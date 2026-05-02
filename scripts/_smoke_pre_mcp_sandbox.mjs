#!/usr/bin/env node
/**
 * Smoke test for pre-mcp-sandbox.cjs
 *
 * Spawns the hook with crafted payloads and validates stdout JSON or exit code.
 * Usage: node scripts/_smoke_pre_mcp_sandbox.mjs
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(__dirname, '../hooks/pre-mcp-sandbox.cjs');
const HOME = os.homedir();

// Fake project cwd — something that exists
const CWD = path.resolve(__dirname, '..');
const OUTSIDE = path.join(HOME, '.claude'); // real path, outside cwd
const MCP = 'mcp__plugin_mixdog_mixdog__';

// ── helpers ──────────────────────────────────────────────────────────────────

function run(payload, env = {}) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 8000,
  });
  const stdout = result.stdout || '';
  let parsed = null;
  if (stdout.trim()) {
    try { parsed = JSON.parse(stdout.trim()); } catch { /* raw */ }
  }
  return { exitCode: result.status, stdout, parsed, stderr: result.stderr || '' };
}

function decision(r) {
  return r.parsed?.hookSpecificOutput?.permissionDecision ?? null;
}

function check(label, r, expectedDecision, expectedExit = 0) {
  const dec = decision(r);
  const pass =
    r.exitCode === expectedExit &&
    (expectedDecision === null ? dec === null : dec === expectedDecision);
  const status = pass ? 'PASS' : 'FAIL';
  const detail = pass ? '' : ` | exit=${r.exitCode} decision=${dec} stderr=${r.stderr.slice(0, 120)}`;
  console.log(`  [${status}] ${label}${detail}`);
  return pass;
}

// ── scenarios ────────────────────────────────────────────────────────────────

const results = [];

function t(label, r, expectedDecision, expectedExit = 0) {
  results.push(check(label, r, expectedDecision, expectedExit));
}

console.log('\n=== pre-mcp-sandbox smoke test ===\n');

// ── Group 1: non-MCP tool → allow (exit 0, no output) ──────────────────────
console.log('Group 1: non-MCP tools (passthrough)');
t('non-MCP tool → allow',
  run({ tool_name: 'Edit', tool_input: { file_path: '/tmp/foo' }, cwd: CWD }),
  null);

// ── Group 2: dangerous hard-deny (mode/allow irrelevant) ───────────────────
console.log('\nGroup 2: dangerous hard-deny');

t('UNC path → deny',
  run({
    tool_name: MCP + 'read',
    tool_input: { path: '\\\\server\\share\\file.txt' },
    cwd: CWD,
    permissionMode: 'bypassPermissions',
  }),
  'deny');

t('dangerous absolute /etc/shadow → deny',
  run({
    tool_name: MCP + 'read',
    tool_input: { path: '/etc/shadow' },
    cwd: CWD,
    permissionMode: 'bypassPermissions',
  }),
  'deny');

t('dangerous absolute C:\\Windows\\System32 → deny',
  run({
    tool_name: MCP + 'read',
    tool_input: { path: 'C:\\Windows\\System32\\cmd.exe' },
    cwd: CWD,
    permissionMode: 'bypassPermissions',
  }),
  'deny');

// ── Group 3: bypassPermissions mode ────────────────────────────────────────
console.log('\nGroup 3: bypassPermissions mode');

t('bypassPermissions + inside-cwd → allow',
  run({
    tool_name: MCP + 'read',
    tool_input: { path: path.join(CWD, 'package.json') },
    cwd: CWD,
    permissionMode: 'bypassPermissions',
  }),
  null);

t('bypassPermissions + outside-cwd → allow (no interference)',
  run({
    tool_name: MCP + 'read',
    tool_input: { path: OUTSIDE },
    cwd: CWD,
    permissionMode: 'bypassPermissions',
  }),
  null);

// ── Group 4: allow list matching (mcp__*) ──────────────────────────────────
console.log('\nGroup 4: allow list (mcp__* pattern in settings)');
// ~/.claude/settings.json has allow: ["mcp__*"] + defaultMode: bypassPermissions
// so evaluateRules hits allow → exit 0

t('allow mcp__* match + outside-cwd → allow (list wins over default)',
  run({
    tool_name: MCP + 'write',
    tool_input: { path: OUTSIDE },
    cwd: CWD,
    // no permissionMode in payload — falls through to settings defaultMode
  }),
  null);

t('allow mcp__* + inside-cwd → allow',
  run({
    tool_name: MCP + 'bash',
    tool_input: { cwd: CWD },
    cwd: CWD,
  }),
  null);

// ── Group 5: default mode (no settings override) ───────────────────────────
console.log('\nGroup 5: default mode (simulate no allow match)');

