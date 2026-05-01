#!/usr/bin/env bun
/**
 * bump-version.mjs
 * Usage: bun scripts/bump-version.mjs <semver>
 *
 * Updates version in:
 *   - package.json                → .version
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

const newVersion = process.argv[2];
if (!newVersion || !newVersion.trim()) {
  process.stderr.write('Usage: bun scripts/bump-version.mjs <version>\n');
  process.stderr.write('Writes the given string to the version field as-is. Any version scheme is accepted (SemVer, CalVer, build number, prerelease identifier, etc.).\n');
  process.exit(1);
}
// Reject only characters that break JSON or shell pipelines; do NOT enforce
// a particular versioning scheme — projects vary (SemVer, CalVer, build
// numbers, custom tags). The version is written to the manifest verbatim.
if (/[\x00-\x1f"\\]/.test(newVersion)) {
  process.stderr.write(`Error: version "${newVersion}" contains control characters or unescaped quotes/backslashes.\n`);
  process.exit(1);
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

  const pluginJsonPath = path.join(ROOT, '.claude-plugin', 'plugin.json');
  if (fs.existsSync(pluginJsonPath)) {
    const plugin = readJson(pluginJsonPath);
    plugin.version = newVersion;
    writeJson(pluginJsonPath, plugin);
    touched.push('plugin.json');
  } else {
    process.stderr.write('Notice: .claude-plugin/plugin.json not found — skipped.\n');
  }

  process.stdout.write(`bumped to ${newVersion}: ${touched.join(', ')}\n`);
  process.stdout.write('Run `bun install` to refresh bun.lock.\n');
} finally {
  releaseLock();
}
