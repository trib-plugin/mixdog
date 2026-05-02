#!/usr/bin/env bun
process.removeAllListeners('warning')
process.on('warning', () => {})

import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readPluginVersion() {
  try {
    const manifestPath = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version || '0.0.1'
  } catch { return '0.0.1' }
}
const PLUGIN_VERSION = readPluginVersion()

try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
try {
  const { env } = await import('@huggingface/transformers')
  env.backends.onnx.wasm.numThreads = 1
} catch {}

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import {
  openDatabase,
  closeDatabase,
  isBootstrapComplete,
  getMetaValue,
  setMetaValue,
  cleanMemoryText,
} from './lib/memory.mjs'
import { configureEmbedding, embedText, getEmbeddingDims } from './lib/embedding-provider.mjs'
import { startLlmWorker, stopLlmWorker } from './lib/llm-worker-host.mjs'
import { runCycle1, runCycle2, parseInterval, syncRootEmbedding } from './lib/memory-cycle.mjs'
import { searchRelevantHybrid } from './lib/memory-recall-store.mjs'
import { retrieveEntries } from './lib/memory-retrievers.mjs'
import { resetEmbeddingIndex, pruneOldEntries } from './lib/memory-maintenance-store.mjs'
import { computeEntryScore, freshnessFactor } from './lib/memory-score.mjs'
import { runFullBackfill } from './lib/memory-ops-policy.mjs'

import { resolvePluginData } from '../shared/plugin-paths.mjs'
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || process.argv[2]
  || (() => {
    const candidates = [
      resolvePluginData(),
    ]
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, 'memory.sqlite'))) return c
    }
    return null
  })()
if (!DATA_DIR) {
  process.stderr.write('[memory-service] CLAUDE_PLUGIN_DATA not set and no fallback found\n')
  process.exit(1)
}
process.stderr.write(`[memory-service] DATA_DIR=${DATA_DIR}\n`)

import { execFileSync } from 'child_process'
const LOCK_FILE = path.join(DATA_DIR, '.memory-service.lock')

const RUNTIME_DIR = path.join(os.tmpdir(), 'mixdog-memory')
try { fs.mkdirSync(RUNTIME_DIR, { recursive: true }) } catch {}
const PORT_FILE = path.join(RUNTIME_DIR, 'memory-port')
const BASE_PORT = 3350
const MAX_PORT = 3357

const MEMORY_INSTRUCTIONS_TEXT = (() => {
  try {
    return fs.readFileSync(path.join(PLUGIN_ROOT, 'rules', 'shared', '02-memory.md'), 'utf8').trim()
  } catch (e) {
    process.stderr.write(`[memory] rules/shared/02-memory.md load failed: ${e.message}\n`)
    return ''
  }
})()

const PROXY_TOOL_DEFS = [
  { name: 'memory', description: 'Run memory management operations.', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } },
  { name: 'search_memories', description: 'Search past context and memory.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: [] } },
]

function readPortFile() {
  try {
    const port = Number(fs.readFileSync(PORT_FILE, 'utf8').trim())
    return (port >= BASE_PORT && port <= MAX_PORT) ? port : null
  } catch { return null }
}

async function isExistingServerHealthy() {
  const port = readPortFile()
  if (!port) return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
    clearTimeout(timer)
    if (res.ok) return port
  } catch {}
  return null
}

async function runProxyMode(port) {
  process.stderr.write(`[memory-service] Healthy server on port ${port}, entering proxy mode\n`)
  const proxyMcp = new Server(
    { name: 'mixdog-memory', version: PLUGIN_VERSION },
    { capabilities: { tools: {} }, instructions: MEMORY_INSTRUCTIONS_TEXT },
  )
  proxyMcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: PROXY_TOOL_DEFS }))
  proxyMcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 120000)
      const res = await fetch(`http://127.0.0.1:${port}/api/tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: req.params.name, arguments: req.params.arguments ?? {} }),
        signal: controller.signal,
      })
      clearTimeout(timer)
      // Normalise the upstream response so the proxy always emits a
      // valid MCP envelope. Older /api/tool versions could return
      // bare {text|error|ok} shapes, which broke MCP clients that
      // require a content[] array. Pass through anything already in
      // canonical form; wrap legacy / error / non-200 shapes.
      const json = await res.json().catch(() => null)
      if (!res.ok || !json) {
        const detail = json ? JSON.stringify(json).slice(0, 500) : `HTTP ${res.status}`
        return { content: [{ type: 'text', text: `proxy error: ${detail}` }], isError: true }
      }
      if (Array.isArray(json.content)) {
        // Canonical envelope shape, but caller may still signal failure
        // via `ok:false` / `isError:true` / `error`. Force isError to
        // true in those cases so MCP clients don't read the failure as
        // a successful no-op.
        if (json.error || json.isError === true || json.ok === false) {
          return { ...json, isError: true }
        }
        return json
      }
      const fallbackText = typeof json === 'string'
        ? json
        : (json.text || json.error || json.message || JSON.stringify(json))
      return {
        content: [{ type: 'text', text: String(fallbackText) }],
        // Legacy `{ ok: false, text: "..." }` shape carries error
        // intent in `ok` rather than a dedicated error key, so honour
        // either signal when deciding isError.
        isError: Boolean(json.error || json.isError || json.ok === false),
      }
    } catch (err) {
      return { content: [{ type: 'text', text: `proxy error: ${err.message}` }], isError: true }
    }
  })
  const transport = new StdioServerTransport()
  await proxyMcp.connect(transport)
  await new Promise((resolve) => { proxyMcp.onclose = resolve })
}

function killPreviousServer(pid) {
  if (pid <= 0 || pid === process.pid) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { encoding: 'utf8', timeout: 5000, stdio: 'ignore' })
      process.stderr.write(`[memory-service] Killed previous server PID ${pid}\n`)
    } catch {}
  } else {
    try { process.kill(pid, 'SIGTERM') } catch {}
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
}

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockedPid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim())
      if (lockedPid > 0 && lockedPid !== process.pid) {
        killPreviousServer(lockedPid)
      }
    }
    const fd = fs.openSync(LOCK_FILE, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    try {
      fs.writeSync(fd, String(process.pid))
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    if (e.code !== 'EEXIST') {
      process.stderr.write(`[memory-service] Lock acquisition failed: ${e.message}\n`)
    } else {
      process.stderr.write(`[memory-service] Lock file exists (EEXIST) — concurrent startup, skipping\n`)
    }
  }
}

function releaseLock() {
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim()
    if (Number(content) === process.pid) fs.unlinkSync(LOCK_FILE)
  } catch {}
}

function readMainConfig() {
  const memoryConfigPath = path.join(DATA_DIR, 'memory-config.json')
  try {
    const raw = JSON.parse(fs.readFileSync(memoryConfigPath, 'utf8'))
    if (raw.enabled !== undefined || raw.cycle1 || raw.cycle2) return raw
  } catch {}
  const mainConfigPath = path.join(DATA_DIR, 'config.json')
  try {
    const raw = JSON.parse(fs.readFileSync(mainConfigPath, 'utf8'))
    if (raw.memory && (raw.memory.cycle1 || raw.memory.enabled !== undefined)) return raw.memory
    return raw
  } catch { return {} }
}

let db = null
let mainConfig = null
let _cycleInterval = null
let _startupTimeout = null
// Outer-layer cycle1 in-flight tracker (MCP-server scope).
//
// The AUTHORITATIVE guard lives in memory-cycle.mjs:runCycle1 itself — that
// one catches every caller, including direct imports (setup-server backfill,
// policy-layer backfill). This outer tracker is kept as a defense-in-depth
// layer local to the MCP server process: it coalesces simultaneous
// _awaitCycle1Run callers (MCP action, scheduler, flush) onto a shared
// promise so they all observe the SAME result object rather than some
// getting the real stats and others getting `skippedInFlight: true` from
// the inner guard.
let _cycle1InFlight = null // shared cycle1 promise (outer coalesce layer)
let _initialized = false
let _bootTimestamp = null
let _transcriptOffsets = new Map()

const TRANSCRIPT_OFFSETS_KEY = 'state.transcript_offsets'
const CYCLE_LAST_RUN_KEY = 'state.cycle_last_run'

async function _initStore() {
  mainConfig = readMainConfig()
  const embeddingConfig = mainConfig?.embedding
  if (embeddingConfig?.provider || embeddingConfig?.ollamaModel || embeddingConfig?.dtype) {
    configureEmbedding({
      provider: embeddingConfig.provider,
      ollamaModel: embeddingConfig.ollamaModel,
      dtype: embeddingConfig.dtype,
    })
  }
  const dims = Number(getEmbeddingDims())
  db = openDatabase(DATA_DIR, dims)
  if (!isBootstrapComplete(db)) {
    throw new Error('memory-service: bootstrap not complete after openDatabase')
  }
  startLlmWorker()
  _bootTimestamp = Date.now()
  loadTranscriptOffsets()
}

function loadTranscriptOffsets() {
  try {
    const raw = getMetaValue(db, TRANSCRIPT_OFFSETS_KEY, '{}')
    const obj = JSON.parse(raw)
    _transcriptOffsets = new Map(Object.entries(obj))
  } catch {
    _transcriptOffsets = new Map()
  }
}

function persistTranscriptOffsets() {
  try {
    const obj = Object.fromEntries(_transcriptOffsets)
    setMetaValue(db, TRANSCRIPT_OFFSETS_KEY, JSON.stringify(obj))
  } catch (e) {
    process.stderr.write(`[memory] persist transcript offsets failed: ${e.message}\n`)
  }
}

function getCycleLastRun() {
  try {
    const raw = getMetaValue(db, CYCLE_LAST_RUN_KEY, '{}')
    const obj = JSON.parse(raw)
    return {
      cycle1: Number(obj.cycle1) || 0,
      cycle2: Number(obj.cycle2) || 0,
      // Phase B §2.4 auto-restart book-keeping — last time an overdue cycle1
      // triggered an unscheduled run, rate-limited separately from the
      // normal cycle timestamp so a long chain of failures cannot tight-loop.
      cycle1_autoRestart: Number(obj.cycle1_autoRestart) || 0,
      // #13/#14: heartbeat (every attempt, success or skip) and the auto-
      // restart attempt timestamp (committed BEFORE the call) are tracked
      // separately from the success timestamps above so a long string of
      // failed/skipped runs cannot disguise itself as a healthy keeper.
      cycle1_heartbeat: Number(obj.cycle1_heartbeat) || 0,
      cycle1_autoRestart_attempt: Number(obj.cycle1_autoRestart_attempt) || 0,
    }
  } catch {
    return {
      cycle1: 0, cycle2: 0, cycle1_autoRestart: 0,
      cycle1_heartbeat: 0, cycle1_autoRestart_attempt: 0,
    }
  }
}

function setCycleLastRun(kind, ts) {
  const cur = getCycleLastRun()
  cur[kind] = ts
  setMetaValue(db, CYCLE_LAST_RUN_KEY, JSON.stringify(cur))
}

// Raw-row priority lookup for narrow-window queries. Raw rows (is_root=0,
// chunk_root IS NULL) are inserted immediately by ingestTranscriptFile before
// cycle1 runs, so they always carry the freshest turns in the DB.
function readRawRowsInWindow(db, tsFromMs, tsToMs, hardLimit = 10) {
  try {
    const stmt = db.prepare(
      `SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
              element, category, summary, status, score, last_seen_at
       FROM entries
       WHERE chunk_root IS NULL AND is_root = 0
         AND ts >= ? AND ts <= ?
       ORDER BY ts DESC
       LIMIT ?`
    )
    return stmt.all(tsFromMs ?? 0, tsToMs ?? Date.now(), hardLimit)
      .map(r => ({ ...r, retrievalScore: 0, rrf: 0 }))
  } catch { return [] }
}

function ingestTranscriptFile(transcriptPath) {
  if (!fs.existsSync(transcriptPath)) return 0
  const stat = fs.statSync(transcriptPath)
  const sessionUuid = path.basename(transcriptPath, '.jsonl')
  const prev = _transcriptOffsets.get(transcriptPath) ?? { bytes: 0, lineIndex: 0 }
  if (stat.size < prev.bytes) {
    prev.bytes = 0
    prev.lineIndex = 0
  }
  if (stat.size <= prev.bytes) return 0

  const fd = fs.openSync(transcriptPath, 'r')
  const buf = Buffer.alloc(stat.size - prev.bytes)
  fs.readSync(fd, buf, 0, buf.length, prev.bytes)
  fs.closeSync(fd)
  prev.bytes = stat.size
  const lines = buf.toString('utf8').split('\n').filter(Boolean)

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO entries(ts, role, content, source_ref, session_id, source_turn)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  let count = 0
  let index = prev.lineIndex
  for (const line of lines) {
    index += 1
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }
    const role = parsed.message?.role
    if (role !== 'user' && role !== 'assistant') continue
    const content = firstTextContent(parsed.message?.content)
    if (!content || !content.trim()) continue
    const cleaned = cleanMemoryText(content)
    if (!cleaned) continue
    const tsMs = parseTsToMs(parsed.timestamp ?? parsed.ts ?? Date.now())
    const sourceRef = `transcript:${sessionUuid}#${index}`
    try {
      const result = insertStmt.run(tsMs, role, cleaned, sourceRef, sessionUuid, index)
      if (result.changes > 0) count += 1
    } catch (e) {
      process.stderr.write(`[transcript-watch] insert error (${sourceRef}): ${e.message}\n`)
    }
  }
  prev.lineIndex = index
  _transcriptOffsets.set(transcriptPath, prev)
  persistTranscriptOffsets()
  return count
}

function firstTextContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  for (const item of content) {
    if (typeof item === 'string') return item
    if (item?.type === 'text' && typeof item.text === 'string') return item.text
  }
  return ''
}

function parseTsToMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function _initTranscriptWatcher() {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects')
  const SAFETY_POLL_MS = 5 * 60_000
  const DEBOUNCE_MS = 500
  const watchedFiles = new Map()
  const pendingByFile = new Map()

  function isWatchable(relOrBase) {
    const base = path.basename(relOrBase)
    if (!base.endsWith('.jsonl') || base.startsWith('agent-')) return false
    if (relOrBase.includes('tmp') || relOrBase.includes('cache') || relOrBase.includes('plugins')) return false
    return true
  }

  function ingestOne(fp) {
    try {
      if (!fs.existsSync(fp)) return
      const mtime = fs.statSync(fp).mtimeMs
      const prev = watchedFiles.get(fp)
      if (prev && prev >= mtime) return
      watchedFiles.set(fp, mtime)
      const n = ingestTranscriptFile(fp)
      if (n > 0) {
        process.stderr.write(`[transcript-watch] ingested ${n} entries from ${path.basename(fp)}\n`)
      }
    } catch (e) {
      process.stderr.write(`[transcript-watch] ingest error: ${e.message}\n`)
    }
  }

  function scheduleIngest(fp) {
    const existing = pendingByFile.get(fp)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      pendingByFile.delete(fp)
      ingestOne(fp)
    }, DEBOUNCE_MS)
    pendingByFile.set(fp, timer)
  }

  function discoverActiveTranscripts() {
    if (!fs.existsSync(projectsRoot)) return []
    const files = []
    try {
      for (const d of fs.readdirSync(projectsRoot)) {
        if (d.includes('tmp') || d.includes('cache') || d.includes('plugins')) continue
        const full = path.join(projectsRoot, d)
        try {
          for (const f of fs.readdirSync(full)) {
            if (!f.endsWith('.jsonl') || f.startsWith('agent-')) continue
            const fp = path.join(full, f)
            const mtime = fs.statSync(fp).mtimeMs
            files.push({ path: fp, mtime })
          }
        } catch {}
      }
    } catch {}
    const cutoff = Date.now() - 30 * 60_000
    return files.filter(f => f.mtime > cutoff)
  }

  function safetySweep() {
    try {
      const active = discoverActiveTranscripts()
      for (const { path: fp } of active) ingestOne(fp)
    } catch (e) {
      process.stderr.write(`[transcript-watch] safety sweep error: ${e.message}\n`)
    }
  }

  setTimeout(safetySweep, 3_000)
  setInterval(safetySweep, SAFETY_POLL_MS)

  try {
    const watcher = fs.watch(projectsRoot, { recursive: true, persistent: true }, (_event, filename) => {
      if (!filename) return
      if (!isWatchable(filename)) return
      const fp = path.join(projectsRoot, filename)
      scheduleIngest(fp)
    })
    watcher.on('error', (err) => {
      process.stderr.write(`[transcript-watch] fs.watch error: ${err.message}\n`)
    })
    process.stderr.write(`[transcript-watch] fs.watch active on ${projectsRoot} (safety sweep every ${SAFETY_POLL_MS / 60_000}min)\n`)
  } catch (e) {
    process.stderr.write(`[transcript-watch] fs.watch setup failed: ${e.message} — relying on safety sweep only\n`)
  }
}

// Phase B §2.4 — cache-keeper health thresholds.
// warning fires when cycle1 is overdue past HEALTH_OVERDUE_MS; an auto-
// restart attempt fires when the warning has been emitted AND the most
// recent unscheduled restart was more than AUTO_RESTART_COOLDOWN_MS ago.
// Both default to 5 min per spec; caller overrides are not exposed yet.
const CYCLE1_HEALTH_OVERDUE_MS = 5 * 60_000
const CYCLE1_AUTO_RESTART_COOLDOWN_MS = 5 * 60_000

