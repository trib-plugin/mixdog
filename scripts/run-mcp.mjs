#!/usr/bin/env bun
/**
 * MCP server launcher for mixdog (bun-only) — proxy supervisor.
 *
 * Boot sequence:
 *   1. Resolve the shared data directory via plugin-paths.cjs.
 *   2. Copy package.json + bun.lock there and run `bun install --frozen-lockfile`
 *      into <dataDir>/node_modules/ (only when the lockfile / dep-keys change).
 *   3. Symlink pluginRoot/node_modules → dataDir/node_modules so all plugin
 *      code resolves deps from the shared install.
 *   4. Spawn server.mjs with bun and proxy MCP stdio between Claude Code and
 *      the child. The proxy caches the client's initialize/initialized so a
 *      child kill (dev-sync --restart, crash) can be silently re-handshaken
 *      against a fresh child without forcing the client to reconnect.
 *
 * Single-runtime path: any failure throws — no node fallback.
 */
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { execSync, spawn, spawnSync } from 'child_process';
import * as os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const __localRoot = join(__dirname, '..');

// Read installed_plugins.json each boot so dev-sync --restart picks up new code
// without forcing client reconnect. Falls back to own cache dir on any error.
let _manifestLock = false
function _resolveLatestPluginRoot() {
  try {
    // Manifest lock: reject path refresh while a previous spawn is in flight.
    // A half-written installed_plugins.json (cache swap during execution) must
    // fail loud rather than crash silently with a corrupted child path.
    if (_manifestLock) {
      process.stderr.write('[run-mcp] WARN: _resolveLatestPluginRoot called while manifest lock held — using fallback\n')
      return __localRoot
    }
    _manifestLock = true
    const manifestPath = join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!data || typeof data !== 'object' || !data.plugins) {
      process.stderr.write('[run-mcp] WARN: installed_plugins.json has unexpected shape — using fallback\n')
      _manifestLock = false
      process.stderr.write('[run-mcp] manifest-lock-fallback: using boot pluginRoot as-is\n')
      return __localRoot
    }
    const entry = data?.plugins?.['mixdog@trib-plugin']?.[0];
    if (entry?.installPath) {
      const latest = entry.installPath.replace(/\\/g, '/');
      if (fs.existsSync(latest)) {
        _manifestLock = false
        return latest
      }
    }
  } catch {}
  _manifestLock = false
  process.stderr.write('[run-mcp] manifest-lock-fallback: manifest read failed — using boot pluginRoot as-is\n')
  return __localRoot;
}
const pluginRoot = _resolveLatestPluginRoot();
if (pluginRoot !== __localRoot) {
  process.stderr.write(`[run-mcp] supervisor proxying to latest cache: ${pluginRoot} (own=${__localRoot})\n`);
}
const serverPath = join(pluginRoot, 'server.mjs');
const pluginPkg  = join(pluginRoot, 'package.json');
const pluginLock = join(pluginRoot, 'bun.lock');
const pluginNm   = join(pluginRoot, 'node_modules');

process.stderr.write(`[boot-time] tag=run-mcp-entry tMs=${Date.now()}\n`);

