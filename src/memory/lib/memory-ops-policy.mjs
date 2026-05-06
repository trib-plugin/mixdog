import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_OPS_POLICY = {
  features: {
    temporalParser: false,
  },
  startup: {
    // Startup catch-up disabled by default: was running inline embeddings
    // ~5s after server start, causing perceptible lag right after user typed.
    // Pending work is still handled by the regular 5-min cycle1 interval.
    cycle1CatchUp: {
      mode: 'off',
      delayMs: 5000,
      minPendingCandidates: 8,
      requireDue: false,
    },
    cycle2CatchUp: {
      mode: 'off',
      delayMs: 5000,
      requireDue: true,
    },
  },
  scheduler: {
    checkIntervalMs: 60_000,
  },
}

function coercePositiveInt(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

function normalizeBackfillWindow(value) {
  const normalized = String(value ?? 'all').trim().toLowerCase()
  if (['none', 'off', 'disabled', '0'].includes(normalized)) return 'none'
  if (['1d', '1day', '1-day', '1 day', 'day', 'today'].includes(normalized)) return '1d'
  if (['3d', '3days', '3-day', '3 day'].includes(normalized)) return '3d'
  if (['7d', '7days', '7-day', '7 day', 'week'].includes(normalized)) return '7d'
  if (['30d', '30days', '30-day', '30 day', 'month'].includes(normalized)) return '30d'
  return 'all'
}

function normalizeCatchUpMode(value, fallback = 'light') {
  const normalized = String(value ?? fallback).trim().toLowerCase()
  if (['off', 'none', 'disabled'].includes(normalized)) return 'off'
  if (['full', 'all', 'aggressive'].includes(normalized)) return 'full'
  return 'light'
}

function normalizeBackfillScope(value) {
  const normalized = String(value ?? 'all').trim().toLowerCase()
  if (['workspace', 'project', 'current'].includes(normalized)) return 'workspace'
  return 'all'
}

function envFlag(value, fallback = false) {
  if (value == null || value === '') return fallback
  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

export function readMemoryOpsPolicy(mainConfig = {}) {
  const runtimeConfig = mainConfig?.runtime ?? {}
  const featuresConfig = runtimeConfig?.features ?? {}
  const startupConfig = runtimeConfig?.startup ?? {}
  const cycle1CatchUpConfig = startupConfig?.cycle1CatchUp ?? {}
  const cycle2CatchUpConfig = startupConfig?.cycle2CatchUp ?? {}
  const schedulerConfig = runtimeConfig?.scheduler ?? {}

  return {
    features: {
      temporalParser: featuresConfig.temporalParser === true,
    },
    startup: {
      cycle1CatchUp: {
        mode: normalizeCatchUpMode(cycle1CatchUpConfig.mode, DEFAULT_OPS_POLICY.startup.cycle1CatchUp.mode),
        delayMs: coercePositiveInt(cycle1CatchUpConfig.delayMs, DEFAULT_OPS_POLICY.startup.cycle1CatchUp.delayMs),
        minPendingCandidates: coercePositiveInt(
          cycle1CatchUpConfig.minPendingCandidates,
          DEFAULT_OPS_POLICY.startup.cycle1CatchUp.minPendingCandidates,
        ),
        requireDue: cycle1CatchUpConfig.requireDue === true,
      },
      cycle2CatchUp: {
        mode: normalizeCatchUpMode(cycle2CatchUpConfig.mode, DEFAULT_OPS_POLICY.startup.cycle2CatchUp.mode),
        delayMs: coercePositiveInt(cycle2CatchUpConfig.delayMs, DEFAULT_OPS_POLICY.startup.cycle2CatchUp.delayMs),
        requireDue: cycle2CatchUpConfig.requireDue !== false,
      },
    },
    scheduler: {
      checkIntervalMs: coercePositiveInt(schedulerConfig.checkIntervalMs, DEFAULT_OPS_POLICY.scheduler.checkIntervalMs),
    },
  }
}

export function readMemoryFeatureFlags(mainConfig = {}) {
  const policy = readMemoryOpsPolicy(mainConfig)
  return {
    temporalParser: envFlag(process.env.MIXDOG_MEMORY_ENABLE_TEMPORAL_PARSER, policy.features.temporalParser),
  }
}

export function resolveBackfillSinceMs(windowValue, now = Date.now()) {
  const normalized = normalizeBackfillWindow(windowValue)
  if (normalized === '1d') return now - (1 * 24 * 60 * 60 * 1000)
  if (normalized === '3d') return now - (3 * 24 * 60 * 60 * 1000)
  if (normalized === '7d') return now - (7 * 24 * 60 * 60 * 1000)
  if (normalized === '30d') return now - (30 * 24 * 60 * 60 * 1000)
  return null
}

export async function countUnclassified(db) {
  if (!db) return 0
  try {
    const row = (await db.query(`SELECT COUNT(*) c FROM entries WHERE chunk_root IS NULL`, [])).rows[0]
    return Number(row?.c ?? 0)
  } catch {
    return 0
  }
}

export function selectBackfillTranscripts({ sinceMs = null, limit = null, projectsRoot = null } = {}) {
  const root = projectsRoot || path.join(os.homedir(), '.claude', 'projects')
  if (!fs.existsSync(root)) return []
  const files = []
  for (const d of fs.readdirSync(root)) {
    if (d.includes('tmp') || d.includes('cache') || d.includes('plugins')) continue
    const full = path.join(root, d)
    try {
      for (const f of fs.readdirSync(full)) {
        if (!f.endsWith('.jsonl') || f.startsWith('agent-')) continue
        const fp = path.join(full, f)
        let mtime
        try { mtime = fs.statSync(fp).mtimeMs } catch { continue }
        if (sinceMs != null && mtime < sinceMs) continue
        files.push({ path: fp, mtime })
      }
    } catch {}
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const capped = (limit != null && Number(limit) > 0) ? files.slice(0, Number(limit)) : files
  return capped.map(f => f.path).reverse()
}

const FULL_BACKFILL_MAX_ITERS = 30
const BACKFILL_CONCURRENCY = 3

export async function runFullBackfill(db, {
  window = '7d',
  scope = 'all',
  limit = null,
  config = {},
  dataDir = null,
  ingestTranscriptFile,
  cwdFromTranscriptPath,
  runCycle1,
  runCycle2,
  now = Date.now(),
  projectsRoot = null,
} = {}) {
  if (typeof ingestTranscriptFile !== 'function') {
    throw new Error('runFullBackfill: ingestTranscriptFile required')
  }
  if (typeof runCycle1 !== 'function' || typeof runCycle2 !== 'function') {
    throw new Error('runFullBackfill: runCycle1/runCycle2 required')
  }

  const normalizedWindow = normalizeBackfillWindow(window)
  const normalizedScope = normalizeBackfillScope(scope)
  const sinceMs = resolveBackfillSinceMs(normalizedWindow, now)
  const selected = selectBackfillTranscripts({ sinceMs, limit, projectsRoot })

  let ingested = 0
  let cursor = 0
  const workers = Array.from({ length: BACKFILL_CONCURRENCY }, async () => {
    while (cursor < selected.length) {
      const idx = cursor++
      const fp = selected[idx]
      try {
        const cwd = typeof cwdFromTranscriptPath === 'function' ? cwdFromTranscriptPath(fp) : undefined
        const n = Number(await ingestTranscriptFile(fp, { cwd }) ?? 0)
        ingested += n
      } catch (err) {
        process.stderr.write(`[backfill] ingest failed (${fp}): ${err.message}\n`)
      }
    }
  })
  await Promise.all(workers)

  let cycle1Iters = 0
  let prevUnclassified = await countUnclassified(db)
  while (prevUnclassified > 0 && cycle1Iters < FULL_BACKFILL_MAX_ITERS) {
    let result
    try {
      result = await runCycle1(db, config?.cycle1 || {}, {}, dataDir)
    } catch (err) {
      process.stderr.write(`[backfill] cycle1 error (iter=${cycle1Iters}): ${err.message}\n`)
      break
    }
    cycle1Iters += 1
    if (Number(result?.processed ?? 0) === 0) break
    const nextUnclassified = await countUnclassified(db)
    if (nextUnclassified >= prevUnclassified) break
    prevUnclassified = nextUnclassified
  }

  let promoted = 0
  try {
    const c2 = await runCycle2(db, config?.cycle2 || {}, {}, dataDir)
    promoted = Number(c2?.promoted ?? 0)
  } catch (err) {
    process.stderr.write(`[backfill] cycle2 error: ${err.message}\n`)
  }

  const unclassified = await countUnclassified(db)
  return {
    window: normalizedWindow,
    scope: normalizedScope,
    files: selected.length,
    ingested,
    cycle1_iters: cycle1Iters,
    promoted,
    unclassified,
  }
}

export function shouldRunCycleCatchUp(kind, policy, state = {}) {
  const config = kind === 'cycle2'
    ? policy?.startup?.cycle2CatchUp
    : policy?.startup?.cycle1CatchUp
  const mode = config?.mode ?? 'off'
  if (mode === 'off') return false

  const due = Boolean(state.due)
  const unclassified = Number(state.unclassifiedEpisodes ?? state.pendingCandidates ?? 0)
  const pendingEmbeds = Number(state.pendingEmbeds ?? 0)
  const missingLastRun = !state.lastRunAt

  if (kind === 'cycle2') {
    if (mode === 'full') return due || unclassified > 0 || missingLastRun
    return config?.requireDue !== false ? due : (due || unclassified > 0 || missingLastRun)
  }

  if (mode === 'full') return due || unclassified > 0 || pendingEmbeds > 0 || missingLastRun
  if (config?.requireDue === true) return due
  return due || unclassified >= Number(config?.minPendingCandidates ?? 0) || (missingLastRun && (unclassified > 0 || pendingEmbeds > 0))
}
