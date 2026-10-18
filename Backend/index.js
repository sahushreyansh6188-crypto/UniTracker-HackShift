const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { parseEmail, sameEvent } = require('./gmail')

try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const [name, ...parts] = line.split('=')
    if (name && !name.startsWith('#') && !process.env[name]) process.env[name] = parts.join('=').trim()
  }
} catch {}

const { claimEmailSearch, completeEmailSearch, createManualEvent, databaseHealth, ensureDemoEvents, listEvents, mergeMessage, setArchived } = require('./event-store')

const port = Number(process.env.PORT || 3002)
const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:3001'
const mapsApiKey = process.env.GOOGLE_MAPS_API_KEY
const clientId = process.env.GOOGLE_CLIENT_ID
const clientSecret = process.env.GOOGLE_CLIENT_SECRET
const callbackUrl = process.env.GOOGLE_REDIRECT_URI || `${frontendOrigin}/api/auth/google/callback`
const gmailQuery = process.env.GMAIL_SEARCH_QUERY || '{hackathon hackathons registration participant shortlisted confirmation discord whatsapp}'
const sessions = new Map()
const oauthStates = new Map()
const sessionCookie = 'unitracker_session'
const isProduction = process.env.NODE_ENV === 'production'

const send = (response, status, body, extraHeaders = {}) => {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': frontendOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  })
  response.end(status === 204 ? '' : JSON.stringify(body))
}
const redirect = (response, location, extraHeaders = {}) => {
  response.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...extraHeaders })
  response.end()
}
const readJson = (request) => new Promise((resolve, reject) => {
  let body = ''
  request.on('data', (chunk) => {
    body += chunk
    if (body.length > 20_000) reject(new Error('Request body is too large.'))
  })
  request.on('end', () => {
    try { resolve(JSON.parse(body || '{}')) } catch { reject(new Error('Invalid JSON body.')) }
  })
  request.on('error', reject)
})
const cookieValue = (request, name) => (request.headers.cookie || '').split(';').map((value) => value.trim()).find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1)
const userSession = (request) => sessions.get(cookieValue(request, sessionCookie))
const makeCookie = (name, value, maxAge) => `${name}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${isProduction ? '; Secure' : ''}`
const randomToken = () => crypto.randomBytes(32).toString('base64url')
const isLocation = (value) => typeof value === 'string' && value.trim().length > 1 && value.trim().length <= 250
const isCoordinates = (value) => value && Number.isFinite(Number(value.latitude)) && Number.isFinite(Number(value.longitude)) && Math.abs(Number(value.latitude)) <= 90 && Math.abs(Number(value.longitude)) <= 180
const isText = (value, limit = 250) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= limit
const configured = () => Boolean(clientId && clientSecret)
const apiError = (error) => error?.message || 'Unexpected server error.'
const serializeEvent = (event) => {
  const { _id, ...data } = event
  return { ...data, id: _id.toString(), source: (event.sources || []).filter(Boolean).join(', ') || 'Gmail' }
}
const departureTime = (startTime, travelMinutes, bufferMinutes) => {
  const match = startTime?.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i)
  if (!match) return ''
  let minutes = Number(match[1]) * 60 + Number(match[2] || 0)
  if (match[3]) {
    minutes = (Number(match[1]) % 12) * 60 + Number(match[2] || 0)
    if (match[3].toLowerCase().startsWith('p')) minutes += 12 * 60
  }
  minutes = (minutes - travelMinutes - bufferMinutes + 1440) % 1440
  const hours = Math.floor(minutes / 60)
  return `${String(hours % 12 || 12).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`
}
const refreshAccessToken = async (session) => {
  if (session.accessToken && session.expiresAt > Date.now() + 60_000) return session.accessToken
  if (!session.refreshToken) throw new Error('Google login expired. Please connect Gmail again.')
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: session.refreshToken, grant_type: 'refresh_token' }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error_description || data.error || 'Could not refresh Google authorization.')
  session.accessToken = data.access_token
  session.expiresAt = Date.now() + Number(data.expires_in || 3600) * 1000
  return session.accessToken
}

