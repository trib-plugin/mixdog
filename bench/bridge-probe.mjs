#!/usr/bin/env node
// bench/bridge-probe.mjs — bridge dispatch probe.
//
// Two modes:
//
//   1) single  (Phase 1, preserved)
//      node bench/bridge-probe.mjs <role> "<prompt>"
//      Calls bridge once with role+prompt, waits for the worker, prints metrics.
//
//   2) sweep   (Phase 2a)
//      node bench/bridge-probe.mjs --sweep [--tasks=path] [--repeats=N] [--out=path] [--read-only]
//      Iterates a fixture (default bench/bridge-tasks.json) and runs each task
//      `--repeats` times sequentially (default 2). Tasks marked
//      `writeCapable: true` in the fixture are skipped — Phase 2a does not
//      provide a sandbox. Each task run is bounded by a 180s timeout; on
//      timeout the run records an `error` and the sweep moves on. Results
//      land in bench/results/bridge-sweep-<ISO>.json.
//
//      SIGINT during sweep flushes the partial result file and exits cleanly.

import {
  existsSync,
  createReadStream,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
} from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createInterface } from 'node:readline'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
// Use an isolated PLUGIN_DATA so the probe's mcp child does NOT collide with
// any live `mixdog` server (singleton lock in server.mjs is keyed on
// PLUGIN_DATA/server.lock). Set BRIDGE_PROBE_DATA=/path/to/dir to share an
// existing data dir (then this script must be run with no other server up).
const DEFAULT_DATA = join(homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin')
const PLUGIN_DATA = process.env.BRIDGE_PROBE_DATA ||
  join(tmpdir(), `bridge-probe-data-${process.pid}`)
const TRACE_PATH = join(PLUGIN_DATA, 'history', 'bridge-trace.jsonl')
const RESULTS_DIR = join(PLUGIN_ROOT, 'bench', 'results')

mkdirSync(PLUGIN_DATA, { recursive: true })
// Seed the isolated PLUGIN_DATA with workflow + auth from the live data dir
// so role lookup ("worker" → preset) and provider creds work. Best-effort.
for (const fname of ['user-workflow.json', 'agent-config.json', 'config.json',
                     'memory-config.json', 'search-config.json', 'auth.json',
                     'auth-anthropic.json', 'auth-openai.json']) {
  try {
    const src = join(DEFAULT_DATA, fname)
    if (existsSync(src) && !existsSync(join(PLUGIN_DATA, fname))) {
      cpSync(src, join(PLUGIN_DATA, fname))
    }
  } catch { /* ignore — server seeds defaults if missing */ }
}
process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT
process.env.CLAUDE_PLUGIN_DATA = PLUGIN_DATA

const importLocal = (rel) => import(pathToFileURL(join(PLUGIN_ROOT, rel)).href)
const mcp = await importLocal('src/agent/orchestrator/mcp/client.mjs')
const { connectMcpServers, executeMcpTool, disconnectAll } = mcp

const PLUGIN_VERSION = readPluginVersion()
const TASK_TIMEOUT_MS = 180_000

const argv = process.argv.slice(2)
const isSweep = argv.includes('--sweep')

if (isSweep) {
  await runSweep(parseSweepArgs(argv))
} else {
  await runSingle(argv)
}

// ────────────────────────────────────────────────────────────
// single-task mode (Phase 1)
// ────────────────────────────────────────────────────────────
async function runSingle(args) {
  await connectBridge()

  const role = args[0] || 'worker'
  const prompt = args[1] ||
    'List the .mjs files under src/agent/orchestrator and briefly describe each.'

  console.log(`[bridge-probe] role=${role}`)
  console.log(`[bridge-probe] prompt="${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`)
  const t0 = Date.now()

  const result = await dispatchOne({ role, prompt, t0, log: true })

  const dt = Date.now() - t0
  console.log(`\n══ metrics ══`)
  console.log(`  duration : ${dt}ms`)
  console.log(`  session  : ${result.sessionId || '?'}`)
  console.log(JSON.stringify(result.metrics, null, 2))

  await disconnectAll()
  process.exit(0)
}

// ────────────────────────────────────────────────────────────
// sweep mode (Phase 2)
// ────────────────────────────────────────────────────────────
function parseSweepArgs(args) {
  const out = { tasks: null, repeats: 2, out: null, readOnly: false }
  for (const a of args) {
    if (a === '--sweep') continue
    if (a === '--read-only') { out.readOnly = true; continue }
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (!m) continue
    const k = m[1]
    const v = m[2]
    if (k === 'tasks') out.tasks = v
    else if (k === 'repeats') out.repeats = Math.max(1, parseInt(v, 10) || 1)
    else if (k === 'out') out.out = v
    else if (k === 'read-only') out.readOnly = true
  }
  if (!out.tasks) out.tasks = join(PLUGIN_ROOT, 'bench', 'bridge-tasks.json')
  if (!out.out) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    out.out = join(RESULTS_DIR, `bridge-sweep-${stamp}.json`)
  }
  return out
}

