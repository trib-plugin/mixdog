#!/usr/bin/env bun
// bench/cycle-probe.mjs — cycle1 chunking-quality benchmark.
//
// Loads each fixture in bench/cycle-fixtures.json into a fresh temp sqlite
// DB, runs runCycle1() in-process against the live cycle1-agent prompt,
// then computes structural metrics (coverage, chunk_count, topic_grouping,
// cross_topic_purity, ack_absorbed, session_split_ok) from the resulting
// entries table. Output is a per-case row + overall PASS rate.
//
// Use this as the structural-A/B harness when iterating on cycle1 prompt
// or chunking strategy (window overlap, embedding-merge pass, etc).
//
// Usage:
//   node bench/cycle-probe.mjs                  # run all 5 fixtures
//   node bench/cycle-probe.mjs <case-name>      # run one fixture
//
// Env:
//   CYCLE_PROBE_KEEP_TMP=1   leave temp dirs in place for inspection
//   CYCLE_PROBE_VERBOSE=1    dump per-chunk content + raw rows

import { readFileSync, mkdtempSync, rmSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const PLUGIN_DATA = join(homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin')

// MUST be set before any plugin module imports — agent.init() and the
// memory schema both read these from process.env at import time.
process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT
process.env.CLAUDE_PLUGIN_DATA = PLUGIN_DATA
const BRIDGE_TRACE_PATH = join(PLUGIN_DATA, 'history', 'bridge-trace.jsonl')

const VERBOSE = process.env.CYCLE_PROBE_VERBOSE === '1'
const KEEP_TMP = process.env.CYCLE_PROBE_KEEP_TMP === '1'

const argFilter = process.argv[2] || null

// ── load fixtures ───────────────────────────────────────────────────
const FIXTURE_PATH = join(HERE, 'cycle-fixtures.json')
const fixtures = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
const BASE_TS = Number(fixtures.base_ts) || Date.now()
const ALL_CASES = fixtures.cases || []
const CASES = argFilter ? ALL_CASES.filter(c => c.name === argFilter) : ALL_CASES
if (CASES.length === 0) die(`no fixture matched "${argFilter}"`)

// ── live module imports ─────────────────────────────────────────────
const importLocal = (rel) => import(pathToFileURL(join(PLUGIN_ROOT, rel)).href)

// agent.init() registers providers + presets (so makeBridgeLlm can resolve
// cycle1-agent role → concrete provider). Mirrors bench/probe.mjs init.
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

// ── in-process IPC bridge ───────────────────────────────────────────
// runCycle1 → callBridgeLlm() in agent-ipc.mjs uses process.send /
// process.on('message') to talk to the parent server. Since we're not
// forked, we stub process.send to invoke makeBridgeLlm() in-process,
// then emit the agent_ipc_response back so agent-ipc.mjs's listener
// resolves the pending promise.
//
// Same flow handleAgentIpcRequest() implements in server.mjs:305+.
installInProcessBridge()

const memoryMod = await importLocal('src/memory/lib/memory.mjs')
  .catch(e => die(`import memory.mjs failed: ${e.message}`))
const { openDatabase } = memoryMod

const cycleMod = await importLocal('src/memory/lib/memory-cycle.mjs')
  .catch(e => die(`import memory-cycle.mjs failed: ${e.message}`))
const { runCycle1 } = cycleMod

// embedding dim — cycle1 itself does not embed (cycle2/embed-worker do),
// but openDatabase requires a dim for the vec virtual table. 1024 matches
// the live config; any positive int works for cycle1-only runs.
const EMBED_DIMS = 1024

// ── run all selected cases ──────────────────────────────────────────
const tmpRoot = mkdtempSync(join(tmpdir(), 'cycle-probe-'))
console.error(`[cycle-probe] tmp root = ${tmpRoot}`)

const summary = []
let overallPass = 0

for (const caseSpec of CASES) {
  const tStart = Date.now()
  let row
  try {
    row = await runCase(caseSpec, tmpRoot)
  } catch (e) {
    row = {
      name: caseSpec.name,
      pass: false,
      coverage: 0,
      chunkCount: 0,
      topicGrouping: 0,
      crossTopicPurity: 0,
      ackAbsorbed: null,
      sessionSplitOk: null,
      error: e.message,
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

// ── per-case implementation ─────────────────────────────────────────

async function runCase(caseSpec, tmpRoot) {
  const tmpDir = mkdtempSync(join(tmpRoot, `${caseSpec.name}-`))
  const db = openDatabase(tmpDir, EMBED_DIMS)
  try {
    insertEntries(db, caseSpec)
    const traceStart = traceCursorNow()
    const tCycleStart = Date.now()
    await runCycle1(db, { batch_size: 50, min_batch: 1 })
    const durationMs = Date.now() - tCycleStart
    const telemetry = collectTelemetry(traceStart, durationMs)
    const rows = db.prepare(`
      SELECT id, ts, role, content, session_id, chunk_root, is_root, element, category, summary
      FROM entries ORDER BY id ASC
    `).all()
    if (VERBOSE) {
      console.error(`\n[verbose] case=${caseSpec.name}`)
      for (const r of rows) {
        console.error(`  id=${r.id} sess=${r.session_id} root=${r.chunk_root} is_root=${r.is_root} element=${r.element || ''}`)
      }
    }
    const metrics = computeMetrics(caseSpec, rows)
    return { ...metrics, telemetry }
  } finally {
    try { db.close() } catch {}
  }
}

function insertEntries(db, caseSpec) {
  // node:sqlite has no .transaction() helper — use BEGIN/COMMIT manually.
  const ins = db.prepare(`
    INSERT INTO entries (ts, role, content, source_ref, session_id, chunk_root, is_root)
    VALUES (?, ?, ?, ?, ?, NULL, 0)
  `)
  db.exec('BEGIN')
  try {
    caseSpec.entries.forEach((e, idx) => {
      const ts = BASE_TS + idx * 1000
      const sessionId = e.session_id || 'sess1'
      const sourceRef = `cycle-probe:${caseSpec.name}:${idx + 1}`
      ins.run(ts, e.role || 'user', String(e.content), sourceRef, sessionId)
    })
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    throw e
  }
}

// ── metric computation ──────────────────────────────────────────────

function computeMetrics(caseSpec, rows) {
  const expected = caseSpec.expected || {}
  const expTopics = expected.topics || []
  const ackIds = new Set(expected.ack_ids || [])
  const [chunkLo, chunkHi] = expected.chunk_count_range || [1, rows.length]

  // Coverage — fraction of input ids with a non-null chunk_root.
  // We index input ids 1..N by ORDER BY id ASC (matches insert order).
  const idMap = new Map(rows.map((r, i) => [i + 1, r])) // logical idx → row
  const total = rows.length
  const withRoot = rows.filter(r => r.chunk_root != null).length
  const coverage = total === 0 ? 0 : withRoot / total

  // Chunk count
  const distinctRoots = new Set(rows.map(r => r.chunk_root).filter(v => v != null))
  const chunkCount = distinctRoots.size

  // Topic grouping — per topic, max(share-of-topic-in-any-single-root) /
  // group-size; case-level mean.
  const topicGroupingPerTopic = expTopics.map(topic => {
    const ids = topic.ids || []
    if (ids.length === 0) return 1
    const counts = new Map()
    for (const logicalId of ids) {
      const row = idMap.get(logicalId)
      if (!row || row.chunk_root == null) continue
      counts.set(row.chunk_root, (counts.get(row.chunk_root) || 0) + 1)
    }
    let maxShare = 0
    for (const c of counts.values()) maxShare = Math.max(maxShare, c)
    return maxShare / ids.length
  })
  const topicGrouping = mean(topicGroupingPerTopic)

  // Cross-topic purity — for each chunk_root, fraction of its members
  // belonging to ONE expected topic. Acks are excluded from the
  // denominator (they're a free pass).
  const expectedIdToTopic = new Map()
  for (const topic of expTopics) {
    for (const logicalId of topic.ids || []) {
      expectedIdToTopic.set(logicalId, topic.name)
    }
  }
  const purityPerRoot = []
  for (const root of distinctRoots) {
    const memberLogicalIds = []
    rows.forEach((r, i) => { if (r.chunk_root === root && !ackIds.has(i + 1)) memberLogicalIds.push(i + 1) })
    if (memberLogicalIds.length === 0) continue
    const topicCounts = new Map()
    for (const lid of memberLogicalIds) {
      const t = expectedIdToTopic.get(lid) || '__unknown__'
      topicCounts.set(t, (topicCounts.get(t) || 0) + 1)
    }
    let maxCount = 0
    for (const c of topicCounts.values()) maxCount = Math.max(maxCount, c)
    purityPerRoot.push(maxCount / memberLogicalIds.length)
  }
  const crossTopicPurity = purityPerRoot.length === 0 ? 0 : mean(purityPerRoot)

  // Ack absorption — for each ack id, did it land on the dominant
  // chunk_root of the surrounding non-ack ids? Skip when no acks.
  let ackAbsorbed = null
  if (ackIds.size > 0) {
    let ok = 0
    for (const ackId of ackIds) {
      const ackRow = idMap.get(ackId)
      if (!ackRow || ackRow.chunk_root == null) continue
      // Dominant root = the most common chunk_root among non-ack ids
      // belonging to the same expected topic that contains the ack
      // surroundings (we use any topic whose ids neighbour this ack).
      const surroundingTopic = findSurroundingTopic(ackId, expTopics, ackIds)
      if (!surroundingTopic) continue
      const counts = new Map()
      for (const lid of surroundingTopic.ids) {
        if (ackIds.has(lid)) continue
        const r = idMap.get(lid)
        if (!r || r.chunk_root == null) continue
        counts.set(r.chunk_root, (counts.get(r.chunk_root) || 0) + 1)
      }
      let dominantRoot = null, dominantCount = 0
      for (const [root, c] of counts) {
        if (c > dominantCount) { dominantCount = c; dominantRoot = root }
      }
      if (dominantRoot != null && ackRow.chunk_root === dominantRoot) ok += 1
    }
    ackAbsorbed = ok / ackIds.size
  }

  // Session split — for case 5 only. PASS iff no chunk_root spans
  // multiple session_ids.
  let sessionSplitOk = null
  if (expected.must_split_sessions) {
    sessionSplitOk = true
    const rootSessions = new Map()
    for (const r of rows) {
      if (r.chunk_root == null) continue
      let set = rootSessions.get(r.chunk_root)
      if (!set) { set = new Set(); rootSessions.set(r.chunk_root, set) }
      set.add(r.session_id)
    }
    for (const set of rootSessions.values()) {
      if (set.size > 1) { sessionSplitOk = false; break }
    }
  }

  // PASS aggregation
  const pass =
    coverage >= 1.0
    && chunkCount >= chunkLo && chunkCount <= chunkHi
    && topicGrouping >= 0.9
    && crossTopicPurity >= 0.9
    && (ackAbsorbed === null || ackAbsorbed >= 0.9)
    && (sessionSplitOk === null || sessionSplitOk === true)

  return {
    name: caseSpec.name,
    pass,
    coverage,
    chunkCount,
    chunkRange: `${chunkLo}-${chunkHi}`,
    topicGrouping,
    crossTopicPurity,
    ackAbsorbed,
    sessionSplitOk,
    error: null,
  }
}

function findSurroundingTopic(ackId, topics, ackIds) {
  // Pick the topic whose non-ack ids are closest in logical-id distance.
  let best = null
  let bestDist = Infinity
  for (const topic of topics) {
    const nonAck = (topic.ids || []).filter(id => !ackIds.has(id))
    if (nonAck.length === 0) continue
    const minD = nonAck.reduce((m, id) => Math.min(m, Math.abs(id - ackId)), Infinity)
    if (minD < bestDist) { bestDist = minD; best = topic }
  }
  return best
}

function mean(arr) {
  if (!arr || arr.length === 0) return 0
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

// ── output formatting ───────────────────────────────────────────────

function fmtPct(v) {
  if (v == null) return '   - '
  return (v * 100).toFixed(1).padStart(5) + '%'
}

function fmtBool(v) {
  if (v == null) return '   -'
  return v ? '   Y' : '   N'
}

function printOneRow(row) {
  const status = row.pass ? '✅ PASS' : '❌ FAIL'
  const t = row.telemetry || {}
  console.error(
    `[case ${row.name}] ${status} ` +
    `cov=${fmtPct(row.coverage)} chunks=${row.chunkCount}(${row.chunkRange}) ` +
    `group=${fmtPct(row.topicGrouping)} purity=${fmtPct(row.crossTopicPurity)} ` +
    `ack=${fmtPct(row.ackAbsorbed)} sess=${fmtBool(row.sessionSplitOk)} ` +
    `llm=${t.llmCalls ?? '-'} iter=${t.iters ?? '-'} tool=${t.toolCalls ?? '-'} ` +
    `tok_in=${t.tokensIn ?? '-'} tok_out=${t.tokensOut ?? '-'} ` +
    `dt=${row.dt}ms` +
    (row.error ? ` ERROR=${row.error}` : '')
  )
}

function printSummaryTable(rows, passCount) {
  const HDR = ['case', 'pass', 'cov', 'chunks/range', 'group', 'purity', 'ack', 'sess',
               'llm', 'iter', 'tool', 'tok_in', 'tok_out', 'dt']
  const data = rows.map(r => {
    const t = r.telemetry || {}
    return [
      r.name,
      r.pass ? 'PASS' : 'FAIL',
      fmtPct(r.coverage).trim(),
      `${r.chunkCount}/${r.chunkRange}`,
      fmtPct(r.topicGrouping).trim(),
      fmtPct(r.crossTopicPurity).trim(),
      fmtPct(r.ackAbsorbed).trim(),
      r.sessionSplitOk == null ? '-' : (r.sessionSplitOk ? 'Y' : 'N'),
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
  console.log('\n=== cycle1 evaluation summary ===')
  console.log(fmtRow(HDR))
  console.log(sep)
  for (const r of data) console.log(fmtRow(r))
  console.log(`\nOverall: ${passCount}/${rows.length} cases PASSED (${(passCount / rows.length * 100).toFixed(0)}%)`)
}

// ── helpers ─────────────────────────────────────────────────────────

function installInProcessBridge() {
  // agent-ipc.mjs sends `agent_ipc_request` via process.send and listens
  // for `agent_ipc_response` via process.on('message'). In a non-forked
  // process both are inert. We monkey-patch:
  //   - process.send: captured request → makeBridgeLlm in-process →
  //                   queue agent_ipc_response → emit on next tick.
  //   - process.on('message') already works in any process; emit just
  //     dispatches to its listeners.
  // This mirrors handleAgentIpcRequest() in server.mjs for 'bridge_llm'.
  const factoryCache = new Map()
  function getLlm(role, taskType, mode, cwd) {
    const key = `${role}|${taskType}|${mode}|${cwd}`
    if (factoryCache.has(key)) return factoryCache.get(key)
    const llm = makeBridgeLlm({
      role: role || undefined,
      taskType: taskType || undefined,
      mode: mode || undefined,
      cwd: cwd || undefined,
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
            prompt: params.prompt,
            mode: params.mode || undefined,
            preset: params.preset || undefined,
            timeout: params.timeout || undefined,
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
  console.error(`[cycle-probe] ${msg}`)
  process.exit(2)
}

// ── bridge-trace.jsonl telemetry ────────────────────────────────────
// bridge-trace appends one row per (preset_assign | loop | tool | usage_raw |
// fetch | sse | …) event for every askSession call. We snapshot the file
// length before each fixture's runCycle1, then read the new tail after,
// and tally:
//   llm_calls = preset_assign rows  (one per llm() session)
//   iters     = loop rows           (one per agent-loop iteration)
//   tool_calls= tool rows           (one per tool invocation)
//   tokens_in/out = sum of usage_raw input/output tokens
//   duration_ms = wall-clock around runCycle1()
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
  try {
    readSync(fd, buf, 0, len, fromOffset)
  } finally {
    try { closeSync(fd) } catch {}
  }
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
  if (process.env.PROBE_TELEMETRY_DEBUG) {
    console.error(`[telemetry] traceStart=${traceStart} now=${traceCursorNow()} rows=${rows.length} kinds=${[...new Set(rows.map(r => r.kind))].join(',')}`)
  }
  // Filter to cycle1-agent rows only — bridge-trace.jsonl is shared with the
  // host process (other concurrent askSession calls). Identify by sessionId
  // family: collect sessionIds from preset_assign rows that belong to
  // cycle1-agent, then keep only rows referencing those sessionIds.
  const cycle1Sessions = new Set()
  for (const r of rows) {
    if (r.kind === 'preset_assign' && (r.role === 'cycle1-agent' || r.profileId === 'cycle1-agent' || r.sourceName === 'cycle1-agent')) {
      if (r.sessionId) cycle1Sessions.add(r.sessionId)
    }
  }
  for (const r of rows) {
    if (r.sessionId && !cycle1Sessions.has(r.sessionId)) continue
    switch (r.kind) {
      // preset_assign fires on every dispatch attempt (retry / fallback /
      // re-route), so summing it overcounts LLM calls when the provider
      // bounces. `loop` is one row per actual provider.send, the
      // deterministic per-LLM-call counter we want to measure here.
      case 'loop':          tally.iters += 1; tally.llmCalls += 1; break
      case 'tool':          tally.toolCalls += 1; break
      case 'usage_raw':
        // prompt_tokens = uncached input + cached input (full prompt size we sent).
        // Falls back to input_tokens if a provider omits prompt_tokens.
        tally.tokensIn  += Number(r.prompt_tokens ?? r.input_tokens) || 0
        tally.tokensOut += Number(r.output_tokens) || 0
        break
      default: break
    }
  }
  return tally
}
