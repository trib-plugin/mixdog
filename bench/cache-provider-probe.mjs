#!/usr/bin/env bun
// bench/cache-provider-probe.mjs
//
// Provider-wide cache behaviour probe. Iterates every preset registered in
// agent-config.json (or a passed list), invoking each with a temporary
// role envelope (`role:'reviewer'` + `preset:<name>` override), so we never
// have to mutate user-workflow.json to test providers that have no live
// role assignment (gemini / deepseek / xai / openai-direct).
//
// Per preset:
//   cold call  → register prefix
//   short pause
//   hot call   → measure prefix re-hit
// Each call carries a 5-step sequential read prompt so iter≥2 rows surface.
//
// Usage:
//   node bench/cache-provider-probe.mjs                        # all presets
//   node bench/cache-provider-probe.mjs "OPUS MID,GEMINI 3 FLASH"
//
// Output:
//   bench/results/cache-provider-<ISO>.json  (machine-readable)
//   bench/results/cache-provider-<ISO>.log   (mirrored stdout)

import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, readSync, closeSync, statSync, appendFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const PLUGIN_DATA = join(homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin')
const BRIDGE_TRACE_PATH = join(PLUGIN_DATA, 'history', 'bridge-trace.jsonl')
const RESULTS_DIR = join(PLUGIN_ROOT, 'bench', 'results')
mkdirSync(RESULTS_DIR, { recursive: true })

process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT
process.env.CLAUDE_PLUGIN_DATA = PLUGIN_DATA

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const RESULT_JSON = join(RESULTS_DIR, `cache-provider-${stamp}.json`)
const OUTPUT_LOG  = join(RESULTS_DIR, `cache-provider-${stamp}.log`)
try { writeFileSync(OUTPUT_LOG, '') } catch {}
const _log = console.log.bind(console)
const _err = console.error.bind(console)
function tee(prefix, args) {
  const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
  try { appendFileSync(OUTPUT_LOG, prefix + line + '\n') } catch {}
}
console.log = (...a) => { tee('', a); _log(...a) }
console.error = (...a) => { tee('[err] ', a); _err(...a) }

const importLocal = (rel) => import(pathToFileURL(join(PLUGIN_ROOT, rel)).href)
const agentMod = await importLocal('src/agent/index.mjs')
if (typeof agentMod.init === 'function') {
  await agentMod.init({ notification: () => {}, elicitInput: async () => ({}) })
}
const { makeBridgeLlm } = await importLocal('src/agent/orchestrator/smart-bridge/bridge-llm.mjs')

const cfg = JSON.parse(readFileSync(join(PLUGIN_DATA, 'agent-config.json'), 'utf8'))
const allPresets = (cfg.presets || []).map(p => ({ name: p.name, provider: p.provider, model: p.model }))

const filterArg = process.argv[2]
const wanted = filterArg
  ? new Set(filterArg.split(',').map(s => s.trim()).filter(Boolean))
  : null
const PRESETS = wanted ? allPresets.filter(p => wanted.has(p.name)) : allPresets

console.log(`[cache-provider] presets to test: ${PRESETS.length}`)
for (const p of PRESETS) console.log(`  - ${p.name} | ${p.provider} | ${p.model}`)

const PROMPT = `Use read tool exactly 5 times in series. RULES:
- ONE tool call per response. NEVER batch.
- After each tool_result, immediately issue the next read.
- Reply 'done' ONLY after the 5th result.
1. read package.json mode='count'
2. read README.md mode='count'
3. read .gitignore mode='count'
4. read CHANGELOG.md mode='count'
5. read tools.json mode='count'`

function traceCursorNow() {
  if (!existsSync(BRIDGE_TRACE_PATH)) return 0
  return statSync(BRIDGE_TRACE_PATH).size
}
function readTraceTail(fromBytes) {
  if (!existsSync(BRIDGE_TRACE_PATH)) return []
  const fd = openSync(BRIDGE_TRACE_PATH, 'r')
  const sz = statSync(BRIDGE_TRACE_PATH).size
  const len = sz - fromBytes
  if (len <= 0) { closeSync(fd); return [] }
  const buf = Buffer.alloc(len)
  readSync(fd, buf, 0, len, fromBytes)
  closeSync(fd)
  return buf.toString('utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function runOne(preset, label, attempt = 1) {
  const cursorBefore = traceCursorNow()
  // role envelope is a fixed user-workflow role so message shape is valid.
  // preset override forces the actual provider/model regardless of the role.
  const llm = makeBridgeLlm({ role: 'reviewer', preset: preset.name, taskType: 'cache-provider-probe' })
  const t = Date.now()
  let raw = ''
  let err = null
  try { raw = await llm({ prompt: PROMPT, timeout: 240000 }) } catch (e) { err = e.message }
  const dt = Date.now() - t
  await sleep(1800)
  // Self-resolve sessionId from this call's trace tail (parallel-safe).
  const tail = readTraceTail(cursorBefore)
  const myAssigns = tail.filter(r => r.kind === 'preset_assign' && r.preset_name === preset.name)
                       .sort((a,b)=>a.ts.localeCompare(b.ts))
  let sessionId = null
  for (const pa of myAssigns) {
    if (tail.some(r => r.kind==='usage_raw' && r.sessionId === pa.sessionId)) { sessionId = pa.sessionId; break }
  }
  const usage = sessionId ? tail.filter(r => r.kind==='usage_raw' && r.sessionId === sessionId)
                                 .sort((a,b)=>a.ts.localeCompare(b.ts)) : []
  // One transient retry for parallel-burst fetch hiccups (e.g. Gemini SDK).
  // Run retry strictly sequentially (await sleep first) to dodge SDK socket
  // contention that the burst itself caused.
  if (err && attempt < 2 && /fetch|ECONNRESET|GoogleGenerativeAI/i.test(err)) {
    await sleep(3000 + Math.random()*2000)
    return runOne(preset, label + '-retry', attempt + 1)
  }
  return { label, dt, err, response: String(raw).slice(0,60), sessionId, usage }
}

// gemini SDK collapses under parallel fetch burst (observed: 11-way
// Promise.all both cold AND retry fail, isolated call OK). Run gemini
// presets sequentially after the parallel batch instead of inside it.
const PARALLEL_PRESETS  = PRESETS.filter(p => p.provider !== 'gemini')
const SEQUENTIAL_PRESETS = PRESETS.filter(p => p.provider === 'gemini')

async function runPair(preset) {
  console.log(`[cache-provider] start ${preset.name} (${preset.provider})`)
  let cold, hot
  try { cold = await runOne(preset, 'cold') } catch (e) { cold = { err: e.message } }
  console.log(`[cache-provider] ${preset.name} cold: ${cold.err ? 'ERR '+cold.err.slice(0,60) : 'OK'} iters=${cold.usage?.length||0} sess=${(cold.sessionId||'').slice(0,18)} ${cold.dt||0}ms`)
  await sleep(2500)
  try { hot = await runOne(preset, 'hot') } catch (e) { hot = { err: e.message } }
  console.log(`[cache-provider] ${preset.name} hot : ${hot.err ? 'ERR '+hot.err.slice(0,60) : 'OK'} iters=${hot.usage?.length||0} sess=${(hot.sessionId||'').slice(0,18)} ${hot.dt||0}ms`)
  return { preset: preset.name, provider: preset.provider, model: preset.model, cold, hot }
}

const parallelResults = await Promise.all(PARALLEL_PRESETS.map(runPair))
const sequentialResults = []
for (const p of SEQUENTIAL_PRESETS) {
  sequentialResults.push(await runPair(p))
  await sleep(1000)
}
const results = [...parallelResults, ...sequentialResults]

// Per-call sessionId already resolved inside runOne(), so each cold/hot
// has its own usage[] populated. Hit% = (cached_tokens + cache_write_tokens)
// / prompt_tokens — both read and write count toward cache utilization.
// bridge-trace.mjs:357-368 makes prompt_tokens the provider-normalized
// total (Anthropic: input + cache_read + cache_write, OpenAI/Gemini:
// input_tokens with cached as subset; cache_write_tokens is 0 for
// providers without explicit write tokens).
function summary(usage) {
  if (!usage?.length) return { iters: 0, sumI: 0, sumC: 0, sumHit: '-' }
  const sumI = usage.reduce((a,u)=>a+(u.prompt_tokens||u.input_tokens||0),0)
  const sumC = usage.reduce((a,u)=>a+(u.cached_tokens||0)+(u.cache_write_tokens||0),0)
  const sumHit = sumI ? (sumC/sumI*100).toFixed(1)+'%' : '-'
  return { iters: usage.length, sumI, sumC, sumHit }
}

console.log('\n========== summary (per-session matched) ==========')
console.log('| preset | provider | cold iters | cold sum-hit | hot iters | hot sum-hit | err |')
console.log('|---|---|---|---|---|---|---|')
for (const r of results) {
  const c = summary(r.cold.usage)
  const h = summary(r.hot.usage)
  const errFlag = (r.cold.err || r.hot.err) ? `Y (${(r.cold.err||r.hot.err).slice(0,40)})` : ''
  console.log(`| ${r.preset} | ${r.provider} | ${c.iters} | ${c.sumHit} | ${h.iters} | ${h.sumHit} | ${errFlag} |`)
}

writeFileSync(RESULT_JSON, JSON.stringify({ ts: new Date().toISOString(), presets: PRESETS, results }, null, 2))
console.log(`\n[cache-provider] result: ${RESULT_JSON}`)
console.log(`[cache-provider] log   : ${OUTPUT_LOG}`)