function _startCycle1Run(config = {}, options = {}) {
  _cycle1InFlight = (async () => {
    try {
      const result = await runCycle1(db, config, options)
      // #13: heartbeat (attempt) is always recorded so the overdue check
      // can tell the keeper is alive; success timestamp only advances when
      // the run actually did work. Skipped/in-flight runs do NOT count as
      // success because the next overdue check would otherwise see a fake
      // green and stop forcing auto-restarts.
      const now = Date.now()
      setCycleLastRun('cycle1_heartbeat', now)
      const skipped = result?.skippedInFlight === true
      const allFailed = !skipped
        && Number(result?.chunks ?? 0) === 0
        && Number(result?.processed ?? 0) === 0
        && Number(result?.skipped ?? 0) > 0
      if (!skipped && !allFailed) {
        setCycleLastRun('cycle1', now)
      }
      return result
    } finally {
      if (_cycle1InFlight === promise) _cycle1InFlight = null
    }
  })()
  const promise = _cycle1InFlight
  return _cycle1InFlight
}

async function _awaitCycle1Run(config = {}, options = {}) {
  const target = _cycle1InFlight || _startCycle1Run(config, options)
  const callerDeadlineMs = Number(options.callerDeadlineMs) || 0
  if (callerDeadlineMs <= 0) return await target
  // Caller-deadline race. When the channels-side timeout fires, we
  // (a) graceful-return a skippedInFlight envelope so the calling
  // SessionStart slot stops blocking with a 200 OK + flags instead of a
  // 503-class throw, and (b) release the outer in-flight handle. The
  // underlying LLM run keeps progressing in the background — it still
  // owns the inner dedup guard (memory-cycle.mjs _runCycle1InFlight).
  // Releasing the outer handle is what breaks the cascade: any later
  // _awaitCycle1Run call now re-enters _startCycle1Run, whose inner
  // runCycle1 short-circuits with skippedInFlight:true the moment it
  // sees the same db still busy. Returning a graceful object (vs the
  // pre-0.1.198 throw) keeps the channel route response shape stable
  // and lets pollers read inFlight=true rather than parse an error.
  let timer
  const deadlinePromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (_cycle1InFlight === target) _cycle1InFlight = null
      resolve({
        processed: 0,
        chunks: 0,
        skipped: 0,
        sessions: 0,
        skippedInFlight: true,
        timedOutWaiting: true,
        callerDeadlineMs,
      })
    }, callerDeadlineMs)
  })
  try {
    return await Promise.race([target, deadlinePromise])
  } finally {
    clearTimeout(timer)
  }
}

// Periodic cycle1 sizing: only enter when ≥ 20 pending rows have built up,
// then split into 2 windows of 50 rows each (≤100 rows per tick). The on-
// demand path used by SessionStart hooks runs with a 1-row threshold and
// 4×25 windows instead — see hooks/session-start.cjs:481. mainConfig.cycle1
// values still win, so users can override any of these in config.json.
function periodicCycle1Config() {
  return {
    min_batch: 20,
    session_cap: 2,
    batch_size: 50,
    ...(mainConfig?.cycle1 || {}),
  }
}

async function checkCycles() {
  if (mainConfig?.enabled === false) return

  const cycle1Ms = parseInterval(mainConfig?.cycle1?.interval || '10m')
  const cycle2Ms = parseInterval(mainConfig?.cycle2?.interval || '1h')

  const now = Date.now()
  const last = getCycleLastRun()

  // Phase B §2.4 — cache-keeper health check + auto-restart.
  //
  // `last.cycle1 + cycle1Ms` is the next scheduled run time; anything beyond
  // that by > HEALTH_OVERDUE_MS means the keeper missed its window and the
  // Anthropic shard is drifting cold. Emit a warning, and — if we haven't
  // retried in the last cooldown window — force an unscheduled run so the
  // shard gets re-touched before the next Worker / Sub call pays the 2×
  // write premium. Cooldown prevents a tight retry loop when the underlying
  // cause (network, provider outage) is still broken.
  //
  // Cold-start guard: a fresh DB has last.cycle1 = 0, which would make
  // (now - 0 - cycle1Ms) blow past HEALTH_OVERDUE_MS on every first boot
  // and force-trigger the auto-restart branch even though the shard never
  // existed in the first place. The "drifting cold" concept doesn't apply
  // until at least one successful run has anchored a baseline.
  const cycle1OverdueMs = last.cycle1 > 0
    ? Math.max(0, now - last.cycle1 - cycle1Ms)
    : 0
  if (cycle1OverdueMs > CYCLE1_HEALTH_OVERDUE_MS) {
    const lastSeen = last.cycle1 ? new Date(last.cycle1).toISOString() : 'never'
    process.stderr.write(
      `[cycle1] overdue by ${Math.floor(cycle1OverdueMs / 60_000)}min `
      + `(last=${lastSeen}). Pool B Anthropic shard may be cold.\n`
    )
    const lastAutoRestart = last.cycle1_autoRestart || 0
    if (now - lastAutoRestart >= CYCLE1_AUTO_RESTART_COOLDOWN_MS) {
      // #14: record the attempt timestamp BEFORE the call (so a hung run
      // cannot tight-loop) and the result timestamp only on success. On
      // failure we return immediately instead of falling through into the
      // due branch — falling through would silently re-enter the same
      // failing path within the same tick.
      setCycleLastRun('cycle1_autoRestart_attempt', now)
      try {
        const result = await _awaitCycle1Run(periodicCycle1Config())
        setCycleLastRun('cycle1_autoRestart', Date.now())
        process.stderr.write(
          `[cycle1] auto-restart completed chunks=${result?.chunks ?? 0} processed=${result?.processed ?? 0}\n`
        )
        return
      } catch (e) {
        process.stderr.write(`[cycle1] auto-restart error: ${e.message}\n`)
        // Cooldown attempt timestamp is committed; do NOT fall through
        // to the due branch — next tick will retry after cooldown.
        return
      }
    }
  }

  if (now - last.cycle1 >= cycle1Ms) {
    try {
      const result = await _awaitCycle1Run(periodicCycle1Config())
      process.stderr.write(`[cycle1] completed chunks=${result?.chunks ?? 0} processed=${result?.processed ?? 0}\n`)
    } catch (e) {
      process.stderr.write(`[cycle1] error: ${e.message}\n`)
    }
  }

  if (now - last.cycle2 >= cycle2Ms) {
    try {
      await runCycle2(db, mainConfig?.cycle2 || {})
      setCycleLastRun('cycle2', Date.now())
      process.stderr.write(`[cycle2] completed\n`)
    } catch (e) {
      process.stderr.write(`[cycle2] error: ${e.message}\n`)
    }
  }
}

// #12: self-rescheduling timer. setInterval would fire ticks regardless of
// whether the previous checkCycles() call had finished; with cycle1/cycle2
// each potentially taking minutes, that races. Use setTimeout that re-arms
// itself only after the prior tick resolves, plus an in-flight guard so a
// stray manual call cannot stack ticks.
let _checkCyclesInFlight = false
async function _runCheckCyclesGuarded() {
  if (_checkCyclesInFlight) return
  _checkCyclesInFlight = true
  try { await checkCycles() }
  catch (e) { process.stderr.write(`[cycle-tick] error: ${e.message}\n`) }
  finally { _checkCyclesInFlight = false }
}
function _scheduleNextCheck() {
  _cycleInterval = setTimeout(async () => {
    _cycleInterval = null
    await _runCheckCyclesGuarded()
    if (_cyclesActive) _scheduleNextCheck()
  }, 60_000)
}
let _cyclesActive = false
function _startCycles() {
  if (_cyclesActive) return
  _cyclesActive = true
  _scheduleNextCheck()
  _startupTimeout = setTimeout(() => { void _runCheckCyclesGuarded() }, 30_000)
}

function _stopCycles() {
  _cyclesActive = false
  if (_cycleInterval) { clearTimeout(_cycleInterval); _cycleInterval = null }
  if (_startupTimeout) { clearTimeout(_startupTimeout); _startupTimeout = null }
}

async function _initRuntime() {
  await _initStore()
  _initTranscriptWatcher()
  _startCycles()
  _initialized = true
  import('./lib/embedding-provider.mjs').then(m => m.warmupEmbeddingProvider()).catch(() => {})
}

