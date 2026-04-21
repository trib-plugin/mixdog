import crypto from 'crypto'
import { CACHE_PATH, readJson, writeJson } from './config.mjs'

const DEFAULT_CACHE_STATE = {
  entries: {},
}

const FLUSH_DELAY_MS = 5000

let cacheDirty = false
let cacheFlushTimer = null
let activeCacheState = null

function nowMs() {
  return Date.now()
}

function scheduleCacheFlush(state) {
  cacheDirty = true
  activeCacheState = state
  if (cacheFlushTimer) return
  cacheFlushTimer = setTimeout(() => {
    flushCacheState()
  }, FLUSH_DELAY_MS)
}

function flushCacheState() {
  if (cacheFlushTimer) {
    clearTimeout(cacheFlushTimer)
    cacheFlushTimer = null
  }
  if (cacheDirty && activeCacheState) {
    writeJson(CACHE_PATH, activeCacheState)
    cacheDirty = false
  }
}

process.on('exit', flushCacheState)

export { flushCacheState }

let _instance = null

export function loadCacheState() {
  if (_instance) return _instance
  const state = readJson(CACHE_PATH, DEFAULT_CACHE_STATE)
  if (!state.entries || typeof state.entries !== 'object') {
    state.entries = {}
  }
  _instance = state
  activeCacheState = state
  pruneExpiredEntries(state)
  return state
}

export function saveCacheState(state) {
  scheduleCacheFlush(state)
}

export function buildCacheKey(namespace, payload) {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
  return `${namespace}:${hash}`
}

export function getCachedEntry(state, key) {
  const entry = state.entries[key]
  if (!entry) return null
  if (entry.expiresAt && entry.expiresAt <= nowMs()) {
    delete state.entries[key]
    scheduleCacheFlush(state)
    return null
  }
  return entry
}

export function setCachedEntry(state, key, payload, ttlMs) {
  const cachedAt = nowMs()
  state.entries[key] = {
    cachedAt,
    expiresAt: cachedAt + ttlMs,
    payload,
  }
  scheduleCacheFlush(state)
  return state.entries[key]
}

export function buildCacheMeta(entry, hit) {
  return {
    hit,
    cachedAt: entry ? new Date(entry.cachedAt).toISOString() : null,
    expiresAt: entry ? new Date(entry.expiresAt).toISOString() : null,
  }
}

function pruneExpiredEntries(state) {
  const current = nowMs()
  let dirty = false
  for (const [key, entry] of Object.entries(state.entries)) {
    if (entry?.expiresAt && entry.expiresAt <= current) {
      delete state.entries[key]
      dirty = true
    }
  }
  if (dirty) {
    scheduleCacheFlush(state)
  }
}
