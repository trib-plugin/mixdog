#!/usr/bin/env node
import { loadConfig, saveConfig } from '../src/agent/orchestrator/config.mjs';
import { loadToolLoopGuardRecommendation } from '../src/agent/orchestrator/tool-loop-guard-recommend.mjs';

const rec = loadToolLoopGuardRecommendation();
if (!rec) {
  console.error('No saved tool loop guard recommendation found.');
  process.exit(1);
}

const config = loadConfig();
config.bridge = config.bridge || {};
config.bridge.toolLoopGuard = rec.overrides || {};
saveConfig(config);

console.log(`Applied saved toolLoopGuard recommendation generated at ${rec.generatedAt || '(unknown time)'}`);
