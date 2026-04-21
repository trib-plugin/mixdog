import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { getPluginData } from './config.mjs';
import { DEFAULT_TOOL_LOOP_GUARD_CONFIG } from './tool-loop-guard.mjs';
const RECOMMENDATION_FILE = 'tool-loop-guard-recommendation.json';

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function median(values) {
  return percentile(values, 0.5);
}

function buildRuleStates() {
  return DEFAULT_TOOL_LOOP_GUARD_CONFIG.toolFamilyWarnRules.map((rule) => ({
    key: rule.key,
    tools: new Set(rule.tools),
    count: 0,
    distinct: new Set(),
    runs: [],
  }));
}

function finishSameToolRun(runs, tool, count) {
  if (!tool || count <= 0) return;
  if (!runs.has(tool)) runs.set(tool, []);
  runs.get(tool).push(count);
}

function finishFamilyRun(state) {
  if (state.count > 0) state.runs.push(state.count);
  state.count = 0;
  state.distinct = new Set();
}

export function analyzeToolTraceRows(rows) {
  const sessions = new Map();
  for (const row of rows) {
    if (!row || row.kind !== 'tool' || !row.sessionId || !row.tool_name) continue;
    if (!sessions.has(row.sessionId)) sessions.set(row.sessionId, []);
    sessions.get(row.sessionId).push(String(row.tool_name).toLowerCase());
  }

  const sameToolRuns = new Map();
  const familyRuns = new Map();
  const totalCalls = [];

  for (const toolSeq of sessions.values()) {
    totalCalls.push(toolSeq.length);
    let lastTool = null;
    let lastCount = 0;
    const familyStates = buildRuleStates();
    for (const tool of toolSeq) {
      if (tool === lastTool) lastCount += 1;
      else {
        finishSameToolRun(sameToolRuns, lastTool, lastCount);
        lastTool = tool;
        lastCount = 1;
      }
      for (const state of familyStates) {
        if (state.tools.has(tool)) {
          state.count += 1;
          state.distinct.add(tool);
        } else {
          finishFamilyRun(state);
        }
      }
    }
    finishSameToolRun(sameToolRuns, lastTool, lastCount);
    for (const state of familyStates) {
      finishFamilyRun(state);
      familyRuns.set(state.key, state.runs);
    }
  }

  return { sessionCount: sessions.size, sameToolRuns, familyRuns, totalCalls };
}

function suggestSameToolThreshold(defaultThreshold, samples) {
  if (!samples || samples.length < 4) return defaultThreshold;
  const p90 = percentile(samples, 0.9);
  const target = Math.max(2, Math.round(p90 + 1));
  return Math.max(2, Math.min(24, Math.round((defaultThreshold * 2 + target) / 3)));
}

function suggestFamilyThreshold(defaultThreshold, samples) {
  if (!samples || samples.length < 4) return defaultThreshold;
  const p90 = percentile(samples, 0.9);
  const target = Math.max(3, Math.round(p90 + 1));
  return Math.max(3, Math.min(32, Math.round((defaultThreshold * 2 + target) / 3)));
}

function suggestBudgetThresholds(defaults, totalCalls) {
  if (!totalCalls.length) return [...defaults];
  const p75 = Math.max(12, Math.round(percentile(totalCalls, 0.75)));
  const p90 = Math.max(p75 + 8, Math.round(percentile(totalCalls, 0.9)));
  return [
    Math.max(12, Math.min(96, Math.round((defaults[0] * 2 + p75) / 3))),
    Math.max(p75 + 8, Math.min(160, Math.round((defaults[1] * 2 + p90) / 3))),
  ];
}

export function buildToolLoopGuardRecommendation(stats) {
  const sameToolThresholds = {};
  for (const [tool, def] of Object.entries(DEFAULT_TOOL_LOOP_GUARD_CONFIG.sameToolThresholds)) {
    sameToolThresholds[tool] = suggestSameToolThreshold(def, stats.sameToolRuns.get(tool) || []);
  }
  const toolFamilyWarnRules = DEFAULT_TOOL_LOOP_GUARD_CONFIG.toolFamilyWarnRules.map((rule) => ({
    key: rule.key,
    threshold: suggestFamilyThreshold(rule.threshold, stats.familyRuns.get(rule.key) || []),
    minDistinctTools: rule.minDistinctTools,
    tools: [...rule.tools],
  }));
  const totalToolWarnThresholds = suggestBudgetThresholds(DEFAULT_TOOL_LOOP_GUARD_CONFIG.totalToolWarnThresholds, stats.totalCalls);
  return {
    sameToolThresholds,
    toolFamilyWarnRules,
    totalToolWarnThresholds,
  };
}

export function diffToolLoopGuardRecommendation(recommendation) {
  const diff = {};
  const sameToolThresholds = {};
  for (const [tool, value] of Object.entries(recommendation.sameToolThresholds || {})) {
    if (value !== DEFAULT_TOOL_LOOP_GUARD_CONFIG.sameToolThresholds[tool]) sameToolThresholds[tool] = value;
  }
  if (Object.keys(sameToolThresholds).length) diff.sameToolThresholds = sameToolThresholds;

  const familyDiff = (recommendation.toolFamilyWarnRules || []).filter((rule) => {
    const base = DEFAULT_TOOL_LOOP_GUARD_CONFIG.toolFamilyWarnRules.find((r) => r.key === rule.key);
    return !base || base.threshold !== rule.threshold;
  });
  if (familyDiff.length) diff.toolFamilyWarnRules = familyDiff;

  if ((recommendation.totalToolWarnThresholds || []).join(',') !== DEFAULT_TOOL_LOOP_GUARD_CONFIG.totalToolWarnThresholds.join(',')) {
    diff.totalToolWarnThresholds = recommendation.totalToolWarnThresholds;
  }
  return diff;
}

export function loadRecentToolTraceRows({ tracePath = null, window = 20000 } = {}) {
  const path = tracePath || join(getPluginData(), 'history', 'bridge-trace.jsonl');
  if (!existsSync(path)) return { tracePath: path, rows: [] };
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const rows = lines
    .slice(-window)
    .filter((line) => line.includes('"kind":"tool"'))
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
  return { tracePath: path, rows };
}

export function recommendToolLoopGuardFromTrace({ tracePath = null, window = 20000 } = {}) {
  const loaded = loadRecentToolTraceRows({ tracePath, window });
  const stats = analyzeToolTraceRows(loaded.rows);
  const recommendation = buildToolLoopGuardRecommendation(stats);
  const overrides = diffToolLoopGuardRecommendation(recommendation);
  return {
    generatedAt: new Date().toISOString(),
    tracePath: loaded.tracePath,
    sampledToolRows: loaded.rows.length,
    sampledSessions: stats.sessionCount,
    totals: {
      medianCallsPerSession: median(stats.totalCalls),
      p90CallsPerSession: percentile(stats.totalCalls, 0.9),
    },
    recommendation,
    overrides,
  };
}

export function getToolLoopGuardRecommendationPath() {
  return join(getPluginData(), RECOMMENDATION_FILE);
}

export function saveToolLoopGuardRecommendation(report) {
  const path = getToolLoopGuardRecommendationPath();
  mkdirSync(getPluginData(), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  return path;
}

export function loadToolLoopGuardRecommendation() {
  const path = getToolLoopGuardRecommendationPath();
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}
