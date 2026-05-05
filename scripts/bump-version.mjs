#!/usr/bin/env bun
/**
 * bump-version.mjs
 * Usage:
 *   bun scripts/bump-version.mjs <X.Y.Z>          explicit semver
 *   bun scripts/bump-version.mjs <X.Y.Z-suffix>   explicit semver with prerelease
 *   bun scripts/bump-version.mjs patch             X.Y.Z → X.Y.(Z+1)
 *   bun scripts/bump-version.mjs minor             X.Y.Z → X.(Y+1).0
 *   bun scripts/bump-version.mjs major             X.Y.Z → (X+1).0.0
 *
 * Updates version in:
 *   - package.json                → .version
 *   - package-lock.json           → .version + .packages[""].version  (skipped if absent)
 *   - .claude-plugin/plugin.json  → .version  (skipped if absent)
 *
 * After bumping, run `bun install` to refresh bun.lock.
 *
 * Pure JS, no external deps.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const USAGE = [
  'Usage:',
  '  bun scripts/bump-version.mjs <X.Y.Z>          explicit semver',
  '  bun scripts/bump-version.mjs <X.Y.Z-suffix>   explicit semver with prerelease',
  '  bun scripts/bump-version.mjs patch             X.Y.Z → X.Y.(Z+1)',
  '  bun scripts/bump-version.mjs minor             X.Y.Z → X.(Y+1).0',
  '  bun scripts/bump-version.mjs major             X.Y.Z → (X+1).0.0',
].join('\n') + '\n';

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const KEYWORDS = new Set(['patch', 'minor', 'major']);

// Parse --dry-run flag (order-tolerant: flag may appear before or after version arg)
const _rawArgs = process.argv.slice(2);
const dryRun = _rawArgs.includes('--dry-run');
const _filteredArgs = _rawArgs.filter(a => a !== '--dry-run');
const arg = _filteredArgs[0];

if (!arg || !arg.trim()) {
  process.stderr.write('Error: version argument is required.\n' + USAGE);
  process.exit(1);
}

let newVersion;

if (KEYWORDS.has(arg)) {
  // Read current version from package.json to compute next
  const pkgRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const current = pkgRaw.version;
  if (!SEMVER_RE.test(current)) {
    process.stderr.write(`Error: current package.json version "${current}" is not valid semver (X.Y.Z). Cannot auto-increment.\n`);
    process.exit(1);
  }
  const [major, minor, patch] = current.split('-')[0].split('.').map(Number);
  if (arg === 'patch') newVersion = `${major}.${minor}.${patch + 1}`;
  else if (arg === 'minor') newVersion = `${major}.${minor + 1}.0`;
  else /* major */          newVersion = `${major + 1}.0.0`;
} else {
  if (!SEMVER_RE.test(arg)) {
    process.stderr.write(`Error: "${arg}" is not a valid semver version (expected X.Y.Z or X.Y.Z-suffix) and is not a keyword (patch/minor/major).\n` + USAGE);
    process.exit(1);
  }
  newVersion = arg;
}

// ── Exclusive file lock ──────────────────────────────────────────────────────
const LOCK_PATH = path.join(__dirname, '.bump.lock');
const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 100;

let lockFd = null;

function acquireLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      lockFd = fs.openSync(LOCK_PATH, 'wx');
      return; // acquired
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Poll: busy-wait with a synchronous sleep via Atomics
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }
  process.stderr.write(
    `Error: bump-version lock is held by another process (waited ${LOCK_WAIT_MS}ms).\n` +
    `Remove ${LOCK_PATH} manually if the previous run crashed.\n`
  );
  process.exit(2);
}

function releaseLock() {
  if (lockFd !== null) {
    try { fs.closeSync(lockFd); } catch { /* ignore */ }
    try { fs.unlinkSync(LOCK_PATH); } catch { /* ignore */ }
    lockFd = null;
  }
}

// Ensure lock is released on uncaught exception or signal.
process.on('uncaughtException', (err) => {
  releaseLock();
  process.stderr.write(`Uncaught error: ${err.message}\n`);
  process.exit(1);
});
process.on('SIGINT', () => { releaseLock(); process.exit(1); });
process.on('SIGTERM', () => { releaseLock(); process.exit(1); });

if (dryRun) {
  // Dry-run: print current→new for each target file, then exit without writing.
  const pkgPath = path.join(ROOT, 'package.json');
  const pkgLockPath = path.join(ROOT, 'package-lock.json');
  const pluginJsonPath = path.join(ROOT, '.claude-plugin', 'plugin.json');

  const pkgCurrent = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '(unknown)';
  process.stdout.write(`dry-run: package.json: ${pkgCurrent} -> ${newVersion}\n`);

  if (fs.existsSync(pkgLockPath)) {
    const lockCurrent = JSON.parse(fs.readFileSync(pkgLockPath, 'utf8')).version || '(unknown)';
    process.stdout.write(`dry-run: package-lock.json: ${lockCurrent} → ${newVersion}\n`);
  }

  if (fs.existsSync(pluginJsonPath)) {
    const pluginCurrent = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8')).version || '(unknown)';
    process.stdout.write(`dry-run: .claude-plugin/plugin.json: ${pluginCurrent} -> ${newVersion}\n`);
  }

  process.stdout.write('dry-run complete (no files written).\n');
  process.exit(0);
}

acquireLock();
// ────────────────────────────────────────────────────────────────────────────

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

const touched = [];

try {
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = readJson(pkgPath);
  pkg.version = newVersion;
  writeJson(pkgPath, pkg);
  touched.push('package.json');

  const lockJsonPath = path.join(ROOT, 'package-lock.json');
  if (fs.existsSync(lockJsonPath)) {
    const lock = readJson(lockJsonPath);
    lock.version = newVersion;
    if (lock.packages && lock.packages['']) lock.packages[''].version = newVersion;
    writeJson(lockJsonPath, lock);
    touched.push('package-lock.json');
  }

  const pluginJsonPath = path.join(ROOT, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(pluginJsonPath)) {
    process.stderr.write('Error: .claude-plugin/plugin.json not found — required target missing. Aborting.\n');
    process.exit(1);
  }
  const plugin = readJson(pluginJsonPath);
  plugin.version = newVersion;
  writeJson(pluginJsonPath, plugin);
  touched.push('plugin.json');

  // ── Final assert: re-read all written files and confirm versions match ───
  const assertErrors = [];
  const pkgActual = readJson(pkgPath).version;
  if (pkgActual !== newVersion) assertErrors.push(`package.json has ${pkgActual}, expected ${newVersion}`);
  const pluginActual = readJson(pluginJsonPath).version;
  if (pluginActual !== newVersion) assertErrors.push(`.claude-plugin/plugin.json has ${pluginActual}, expected ${newVersion}`);
  if (assertErrors.length > 0) {
    process.stderr.write(`Error: post-write version mismatch:\n  ${assertErrors.join('\n  ')}\n`);
    process.exit(1);
  }

  process.stdout.write(`bumped to ${newVersion}: ${touched.join(', ')}\n`);
  process.stdout.write('Run `bun install` to refresh bun.lock.\n');
} finally {
  releaseLock();
}
