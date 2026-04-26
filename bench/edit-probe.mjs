#!/usr/bin/env node
// bench/edit-probe.mjs — edit tool array-form benchmark.
//
// Validates the unified edit dispatcher: single form, array form on one
// file (sequential apply), array form across files (per-file batch),
// per-edit path override, and uniqueness/replace_all semantics. The probe
// is the structural answer to the multi_edit/batch_edit hallucination —
// these features are all reachable through the single `edit` tool.
//
// Usage:
//   node bench/edit-probe.mjs                  # all cases
//   node bench/edit-probe.mjs <case-name>      # one case

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const PLUGIN_DATA = join(homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin')

process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT
process.env.CLAUDE_PLUGIN_DATA = PLUGIN_DATA

const KEEP_TMP = process.env.EDIT_PROBE_KEEP_TMP === '1'
const VERBOSE = process.env.EDIT_PROBE_VERBOSE === '1'
const argFilter = process.argv[2] || null

const importLocal = (rel) => import(pathToFileURL(join(PLUGIN_ROOT, rel)).href)
const builtin = await importLocal('src/agent/orchestrator/tools/builtin.mjs')
  .catch(e => die(`import builtin.mjs failed: ${e.message}`))
const { executeBuiltinTool } = builtin

const tmpRoot = mkdtempSync(join(tmpdir(), 'edit-probe-'))

function makeFile(name, content) {
  const p = join(tmpRoot, name)
  writeFileSync(p, content, 'utf-8')
  return p
}

// Edit honours a read-snapshot guard — register the file with a one-shot
// read so the array-form assertions exercise the actual replace path
// rather than the first-touch snapshot rejection.
async function prime(path) {
  await executeBuiltinTool('read', { path }, tmpRoot)
}

function readBack(p) { return readFileSync(p, 'utf-8') }

const cases = [
  {
    name: 'single_form',
    setup: () => makeFile('single.txt', 'hello world'),
    run: async (path) => executeBuiltinTool('edit', {
      path, old_string: 'world', new_string: 'mixdog',
    }, tmpRoot),
    check: (out, path) => {
      if (/Error/i.test(out)) return `unexpected error: ${out}`
      if (readBack(path) !== 'hello mixdog') return `bad content: ${readBack(path)}`
      return null
    },
  },
  {
    name: 'array_form_same_file_sequential',
    setup: () => makeFile('seq.txt', 'A B C'),
    run: async (path) => executeBuiltinTool('edit', {
      path,
      edits: [
        { old_string: 'A', new_string: 'X' },
        { old_string: 'B', new_string: 'Y' },
        { old_string: 'C', new_string: 'Z' },
      ],
    }, tmpRoot),
    check: (out, path) => {
      if (/Error/i.test(out)) return `unexpected error: ${out}`
      if (readBack(path) !== 'X Y Z') return `bad content: ${readBack(path)}`
      return null
    },
  },
  {
    name: 'array_form_chained_replace',
    // First edit's replacement becomes the second edit's match — only
    // works if the array applies sequentially against the same file.
    setup: () => makeFile('chain.txt', 'one'),
    run: async (path) => executeBuiltinTool('edit', {
      path,
      edits: [
        { old_string: 'one', new_string: 'two' },
        { old_string: 'two', new_string: 'three' },
      ],
    }, tmpRoot),
    check: (out, path) => {
      if (/Error/i.test(out)) return `unexpected error: ${out}`
      if (readBack(path) !== 'three') return `chained sequential failed: ${readBack(path)}`
      return null
    },
  },
  {
    name: 'array_form_cross_file',
    setup: () => ({
      a: makeFile('xa.txt', 'apple'),
      b: makeFile('xb.txt', 'banana'),
      c: makeFile('xc.txt', 'cherry'),
    }),
    run: async (paths) => executeBuiltinTool('edit', {
      edits: [
        { path: paths.a, old_string: 'apple', new_string: 'AVOCADO' },
        { path: paths.b, old_string: 'banana', new_string: 'BLUEBERRY' },
        { path: paths.c, old_string: 'cherry', new_string: 'COCONUT' },
      ],
    }, tmpRoot),
    check: (out, paths) => {
      if (/Error/i.test(out)) return `unexpected error: ${out}`
      if (readBack(paths.a) !== 'AVOCADO') return `xa: ${readBack(paths.a)}`
      if (readBack(paths.b) !== 'BLUEBERRY') return `xb: ${readBack(paths.b)}`
      if (readBack(paths.c) !== 'COCONUT') return `xc: ${readBack(paths.c)}`
      return null
    },
  },
  {
    name: 'per_edit_path_override',
    setup: () => ({
      base: makeFile('base.txt', 'BASE-content'),
      other: makeFile('other.txt', 'OTHER-content'),
    }),
    run: async (paths) => executeBuiltinTool('edit', {
      path: paths.base,
      edits: [
        { old_string: 'BASE', new_string: 'edited' },
        { path: paths.other, old_string: 'OTHER', new_string: 'overridden' },
      ],
    }, tmpRoot),
    check: (out, paths) => {
      if (/Error/i.test(out)) return `unexpected error: ${out}`
      if (readBack(paths.base) !== 'edited-content') return `base: ${readBack(paths.base)}`
      if (readBack(paths.other) !== 'overridden-content') return `other: ${readBack(paths.other)}`
      return null
    },
  },
  {
    name: 'uniqueness_violation_rejected',
    setup: () => makeFile('dup.txt', 'aa aa aa'),
    run: async (path) => executeBuiltinTool('edit', {
      path, old_string: 'aa', new_string: 'bb',
    }, tmpRoot),
    check: (out, path) => {
      if (!/Error|multiple|matches|occurrenc/i.test(out)) return `expected uniqueness error, got: ${out}`
      if (readBack(path) !== 'aa aa aa') return `file mutated despite uniqueness rejection: ${readBack(path)}`
      return null
    },
  },
  {
    name: 'replace_all_semantics',
    setup: () => makeFile('rall.txt', 'aa aa aa'),
    run: async (path) => executeBuiltinTool('edit', {
      path, old_string: 'aa', new_string: 'bb', replace_all: true,
    }, tmpRoot),
    check: (out, path) => {
      if (/Error/i.test(out)) return `unexpected error: ${out}`
      if (readBack(path) !== 'bb bb bb') return `replace_all failed: ${readBack(path)}`
      return null
    },
  },
]

const filtered = argFilter ? cases.filter(c => c.name === argFilter) : cases
if (filtered.length === 0) die(`no case matched "${argFilter}"`)

let pass = 0
let fail = 0

for (const c of filtered) {
  const target = c.setup()
  if (typeof target === 'string') await prime(target)
  else for (const p of Object.values(target)) await prime(p)
  let out
  try {
    out = await c.run(target)
  } catch (err) {
    fail++
    console.log(`FAIL ${c.name} — threw: ${err.message}`)
    continue
  }
  if (VERBOSE) console.log(`--- ${c.name} ---\n${out}\n---`)
  const reason = c.check(out, target)
  if (reason) {
    fail++
    console.log(`FAIL ${c.name} — ${reason}`)
    if (!VERBOSE) console.log(`  out: ${JSON.stringify(String(out).slice(0, 200))}`)
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
