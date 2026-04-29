#!/usr/bin/env bun
/**
 * check-version.mjs
 * Verifies that version fields in package.json and .claude-plugin/plugin.json match.
 *
 * Exit 0 → in sync.
 * Exit 1 → mismatch (prints a table of mismatches).
 *
 * Pure JS, no external deps.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    process.stderr.write(`Error reading ${filePath}: ${e.message}\n`);
    process.exit(1);
  }
}

const readings = [];

const pkgPath = path.join(ROOT, 'package.json');
const pkg = readJson(pkgPath);
readings.push({ file: 'package.json', field: 'version', value: pkg.version });

const pluginJsonPath = path.join(ROOT, '.claude-plugin', 'plugin.json');
if (fs.existsSync(pluginJsonPath)) {
  const plugin = readJson(pluginJsonPath);
  readings.push({ file: '.claude-plugin/plugin.json', field: 'version', value: plugin.version });
}

const uniqueValues = [...new Set(readings.map(r => r.value))];

if (uniqueValues.length === 1) {
  process.stdout.write(`✓ versions in sync: ${uniqueValues[0]}\n`);
  process.exit(0);
}

process.stderr.write('✗ version mismatch detected:\n\n');

const colFile  = Math.max('File'.length,    ...readings.map(r => r.file.length));
const colField = Math.max('Field'.length,   ...readings.map(r => r.field.length));
const colValue = Math.max('Version'.length, ...readings.map(r => (r.value ?? '(missing)').length));

const sep = `+${'-'.repeat(colFile + 2)}+${'-'.repeat(colField + 2)}+${'-'.repeat(colValue + 2)}+`;
const row = (f, k, v) =>
  `| ${f.padEnd(colFile)} | ${k.padEnd(colField)} | ${v.padEnd(colValue)} |`;

process.stderr.write(sep + '\n');
process.stderr.write(row('File', 'Field', 'Version') + '\n');
process.stderr.write(sep + '\n');
for (const r of readings) {
  const marker = r.value !== uniqueValues[0] ? ' !' : '  ';
  process.stderr.write(row(r.file, r.field, r.value ?? '(missing)') + marker + '\n');
}
process.stderr.write(sep + '\n');
process.stderr.write('\nRun `bun scripts/bump-version.mjs <version>` to fix all at once.\n');
process.exit(1);