// Surface plugin.json/package.json version drift at boot — warn-only.
try {
  const pluginVer  = JSON.parse(fs.readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const packageVer = JSON.parse(fs.readFileSync(pluginPkg, 'utf8')).version;
  if (pluginVer && packageVer && pluginVer !== packageVer) {
    process.stderr.write(
      `[run-mcp] WARN: version mismatch — plugin.json=${pluginVer} package.json=${packageVer}\n`
      + `         Run \`bun scripts/bump-version.mjs ${pluginVer}\` to sync.\n`,
    );
  }
} catch { /* missing manifest — not run-mcp's concern */ }

const requiredDepNames = [
  ['@modelcontextprotocol', 'sdk', 'package.json'],
  ['zod', 'package.json'],
  ['zod-to-json-schema', 'package.json'],
  ['openai', 'package.json'],
];

function hasRequiredDeps(nmDir) {
  return requiredDepNames.every((parts) => fs.existsSync(join(nmDir, ...parts)));
}

const LOCK_POLL_MS  = 250;
const LOCK_MAX_MS   = 15 * 60 * 1000;
const LOCK_XHOST_MS = 10 * 60 * 1000;

function acquireLock(lockFile) {
  const start = Date.now();
  while (Date.now() - start < LOCK_MAX_MS) {
    try {
      const body = JSON.stringify({
        pid:       process.pid,
        hostname:  os.hostname(),
        startedAt: Date.now(),
      });
      // 'wx' = O_CREAT | O_EXCL — fails atomically if file already exists.
      fs.writeFileSync(lockFile, body, { flag: 'wx' });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const raw  = fs.readFileSync(lockFile, 'utf8');
        const body = JSON.parse(raw);
        const st   = fs.statSync(lockFile);
        const sameHost = body.hostname === os.hostname();
        let dead = false;
        if (sameHost) {
          try { process.kill(body.pid, 0); }
          catch (ke) { if (ke.code === 'ESRCH') dead = true; }
        } else {
          if (Date.now() - st.mtimeMs > LOCK_XHOST_MS) dead = true;
        }
        if (dead) fs.unlinkSync(lockFile);
      } catch { /* lock may have been released between read and stat — retry */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }
  throw new Error(
    `timed out waiting for dependency install lock after ${LOCK_MAX_MS / 60000} minutes`
  );
}

function releaseLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch {}
}

function ensureNmSymlink(linkPath, targetPath) {
  let stat;
  try { stat = fs.lstatSync(linkPath); } catch { stat = null; }

  if (stat === null) {
    fs.symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return;
  }
  if (stat.isSymbolicLink()) {
    const current = fs.readlinkSync(linkPath);
    if (current === targetPath) return;
    fs.unlinkSync(linkPath);
    fs.symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return;
  }
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * SHA-256 hash that changes iff the resolved dep tree changes.
 * Primary: bun.lock. Fallback: dep-key objects from package.json (so the very
 * first install — before bun.lock exists — still hashes deterministically).
 */
function computeDepHash(pkgJsonPath, pkgLockPath) {
  if (fs.existsSync(pkgLockPath)) {
    return sha256(fs.readFileSync(pkgLockPath));
  }
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const depKeys = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  const depObj = {};
  for (const k of depKeys) {
    if (pkg[k]) {
      depObj[k] = Object.fromEntries(
        Object.entries(pkg[k]).sort(([a], [b]) => a.localeCompare(b))
      );
    }
  }
  return sha256(Buffer.from(JSON.stringify(depObj)));
}

const require = createRequire(import.meta.url);
const { resolvePluginData } = require('../lib/plugin-paths.cjs');
const dataDir = resolvePluginData();

fs.mkdirSync(dataDir, { recursive: true });

const sharedPkg  = join(dataDir, 'package.json');
const sharedLock = join(dataDir, 'bun.lock');
const sharedNm   = join(dataDir, 'node_modules');
const stamp      = join(dataDir, '.deps-stamp');
const stampTmp   = join(dataDir, '.deps-stamp.tmp');
const lockFile   = join(dataDir, '.install.lock');

const currentHash = computeDepHash(pluginPkg, pluginLock);
let storedHash = '';
try { storedHash = fs.readFileSync(stamp, 'utf8').trim(); } catch {}

const needsInstall = (currentHash !== storedHash) || !hasRequiredDeps(sharedNm);

if (needsInstall) {
  acquireLock(lockFile);
  try {
    fs.copyFileSync(pluginPkg, sharedPkg);
    if (fs.existsSync(pluginLock)) fs.copyFileSync(pluginLock, sharedLock);

    const args = fs.existsSync(sharedLock)
      ? ['install', '--frozen-lockfile']
      : ['install'];
    process.stderr.write(`[run-mcp] installing shared deps: bun ${args.join(' ')}\n`);

    const INSTALL_TIMEOUT_MS = 30_000;
    const result = spawnSync('bun', args, {
      cwd: dataDir,
      stdio: 'inherit',
      timeout: INSTALL_TIMEOUT_MS,
    });
    if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
      process.stderr.write(
        `[run-mcp] WARN: bun install timed out after ${INSTALL_TIMEOUT_MS}ms — ` +
        `continuing with existing node_modules (stale lock removed)\n`
      );
      try { fs.unlinkSync(lockFile); } catch {}
    } else if (result.status !== 0) {
      const detail = result.status ?? result.signal ?? 'unknown';
      process.stderr.write(
        `[run-mcp] WARN: bun install exited with status ${detail} — ` +
        `continuing with existing node_modules if available\n`
      );
    } else {
      // Atomic stamp write: tmp + rename so a crash cannot leave it half-written.
      fs.writeFileSync(stampTmp, currentHash);
      fs.renameSync(stampTmp, stamp);
    }
  } finally {
    releaseLock(lockFile);
  }
}

ensureNmSymlink(pluginNm, sharedNm);

const probe = join(pluginNm, '@modelcontextprotocol', 'sdk', 'package.json');
if (!fs.existsSync(probe)) {
  // Probe failed: node_modules may be stale or install failed.
  // If any required dep is present the env may still be usable — warn and continue.
  // If ALL required deps are missing (fresh env + install failure), abort with guidance.
  const anyPresent = hasRequiredDeps(sharedNm) || hasRequiredDeps(pluginNm);
  if (anyPresent) {
    process.stderr.write(
      `[run-mcp] WARN: @modelcontextprotocol/sdk not found at expected path after install — ` +
      `continuing with available node_modules\n`
    );
  } else {
    process.stderr.write(
      `[run-mcp] ERROR: node_modules is incomplete and bun install did not succeed.\n` +
      `  Run \`bun install\` manually in ${pluginRoot} and retry.\n`
    );
    process.exit(1);
  }
}

const isWin = process.platform === 'win32';

// Proxy supervisor: parses NDJSON JSON-RPC, caches initialize so child kills
// are silent to the client; in-flight requests get a retry-able error on child death.

const CRASH_WINDOW_MS    = 10_000;
const CRASH_MAX_RESTARTS = 5;
const CRASH_BACKOFF_MS   = 500;

let proc = null;
let shuttingDown = false;
let respawnTimer = null;
const recentRestarts = [];

let cachedInitRequest    = null; // { id, params } from client's first initialize
let cachedInitDone       = false; // initialized notification observed from client
let internalIdSeq        = -1;    // negative ids reserved for supervisor-internal requests
const pendingFromClient  = new Map(); // request id (from client) → { method }
const pendingInternal    = new Set(); // internal ids (init replay) — drop responses
let stdinBuf  = '';
let stdoutBuf = '';

function writeToClient(line) {
  // Client transport is line-delimited JSON.
  try { process.stdout.write(line + '\n'); } catch {}
}

function writeToChild(line) {
  if (!proc || !proc.stdin || !proc.stdin.writable) return false;
  try { proc.stdin.write(line + '\n'); return true; } catch { return false; }
}

function sendErrorToClient(id, code, message) {
  if (id === undefined || id === null) return;
  writeToClient(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
}

function replayInitToChild() {
  if (!cachedInitRequest) return;
  const internalId = internalIdSeq--;
  pendingInternal.add(internalId);
  writeToChild(JSON.stringify({
    jsonrpc: '2.0',
    id: internalId,
    method: 'initialize',
    params: cachedInitRequest.params,
  }));
  if (cachedInitDone) {
    // Notification — no id, no response expected.
    writeToChild(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }));
  }
}