function fmtDateOnly(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function parsePeriod(period, hasQuery) {
  if (!period && hasQuery) period = '30d'
  if (!period) return null
  if (period === 'all') return null
  if (period === 'last') return { mode: 'last' }
  // Calendar-day windows: 'today' anchors at local midnight rather than
  // rolling 24h. Without this, a query asking '오늘' at 01:30 would silently
  // include yesterday's last 22.5h of activity, mislabelling them as
  // 'today's work'. 'yesterday' is the previous calendar day.
  if (period === 'today') {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return { startMs: start.getTime(), endMs: Date.now() }
  }
  if (period === 'yesterday') {
    const start = new Date()
    start.setDate(start.getDate() - 1)
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setHours(23, 59, 59, 999)
    return { startMs: start.getTime(), endMs: end.getTime() }
  }
  if (period === 'this_week' || period === 'last_week') {
    // R6 P9: calendar Mon-Sun previous/current week. Mon-start ISO
    // convention. Replaces R5 rolling 7-14d range which was empty for
    // sessions where "지난주" decisions actually fell on Mon (4/27) of
    // this week. Precise calendar bounds match Korean intuition.
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    const dayOfWeek = d.getDay()
    const daysSinceMon = (dayOfWeek + 6) % 7
    const thisWeekMon = new Date(d)
    thisWeekMon.setDate(d.getDate() - daysSinceMon)
    if (period === 'this_week') {
      return { startMs: thisWeekMon.getTime(), endMs: Date.now() }
    }
    const lastWeekMon = new Date(thisWeekMon)
    lastWeekMon.setDate(thisWeekMon.getDate() - 7)
    const lastWeekSunEnd = new Date(thisWeekMon.getTime() - 1)
    return { startMs: lastWeekMon.getTime(), endMs: lastWeekSunEnd.getTime() }
  }
  const relMatch = period.match(/^(\d+)(h|d)$/)
  if (relMatch) {
    const n = parseInt(relMatch[1])
    const unit = relMatch[2]
    const now = new Date()
    if (unit === 'h') {
      const start = new Date(now.getTime() - n * 3600_000)
      return { startMs: start.getTime(), endMs: now.getTime() }
    }
    const start = new Date(now)
    start.setDate(start.getDate() - n)
    return { startMs: start.getTime(), endMs: now.getTime() }
  }
  const rangeMatch = period.match(/^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/)
  if (rangeMatch) {
    return {
      startMs: Date.parse(rangeMatch[1] + 'T00:00:00'),
      endMs:   Date.parse(rangeMatch[2] + 'T23:59:59.999'),
    }
  }
  const dateMatch = period.match(/^(\d{4}-\d{2}-\d{2})$/)
  if (dateMatch) {
    return {
      startMs: Date.parse(dateMatch[1] + 'T00:00:00'),
      endMs:   Date.parse(dateMatch[1] + 'T23:59:59.999'),
      exact: true,
    }
  }
  return null
}

function formatTs(tsMs) {
  const n = Number(tsMs)
  if (Number.isFinite(n) && n > 1e12) {
    return new Date(n).toLocaleString('sv-SE').slice(0, 16)
  }
  return String(tsMs ?? '').slice(0, 16)
}

async function handleSearch(args) {
  // Array query — fan out in parallel, each query runs its own hybrid search
  // path, and results are grouped in the response so the caller sees one
  // ranked list per angle. Collapses what would otherwise be N sequential
  // tool calls into a single invocation.
  if (Array.isArray(args.query)) {
    // Dedup + fan-out cap. The cap protects the result envelope from
    // over-eager callers (20+ near-duplicate queries N× the IO) without
    // silently swallowing the caller's intent: when the input exceeds
    // QUERIES_CAP, prepend a one-line note so the caller can see the
    // truncation and re-shape their query list.
    const QUERIES_CAP = 5
    const dedup = [...new Set(args.query.map(q => String(q || '').trim()).filter(Boolean))]
    if (dedup.length === 0) return { text: '' }
    const queries = dedup.slice(0, QUERIES_CAP)
    const dropped = dedup.length - queries.length
    const rest = { ...args }
    delete rest.query
    const deadlineSec = Math.max(1, Number(process.env.MEMORY_FANOUT_DEADLINE_S) || 180)
    const deadlineMs = deadlineSec * 1000
    const fanOutAbort = new AbortController()
    let deadlineTimer
    const deadlineRace = new Promise((_res, rej) => {
      deadlineTimer = setTimeout(() => {
        fanOutAbort.abort(new Error(`memory fan-out deadline exceeded (${deadlineSec}s)`))
        rej(Object.assign(new Error(`memory fan-out deadline exceeded (${deadlineSec}s)`), { _deadline: true }))
      }, deadlineMs)
    })
    let settled
    try {
      settled = await Promise.race([
        Promise.allSettled(queries.map(async (q) => {
          if (fanOutAbort.signal.aborted) throw fanOutAbort.signal.reason
          const sub = await handleSearch({ ...rest, query: q })
          return `[${q}]\n${sub.text || '(no results)'}`
        })),
        deadlineRace,
      ])
    } catch (err) {
      if (!err._deadline) throw err
      settled = queries.map((_q, i) =>
        settled?.[i] ?? { status: 'rejected', reason: fanOutAbort.signal.reason }
      )
    } finally {
      clearTimeout(deadlineTimer)
    }
    const parts = settled.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : `[${queries[i]}]\n(error: ${r.reason?.message || r.reason})`
    )
    const header = dropped > 0
      ? `note: ${dedup.length} queries received, ${queries.length} processed, ${dropped} dropped (cap ${QUERIES_CAP})\n\n`
      : ''
    return { text: header + parts.join('\n\n') }
  }
  const query = String(args.query ?? '').trim()
  let period = String(args.period ?? '').trim() || undefined
  // Auto-derive period from time keywords in the query when the caller did
  // not pass one explicitly. The recall-agent rules try to map these but
  // models occasionally skip the mapping; this engine-side fallback ensures
  // 'right now / 지금 / 방금 / 현재 / today / 오늘' always activates the
  // narrow-window pre-filter and JSONL tail merge below.
  if (!period && query) {
    const q = query.toLowerCase()
    if (/(지금|방금|현재|몇분전|방금전|1시간 이내|한 시간 이내|몇분 전|조금 전|좀 전|얼마 전|잠깐 전|최근 1시간|right now|just now|this minute|a few minutes ago|a moment ago|moments ago|a little while ago|right this second|in the last hour|past hour|within an hour)/.test(q)) {
      period = '1h'
    } else if (/(어제|yesterday)/.test(q)) {
      period = 'yesterday'
    } else if (/(오늘|today|this hour|today's session|this session|이번 세션)/.test(q)) {
      // Calendar 'today' (since local midnight) instead of rolling 24h.
      period = 'today'
    } else if (/(24시간 이내|하루 이내|last 24 hours)/.test(q)) {
      period = '1d'
    } else if (/(지난주|last week)/.test(q)) {
      // R5 P7: 지난주 → calendar-style previous-week window (7–14d ago)
      // instead of rolling 7d which silently included today and this week.
      period = 'last_week'
    } else if (/(이번주|this week)/.test(q)) {
      // R6 P9: 이번주 → calendar Mon-now (this calendar week) instead
      // of rolling 7d which silently included last weekend.
      period = 'this_week'
    } else if (/(7일 이내|last 7 days|past 7 days)/.test(q)) {
      period = '7d'
    } else if (/(최근 며칠|지난 며칠|recent days|past few days|few days ago|며칠간|며칠동안|지난 [2-7]일|이틀|사흘|나흘)/.test(q)) {
      // R5 P6: vague multi-day cues collapse to 3d so candidate window
      // covers today + last 2 days, freshness factor handles ranking.
      period = '3d'
    } else if (/(이번달|지난달|this month|last month|30일 이내)/.test(q)) {
      period = '30d'
    } else if (/(이어서|계속|지금까장|지금까지|방금까지|진행 상황|현재 작업|마지막 작업|최근 작업|최근 변경|최근 진행|진행 중|continuing|continue from|where.*left off|pick up.*from|latest progress|current status|current work|ongoing now|right now status)/.test(q)) {
      // Vague-time continuation cues map to `today` so the candidate
      // window narrows to the current calendar day. Without this the
      // engine defaults to 30d and BM25 surfaces fact-rich older entries
      // over the freshest current-session events (#16812 recency bias
      // root cause for vague-time queries).
      period = 'today'
    }
  }
  // R6 P12: detect chronological cues so "가장 최근 결정 / 최근 결정 /
  // 시간순 / 순서대로 / recent decisions / chronological / date order"
  // queries return ts-DESC ordering even in mid/wide windows, instead of
  // letting BM25 surface lexically-rich older entries first. Forced sort
  // is overridden by an explicit caller sort.
  let forcedSort = null
  if (query) {
    const cq = query.toLowerCase()
    if (/(가장 최근|최근 결정|시간순|순서대로|낙시순|최근 동향|최근 이벤트|chronological|date order|recent decisions|recent events|latest decisions|latest events|most recent decisions)/.test(cq)) {
      forcedSort = 'date'
    }
  }
  const limit = Math.max(1, Number(args.limit ?? 10))
  const offset = Math.max(0, Number(args.offset ?? 0))
  const sort = args.sort != null ? String(args.sort) : (forcedSort ?? 'importance')
  const includeMembers = Boolean(args.includeMembers)
  const temporal = parsePeriod(period, Boolean(query))

  // R11 reviewer M4: calendar-bounded periods disable freshness decay
  // so within-period ranking doesn't downgrade Mon entries vs Sun.
  const CALENDAR_PERIODS = new Set(['yesterday', 'today', 'this_week', 'last_week'])
  const isCalendarPeriod = period != null
    && (CALENDAR_PERIODS.has(period) || /^\d{4}-\d{2}-\d{2}/.test(period))
  const applyFreshness = !isCalendarPeriod

  if (query) {
    const queryVector = await embedText(query).catch(() => null)
    // Push ts and status filters into the hybrid candidate query so FTS / vec
    // rank inside the requested window, not the whole tree. The previous post-
    // filter approach silently emptied results when relevant matches sat
    // outside `period` (default 30d) and could not bubble through.
    const results = await searchRelevantHybrid(db, query, {
      limit: limit + offset,
      queryVector: Array.isArray(queryVector) ? queryVector : null,
      includeMembers,
      ts_from: temporal?.startMs,
      ts_to: temporal?.endMs,
      applyFreshness,
    })
    let filtered = results
    // Narrow-window fallback: caller asked for 'today / right now / just now
    // / 1d' (≤24h) and hybrid found nothing because the freshest evidence
    // lives in raw NULL chunks whose content does not lexically overlap the
    // caller's exact tokens (cycle1 has not produced an `element/summary`
    // yet). Pull both classified roots and raw chunks in the window so the
    // recall-agent can render them as `[raw]` recent-window evidence per
    // its rules.
    const narrowWindowMs = 24 * 60 * 60 * 1000
    const isNarrow = temporal?.startMs != null
      && temporal?.endMs != null
      && (temporal.endMs - temporal.startMs) <= narrowWindowMs
    // P5 R3: ALWAYS augment narrow-window candidate pool with chronological
    // scan results. The previous behaviour (run only on empty hybrid) caused
    // BM25 to seed `filtered` with topic-matched older entries while the
    // freshest in-window items never entered the candidate set, so freshness
    // factor had nothing to rank. Now we union hybrid hits with the full
    // window scan and dedup by id; sort=date default below makes ts the
    // ranking key for narrow windows.
    // R5 P8: extend augment to mid-band (>24h, ≤7d). Narrow keeps
    // root+raw, mid-band keeps roots only so week-scope queries get
    // classified decisions injected without the noise of raw turn
    // chunks. Augmented entries carry freshnessFactor so they tiebreak
    // with low-tier hybrid hits but never overtake high-quality matches.
    const sevenDayMs = 7 * 24 * 60 * 60 * 1000
    const isMidWindow = !isNarrow
      && temporal?.startMs != null
      && temporal?.endMs != null
      && (temporal.endMs - temporal.startMs) <= sevenDayMs * 1.1
    if (isNarrow || isMidWindow) {
      // R11 reviewer H2/M3: exclude archived/demoted, scope raw to orphan
      // chunks (chunk_root IS NULL) so member rows of classified roots
      // can't duplicate their root in the augment pool.
      const baseFilters = {
        limit: Math.max(limit + offset, isNarrow ? 24 : 32),
        ts_from: temporal.startMs,
        ts_to: temporal.endMs,
        excludeStatuses: ['archived', 'demoted'],
      }
      if (includeMembers) baseFilters.includeMembers = true
      const rootHits = retrieveEntries(db, { ...baseFilters, is_root: true })
      const rawHits = isNarrow
        ? retrieveEntries(db, { ...baseFilters, is_root: false, chunkRootNull: true })
        : []
      const existingIds = new Set(filtered.map(f => Number(f.id)))
      const nowForAugment = Date.now()
      for (const r of [...rootHits, ...rawHits]) {
        const id = Number(r.id)
        if (existingIds.has(id)) continue
        existingIds.add(id)
        // R11 reviewer M4: calendar periods skip freshness within-window.
        const fresh = applyFreshness ? freshnessFactor(r.ts, nowForAugment) : 1.0
        const augBase = isNarrow ? 0.005 : 0.012
        filtered.push({ ...r, retrievalScore: augBase * fresh, rrf: 0, freshness: fresh })
      }
    }
    // Raw-row merge for narrow windows: raw rows (chunk_root IS NULL, is_root=0)
    // are inserted immediately by ingestTranscriptFile so they carry the
    // freshest turns available in the DB. Merge and deduplicate against hybrid
    // results; apply a freshness boost so recent raw rows sort to the top.
    if (isNarrow) {
      const rawEntries = readRawRowsInWindow(
        db,
        temporal.startMs,
        temporal.endMs,
        Math.max(limit + offset, 6),
      )
      if (rawEntries.length > 0) {
        const dedupKey = (r) => {
          const head = String(r.content || r.element || '').replace(/\s+/g, ' ').slice(0, 80)
          return `${Number(r.ts) || 0}|${r.role || ''}|${head}`
        }
        const dbKeys = new Set(filtered.map(dedupKey))
        const nowMs = Date.now()
        const fresh = rawEntries
          .filter(t => !dbKeys.has(dedupKey(t)))
          .map(t => {
            const ageMs = Math.max(0, nowMs - Number(t.ts || 0))
            const ageMinutes = ageMs / (60 * 1000)
            const boost = ageMinutes < 5 ? 1.0
              : ageMinutes < 30 ? 0.5
              : ageMinutes < 60 ? 0.2
              : 0.1
            return { ...t, retrievalScore: boost, rrf: boost }
          })
        filtered = [...fresh, ...filtered]
      }
    }
    // P5 R3: narrow-window queries default to chronological sort. Caller
    // semantics for "today / 지금까지 / 이어서 / 최근 진행" is "latest
    // events", not "most lexically relevant". Explicit sort='importance'
    // still works for callers that want BM25-ranked narrow searches.
    // R6 P12: forcedSort wins over narrow-window auto-default.
    const effectiveSort = (args.sort != null)
      ? sort
      : (forcedSort ?? (isNarrow ? 'date' : sort))
    if (effectiveSort === 'date') {
      // R11 reviewer L5: NaN guard — entries with null/undefined ts default
      // to 0 so the comparator stays numeric and stable.
      filtered.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
    } else {
      filtered.sort((a, b) => {
        const sa = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
        return (sa(b.retrievalScore ?? b.rrf ?? 0) - sa(a.retrievalScore ?? a.rrf ?? 0))
          || (sa(b.score ?? 0) - sa(a.score ?? 0))
          || (sa(b.ts ?? 0) - sa(a.ts ?? 0))
          || (Number(a.id ?? 0) - Number(b.id ?? 0))
      })
    }
    const sliced = filtered.slice(offset, offset + limit)
    return { text: renderEntryLines(sliced) }
  }

  const filters = { limit: limit + offset }
  if (temporal?.startMs != null) { filters.ts_from = temporal.startMs; filters.ts_to = temporal.endMs }
  if (temporal?.mode === 'last' && _bootTimestamp) {
    filters.ts_to = _bootTimestamp - 1
  }
  if (includeMembers) filters.includeMembers = true
  const rows = retrieveEntries(db, filters)
  const sliced = rows.slice(offset, offset + limit)
  return { text: renderEntryLines(sliced) }
}

function _turnRange(row, members) {
  // Leaves carry their own jsonl turn index.
  if (row.is_root !== 1 && Number.isFinite(Number(row.source_turn))) {
    return String(row.source_turn)
  }
  // Roots aggregate members — emit "min-max" (or just "N" when all members
  // collapse on one turn). Chunks that pre-date the v2 schema will have no
  // source_turn on members and therefore no turn anchor; that is the
  // expected fallback, not an error.
  if (row.is_root === 1 && Array.isArray(members) && members.length > 0) {
    const turns = members
      .map(m => Number(m?.source_turn))
      .filter(n => Number.isFinite(n))
    if (turns.length > 0) {
      const min = Math.min(...turns)
      const max = Math.max(...turns)
      return min === max ? String(min) : `${min}-${max}`
    }
  }
  return null
}

function _renderAnchor(row, members, opts) {
  // Origin anchor. Default mode emits only the entry id so the recall
  // envelope stays compact — sid/turns add ~30 chars per row and were
  // never used outside debug/includeMembers paths. Verbose mode (opts.
  // verbose=true) restores the full sid/turns trailer for transcript
  // navigation; callers that need it (includeMembers, debug rendering)
  // pass it explicitly.
  // The id is emitted as `#NNNN` so it matches the citation form the
  // recall-agent rules require verbatim, removing the translation step
  // (`id:NNNN` → `#NNNN`) where transposition errors used to creep in.
  const verbose = Boolean(opts && opts.verbose)
  const bits = []
  if (verbose && row.session_id) bits.push(`sid:${String(row.session_id).slice(0, 8)}`)
  if (row.id != null) bits.push(`#${row.id}`)
  if (verbose) {
    const turn = _turnRange(row, members)
    if (turn) bits.push(`turns:${turn}`)
  }
  return bits.length > 0 ? `  ⟨${bits.join(' ')}⟩` : ''
}

function renderEntryLines(rows) {
  if (!rows || rows.length === 0) return '(no results)'
  const lines = []
  for (const r of rows) {
    const ts = formatTs(r.ts)
    const cat = r.category ? `[${r.category}] ` : ''
    const element = r.element ?? ''
    const summary = r.summary ?? ''
    // Distinguish classified entries (cycle1 produced element/summary) from
    // raw turns. Raw rows are recent conversation slices with no `element`
    // or `summary`; the agent should treat them as weak evidence rather
    // than as a confident citation. The [raw] marker plus the missing
    // [category] gives the recall-agent a visible signal to label them
    // tentative per the retrieval-role-principles weak-match rule.
    // The [weak] marker fires when retrievalScore is near the relevance
    // floor — the synthesizer can then refuse to grant the entry a
    // confident citation per the weak-only rule.
    const score = Number(r.retrievalScore ?? r.rrf ?? 0)
    const weakTag = (Number.isFinite(score) && score > 0 && score < 0.012) ? '[weak] ' : ''
    const head = element || summary
      ? `${weakTag}${cat}${element}${summary ? ' — ' + summary : ''}`
      : `${weakTag}[raw] ${cleanMemoryText(String(r.content ?? '')).slice(0, 300)}`
    lines.push(`[${ts}] ${head.slice(0, 500)}${_renderAnchor(r, r.members)}`)
    if (Array.isArray(r.members) && r.members.length > 0) {
      for (const m of r.members) {
        const mTs = formatTs(m.ts)
        const prefix = m.role === 'user' ? 'u' : m.role === 'assistant' ? 'a' : (m.role || '?')
        lines.push(`  [${mTs}] ${prefix}: ${cleanMemoryText(String(m.content ?? '')).slice(0, 200)}${_renderAnchor(m)}`)
      }
    }
  }
  return lines.join('\n')
}

function entryStats() {
  const total = db.prepare(`SELECT COUNT(*) c FROM entries`).get().c
  const roots = db.prepare(`SELECT COUNT(*) c FROM entries WHERE is_root = 1`).get().c
  const unclassified = db.prepare(`SELECT COUNT(*) c FROM entries WHERE chunk_root IS NULL`).get().c
  const byStatus = db.prepare(`
    SELECT status, COUNT(*) c FROM entries WHERE is_root = 1 GROUP BY status
  `).all()
  const byCategory = db.prepare(`
    SELECT category, COUNT(*) c FROM entries
    WHERE is_root = 1 AND status = 'active'
    GROUP BY category ORDER BY c DESC
  `).all()
  return { total, roots, unclassified, byStatus, byCategory }
}

async function handleMemoryAction(args) {
  const action = String(args.action ?? '')
  const config = readMainConfig()

  if (action === 'status') {
    const stats = entryStats()
    const last = getCycleLastRun()
    const dims = Number(getMetaValue(db, 'embedding.current_dims', '0'))
    const vecReady = Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE name='vec_entries'`).get())
    const lastCycle1Ago = last.cycle1 ? `${Math.round((Date.now() - last.cycle1) / 60000)}m ago` : 'never'
    const lastCycle2Ago = last.cycle2 ? `${Math.round((Date.now() - last.cycle2) / 60000)}m ago` : 'never'
    const lines = [
      `entries: total=${stats.total} roots=${stats.roots} unclassified=${stats.unclassified}`,
      `status: ${stats.byStatus.map(r => `${r.status ?? 'NULL'}:${r.c}`).join(', ') || 'empty'}`,
      `categories(active): ${stats.byCategory.map(r => `${r.category ?? 'NULL'}:${r.c}`).join(', ') || 'empty'}`,
      `vec_entries: ${vecReady ? 'ready' : 'missing'} dims=${dims}`,
      `bootstrap: ${isBootstrapComplete(db) ? 'complete' : 'incomplete'}`,
      `last_cycle1: ${lastCycle1Ago}`,
      `last_cycle2: ${lastCycle2Ago}`,
    ]
    return { text: lines.join('\n') }
  }

  if (action === 'cycle1') {
    const minBatchOverride = Number(args?.min_batch)
    const sessionCapOverride = Number(args?.session_cap)
    const batchSizeOverride = Number(args?.batch_size)
    const baseCycle1 = config?.cycle1 || {}
    let cycle1Config = baseCycle1
    // _runCycle1Impl reads `config?.min_batch ?? config?.cycle1?.min_batch ??
    // default` — top-level wins, so pin the override at top-level only.
    if (Number.isFinite(minBatchOverride) && minBatchOverride > 0) {
      cycle1Config = { ...cycle1Config, min_batch: minBatchOverride }
    }
    if (Number.isFinite(sessionCapOverride) && sessionCapOverride > 0) {
      cycle1Config = { ...cycle1Config, session_cap: sessionCapOverride }
    }
    if (Number.isFinite(batchSizeOverride) && batchSizeOverride > 0) {
      cycle1Config = { ...cycle1Config, batch_size: batchSizeOverride }
    }
    const callerDeadlineMs = Number(args?._callerDeadlineMs) || 0
    const result = await _awaitCycle1Run(
      cycle1Config,
      callerDeadlineMs > 0 ? { callerDeadlineMs } : {},
    )
    const pendingStr = result?.pendingRows != null ? result.pendingRows : 0
    const inFlightStr = result?.skippedInFlight === true ? 'true' : 'false'
    const timedOutPart = result?.timedOutWaiting === true ? ' timedOut=true' : ''
    return { text: `cycle1: chunks=${result.chunks} processed=${result.processed} skipped=${result.skipped} pending=${pendingStr} inFlight=${inFlightStr}${timedOutPart}` }
  }

  if (action === 'cycle2' || action === 'sleep') {
    const result = await runCycle2(db, config?.cycle2 || {})
    setCycleLastRun('cycle2', Date.now())
    const promoted = result?.promoted ?? result?.merged ?? 0
    const reviewed = result?.reviewed ?? result?.processed ?? 0
    return { text: `cycle2 promoted=${promoted} reviewed=${reviewed}` }
  }

  if (action === 'flush') {
    const r1 = await _awaitCycle1Run(config?.cycle1 || {})
    const r2 = await runCycle2(db, config?.cycle2 || {})
    setCycleLastRun('cycle2', Date.now())
    return { text: `flush: cycle1 chunks=${r1.chunks} processed=${r1.processed}, cycle2 ${JSON.stringify(r2)}` }
  }

  if (action === 'rebuild') {
    if (args.confirm !== 'REBUILD MEMORY') {
      return { text: 'rebuild requires confirm: "REBUILD MEMORY" (truncates classification columns and re-runs cycles)', isError: true }
    }
    db.prepare(`UPDATE entries SET chunk_root = NULL, is_root = 0 WHERE chunk_root = id`).run()
    db.prepare(`UPDATE entries SET chunk_root = NULL WHERE is_root = 0`).run()
    db.prepare(`
      UPDATE entries
      SET element = NULL, category = NULL, summary = NULL,
          status = NULL, score = NULL, last_seen_at = NULL,
          embedding = NULL, summary_hash = NULL
      WHERE is_root = 1 OR (chunk_root IS NULL)
    `).run()
    const r1 = await _awaitCycle1Run(config?.cycle1 || {})
    const r2 = await runCycle2(db, config?.cycle2 || {})
    setCycleLastRun('cycle2', Date.now())
    return { text: `rebuild: cycle1 chunks=${r1.chunks} processed=${r1.processed}, cycle2 ${JSON.stringify(r2)}` }
  }

  if (action === 'prune') {
    if (args.confirm !== 'PRUNE OLD ENTRIES') {
      return { text: 'prune requires confirm: "PRUNE OLD ENTRIES" (permanently deletes unclassified entries older than maxDays)', isError: true }
    }
    const days = Math.max(1, Number(args.maxDays ?? 30))
    const result = pruneOldEntries(db, days)
    return { text: `prune: deleted ${result.deleted} unclassified entries older than ${days} days` }
  }

  if (action === 'backfill') {
    const window = args.window != null ? String(args.window) : '7d'
    const scope = args.scope != null ? String(args.scope) : 'all'
    const limit = args.limit != null ? Math.max(1, Number(args.limit)) : null
    const result = await runFullBackfill(db, {
      window,
      scope,
      limit,
      config,
      ingestTranscriptFile,
      runCycle1: (dbArg, cycle1Config = {}, options = {}) => _awaitCycle1Run(cycle1Config, options),
      runCycle2,
    })
    setCycleLastRun('cycle2', Date.now())
    return {
      text: `backfill: window=${result.window} scope=${result.scope} files=${result.files} ingested=${result.ingested} cycle1_iters=${result.cycle1_iters} promoted=${result.promoted} unclassified=${result.unclassified}`,
    }
  }

  if (action === 'remember') {
    const element = String(args.element ?? '').trim()
    const category = String(args.category ?? args.importance ?? 'fact').trim().toLowerCase()
    const summary = String(args.summary ?? args.element ?? '').trim()
    if (!element || !summary) {
      return { text: 'remember requires element and summary', isError: true }
    }
    const VALID = new Set(['rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue'])
    if (!VALID.has(category)) {
      return { text: `remember: invalid category "${category}". Valid: ${[...VALID].join(', ')}`, isError: true }
    }
    const nowMs = Date.now()
    const sourceRef = `manual:${nowMs}-${process.pid}`
    db.exec('BEGIN')
    try {
      const result = db.prepare(`
        INSERT INTO entries(ts, role, content, source_ref, session_id)
        VALUES (?, 'system', ?, ?, NULL)
      `).run(nowMs, element + ' — ' + summary, sourceRef)
      const newId = Number(result.lastInsertRowid)
      const score = computeEntryScore(category, nowMs, nowMs)
      db.prepare(`
        UPDATE entries
        SET chunk_root = ?, is_root = 1, element = ?, category = ?, summary = ?,
            status = 'active', score = ?, last_seen_at = ?
        WHERE id = ?
      `).run(newId, element, category, summary, score, nowMs, newId)
      db.exec('COMMIT')
      await syncRootEmbedding(db, newId)
      return { text: `remembered (id=${newId}): [${category}] ${element} — ${summary.slice(0, 200)}` }
    } catch (e) {
      try { db.exec('ROLLBACK') } catch {}
      return { text: `remember failed: ${e.message}`, isError: true }
    }
  }

  if (action === 'delete') {
    if (args.confirm !== 'DELETE ALL MEMORY') {
      return { text: 'delete requires confirm: "DELETE ALL MEMORY"', isError: true }
    }
    const preCount = db.prepare(`SELECT COUNT(*) c FROM entries`).get().c
    db.exec('BEGIN')
    try {
      db.prepare(`DELETE FROM entries`).run()
      // FTS + vec_entries are maintained via AFTER DELETE triggers on
      // entries, so cascade happens automatically. Explicit safety net
      // below in case a future migration drops a trigger.
      try { db.exec(`DELETE FROM entries_fts`) } catch {}
      try { db.exec(`DELETE FROM vec_entries`) } catch {}
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch {}
      return { text: `delete failed: ${e.message}`, isError: true }
    }
    return { text: `deleted all memory entries (count=${preCount})` }
  }

  if (action === 'forget') {
    const rawId = args.id
    const rawElement = args.element
    const id = rawId != null && rawId !== '' ? Number(rawId) : null
    const elementQuery = rawElement != null ? String(rawElement).trim() : ''

    if ((id == null || !Number.isFinite(id)) && !elementQuery) {
      return { text: 'forget requires id or element', isError: true }
    }

    if (id != null && Number.isFinite(id) && id > 0) {
      const info = db.prepare(
        `SELECT category, element, status, is_root FROM entries WHERE id = ?`,
      ).get(id)
      if (!info) return { text: `forget: no entry with id=${id}`, isError: true }
      if (info.is_root !== 1) return { text: `forget: id=${id} is not a root`, isError: true }
      if (info.status !== 'active') return { text: `forget: id=${id} status=${info.status ?? 'NULL'} (not active)`, isError: true }
      const result = db.prepare(
        `UPDATE entries SET status = 'archived' WHERE id = ? AND is_root = 1 AND status = 'active'`,
      ).run(id)
      if (result.changes === 0) return { text: `forget: id=${id} no change`, isError: true }
      return { text: `forgotten (id=${id}): [${info.category ?? '-'}] ${info.element ?? ''}` }
    }

    const matches = db.prepare(
      `SELECT id, category, element FROM entries
       WHERE is_root = 1 AND status = 'active' AND element LIKE ?
       ORDER BY id ASC`,
    ).all(`%${elementQuery}%`)
    if (matches.length === 0) return { text: `forget: no active root matches "${elementQuery}"`, isError: true }
    if (matches.length > 1) {
      const preview = matches.slice(0, 10).map(r => `id=${r.id} "${r.element}"`).join(', ')
      const extra = matches.length > 10 ? ` (+${matches.length - 10} more)` : ''
      return { text: `forget: ${matches.length} candidates — ${preview}${extra}`, isError: true }
    }
    const target = matches[0]
    db.prepare(`UPDATE entries SET status = 'archived' WHERE id = ?`).run(target.id)
    return { text: `forgotten (id=${target.id}): [${target.category}] ${target.element}` }
  }

  return { text: `unknown memory action: ${action}`, isError: true }
}

// The canonical TOOL_DEFS for this module. `public: false` entries are
// reachable through the in-process dispatcher (Pool C executors, synthetic
// tool registrations) but are not advertised via ListTools / tools.json, so
// they never reach an external LLM. `aiWrapped: true` routes dispatches
// through ai-wrapped-dispatch.mjs instead of the module's handleToolCall.
const TOOL_DEFS = [
  {
    name: 'memory',
    title: 'Memory Cycle',
    annotations: { title: 'Memory Cycle', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Run memory operations: cycle1, cycle2/sleep (promote+dedup), flush, prune, status, remember (store fact), forget (archive a root), backfill, rebuild, delete. Destructive ops (rebuild, prune, delete) require matching `confirm` string.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['sleep','cycle2','flush','rebuild','rebuild_classifications','prune','cycle1','backfill','status','remember','forget','delete'], description: 'Operation to run' },
        topic: { type: 'string', description: 'Topic for remember' },
        element: { type: 'string', description: 'Content for remember; also accepted as a substring match target for forget' },
        importance: { type: 'string', description: 'Importance for remember (default: fact)' },
        maxDays: { type: 'number', description: 'Age threshold in days for the `prune` action. Unclassified entries older than this are deleted. Default 30, minimum 1. Ignored by other actions.' },
        window: { type: 'string', description: 'Time window: 1d, 3d, 7d, 30d, all' },
        limit: { type: 'number', description: 'Max episodes to backfill (default 100)' },
        id: { type: 'number', description: 'Entry id for forget action.' },
        confirm: { type: 'string', description: 'Required for destructive actions: "DELETE ALL MEMORY" for delete, "PRUNE OLD ENTRIES" for prune, "REBUILD MEMORY" for rebuild. Must match exactly.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'recall',
    title: 'Recall',
    aiWrapped: true,
    annotations: { title: 'Recall', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Past project/session memory store — try this first; never grep/read/bash for memory questions. `query`: single rich NL query (default — one internal agent judges multi-angle probes & synthesizes) or array of strings (N independent agents, mechanical merge, no cross-synthesis — only for genuinely unrelated asks). Lead: async (merged answer auto-pushed via channel). Role sessions: sync in-turn. Use `background:true/false` to override. External web → `search`, codebase → `explore`.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 }], description: 'Single NL string, or array of strings for unrelated multi-question.' },
        cwd: { type: 'string', description: 'Optional workspace hint.' },
        background: { type: 'boolean', description: 'Default false (sync). Set true for heavy queries to dispatch async and receive answer via channel.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'explore',
    title: 'Explore',
    aiWrapped: true,
    annotations: { title: 'Explore', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Internal codebase/file/structure search — try this first when location uncertain; never grep/read/bash/find_symbol blind. Local filesystem only — not web, not memory. `query`: single rich NL query (default — one internal agent judges glob+grep fan-out & synthesizes) or array of strings (N independent agents, mechanical merge, no cross-synthesis — only for genuinely unrelated asks). Omit `cwd` for the current workspace; set `cwd` only when the user explicitly names that root/path. Lead: async (merged answer auto-pushed via channel). Role sessions: sync in-turn. Use `background:true/false` to override. Past context → `recall`, external web → `search`.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 }], description: 'Single NL string, or array of strings for unrelated multi-question.' },
        cwd: { type: 'string', description: 'Optional search root. Omit for current workspace; pass only when the user names a path.' },
        background: { type: 'boolean', description: 'Default false (sync). Set true for heavy queries to dispatch async and receive answer via channel.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_memories',
    title: 'Search Memories',
    public: false,
    annotations: { title: 'Search Memories', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Search past context and memory. Returns root entries by default. Use when user references prior work, decisions, or preferences. Storage is automatic — only retrieval is manual.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text. Triggers hybrid search (vec_entries KNN + entries_fts BM25).' },
        period: { type: 'string', description: 'Time scope: "last" (before this session), "24h"/"3d"/"7d"/"30d" (relative), "all", "2026-04-05" (single day), "2026-04-01~2026-04-05" (range). Default: 30d when query set, latest entries otherwise.' },
        sort: { type: 'string', enum: ['date', 'importance'], description: 'date (newest first) or importance (score desc).' },
        limit: { type: 'number', default: 30 },
        offset: { type: 'number', default: 0 },
        includeMembers: { type: 'boolean', description: 'Include chunk member entries inline.' },
      },
      required: [],
    },
  },
]

