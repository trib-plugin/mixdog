'use strict';
/**
 * permission-evaluator.cjs
 * Reusable permission evaluation extracted from pre-mcp-sandbox.cjs.
 *
 * Permission priority: deny > ask > allow > mode-default
 *
 * Exported function:
 *   evaluatePermission({ toolName, toolInput, permissionMode, projectDir, userCwd })
 *   → { decision: 'allow'|'deny'|'ask', reason: string }
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { loadPermissions }               = require('./settings-loader.cjs');
const { evaluateRules, isReadOnlyTool } = require('./permission-rules.cjs');

// ── constants ─────────────────────────────────────────────────────────────────

const MCP_PREFIX = 'mcp__plugin_mixdog_mixdog__';

// edit/write-class tools allowed under acceptEdits mode
const EDIT_WRITE_TOOLS = new Set([
  'edit', 'write', 'apply_patch',
]);

// ── hard-deny patterns (bypass-proof) ────────────────────────────────────────
// These patterns are evaluated BEFORE mode checks, including bypassPermissions.
// They cover UNC paths and dangerous absolute system locations.

const HARD_DENY_PATH_PATTERNS = [
  // UNC network paths (\\server\share)
  /^\\\\/,
  // Unix system sensitive dirs
  /^\/etc\//i,
  /^\/etc$/i,
  /^\/proc\//i,
  /^\/proc$/i,
  /^\/sys\//i,
  /^\/sys$/i,
  /^\/boot\//i,
  /^\/boot$/i,
  /^\/dev\//i,
  /^\/dev$/i,
  // Windows system dirs (various drive letters)
  /^[a-z]:[/\\]windows[/\\]/i,
  /^[a-z]:[/\\]windows$/i,
  /^[a-z]:[/\\]program files[/\\]/i,
  /^[a-z]:[/\\]program files$/i,
  /^[a-z]:[/\\]program files \(x86\)[/\\]/i,
  /^[a-z]:[/\\]program files \(x86\)$/i,
  /^[a-z]:[/\\]system32/i,
];

/**
 * Returns true if any extracted path matches a hard-deny pattern.
 * Called before mode checks — bypass-proof.
 */
function isHardDenyPath(rawPaths) {
  for (const p of rawPaths) {
    if (!p || typeof p !== 'string') continue;
    // UNC check on raw value (before normalization strips leading slashes)
    if (/^\\\\/.test(p)) return true;
    // Normalize for platform-independent matching
    let norm;
    try { norm = path.resolve(p); } catch { norm = p; }
    norm = norm.replace(/\\/g, '/');
    for (const re of HARD_DENY_PATH_PATTERNS) {
      if (re.test(p) || re.test(norm)) return true;
    }
  }
  return false;
}

module.exports._isHardDenyPath = isHardDenyPath; // exported for tests

// ── path helpers ──────────────────────────────────────────────────────────────

