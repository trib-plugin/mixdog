import { USAGE_PATH, readJson, writeJson } from './config.mjs'

const FLUSH_DELAY_MS = 5000

let usageDirty = false
let usageFlushTimer = null
let activeUsageState = null

function now() {
  return new Date().toISOString()
}

function defaultState() {
  return {
    providers: {},
    routingCache: {
      rawBySite: {},
      scrapeByHost: {},
    },
  }
}

function scheduleUsageFlush(state) {
  usageDirty = true
  activeUsageState = state
  if (usageFlushTimer) return
  usageFlushTimer = setTimeout(() => {
    flushUsageState()
  }, FLUSH_DELAY_MS)
}

function flushUsageState() {
  if (usageFlushTimer) {
    clearTimeout(usageFlushTimer)
    usageFlushTimer = null
  }
  if (usageDirty && activeUsageState) {
    writeJson(USAGE_PATH, activeUsageState)
    usageDirty = false
  }
}

process.on('exit', flushUsageState)

export { flushUsageState }

let _instance = null

export function loadUsageState() {
  if (_instance) return _instance
  const raw = readJson(USAGE_PATH, null)
  const def = defaultState()
  const state = raw && typeof raw === 'object' ? {
    ...def,
    ...raw,
    providers: { ...(raw.providers || {}) },
    routingCache: {
      rawBySite: { ...(def.routingCache.rawBySite), ...(raw.routingCache?.rawBySite || {}) },
      scrapeByHost: { ...(def.routingCache.scrapeByHost), ...(raw.routingCache?.scrapeByHost || {}) },
    },
  } : def
  _instance = state
  activeUsageState = state
  return state
}

export function saveUsageState(state) {
  scheduleUsageFlush(state)
}

export function updateProviderState(state, provider, patch) {
  let normalizedPatch = { ...patch }
  const remaining =
    typeof normalizedPatch.remaining === 'number' ? normalizedPatch.remaining : null
  const limit = typeof normalizedPatch.limit === 'number' ? normalizedPatch.limit : null

  if (
    limit &&
    limit > 0 &&
    remaining !== null &&
    typeof normalizedPatch.percentUsed !== 'number'
  ) {
    normalizedPatch.percentUsed = Number((((limit - remaining) / limit) * 100).toFixed(2))
  }

  state.providers[provider] = {
    ...(state.providers[provider] || {}),
    ...normalizedPatch,
    updatedAt: normalizedPatch.updatedAt || now(),
  }
  scheduleUsageFlush(state)
}

export function noteProviderSuccess(state, provider, extra = {}) {
  updateProviderState(state, provider, {
    ...extra,
    error: null,
    lastUsedAt: now(),
    lastSuccessAt: now(),
    cooldownUntil: null,
  })
}

export function noteProviderFailure(state, provider, errorMessage, cooldownMs = 0) {
  const payload = {
    error: errorMessage,
    lastUsedAt: now(),
    lastFailureAt: now(),
  }
  if (cooldownMs > 0) {
    payload.cooldownUntil = new Date(Date.now() + cooldownMs).toISOString()
  }
  updateProviderState(state, provider, payload)
}

export function rankProviders(baseProviders, state, site) {
  const currentTime = Date.now()
  const filtered = baseProviders.filter(provider => {
    const info = state.providers?.[provider]
    if (!info?.cooldownUntil) return true
    const t = new Date(info.cooldownUntil).getTime()
    return !Number.isFinite(t) || t <= currentTime
  })

  const ranked = filtered.length > 0 ? filtered : [...baseProviders]

  if (!site) return ranked
  const preferred = state.routingCache?.rawBySite?.[site]
  if (!preferred || !Array.isArray(preferred) || preferred.length === 0) {
    return ranked
  }
  const order = new Map(preferred.map((provider, index) => [provider, index]))
  return ranked.sort((left, right) => {
    const leftIndex = order.has(left) ? order.get(left) : Number.MAX_SAFE_INTEGER
    const rightIndex = order.has(right) ? order.get(right) : Number.MAX_SAFE_INTEGER
    return leftIndex - rightIndex
  })
}

export function rememberPreferredRawProviders(state, site, providers) {
  if (!site || !providers?.length) return
  state.routingCache.rawBySite[site] = [...providers]
  scheduleUsageFlush(state)
}

export function rememberPreferredScrapeExtractor(state, host, extractor) {
  if (!host || !extractor) return
  state.routingCache.scrapeByHost[host] = [extractor]
  scheduleUsageFlush(state)
}

export function rankScrapeExtractors(host, state, defaults) {
  const preferred = state.routingCache?.scrapeByHost?.[host]
  let base
  if (!preferred || !Array.isArray(preferred) || preferred.length === 0) {
    base = [...defaults]
  } else {
    base = [...preferred]
    for (const candidate of defaults) {
      if (!base.includes(candidate)) {
        base.push(candidate)
      }
    }
  }

  const currentTime = Date.now()
  const active = []
  const coolingDown = []
  for (const extractor of base) {
    const info = state.providers?.[extractor]
    if (info?.cooldownUntil && new Date(info.cooldownUntil).getTime() > currentTime) {
      coolingDown.push(extractor)
    } else {
      active.push(extractor)
    }
  }
  if (active.length > 0) {
    return [...active, ...coolingDown]
  }
  return coolingDown.sort((a, b) => {
    const aTime = new Date(state.providers?.[a]?.cooldownUntil).getTime()
    const bTime = new Date(state.providers?.[b]?.cooldownUntil).getTime()
    return aTime - bTime
  })
}
