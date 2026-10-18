const decodeBase64Url = (value = '') => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')

const collectBodies = (part, bodies = []) => {
  if (part?.body?.data) bodies.push(decodeBase64Url(part.body.data))
  for (const child of part?.parts || []) collectBodies(child, bodies)
  return bodies
}

const cleanBody = (value) => value
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/[ \t]+/g, ' ')
  .replace(/\n\s*\n\s*\n/g, '\n\n')
  .trim()

const subjectName = (subject) => subject
  .replace(/^(?:(?:re|fwd?|fw)\s*:\s*)+/i, '')
  .replace(/\b(you are|your|hackathon|event)\s+(?:are\s+)?(?:successfully\s+)?(?:registered|registration confirmed|confirmed|confirmation|shortlisted|accepted)\s*(?:for|to|in)?\s*/ig, '')
  .replace(/\b(registration|confirmation|confirmed|participant|shortlisted|next steps|action required|reminder|update|invitation|invite|successfully|successful|success)\b/ig, ' ')
  .replace(/[|:–—-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const sentenceList = (text) => text
  .split(/(?<=[.!?])\s+|\n+/)
  .map((line) => line.trim().replace(/^[-•*\d.)\s]+/, ''))
  .filter((line) => line.length > 8 && line.length < 500)

const unique = (values) => [...new Set(values.filter(Boolean))]
const urlsFrom = (text) => unique((text.match(/https?:\/\/[^\s<>"')\]]+/gi) || []).map((url) => url.replace(/[.,;!?]+$/, '')))

const parseEmail = (message) => {
  const headers = Object.fromEntries((message.payload?.headers || []).map((header) => [header.name.toLowerCase(), header.value]))
  const subject = headers.subject || '(No subject)'
  const bodies = collectBodies(message.payload)
  const text = cleanBody(bodies.join('\n'))
  const lines = sentenceList(text)
  const links = urlsFrom(text).map((url) => ({
    url,
    type: /discord\.gg|discord\.com/i.test(url) ? 'Discord' : /chat\.whatsapp\.com|wa\.me/i.test(url) ? 'WhatsApp' : /maps\.google|goo\.gl\/maps/i.test(url) ? 'Map' : 'Link',
  }))
  const relevant = (line, pattern) => line.match(pattern)
  const confirmation = lines.filter((line) => relevant(line, /confirm|registered|registration|participant|accepted|shortlist/i))
  const nextSteps = lines.filter((line) => relevant(line, /next step|please |must |submit|upload|complete|deadline|by \w+|before |prepare|join|attend|check.?in|bring /i))
  const venueLine = lines.find((line) => relevant(line, /venue|location|address|held at|takes place at|in-person|onsite|on-site/i))
  const venueMatch = venueLine?.match(/(?:venue|location|address|held at|takes place at)\s*[:\-]?\s*(.{4,120})/i)
  const dateMatch = text.match(/\b(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:,?\s+20\d{2})?|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+20\d{2})?|\d{1,2}[/-]\d{1,2}[/-]20\d{2})\b/i)
  const timeMatch = text.match(/\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i)
  const cleanedSubject = subjectName(subject)
  const bodyNameMatch = text.match(/\b(?:registration for|registered for|registering for|confirmed for|confirmation for|participant in|accepted to|shortlisted for|welcome to|hackathon name\s*[:\-])\s+([^.!?\n]{3,90})/i)
  const bodyName = bodyNameMatch?.[1]?.replace(/\s+(?:is|will be|starts|begins|on|at)\s+.*$/i, '').replace(/^(?:the\s+)?(?:hackathon|event)\s+/i, '').replace(/^the\s+/i, '').replace(/[,:;\s]+$/, '').trim()
  const name = cleanedSubject || bodyName || ''

  return {
    name,
    subject,
    messageId: message.id,
    receivedAt: Number(message.internalDate) ? new Date(Number(message.internalDate)).toISOString() : null,
    source: headers.from || 'Gmail',
    confirmation: confirmation.join(' '),
    nextSteps: unique(nextSteps),
    links,
    venue: venueMatch?.[1]?.replace(/[.\s]+$/, '') || '',
    date: dateMatch?.[0] || '',
    startTime: timeMatch?.[0] || '',
    snippets: lines.filter((line) => relevant(line, /hackathon|registration|confirm|participant|next step|discord|whatsapp|deadline/i)).slice(0, 8),
  }
}

const tokens = (name) => new Set(name.toLowerCase().replace(/\b(hackathon|hack|registration|confirmation|confirmed|participant|shortlist|update|reminder|next steps|event|re|fwd|round|phase|stage)\b/g, ' ').split(/[^a-z0-9]+/).filter((word) => word.length > 2))
const sameEvent = (left, right) => {
  const a = tokens(left)
  const b = tokens(right)
  const yearsA = [...left.matchAll(/\b20\d{2}\b/g)].map(([year]) => year)
  const yearsB = [...right.matchAll(/\b20\d{2}\b/g)].map(([year]) => year)
  if (yearsA.length && yearsB.length && !yearsA.some((year) => yearsB.includes(year))) return false
  if (!a.size || !b.size) return left.toLowerCase().trim() === right.toLowerCase().trim()
  const common = [...a].filter((word) => b.has(word)).length
  const similarity = common / (a.size + b.size - common)
  return similarity >= 0.6 || (common >= 2 && common / Math.min(a.size, b.size) >= 0.85)
}

const mergeEmail = (events, email) => {
  let event = events.find((candidate) => sameEvent(candidate.name, email.name))
  if (!event) {
    event = {
      id: `gmail-${email.messageId}`,
      name: email.name,
      org: 'From Gmail',
      type: 'Hackathons',
      source: 'Gmail',
      venue: '',
      date: '',
      startTime: '',
      bufferMinutes: 30,
      origin: '',
      route: null,
      confirmation: '',
      stages: [],
      links: [],
      messages: [],
    }
    events.push(event)
  } else if (event.name.length > email.name.length && email.name.length > 3) {
    event.name = email.name
  }
  event.messages = unique([...event.messages, email.messageId])
  event.sources = unique([...(event.sources || []), email.source])
  event.source = 'Gmail · ' + event.sources.join(', ')
  event.confirmation = [event.confirmation, email.confirmation].filter(Boolean).join(' ')
  event.venue ||= email.venue
  event.date ||= email.date
  event.startTime ||= email.startTime
  event.stages = unique([...event.stages, ...email.nextSteps, ...email.snippets])
  event.links = [...event.links, ...email.links.filter((link) => !event.links.some((existing) => existing.url === link.url))]
  event.current = event.stages.length ? 0 : 0
  return event
}

module.exports = { parseEmail, mergeEmail, sameEvent }
