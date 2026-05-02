'use strict';
/**
 * mixdog PreToolUse hook — MCP sandbox approval prompt (v2)
 *
 * Permission priority: deny > ask > allow > mode-default
 *
 * Settings are loaded from three tiers (project-local > project > user).
 * Permission lists are evaluated in deny → ask → allow order.
 * Mode default applies when no list matches:
 *   bypassPermissions         → exit 0 (no interference)
 *   acceptEdits               → readOnly tools + edit/write/apply_patch → exit 0;
 *                               other tools outside cwd → ask
 *   plan                      → readOnly tools → exit 0; others → ask
 *   dontAsk                   → deny (no list match = explicit deny)
 *   default / unknown         → outside-cwd → ask; updatedInput.cwd set to deepest existing ancestor
 *
 * On parse / unexpected error → exit 0 + stderr warn.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { evaluatePermission } = require('./lib/permission-evaluator.cjs');

// ── constants ─────────────────────────────────────────────────────────────────

const MCP_PREFIX = 'mcp__plugin_mixdog_mixdog__';

// ── output helpers ────────────────────────────────────────────────────────────

function emitDecision(decision, reason, updatedInput) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
  if (updatedInput !== undefined) {
    out.hookSpecificOutput.updatedInput = updatedInput;
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

// ── main ──────────────────────────────────────────────────────────────────────

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[pre-mcp-sandbox] Unexpected error: ${err.message}\n`);
    process.exit(0); // default allow on unexpected error
  }
});

function main() {
  // 1. Parse payload
  let payload;
  try { payload = JSON.parse(input); }
  catch {
    process.exit(0); // malformed → default allow
    return;
  }

  const toolName  = payload?.tool_name || payload?.toolName || '';
  const toolInput = payload?.tool_input ?? payload?.toolInput ?? {};

  // 2. Only handle mcp__plugin_mixdog_mixdog__* tools
  if (!toolName.startsWith(MCP_PREFIX)) {
    process.exit(0);
    return;
  }

  // 3. Resolve user cwd
  let userCwdRaw = payload?.cwd || '';
  if (!userCwdRaw) {
    const dataDir = process.env.CLAUDE_PLUGIN_DATA || '';
    if (dataDir) {
      try { userCwdRaw = fs.readFileSync(path.join(dataDir, 'user-cwd.txt'), 'utf8').trim(); } catch { /* ok */ }
    }
  }
  if (!userCwdRaw) userCwdRaw = process.cwd();

  const normCwdRaw = (userCwdRaw && path.sep === '\\')
    ? (() => { try { return path.normalize(userCwdRaw); } catch { return userCwdRaw; } })()
    : userCwdRaw;
  const userCwd = path.isAbsolute(normCwdRaw)
    ? path.normalize(normCwdRaw)
    : path.resolve(normCwdRaw);

  const projectDir = payload?.projectDir || payload?.project_dir ||
    process.env.CLAUDE_PROJECT_DIR || userCwd;
  const permissionMode = payload?.permissionMode || payload?.permission_mode || undefined;

  const { loadPermissions } = require('./lib/settings-loader.cjs');
  const settingsPerms = loadPermissions(projectDir);
  const effectiveMode = permissionMode || settingsPerms.defaultMode;

  // 4. Delegate to shared evaluator.
  //    bypass/auto modes still run the evaluator so that hard-deny rules
  //    (UNC paths, dangerous system paths) are enforced. Only 'ask' decisions
  //    are auto-approved under bypass; 'deny' is always respected.
  const evalResult = evaluatePermission({
    toolName,
    toolInput,
    permissionMode,
    projectDir,
    userCwd,
  });
  const { decision, reason, updatedInput } = evalResult;

  // Fast-path for bypass/auto mode AFTER evaluator (deny already returned above
  // if hard-deny matched; safe to skip ask/allow handling here).
  if (effectiveMode === 'bypassPermissions' || effectiveMode === 'auto') {
    if (decision === 'deny') {
      emitDecision('deny', reason);
      return;
    }
    // ask/allow → auto-approve under bypass
    process.exit(0);
    return;
  }

  if (decision === 'allow') {
    process.exit(0);
    return;
  }

  // For ask decisions in default mode, inject cwd into updatedInput so Claude
  // Code can show the resolved sandbox root in the approval dialog.
  // evaluatePermission returns updatedInput.cwd when firstOutsideResolved is set.
  if (decision === 'ask') {
    emitDecision('ask', reason, updatedInput);
    return;
  }

  emitDecision('deny', reason);
}