async function handleToolCall(name, args) {
  try {
    if (name === 'search_memories') {
      const result = await handleSearch(args || {})
      return { content: [{ type: 'text', text: result.text }], isError: result.isError || false }
    }
    if (name === 'memory') {
      const result = await handleMemoryAction(args || {})
      return { content: [{ type: 'text', text: result.text }], isError: result.isError || false }
    }
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `${name} failed: ${msg}` }], isError: true }
  }
}

const mcp = new Server(
  { name: 'mixdog-memory', version: PLUGIN_VERSION },
  { capabilities: { tools: {} }, instructions: MEMORY_INSTRUCTIONS_TEXT },
)
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))
mcp.setRequestHandler(CallToolRequestSchema, (req) => handleToolCall(req.params.name, req.params.arguments ?? {}))

function createHttpMcpServer() {
  const s = new Server(
    { name: 'mixdog-memory', version: PLUGIN_VERSION },
    { capabilities: { tools: {} }, instructions: MEMORY_INSTRUCTIONS_TEXT },
  )
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))
  s.setRequestHandler(CallToolRequestSchema, (req) => handleToolCall(req.params.name, req.params.arguments ?? {}))
  return s
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) { resolve({}); return }
      try { resolve(JSON.parse(raw)) }
      catch (error) {
        const e = new Error(`invalid JSON body: ${error.message}`)
        e.statusCode = 400
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendError(res, msg, status = 500) {
  sendJson(res, { error: msg }, status)
}

const httpServer = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/session-reset') {
    _bootTimestamp = Date.now()
    sendJson(res, { ok: true, bootTimestamp: _bootTimestamp })
    return
  }
  if (req.method === 'POST' && req.url === '/rebind') {
    _bootTimestamp = Date.now()
    sendJson(res, { ok: true })
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    try {
      const stats = entryStats()
      sendJson(res, {
        status: 'ok',
        bootstrap: isBootstrapComplete(db),
        entries: stats.total,
        roots: stats.roots,
        unclassified: stats.unclassified,
      })
    } catch (e) { sendError(res, e.message) }
    return
  }

  if (req.method === 'POST' && req.url === '/api/tool') {
    try {
      const body = await readBody(req)
      const result = await handleToolCall(body.name, body.arguments ?? {})
      sendJson(res, result)
    } catch (e) {
      sendJson(res, { content: [{ type: 'text', text: `api/tool error: ${e.message}` }], isError: true }, Number(e?.statusCode) || 500)
    }
    return
  }

  if (req.url === '/mcp') {
    try {
      if (req.method === 'POST') {
        const httpMcp = createHttpMcpServer()
        const httpTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        })
        res.on('close', () => {
          httpTransport.close()
          void httpMcp.close()
        })
        await httpMcp.connect(httpTransport)
        const body = await readBody(req)
        await httpTransport.handleRequest(req, res, body)
      } else {
        sendJson(res, { error: 'Method not allowed' }, 405)
      }
    } catch (e) {
      process.stderr.write(`[memory-service] /mcp error: ${e.stack || e.message}\n`)
      if (!res.headersSent) sendError(res, e.message, Number(e?.statusCode) || 500)
    }
    return
  }

  if (req.method !== 'POST') {
    sendJson(res, { error: 'Method not allowed' }, 405)
    return
  }

  let body
  try { body = await readBody(req) }
  catch (e) { sendError(res, e.message, Number(e?.statusCode) || 500); return }

  try {
    if (req.url === '/entry') {
      const role = String(body.role ?? 'user')
      const content = String(body.content ?? '')
      const sourceRef = String(body.sourceRef ?? `manual:${Date.now()}-${process.pid}`)
      const sessionId = body.sessionId ?? null
      const tsMs = parseTsToMs(body.ts ?? Date.now())
      if (!content) { sendJson(res, { error: 'content required' }, 400); return }
      // Run the same scrubber used by ingestTranscriptFile so noise markers
      // like "[Request interrupted by user]" and whitespace-only payloads
      // are rejected before they reach the entries table. Match the
      // existing 400 / { error } convention for invalid payloads.
      const cleaned = cleanMemoryText(content)
      if (!cleaned || !cleaned.trim()) {
        sendJson(res, { error: 'empty after clean' }, 400)
        return
      }
      try {
        const result = db.prepare(`
          INSERT OR IGNORE INTO entries(ts, role, content, source_ref, session_id)
          VALUES (?, ?, ?, ?, ?)
        `).run(tsMs, role, cleaned, sourceRef, sessionId)
        sendJson(res, { ok: true, id: Number(result.lastInsertRowid), changes: Number(result.changes) })
      } catch (e) {
        sendJson(res, { error: e.message }, 500)
      }
      return
    }

    if (req.url === '/ingest-transcript') {
      const filePath = body.filePath
      if (!filePath) { sendJson(res, { error: 'filePath required' }, 400); return }
      try {
        const n = ingestTranscriptFile(filePath)
        sendJson(res, { ok: true, ingested: n })
      } catch (e) {
        sendJson(res, { error: e.message }, 500)
      }
      return
    }

    sendJson(res, { error: 'Not found' }, 404)
  } catch (e) {
    process.stderr.write(`[memory-service] ${req.url} error: ${e.stack || e.message}\n`)
    sendError(res, e.message)
  }
})