const gmailRequest = async (session, endpoint) => {
  const token = await refreshAccessToken(session)
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${endpoint}`, { headers: { Authorization: `Bearer ${token}` } })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error?.message || 'Gmail could not be read.')
  return data
}

const fetchRoute = async (origin, destination) => {
  if (!mapsApiKey) return null
  const waypoint = (value) => isCoordinates(value)
    ? { location: { latLng: { latitude: Number(value.latitude), longitude: Number(value.longitude) } } }
    : { address: value }
  const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': mapsApiKey, 'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters' },
    body: JSON.stringify({ origin: waypoint(origin), destination: waypoint(destination), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', languageCode: 'en-US', units: 'METRIC' }),
  })
  const data = await response.json()
  if (!response.ok || !data.routes?.[0]) throw new Error(data.error?.message || 'Google Maps could not find a route.')
  const route = data.routes[0]
  return { durationMinutes: Math.ceil(Number.parseFloat(route.duration) / 60), distanceKm: Number((route.distanceMeters / 1000).toFixed(1)), fetchedAt: new Date().toISOString() }
}

http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
  if (request.method === 'OPTIONS') return send(response, 204, {})

  if (request.method === 'GET' && url.pathname === '/api/auth/google') {
    if (!configured()) return send(response, 503, { error: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI on the server.' })
    const state = randomToken()
    oauthStates.set(state, Date.now() + 10 * 60_000)
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authUrl.search = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUrl, response_type: 'code', scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly', access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', state }).toString()
    return redirect(response, authUrl.toString())
  }

  if (request.method === 'GET' && url.pathname === '/api/auth/google/callback') {
    if (url.searchParams.has('error')) return redirect(response, `${frontendOrigin}/?oauth_error=${encodeURIComponent(url.searchParams.get('error'))}#sync`)
    const state = url.searchParams.get('state')
    if (!state || !oauthStates.has(state) || oauthStates.get(state) < Date.now()) return send(response, 400, { error: 'OAuth state is invalid or expired. Start Google login again.' })
    oauthStates.delete(state)
    if (!url.searchParams.get('code')) return send(response, 400, { error: 'Google did not return an authorization code.' })
    try {
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: url.searchParams.get('code'), client_id: clientId, client_secret: clientSecret, redirect_uri: callbackUrl, grant_type: 'authorization_code' }),
      })
      const tokenData = await tokenResponse.json()
      if (!tokenResponse.ok) throw new Error(tokenData.error_description || tokenData.error || 'Google login failed.')
      const profileResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${tokenData.access_token}` } })
      const profile = await profileResponse.json()
      if (!profileResponse.ok || !profile.email) throw new Error('Could not identify the Google account.')
      const sessionId = randomToken()
      sessions.set(sessionId, { email: profile.email, name: profile.name || '', accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token || '', expiresAt: Date.now() + Number(tokenData.expires_in || 3600) * 1000 })
      return redirect(response, `${frontendOrigin}/#sync`, { 'Set-Cookie': makeCookie(sessionCookie, sessionId, 30 * 24 * 60 * 60) })
    } catch (error) {
      return redirect(response, `${frontendOrigin}/?oauth_error=${encodeURIComponent(apiError(error))}#sync`)
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/auth/status') {
    const session = userSession(request)
    return send(response, 200, { connected: Boolean(session), email: session?.email || null, name: session?.name || null })
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    const sessionId = cookieValue(request, sessionCookie)
    const session = sessions.get(sessionId)
    if (session) sessions.delete(sessionId)
    return send(response, 200, { connected: false }, { 'Set-Cookie': makeCookie(sessionCookie, '', 0) })
  }

  if (request.method === 'GET' && url.pathname === '/api/events') {
    const session = userSession(request)
    if (!session) return send(response, 401, { error: 'Connect Google first.' })
    try {
      await ensureDemoEvents(session.email)
      const archived = url.searchParams.has('archived') ? url.searchParams.get('archived') === 'true' : undefined
      const events = (await listEvents(session.email, archived)).map(serializeEvent)
      return send(response, 200, { events })
    } catch (error) { return send(response, 503, { error: `MongoDB is unavailable: ${apiError(error)}` }) }
  }

  if (request.method === 'POST' && url.pathname === '/api/events/manual') {
    const session = userSession(request)
    if (!session) return send(response, 401, { error: 'Sign in with Google to add an event.' })
    try {
      const body = await readJson(request)
      if (!isText(body.name, 120)) return send(response, 400, { error: 'Event name is required (120 characters max).' })
      const allowedTypes = ['Hackathons', 'Workshops', 'Conferences', 'Other']
      const type = allowedTypes.includes(body.type) ? body.type : 'Hackathons'
      const origin = isLocation(body.origin) ? body.origin.trim() : ''
      const bufferMinutes = Number.isFinite(Number(body.bufferMinutes)) ? Math.max(0, Math.min(360, Number(body.bufferMinutes))) : 30
      const links = Array.isArray(body.links) ? body.links.slice(0, 10).flatMap((link) => {
        if (!isText(link?.url, 2048)) return []
        try {
          const parsedUrl = new URL(link.url.trim())
          if (!['http:', 'https:'].includes(parsedUrl.protocol)) return []
          return [{ label: isText(link.label, 40) ? link.label.trim() : 'Event link', type: isText(link.type, 40) ? link.type.trim() : 'Link', url: parsedUrl.toString() }]
        } catch { return [] }
      }) : []
      const stages = typeof body.nextSteps === 'string' ? [...new Set(body.nextSteps.split(/\r?\n/).map((step) => step.trim()).filter(Boolean).map((step) => step.slice(0, 300)))].slice(0, 30) : []
      const details = {
        name: body.name.trim(),
        org: isText(body.org, 120) ? body.org.trim() : 'Organizer not provided',
        type,
        venue: isText(body.venue, 250) ? body.venue.trim() : '',
        date: isText(body.date, 40) ? body.date.trim() : '',
        startTime: isText(body.startTime, 30) ? body.startTime.trim() : '',
        confirmation: isText(body.confirmation, 1000) ? body.confirmation.trim() : '',
        stages,
        links,
        origin,
        bufferMinutes,
      }
      if (details.venue) details.mapLink = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(details.venue)}${origin ? `&origin=${encodeURIComponent(origin)}` : ''}`
      if (origin && details.venue && mapsApiKey) {
        try {
          details.route = await fetchRoute(origin, details.venue)
          details.leaveBy = departureTime(details.startTime, details.route.durationMinutes, bufferMinutes)
        } catch (error) { details.routeError = apiError(error) }
      }
      let event = await createManualEvent(session.email, details)
      let searchStatus = 'already_searched'
      let searchCount = event.emailSearchCount || 0
      const claimed = await claimEmailSearch(session.email, event._id.toString())
      if (claimed) {
        try {
          const query = `"${details.name.replace(/["\\]/g, ' ').trim()}"`
          const result = await gmailRequest(session, `messages?maxResults=25&q=${encodeURIComponent(query)}`)
          searchCount = 0
          for (const item of result.messages || []) {
            const gmailMessage = await gmailRequest(session, `messages/${encodeURIComponent(item.id)}?format=full`)
            const parsed = parseEmail(gmailMessage)
            if (!parsed.name || !sameEvent(parsed.name, details.name)) continue
            const emailPreferences = { origin, bufferMinutes }
            if (origin && (parsed.venue || details.venue) && mapsApiKey) {
              try {
                emailPreferences.route = await fetchRoute(origin, parsed.venue || details.venue)
                emailPreferences.leaveBy = departureTime(parsed.startTime || details.startTime, emailPreferences.route.durationMinutes, bufferMinutes)
              } catch {}
            }
            await mergeMessage(session.email, parsed, { ...emailPreferences, mapLink: details.mapLink })
            searchCount += 1
          }
          searchStatus = searchCount ? 'found' : 'not_found'
          await completeEmailSearch(session.email, event._id.toString(), { status: searchStatus, count: searchCount })
        } catch (error) {
          searchStatus = 'error'
          await completeEmailSearch(session.email, event._id.toString(), { status: searchStatus, count: 0, error: apiError(error) })
        }
      }
      event = (await listEvents(session.email)).find((candidate) => candidate._id.equals(event._id)) || event
      return send(response, 201, { event: serializeEvent(event), emailSearch: { status: searchStatus, count: searchCount } })
    } catch (error) {
      if (error.name === 'MongoServerSelectionError') return send(response, 503, { error: `MongoDB is unavailable: ${apiError(error)}` })
      return send(response, 500, { error: apiError(error) })
    }
  }

  if (request.method === 'POST' && url.pathname.startsWith('/api/events/') && url.pathname.endsWith('/archive')) {
    const session = userSession(request)
    if (!session) return send(response, 401, { error: 'Connect Google first.' })
    try {
      const body = await readJson(request)
      if (typeof body.archived !== 'boolean') return send(response, 400, { error: 'Set archived to true or false.' })
      const id = url.pathname.split('/')[3]
      const event = await setArchived(session.email, id, body.archived)
      if (!event) return send(response, 404, { error: 'Event not found.' })
      return send(response, 200, { event: serializeEvent(event) })
    } catch (error) { return send(response, 503, { error: `MongoDB is unavailable: ${apiError(error)}` }) }
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    let database = 'disconnected'
    let databaseError
    try { await databaseHealth(); database = 'connected' } catch (error) { databaseError = apiError(error) }
    return send(response, 200, {
      database,
      maps: mapsApiKey ? 'configured' : 'missing_key',
      oauth: configured() ? 'configured' : 'missing_credentials',
      ...(databaseError ? { databaseError } : {}),
    })
  }

  if (request.method === 'POST' && url.pathname === '/api/gmail/sync') {
    const session = userSession(request)
    if (!session) return send(response, 401, { error: 'Connect Google first.' })
    try {
      const body = await readJson(request)
      const origin = isLocation(body.origin) ? body.origin.trim() : ''
      const bufferMinutes = Number.isFinite(Number(body.bufferMinutes)) ? Math.max(0, Math.min(360, Number(body.bufferMinutes))) : 30
      const query = typeof body.query === 'string' && body.query.trim() ? body.query.trim().slice(0, 500) : gmailQuery
      const list = await gmailRequest(session, `messages?maxResults=100&q=${encodeURIComponent(query)}`)
      let scanned = 0
      for (const item of list.messages || []) {
        const gmailMessage = await gmailRequest(session, `messages/${encodeURIComponent(item.id)}?format=full`)
        const parsed = parseEmail(gmailMessage)
        if (!parsed.name) continue
        if (!/hackathon|hack\s?fest|participant|registration|registered|confirmation|discord|whatsapp/i.test(`${parsed.subject} ${parsed.snippets.join(' ')}`)) continue
        const message = { ...parsed }
        const preferences = { origin, bufferMinutes }
        if (parsed.venue) message.mapLink = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(parsed.venue)}${origin ? `&origin=${encodeURIComponent(origin)}` : ''}`
        if (origin && parsed.venue && mapsApiKey) {
          try {
            preferences.route = await fetchRoute(origin, parsed.venue)
            preferences.leaveBy = departureTime(parsed.startTime, preferences.route.durationMinutes, bufferMinutes)
          } catch (error) { message.routeError = apiError(error) }
        }
        await mergeMessage(session.email, message, { ...preferences, mapLink: message.mapLink })
        scanned += 1
      }
      const events = await listEvents(session.email)
      return send(response, 200, { scanned, totalEvents: events.length, events: events.map(serializeEvent), query })
    } catch (error) {
      if (error.message?.includes('server selection') || error.name === 'MongoServerSelectionError') return send(response, 503, { error: `MongoDB is unavailable: ${apiError(error)}` })
      return send(response, 502, { error: apiError(error) })
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/commute') {
    if (!mapsApiKey) return send(response, 503, { error: 'Google Maps is not configured. Set GOOGLE_MAPS_API_KEY on the server.' })
    try {
      const { origin, destination } = await readJson(request)
      if (!(isLocation(origin) || isCoordinates(origin)) || !isLocation(destination)) return send(response, 400, { error: 'Origin and destination are required.' })
      return send(response, 200, await fetchRoute(typeof origin === 'string' ? origin.trim() : origin, destination.trim()))
    } catch (error) {
      return send(response, 502, { error: apiError(error) })
    }
  }

  return send(response, 404, { error: 'Not found.' })
}).listen(port, () => console.log(`UniTracker API listening on http://localhost:${port}`))