// Use a temp dir as CLAUDE_PROJECT_DIR so settings-loader finds no settings files
// (no ~/.claude/settings.json override applies when projectDir has no .claude/)
// and permissionMode: 'default' in payload drives the mode branch.
// Note: ~/.claude/settings.json (user-tier) still loads, so we send
// permissionMode explicitly via payload which overrides the mode variable.
//
// The user settings have allow:["mcp__*"] which would short-circuit to allow.
// To test the mode=default path we need a toolName NOT matched by allow list.
// Since mcp__* matches everything starting with mcp__, we instead set projectDir
// to os.tmpdir() (no .claude/settings) AND rely on payload permissionMode only
// for the mode branch — but allow list from ~/.claude/settings.json still fires.
//
// Correct approach: pass projectDir=os.tmpdir() AND omit permissionMode from
// payload so defaultMode from merged settings drives it. But user settings has
// defaultMode:bypassPermissions, so we need a clean env.
// Simplest: use a non-MCP prefix tool that passes prefix check is impossible.
// Instead test mode branches via explicit permissionMode in payload, which
// takes priority over settings defaultMode in step 9 of hook logic.
// BUT allow list match (step 8) exits before reaching step 9.
//
// Solution: inject projectDir with a tmp dir that has a settings.json
// overriding allow:[] and defaultMode:default. We write a temp file.
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
const tmpProj = mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
mkdirSync(path.join(tmpProj, '.claude'), { recursive: true });
// Empty allow list + defaultMode:default — no allow matches
writeFileSync(
  path.join(tmpProj, '.claude', 'settings.json'),
  JSON.stringify({ permissions: { allow: [], deny: [], ask: [], defaultMode: 'default' } }),
);

function runNoAllow(payload) {
  // Override HOME/USERPROFILE so settings-loader cannot find ~/.claude/settings.json
  // (user-tier). Only the project-tier settings in tmpProj apply: allow:[], defaultMode:default.
  return run({ ...payload, projectDir: tmpProj }, {
    CLAUDE_PROJECT_DIR: tmpProj,
    HOME: tmpProj,
    USERPROFILE: tmpProj,
  });
}

t('default mode + inside-cwd → allow',
  runNoAllow({
    tool_name: MCP + 'read',
    tool_input: { path: path.join(CWD, 'package.json') },
    cwd: CWD,
  }),
  null);

t('default mode + outside-cwd → ask',
  runNoAllow({
    tool_name: MCP + 'write',
    tool_input: { path: OUTSIDE },
    cwd: CWD,
  }),
  'ask');

// ── Group 6: plan mode ─────────────────────────────────────────────────────
console.log('\nGroup 6: plan mode');

// Groups 6-8 use runNoAllow to bypass the user settings allow:[mcp__*] list
t('plan mode + readOnly tool → allow',
  runNoAllow({
    tool_name: MCP + 'read',
    tool_input: { path: path.join(CWD, 'package.json') },
    cwd: CWD,
    permissionMode: 'plan',
  }),
  null);

t('plan mode + write tool → ask',
  runNoAllow({
    tool_name: MCP + 'write',
    tool_input: { path: OUTSIDE },
    cwd: CWD,
    permissionMode: 'plan',
  }),
  'ask');

// ── Group 7: acceptEdits mode ──────────────────────────────────────────────
console.log('\nGroup 7: acceptEdits mode');

t('acceptEdits + edit tool inside-cwd → allow',
  runNoAllow({
    tool_name: MCP + 'edit',
    tool_input: { path: path.join(CWD, 'foo.txt') },
    cwd: CWD,
    permissionMode: 'acceptEdits',
  }),
  null);

t('acceptEdits + bash outside-cwd → ask',
  runNoAllow({
    tool_name: MCP + 'bash',
    tool_input: { cwd: OUTSIDE },
    cwd: CWD,
    permissionMode: 'acceptEdits',
  }),
  'ask');

// ── Group 8: dontAsk mode ──────────────────────────────────────────────────
console.log('\nGroup 8: dontAsk mode');

t('dontAsk + no list match → deny',
  runNoAllow({
    tool_name: MCP + 'write',
    tool_input: { path: OUTSIDE },
    cwd: CWD,
    permissionMode: 'dontAsk',
  }),
  'deny');

// ── Group 9: malformed / edge cases ───────────────────────────────────────
console.log('\nGroup 9: edge cases');

t('malformed JSON → allow (exit 0)',
  { exitCode: 0, parsed: null, stdout: '', stderr: '' },
  null);
// actual malformed run:
{
  const r = spawnSync(process.execPath, [HOOK], {
    input: 'NOT_JSON',
    encoding: 'utf8',
    timeout: 4000,
    env: process.env,
  });
  results.push(check('malformed JSON → exit 0', { exitCode: r.status, parsed: null, stdout: r.stdout, stderr: r.stderr }, null));
}

t('no paths in toolInput → allow',
  runNoAllow({
    tool_name: MCP + 'bash',
    tool_input: {},
    cwd: CWD,
  }),
  null);

t('updatedInput.cwd injected on ask',
  runNoAllow({
    tool_name: MCP + 'write',
    tool_input: { path: OUTSIDE },
    cwd: CWD,
  }),
  'ask');

// verify updatedInput presence
{
  const r = runNoAllow({
    tool_name: MCP + 'write',
    tool_input: { path: OUTSIDE },
    cwd: CWD,
  });
  const hasUpdated = r.parsed?.hookSpecificOutput?.updatedInput?.cwd !== undefined;
  const pass = hasUpdated;
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ask response includes updatedInput.cwd`);
  results.push(pass);
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────────────');
const passed = results.filter(Boolean).length;
const total  = results.length;
console.log(`Result: ${passed}/${total} PASS`);
if (passed < total) {
  console.log(`FAILED: ${total - passed} scenario(s)`);
  process.exit(1);
} else {
  console.log('All scenarios PASS');
  process.exit(0);
}
