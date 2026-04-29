#!/usr/bin/env bun
import { loadConfig, saveConfig } from '../src/agent/orchestrator/config.mjs';
import { recommendToolLoopGuardFromTrace } from '../src/agent/orchestrator/tool-loop-guard-recommend.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => !arg.includes('=')));
const kv = Object.fromEntries(argv.filter((arg) => arg.includes('=')).map((arg) => arg.replace(/^--/, '').split('=')));

const APPLY = flags.has('--apply');
const JSON_OUT = flags.has('--json');
const WINDOW = Math.max(200, Number.parseInt(kv.window || '20000', 10) || 20000);
const TRACE_PATH = kv.trace || null;

const output = recommendToolLoopGuardFromTrace({ tracePath: TRACE_PATH, window: WINDOW });

if (APPLY) {
  const config = loadConfig();
  config.bridge = config.bridge || {};
  config.bridge.toolLoopGuard = output.overrides;
  saveConfig(config);
  output.applied = true;
} else {
  output.applied = false;
}

if (JSON_OUT) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`# Tool Loop Guard Recommendation`);
  console.log(`trace: ${output.tracePath}`);
  console.log(`sampled tool rows: ${output.sampledToolRows}`);
  console.log(`sampled sessions: ${output.sampledSessions}`);
  console.log(`median calls/session: ${output.totals.medianCallsPerSession}`);
  console.log(`p90 calls/session: ${output.totals.p90CallsPerSession}`);
  console.log(``);
  console.log(JSON.stringify(output.overrides, null, 2));
  if (APPLY) {
    console.log(`\nApplied to config.bridge.toolLoopGuard`);
  } else {
    console.log(`\nUse --apply to write these overrides into agent-config.json`);
  }
}