function handleClientLine(line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch {
    // Forward unparseable bytes verbatim — let the child reject if malformed.
    writeToChild(line);
    return;
  }
  if (msg && typeof msg === 'object') {
    if (msg.method === 'initialize') {
      cachedInitRequest = { id: msg.id, params: msg.params };
    } else if (msg.method === 'notifications/initialized' || msg.method === 'initialized') {
      cachedInitDone = true;
    }
    if (msg.id !== undefined && msg.method) {
      pendingFromClient.set(msg.id, { method: msg.method });
    }
  }
  if (!writeToChild(line)) {
    // Child not yet ready (e.g. mid-respawn). For requests with an id, surface
    // a retry-able error; notifications are dropped (clients re-emit on
    // demand — list_changed will re-trigger).
    if (msg && msg.id !== undefined && msg.method) {
      sendErrorToClient(msg.id, -32603, '[run-mcp] mcp child unavailable; retry');
      pendingFromClient.delete(msg.id);
    }
  }
}

function handleChildLine(line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch {
    // Forward verbatim.
    writeToClient(line);
    return;
  }
  if (msg && typeof msg === 'object' && msg.id !== undefined) {
    if (pendingInternal.has(msg.id)) {
      // Supervisor-internal initialize replay — swallow the reply.
      pendingInternal.delete(msg.id);
      return;
    }
    pendingFromClient.delete(msg.id);
  }
  writeToClient(line);
}

