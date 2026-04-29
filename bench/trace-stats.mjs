#!/usr/bin/env bun
// bench/trace-stats.mjs — bridge-trace.jsonl analytics.
//
// Walks the live trace file (and rotated shards if present) and prints
// aggregates for the kinds the result-compression and batch metrics emit:
//
//   compress  per-tool savings_pct + total bytes saved
//   batch     per-turn tool_call_count distribution + multi-tool ratio
//
// Run:
//   bun bench/trace-stats.mjs                         # last 24h, all kinds
//   bun bench/trace-stats.mjs --window 6h             # last 6 hours
//   bun bench/trace-stats.mjs --kind compress         # compress only
//   bun bench/trace-stats.mjs --kind batch --window 1h
//
// No external deps. Reads jsonl with sync IO since trace files are bounded
// by the rotation policy (20 MB live + 3 rotations) in bridge-trace.mjs.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA
  || join(homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin')
const HISTORY_DIR = join(PLUGIN_DATA, 'history')
const TRACE_PATH = join(HISTORY_DIR, 'bridge-trace.jsonl')

function parseArgs(argv) {
  const args = { window: '24h', kind: 'all' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--window' && argv[i + 1]) { args.window = argv[++i]; continue }
    if (a === '--kind' && argv[i + 1]) { args.kind = argv[++i]; continue }
  }
  return args
}

function windowToMs(w) {
  const m = String(w || '').match(/^(\d+)([hd])$/i)
  if (!m) return 24 * 60 * 60 * 1000
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  return unit === 'h' ? n * 60 * 60 * 1000 : n * 24 * 60 * 60 * 1000
}

function listTraceFiles() {
  if (!existsSync(HISTORY_DIR)) return []
  const all = readdirSync(HISTORY_DIR)
  const live = TRACE_PATH
  const rotated = all
    .filter(name => name.startsWith('bridge-trace.jsonl.'))
    .map(name => join(HISTORY_DIR, name))
  const out = []
  if (existsSync(live)) out.push(live)
  for (const f of rotated) out.push(f)
  return out
}

function* readRows(paths, cutoffMs) {
  for (const path of paths) {
    let stat
    try { stat = statSync(path) } catch { continue }
    if (stat.mtimeMs < cutoffMs) continue
    let text
    try { text = readFileSync(path, 'utf-8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      const ts = row.ts ? Date.parse(row.ts) : NaN
      if (Number.isFinite(ts) && ts < cutoffMs) continue
      yield row
    }
  }
}

function fmtBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / 1024 / 1024).toFixed(2)} MB`
}

function fmtPct(n) {
  const v = Number(n) || 0
  return `${v.toFixed(1)}%`
}

function pad(s, w) { return String(s).padEnd(w) }

function summarizeCompress(rows) {
  const byTool = new Map()
  let totalBefore = 0
  let totalAfter = 0
  let totalCalls = 0
  for (const r of rows) {
    if (r.kind !== 'compress') continue
    const tool = r.tool_name || 'unknown'
    const before = Number(r.bytes_before) || 0
    const after = Number(r.bytes_after) || 0
    if (before <= 0) continue
    let acc = byTool.get(tool)
    if (!acc) {
      acc = { calls: 0, before: 0, after: 0 }
      byTool.set(tool, acc)
    }
    acc.calls += 1
    acc.before += before
    acc.after += after
    totalBefore += before
    totalAfter += after
    totalCalls += 1
  }
  if (totalCalls === 0) {
    console.log('compress: no rows in window')
    return
  }
  const tools = [...byTool.entries()].sort((a, b) => (b[1].before - b[1].after) - (a[1].before - a[1].after))
  console.log('compress savings (per tool):')
  console.log('  ' + pad('tool', 14) + pad('calls', 8) + pad('saved', 12) + pad('avg %', 8))
  for (const [tool, acc] of tools) {
    const saved = acc.before - acc.after
    const pct = acc.before > 0 ? (saved / acc.before) * 100 : 0
    console.log('  ' + pad(tool, 14) + pad(acc.calls, 8) + pad(fmtBytes(saved), 12) + pad(fmtPct(pct), 8))
  }
  const totalSaved = totalBefore - totalAfter
  const totalPct = totalBefore > 0 ? (totalSaved / totalBefore) * 100 : 0
  console.log('  ' + pad('TOTAL', 14) + pad(totalCalls, 8) + pad(fmtBytes(totalSaved), 12) + pad(fmtPct(totalPct), 8))
}

function summarizeBatch(rows) {
  let total = 0
  let multi = 0
  let totalCalls = 0
  const dist = new Map()
  for (const r of rows) {
    if (r.kind !== 'batch') continue
    const n = Number(r.tool_call_count) || 0
    if (n <= 0) continue
    total += 1
    if (n >= 2) multi += 1
    totalCalls += n
    dist.set(n, (dist.get(n) || 0) + 1)
  }
  if (total === 0) {
    console.log('batch: no rows in window')
    return
  }
  const ratio = total > 0 ? (multi / total) * 100 : 0
  const avg = total > 0 ? totalCalls / total : 0
  console.log('batch shape (per assistant turn):')
  console.log(`  turns:        ${total}`)
  console.log(`  multi-tool:   ${multi} (${fmtPct(ratio)})`)
  console.log(`  avg calls:    ${avg.toFixed(2)}`)
  const sortedSizes = [...dist.entries()].sort((a, b) => a[0] - b[0])
  console.log('  distribution: ' + sortedSizes.map(([n, c]) => `${n}=${c}`).join(' '))
}

const args = parseArgs(process.argv.slice(2))
const windowMs = windowToMs(args.window)
const cutoffMs = Date.now() - windowMs
const paths = listTraceFiles()
if (paths.length === 0) {
  console.error(`no trace files under ${HISTORY_DIR}`)
  process.exit(1)
}
const rows = [...readRows(paths, cutoffMs)]
console.log(`window: last ${args.window}  files: ${paths.length}  rows: ${rows.length}`)
console.log()
if (args.kind === 'all' || args.kind === 'compress') summarizeCompress(rows)
if (args.kind === 'all') console.log()
if (args.kind === 'all' || args.kind === 'batch') summarizeBatch(rows)
