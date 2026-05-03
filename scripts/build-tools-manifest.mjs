#!/usr/bin/env bun
/**
 * Build tools.json — the static tool manifest consumed by server.mjs.
 *
 * Collects TOOL_DEFS from every participating module and tags each tool
 * with its originating module so that server.mjs can route CallTool
 * requests without a runtime handler discovery pass.
 *
 * Modules now include the orchestrator-side builtin file tools and the
 * common code-graph tools — previously hand-merged into tools.json.
 * Every tool is single-source-of-truth in code; this script only
 * filters and stitches.
 *
 * Filtering: entries flagged `public: false` are reachable through the
 * in-process dispatcher (Pool C executors, synthetic tool registrations,
 * module handleToolCall) but excluded from tools.json so external LLMs
 * never see them advertised. The `public` flag itself is stripped from
 * the output to keep the manifest clean.
 *
 * Usage:  node scripts/build-tools-manifest.mjs
 * Output: <plugin-root>/tools.json
 */

import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(__dirname, '..')
const OUTPUT = join(PLUGIN_ROOT, 'tools.json')

globalThis.__tribFastEntry = true
process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT
let _tempDataDir = null
if (!process.env.CLAUDE_PLUGIN_DATA) {
  // Module imports below (channels / memory / search / agent) touch DATA_DIR
  // during init (boot.log, caches, sqlite warm-up). Route those writes to a
  // throwaway OS temp dir so the manifest build never pollutes the plugin
  // source tree with a shadow `.data/` next to the real one under
  // ~/.claude/plugins/data/<plugin>-<marketplace>.
  _tempDataDir = mkdtempSync(join(tmpdir(), 'mixdog-tools-'))
  process.env.CLAUDE_PLUGIN_DATA = _tempDataDir
}

// `key` names the export each module uses for its tool list. Most modules
// standardised on TOOL_DEFS; the two orchestrator-internal files predate
// that convention and keep their domain-specific names.
const MODULES = [
  { name: 'channels',   path: 'src/channels/index.mjs',                       key: 'TOOL_DEFS' },
  { name: 'memory',     path: 'src/memory/index.mjs',                         key: 'TOOL_DEFS' },
  { name: 'search',     path: 'src/search/index.mjs',                         key: 'TOOL_DEFS' },
  { name: 'agent',      path: 'src/agent/index.mjs',                          key: 'TOOL_DEFS' },
  { name: 'builtin',    path: 'src/agent/orchestrator/tools/builtin.mjs',     key: 'BUILTIN_TOOLS' },
  { name: 'code_graph', path: 'src/agent/orchestrator/tools/code-graph.mjs',  key: 'CODE_GRAPH_TOOL_DEFS' },
  { name: 'patch',      path: 'src/agent/orchestrator/tools/patch.mjs',       key: 'PATCH_TOOL_DEFS' },
  { name: 'host_input', path: 'src/agent/orchestrator/tools/host-input.mjs',  key: 'HOST_INPUT_TOOL_DEFS' },
]

const t0 = Date.now()
const collected = []

for (const { name, path, key } of MODULES) {
  const url = pathToFileURL(join(PLUGIN_ROOT, path)).href
  const mod = await import(url)
  const defs = Array.isArray(mod[key]) ? mod[key] : []
  let kept = 0
  let hidden = 0
  for (const def of defs) {
    if (def?.public === false) { hidden++; continue }
    const { public: _pub, ...rest } = def
    collected.push({ ...rest, module: name })
    kept++
  }
  const note = hidden ? ` (+${hidden} hidden)` : ''
  console.error(`[build-tools] ${name.padEnd(8)}: ${String(kept).padStart(3)} tools${note}`)
}

// Deduplicate by name (later modules override earlier if collision)
const seen = new Set()
const unique = []
for (let i = collected.length - 1; i >= 0; i--) {
  const t = collected[i]
  if (seen.has(t.name)) continue
  seen.add(t.name)
  unique.unshift(t)
}

// Validate
for (const tool of unique) {
  if (!tool.name) throw new Error(`Tool missing name: ${JSON.stringify(tool).slice(0, 120)}`)
  if (!tool.description) throw new Error(`${tool.name}: missing description`)
  if (!tool.inputSchema) throw new Error(`${tool.name}: missing inputSchema`)
  if (!tool.module) throw new Error(`${tool.name}: missing module`)
}

writeFileSync(OUTPUT, JSON.stringify(unique, null, 2) + '\n')
console.error(`[build-tools] wrote ${unique.length} tools → ${OUTPUT}`)
console.error(`[build-tools] done in ${Date.now() - t0} ms`)
if (_tempDataDir) {
  try { rmSync(_tempDataDir, { recursive: true, force: true }) } catch {}
}
process.exit(0)
