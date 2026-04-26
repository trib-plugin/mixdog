#!/usr/bin/env node
// bench/bridge-probe.mjs — bridge dispatch probe.
//
// Calls the bridge tool with a role + prompt via stdio MCP, waits for the
// background worker to finish, then reads bridge-trace.jsonl to extract
// per-session metrics for that dispatch.
//
// Usage:
//   node bench/bridge-probe.mjs <role> "<prompt>"
//
// Phase-1 minimal version: one task, prints session metrics. Phase 2 will
// add fixture-driven sweep + sandbox isolation for write-capable roles.

import { existsSync, createReadStream } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const PLUGIN_DATA = join(homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin')
const TRACE_PATH = join(PLUGIN_DATA, 'history', 'bridge-trace.jsonl')

process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT
process.env.CLAUDE_PLUGIN_DATA = PLUGIN_DATA

const importLocal = (rel) => import(pathToFileURL(join(PLUGIN_ROOT, rel)).href)
const mcp = await importLocal('src/agent/orchestrator/mcp/client.mjs')
const { connectMcpServers, executeMcpTool, disconnectAll } = mcp

await connectMcpServers({
  mixdog: {
    command: 'node',
    args: [join(PLUGIN_ROOT, 'scripts', 'run-mcp.mjs')],
    cwd: PLUGIN_ROOT,
  },
})

const role = process.argv[2] || 'worker'
const prompt = process.argv[3] ||
  'List the .mjs files under src/agent/orchestrator and briefly describe each.'

console.log(`[bridge-probe] role=${role}`)
console.log(`[bridge-probe] prompt="${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`)
const t0 = Date.now()

let dispatchOut
try {
  dispatchOut = await executeMcpTool('mcp__mixdog__bridge', { role, prompt })
} catch (e) {
  console.error(`[bridge-probe] bridge dispatch failed: ${e.message}`)
  await disconnectAll()
  process.exit(1)
}

const dispatchText = extractText(dispatchOut)
console.log(`\n[bridge-probe] dispatch response (${Date.now() - t0}ms):`)
console.log(dispatchText.slice(0, 600))

const sessionId = extractField(dispatchText, /sessionId["\s:]+["']?(sess_[\w_-]+)/i) ||
                  extractField(dispatchText, /(sess_[\w_-]+)/)
const jobId = extractField(dispatchText, /jobId["\s:]+["']?(job_[\w_-]+)/i) ||
              extractField(dispatchText, /(job_[\w_-]+)/)

console.log(`\n[bridge-probe] sessionId=${sessionId || '?'} jobId=${jobId || '?'}`)

if (jobId) {
  console.log(`[bridge-probe] waiting for job to finish (max 180s)...`)
  try {
    const waitOut = await executeMcpTool('mcp__mixdog__job_wait', { jobId, timeoutMs: 180000 })
    const waitText = extractText(waitOut)
    console.log(`[bridge-probe] job_wait (${Date.now() - t0}ms):`)
    console.log(waitText.slice(0, 600))
  } catch (e) {
    console.error(`[bridge-probe] job_wait failed: ${e.message}`)
  }
}

const dt = Date.now() - t0
const metrics = sessionId ? await analyzeSession(sessionId) : { error: 'no sessionId extracted' }
console.log(`\n══ metrics ══`)
console.log(`  duration : ${dt}ms`)
console.log(`  session  : ${sessionId || '?'}`)
console.log(JSON.stringify(metrics, null, 2))

await disconnectAll()
process.exit(0)

function extractText(out) {
  if (!out) return ''
  if (typeof out === 'string') return out
  const arr = out.content
  if (!Array.isArray(arr)) return JSON.stringify(out)
  return arr.filter(p => p && p.type === 'text').map(p => p.text).join('\n')
}

function extractField(s, re) {
  const m = re.exec(s || '')
  return m ? (m[1] || m[0]) : null
}

async function analyzeSession(sessionId) {
  if (!existsSync(TRACE_PATH)) return { error: 'no trace file' }
  const tools = []
  let iters = 0, traceRole = null, tokensIn = 0, tokensOut = 0, lines = 0
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
  let alt = 0, last = null
  for (const t of tools) {
    if ((t === 'read' || t === 'grep') && last && last !== t && (last === 'read' || last === 'grep')) alt++
    last = t
  }
  const histogram = tools.reduce((m, t) => (m[t] = (m[t] || 0) + 1, m), {})
  const total = tools.length
  const structure = tools.filter(t => /^(find_symbol|find_imports|find_dependents|find_callers|find_references|code_graph)$/.test(t)).length
  const fileLookup = tools.filter(t => /^(read|grep|glob|list|multi_read)$/.test(t)).length
  return {
    role: traceRole,
    iters,
    tokensIn,
    tokensOut,
    toolCalls: total,
    structurePct: total ? +(structure / total * 100).toFixed(1) : 0,
    fileLookupPct: total ? +(fileLookup / total * 100).toFixed(1) : 0,
    altCount: alt,
    histogram,
    traceLines: lines,
  }
}
