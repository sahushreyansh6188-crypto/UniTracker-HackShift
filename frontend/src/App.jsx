import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import './amendments.css'

const demoEvents = [
  { id: 'demo-hackshift', name: 'HackShift 2026', org: 'IIIT Delhi', type: 'Hackathons', source: 'Demo event', venue: 'IIIT Delhi, Okhla', date: 'Oct 17, 2026', current: 0, stages: [['Registration milestone', 'Completed'], ['Shortlist milestone', 'Date pending'], ['Finale milestone', 'Oct 17 · IIIT Delhi']], links: [] },
  { id: 'demo-codesprint', name: 'CodeSprint Workshop', org: 'Coding Club', type: 'Workshops', source: 'Demo event', venue: 'Seminar Hall 2', date: 'Oct 21, 2026', current: 0, stages: [['Registration milestone', 'Completed'], ['Workshop milestone', 'Oct 21 · 10:00 AM']], links: [] },
]
const navItems = [['dashboard', 'My Dashboard'], ['events', 'My Events'], ['archive', 'Archived Events'], ['calendar', 'Calendar & Clashes'], ['commute', 'Commute Guard'], ['links', 'Saved Links'], ['sync', 'Auto-Sync']]
const commuteApi = import.meta.env.VITE_COMMUTE_API_URL || '/api/commute'
const backendApi = import.meta.env.VITE_BACKEND_API_URL || '/api'
const mapsEmbedKey = import.meta.env.VITE_GOOGLE_MAPS_EMBED_KEY || ''

const apiRequest = async (path, options = {}) => {
  const response = await fetch(backendApi + path, { credentials: 'include', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.')
  return data
}
const fetchCommute = async (origin, destination, liveLocation) => {
  const response = await fetch(commuteApi, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: liveLocation || origin, destination }) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Unable to fetch a travel estimate.')
  return data
}
const leaveTime = (start, minutes) => {
  const [hours, mins] = start.split(':').map(Number)
  const total = (hours * 60 + mins - minutes + 1440) % 1440
  const hour = Math.floor(total / 60)
  return String(hour % 12 || 12).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0') + (hour < 12 ? ' AM' : ' PM')
}
const toTimeInput = (value) => {
  const match = String(value || '').match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i)
  if (!match) return ''
  let hours = Number(match[1])
  if (match[3]) { hours %= 12; if (match[3].toUpperCase() === 'PM') hours += 12 }
  return `${String(hours).padStart(2, '0')}:${match[2] || '00'}`
}
const linkTitle = (link) => link.label || link.type || 'Event link'
const eventIdentity = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function EventCard({ event, onArchive }) {
  const stages = (event.stages || []).map((item) => Array.isArray(item) ? item : [item, 'From email'])
  const current = Number(event.current || 0)
  return <article className="card event-card">
    <span className="badge">{stages.length ? `Milestone ${current + 1} of ${stages.length}` : 'Event details'}</span>
    <h3>{event.name}</h3>
    <p className="meta">{event.org || 'Organizer not provided'} · {event.venue || 'Venue pending'} · via {event.source || 'Gmail'}{(event.date || event.startTime) && ` · ${[event.date, event.startTime].filter(Boolean).join(' · ')}`}</p>
    {event.confirmationDetails?.length > 0 && <p className="event-confirmation">{event.confirmationDetails.join(' ')}</p>}
    {event.confirmation && <p className="event-confirmation">{event.confirmation}</p>}
    {stages.length > 0 && <><h4 className="milestone-heading">Next steps & milestones</h4>{stages.map(([stage, detail], index) => <div className={'stage ' + (index < current ? 'done' : index === current ? 'current' : '')} key={`${stage}-${index}`}><i /><div>{stage}<small>{detail}</small></div></div>)}</>}
    {event.links?.length > 0 && <div className="event-links">{event.links.map((link, index) => <a key={link.url || index} href={link.url} target="_blank" rel="noreferrer">{linkTitle(link)}</a>)}</div>}
    {event.route && <p className="meta">Map route: {event.route.durationMinutes} min · {event.route.distanceKm} km · {event.bufferMinutes} min buffer{event.leaveBy && ` · Leave by ${event.leaveBy}`}</p>}
    {event.mapLink && <a className="map-link" href={event.mapLink} target="_blank" rel="noreferrer">Directions from {event.origin || 'your location'}</a>}
    {typeof event.id === 'string' && !event.id.startsWith('demo-') && <button className="archive-action" type="button" onClick={() => onArchive?.(event.id, !event.archived)}>{event.archived ? 'Restore to My Events' : 'Archive event'}</button>}
  </article>
}