function isWriteCapable(task) {
  return task.writeCapable === true
}

async function runSweep(opts) {
  console.log(`[bridge-probe] sweep mode (Phase 2a)`)
  console.log(`[bridge-probe]   tasksPath = ${opts.tasks}`)
  console.log(`[bridge-probe]   repeats   = ${opts.repeats}`)
  console.log(`[bridge-probe]   readOnly  = ${opts.readOnly}`)
  console.log(`[bridge-probe]   out       = ${opts.out}`)

  if (!existsSync(opts.tasks)) {
    console.error(`[bridge-probe] tasks fixture not found: ${opts.tasks}`)
    process.exit(2)
  }
  mkdirSync(RESULTS_DIR, { recursive: true })

  const fixture = JSON.parse(readFileSync(opts.tasks, 'utf-8'))
  const tasks = Array.isArray(fixture) ? fixture : (fixture.tasks || [])
  if (!tasks.length) {
    console.error(`[bridge-probe] tasks fixture has 0 tasks`)
    process.exit(2)
  }

  await connectBridge()

  const taskResults = []
  let interrupted = false
  const onSigint = () => {
    if (interrupted) return
    interrupted = true
    console.log(`\n[bridge-probe] SIGINT — flushing partial results to ${opts.out}`)
  }
  process.on('SIGINT', onSigint)

  const startedAt = new Date().toISOString()

  outer:
  for (const task of tasks) {
    if (interrupted) break
    const writeCap = isWriteCapable(task)
    const taskRow = {
      id: task.id,
      role: task.role,
      writeCapable: writeCap,
      skipped: false,
      runs: [],
      summary: null,
    }

    if (writeCap) {
      console.log(`\n── task ${task.id} (role=${task.role}) — writeCapable, skipping (no sandbox in Phase 2a) ──`)
      taskRow.skipped = true
      taskRow.reason = 'writeCapable task skipped — sandbox not provided in Phase 2a'
      taskResults.push(taskRow)
      continue
    }

    console.log(`\n── task ${task.id} (role=${task.role}) ──`)

    for (let i = 1; i <= opts.repeats; i++) {
      if (interrupted) break outer

      console.log(`  run ${i}/${opts.repeats}`)
      const t0 = Date.now()
      let runRow
      try {
        const result = await runWithTimeout(
          dispatchOne({
            role: task.role,
            prompt: task.prompt,
            cwd: PLUGIN_ROOT,
            t0,
            log: false,
          }),
          TASK_TIMEOUT_MS,
          `task ${task.id} run ${i} exceeded ${TASK_TIMEOUT_MS}ms`,
        )
        const durationMs = Date.now() - t0
        runRow = {
          taskId: task.id,
          run: i,
          role: task.role,
          durationMs,
          sessionId: result.sessionId || null,
          jobId: result.jobId || null,
          ...result.metrics,
        }
      } catch (e) {
        runRow = {
          taskId: task.id,
          run: i,
          role: task.role,
          durationMs: Date.now() - t0,
          error: e.message,
        }
      }

      const summary = oneLineRun(runRow)
      console.log(`    → ${summary}`)
      taskRow.runs.push(runRow)
    }

    taskRow.summary = summarizeRuns(taskRow.runs)
    taskResults.push(taskRow)
  }

  process.off('SIGINT', onSigint)

  const overall = aggregateRuns(taskResults.flatMap(t => t.runs.filter(r => !r.error)))
  const byRole = aggregateByRole(taskResults)

  const skippedCount = taskResults.filter(t => t.skipped).length
  const outDoc = {
    version: PLUGIN_VERSION,
    mode: 'sweep-phase2a',
    interrupted,
    config: {
      tasksPath: opts.tasks,
      repeats: opts.repeats,
      readOnly: opts.readOnly,
      ranAt: startedAt,
      finishedAt: new Date().toISOString(),
    },
    tasks: taskResults,
    byRole,
    overall,
  }

  writeFileSync(opts.out, JSON.stringify(outDoc, null, 2))
  console.log(`\n[bridge-probe] wrote ${opts.out}`)
  console.log(`[bridge-probe] tasks=${taskResults.length} (skipped=${skippedCount})`)
  console.log(`[bridge-probe] overall durationMs p50=${overall.durationMs?.p50 ?? '?'} p95=${overall.durationMs?.p95 ?? '?'} mean=${overall.durationMs?.mean ?? '?'} n=${overall.durationMs?.n ?? 0}`)
  console.log(`[bridge-probe] overall iters       p50=${overall.iters?.p50 ?? '?'} p95=${overall.iters?.p95 ?? '?'} mean=${overall.iters?.mean ?? '?'}`)
  for (const [role, stats] of Object.entries(byRole)) {
    console.log(`[bridge-probe]   role=${role.padEnd(9)} n=${stats.durationMs.n}  dt p50=${stats.durationMs.p50}  iters p50=${stats.iters.p50}`)
  }

  await disconnectAll()
  process.exit(interrupted ? 130 : 0)
}

function runWithTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise.finally(() => { if (timer) clearTimeout(timer) }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)
    }),
  ])
}

function oneLineRun(r) {
  if (r.error) return `ERROR ${r.error}`
  return `dt=${r.durationMs}ms  iters=${r.iters ?? '?'}  tools=${r.toolCalls ?? '?'}  struct%=${r.structurePct ?? '?'}  sess=${(r.sessionId || '').slice(0, 14)}`
}


// ────────────────────────────────────────────────────────────
// dispatch + analysis (shared)
// ────────────────────────────────────────────────────────────
async function dispatchOne({ role, prompt, cwd, t0, log }) {
  const args = { role, prompt }
  if (cwd) args.cwd = cwd

  let dispatchOut
  try {
    dispatchOut = await executeMcpTool('mcp__mixdog__bridge', args)
  } catch (e) {
    throw new Error(`bridge dispatch failed: ${e.message}`)
  }
  const dispatchText = extractText(dispatchOut)
  if (log) {
    console.log(`\n[bridge-probe] dispatch response (${Date.now() - t0}ms):`)
    console.log(dispatchText.slice(0, 600))
  }

  const sessionId = extractField(dispatchText, /"sessionId"\s*:\s*"(sess_[\w-]+)"/) ||
                    extractField(dispatchText, /(sess_[\w-]+)/)
  const jobId = extractField(dispatchText, /"jobId"\s*:\s*"((?:job|bridge)_[\w-]+)"/) ||
                extractField(dispatchText, /\b((?:job|bridge)_[\w-]+)\b/)
  if (log) console.log(`\n[bridge-probe] sessionId=${sessionId || '?'} jobId=${jobId || '?'}`)
  if (!sessionId && !log) {
    // Surface the dispatch response so sweep failures aren't a black box.
    console.error(`    dispatch text: ${dispatchText.slice(0, 400).replace(/\n/g, ' ')}`)
  }
  if (process.env.BRIDGE_PROBE_DEBUG) {
    console.error(`    [debug] sess=${sessionId} job=${jobId} text="${dispatchText.slice(0, 240).replace(/\n/g, ' ')}"`)
  }

  if (sessionId) {
    if (log) console.log(`[bridge-probe] waiting for bridge session to finish (max 180s)...`)
    try {
      await waitForSessionDone(sessionId, 180000, log)
    } catch (e) {
      if (log) console.error(`[bridge-probe] waitForSessionDone failed: ${e.message}`)
    }
  }

  const metrics = sessionId ? await analyzeSession(sessionId) : { error: 'no sessionId extracted' }
  return { sessionId, jobId, metrics }
}

async function waitForSessionDone(sessionId, timeoutMs, log) {
  const deadline = Date.now() + timeoutMs
  const intervalMs = 1500
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs))
    let listed
    try { listed = await executeMcpTool('mcp__mixdog__list_sessions', {}) }
    catch (e) { if (log) console.error(`list_sessions failed: ${e.message}`); continue }
    const text = extractText(listed)
    // Find the row for our sessionId; stage may appear as "stage": "done" / "running" / "error"
    // The JSON shape is: array of objects with id + runtime.stage.
    let rowStage = null
    try {
      const parsed = JSON.parse(text)
      const arr = Array.isArray(parsed) ? parsed : (parsed.sessions || parsed.items || [])
      const row = arr.find(s => s && (s.id === sessionId || s.sessionId === sessionId))
      if (row) {
        rowStage = (row.runtime && row.runtime.stage) || row.stage || null
      } else {
        // Session may have been reaped already → treat as done.
        return
      }
    } catch {
      // Fallback: regex over raw text.
      const m = new RegExp(`${sessionId}[^}]*?"stage"\\s*:\\s*"([^"]+)"`, 's').exec(text)
      rowStage = m ? m[1] : null
    }
    if (rowStage === 'done' || rowStage === 'error' || rowStage === 'idle') return
  }
  if (log) console.warn('waitForSessionDone: timed out')
}

