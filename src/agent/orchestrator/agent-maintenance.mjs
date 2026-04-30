import { loadConfig, saveConfig } from './config.mjs';
import { getTrajectoryDb, getTrajectoryStats, findRepeatingPatterns } from './trajectory.mjs';
import { recommendToolLoopGuardFromTrace, saveToolLoopGuardRecommendation } from './tool-loop-guard-recommend.mjs';

let _timer = null;

function parseInterval(str) {
  const match = String(str || '30m').match(/^(\d+)(m|h)$/);
  if (!match) return 30 * 60 * 1000;
  const [, n, unit] = match;
  return Number(n) * (unit === 'h' ? 3600000 : 60000);
}

export function startAgentMaintenance() {
  const config = loadConfig();
  if (!config.agentMaintenance?.enabled) return;

  const interval = parseInterval(config.agentMaintenance?.interval);

  _timer = setInterval(async () => {
    try {
      await runAgentMaintenance();
    } catch (err) {
      process.stderr.write(`[agent-maintenance] error: ${err.message}\n`);
    }
  }, interval);

  process.stderr.write(`[agent-maintenance] started (interval: ${config.agentMaintenance?.interval || '30m'})\n`);
}

export function stopAgentMaintenance() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

export async function runAgentMaintenance() {
  const config = loadConfig();
  const autoTune = config.bridge?.toolLoopGuardAutoTune || {};
  if (autoTune.enabled === true) {
    const rec = recommendToolLoopGuardFromTrace({
      tracePath: autoTune.tracePath || null,
      window: Number.isFinite(Number(autoTune.window)) ? Number(autoTune.window) : 20000,
    });
    const minToolRows = Number.isFinite(Number(autoTune.minToolRows)) ? Number(autoTune.minToolRows) : 1000;
    if (rec.sampledToolRows >= minToolRows) {
      const current = JSON.stringify(config.bridge?.toolLoopGuard || {});
      const next = JSON.stringify(rec.overrides || {});
      const mode = String(autoTune.mode || 'recommend').toLowerCase();
      if (current !== next) {
        const report = {
          ...rec,
          mode,
          current: config.bridge?.toolLoopGuard || {},
        };
        const recPath = saveToolLoopGuardRecommendation(report);
        if (mode === 'apply') {
          config.bridge = config.bridge || {};
          config.bridge.toolLoopGuard = rec.overrides;
          saveConfig(config);
          process.stderr.write(`[agent-maintenance] toolLoopGuard auto-tuned from ${rec.sampledToolRows} tool rows across ${rec.sampledSessions} sessions\n`);
        } else {
          process.stderr.write(`[agent-maintenance] toolLoopGuard recommendation updated at ${recPath} (${rec.sampledToolRows} tool rows / ${rec.sampledSessions} sessions)\n`);
        }
      }
    }
  }
  const db = getTrajectoryDb();
  if (!db) return;

  // 1. Log stats
  const stats = getTrajectoryStats(null, new Date(Date.now() - 86400000).toISOString());
  if (stats.total > 0) {
    process.stderr.write(`[agent-maintenance] 24h stats: ${stats.total} calls, ${stats.successRate}% success, avg ${stats.avgDuration}ms\n`);
  }

  // 2. Pattern detection
  const patterns = findRepeatingPatterns(3);
  if (patterns.length > 0) {
    process.stderr.write(`[agent-maintenance] ${patterns.length} repeating pattern(s) detected\n`);
  }

}