function LeaveBy({ time, note }) { return <div className="leave"><div>Leave campus by</div><div>{time}{note && <small>• {note}</small>}</div></div> }

function DashboardCommute({ commute, onRefresh, onOpen }) {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const refresh = async () => { setLoading(true); setError(''); try { await onRefresh() } catch (err) { setError(err.message) } finally { setLoading(false) } }
  const { route } = commute
  return <section className="card dashboard-commute"><div><span className="commute-kicker">Google Maps live route</span><b>{commute.origin} → {commute.destination}</b>{route ? <small>{route.durationMinutes} min · {route.distanceKm} km · Leave by {leaveTime(commute.start, route.durationMinutes + Number(commute.buffer))}</small> : <small>{error || 'Refresh to get a traffic-aware estimate.'}</small>}</div><div><button className="button inline" type="button" onClick={refresh} disabled={loading}>{loading ? 'Checking…' : 'Refresh route'}</button><button className="button outline" type="button" onClick={onOpen}>Commute Guard</button></div></section>
}

function Dashboard({ commute, events, onRefreshCommute, onOpenCommute }) {
  const activeEvents = events.filter((event) => !event.archived)
  const hackshift = activeEvents.find((event) => /hackshift/i.test(event.name))
  const links = hackshift?.links || []
  const actions = [
    ['📄', 'Download PPT Template', /ppt|template/i],
    ['💬', 'Join Team Discord', /discord/i],
    ['▦', 'Entry QR Pass', /qr|pass|entry/i],
  ]
  const departure = commute.route ? leaveTime(commute.start, commute.route.durationMinutes + Number(commute.buffer)) : '—'
  const note = commute.route ? 'Live Google Maps estimate' : 'Fetch a route in Commute Guard'
  return <>
    <section className="panel"><h1>Today’s Focus</h1><div className="priority">Active Priority: HackShift 2026 (IIIT Delhi)</div><div className="step-row"><span className="pill">Step 2 of 4: Idea PPT Due Oct 15, 11:59 PM</span><div className="progress"><span className="done" /><em className="done" /><span className="current" /><em /><span /><em /><span /></div></div>
      <div className="tiles">{actions.map(([icon, label, pattern]) => { const link = links.find((item) => pattern.test(`${item.label || ''} ${item.type || ''}`)); return link?.url ? <a className="tile" href={link.url} target="_blank" rel="noreferrer" key={label}><b>{icon}</b>{label}</a> : <button className="tile" type="button" key={label} disabled title="Add this link in the event form to enable it"><b>{icon}</b>{label}<small>Link not added</small></button> })}</div><LeaveBy time={departure} note={note} />
    </section>
    <DashboardCommute commute={commute} onRefresh={onRefreshCommute} onOpen={onOpenCommute} />
    <section className="stats">{[[activeEvents.length, 'Active events'], [activeEvents.filter((event) => event.manualEntry).length, 'Manually added'], [activeEvents.filter((event) => (event.messageIds || []).length).length, 'Linked to email']].map(([value, label]) => <div className="card stat" key={label}><b>{value}</b><span>{label}</span></div>)}</section>
    <h2>Up next</h2><section className="grid">{activeEvents.slice(0, 3).map((event) => <EventCard event={event} key={event.id} />)}</section>
  </>
}

