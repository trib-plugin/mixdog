#!/usr/bin/env node
// bench/bridge-analyze.mjs — analyze bridge-trace metrics for given sessionIds.
//
// Usage:
//   node bench/bridge-analyze.mjs <sessionId1> [sessionId2 ...]
//   node bench/bridge-analyze.mjs --file=/path/to/sessionIds.txt   # one id per line
//
// Reads bridge-trace.jsonl, extracts each session's tool sequence, and prints
// a per-session metric row plus an aggregate summary across all sessions.
//
// Metrics per session:
//   role, iters, toolCalls, structurePct, fileLookupPct, bashLookupCalls,
//   altCount, duration_ms, top tools

import { readFileSync, existsSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { homedir } from 'node:os'

const TRACE_PATH = join(homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin', 'history', 'bridge-trace.jsonl')
if (!existsSync(TRACE_PATH)) die(`trace not found: ${TRACE_PATH}`)

const args = process.argv.slice(2)
let sessionIds = []
const flags = {}
for (const a of args) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2]
  else sessionIds.push(a)
}
if (flags.file) {
  if (!existsSync(flags.file)) die(`file not found: ${flags.file}`)
  sessionIds = sessionIds.concat(
    readFileSync(flags.file, 'utf-8').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  )
}
if (!sessionIds.length) die(`usage: bridge-analyze.mjs <sessionId>... | --file=ids.txt`)

const STRUCTURE_TOOLS = /^(find_symbol|find_imports|find_dependents|find_callers|find_references|code_graph)$/
const FILE_LOOKUP_TOOLS = /^(read|grep|glob|list|multi_read)$/
const BASH_LOOKUP_PATTERNS = /\b(ls|cat|find|head|tail|grep|wc|file|du)\b/

const wanted = new Set(sessionIds)
const sessions = new Map() // id → { tools:[], iters:Set, role, ts0, ts1, bashLookup, args:Map }

const stream = createReadStream(TRACE_PATH, { encoding: 'utf-8' })
const rl = createInterface({ input: stream, crlfDelay: Infinity })
for await (const line of rl) {
  if (!line) continue
  let row
  try { row = JSON.parse(line) } catch { continue }
  if (!wanted.has(row.sessionId)) continue
  let s = sessions.get(row.sessionId)
  if (!s) {
    s = { tools: [], iters: new Set(), role: null, ts0: null, ts1: null, bashLookup: 0, totalLines: 0 }
    sessions.set(row.sessionId, s)
  }
  s.totalLines++
  const ts = Date.parse(row.ts)
  if (Number.isFinite(ts)) {
    if (s.ts0 === null || ts < s.ts0) s.ts0 = ts
    if (s.ts1 === null || ts > s.ts1) s.ts1 = ts
  }
  if (!s.role && row.role) s.role = row.role
  if (row.kind === 'preset_assign' && row.role) s.role = row.role
  if (row.iteration) s.iters.add(row.iteration)
  if (row.kind === 'tool' && row.tool_name) {
    s.tools.push(row.tool_name)
    if (row.tool_name === 'bash' && row.tool_args && typeof row.tool_args.command === 'string') {
      if (BASH_LOOKUP_PATTERNS.test(row.tool_args.command) && !/\bgit\b|\bnpm\b|\bnode\b|\bpwsh\b|\btest\b/.test(row.tool_args.command)) {
        s.bashLookup++
      }
    }
  }
}

const rows = []
for (const id of sessionIds) {
  const s = sessions.get(id)
  if (!s) {
    rows.push({ id, missing: true })
    continue
  }
  let alt = 0, last = null
  for (const t of s.tools) {
    if ((t === 'read' || t === 'grep') && last && last !== t && (last === 'read' || last === 'grep')) alt++
    last = t
  }
  const histogram = s.tools.reduce((m, t) => (m[t] = (m[t] || 0) + 1, m), {})
  const total = s.tools.length
  const structure = s.tools.filter(t => STRUCTURE_TOOLS.test(t)).length
  const fileLookup = s.tools.filter(t => FILE_LOOKUP_TOOLS.test(t)).length
  const top = Object.entries(histogram).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, v]) => `${k}(${v})`).join(' ')
  rows.push({
    id,
    role: s.role,
    iters: s.iters.size,
    toolCalls: total,
    structurePct: total ? +(structure / total * 100).toFixed(1) : 0,
    fileLookupPct: total ? +(fileLookup / total * 100).toFixed(1) : 0,
    bashLookup: s.bashLookup,
    altCount: alt,
    durationMs: s.ts0 !== null && s.ts1 !== null ? s.ts1 - s.ts0 : null,
    top,
  })
}

console.log('\n══ per-session ══')
console.log('id'.padEnd(50), 'role'.padEnd(10), 'iter', 'tools', 'struct%', 'file%', 'bashLk', 'alt', 'dt(ms)')
for (const r of rows) {
  if (r.missing) {
    console.log(r.id.padEnd(50), '(no trace rows found)')
    continue
  }
  console.log(
    String(r.id).padEnd(50),
    String(r.role || '?').padEnd(10),
    String(r.iters).padStart(4),
    String(r.toolCalls).padStart(5),
    String(r.structurePct).padStart(7),
    String(r.fileLookupPct).padStart(5),
    String(r.bashLookup).padStart(6),
    String(r.altCount).padStart(3),
    String(r.durationMs ?? '?').padStart(6),
  )
  if (r.top) console.log(' '.repeat(50), '└', r.top)
}

const found = rows.filter(r => !r.missing)
if (found.length > 0) {
  const byRole = new Map()
  for (const r of found) {
    const list = byRole.get(r.role) || []
    list.push(r)
    byRole.set(r.role, list)
  }
  console.log('\n══ by role ══')
  console.log('role'.padEnd(10), 'n', 'iter avg', 'iter p95', 'struct% avg', 'bashLk avg', 'alt avg', 'dt avg(ms)')
  for (const [role, list] of byRole) {
    const n = list.length
    const itArr = list.map(r => r.iters).sort((a, b) => a - b)
    const iterAvg = +(itArr.reduce((a, b) => a + b, 0) / n).toFixed(1)
    const iterP95 = itArr[Math.min(n - 1, Math.floor(n * 0.95))]
    const structAvg = +(list.reduce((a, b) => a + b.structurePct, 0) / n).toFixed(1)
    const bashAvg = +(list.reduce((a, b) => a + b.bashLookup, 0) / n).toFixed(1)
    const altAvg = +(list.reduce((a, b) => a + b.altCount, 0) / n).toFixed(1)
    const dtAvg = Math.round(list.reduce((a, b) => a + (b.durationMs ?? 0), 0) / n)
    console.log(
      String(role).padEnd(10),
      String(n).padStart(1),
      String(iterAvg).padStart(8),
      String(iterP95).padStart(8),
      String(structAvg).padStart(11),
      String(bashAvg).padStart(10),
      String(altAvg).padStart(7),
      String(dtAvg).padStart(10),
    )
  }
}

function die(msg) {
  console.error(`[bridge-analyze] ${msg}`)
  process.exit(1)
}
