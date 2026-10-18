const { MongoClient, ObjectId } = require('mongodb')
const { sameEvent } = require('./gmail')

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017'
const databaseName = process.env.MONGODB_DATABASE || 'UniTracker'
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 })
let initialization
const locks = new Map()

const collection = async () => {
  if (!initialization) {
    initialization = client.connect().then(async () => {
      const events = client.db(databaseName).collection('events')
      await events.createIndex({ accountEmail: 1, eventKey: 1 }, { unique: true, name: 'account_event_key' })
      await events.createIndex({ accountEmail: 1, archived: 1, updatedAt: -1 }, { name: 'account_archive_updated' })
      return events
    }).catch((error) => {
      initialization = null
      throw error
    })
  }
  return initialization
}

const normalizedKey = (name) => name.toLowerCase()
  .replace(/\b(registration|registered|confirmation|confirmed|participant|shortlisted|shortlist|next steps|reminder|update|invitation|invite|hackathon|hackathons|event|re|fwd)\b/gi, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .split(/\s+/)
  .filter(Boolean)
  .sort()
  .join('-') || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')

const withUserLock = async (email, operation) => {
  const previous = locks.get(email) || Promise.resolve()
  let release
  const current = new Promise((resolve) => { release = resolve })
  const queued = previous.then(() => current)
  locks.set(email, queued)
  await previous
  try { return await operation() } finally {
    release()
    if (locks.get(email) === queued) locks.delete(email)
  }
}

const mergeMessage = async (accountEmail, message, preferences = {}) => withUserLock(accountEmail, async () => {
  const events = await collection()
  const existingEvents = await events.find({ accountEmail }, { projection: { _id: 1, name: 1, eventKey: 1 } }).toArray()
  const existing = existingEvents.find((event) => sameEvent(event.name, message.name))
  const key = existing?.eventKey || normalizedKey(message.name)
  const now = new Date()
  const set = { updatedAt: now }
  for (const field of ['venue', 'date', 'startTime']) if (message[field]) set[field] = message[field]
  if (preferences.origin) set.origin = preferences.origin
  if (Number.isFinite(preferences.bufferMinutes)) set.bufferMinutes = preferences.bufferMinutes
  if (preferences.mapLink) set.mapLink = preferences.mapLink
  if (preferences.route) set.route = preferences.route
  if (preferences.leaveBy) set.leaveBy = preferences.leaveBy
  const insert = {
    accountEmail,
    eventKey: key,
    name: message.name,
    org: 'From Gmail',
    type: 'Hackathons',
    current: 0,
    archived: false,
    archivedAt: null,
    createdAt: now,
    venue: '',
    date: '',
    startTime: '',
    bufferMinutes: 30,
    origin: '',
    confirmation: '',
    route: null,
    mapLink: '',
    leaveBy: '',
  }
  for (const field of Object.keys(set)) delete insert[field]
  const filter = existing ? { _id: existing._id, accountEmail } : { accountEmail, eventKey: key }
  const addToSet = {
    messageIds: message.messageId,
    sources: { $each: [message.source, ...(message.sources || [])] },
    stages: { $each: message.nextSteps || [] },
    snippets: { $each: message.snippets || [] },
    links: { $each: message.links || [] },
    emailDetails: { $each: [{ messageId: message.messageId, subject: message.subject, receivedAt: message.receivedAt, source: message.source, confirmation: message.confirmation, nextSteps: message.nextSteps || [], snippets: message.snippets || [], links: message.links || [], venue: message.venue, date: message.date, startTime: message.startTime }] },
  }
  if (message.confirmation) addToSet.confirmationDetails = message.confirmation
  const update = {
    $set: set,
    $setOnInsert: insert,
    $addToSet: addToSet,
  }
  let result
  try {
    result = await events.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' })
  } catch (error) {
    if (error.code !== 11000) throw error
    result = await events.findOneAndUpdate({ accountEmail, eventKey: key }, update, { returnDocument: 'after' })
  }
  return result
})

const createManualEvent = async (accountEmail, details) => withUserLock(accountEmail, async () => {
  const events = await collection()
  const candidates = await events.find({ accountEmail }, { projection: { _id: 1, name: 1, eventKey: 1, emailSearchCompleted: 1 } }).toArray()
  const existing = candidates.find((event) => sameEvent(event.name, details.name))
  const now = new Date()
  const key = existing?.eventKey || normalizedKey(details.name)
  const set = {
    updatedAt: now,
    org: details.org,
    type: details.type,
    manualEntry: true,
    emailSearchCompleted: existing?.emailSearchCompleted === true,
  }
  for (const field of ['venue', 'date', 'startTime', 'confirmation', 'origin', 'bufferMinutes', 'route', 'mapLink', 'leaveBy']) {
    if (details[field] !== undefined) set[field] = details[field]
  }
  const insert = {
    accountEmail,
    eventKey: key,
    name: details.name,
    org: details.org,
    type: details.type,
    current: 0,
    archived: false,
    archivedAt: null,
    createdAt: now,
    venue: '',
    date: '',
    startTime: '',
    confirmation: '',
    origin: '',
    bufferMinutes: 30,
    route: null,
    mapLink: '',
    leaveBy: '',
    emailSearchCompleted: false,
    manualEntry: true,
  }
  for (const field of Object.keys(set)) delete insert[field]
  const update = {
    $set: set,
    $setOnInsert: insert,
    $addToSet: {
      sources: { $each: ['Manual entry'] },
      stages: { $each: details.stages || [] },
      links: { $each: details.links || [] },
    },
  }
  const filter = existing ? { _id: existing._id, accountEmail } : { accountEmail, eventKey: key }
  try {
    return await events.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' })
  } catch (error) {
    if (error.code !== 11000) throw error
    return events.findOneAndUpdate({ accountEmail, eventKey: key }, update, { returnDocument: 'after' })
  }
})

const claimEmailSearch = async (accountEmail, id) => {
  if (!ObjectId.isValid(id)) return null
  const events = await collection()
  return events.findOneAndUpdate(
    { _id: new ObjectId(id), accountEmail, emailSearchCompleted: { $ne: true } },
    { $set: { emailSearchCompleted: true, emailSearchStartedAt: new Date(), updatedAt: new Date() } },
    { returnDocument: 'after' },
  )
}

const completeEmailSearch = async (accountEmail, id, result) => {
  if (!ObjectId.isValid(id)) return null
  const events = await collection()
  return events.findOneAndUpdate(
    { _id: new ObjectId(id), accountEmail },
    { $set: { emailSearchResult: result.status, emailSearchCount: result.count || 0, emailSearchError: result.error || '', emailSearchFinishedAt: new Date(), updatedAt: new Date() } },
    { returnDocument: 'after' },
  )
}

const listEvents = async (accountEmail, archived) => {
  const events = await collection()
  return events.find({ accountEmail, ...(typeof archived === 'boolean' ? { archived } : {}) }).sort({ updatedAt: -1 }).toArray()
}

const ensureDemoEvents = async (accountEmail) => withUserLock(accountEmail, async () => {
  const events = await collection()
  const seeds = [
    { name: 'HackShift 2026', org: 'IIIT Delhi', type: 'Hackathons', venue: 'IIIT Delhi, Okhla', date: 'Oct 17, 2026', source: 'Demo event', stages: ['Registration milestone · Completed', 'Shortlist milestone · Date pending', 'Finale milestone · Oct 17 · IIIT Delhi'] },
    { name: 'CodeSprint Workshop', org: 'Coding Club', type: 'Workshops', venue: 'Seminar Hall 2', date: 'Oct 21, 2026', source: 'Demo event', stages: ['Registration milestone · Completed', 'Workshop milestone · Oct 21 · 10:00 AM'] },
  ]
  const existing = await events.find({ accountEmail }, { projection: { name: 1 } }).toArray()
  for (const seed of seeds) {
    if (existing.some((event) => sameEvent(event.name, seed.name))) continue
    const now = new Date()
    await events.updateOne({ accountEmail, eventKey: normalizedKey(seed.name) }, { $setOnInsert: {
      accountEmail, eventKey: normalizedKey(seed.name), ...seed, current: 0, links: [], sources: [seed.source], messageIds: [], emailDetails: [], confirmationDetails: [], snippets: [], archived: false, archivedAt: null, manualEntry: false, emailSearchCompleted: false, bufferMinutes: 30, origin: '', route: null, mapLink: '', leaveBy: '', confirmation: '', createdAt: now, updatedAt: now,
    } }, { upsert: true })
  }
})

const setArchived = async (accountEmail, id, archived) => {
  if (!ObjectId.isValid(id)) return null
  const events = await collection()
  return events.findOneAndUpdate({ _id: new ObjectId(id), accountEmail }, { $set: { archived, archivedAt: archived ? new Date() : null, updatedAt: new Date() } }, { returnDocument: 'after' })
}

const databaseHealth = async () => {
  await (await collection())
  await client.db(databaseName).command({ ping: 1 })
  return true
}

module.exports = { claimEmailSearch, collection, completeEmailSearch, createManualEvent, databaseHealth, ensureDemoEvents, listEvents, mergeMessage, setArchived }
