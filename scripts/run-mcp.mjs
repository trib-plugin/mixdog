#!/usr/bin/env node
/**
 * MCP server launcher for mixdog.
 * Starts the server.mjs in stdio mode.
 *
 * Boot sequence:
 *   1. Resolve the shared data directory via plugin-paths.cjs.
 *   2. Copy package.json + package-lock.json there and run npm ci/install into
 *      <dataDir>/node_modules/ (only when the lock-file / dep-keys change).
 *   3. Symlink pluginRoot/node_modules → dataDir/node_modules so that
 *      all plugin code resolves deps from the shared install.
 *   4. Spawn server.mjs.
 *
 * If ANY step in 1-3 fails, a single stderr line is logged and the
 * launcher falls back to the legacy behaviour: npm ci into pluginRoot.
 * This guarantees "plugin always boots" even on exotic filesystems.
 */
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { execSync, spawn, spawnSync } from 'child_process';
import * as os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(__dirname, '..');
const serverPath = join(pluginRoot, 'server.mjs');
const pluginPkg   = join(pluginRoot, 'package.json');
const pluginLock  = join(pluginRoot, 'package-lock.json');
const pluginNm    = join(pluginRoot, 'node_modules');

// ── Version sync warn ─────────────────────────────────────────────────────────
// plugin.json and package.json must bump together (scripts/bump-version.mjs
// does both). A standalone edit leaves the manifests skewed and confuses
// install/release tooling. Surface the mismatch immediately at boot so it can
// be fixed before it ships; warn-only — never block the launcher.
try {
  const pluginVer  = JSON.parse(fs.readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const packageVer = JSON.parse(fs.readFileSync(pluginPkg, 'utf8')).version;
  if (pluginVer && packageVer && pluginVer !== packageVer) {
    process.stderr.write(
      `[run-mcp] WARN: version mismatch — plugin.json=${pluginVer} package.json=${packageVer}\n`
      + `         Run \`node scripts/bump-version.mjs ${pluginVer}\` to sync (also updates package-lock.json).\n`,
    );
  }
} catch { /* missing manifest — not run-mcp's concern */ }

// ── Required-dep probe paths (relative to any node_modules dir) ──────────────
const requiredDepNames = [
  ['@modelcontextprotocol', 'sdk', 'package.json'],
  ['zod', 'package.json'],
  ['zod-to-json-schema', 'package.json'],
  ['openai', 'package.json'],
];

function hasRequiredDeps(nmDir) {
  return requiredDepNames.every((parts) => fs.existsSync(join(nmDir, ...parts)));
}

// ── Lock helpers ──────────────────────────────────────────────────────────────
const LOCK_POLL_MS  = 250;
const LOCK_MAX_MS   = 15 * 60 * 1000; // 15-minute hard ceiling
const LOCK_XHOST_MS = 10 * 60 * 1000; // cross-host stale threshold

function acquireLock(lockFile) {
  const start = Date.now();
  while (Date.now() - start < LOCK_MAX_MS) {
    try {
      // Write JSON body so waiters can probe liveness.
      const body = JSON.stringify({
        pid:       process.pid,
        hostname:  os.hostname(),
        startedAt: Date.now(),
      });
      // 'wx' = O_CREAT | O_EXCL — fails atomically if file already exists.
      fs.writeFileSync(lockFile, body, { flag: 'wx' });
      return; // acquired
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // ── Liveness check ──────────────────────────────────────────────────
      try {
        const raw  = fs.readFileSync(lockFile, 'utf8');
        const body = JSON.parse(raw);
        const st   = fs.statSync(lockFile);
        const sameHost = body.hostname === os.hostname();
        let dead = false;
        if (sameHost) {
          // Same host: probe the pid directly.
          try {
            process.kill(body.pid, 0); // throws ESRCH if no such process
          } catch (ke) {
            if (ke.code === 'ESRCH') dead = true;
            // EPERM means the process exists but we can't signal it — alive.
          }
        } else {
          // Different host: we can't probe the pid; rely on mtime age.
          if (Date.now() - st.mtimeMs > LOCK_XHOST_MS) dead = true;
        }
        if (dead) fs.unlinkSync(lockFile);
      } catch { /* lock may have been released between read and stat — retry */ }
      // Busy-wait before retrying.
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

// ── Symlink helper ────────────────────────────────────────────────────────────
function ensureNmSymlink(linkPath, targetPath) {
  let stat;
  try { stat = fs.lstatSync(linkPath); } catch { stat = null; }

  if (stat === null) {
    // Nothing there — create the symlink.
    fs.symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return;
  }
  if (stat.isSymbolicLink()) {
    const current = fs.readlinkSync(linkPath);
    if (current === targetPath) return; // already correct
    fs.unlinkSync(linkPath);
    fs.symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return;
  }
  // Real directory — remove and replace with symlink.
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

// ── SHA-256 helper ────────────────────────────────────────────────────────────
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ── Dep-hash helper ───────────────────────────────────────────────────────────
/**
 * Returns a SHA-256 hash that changes iff the resolved dependency tree changes.
 *
 * Primary source: package-lock.json (deterministic per dep tree; unaffected by
 * a version-only plugin bump that doesn't touch deps).
 * Fallback (missing lock): hash only the dep-key objects from package.json so
 * that a name/version bump in unrelated fields still doesn't force reinstall.
 */
function computeDepHash(pkgJsonPath, pkgLockPath) {
  if (fs.existsSync(pkgLockPath)) {
    return sha256(fs.readFileSync(pkgLockPath));
  }
  // Fallback: extract only the dep-relevant keys and hash their JSON.
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const depKeys = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  const depObj = {};
  for (const k of depKeys) {
    if (pkg[k]) {
      // Sort keys for a stable serialization independent of insertion order.
      depObj[k] = Object.fromEntries(
        Object.entries(pkg[k]).sort(([a], [b]) => a.localeCompare(b))
      );
    }
  }
  return sha256(Buffer.from(JSON.stringify(depObj)));
}

// ── Legacy fallback ───────────────────────────────────────────────────────────
function legacyInstall() {
  if (hasRequiredDeps(pluginNm)) return;
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = fs.existsSync(pluginLock)
    ? ['ci', '--ignore-scripts']
    : ['install', '--ignore-scripts'];
  process.stderr.write(`[run-mcp] legacy bootstrap: ${npmCmd} ${args.join(' ')}\n`);
  const result = spawnSync(npmCmd, args, {
    cwd: pluginRoot,
    stdio: 'inherit',
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });
  if (result.status !== 0 || !hasRequiredDeps(pluginNm)) {
    const detail = result.status ?? result.signal ?? 'unknown';
    throw new Error(`legacy dependency bootstrap failed (${detail})`);
  }
}

// ── Main bootstrap ────────────────────────────────────────────────────────────
let bootstrapDone = false;
// Hoisted: spawn() below needs `dataDir` for env propagation, so the
// binding has to outlive the try block. Falls back to pluginRoot when the
// shared-install path failed and legacyInstall() ran.
let dataDir = pluginRoot;

try {
  // Step 1 — Resolve plugin data directory via plugin-paths.cjs.
  const require = createRequire(import.meta.url);
  const { resolvePluginData } = require('../lib/plugin-paths.cjs');
  dataDir = resolvePluginData();

  // Step 3 — Ensure dataDir exists.
  fs.mkdirSync(dataDir, { recursive: true });

  // Step 4 — Path constants.
  const sharedPkg  = join(dataDir, 'package.json');
  const sharedLock = join(dataDir, 'package-lock.json');
  const sharedNm   = join(dataDir, 'node_modules');
  const stamp      = join(dataDir, '.deps-stamp');
  const stampTmp   = join(dataDir, '.deps-stamp.tmp');
  const lockFile   = join(dataDir, '.install.lock');

  // Step 5 — Hash the dep tree (lock file preferred; dep-keys fallback).
  const currentHash = computeDepHash(pluginPkg, pluginLock);
  let storedHash = '';
  try { storedHash = fs.readFileSync(stamp, 'utf8').trim(); } catch {}

  // Step 6 — Decide whether to reinstall.
  const needsInstall = (currentHash !== storedHash) || !hasRequiredDeps(sharedNm);

  // Step 7 — Run npm install into dataDir if needed.
  if (needsInstall) {
    acquireLock(lockFile);
    try {
      fs.copyFileSync(pluginPkg, sharedPkg);
      if (fs.existsSync(pluginLock)) fs.copyFileSync(pluginLock, sharedLock);

      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const args = fs.existsSync(sharedLock)
        ? ['ci', '--ignore-scripts']
        : ['install', '--ignore-scripts'];
      process.stderr.write(`[run-mcp] installing shared deps: ${npmCmd} ${args.join(' ')}\n`);

      const result = spawnSync(npmCmd, args, {
        cwd: dataDir,
        stdio: 'inherit',
        env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
      });
      if (result.status !== 0) {
        const detail = result.status ?? result.signal ?? 'unknown';
        throw new Error(`npm exited with status ${detail}`);
      }

      // Atomic stamp write: write to .tmp then rename so a crash between the
      // two calls can't leave the stamp in a partially-written / wrong state.
      fs.writeFileSync(stampTmp, currentHash);
      fs.renameSync(stampTmp, stamp);
    } finally {
      releaseLock(lockFile);
    }
  }

  // Step 8 — Symlink pluginRoot/node_modules → dataDir/node_modules.
  ensureNmSymlink(pluginNm, sharedNm);

  // Step 9 — Verify the install landed.
  const probe = join(pluginNm, '@modelcontextprotocol', 'sdk', 'package.json');
  if (!fs.existsSync(probe)) {
    throw new Error('install completed but @modelcontextprotocol/sdk is missing — npm may have failed silently');
  }

  bootstrapDone = true;
} catch (err) {
  const reason = err?.message ?? String(err);
  process.stderr.write(`[run-mcp] shared install failed (${reason}), falling back to legacy layout\n`);
  // Fallback: install directly into pluginRoot/node_modules as before.
  legacyInstall();
  bootstrapDone = true;
}

// ── Spawn server ──────────────────────────────────────────────────────────────
const isWin = process.platform === 'win32';
const proc = spawn('bun', [serverPath], {
  cwd: pluginRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    UV_THREADPOOL_SIZE: '2',
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PLUGIN_DATA: dataDir,
  },
  ...(isWin ? { windowsHide: true } : {}),
});

// Lower process priority on Windows to reduce fan noise.
if (isWin && proc.pid) {
  try {
    execSync(`wmic process where processid=${proc.pid} call setpriority "below normal"`, { stdio: 'ignore', windowsHide: true });
  } catch {}
}

function killChild() {
  if (isWin && proc.pid) {
    try {
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    } catch {}
  } else {
    proc.kill('SIGTERM');
  }
}

process.on('SIGTERM', killChild);
process.on('SIGINT', killChild);
process.stdin.on('end', killChild);
process.stdin.on('close', killChild);

proc.on('exit', (code) => {
  process.exit(code || 0);
});
