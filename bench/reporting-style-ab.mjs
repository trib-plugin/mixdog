#!/usr/bin/env bun
// bench/reporting-style-ab.mjs — A/B benchmark for the
// "Reporting style — final reply to Lead" section in
// rules/bridge/00-common.md (added at 0.1.118).
//
// Hypothesis: with the section ON (variant B = current rules), worker final
// replies are shorter and more structured (path:line bullets, one-line
// verification, no tables / no spec restatement / no fence dumps) than with
// it suspended (variant A = verbose override injected via context).
//
// Mechanics — uses approach (b) from the spec: instead of swapping rules
// directories, we inject a system-style override paragraph into the
// `context` field of the bridge tool call for variant A. Variant B sends no
// override, so the live rules apply.
//
// Reuses the dispatch + analyzeSession plumbing pattern from
// bench/bridge-probe.mjs and the fixture loading pattern from
// bench/cycle-probe.mjs. Result file lands next to other sweeps under
// bench/results/reporting-style-ab-<ISO>.json.
//
// IMPORTANT: this script does not run any worker calls by default. Call it
// explicitly:
//   node bench/reporting-style-ab.mjs              # 3 runs per variant
//   node bench/reporting-style-ab.mjs --repeats=5  # custom repeat count
//   node bench/reporting-style-ab.mjs --task=<id>  # alternate fixture row
//
// The final reply text used for length / verbose-marker counting is
// resolved from bridge-trace.jsonl by scanning kind="sse" rows for the
// session's last assistant payload. If that fails, the script falls back
// to whatever text the dispatch tool returned synchronously (rare for
// detached bridge calls, but kept for resilience).

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
const DEFAULT_DATA = join(homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin')
const PLUGIN_DATA = process.env.REPORTING_AB_DATA ||
  join(tmpdir(), `reporting-ab-data-${process.pid}`)
const TRACE_PATH = join(PLUGIN_DATA, 'history', 'bridge-trace.jsonl')
const RESULTS_DIR = join(PLUGIN_ROOT, 'bench', 'results')

mkdirSync(PLUGIN_DATA, { recursive: true })
for (const fname of ['user-workflow.json', 'agent-config.json', 'config.json',
                     'memory-config.json', 'search-config.json', 'auth.json',
                     'auth-anthropic.json', 'auth-openai.json']) {
  try {
    const src = join(DEFAULT_DATA, fname)
    if (existsSync(src) && !existsSync(join(PLUGIN_DATA, fname))) {
      cpSync(src, join(PLUGIN_DATA, fname))
    }
  } catch { /* server seeds defaults */ }
}
process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT
process.env.CLAUDE_PLUGIN_DATA = PLUGIN_DATA

const importLocal = (rel) => import(pathToFileURL(join(PLUGIN_ROOT, rel)).href)
const mcp = await importLocal('src/agent/orchestrator/mcp/client.mjs')
const { connectMcpServers, executeMcpTool, disconnectAll } = mcp

const PLUGIN_VERSION = readPluginVersion()
const TASK_TIMEOUT_MS = 240_000

// ── args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const opts = parseArgs(argv)

function parseArgs(args) {
  const out = { repeats: 3, task: 'worker-reporting-style-ab', tasks: null, out: null }
  for (const a of args) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (!m) continue
    const k = m[1]; const v = m[2]
    if (k === 'repeats') out.repeats = Math.max(1, parseInt(v, 10) || 1)
    else if (k === 'task') out.task = v
    else if (k === 'tasks') out.tasks = v
    else if (k === 'out') out.out = v
  }
  if (!out.tasks) out.tasks = join(PLUGIN_ROOT, 'bench', 'bridge-tasks.json')
  if (!out.out) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    out.out = join(RESULTS_DIR, `reporting-style-ab-${stamp}.json`)
  }
  return out
}

