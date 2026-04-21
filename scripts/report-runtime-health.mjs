#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getPluginData } from '../src/agent/orchestrator/config.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => !arg.includes('=')));
const kv = Object.fromEntries(argv.filter((arg) => arg.includes('=')).map((arg) => arg.replace(/^--/, '').split('=')));

const JSON_OUT = flags.has('--json');
const HOURS = Math.max(1, Number.parseInt(kv.hours || '24', 10) || 24);
const SINCE_MS = Date.now() - HOURS * 3600_000;
const TRACE_PATH = kv.trace || join(getPluginData(), 'history', 'bridge-trace.jsonl');
const JOBS_DIR = kv.jobs_dir || join(getPluginData(), 'shell-jobs');

function loadTraceRows(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((row) => row && Date.parse(row.ts || 0) >= SINCE_MS);
}

function increment(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function topEntries(map, limit = 5) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function analyzeTrace(rows) {
  const summary = {
    toolLoopDetected: 0,
    toolLoopAborted: 0,
    warnCounts: { same_tool: 0, family: 0, budget: 0 },
    topWarnedTools: [],
    topWarnedFamilies: [],
    topLoopAbortTools: [],
  };
  const warnedTools = new Map();
  const warnedFamilies = new Map();
  const abortedTools = new Map();
  for (const row of rows) {
    if (row.kind === 'tool_loop_detected') summary.toolLoopDetected++;
    if (row.kind === 'tool_loop_aborted') {
      summary.toolLoopAborted++;
      increment(abortedTools, row.tool_name);
    }
    if (row.kind === 'tool_loop_warn') {
      if (row.warn_type && summary.warnCounts[row.warn_type] != null) summary.warnCounts[row.warn_type]++;
      if (row.warn_type === 'same_tool') increment(warnedTools, row.tool_name);
      if (row.warn_type === 'family') increment(warnedFamilies, row.family_key);
    }
  }
  summary.topWarnedTools = topEntries(warnedTools);
  summary.topWarnedFamilies = topEntries(warnedFamilies);
  summary.topLoopAbortTools = topEntries(abortedTools);
  return summary;
}

function loadJobDetails(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; }
    })
    .filter((row) => row && Date.parse(row.startedAt || 0) >= SINCE_MS);
}

function analyzeJobs(rows) {
  const statuses = { running: 0, completed: 0, failed: 0, cancelled: 0 };
  const finishedDurations = [];
  for (const row of rows) {
    if (statuses[row.status] != null) statuses[row.status]++;
    if (row.finishedAt && row.startedAt) {
      const ms = Date.parse(row.finishedAt) - Date.parse(row.startedAt);
      if (Number.isFinite(ms) && ms >= 0) finishedDurations.push(ms);
    }
  }
  return {
    total: rows.length,
    statuses,
    medianFinishedMs: percentile(finishedDurations, 0.5),
    p90FinishedMs: percentile(finishedDurations, 0.9),
  };
}

const traceRows = loadTraceRows(TRACE_PATH);
const jobRows = loadJobDetails(JOBS_DIR);
const output = {
  windowHours: HOURS,
  tracePath: TRACE_PATH,
  jobsDir: JOBS_DIR,
  traceRows: traceRows.length,
  loop: analyzeTrace(traceRows),
  jobs: analyzeJobs(jobRows),
};

if (JSON_OUT) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`# Runtime Health (${HOURS}h)`);
  console.log(`trace rows: ${output.traceRows}`);
  console.log(`tool_loop_detected: ${output.loop.toolLoopDetected}`);
  console.log(`tool_loop_aborted: ${output.loop.toolLoopAborted}`);
  console.log(`warn same_tool/family/budget: ${output.loop.warnCounts.same_tool}/${output.loop.warnCounts.family}/${output.loop.warnCounts.budget}`);
  if (output.loop.topWarnedTools.length) {
    console.log(`top warned tools: ${output.loop.topWarnedTools.map(([k, v]) => `${k}:${v}`).join(', ')}`);
  }
  if (output.loop.topWarnedFamilies.length) {
    console.log(`top warned families: ${output.loop.topWarnedFamilies.map(([k, v]) => `${k}:${v}`).join(', ')}`);
  }
  if (output.loop.topLoopAbortTools.length) {
    console.log(`top abort tools: ${output.loop.topLoopAbortTools.map(([k, v]) => `${k}:${v}`).join(', ')}`);
  }
  console.log(`jobs total: ${output.jobs.total}`);
  console.log(`jobs status running/completed/failed/cancelled: ${output.jobs.statuses.running}/${output.jobs.statuses.completed}/${output.jobs.statuses.failed}/${output.jobs.statuses.cancelled}`);
  console.log(`jobs median/p90 finished ms: ${output.jobs.medianFinishedMs}/${output.jobs.p90FinishedMs}`);
}