async function connectBridge() {
  await connectMcpServers({
    mixdog: {
      command: 'node',
      args: [join(PLUGIN_ROOT, 'scripts', 'run-mcp.mjs')],
      cwd: PLUGIN_ROOT,
    },
  })
}

function extractText(out) {
  if (!out) return ''
  if (typeof out === 'string') return out
  const arr = out.content
  if (!Array.isArray(arr)) return JSON.stringify(out)
  return arr.filter(p => p && p.type === 'text').map(p => p.text).join('\n')
}

function extractField(s, re) {
  const m = re.exec(s || '')
  return m ? (m[1] || m[0]) : null
}

async function analyzeSession(sessionId) {
  if (!existsSync(TRACE_PATH)) {
    if (process.env.BRIDGE_PROBE_DEBUG) console.error(`    [debug] no trace at ${TRACE_PATH}`)
    return { error: `no trace file at ${TRACE_PATH}` }
  }
  if (process.env.BRIDGE_PROBE_DEBUG) console.error(`    [debug] scanning ${TRACE_PATH} for ${sessionId}`)
  const tools = []
  let iters = 0, traceRole = null, tokensIn = 0, tokensOut = 0, lines = 0
  const stream = createReadStream(TRACE_PATH, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row.sessionId !== sessionId) continue
    lines++
    if (!traceRole && row.role) traceRole = row.role
    if (row.kind === 'iter') iters++
    if (row.kind === 'tool' && row.tool) tools.push(row.tool)
    if (row.tokensIn) tokensIn += row.tokensIn
    if (row.tokensOut) tokensOut += row.tokensOut
  }
  let alt = 0, last = null
  for (const t of tools) {
    if ((t === 'read' || t === 'grep') && last && last !== t && (last === 'read' || last === 'grep')) alt++
    last = t
  }
  const histogram = tools.reduce((m, t) => (m[t] = (m[t] || 0) + 1, m), {})
  const total = tools.length
  const structure = tools.filter(t => /^(find_symbol|find_imports|find_dependents|find_callers|find_references|code_graph)$/.test(t)).length
  const fileLookup = tools.filter(t => /^(read|grep|glob|list)$/.test(t)).length
  return {
    role: traceRole,
    iters,
    tokensIn,
    tokensOut,
    toolCalls: total,
    structurePct: total ? +(structure / total * 100).toFixed(1) : 0,
    fileLookupPct: total ? +(fileLookup / total * 100).toFixed(1) : 0,
    altCount: alt,
    histogram,
    traceLines: lines,
  }
}

// ────────────────────────────────────────────────────────────
// stats helpers
// ────────────────────────────────────────────────────────────
function pct(sortedAsc, q) {
  if (!sortedAsc.length) return null
  const idx = Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length))
  return sortedAsc[idx]
}

function statBlock(values) {
  const arr = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (!arr.length) return { n: 0, p50: null, p95: null, mean: null, min: null, max: null }
  const sum = arr.reduce((a, b) => a + b, 0)
  return {
    n: arr.length,
    p50: pct(arr, 0.5),
    p95: pct(arr, 0.95),
    mean: +(sum / arr.length).toFixed(1),
    min: arr[0],
    max: arr[arr.length - 1],
  }
}

function aggregateRuns(runs) {
  return {
    durationMs: statBlock(runs.map(r => r.durationMs)),
    iters: statBlock(runs.map(r => r.iters)),
    toolCalls: statBlock(runs.map(r => r.toolCalls)),
    tokensIn: statBlock(runs.map(r => r.tokensIn)),
    tokensOut: statBlock(runs.map(r => r.tokensOut)),
    structurePct: statBlock(runs.map(r => r.structurePct)),
    fileLookupPct: statBlock(runs.map(r => r.fileLookupPct)),
    altCount: statBlock(runs.map(r => r.altCount)),
  }
}

function summarizeRuns(runs) {
  const ok = runs.filter(r => !r.error)
  return {
    runs: runs.length,
    errored: runs.length - ok.length,
    ...aggregateRuns(ok),
  }
}

function aggregateByRole(taskRows) {
  const buckets = new Map()
  for (const t of taskRows) {
    if (t.skipped) continue
    const role = t.role || 'unknown'
    if (!buckets.has(role)) buckets.set(role, [])
    for (const r of t.runs) {
      if (!r.error) buckets.get(role).push(r)
    }
  }
  const out = {}
  for (const [role, runs] of buckets) out[role] = aggregateRuns(runs)
  return out
}

function readPluginVersion() {
  try {
    const j = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf-8'))
    return j.version || 'unknown'
  } catch { return 'unknown' }
}