// ── fixture ─────────────────────────────────────────────────────────
const fixtureDoc = JSON.parse(readFileSync(opts.tasks, 'utf-8'))
const tasks = Array.isArray(fixtureDoc) ? fixtureDoc : (fixtureDoc.tasks || [])
const task = tasks.find(t => t.id === opts.task)
if (!task) die(`task not found in fixture: ${opts.task}`)
if (!task.ab_variants || typeof task.ab_variants !== 'object') {
  die(`task ${opts.task} has no ab_variants object — A/B run impossible`)
}
const variantNames = Object.keys(task.ab_variants)
if (variantNames.length < 2) die(`task ${opts.task} needs >=2 ab_variants, got ${variantNames.length}`)

// ── verbose marker patterns ────────────────────────────────────────
// Each regex catches one explicit shape that the new "Reporting style"
// section bans. Hits across all patterns are summed per reply.
const VERBOSE_MARKER_PATTERNS = [
  { name: 'codeFence',       re: /```/g },
  { name: 'tablePipe',       re: /^\s*\|.+\|\s*$/gm },
  { name: 'tableSeparator',  re: /^\s*\|?[\s:]*-{3,}[\s:|-]*\|?\s*$/gm },
  { name: 'verifyHeader',    re: /^\s*#{1,6}\s*Verification\b/gim },
  { name: 'changesHeader',   re: /^\s*#{1,6}\s*Changes\b/gim },
  { name: 'notesHeader',     re: /^\s*#{1,6}\s*Notes\b/gim },
  { name: 'specRestate',     re: /\b(as requested|per (the )?spec|the (task|user) (asks|asked|wants|wanted))/gi },
  { name: 'aboutToVerb',     re: /\b(I will|I'll|let me|let's)\s+(now\s+)?(do|run|check|verify|investigate|trace|read|grep|look)\b/gi },
  { name: 'didNotDo',        re: /\b(not (performed|executed|run|done)|did not (push|commit|run))/gi },
  { name: 'nestedBullet',    re: /^\s{4,}[-*]\s+/gm },
  { name: 'totalCount',      re: /\b(total|applied|matched)\s+\d+\s+(places|files|matches|occurrences)/gi },
]

// ── main ────────────────────────────────────────────────────────────
console.log(`[reporting-ab] task     = ${opts.task}`)
console.log(`[reporting-ab]   role   = ${task.role}`)
console.log(`[reporting-ab]   variants = ${variantNames.join(' | ')}`)
console.log(`[reporting-ab]   repeats  = ${opts.repeats}`)
console.log(`[reporting-ab]   out      = ${opts.out}`)

await connectBridge()

mkdirSync(RESULTS_DIR, { recursive: true })

const startedAt = new Date().toISOString()
const allRuns = []
const runsByVariant = Object.fromEntries(variantNames.map(v => [v, []]))

let interrupted = false
process.on('SIGINT', () => {
  if (interrupted) return
  interrupted = true
  console.log(`\n[reporting-ab] SIGINT — flushing partial results`)
})

outer:
for (const variant of variantNames) {
  const overrideText = task.ab_variants[variant] || ''
  console.log(`\n── variant ${variant} ${overrideText ? '(override active)' : '(no override)'} ──`)
  for (let i = 1; i <= opts.repeats; i++) {
    if (interrupted) break outer
    console.log(`  run ${i}/${opts.repeats}`)
    const t0 = Date.now()
    let row
    try {
      const result = await runWithTimeout(
        dispatchOne({
          role: task.role,
          prompt: task.prompt,
          context: overrideText || null,
          cwd: PLUGIN_ROOT,
        }),
        TASK_TIMEOUT_MS,
        `${variant} run ${i} exceeded ${TASK_TIMEOUT_MS}ms`,
      )
      const reply = result.replyText || ''
      const styleMetrics = scoreReply(reply)
      row = {
        variant,
        run: i,
        durationMs: Date.now() - t0,
        sessionId: result.sessionId || null,
        jobId: result.jobId || null,
        ...result.metrics,
        ...styleMetrics,
      }
    } catch (e) {
      row = {
        variant,
        run: i,
        durationMs: Date.now() - t0,
        error: e.message,
      }
    }
    console.log(`    → ${oneLineRun(row)}`)
    allRuns.push(row)
    runsByVariant[variant].push(row)
  }
}

const summary = {}
for (const v of variantNames) {
  summary[v] = aggregateRuns(runsByVariant[v].filter(r => !r.error))
}

const outDoc = {
  version: PLUGIN_VERSION,
  mode: 'reporting-style-ab',
  taskId: opts.task,
  role: task.role,
  variants: variantNames,
  config: {
    repeats: opts.repeats,
    tasksPath: opts.tasks,
    ranAt: startedAt,
    finishedAt: new Date().toISOString(),
    interrupted,
  },
  runs: allRuns,
  summary,
}

writeFileSync(opts.out, JSON.stringify(outDoc, null, 2))
console.log(`\n[reporting-ab] wrote ${opts.out}`)
printComparisonTable(summary)

await disconnectAll()
process.exit(interrupted ? 130 : 0)

// ── dispatch ───────────────────────────────────────────────────────
async function dispatchOne({ role, prompt, context, cwd }) {
  const args = { role, prompt }
  if (cwd) args.cwd = cwd
  if (context) args.context = context

  let dispatchOut
  try {
    dispatchOut = await executeMcpTool('mcp__mixdog__bridge', args)
  } catch (e) {
    throw new Error(`bridge dispatch failed: ${e.message}`)
  }
  const dispatchText = extractText(dispatchOut)
  const sessionId = extractField(dispatchText, /"sessionId"\s*:\s*"(sess_[\w-]+)"/) ||
                    extractField(dispatchText, /(sess_[\w-]+)/)
  const jobId = extractField(dispatchText, /"jobId"\s*:\s*"((?:job|bridge)_[\w-]+)"/) ||
                extractField(dispatchText, /\b((?:job|bridge)_[\w-]+)\b/)

  if (sessionId) {
    try { await waitForSessionDone(sessionId, TASK_TIMEOUT_MS) }
    catch { /* fall through to whatever we have */ }
  }

  const metrics = sessionId ? await analyzeSession(sessionId) : { error: 'no sessionId extracted' }
  const replyText = sessionId ? await loadFinalReply(sessionId) : dispatchText
  return { sessionId, jobId, metrics, replyText }
}

async function waitForSessionDone(sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const intervalMs = 1500
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs))
    let listed
    try { listed = await executeMcpTool('mcp__mixdog__list_sessions', {}) }
    catch { continue }
    const text = extractText(listed)
    let stage = null
    try {
      const parsed = JSON.parse(text)
      const arr = Array.isArray(parsed) ? parsed : (parsed.sessions || parsed.items || [])
      const row = arr.find(s => s && (s.id === sessionId || s.sessionId === sessionId))
      if (!row) return
      stage = (row.runtime && row.runtime.stage) || row.stage || null
    } catch {
      const m = new RegExp(`${sessionId}[^}]*?"stage"\\s*:\\s*"([^"]+)"`, 's').exec(text)
      stage = m ? m[1] : null
    }
    if (stage === 'done' || stage === 'error' || stage === 'idle') return
  }
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