function drainBuffer(buf, onLine) {
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).replace(/\r$/, '');
    buf = buf.slice(idx + 1);
    onLine(line);
  }
  return buf;
}

function spawnChild() {
  // Re-resolve pluginRoot on EVERY child spawn so dev-sync --restart
  // (kills only child) picks up the new cache path. Boot-time pluginRoot
  // is used for one-shot install / symlink / version warn; everything
  // child-facing must come from the live manifest each spawn.
  const childPluginRoot = _resolveLatestPluginRoot();
  const childServerPath = join(childPluginRoot, 'server.mjs');
  if (childPluginRoot !== pluginRoot) {
    process.stderr.write(`[run-mcp] child spawn path refreshed: ${childPluginRoot} (boot=${pluginRoot})\n`);
  }
  process.stderr.write(`[boot-time] tag=run-mcp-spawn-server tMs=${Date.now()}\n`);
  proc = spawn('bun', [childServerPath], {
    cwd: childPluginRoot,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env,
      UV_THREADPOOL_SIZE: '2',
      CLAUDE_PLUGIN_ROOT: childPluginRoot,
      CLAUDE_PLUGIN_DATA: dataDir,
    },
    ...(isWin ? { windowsHide: true } : {}),
  });

  if (isWin && proc.pid) {
    try {
      execSync(`wmic process where processid=${proc.pid} call setpriority "below normal"`, { stdio: 'ignore', windowsHide: true });
    } catch {}
  }

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    stdoutBuf = drainBuffer(stdoutBuf, handleChildLine);
  });

  proc.on('exit', (code, signal) => {
    // Clear proc immediately so SIGTERM / killChild sees proc=null and exits
    // cleanly rather than sending SIGTERM to a dead process handle.
    proc = null;
    if (shuttingDown) {
      process.exit(code || 0);
      return;
    }
    // Surface retry-able errors for any request the dead child still owed us.
    for (const [id] of pendingFromClient) {
      sendErrorToClient(id, -32603, '[run-mcp] mcp child restarted; retry');
    }
    pendingFromClient.clear();
    pendingInternal.clear();

    const now = Date.now();
    recentRestarts.push(now);
    while (recentRestarts.length && now - recentRestarts[0] > CRASH_WINDOW_MS) {
      recentRestarts.shift();
    }
    if (recentRestarts.length > CRASH_MAX_RESTARTS) {
      // Don't tear down the supervisor — staying alive lets a follow-up
      // dev-sync replace the broken child without losing the MCP stdio
      // session. Surface the diagnostic and back off; new client requests
      // will get a retry-able error until a clean child boots.
      process.stderr.write(
        `[run-mcp] child crash loop (${recentRestarts.length} restarts in ${CRASH_WINDOW_MS}ms) — backing off ${CRASH_BACKOFF_MS}ms; supervisor stays up\n`,
      );
      respawnTimer = setTimeout(() => {
        if (shuttingDown) return;
        spawnChild();
        // Re-handshake the fresh child after crash-loop backoff.
        if (!cachedInitRequest) {
          process.stderr.write('[run-mcp] WARN: crash-loop respawn before initialize landed — skipping init replay\n');
        } else {
          replayInitToChild();
        }
        writeToClient(JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/tools/list_changed',
        }));
      }, CRASH_BACKOFF_MS * 4);
      return;
    }
    process.stderr.write(`[run-mcp] child exit code=${code} signal=${signal} — respawning (#${recentRestarts.length})\n`);
    respawnTimer = setTimeout(() => {
      if (shuttingDown) return;
      spawnChild();
      // Silent re-handshake against the fresh child.
      replayInitToChild();
      // Tell the client tools may have changed — rebuilds the schema cache
      // without forcing initialize to repeat.
      writeToClient(JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/tools/list_changed',
      }));
    }, CRASH_BACKOFF_MS);
  });

  proc.on('error', (err) => {
    process.stderr.write(`[run-mcp] child spawn error: ${err && err.message}\n`);
  });
}

