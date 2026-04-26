#!/usr/bin/env node
// bench/probe.mjs — in-process probe for recall / search / explore.
//
// Bypasses the MCP stdio transport: connects directly to the running
// mixdog-memory worker over its autoDetect HTTP port and calls
// dispatchAiWrapped() against the live source tree. Each invocation
// re-imports nothing — restart this script when you want a clean module
// graph; otherwise edits to ai-wrapped-dispatch.mjs land on the next
// `node bench/probe.mjs ...` call (no host restart needed).
//
// Usage:
//   node bench/probe.mjs <recall|search|explore> "<query>"
//   node bench/probe.mjs run                          # all queries (concurrency=5)
//   node bench/probe.mjs run recall                   # one tool
//   node bench/probe.mjs run --concurrency=8          # tweak pool
//   node bench/probe.mjs run recall --concurrency=3   # both
//   node bench/probe.mjs sweep concurrency 1 3 5 8
//   node bench/probe.mjs sweep prompt_variant baseline terse
//   node bench/probe.mjs sweep model claude-sonnet-4-5 claude-haiku-4-5
//   node bench/probe.mjs sweep iter_cap 4 8 12
//
// Env:
//   PROBE_KEEP_CACHE=1     keep ai-wrapped query cache between calls
//   PROBE_VERBOSE=1        dump full body instead of head-400
//   PROBE_CONCURRENCY=N    default pool size for `run` (overridden by --concurrency)

