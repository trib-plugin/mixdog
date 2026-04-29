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

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

const newVersion = process.argv[2];
if (!newVersion) {
  process.stderr.write('Usage: bun scripts/bump-version.mjs <semver>\n');
  process.stderr.write('Example: bun scripts/bump-version.mjs 1.2.3\n');
  process.exit(1);
}
if (!SEMVER_RE.test(newVersion)) {
  process.stderr.write(`Error: "${newVersion}" is not a valid semver string.\n`);
  process.stderr.write('Expected format: MAJOR.MINOR.PATCH (e.g. 0.1.12) or MAJOR.MINOR.PATCH-tag\n');
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

const touched = [];

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