function killChild() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(respawnTimer);
  respawnTimer = null;
  if (!proc) {
    process.exit(0);
    return;
  }
  // Graceful shutdown: close stdin (EOF) + SIGINT → child detects EOF and shuts down gracefully.
  // Bun children spawned via spawn() have no IPC channel, so SIGTERM offers no graceful-close
  // guarantee (on Windows it maps directly to SIGKILL). Closing stdin lets server.mjs detect
  // the EOF via its stdin 'end' listener and initiate its own clean shutdown before the parent
  // times out and force-kills.
  const GRACEFUL_TIMEOUT_MS = 10000;
  const pid = proc.pid;
  try {
    // Close child's stdin — EOF signals graceful shutdown to server.mjs
    proc.stdin.end();
    process.stderr.write(`[run-mcp] closed child stdin (pid=${pid}) — signalling graceful shutdown\n`);
  } catch (e) {
    process.stderr.write(`[run-mcp] stdin.end() failed (pid=${pid}): ${e && e.message}\n`);
  }
  // Also send SIGINT (Ctrl+C simulation) on non-Windows; on Windows skip (no reliable delivery)
  if (!isWin) {
    try { proc.kill('SIGINT'); } catch {}
  }
  // Wait up to GRACEFUL_TIMEOUT_MS for clean exit; force-kill only if timeout expires.
  let exited = false;
  const forceTimer = setTimeout(() => {
    if (exited) return;
    process.stderr.write(`[run-mcp] child did not exit within ${GRACEFUL_TIMEOUT_MS}ms — forcing kill (pid=${pid}) path=force\n`);
    try {
      if (isWin && pid) {
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore', windowsHide: true, timeout: 5000 });
      } else {
        proc.kill('SIGKILL');
      }
    } catch {}
  }, GRACEFUL_TIMEOUT_MS);
  proc.once('exit', (code, signal) => {
    exited = true;
    clearTimeout(forceTimer);
    process.stderr.write(`[run-mcp] child exited cleanly (pid=${pid} code=${code} signal=${signal}) path=graceful\n`);
    process.exit(code || 0);
  });
  // process.exit is called by the proc 'exit' handler above once the child terminates.
}

process.on('SIGTERM', killChild);
process.on('SIGINT', killChild);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  stdinBuf = drainBuffer(stdinBuf, handleClientLine);
});
process.stdin.on('end', killChild);
process.stdin.on('close', killChild);

spawnChild();