import { readFileSync, existsSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const PLUGIN_DATA = join(homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin');
const RESULTS_DIR = join(HERE, 'results');
const VARIANTS_DIR = join(HERE, 'prompt-variants');

// Set BEFORE any plugin module imports — agent.init() and friends read
// these from process.env at import-time.
process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT;
process.env.CLAUDE_PLUGIN_DATA = PLUGIN_DATA;

const TOOLS_JSON = join(PLUGIN_ROOT, 'tools.json');
if (!existsSync(TOOLS_JSON)) die(`tools.json not found at ${TOOLS_JSON}`);
const RAW_TOOL_DEFS = JSON.parse(readFileSync(TOOLS_JSON, 'utf8'));
const TOOL_DEFS = RAW_TOOL_DEFS.filter(t => t && t.name && t.module);
const TOOL_BY_NAME = Object.fromEntries(TOOL_DEFS.map(t => [t.name, t]));

const VALID_TOOLS = new Set(['recall', 'search', 'explore']);
const TIMEOUT_MS = 120_000;

// ── argv parsing (flag may sit before or after the subcommand) ──────
const rawArgv = process.argv.slice(2);
if (rawArgv.length === 0) usage();

const flags = {};
const positional = [];
for (const arg of rawArgv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
  else positional.push(arg);
}

const cmd = positional[0];
let mode = null;            // 'one' | 'run' | 'sweep'
let oneTool = null;
let oneQuery = null;
let runFilter = null;
let sweepParam = null;
let sweepValues = [];

if (cmd === 'run') {
  mode = 'run';
  if (positional[1]) {
    if (!VALID_TOOLS.has(positional[1])) die(`unknown tool filter: ${positional[1]}`);
    runFilter = positional[1];
  }
} else if (cmd === 'sweep') {
  mode = 'sweep';
  sweepParam = positional[1];
  sweepValues = positional.slice(2);
  const SWEEP_PARAMS = new Set(['model', 'concurrency', 'prompt_variant', 'iter_cap']);
  if (!sweepParam || !SWEEP_PARAMS.has(sweepParam)) {
    die(`sweep <param> must be one of: ${[...SWEEP_PARAMS].join(', ')}`);
  }
  if (sweepValues.length === 0) die(`sweep ${sweepParam} requires at least one value`);
} else if (VALID_TOOLS.has(cmd)) {
  mode = 'one';
  oneTool = cmd;
  oneQuery = positional.slice(1).join(' ').trim();
  if (!oneQuery) die(`missing query for ${cmd}`);
} else {
  usage();
}

const DEFAULT_CONCURRENCY = clampInt(flags.concurrency ?? process.env.PROBE_CONCURRENCY ?? 5, 1, 32);

// ── disk cache wipe — ONCE at start ─────────────────────────────────
// Parallel runs would race on this delete, so we do it here (single
// call, before any worker imports the cache). The per-query in-memory
// cache reset that the old serial runner used is gone; the disk wipe +
// fresh process is enough for benchmarking.
const DISK_CACHE = join(PLUGIN_DATA, 'aiwrapped-query-cache.json');
if (process.env.PROBE_KEEP_CACHE !== '1' && existsSync(DISK_CACHE)) {
  try { unlinkSync(DISK_CACHE); console.error(`[probe] removed disk cache ${DISK_CACHE}`); }
  catch (e) { console.error(`[probe] WARN could not remove disk cache: ${e.message}`); }
}

// ── live module imports ─────────────────────────────────────────────
const importLocal = (rel) => import(pathToFileURL(join(PLUGIN_ROOT, rel)).href);

const mcpClient = await importLocal('src/agent/orchestrator/mcp/client.mjs').catch(e => die(`import mcp/client.mjs failed: ${e.message}`));
const { connectMcpServers, executeMcpTool, disconnectAll } = mcpClient;

try {
  await connectMcpServers({ 'mixdog-memory': { autoDetect: 'mixdog-memory' } });
} catch (e) {
  die(`mixdog-memory autoDetect failed (port file missing? worker down?): ${e.message}`);
}

const agentMod = await importLocal('src/agent/index.mjs').catch(e => die(`import agent/index.mjs failed: ${e.message}`));
try {
  if (typeof agentMod.init === 'function') await agentMod.init({ notification: () => {}, elicitInput: async () => ({}) });
} catch (e) {
  die(`agent.init() failed: ${e.message}`);
}

const internalToolsMod = await importLocal('src/agent/orchestrator/internal-tools.mjs');
const { setInternalToolsProvider, addInternalTools } = internalToolsMod;
const { SYNTHETIC_TOOL_DEFS } = await importLocal('src/agent/orchestrator/synthetic-tools.mjs');

const internalTools = TOOL_DEFS.filter(t => t.module && t.module !== 'agent');
async function toolExecutor(name, args) {
  const def = TOOL_BY_NAME[name];
  if (!def) throw new Error(`Unknown tool: ${name}`);
  if (def.module === 'agent') throw new Error(`tool "${name}" is agent-internal`);
  return dispatchInProcessTool(def, args ?? {});
}
setInternalToolsProvider({ executor: toolExecutor, tools: internalTools });

const SYNTHETIC_EXECUTORS = {
  memory_search: async (args) => executeMcpTool('mcp__mixdog-memory__search_memories', args || {}),
  web_search: async (args) => {
    const searchMod = await importLocal('src/search/index.mjs');
    return searchMod.handleToolCall('search', args || {});
  },
};
addInternalTools(
  SYNTHETIC_TOOL_DEFS.map(def => ({ def, executor: SYNTHETIC_EXECUTORS[def.name] }))
                     .filter(e => typeof e.executor === 'function')
);

async function dispatchInProcessTool(def, args) {
  const cwd = process.cwd();
  const text = async (mod, fn) => {
    const m = await importLocal(mod);
    const out = await m[fn](def.name, args, cwd);
    return { content: [{ type: 'text', text: String(out) }] };
  };
  switch (def.module) {
    case 'builtin':      return text('src/agent/orchestrator/tools/builtin.mjs',     'executeBuiltinTool');
    case 'code_graph':   return text('src/agent/orchestrator/tools/code-graph.mjs',  'executeCodeGraphTool');
    case 'astgrep':      return text('src/agent/orchestrator/tools/astgrep.mjs',     'executeAstGrepTool');
    case 'patch':        return text('src/agent/orchestrator/tools/patch.mjs',       'executePatchTool');
    case 'bash_session': return text('src/agent/orchestrator/tools/bash-session.mjs','executeBashSessionTool');
    case 'host_input':   return text('src/agent/orchestrator/tools/host-input.mjs',  'executeHostInputTool');
    case 'memory':       return executeMcpTool(`mcp__mixdog-memory__${def.name}`, args);
    case 'search': {
      const m = await importLocal('src/search/index.mjs');
      return m.handleToolCall(def.name, args);
    }
    case 'channels':     throw new Error(`channels tools not supported in probe`);
    default:             throw new Error(`unhandled module ${def.module} for ${def.name}`);
  }
}

// ── ai-wrapped-dispatch handle ──────────────────────────────────────
const wrappedMod = await importLocal('src/agent/orchestrator/ai-wrapped-dispatch.mjs');
const { dispatchAiWrapped, _internals } = wrappedMod;
if (!dispatchAiWrapped) die(`dispatchAiWrapped not exported from ai-wrapped-dispatch.mjs`);

const probeCtx = {
  PLUGIN_ROOT,
  callMemoryWorker: (n, a) => executeMcpTool(`mcp__mixdog-memory__${n}`, a || {}),
  callerSessionId: null,
  callerCwd: process.cwd(),
  notifyFn: () => {},
};

function buildArgs(tool, q) {
  return tool === 'explore' ? { query: q, cwd: process.cwd() } : { query: q };
}

function extractText(out) {
  if (!out) return '';
  if (typeof out === 'string') return out;
  const arr = out.content;
  if (!Array.isArray(arr)) return JSON.stringify(out);
  return arr.filter(p => p && p.type === 'text').map(p => p.text).join('\n');
}

function failSignals(body) {
  const sig = [];
  if (!body || body.length === 0) sig.push('empty-body');
  if (body === 'null') sig.push('null-body');
  if (body && body.includes('(no response)')) sig.push('no-response');
  if (body && body.includes('code_graph references: file not found')) sig.push('code-graph-miss');
  if (body && /\[[a-z0-9-]+ error\]/i.test(body)) sig.push('bracket-error');
  return sig;
}

// Single call → result object. No printing here; the runner buffers and
// prints in stable (tool, index) order after every call lands.
async function runOne(tool, q, expected, idx) {
  const t0 = Date.now();
  let body = '', err = null, timedOut = false;
  try {
    body = await withTimeout(
      dispatchAiWrapped(tool, buildArgs(tool, q), probeCtx).then(extractText),
      TIMEOUT_MS,
    );
  } catch (e) {
    if (e && e.code === 'PROBE_TIMEOUT') { timedOut = true; body = `[probe-timeout] ${TIMEOUT_MS}ms`; }
    else { err = e; body = `[probe-error] ${e.message}`; }
  }
  const dt = Date.now() - t0;
  const fails = failSignals(body);
  const matched = Array.isArray(expected) ? expected.filter(s => body.toLowerCase().includes(String(s).toLowerCase())) : [];
  const pass = !timedOut && err === null && fails.length === 0 && (!expected || matched.length > 0);
  return { tool, idx, q, expected: expected || [], dt, pass, timedOut, chars: body.length, fails, matched, body };
}

function withTimeout(p, ms) {
  return new Promise((resolveP, rejectP) => {
    const t = setTimeout(() => {
      const err = new Error(`probe call exceeded ${ms}ms`);
      err.code = 'PROBE_TIMEOUT';
      rejectP(err);
    }, ms);
    p.then(v => { clearTimeout(t); resolveP(v); }, e => { clearTimeout(t); rejectP(e); });
  });
}

// Bounded-parallel pool. Tasks already carry their own ordering key
// (tool + idx); execution order does NOT determine print order.
async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

function printResultRow(r) {
  const qShown = r.q.length > 80 ? r.q.slice(0, 77) + '...' : r.q;
  const verdict = r.timedOut ? 'TIMEOUT' : (r.pass ? 'PASS' : 'FAIL');
  console.log('');
  console.log(`── ${r.tool.padEnd(7)} | ${r.dt.toString().padStart(6)}ms | ${verdict.padEnd(7)} | ${qShown}`);
  console.log(`   chars=${r.chars} fails=[${r.fails.join(',')}] expected_match=${r.matched.length}/${r.expected.length}`);
  const head = process.env.PROBE_VERBOSE === '1' ? r.body : (r.body || '').slice(0, 400);
  console.log(head.split('\n').map(l => '   │ ' + l).join('\n'));
}

function summarize(results, wallMs) {
  const byTool = new Map();
  for (const r of results) {
    if (!byTool.has(r.tool)) byTool.set(r.tool, []);
    byTool.get(r.tool).push(r);
  }
  console.log('\n══ summary ══');
  console.log('tool      n  pass  p50ms   p95ms   pass_rate');
  for (const [tool, rs] of byTool) {
    const stats = computeStats(rs);
    console.log(`${tool.padEnd(8)} ${pad(stats.n, 2)}  ${pad(stats.pass, 4)}  ${pad(stats.p50, 6)}  ${pad(stats.p95, 6)}  ${stats.passRate.toFixed(2)}`);
  }
  const totalCpu = results.reduce((a, r) => a + r.dt, 0);
  console.log(`wall=${wallMs}ms (sum-of-call=${totalCpu}ms, calls=${results.length})`);
}

function computeStats(rs) {
  const lat = rs.map(r => r.dt).sort((a, b) => a - b);
  const p = (q) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : 0;
  const passN = rs.filter(r => r.pass).length;
  return { n: rs.length, pass: passN, p50: p(0.5), p95: p(0.95), passRate: rs.length ? passN / rs.length : 0 };
}

function pad(v, w) { return String(v).padStart(w); }

function loadQueriesForRun() {
  const queriesPath = join(HERE, 'queries.json');
  const queries = JSON.parse(readFileSync(queriesPath, 'utf8'));
  const tasks = [];
  for (const tool of ['recall', 'search', 'explore']) {
    if (runFilter && tool !== runFilter) continue;
    const list = queries[tool] || [];
    list.forEach((item, idx) => {
      tasks.push({ tool, idx, q: item.q, expected: item.expected_substrings });
    });
  }
  return tasks;
}

async function executeRun(concurrency, label = null) {
  const tasks = loadQueriesForRun();
  if (label) console.error(`\n[probe] ── ${label} (concurrency=${concurrency}, n=${tasks.length}) ──`);
  const t0 = Date.now();
  const wrapped = tasks.map(t => () => runOne(t.tool, t.q, t.expected, t.idx));
  const results = await runPool(wrapped, concurrency);
  const wallMs = Date.now() - t0;
  // Stable print order: tool order then idx.
  const order = ['recall', 'search', 'explore'];
  const sorted = results.slice().sort((a, b) => {
    const da = order.indexOf(a.tool), db = order.indexOf(b.tool);
    if (da !== db) return da - db;
    return a.idx - b.idx;
  });
  for (const r of sorted) printResultRow(r);
  summarize(sorted, wallMs);
  return { results: sorted, wallMs };
}

// ── sweep helpers ───────────────────────────────────────────────────

// Apply a sweep value, return a "restore" function that undoes it.
async function applySweepValue(param, value) {
  if (param === 'concurrency') {
    const n = clampInt(value, 1, 32);
    return { concurrency: n, restore: () => {} };
  }
  if (param === 'prompt_variant') {
    if (!_internals || !_internals.builders) {
      die([
        `sweep prompt_variant: ai-wrapped-dispatch.mjs#_internals does NOT expose 'builders'.`,
        `Required next-pass src change (single-line):`,
        `  export const _internals = { ..., builders: { recall: buildRecallPrompt, search: buildSearchPrompt, explore: buildExplorerPrompt } }`,
        `AND change ROLE_BY_TOOL to: build: (...a) => _internals.builders.<tool>(...a)`,
        `Rerun the sweep after that lands.`,
      ].join('\n'));
    }
    const variantPath = join(VARIANTS_DIR, `${value}.mjs`);
    if (!existsSync(variantPath)) die(`prompt-variant '${value}' not found at ${variantPath}`);
    const mod = await import(pathToFileURL(variantPath).href);
    const required = ['buildExplorerPrompt', 'buildRecallPrompt', 'buildSearchPrompt'];
    for (const name of required) {
      if (typeof mod[name] !== 'function') die(`variant '${value}' missing export ${name}`);
    }
    const original = { ..._internals.builders };
    _internals.builders.recall = mod.buildRecallPrompt;
    _internals.builders.search = mod.buildSearchPrompt;
    _internals.builders.explore = mod.buildExplorerPrompt;
    return { restore: () => Object.assign(_internals.builders, original) };
  }
  if (param === 'model') {
    // Search the codebase for a clean knob. As of this revision, no
    // MIXDOG_*_MODEL env var is read by the orchestrator (verified
    // 2025-01 via `grep MIXDOG_.*MODEL src/`). The hidden-role preset
    // is resolved inside src/agent/orchestrator/smart-bridge/ from
    // static config — there is no env override.
    die([
      `sweep model: NOT IMPLEMENTED — no env knob exists in the agent wiring.`,
      `Searched for: MIXDOG_RECALL_MODEL, MIXDOG_EXPLORE_MODEL, MIXDOG_SEARCH_MODEL — none read.`,
      `Hidden-role preset is resolved statically in src/agent/orchestrator/smart-bridge/`,
      `(role-resolver.mjs / preset-catalog.mjs).`,
      `Add an env override there first; then this sweep can simply set process.env.MIXDOG_<ROLE>_MODEL`,
      `before each batch and reset it after.`,
    ].join('\n'));
  }
  if (param === 'iter_cap') {
    // Likewise, EMERGENCY_ITERATION_FUSE / SOFT_ITERATION_WARN_THRESHOLDS
    // are baked into the agent loop with no env override at the time
    // this harness was written.
    die([
      `sweep iter_cap: NOT IMPLEMENTED — no env knob for the agent iteration fuse.`,
      `EMERGENCY_ITERATION_FUSE and SOFT_ITERATION_WARN_THRESHOLDS are constants in`,
      `src/agent/orchestrator/ (or role-specific overrides). Wire an env read first`,
      `(e.g. MIXDOG_ITER_CAP) and then this sweep can drive it.`,
    ].join('\n'));
  }
  die(`unknown sweep param ${param}`);
}

function clampInt(v, lo, hi) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

async function executeSweep() {
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(RESULTS_DIR, `sweep-${sweepParam}-${ts}.json`);
  const allRows = [];   // {param, value, tool, stats}
  const rawAll = [];    // {param, value, results}

  for (const value of sweepValues) {
    const applied = await applySweepValue(sweepParam, value);
    const concurrency = applied.concurrency ?? DEFAULT_CONCURRENCY;
    const label = `sweep ${sweepParam}=${value}`;
    const { results, wallMs } = await executeRun(concurrency, label);

    const byTool = new Map();
    for (const r of results) {
      if (!byTool.has(r.tool)) byTool.set(r.tool, []);
      byTool.get(r.tool).push(r);
    }
    for (const [tool, rs] of byTool) {
      const stats = computeStats(rs);
      allRows.push({ param: sweepParam, value: String(value), tool, ...stats, wallMs });
    }
    rawAll.push({ param: sweepParam, value: String(value), wallMs, results });
    if (typeof applied.restore === 'function') applied.restore();
  }

  console.log('\n══ sweep summary ══');
  console.log('param=value                              tool    n  pass  p50ms   p95ms   pass_rate');
  for (const row of allRows) {
    const head = `${sweepParam}=${row.value}`.padEnd(38);
    console.log(`${head}  ${row.tool.padEnd(7)} ${pad(row.n,2)}  ${pad(row.pass,4)}  ${pad(row.p50,6)}  ${pad(row.p95,6)}  ${row.passRate.toFixed(2)}`);
  }

  // Best per tool: highest pass_rate; ties → lower p95.
  const tools = [...new Set(allRows.map(r => r.tool))];
  console.log('\n══ best per tool ══');
  for (const tool of tools) {
    const rows = allRows.filter(r => r.tool === tool);
    rows.sort((a, b) => (b.passRate - a.passRate) || (a.p95 - b.p95));
    const winner = rows[0];
    console.log(`${tool.padEnd(8)} → ${sweepParam}=${winner.value}  pass_rate=${winner.passRate.toFixed(2)}  p95=${winner.p95}ms`);
  }

  writeFileSync(outPath, JSON.stringify({ param: sweepParam, values: sweepValues, rows: allRows, raw: rawAll.map(r => ({
    ...r,
    results: r.results.map(({ body, ...rest }) => rest), // strip bodies to keep file small
  })) }, null, 2));
  console.log(`\n[probe] sweep raw results → ${outPath}`);
}

// ── execute ─────────────────────────────────────────────────────────
let exitCode = 0;
try {
  if (mode === 'one') {
    const r = await runOne(oneTool, oneQuery, null, 0);
    printResultRow(r);
    exitCode = r.pass ? 0 : 1;
  } else if (mode === 'run') {
    const { results } = await executeRun(DEFAULT_CONCURRENCY);
    exitCode = results.some(r => !r.pass) ? 1 : 0;
  } else if (mode === 'sweep') {
    await executeSweep();
    exitCode = 0;
  }
} finally {
  try { await disconnectAll(); } catch {}
  setImmediate(() => process.exit(exitCode));
}

// ── helpers ─────────────────────────────────────────────────────────
function die(msg) { console.error(`[probe] FATAL: ${msg}`); process.exit(2); }
function usage() {
  console.error('usage:');
  console.error('  node bench/probe.mjs <recall|search|explore> "<query>"');
  console.error('  node bench/probe.mjs run [recall|search|explore] [--concurrency=N]');
  console.error('  node bench/probe.mjs sweep <model|concurrency|prompt_variant|iter_cap> <values...>');
  process.exit(2);
}