function normalizePath(p) {
  if (!p || typeof p !== 'string') return null;
  if (/^\\\\/.test(p)) return p;

  if (path.sep === '\\') {
    const posixDriveMatch = p.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (posixDriveMatch) {
      const drive = posixDriveMatch[1].toUpperCase();
      const rest = (posixDriveMatch[2] || '').replace(/\//g, '\\');
      p = drive + ':' + (rest || '\\');
    }
  }

  try {
    return path.isAbsolute(p) ? path.normalize(p) : null;
  } catch {
    return null;
  }
}

function resolveCandidate(p, baseCwd) {
  if (!p || typeof p !== 'string') return null;
  if (/^\\\\/.test(p)) return p;
  try {
    const normalized = normalizePath(p);
    if (normalized !== null && path.isAbsolute(normalized)) return normalized;
    return path.resolve(baseCwd, p);
  } catch {
    return null;
  }
}

function isInside(child, parent) {
  const norm = p => p.replace(/[/\\]+$/, '');
  let c = norm(child);
  let p2 = norm(parent);
  if (path.sep === '\\') { c = c.toLowerCase(); p2 = p2.toLowerCase(); }
  return c === p2 || c.startsWith(p2 + '\\') || c.startsWith(p2 + '/');
}

function deepestExistingAncestor(p) {
  let cur = p;
  while (cur) {
    try { if (fs.existsSync(cur) && fs.statSync(cur).isDirectory()) return cur; } catch { /* walk */ }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.dirname(p);
}

function extractPaths(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];

  const tool = toolName.startsWith(MCP_PREFIX)
    ? toolName.slice(MCP_PREFIX.length)
    : toolName;
  const candidates = [];

  const push = (...vals) => {
    for (const v of vals) { if (v && typeof v === 'string') candidates.push(v); }
  };

  switch (tool) {
    case 'bash':
    case 'bash_session':
      push(toolInput.cwd);
      break;
    case 'bridge':
      push(toolInput.cwd);
      push(toolInput.file);
      break;
    case 'apply_patch': {
      push(toolInput.base_path);
      const patch = toolInput.patch;
      if (typeof patch === 'string') {
        for (const m of patch.matchAll(/^\+\+\+\s+b\/(.+)$/gm)) push(m[1]);
        for (const m of patch.matchAll(/^---\s+a\/(.+)$/gm)) push(m[1]);
      }
      break;
    }
    case 'read': {
      if (toolInput.path && typeof toolInput.path === 'string') push(toolInput.path);
      push(toolInput.cwd);
      if (Array.isArray(toolInput.reads)) toolInput.reads.forEach(r => push(r?.path));
      if (Array.isArray(toolInput.path))  toolInput.path.forEach(p => {
        if (p && typeof p === 'string') push(p);
        else if (p && typeof p === 'object' && p.path) push(p.path);
      });
      break;
    }
    default:
      if (toolInput.path && typeof toolInput.path === 'string') push(toolInput.path);
      push(toolInput.file, toolInput.cwd, toolInput.base_path);
      if (Array.isArray(toolInput.path))  toolInput.path.forEach(p => push(p));
      if (Array.isArray(toolInput.reads)) toolInput.reads.forEach(r => push(r?.path));
      if (Array.isArray(toolInput.edits)) toolInput.edits.forEach(e => push(e?.path));
      if (Array.isArray(toolInput.writes)) toolInput.writes.forEach(w => push(w?.path));
      break;
  }

  return [...new Set(candidates)];
}

// ── main evaluator ────────────────────────────────────────────────────────────

/**
 * Evaluate whether a tool call should be allowed, denied, or asked.
 *
 * @param {object} opts
 * @param {string}  opts.toolName       — full tool name (mcp__ prefix expected for mixdog tools)
 * @param {object}  opts.toolInput      — tool arguments object
 * @param {string}  [opts.permissionMode] — override mode ('bypassPermissions', 'acceptEdits',
 *                                         'plan', 'dontAsk', 'default'). Falls back to
 *                                         settings defaultMode.
 * @param {string}  [opts.projectDir]   — project root for settings lookup
 * @param {string}  [opts.userCwd]      — user working directory for path resolution
 * @returns {{ decision: 'allow'|'deny'|'ask', reason: string, updatedInput?: object }}
 */
function evaluatePermission({ toolName, toolInput, permissionMode, projectDir, userCwd }) {
  const name  = typeof toolName  === 'string' ? toolName  : '';
  const input = (toolInput && typeof toolInput === 'object') ? toolInput : {};
  const cwd   = (typeof userCwd === 'string' && userCwd) ? userCwd : process.cwd();

  // 0. Hard-deny: bypass-proof path check (UNC, dangerous system paths).
  //    Evaluated before any mode check — even bypassPermissions cannot override.
  const rawPathsHard = extractPaths(name, input);
  if (isHardDenyPath(rawPathsHard)) {
    return { decision: 'deny', reason: `Tool '${name}' targets a protected system path.` };
  }

  // Plugin source tree: read-only exemption.
  // Paths inside CLAUDE_PLUGIN_ROOT are always allowed for read-class tools.
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || '';
  const rawPaths0 = extractPaths(name, input);
  if (pluginRoot && isReadOnlyTool(name) && rawPaths0.length > 0 &&
      rawPaths0.every(p => { const r = resolveCandidate(p, cwd); return r && isInside(r, pluginRoot); })) {
    return { decision: 'allow', reason: 'Plugin source tree read-only access allowed.' };
  }

  // 1. Extract candidate paths
  const rawPaths = rawPaths0;

  // 2. Resolve paths; find first outside-cwd hit
  let firstOutsidePath     = null;
  let firstOutsideResolved = null;

  for (const raw of rawPaths) {
    const resolved = resolveCandidate(raw, cwd);
    if (!resolved) continue;
    if (!isInside(resolved, cwd) && firstOutsidePath === null) {
      firstOutsidePath     = raw;
      firstOutsideResolved = resolved;
    }
  }

  // 3. Load merged settings
  const { allow, deny, ask, defaultMode } = loadPermissions(projectDir || cwd);

  // 4. Permission-list evaluation (deny > ask > allow)
  const listResult = evaluateRules(name, input, allow, deny, ask);

  if (listResult === 'deny') {
    return { decision: 'deny', reason: `Tool '${name}' blocked by deny rule.` };
  }
  if (listResult === 'ask') {
    const outsideReason = firstOutsidePath
      ? `Path '${firstOutsidePath}' is outside project sandbox (${cwd}).`
      : `Tool '${name}' requires explicit approval.`;
    const updatedInput = firstOutsideResolved
      ? { cwd: deepestExistingAncestor(firstOutsideResolved) }
      : undefined;
    return { decision: 'ask', reason: outsideReason, ...(updatedInput ? { updatedInput } : {}) };
  }
  if (listResult === 'allow') {
    return { decision: 'allow', reason: 'Matched allow rule.' };
  }

  // 5. Mode default (no list matched)
  // Settings-derived auto-approval modes take priority over a payload
  // 'default' so that a user-level bypassPermissions is never shadowed.
  const AUTO_MODES = new Set(['bypassPermissions', 'auto']);
  const mode = (AUTO_MODES.has(defaultMode) && !AUTO_MODES.has(permissionMode))
    ? defaultMode
    : (permissionMode || defaultMode || 'default');

  if (AUTO_MODES.has(mode)) {
    return { decision: 'allow', reason: 'bypassPermissions mode.' };
  }

  if (mode === 'acceptEdits') {
    const shortTool = name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
    if (isReadOnlyTool(name) || EDIT_WRITE_TOOLS.has(shortTool)) {
      return { decision: 'allow', reason: 'acceptEdits mode: read-only or edit/write tool.' };
    }
    if (firstOutsideResolved !== null) {
      return { decision: 'ask', reason: `Tool '${name}' is outside project sandbox in acceptEdits mode.` };
    }
    return { decision: 'allow', reason: 'acceptEdits mode: tool is inside project sandbox.' };
  }

  if (mode === 'plan') {
    if (isReadOnlyTool(name)) {
      return { decision: 'allow', reason: 'plan mode: read-only tool.' };
    }
    return { decision: 'ask', reason: `Tool '${name}' is not allowed in plan mode.` };
  }

  if (mode === 'dontAsk') {
    return { decision: 'deny', reason: `Tool '${name}' not matched by any allow rule (dontAsk mode).` };
  }

  // default / unknown mode
  if (firstOutsideResolved !== null) {
    return {
      decision: 'ask',
      reason: `Path '${firstOutsidePath}' is outside project sandbox (${cwd}). Approve to grant mcp access.`,
      updatedInput: { cwd: deepestExistingAncestor(firstOutsideResolved) },
    };
  }

  return { decision: 'allow', reason: 'default mode: tool is inside project sandbox.' };
}

module.exports = { evaluatePermission };