export { TOOL_DEFS, handleToolCall }
export { MEMORY_INSTRUCTIONS_TEXT as instructions }

export async function init() {
  if (_initialized) return
  process.stderr.write(`[boot-time] tag=memory-init-start tMs=${Date.now()}\n`)
  await _initRuntime()
  await _startHttpServer()
  if (process.env.MIXDOG_WORKER_MODE === '1' && process.send) {
    process.stderr.write(`[boot-time] tag=memory-ready tMs=${Date.now()}\n`)
    process.send({ type: 'ready' })
  }
  process.stderr.write(`[memory-service] init() complete (entries unified mode, version=${PLUGIN_VERSION})\n`)
}

export async function start() { _startCycles() }

export async function stop() {
  _stopCycles()
  void stopLlmWorker().catch(() => {})
  if (httpServer) await new Promise(resolve => httpServer.close(resolve))
  closeDatabase(DATA_DIR)
  releaseLock()
  removePortFile()
}

function writePortFile(port) {
  try { fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true }) } catch {}
  fs.writeFileSync(PORT_FILE, String(port))
}

function removePortFile() {
  try { fs.unlinkSync(PORT_FILE) } catch {}
}

let activePort = BASE_PORT

function _startHttpServer() {
  return new Promise((resolve, reject) => {
    function tryListen() {
      httpServer.listen(activePort, '127.0.0.1', () => {
        writePortFile(activePort)
        process.stderr.write(`[memory-service] HTTP listening on 127.0.0.1:${activePort}\n`)
        resolve(activePort)
      })
    }
    httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && activePort < MAX_PORT) {
        activePort++
        tryListen()
      } else if (err.code === 'EADDRINUSE') {
        activePort = 0
        tryListen()
      } else {
        process.stderr.write(`[memory-service] HTTP fatal: ${err.message}\n`)
        reject(err)
      }
    })
    tryListen()
  })
}

if (process.env.MIXDOG_WORKER_MODE === '1' && process.send) {
  process.on('message', async (msg) => {
    if (msg.type !== 'call' || !msg.callId) return
    try {
      const result = await handleToolCall(msg.name, msg.args || {})
      process.send({ type: 'result', callId: msg.callId, result })
    } catch (e) {
      process.send({ type: 'result', callId: msg.callId, error: e.message })
    }
  })
  init().catch(e => {
    process.stderr.write(`[memory-worker] init failed: ${e.message}\n`)
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  ;(async () => {
    const existing = await isExistingServerHealthy()
    if (existing) {
      await runProxyMode(existing)
      process.exit(0)
    }
    acquireLock()
    process.on('exit', releaseLock)
    process.on('SIGINT', () => { stop().finally(() => process.exit(0)) })
    process.on('SIGTERM', () => { stop().finally(() => process.exit(0)) })
    await init()
    const transport = new StdioServerTransport()
    await mcp.connect(transport)
    await new Promise((resolve) => { mcp.onclose = resolve })
    await stop()
  })().catch((err) => {
    process.stderr.write(`[memory-service] startup failed: ${err.stack || err.message}\n`)
    process.exit(1)
  })
}
