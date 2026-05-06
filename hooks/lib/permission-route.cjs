'use strict';
/**
 * Shared helper for permission-request hooks to decide whether a prompt can
 * actually be routed to Discord (owner terminal is up + HTTP server live)
 * or must fall through to the built-in terminal prompt.
 *
 * Used by:
 *   - hooks/permission-request.cjs       (main-session permission requests)
 *   - hooks/pre-tool-subagent.cjs        (sub-agent protected-path requests)
 *
 * Routing criteria (all must hold for `discord`):
 *   1. `active-instance.json` exists and has a non-empty `instanceId`
 *   2. `active.supervisor_pid` is alive (probed via `process.kill(pid, 0)`)
 *   3. Either `active.httpPort` is set, or `bridge-state.json.active === true`
 *
 * Returns: `{ route: 'discord' | 'terminal', httpPort?: number }`
 *
 * Not exported: the Discord API wiring itself — each hook keeps its own
 * flow. This helper only answers the routing question.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = path.join(os.tmpdir(), 'mixdog');
const ACTIVE_INSTANCE_FILE = path.join(RUNTIME_ROOT, 'active-instance.json');
const BRIDGE_STATE_FILE = path.join(RUNTIME_ROOT, 'bridge-state.json');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!n || !Number.isFinite(n)) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    // EPERM → process exists but signal denied → still alive
    return err && err.code === 'EPERM';
  }
}

function shouldRoutePermissionToDiscord() {
  const active = readJson(ACTIVE_INSTANCE_FILE);
  if (!active || !active.instanceId) return { route: 'terminal' };
  if (!isPidAlive(active.supervisor_pid)) return { route: 'terminal' };

  const hasHttpPort = typeof active.httpPort === 'number' && active.httpPort > 0;
  const bridgeState = readJson(BRIDGE_STATE_FILE);
  const bridgeActive = bridgeState && bridgeState.active === true;

  if (!hasHttpPort && !bridgeActive) return { route: 'terminal' };
  return hasHttpPort
    ? { route: 'discord', httpPort: active.httpPort }
    : { route: 'discord' };
}

module.exports = { shouldRoutePermissionToDiscord };
