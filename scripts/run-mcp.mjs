#!/usr/bin/env bun
/**
 * MCP server launcher for mixdog (bun-only).
 *
 * Boot sequence:
 *   1. Resolve the shared data directory via plugin-paths.cjs.
 *   2. Copy package.json + bun.lock there and run `bun install --frozen-lockfile`
 *      into <dataDir>/node_modules/ (only when the lockfile / dep-keys change).
 *   3. Symlink pluginRoot/node_modules → dataDir/node_modules so all plugin
 *      code resolves deps from the shared install.
 *   4. Spawn server.mjs with bun.
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
const pluginRoot = join(__dirname, '..');
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

    const result = spawnSync('bun', args, {
      cwd: dataDir,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      const detail = result.status ?? result.signal ?? 'unknown';
      throw new Error(`bun install exited with status ${detail}`);
    }

    // Atomic stamp write: tmp + rename so a crash cannot leave it half-written.
    fs.writeFileSync(stampTmp, currentHash);
    fs.renameSync(stampTmp, stamp);
  } finally {
    releaseLock(lockFile);
  }
}

ensureNmSymlink(pluginNm, sharedNm);

const probe = join(pluginNm, '@modelcontextprotocol', 'sdk', 'package.json');
if (!fs.existsSync(probe)) {
  throw new Error('install completed but @modelcontextprotocol/sdk is missing — bun install may have failed silently');
}

const isWin = process.platform === 'win32';

// Supervisor: keep the wrapper alive across child crashes / dev-restart kills
// so Claude Code's MCP stdio stays connected. The wrapper exits only when the
// parent closes stdin (Claude Code shutting us down) or the child enters a
// crash loop (CRASH_WINDOW_MS / CRASH_MAX_RESTARTS).
const CRASH_WINDOW_MS = 10_000;
const CRASH_MAX_RESTARTS = 5;
let proc = null;
let shuttingDown = false;
const recentRestarts = [];

function spawnChild() {
  process.stderr.write(`[boot-time] tag=run-mcp-spawn-server tMs=${Date.now()}\n`);
  proc = spawn('bun', [serverPath], {
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

  if (isWin && proc.pid) {
    try {
      execSync(`wmic process where processid=${proc.pid} call setpriority "below normal"`, { stdio: 'ignore', windowsHide: true });
    } catch {}
  }

  proc.on('exit', (code, signal) => {
    if (shuttingDown) {
      process.exit(code || 0);
      return;
    }
    const now = Date.now();
    recentRestarts.push(now);
    while (recentRestarts.length && now - recentRestarts[0] > CRASH_WINDOW_MS) {
      recentRestarts.shift();
    }
    if (recentRestarts.length > CRASH_MAX_RESTARTS) {
      process.stderr.write(`[run-mcp] child crash loop (${recentRestarts.length} restarts in ${CRASH_WINDOW_MS}ms) — giving up\n`);
      process.exit(code || 1);
      return;
    }
    process.stderr.write(`[run-mcp] child exit code=${code} signal=${signal} — respawning (#${recentRestarts.length})\n`);
    spawnChild();
  });
}

function killChild() {
  shuttingDown = true;
  if (!proc) return;
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

spawnChild();