// ── trace analysis ─────────────────────────────────────────────────
async function analyzeSession(sessionId) {
  if (!existsSync(TRACE_PATH)) return { error: `no trace at ${TRACE_PATH}` }
  const tools = []
  let iters = 0, tokensIn = 0, tokensOut = 0, lines = 0, traceRole = null
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
  return {
    role: traceRole,
    iters,
    tokensIn,
    tokensOut,
    toolCalls: tools.length,
    traceLines: lines,
  }
}

// Best-effort: scan trace for the last assistant payload tied to the
// session. The bridge trace records SSE deltas under kind="sse"; we also
// accept any row with a non-empty `text` / `content` field that looks like
// a final assistant message.
async function loadFinalReply(sessionId) {
  if (!existsSync(TRACE_PATH)) return ''
  let lastFinal = ''
  let buffered = ''
  const stream = createReadStream(TRACE_PATH, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row.sessionId !== sessionId) continue
    if (row.kind === 'sse') {
      const delta = typeof row.text === 'string' ? row.text
                  : typeof row.delta === 'string' ? row.delta
                  : ''
      if (delta) buffered += delta
      if (row.event === 'message_stop' || row.event === 'response.completed' || row.done) {
        if (buffered.trim()) lastFinal = buffered
        buffered = ''
      }
    } else if (typeof row.finalText === 'string' && row.finalText.trim()) {
      lastFinal = row.finalText
    } else if (row.kind === 'final' && typeof row.text === 'string') {
      lastFinal = row.text
    }
  }
  if (!lastFinal && buffered.trim()) lastFinal = buffered
  return lastFinal
}

