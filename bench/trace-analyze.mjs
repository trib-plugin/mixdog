#!/usr/bin/env bun
// bench/trace-analyze.mjs — bridge-trace.jsonl iter-cost analyzer.
//
// Streams the trace file once and reports iter-saving signals:
//   1. tool histogram per role (which tools each role actually uses)
//   2. retrieve vs file-tool ratio (recall+search+explore vs read+grep)
//   3. unknown / hallucinated tool names (multi_edit, batch_edit, jobs_list…)
//   4. read↔grep alternation per session (locate-confirm loop)
//   5. find_symbol underuse (grep-heavy without find_symbol)
//   6. iter distribution per role (p50 / p95 / max)
//
// Use this after running real workloads to spot which roles are wasting
// iters and where the rule violations cluster.
//
// Usage:
//   node bench/trace-analyze.mjs                     # last 24h
//   node bench/trace-analyze.mjs --since=2026-04-26  # since date
//   node bench/trace-analyze.mjs --all               # whole file
//   node bench/trace-analyze.mjs --top=20            # top-N anti-patterns
//   node bench/trace-analyze.mjs --role=worker       # one role only

import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { homedir } from 'node:os'

const TRACE_PATH = join(homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin', 'history', 'bridge-trace.jsonl')
if (!existsSync(TRACE_PATH)) die(`trace not found: ${TRACE_PATH}`)

const args = parseArgs(process.argv.slice(2))
const TOP = Number(args.top ?? 10)
const ROLE_FILTER = args.role || null
const SINCE_MS = (() => {
  if (args.all) return 0
  if (args.since) {
    const t = Date.parse(args.since)
    if (!Number.isFinite(t)) die(`bad --since: ${args.since}`)
    return t
  }
  return Date.now() - 24 * 3600 * 1000
})()

// Tools that should be preferred for retrieval / structural lookup.
const RETRIEVE_TOOLS = new Set(['recall', 'search', 'explore'])
const FILE_LOOKUP_TOOLS = new Set(['read', 'grep', 'glob', 'list'])
const STRUCTURE_TOOLS = new Set(['find_symbol', 'find_imports', 'find_dependents', 'find_callers', 'find_references', 'code_graph'])
// Real builtin/MCP tool names. Anything outside this set surfaced through
// `kind:tool` rows is a hallucinated dispatch (the LLM made it up).
const KNOWN_TOOLS = new Set([
  'read', 'edit', 'write', 'apply_patch',
  'bash', 'bash_session', 'job_wait',
  'grep', 'glob', 'list',
  'find_symbol', 'find_imports', 'find_dependents', 'find_callers', 'find_references', 'code_graph',
  'recall', 'search', 'explore', 'fetch',
  'reply', 'react', 'edit_message', 'download_attachment', 'inject_input',
  'memory_search',
  'create_session', 'close_session', 'list_sessions', 'list_models',
  'reload_config', 'activate_channel_bridge', 'bridge', 'bridge_send', 'bridge_spawn',
  'schedule_status', 'trigger_schedule', 'schedule_control',
  'skills_list', 'skill_view', 'skill_execute', 'skill_suggest',
  'web_search', 'set_prompt', 'get_workflow', 'get_workflows',
])

// session → {role, tools:[name…], iters:Set, tokensIn, tokensOut, ts0, ts1}
const sessions = new Map()
const unknownTools = new Map() // name → count

const stream = createReadStream(TRACE_PATH, { encoding: 'utf-8' })
const rl = createInterface({ input: stream, crlfDelay: Infinity })

let lineCount = 0
for await (const line of rl) {
  lineCount++
  if (!line) continue
  let row
  try { row = JSON.parse(line) } catch { continue }
  const ts = Date.parse(row.ts)
  if (!Number.isFinite(ts) || ts < SINCE_MS) continue
  const sid = row.sessionId
  if (!sid) continue
  let s = sessions.get(sid)
  if (!s) {
    s = { role: null, preset: null, tools: [], iters: new Set(), tokensIn: 0, tokensOut: 0, ts0: ts, ts1: ts }
    sessions.set(sid, s)
  }
  s.ts1 = ts
  switch (row.kind) {
    case 'preset_assign':
      s.role = row.role || row.profileId || row.sourceName || s.role
      s.preset = row.preset_name || s.preset
      break
    case 'tool': {
      const name = row.tool_name || '(unnamed)'
      s.tools.push(name)
      if (Number.isFinite(row.iteration)) s.iters.add(row.iteration)
      if (!KNOWN_TOOLS.has(name)) {
        unknownTools.set(name, (unknownTools.get(name) || 0) + 1)
      }
      break
    }
    case 'loop':
      if (Number.isFinite(row.iteration)) s.iters.add(row.iteration)
      break
    case 'usage_raw':
      s.tokensIn += Number(row.prompt_tokens ?? row.input_tokens) || 0
      s.tokensOut += Number(row.output_tokens) || 0
      break
  }
}

// ── per-role aggregation ─────────────────────────────────────────────
const roleStats = new Map() // role → {sessions, iters[], toolHist:Map, retrieveCount, fileLookupCount, structureCount, readGrepAlt:[], grepHeavyNoSymbol:[]}

for (const [sid, s] of sessions) {
  const role = s.role || '(unknown)'
  if (ROLE_FILTER && role !== ROLE_FILTER) continue
  let r = roleStats.get(role)
  if (!r) {
    r = { sessions: 0, itersList: [], toolHist: new Map(), retrieveCount: 0, fileLookupCount: 0, structureCount: 0, totalTools: 0, readGrepAlt: [], grepHeavyNoSymbol: [], tokensIn: 0, tokensOut: 0 }
    roleStats.set(role, r)
  }
  r.sessions += 1
  r.itersList.push(s.iters.size || s.tools.length)
  r.tokensIn += s.tokensIn
  r.tokensOut += s.tokensOut
  let readCount = 0, grepCount = 0, findSymbolCount = 0
  let alternations = 0
  let prev = null
  for (const t of s.tools) {
    r.toolHist.set(t, (r.toolHist.get(t) || 0) + 1)
    r.totalTools += 1
    if (RETRIEVE_TOOLS.has(t)) r.retrieveCount += 1
    if (FILE_LOOKUP_TOOLS.has(t)) r.fileLookupCount += 1
    if (STRUCTURE_TOOLS.has(t)) r.structureCount += 1
    if (t === 'read') readCount++
    if (t === 'grep') grepCount++
    if (t === 'find_symbol') findSymbolCount++
    if (prev && ((prev === 'read' && t === 'grep') || (prev === 'grep' && t === 'read'))) {
      alternations++
    }
    prev = t
  }
  if (alternations >= 6) {
    r.readGrepAlt.push({ sid, alternations, reads: readCount, greps: grepCount, totalTools: s.tools.length })
  }
  if (grepCount >= 5 && findSymbolCount === 0) {
    r.grepHeavyNoSymbol.push({ sid, greps: grepCount, totalTools: s.tools.length })
  }
}

// ── output ───────────────────────────────────────────────────────────
console.log(`bridge-trace iter-cost report`)
console.log(`  source       : ${TRACE_PATH}`)
console.log(`  lines parsed : ${lineCount}`)
console.log(`  since        : ${SINCE_MS === 0 ? '(all)' : new Date(SINCE_MS).toISOString()}`)
console.log(`  sessions     : ${sessions.size}${ROLE_FILTER ? ` (role=${ROLE_FILTER})` : ''}`)
console.log('')

const roles = [...roleStats.entries()].sort((a, b) => b[1].sessions - a[1].sessions)

for (const [role, r] of roles) {
  console.log(`── role: ${role}`)
  console.log(`   sessions: ${r.sessions}`)
  if (r.itersList.length > 0) {
    const sorted = r.itersList.slice().sort((a, b) => a - b)
    const p50 = sorted[Math.floor(sorted.length * 0.5)]
    const p95 = sorted[Math.floor(sorted.length * 0.95)]
    const max = sorted[sorted.length - 1]
    const mean = (sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1)
    console.log(`   iters    : mean=${mean} p50=${p50} p95=${p95} max=${max}`)
  }
  console.log(`   tokens   : in=${r.tokensIn.toLocaleString()} out=${r.tokensOut.toLocaleString()}`)
  if (r.totalTools > 0) {
    const retrievePct = ((r.retrieveCount / r.totalTools) * 100).toFixed(1)
    const fileLookupPct = ((r.fileLookupCount / r.totalTools) * 100).toFixed(1)
    const structurePct = ((r.structureCount / r.totalTools) * 100).toFixed(1)
    console.log(`   tool mix : total=${r.totalTools} retrieve=${retrievePct}% file=${fileLookupPct}% structure=${structurePct}%`)
  }
  const topTools = [...r.toolHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  console.log(`   top tools: ${topTools.map(([n, c]) => `${n}(${c})`).join(' ')}`)
  if (r.readGrepAlt.length > 0) {
    const top = r.readGrepAlt.sort((a, b) => b.alternations - a.alternations).slice(0, TOP)
    console.log(`   read↔grep alt (≥6): ${r.readGrepAlt.length} sessions; top:`)
    for (const x of top) {
      console.log(`     ${x.sid.slice(-12)} alt=${x.alternations} reads=${x.reads} greps=${x.greps} tools=${x.totalTools}`)
    }
  }
  if (r.grepHeavyNoSymbol.length > 0) {
    const top = r.grepHeavyNoSymbol.sort((a, b) => b.greps - a.greps).slice(0, TOP)
    console.log(`   grep≥5 + 0 find_symbol: ${r.grepHeavyNoSymbol.length} sessions; top:`)
    for (const x of top) {
      console.log(`     ${x.sid.slice(-12)} greps=${x.greps} tools=${x.totalTools}`)
    }
  }
  console.log('')
}

if (unknownTools.size > 0) {
  console.log(`── hallucinated tool names (not in BUILTIN_TOOLS / known MCP set)`)
  const sorted = [...unknownTools.entries()].sort((a, b) => b[1] - a[1])
  for (const [name, count] of sorted) {
    console.log(`   ${name.padEnd(22)} ${count}`)
  }
} else {
  console.log(`── hallucinated tool names: none`)
}

function parseArgs(argv) {
  const out = {}
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=')
      out[k] = v ?? true
    }
  }
  return out
}

function die(msg) { console.error(msg); process.exit(2) }