function Events({ filter, events, archived = false, onArchive, notice }) {
  const filtered = events.filter((event) => Boolean(event.archived) === archived && (filter === 'All' || event.type === filter))
  return <><h1>{archived ? 'Archived Events' : 'My Events'}</h1><p className="muted">{archived ? 'Completed events are kept here and hidden from My Events.' : 'Event details from your account and Gmail are merged into one card.'} Filter: {filter}</p>{notice && <p className="sync-result">{notice}</p>}<section className="grid">{filtered.map((event) => <EventCard event={event} onArchive={onArchive} key={event.id} />)}</section>{filtered.length === 0 && <p className="muted">{archived ? 'No archived events yet.' : 'No events found.'}</p>}</>
}

function Calendar({ events }) {
  const datedEvents = events.filter((event) => event.date || event.startTime)
  return <><h1>Calendar & Clashes</h1><p className="muted">Dates shown here come from your saved event details.</p>{datedEvents.length ? <section className="grid">{datedEvents.map((event) => <article className="card" key={event.id}><b>{event.name}</b><p className="meta">{[event.date, event.startTime, event.venue].filter(Boolean).join(' · ')}</p></article>)}</section> : <p className="muted">Add event dates to see them here.</p>}</>
}

function Commute({ commute, setCommute, onRefresh, events }) {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [tracking, setTracking] = useState(false)
  const watchId = useRef(null)
  const lastAutoRouteAt = useRef(0)
  const setValue = (key, value) => setCommute((current) => ({ ...current, [key]: value, route: key === 'origin' || key === 'destination' ? null : current.route }))
  const estimate = async () => { setLoading(true); setError(''); try { await onRefresh() } catch (err) { setError(err.message) } finally { setLoading(false) } }
  const startLiveLocation = () => {
    setError('')
    if (!navigator.geolocation) { setError('Live location is not available in this browser.'); return }
    setTracking(true)
    lastAutoRouteAt.current = 0
  }
  useEffect(() => {
    if (!tracking) return undefined
    if (!navigator.geolocation) { setError('Live location is not available in this browser.'); setTracking(false); return undefined }
    watchId.current = navigator.geolocation.watchPosition(async ({ coords }) => {
      const liveLocation = { latitude: coords.latitude, longitude: coords.longitude }
      setCommute((current) => ({ ...current, liveLocation, origin: 'Current location' }))
      const now = Date.now()
      if (!commute.destination || now - lastAutoRouteAt.current < 60_000) return
      lastAutoRouteAt.current = now
      try {
        const route = await fetchCommute('Current location', commute.destination, liveLocation)
        setCommute((current) => ({ ...current, route }))
        setError('')
      } catch (err) { setError(err.message) }
    }, (err) => {
      setError(err.code === 1 ? 'Location permission was denied. Allow location access in your browser to use live routing.' : `Could not read your location: ${err.message}`)
      setTracking(false)
    }, { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 })
    return () => { if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current) }
  }, [tracking, commute.destination, setCommute])
  const plannedLeave = commute.route ? leaveTime(commute.start, commute.route.durationMinutes + Number(commute.buffer)) : '—'
  const mapOrigin = commute.liveLocation ? `${commute.liveLocation.latitude},${commute.liveLocation.longitude}` : commute.origin
  const mapUrl = commute.destination ? (mapsEmbedKey
    ? `https://www.google.com/maps/embed/v1/directions?key=${encodeURIComponent(mapsEmbedKey)}&origin=${encodeURIComponent(mapOrigin)}&destination=${encodeURIComponent(commute.destination)}&mode=driving`
    : `https://www.google.com/maps?output=embed&saddr=${encodeURIComponent(mapOrigin)}&daddr=${encodeURIComponent(commute.destination)}`) : ''
  const directionsUrl = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(mapOrigin)}&destination=${encodeURIComponent(commute.destination)}`
  return <><h1>Commute Guard</h1><section className="panel commute"><p className="muted">Live location updates the route origin. Google Maps traffic time is combined with your safety buffer to calculate when to leave.</p><div className="commute-controls"><label>From<input value={commute.liveLocation ? 'Live device location' : commute.origin} readOnly={Boolean(commute.liveLocation)} onChange={(e) => setValue('origin', e.target.value)} /></label><label>To<select value={events.find((event) => event.venue && event.venue === commute.destination)?.id || ''} onChange={(e) => { const event = events.find((item) => item.id === e.target.value); if (event) setCommute((current) => ({ ...current, destination: event.venue, start: toTimeInput(event.startTime) || current.start, route: null })) }}><option value="">Choose saved event venue…</option>{events.filter((event) => event.venue).map((event) => <option key={event.id} value={event.id}>{event.name} · {event.venue}</option>)}</select><input aria-label="Custom destination" placeholder="Or enter a venue or address" value={commute.destination} onChange={(e) => setValue('destination', e.target.value)} /></label><label>Event start<input type="time" value={commute.start} onChange={(e) => setCommute((current) => ({ ...current, start: e.target.value }))} /></label><label>Safety buffer (min)<input type="number" min="0" value={commute.buffer} onChange={(e) => setCommute((current) => ({ ...current, buffer: e.target.value }))} /></label></div><div className="route-actions"><button className="button outline" type="button" onClick={() => tracking ? (setTracking(false), setCommute((current) => ({ ...current, liveLocation: null, route: null }))) : startLiveLocation()}>{tracking ? 'Stop live location' : 'Use my live location'}</button><button className="button" type="button" onClick={estimate} disabled={loading || !commute.destination}>{loading ? 'Fetching route…' : 'Refresh route & travel time'}</button></div>{error && <p className="route-error">{error}</p>}{commute.liveLocation && <p className="location-note"><span /> Live location active · route refreshes automatically at most once a minute</p>}{commute.route && <p className="route-details">Google Maps estimate: <b>{commute.route.durationMinutes} min</b> · {commute.route.distanceKm} km · {commute.buffer} min buffer · Leave by <b>{plannedLeave}</b></p>}<LeaveBy time={plannedLeave} note={commute.route ? `Travel ${commute.route.durationMinutes} min + ${commute.buffer} min safety buffer` : 'Allow location access and fetch a route'} /><div className="commute-map-heading"><div><b>Route map</b><small>{mapOrigin} → {commute.destination}</small></div><a href={directionsUrl} target="_blank" rel="noreferrer">Open in Google Maps ↗</a></div>{mapUrl ? <iframe className="commute-map" title="Google Maps route from your current location to the event" src={mapUrl} loading="lazy" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen /> : <div className="map-placeholder"><b>Choose a destination to see the route map</b><span>The route will appear here when you enter an address or select a saved event.</span></div>}</section></>
}

function Links({ events }) {
  const links = events.filter((event) => !event.archived).flatMap((event) => (event.links || []).map((link, index) => ({ ...link, eventName: event.name, key: `${event.id}-${index}` })))
  return <><h1>Saved Links · Asset Vault</h1>{links.length ? <section className="grid">{links.map((link) => <article className="card asset" key={link.key}><div>↗</div><b>{linkTitle(link)}</b><small>{link.eventName}</small><a className="button inline" href={link.url} target="_blank" rel="noreferrer">Open link</a></article>)}</section> : <p className="muted">No event links yet. Add links from an event card or the event form.</p>}</>
}

function Sync({ commute, events, onEvents, account, onAccount, readiness, initialError }) {
  const [error, setError] = useState(initialError || '')
  const [loading, setLoading] = useState(false)
  const [synced, setSynced] = useState(null)
  const connect = () => { if (readiness?.oauth !== 'configured') { setError('Google OAuth is not configured. Add the OAuth client ID and secret to Backend/.env, then restart the backend.'); return } window.location.href = backendApi + '/auth/google' }
  const syncMail = async () => { setLoading(true); setError(''); try { const data = await apiRequest('/gmail/sync', { method: 'POST', body: JSON.stringify({ origin: commute.origin, bufferMinutes: commute.buffer }) }); onEvents(data.events); setSynced(data) } catch (err) { setError(err.message) } finally { setLoading(false) } }
  const disconnect = async () => { try { await apiRequest('/auth/logout', { method: 'POST', body: '{}' }); onAccount({ connected: false }); onEvents([]); setSynced(null) } catch (err) { setError(err.message) } }
  return <><h1>Auto-Sync</h1><section className="grid"><article className="card"><div className="row"><b>Gmail · Google OAuth 2.0</b>{account?.connected && <span className="connected">● Connected</span>}</div><p className="muted">Read-only Gmail access finds event confirmations, follow-up steps, venue details, and Discord or WhatsApp links. Matching emails merge into the event record.</p><p className="muted">OAuth: {readiness?.oauth === 'configured' ? 'configured' : 'missing credentials in Backend/.env'} · MongoDB: {readiness?.database || 'checking'}</p>{account?.connected ? <><p className="gmail-account">Signed in as {account.email}</p><button className="button inline" type="button" onClick={syncMail} disabled={loading}>{loading ? 'Reading emails…' : 'Sync Gmail'}</button><button className="button inline secondary-action" type="button" onClick={disconnect}>Disconnect</button></> : <button className="button inline" type="button" onClick={connect}>Sign in with Google</button>}{synced && <p className="sync-result">Checked {synced.scanned} matching emails · {synced.totalEvents} saved event cards</p>}{error && <p className="route-error">{error}</p>}<p className="muted">Events loaded: {events.length}</p></article><article className="card"><b>Google Maps Routes</b><p className="muted">Maps API: {readiness?.maps === 'configured' ? 'configured' : 'missing GOOGLE_MAPS_API_KEY in Backend/.env'}</p><p className="muted">A configured key must have Routes API enabled. Route estimates are requested when you use Refresh route or Fetch Google Maps travel time.</p></article></section></>
}

function ManualEventForm({ commute, onClose, onSaved }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [values, setValues] = useState({ name: '', org: '', type: 'Hackathons', venue: '', date: '', startTime: '', confirmation: '', nextSteps: '', origin: commute.origin, bufferMinutes: commute.buffer, eventUrl: '', discordUrl: '', whatsappUrl: '', pptUrl: '', qrUrl: '' })
  const set = (key) => (event) => setValues((current) => ({ ...current, [key]: event.target.value }))
  const submit = async (event) => {
    event.preventDefault(); setSaving(true); setError(''); setResult('')
    const links = [
      ['Event website', 'Website', values.eventUrl], ['Discord', 'Discord', values.discordUrl], ['WhatsApp', 'WhatsApp', values.whatsappUrl], ['PPT template', 'PPT Template', values.pptUrl], ['Entry QR pass', 'QR Pass', values.qrUrl],
    ].filter(([, , url]) => url.trim()).map(([label, type, url]) => ({ label, type, url: url.trim() }))
    try {
      const data = await apiRequest('/events/manual', { method: 'POST', body: JSON.stringify({ ...values, links }) })
      onSaved(data.event)
      const status = data.emailSearch.status === 'found' ? `Found and merged ${data.emailSearch.count} matching email${data.emailSearch.count === 1 ? '' : 's'}.` : data.emailSearch.status === 'not_found' ? 'No matching email found. The one-time search is complete.' : data.emailSearch.status === 'already_searched' ? 'This event has already had its one-time email search.' : `Saved. Email search could not complete: ${data.event.emailSearchError || 'check Gmail connection'}. It will not repeat automatically.`
      setResult(`Event saved. ${status}`)
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }
  return <div className="modal-backdrop" role="presentation"><section className="event-modal" role="dialog" aria-modal="true" aria-labelledby="add-event-title"><div className="modal-heading"><div><span className="commute-kicker">Event record</span><h2 id="add-event-title">Add an event</h2></div><button className="modal-close" type="button" aria-label="Close form" onClick={onClose}>×</button></div>{result ? <><p className="sync-result">{result}</p><button className="button" type="button" onClick={onClose}>Done</button></> : <form onSubmit={submit} className="event-form"><div className="form-grid"><label>Event name *<input required maxLength="120" value={values.name} onChange={set('name')} /></label><label>Organizer<input maxLength="120" value={values.org} onChange={set('org')} /></label><label>Event type<select value={values.type} onChange={set('type')}><option>Hackathons</option><option>Workshops</option><option>Conferences</option><option>Other</option></select></label><label>Venue<input maxLength="250" value={values.venue} onChange={set('venue')} /></label><label>Event date<input type="date" value={values.date} onChange={set('date')} /></label><label>Start time<input type="time" value={values.startTime} onChange={set('startTime')} /></label></div><label>Registration / confirmation details<textarea rows="2" maxLength="1000" value={values.confirmation} onChange={set('confirmation')} /></label><label>Next steps <small>One item per line</small><textarea rows="3" value={values.nextSteps} onChange={set('nextSteps')} /></label><fieldset><legend>Event links (leave blank if unavailable)</legend><div className="form-grid">{[['eventUrl', 'Event website'], ['discordUrl', 'Discord invite'], ['whatsappUrl', 'WhatsApp invite'], ['pptUrl', 'PPT template'], ['qrUrl', 'Entry QR pass']].map(([key, label]) => <label key={key}>{label}<input type="url" value={values[key]} onChange={set(key)} placeholder="https://" /></label>)}</div></fieldset><div className="form-grid"><label>Route origin<input value={values.origin} onChange={set('origin')} /></label><label>Safety buffer (minutes)<input type="number" min="0" max="360" value={values.bufferMinutes} onChange={set('bufferMinutes')} /></label></div><p className="muted">Saving searches Gmail once for this event. A missing email is recorded and won’t be searched again automatically.</p>{error && <p className="route-error">{error}</p>}<div className="modal-actions"><button className="button outline" type="button" onClick={onClose}>Cancel</button><button className="button" type="submit" disabled={saving}>{saving ? 'Saving & searching once…' : 'Save event'}</button></div></form>}</section></div>
}

function App() {
  const hash = window.location.hash.slice(1)
  const [tab, setTab] = useState(navItems.some(([key]) => key === hash) ? hash : 'dashboard')
  const [filter, setFilter] = useState('All')
  const [gmailEvents, setGmailEvents] = useState([])
  const [databaseStatus, setDatabaseStatus] = useState('checking')
  const [readiness, setReadiness] = useState({ database: 'checking', maps: 'checking', oauth: 'checking' })
  const [oauthError, setOauthError] = useState(() => {
    const oauthErrorParam = new URLSearchParams(window.location.search).get('oauth_error')
    if (oauthErrorParam === 'access_denied') return 'Google denied authorization. If you did not cancel the prompt, add this Google account under Google Cloud Console → Google Auth Platform → Audience → Test users. If the app audience is Internal, use an account from that Workspace organization.'
    return oauthErrorParam || ''
  })
  const [account, setAccount] = useState({ connected: false })
  const [accountOpen, setAccountOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [theme, setTheme] = useState(() => { const saved = window.localStorage.getItem('unitracker-theme'); return saved === 'light' || saved === 'dark' ? saved : (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') })
  const [commute, setCommute] = useState({ origin: 'Greater Noida', destination: 'IIIT Delhi, Okhla', start: '10:00', buffer: 30, route: null, liveLocation: null })
  const visibleEvents = useMemo(() => {
    const storedNames = new Set(gmailEvents.map((event) => eventIdentity(event.name)))
    return [...gmailEvents, ...demoEvents.filter((event) => !storedNames.has(eventIdentity(event.name)))]
  }, [gmailEvents])

  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; window.localStorage.setItem('unitracker-theme', theme) }, [theme])
  useEffect(() => {
    apiRequest('/auth/status').then((status) => { setAccount(status); if (status.connected) return apiRequest('/events').then((data) => setGmailEvents(data.events)) }).catch(() => {})
    apiRequest('/health').then((status) => { setReadiness(status); setDatabaseStatus(status.database) }).catch(() => { setReadiness({ database: 'unavailable', maps: 'unavailable', oauth: 'unavailable' }); setDatabaseStatus('unavailable') })
    if (window.location.search.includes('oauth_error')) { window.history.replaceState(null, '', `${window.location.pathname}#sync`) }
  }, [])
  const navigate = (key) => { window.history.replaceState(null, '', '#' + key); setTab(key); setAccountOpen(false) }
  const selectEventFilter = (value) => { setFilter(value); navigate('events') }
  const refreshCommute = async () => { const route = await fetchCommute(commute.origin, commute.destination, commute.liveLocation); setCommute((current) => ({ ...current, route })); return route }
  const archiveEvent = async (id, archived) => { const { event } = await apiRequest(`/events/${encodeURIComponent(id)}/archive`, { method: 'POST', body: JSON.stringify({ archived }) }); setGmailEvents((current) => current.map((item) => item.id === id ? event : item)) }
  const savedManualEvent = (event) => { setGmailEvents((current) => [...current.filter((item) => item.id !== event.id), event]); setNotice('Manual event saved to MongoDB.'); navigate('events') }
  const logout = async () => { await apiRequest('/auth/logout', { method: 'POST', body: '{}' }); setAccount({ connected: false }); setGmailEvents([]); setAccountOpen(false) }
  const pages = {
    dashboard: <Dashboard commute={commute} events={visibleEvents} onRefreshCommute={refreshCommute} onOpenCommute={() => navigate('commute')} />,
    events: <Events filter={filter} events={visibleEvents} onArchive={archiveEvent} notice={notice} />,
    archive: <Events filter="All" events={visibleEvents} archived onArchive={archiveEvent} />,
    calendar: <Calendar events={visibleEvents.filter((event) => !event.archived)} />,
    commute: <Commute commute={commute} setCommute={setCommute} onRefresh={refreshCommute} events={visibleEvents.filter((event) => !event.archived)} />,
    links: <Links events={visibleEvents} />,
    sync: <Sync commute={commute} events={visibleEvents} onEvents={setGmailEvents} account={account} onAccount={setAccount} readiness={readiness} initialError={oauthError} />,
  }

  return <div className="app"><div className="shell"><header><div className="logo">✦ UniTracker ✧</div><div className="header-right"><button className="theme-toggle" type="button" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} aria-pressed={theme === 'dark'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}><span aria-hidden="true">{theme === 'light' ? '☾' : '☀'}</span><span>{theme === 'light' ? 'Dark mode' : 'Light mode'}</span></button><button className="add-event-button" type="button" onClick={() => { setNotice(''); if (!account.connected) setAccountOpen(true); else setAddOpen(true) }}><span aria-hidden="true">+</span> Add event</button><div className="account-wrap"><button className="avatar account-avatar" type="button" aria-label="Account and sign in" aria-expanded={accountOpen} onClick={() => setAccountOpen((open) => !open)}>{account.connected ? (account.name || account.email || 'U').slice(0, 2).toUpperCase() : '♙'}</button>{accountOpen && <div className="account-menu">{account.connected ? <><b>{account.name || 'Signed in'}</b><small>{account.email}</small><button type="button" onClick={logout}>Sign out</button></> : <><b>Sign in to UniTracker</b><small>Use Google to save events and connect Gmail.</small><button type="button" onClick={() => { window.location.href = backendApi + '/auth/google' }}>Continue with Google</button></>}</div>}</div></div></header><div className="body"><nav>{navItems.map(([key, title]) => <div className="nav-item" key={key}><button type="button" className={tab === key ? 'active' : ''} onClick={() => navigate(key)}>{title}{key === 'events' && ' ▾'}</button>{key === 'events' && tab === 'events' && <div className="nav-sub">{['All', 'Hackathons', 'Conferences', 'Workshops', 'Other'].map((type) => <button type="button" className={filter === type ? 'selected' : ''} onClick={() => selectEventFilter(type)} key={type}>{type}</button>)}</div>}</div>)}<p className="database">● <b>DB</b> {databaseStatus}<br />Team ARROWS • HackShift</p></nav><main>{pages[tab]}</main></div></div>{addOpen && <ManualEventForm commute={commute} onClose={() => setAddOpen(false)} onSaved={savedManualEvent} />}</div>
}

export default App