// ── style scoring ─────────────────────────────────────────────────
function scoreReply(text) {
  const safe = typeof text === 'string' ? text : ''
  const chars = safe.length
  const lines = safe ? safe.split(/\r?\n/).length : 0
  const verboseHits = {}
  let verboseTotal = 0
  for (const { name, re } of VERBOSE_MARKER_PATTERNS) {
    re.lastIndex = 0
    const matches = safe.match(re)
    const n = matches ? matches.length : 0
    verboseHits[name] = n
    verboseTotal += n
  }
  return { replyChars: chars, replyLines: lines, verboseHits, verboseTotal }
}

// ── stats ─────────────────────────────────────────────────────────
function pct(arr, q) {
  if (!arr.length) return null
  const idx = Math.min(arr.length - 1, Math.floor(q * arr.length))
  return arr[idx]
}
function statBlock(values) {
  const arr = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (!arr.length) return { n: 0, p50: null, p95: null, mean: null, min: null, max: null }
  const sum = arr.reduce((a, b) => a + b, 0)
  return { n: arr.length, p50: pct(arr, 0.5), p95: pct(arr, 0.95), mean: +(sum / arr.length).toFixed(1), min: arr[0], max: arr[arr.length - 1] }
}
function aggregateRuns(runs) {
  return {
    runs: runs.length,
    durationMs: statBlock(runs.map(r => r.durationMs)),
    iters: statBlock(runs.map(r => r.iters)),
    toolCalls: statBlock(runs.map(r => r.toolCalls)),
    tokensOut: statBlock(runs.map(r => r.tokensOut)),
    replyChars: statBlock(runs.map(r => r.replyChars)),
    replyLines: statBlock(runs.map(r => r.replyLines)),
    verboseTotal: statBlock(runs.map(r => r.verboseTotal)),
  }
}

function printComparisonTable(summary) {
  const variants = Object.keys(summary)
  const rows = ['replyChars', 'replyLines', 'verboseTotal', 'tokensOut', 'iters', 'toolCalls', 'durationMs']
  const w = 14
  const head = ['metric'.padEnd(16), ...variants.map(v => v.padEnd(w))].join(' ')
  console.log(`\n══ A/B comparison (p50 / p95) ══`)
  console.log(head)
  console.log('-'.repeat(head.length))
  for (const k of rows) {
    const cells = variants.map(v => {
      const s = summary[v][k]
      if (!s || s.n === 0) return 'n=0'.padEnd(w)
      return `${s.p50}/${s.p95}`.padEnd(w)
    })
    console.log(k.padEnd(16) + ' ' + cells.join(' '))
  }
}

function oneLineRun(r) {
  if (r.error) return `ERROR ${r.error}`
  return `dt=${r.durationMs}ms iters=${r.iters ?? '?'} tools=${r.toolCalls ?? '?'} chars=${r.replyChars ?? '?'} lines=${r.replyLines ?? '?'} verbose=${r.verboseTotal ?? '?'}`
}

function runWithTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise.finally(() => { if (timer) clearTimeout(timer) }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms) }),
  ])
}

function extractText(out) {
  if (!out) return ''
  if (typeof out === 'string') return out
  const arr = out.content
  if (!Array.isArray(arr)) return JSON.stringify(out)
  return arr.filter(p => p && p.type === 'text').map(p => p.text).join('\n')
}
function extractField(s, re) { const m = re.exec(s || ''); return m ? (m[1] || m[0]) : null }
function readPluginVersion() {
  try { return JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf-8')).version || 'unknown' }
  catch { return 'unknown' }
}
function die(msg) { console.error(`[reporting-ab] ${msg}`); process.exit(2) }
