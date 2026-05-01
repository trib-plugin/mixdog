/**
 * mixdog PreToolUse hook — MCP sandbox approval prompt
 *
 * When a mcp__plugin_mixdog_mixdog__* tool call targets a path OUTSIDE the
 * user project cwd, returns permissionDecision:"ask" so Claude Code shows its
 * native Allow / Deny / Allow Always / Deny Always prompt.
 * updatedInput injects `cwd` = deepest existing ancestor of the requested path
 * so mcp's isSafePath passes after the user clicks Allow.
 *
 * Hard-block (permissionDecision:"deny"):
 *   - UNC paths  (\\server\share)
 *   - Dangerous absolutes (/etc/shadow, /etc/passwd, C:\Windows\System32, …)
 *   - Parent-escape after normalization (resolved path still contains "..")
 *
 * On any parse / unexpected error → default allow (no output) + stderr warn.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── constants ─────────────────────────────────────────────────────────────────

const MCP_PREFIX = 'mcp__plugin_mixdog_mixdog__';

const DANGEROUS_ABSOLUTES = [
  /^[Cc]:[/\\]Windows[/\\]System32\b/i,
  /^[Cc]:[/\\]Windows[/\\]SysWOW64\b/i,
  /^\/etc\/shadow$/,
  /^\/etc\/passwd$/,
];

// ── helpers ───────────────────────────────────────────────────────────────────

/** Return true if the string looks like a UNC path (\\server\share). */
function isUNC(p) {
  return typeof p === 'string' && /^\\\\/.test(p);
}

/** Return true if resolved path contains a leftover ".." segment. */
function hasParentEscape(resolved) {
  return resolved.split(/[/\\]/).includes('..');
}

/** Return true if path matches any dangerous-absolute pattern. */
function isDangerous(resolved) {
  return DANGEROUS_ABSOLUTES.some(rx => rx.test(resolved));
}

/**
 * Normalize a path to a Windows absolute path on Windows hosts.
 * Handles both POSIX /c/foo and Windows C:\foo forms.
 * On POSIX hosts, no conversion needed.
 */
function normalizePath(p) {
  if (!p || typeof p !== 'string') return null;

  // UNC — do not normalize (will be hard-blocked)
  if (/^\\\\/.test(p)) return p;

  // On Windows: convert POSIX-style /X/... drive paths to X:\...
  if (path.sep === '\\') {
    const posixDriveMatch = p.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (posixDriveMatch) {
      const drive = posixDriveMatch[1].toUpperCase();
      const rest = (posixDriveMatch[2] || '').replace(/\//g, '\\');
      p = drive + ':' + (rest || '\\');
    }
  }

  try {
    return path.isAbsolute(p) ? path.normalize(p) : null; // relative returned as null — caller resolves
  } catch {
    return null;
  }
}

/**
 * Resolve a candidate path to absolute using baseCwd.
 * Returns null if p is not a usable string.
 */
function resolveCandidate(p, baseCwd) {
  if (!p || typeof p !== 'string') return null;

  // UNC — return as-is for hard-block detection
  if (/^\\\\/.test(p)) return p;

  try {
    let normalized = normalizePath(p);
    if (normalized !== null && path.isAbsolute(normalized)) return normalized;
    // relative path: resolve against baseCwd
    return path.resolve(baseCwd, p);
  } catch {
    return null;
  }
}

/**
 * Return true if `child` is inside (or equal to) `parent`.
 * Both must be normalized absolute paths.
 * Case-insensitive on Windows.
 */
function isInside(child, parent) {
  const normalize = p => p.replace(/[/\\]+$/, '');
  let c = normalize(child);
  let p = normalize(parent);

  if (path.sep === '\\') {
    c = c.toLowerCase();
    p = p.toLowerCase();
  }

  return c === p || c.startsWith(p + '\\') || c.startsWith(p + '/');
}

/**
 * Walk upward from `p` until we find a directory that exists on disk.
 * Returns the deepest existing ancestor (may be `p` itself if it exists).
 */
function deepestExistingAncestor(p) {
  let cur = p;
  while (cur) {
    try {
      if (fs.existsSync(cur) && fs.statSync(cur).isDirectory()) return cur;
    } catch { /* keep walking */ }
    const parent = path.dirname(cur);
    if (parent === cur) break; // filesystem root
    cur = parent;
  }
  return path.dirname(p); // fallback: immediate parent
}

/**
 * Extract candidate path strings from tool_input based on toolName.
 * Returns a (possibly empty) array of raw strings — NOT yet resolved.
 */
function extractPaths(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];

  const tool = toolName.slice(MCP_PREFIX.length); // e.g. "read", "bash"
  const candidates = [];

  const push = (...vals) => {
    for (const v of vals) {
      if (v && typeof v === 'string') candidates.push(v);
    }
  };

  switch (tool) {
    case 'bash':
    case 'bash_session':
      push(toolInput.cwd);
      break;

    case 'bridge':
      push(toolInput.cwd);
      break;

    case 'apply_patch': {
      push(toolInput.base_path);
      // parse path: lines from patch text (best-effort)
      const patch = toolInput.patch;
      if (typeof patch === 'string') {
        for (const m of patch.matchAll(/^\+\+\+\s+b\/(.+)$/gm)) push(m[1]);
        for (const m of patch.matchAll(/^---\s+a\/(.+)$/gm)) push(m[1]);
      }
      break;
    }

    case 'read': {
      // scalar path
      if (toolInput.path && typeof toolInput.path === 'string') push(toolInput.path);
      push(toolInput.cwd);
      // reads:[{path},...] array form
      const reads = toolInput.reads;
      if (Array.isArray(reads)) reads.forEach(r => push(r?.path));
      // path array form
      if (Array.isArray(toolInput.path)) toolInput.path.forEach(p => push(p));
      break;
    }

    default:
      // list / glob / grep / edit / write / code_graph / find_symbol and others
      if (toolInput.path && typeof toolInput.path === 'string') push(toolInput.path);
      push(toolInput.file, toolInput.cwd, toolInput.base_path);
      if (Array.isArray(toolInput.path)) toolInput.path.forEach(p => push(p));
      if (Array.isArray(toolInput.reads)) toolInput.reads.forEach(r => push(r?.path));
      if (Array.isArray(toolInput.edits)) toolInput.edits.forEach(e => push(e?.path));
      if (Array.isArray(toolInput.writes)) toolInput.writes.forEach(w => push(w?.path));
      break;
  }

  return [...new Set(candidates)];
}

