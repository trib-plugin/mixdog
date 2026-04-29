#!/usr/bin/env bun
// bench/search-probe.mjs — grep / glob / list array-form benchmark.
//
// Validates the OR-join semantics on grep `pattern`/`glob`, glob `pattern`,
// and list `mode` dispatch (list/tree/find). Array forms are the iter-saver
// equivalents documented in the tool descriptions; this probe is the
// regression net for that contract.
//
// Usage:
//   node bench/search-probe.mjs                  # all cases
//   node bench/search-probe.mjs <case-name>      # one case

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const PLUGIN_DATA = join(homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin')

process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT
process.env.CLAUDE_PLUGIN_DATA = PLUGIN_DATA

const KEEP_TMP = process.env.SEARCH_PROBE_KEEP_TMP === '1'
const VERBOSE = process.env.SEARCH_PROBE_VERBOSE === '1'
const argFilter = process.argv[2] || null

const importLocal = (rel) => import(pathToFileURL(join(PLUGIN_ROOT, rel)).href)
const builtin = await importLocal('src/agent/orchestrator/tools/builtin.mjs')
  .catch(e => die(`import builtin.mjs failed: ${e.message}`))
const { executeBuiltinTool } = builtin

const tmpRoot = mkdtempSync(join(tmpdir(), 'search-probe-'))

function makeFile(rel, content) {
  const p = join(tmpRoot, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf-8')
  return p
}

makeFile('src/route.mjs', 'export const path = "/foo"\n// route handler\n')
makeFile('src/policy.json', '{"name":"alpha","mode":"strict"}')
makeFile('src/handler.mjs', 'function handle() { return 1 }\n')
makeFile('lib/util.mjs', 'export const ID = 7\n// ALPHA marker\n')
makeFile('docs/readme.md', '# Title\nALPHA in body\n')

const cases = [
  {
    name: 'grep_array_pattern_or',
    run: () => executeBuiltinTool('grep', {
      pattern: ['ALPHA', 'route handler'],
      output_mode: 'content',
    }, tmpRoot),
    check: (out) => {
      if (!/ALPHA/.test(out)) return 'missing ALPHA hit'
      if (!/route handler/.test(out)) return 'missing route handler hit'
      return null
    },
  },
  {
    name: 'grep_array_glob_or',
    run: () => executeBuiltinTool('grep', {
      pattern: 'export',
      glob: ['**/*.mjs', '**/*.md'],
      output_mode: 'files_with_matches',
    }, tmpRoot),
    check: (out) => {
      if (!/route\.mjs/.test(out)) return 'missing route.mjs match'
      if (!/util\.mjs/.test(out)) return 'missing util.mjs match'
      if (/policy\.json/.test(out)) return 'json file leaked into mjs/md glob'
      return null
    },
  },
  {
    name: 'glob_array_pattern_or',
    run: () => executeBuiltinTool('glob', {
      pattern: ['**/*route*.mjs', '**/*policy*.json'],
    }, tmpRoot),
    check: (out) => {
      if (!/route\.mjs/.test(out)) return 'missing route.mjs'
      if (!/policy\.json/.test(out)) return 'missing policy.json'
      if (/handler\.mjs|util\.mjs|readme\.md/.test(out)) return `unexpected match leaked: ${out}`
      return null
    },
  },
  {
    name: 'list_default',
    run: () => executeBuiltinTool('list', { path: 'src' }, tmpRoot),
    check: (out) => {
      if (!/route\.mjs/.test(out)) return 'missing route.mjs'
      if (!/handler\.mjs/.test(out)) return 'missing handler.mjs'
      if (!/policy\.json/.test(out)) return 'missing policy.json'
      return null
    },
  },
  {
    name: 'list_mode_tree',
    run: () => executeBuiltinTool('list', { path: '.', mode: 'tree' }, tmpRoot),
    check: (out) => {
      if (!/src/.test(out)) return 'tree missing src'
      if (!/lib/.test(out)) return 'tree missing lib'
      if (!/docs/.test(out)) return 'tree missing docs'
      return null
    },
  },
  {
    name: 'list_mode_find',
    run: () => executeBuiltinTool('list', { path: '.', mode: 'find', name: '*.mjs' }, tmpRoot),
    check: (out) => {
      if (!/route\.mjs/.test(out)) return 'find missing route.mjs'
      if (!/util\.mjs/.test(out)) return 'find missing util.mjs'
      if (/policy\.json|readme\.md/.test(out)) return `find leaked non-mjs: ${out}`
      return null
    },
  },
]

const filtered = argFilter ? cases.filter(c => c.name === argFilter) : cases
if (filtered.length === 0) die(`no case matched "${argFilter}"`)

let pass = 0
let fail = 0

for (const c of filtered) {
  let out
  try {
    out = await c.run()
  } catch (err) {
    fail++
    console.log(`FAIL ${c.name} — threw: ${err.message}`)
    continue
  }
  if (VERBOSE) console.log(`--- ${c.name} ---\n${out}\n---`)
  const reason = c.check(String(out))
  if (reason) {
    fail++
    console.log(`FAIL ${c.name} — ${reason}`)
    if (!VERBOSE) console.log(`  out: ${JSON.stringify(String(out).slice(0, 300))}`)
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
