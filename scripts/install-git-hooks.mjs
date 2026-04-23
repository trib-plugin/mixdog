#!/usr/bin/env node
/**
 * install-git-hooks.mjs
 * Installs a pre-commit hook that runs check-version.mjs before every commit.
 *
 * Behaviour:
 *   - If no .git dir → skip with non-error message.
 *   - If hook exists and already contains the check → skip (idempotent).
 *   - If hook exists but lacks the check → APPEND (preserve existing hooks).
 *   - If hook doesn't exist → create from scratch.
 *   - chmod 755 on POSIX; Windows skips chmod (git handles it).
 *
 * Pure Node, no external deps.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const GIT_DIR = path.join(ROOT, '.git');
const HOOKS_DIR = path.join(GIT_DIR, 'hooks');
const HOOK_PATH = path.join(HOOKS_DIR, 'pre-commit');

// The guard snippet we insert/check for
const GUARD_MARKER = 'check-version.mjs';
const HOOK_BLOCK = `\n#!/bin/sh\n# mixdog version-sync guard (auto-installed)\nnode scripts/check-version.mjs || exit 1\n`;
const HOOK_FRESH = `#!/bin/sh\n# mixdog version-sync guard (auto-installed)\nnode scripts/check-version.mjs || exit 1\n`;

// 1. Check for .git
if (!fs.existsSync(GIT_DIR)) {
  process.stdout.write('Not a git repository (no .git dir found) — skipping hook install.\n');
  process.exit(0);
}

// 2. Ensure hooks dir exists
if (!fs.existsSync(HOOKS_DIR)) {
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
}

// 3. Read existing hook (if any)
let existingContent = null;
if (fs.existsSync(HOOK_PATH)) {
  existingContent = fs.readFileSync(HOOK_PATH, 'utf8');
}

if (existingContent !== null && existingContent.includes(GUARD_MARKER)) {
  // Already installed — idempotent no-op
  process.stdout.write(`✓ pre-commit hook already contains version-sync guard — nothing to do.\n`);
  process.exit(0);
}

if (existingContent !== null) {
  // Hook exists but lacks the guard — append
  const appended = existingContent.endsWith('\n')
    ? existingContent + HOOK_BLOCK.trimStart()
    : existingContent + HOOK_BLOCK;
  fs.writeFileSync(HOOK_PATH, appended, 'utf8');
  process.stdout.write(`✓ Appended version-sync guard to existing pre-commit hook: ${HOOK_PATH}\n`);
} else {
  // No hook yet — create fresh
  fs.writeFileSync(HOOK_PATH, HOOK_FRESH, 'utf8');
  process.stdout.write(`✓ Created pre-commit hook: ${HOOK_PATH}\n`);
}

// 4. chmod 755 on POSIX (Windows doesn't need it)
if (os.platform() !== 'win32') {
  try {
    fs.chmodSync(HOOK_PATH, 0o755);
  } catch (e) {
    process.stderr.write(`Warning: could not chmod hook: ${e.message}\n`);
  }
}

process.stdout.write(`Hook content:\n---\n${fs.readFileSync(HOOK_PATH, 'utf8')}---\n`);
