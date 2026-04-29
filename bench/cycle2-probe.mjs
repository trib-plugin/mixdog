#!/usr/bin/env bun
// bench/cycle2-probe.mjs — cycle2 promotion-quality benchmark.
//
// Loads each fixture in bench/cycle2-fixtures.json into a fresh temp sqlite
// DB as is_root=1 entries, runs runPromotePhase() in-process for the given
// phase, then checks each candidate's resulting action keyword (and for
// update/merge cases, presence of element/summary). Output: per-case row +
// overall PASS rate. Mirrors the cycle1-probe harness (in-process IPC stub
// for callBridgeLlm, bridge-trace.jsonl telemetry for tokens/iter).
//
// Usage:
//   bun bench/cycle2-probe.mjs                  # run all fixtures
//   bun bench/cycle2-probe.mjs <case-name>      # run one fixture

import { readFileSync, mkdtempSync, rmSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const PLUGIN_DATA = join(homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin')

process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT
process.env.CLAUDE_PLUGIN_DATA = PLUGIN_DATA
const BRIDGE_TRACE_PATH = join(PLUGIN_DATA, 'history', 'bridge-trace.jsonl')

const VERBOSE = process.env.CYCLE2_PROBE_VERBOSE === '1'
const KEEP_TMP = process.env.CYCLE2_PROBE_KEEP_TMP === '1'
const RAW_DUMP = process.env.CYCLE2_RAW_DUMP === '1'

const argFilter = process.argv[2] || null

const FIXTURE_PATH = join(HERE, 'cycle2-fixtures.json')
const fixtures = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
const BASE_TS = Number(fixtures.base_ts) || Date.now()
const ACTIVE_COUNT = Number(fixtures.active_count ?? 12)
const ACTIVE_CAP = Number(fixtures.active_cap ?? 50)
const ALL_CASES = fixtures.cases || []
const CASES = argFilter ? ALL_CASES.filter(c => c.name === argFilter) : ALL_CASES
if (CASES.length === 0) die(`no fixture matched "${argFilter}"`)

const importLocal = (rel) => import(pathToFileURL(join(PLUGIN_ROOT, rel)).href)

const agentMod = await importLocal('src/agent/index.mjs')
  .catch(e => die(`import agent/index.mjs failed: ${e.message}`))
try {
  if (typeof agentMod.init === 'function') {
    await agentMod.init({ notification: () => {}, elicitInput: async () => ({}) })
  }
} catch (e) {
  die(`agent.init() failed: ${e.message}`)
}

const bridgeLlmMod = await importLocal('src/agent/orchestrator/smart-bridge/bridge-llm.mjs')
  .catch(e => die(`import bridge-llm.mjs failed: ${e.message}`))
const { makeBridgeLlm } = bridgeLlmMod

installInProcessBridge()

const memoryMod = await importLocal('src/memory/lib/memory.mjs')
  .catch(e => die(`import memory.mjs failed: ${e.message}`))
const { openDatabase } = memoryMod

const cycleMod = await importLocal('src/memory/lib/memory-cycle.mjs')
  .catch(e => die(`import memory-cycle.mjs failed: ${e.message}`))
const { runPromotePhase } = cycleMod

const EMBED_DIMS = 1024
const tmpRoot = mkdtempSync(join(tmpdir(), 'cycle2-probe-'))
console.error(`[cycle2-probe] tmp root = ${tmpRoot}`)

const summary = []
let overallPass = 0

for (const caseSpec of CASES) {
  const tStart = Date.now()
  let row
  try {
    row = await runCase(caseSpec, tmpRoot)
  } catch (e) {
    row = {
      name: caseSpec.name, phase: caseSpec.phase, pass: false,
      hits: 0, candidates: 0, mismatches: [], error: e.message,
      dt: Date.now() - tStart,
      telemetry: { llmCalls: 0, iters: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, durationMs: Date.now() - tStart },
    }
  }
  if (row.pass) overallPass += 1
  summary.push({ ...row, dt: row.dt ?? Date.now() - tStart })
  printOneRow(summary[summary.length - 1])
}

if (!KEEP_TMP) {
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
}

printSummaryTable(summary, overallPass)
process.exit(summary.every(r => r.pass) ? 0 : 1)

async function runCase(caseSpec, tmpRoot) {
  const tmpDir = mkdtempSync(join(tmpRoot, `${caseSpec.name}-`))
  const db = openDatabase(tmpDir, EMBED_DIMS)
  try {
    insertRoots(db, caseSpec)
    const candidates = (caseSpec.candidates || []).map(c => fetchRoot(db, c.id))
    const activeRows = (caseSpec.active_core || []).map(c => fetchRoot(db, c.id))
    const traceStart = traceCursorNow()
    const tCallStart = Date.now()
    const result = await runPromotePhase(
      db,
      caseSpec.phase,
      candidates,
      activeRows,
      {},
      {},
      { ACTIVE_COUNT: String(ACTIVE_COUNT), ACTIVE_CAP: String(ACTIVE_CAP) },
    )
    const durationMs = Date.now() - tCallStart
    const telemetry = collectTelemetry(traceStart, durationMs)
    const actions = Array.isArray(result?.actions) ? result.actions : []
    if (RAW_DUMP) {
      console.error(`\n[cycle2-raw] case=${caseSpec.name} phase=${caseSpec.phase} actions=${JSON.stringify(actions)}\n`)
    }
    const metrics = computeMetrics(caseSpec, actions)
    return { ...metrics, telemetry }
  } finally {
    try { db.close() } catch {}
  }
}

function insertRoots(db, caseSpec) {
  const ins = db.prepare(`
    INSERT INTO entries (id, ts, role, content, source_ref, session_id, chunk_root, is_root, element, category, summary, score, status, last_seen_at)
    VALUES (?, ?, 'system', '', ?, 'sess-bench', NULL, 1, ?, ?, ?, ?, ?, ?)
  `)
  const all = []
  for (const e of caseSpec.candidates || []) all.push(e)
  for (const e of caseSpec.active_core || []) {
    if (!all.some(x => x.id === e.id)) all.push(e)
  }
  db.exec('BEGIN')
  try {
    all.forEach((e, idx) => {
      const ts = BASE_TS + idx * 1000
      const status = caseSpec.active_core?.some(a => a.id === e.id) ? 'active' : (e.status || 'pending')
      ins.run(
        Number(e.id), ts, `cycle2-probe:${caseSpec.name}:${idx + 1}`,
        e.element || '', e.category || 'fact', e.summary || '',
        Number(e.score ?? 0), status, ts,
      )
    })
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    throw e
  }
}

function fetchRoot(db, id) {
  return db.prepare(
    `SELECT id, element, category, summary, score, status FROM entries WHERE id = ? AND is_root = 1`,
  ).get(Number(id))
}

function computeMetrics(caseSpec, actions) {
  const candidates = caseSpec.candidates || []
  const actionById = new Map(actions.map(a => [Number(a.entry_id), a]))
  const mismatches = []
  let hits = 0
  for (const c of candidates) {
    if (c.expected_action === 'any') { hits += 1; continue }
    const got = actionById.get(Number(c.id))
    const gotAction = got?.action || '(none)'
    if (c.expected_action !== gotAction) {
      mismatches.push({ id: c.id, expected: c.expected_action, got: gotAction })
      continue
    }
    if (gotAction === 'merge') {
      const expectedTarget = Number(c.expected_target)
      const actualTarget = Number(got.target_id)
      if (Number.isFinite(expectedTarget) && expectedTarget !== actualTarget) {
        mismatches.push({ id: c.id, expected: `merge→${expectedTarget}`, got: `merge→${actualTarget}` })
        continue
      }
      if (!got.element || !got.summary) {
        mismatches.push({ id: c.id, expected: 'merge w/ element+summary', got: 'merge missing fields' })
        continue
      }
    }
    if (gotAction === 'update' && (!got.element || !got.summary)) {
      mismatches.push({ id: c.id, expected: 'update w/ element+summary', got: 'update missing fields' })
      continue
    }
    hits += 1
  }
  const totalScored = candidates.filter(c => c.expected_action !== 'any').length
  const accuracy = totalScored === 0 ? 1 : hits / candidates.length
  const pass = mismatches.length === 0
  return {
    name: caseSpec.name, phase: caseSpec.phase, pass,
    hits, candidates: candidates.length, mismatches,
    accuracy, error: null,
  }
}

function printOneRow(row) {
  const status = row.pass ? '✅ PASS' : '❌ FAIL'
  const t = row.telemetry || {}
  const mm = row.mismatches?.length
    ? ' miss=[' + row.mismatches.map(m => `${m.id}:${m.expected}≠${m.got}`).join(', ') + ']'
    : ''
  console.error(
    `[case ${row.name}] ${status} phase=${row.phase} ` +
    `hits=${row.hits}/${row.candidates} acc=${(row.accuracy * 100).toFixed(1)}% ` +
    `llm=${t.llmCalls ?? '-'} iter=${t.iters ?? '-'} tool=${t.toolCalls ?? '-'} ` +
    `tok_in=${t.tokensIn ?? '-'} tok_out=${t.tokensOut ?? '-'} ` +
    `dt=${row.dt}ms` +
    mm +
    (row.error ? ` ERROR=${row.error}` : '')
  )
}

function printSummaryTable(rows, passCount) {
  const HDR = ['case', 'phase', 'pass', 'hits', 'acc', 'llm', 'iter', 'tool', 'tok_in', 'tok_out', 'dt']
  const data = rows.map(r => {
    const t = r.telemetry || {}
    return [
      r.name, r.phase, r.pass ? 'PASS' : 'FAIL',
      `${r.hits}/${r.candidates}`,
      `${(r.accuracy * 100).toFixed(1)}%`,
      String(t.llmCalls ?? '-'),
      String(t.iters ?? '-'),
      String(t.toolCalls ?? '-'),
      String(t.tokensIn ?? '-'),
      String(t.tokensOut ?? '-'),
      `${t.durationMs ?? r.dt}ms`,
    ]
  })
  const widths = HDR.map((h, i) => Math.max(h.length, ...data.map(r => String(r[i]).length)))
  const fmtRow = r => '| ' + r.map((c, i) => String(c).padEnd(widths[i])).join(' | ') + ' |'
  const sep = '|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|'
  console.log('\n=== cycle2 evaluation summary ===')
  console.log(fmtRow(HDR))
  console.log(sep)
  for (const r of data) console.log(fmtRow(r))
  console.log(`\nOverall: ${passCount}/${rows.length} cases PASSED (${(passCount / rows.length * 100).toFixed(0)}%)`)
}

function installInProcessBridge() {
  const factoryCache = new Map()
  function getLlm(role, taskType, mode, cwd) {
    const key = `${role}|${taskType}|${mode}|${cwd}`
    if (factoryCache.has(key)) return factoryCache.get(key)
    const llm = makeBridgeLlm({
      role: role || undefined, taskType: taskType || undefined,
      mode: mode || undefined, cwd: cwd || undefined,
    })
    factoryCache.set(key, llm)
    return llm
  }
  process.send = function patchedSend(msg) {
    if (!msg || msg.type !== 'agent_ipc_request' || !msg.callId) return true
    const params = msg.params || {}
    Promise.resolve().then(async () => {
      let response
      try {
        if (msg.tool !== 'bridge_llm') {
          response = { type: 'agent_ipc_response', callId: msg.callId, ok: false, error: `unsupported tool ${msg.tool}` }
        } else if (!params.prompt) {
          response = { type: 'agent_ipc_response', callId: msg.callId, ok: false, error: 'bridge_llm: prompt required' }
        } else {
          const llm = getLlm(params.role, params.taskType, params.mode, params.cwd)
          const raw = await llm({
            prompt: params.prompt, mode: params.mode || undefined,
            preset: params.preset || undefined, timeout: params.timeout || undefined,
          })
          response = { type: 'agent_ipc_response', callId: msg.callId, ok: true, result: raw }
        }
      } catch (e) {
        response = { type: 'agent_ipc_response', callId: msg.callId, ok: false, error: e?.message || String(e) }
      }
      process.emit('message', response)
    })
    return true
  }
}

function die(msg) {
  console.error(`[cycle2-probe] ${msg}`)
  process.exit(2)
}

function traceCursorNow() {
  try {
    if (!existsSync(BRIDGE_TRACE_PATH)) return 0
    return statSync(BRIDGE_TRACE_PATH).size
  } catch {
    return 0
  }
}

function readTraceTail(fromOffset) {
  if (!existsSync(BRIDGE_TRACE_PATH)) return []
  let endSize
  try { endSize = statSync(BRIDGE_TRACE_PATH).size } catch { return [] }
  if (endSize <= fromOffset) return []
  const len = endSize - fromOffset
  const buf = Buffer.alloc(len)
  const fd = openSync(BRIDGE_TRACE_PATH, 'r')
  try { readSync(fd, buf, 0, len, fromOffset) }
  finally { try { closeSync(fd) } catch {} }
  const text = buf.toString('utf8')
  const rows = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try { rows.push(JSON.parse(line)) } catch {}
  }
  return rows
}

function collectTelemetry(traceStart, durationMs) {
  const tally = { llmCalls: 0, iters: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, durationMs }
  let rows = []
  try { rows = readTraceTail(traceStart) } catch {}
  const cycle2Sessions = new Set()
  for (const r of rows) {
    if (r.kind === 'preset_assign' && (r.role === 'cycle2-agent' || r.profileId === 'cycle2-agent' || r.sourceName === 'cycle2-agent')) {
      if (r.sessionId) cycle2Sessions.add(r.sessionId)
    }
  }
  for (const r of rows) {
    if (r.sessionId && !cycle2Sessions.has(r.sessionId)) continue
    switch (r.kind) {
      case 'preset_assign': tally.llmCalls += 1; break
      case 'loop':          tally.iters += 1; break
      case 'tool':          tally.toolCalls += 1; break
      case 'usage_raw':
        tally.tokensIn  += Number(r.prompt_tokens ?? r.input_tokens) || 0
        tally.tokensOut += Number(r.output_tokens) || 0
        break
      default: break
    }
  }
  return tally
}