// ── main ──────────────────────────────────────────────────────────────────────

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[pre-mcp-sandbox] Unexpected error: ${err.message}\n`);
    // default allow — emit nothing
    process.exit(0);
  }
});

function main() {
  // 1. Parse payload
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0); // malformed → default allow
    return;
  }

  const toolName = payload?.tool_name || payload?.toolName || '';
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
      try {
        const cwdFile = path.join(dataDir, 'user-cwd.txt');
        userCwdRaw = fs.readFileSync(cwdFile, 'utf8').trim();
      } catch { /* file may not exist */ }
    }
  }
  if (!userCwdRaw) userCwdRaw = process.cwd();

  // Normalize the cwd (handle POSIX /c/... on Windows)
  const normalizedCwdRaw = normalizePath(userCwdRaw) || userCwdRaw;
  const userCwd = path.isAbsolute(normalizedCwdRaw)
    ? path.normalize(normalizedCwdRaw)
    : path.resolve(normalizedCwdRaw);

  // 4. Extract candidate paths
  const rawPaths = extractPaths(toolName, toolInput);

  if (rawPaths.length === 0) {
    // No paths to check — allow
    process.exit(0);
    return;
  }

  // 5. Evaluate each candidate
  let denyReason = null;
  let firstOutsidePath = null; // raw string
  let firstOutsideResolved = null;

  for (const raw of rawPaths) {
    // Hard-block: UNC
    if (isUNC(raw)) {
      denyReason = `UNC path blocked: ${raw}`;
      break;
    }

    const resolved = resolveCandidate(raw, userCwd);
    if (!resolved) continue; // skip null (non-string / failed)

    // Hard-block: parent-escape after normalization
    if (hasParentEscape(resolved)) {
      denyReason = `Parent-escape path blocked: ${raw}`;
      break;
    }

    // Hard-block: dangerous absolute
    if (isDangerous(resolved)) {
      denyReason = `Dangerous path blocked: ${resolved}`;
      break;
    }

    // Sandbox check
    if (!isInside(resolved, userCwd) && firstOutsidePath === null) {
      firstOutsidePath = raw;
      firstOutsideResolved = resolved;
    }
  }

  // 6. Emit decision

  if (denyReason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyReason,
      },
    }));
    process.exit(0);
    return;
  }

  if (firstOutsideResolved !== null) {
    // Compute resolvedRoot = deepest existing ancestor of the outside path
    const resolvedRoot = deepestExistingAncestor(firstOutsideResolved);

    const reason =
      `Path '${firstOutsidePath}' is outside project sandbox (${userCwd}). ` +
      `Approve to grant mcp access.`;

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: reason,
        updatedInput: { ...toolInput, cwd: resolvedRoot },
      },
    }));
    process.exit(0);
    return;
  }

  // All paths inside sandbox — default allow (no output)
  process.exit(0);
}
