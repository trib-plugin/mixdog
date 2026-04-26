#!/usr/bin/env node
// bench/read-probe.mjs — read tool structural benchmark.
//
// Validates the read tool's mode dispatchers (full / head / tail / count)
// against a fixed set of fixture files in a temp dir. The probe asserts
// per-case invariants — line-prefix shape, BOM stripping, ETOOBIG fallback,
// and absence of pagination hints in head/tail output.
//
// Use this as the structural harness when changing read dispatch, head/tail
// implementations, or output truncation/cap logic.
//
// Usage:
//   node bench/read-probe.mjs                  # run all cases
//   node bench/read-probe.mjs <case-name>      # run one case

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const PLUGIN_DATA = join(homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin')

process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT
process.env.CLAUDE_PLUGIN_DATA = PLUGIN_DATA

const KEEP_TMP = process.env.READ_PROBE_KEEP_TMP === '1'
const VERBOSE = process.env.READ_PROBE_VERBOSE === '1'
const argFilter = process.argv[2] || null

const importLocal = (rel) => import(pathToFileURL(join(PLUGIN_ROOT, rel)).href)
const builtin = await importLocal('src/agent/orchestrator/tools/builtin.mjs')
  .catch(e => die(`import builtin.mjs failed: ${e.message}`))
const { executeBuiltinTool } = builtin

const tmpRoot = mkdtempSync(join(tmpdir(), 'read-probe-'))

function makeFile(name, content) {
  const p = join(tmpRoot, name)
  writeFileSync(p, content, 'utf-8')
  return p
}

const SHORT = makeFile('short.txt', Array.from({length: 10}, (_, i) => `line-${i+1}`).join('\n'))
const BOM = makeFile('bom.txt', '﻿alpha\nbeta\ngamma')
const EMPTY = makeFile('empty.txt', '')
const TRAILING_NL = makeFile('trailing.txt', 'a\nb\nc\n')

// > READ_MAX_SIZE_BYTES (256KB) to force the ETOOBIG path
const BIG_LINES = 8000
const big = Array.from({length: BIG_LINES}, (_, i) => `big-${i.toString().padStart(6, '0')}-${'x'.repeat(40)}`).join('\n')
const BIG = makeFile('big.txt', big)

const cases = [
  {
    name: 'head_normal',
    call: { tool: 'read', args: { path: SHORT, mode: 'head', n: 5 } },
    check: (out) => {
      if (/next offset/.test(out)) return 'pagination hint leaked'
      if (/more entries/.test(out)) return 'remaining-entries hint leaked'
      const lines = out.split('\n')
      if (lines.length !== 5) return `expected 5 lines, got ${lines.length}`
      if (!/^1\tline-1$/.test(lines[0])) return `bad line-1 prefix: ${lines[0]}`
      if (!/^5\tline-5$/.test(lines[4])) return `bad line-5 prefix: ${lines[4]}`
      return null
    },
  },
  {
    name: 'head_n_exceeds',
    call: { tool: 'read', args: { path: SHORT, mode: 'head', n: 50 } },
    check: (out) => {
      if (/next offset/.test(out)) return 'pagination hint leaked'
      const lines = out.split('\n')
      if (lines.length !== 10) return `expected 10 lines (file has 10), got ${lines.length}`
      return null
    },
  },
  {
    name: 'head_bom_stripped',
    call: { tool: 'read', args: { path: BOM, mode: 'head', n: 3 } },
    check: (out) => {
      if (out.charCodeAt(0) === 0xFEFF) return 'BOM not stripped'
      if (!/^1\talpha/.test(out)) return `bad line-1: ${JSON.stringify(out.split('\n')[0])}`
      return null
    },
  },
  {
    name: 'head_empty_file',
    call: { tool: 'read', args: { path: EMPTY, mode: 'head', n: 5 } },
    check: (out) => {
      if (/next offset/.test(out)) return 'pagination hint leaked on empty'
      if (out.length !== 0) return `expected empty output, got ${JSON.stringify(out)}`
      return null
    },
  },
  {
    name: 'head_trailing_newline',
    call: { tool: 'read', args: { path: TRAILING_NL, mode: 'head', n: 10 } },
    check: (out) => {
      const lines = out.split('\n').filter(l => l.length > 0)
      if (lines.length !== 3) return `trailing newline should not produce 4th line, got ${lines.length}`
      return null
    },
  },
  {
    name: 'head_etoobig_streamed',
    call: { tool: 'read', args: { path: BIG, mode: 'head', n: 5 } },
    check: (out) => {
      if (/next offset/.test(out)) return 'pagination hint leaked from ETOOBIG fallback'
      if (/range limit reached/.test(out)) return 'streamReadRange hint leaked'
      const lines = out.split('\n')
      if (lines.length !== 5) return `expected 5 streamed lines, got ${lines.length}`
      if (!/^1\tbig-000000/.test(lines[0])) return `bad streamed line-1: ${lines[0]}`
      return null
    },
  },
  {
    name: 'tail_normal',
    call: { tool: 'read', args: { path: SHORT, mode: 'tail', n: 3 } },
    check: (out) => {
      const lines = out.split('\n')
      if (lines.length !== 3) return `expected 3 lines, got ${lines.length}`
      if (!/^8\tline-8/.test(lines[0])) return `bad start line: ${lines[0]}`
      if (!/^10\tline-10/.test(lines[2])) return `bad last line: ${lines[2]}`
      return null
    },
  },
  {
    name: 'count_mode',
    call: { tool: 'read', args: { path: SHORT, mode: 'count' } },
    check: (out) => {
      if (!/^lines\t10\twords\t10\tbytes\t/.test(out)) return `unexpected wc output: ${out}`
      return null
    },
  },
  {
    name: 'full_with_range',
    call: { tool: 'read', args: { path: SHORT, offset: 2, limit: 3 } },
    // Range form should still emit a pagination hint — head dispatch
    // bypasses this branch so its absence is the head-only contract.
    check: (out) => {
      if (!/next offset/.test(out)) return 'expected pagination hint on explicit range'
      const lines = out.split('\n').filter(l => /^\d+\tline-/.test(l))
      if (lines.length !== 3) return `expected 3 line-prefixed rows, got ${lines.length}`
      return null
    },
  },
  {
    name: 'multi_read_array',
    call: { tool: 'read', args: { path: [SHORT, BOM] } },
    check: (out) => {
      if (!/multi_read complete/.test(out)) return 'missing multi_read header'
      if (!/short\.txt/.test(out)) return 'short.txt missing from result'
      if (!/bom\.txt/.test(out)) return 'bom.txt missing from result'
      return null
    },
  },
]

const filtered = argFilter ? cases.filter(c => c.name === argFilter) : cases
if (filtered.length === 0) die(`no case matched "${argFilter}"`)

let pass = 0
let fail = 0
const failures = []

for (const c of filtered) {
  let out
  try {
    out = await executeBuiltinTool(c.call.tool, c.call.args, tmpRoot)
  } catch (err) {
    fail++
    failures.push({ name: c.name, reason: `threw: ${err.message}` })
    console.log(`FAIL ${c.name} — threw: ${err.message}`)
    continue
  }
  if (VERBOSE) console.log(`--- ${c.name} ---\n${out}\n---`)
  const reason = c.check(out)
  if (reason) {
    fail++
    failures.push({ name: c.name, reason, out })
    console.log(`FAIL ${c.name} — ${reason}`)
    if (!VERBOSE) console.log(`  out: ${JSON.stringify(out.slice(0, 200))}`)
  } else {
    pass++
    console.log(`PASS ${c.name}`)
  }
}

console.log(`\n${pass}/${pass + fail} passed`)

if (!KEEP_TMP) rmSync(tmpRoot, { recursive: true, force: true })
else console.log(`tmp kept: ${tmpRoot}`)

process.exit(fail === 0 ? 0 : 1)

function die(msg) { console.error(msg); process.exit(2) }
