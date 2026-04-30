'use strict';
// Destructive command detector.
//
// Returns a short human-readable warning string when the command matches
// a known data-loss / hard-to-reverse pattern. Purely informational — the
// caller (case 'bash' in builtin.mjs) prepends the warning to the result
// envelope so the agent sees the risk inline. Does NOT block execution;
// hard blocks remain in BLOCKED_PATTERNS in builtin.mjs / bash-session.mjs.
//
// Pattern set mirrors Claude Code upstream
// (src/tools/BashTool/destructiveCommandWarning.ts:12). Shape: tuples of
// (regex, warning). First match wins.

const _PATTERNS = [
  // Git — data loss / history rewrite
  [/\bgit\s+reset\s+--hard\b/, 'may discard uncommitted changes'],
  [/\bgit\s+push\b[^;&|\n]*[ \t](--force|--force-with-lease|-f)\b/, 'may overwrite remote history'],
  [/\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/, 'may permanently delete untracked files'],
  [/\bgit\s+checkout\s+(--\s+)?\.[ \t]*($|[;&|\n])/, 'may discard all working tree changes'],
  [/\bgit\s+restore\s+(--\s+)?\.[ \t]*($|[;&|\n])/, 'may discard all working tree changes'],
  [/\bgit\s+stash[ \t]+(drop|clear)\b/, 'may permanently remove stashed changes'],
  [/\bgit\s+branch\s+(-D[ \t]|--delete\s+--force|--force\s+--delete)\b/, 'may force-delete a branch'],
  // Git — safety bypass
  [/\bgit\s+(commit|push|merge)\b[^;&|\n]*--no-verify\b/, 'may skip safety hooks'],
  [/\bgit\s+commit\b[^;&|\n]*--amend\b/, 'may rewrite the last commit'],
  // Filesystem
  [/(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/, 'may recursively force-remove files'],
  [/(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR]/, 'may recursively remove files'],
  [/(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f/, 'may force-remove files'],
  // Database
  [/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, 'may drop or truncate database objects'],
  [/\bDELETE\s+FROM\s+\w+[ \t]*(;|"|'|\n|$)/i, 'may delete all rows from a database table'],
  // Infrastructure
  [/\bkubectl\s+delete\b/, 'may delete Kubernetes resources'],
  [/\bterraform\s+destroy\b/, 'may destroy Terraform infrastructure'],
];

// Strip quoted spans + line comments before matching so a destructive
// pattern that appears only inside `git commit -m "rm -rf hint"` or
// after `# rm -rf todo` does not false-positive. We replace quoted spans
// with empty quotes (preserving structure but emptying content) instead
// of dropping them so positional separators (semicolon / pipe) downstream
// of a quoted span still anchor the patterns.
// Public alias — builtin.mjs imports this for quote/heredoc-aware
// BLOCKED_PATTERNS testing.
export function stripQuotedAndHeredoc(s) {
  return _stripQuotedSpans(s);
}

// Public alias for builtin.mjs to scan `bash -c '…'` payloads alongside
// the outer command when applying BLOCKED_PATTERNS.
export function extractShellCInner(s) {
  return _extractShellCInner(s);
}

function _stripQuotedSpans(s) {
  return String(s || '')
    // Heredocs first (their bodies can contain unescaped quotes that
    // would confuse the simpler quote scanners below). Match both
    // `<<TAG`, `<<-TAG`, `<<'TAG'`, `<<"TAG"`.
    .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, '<<HEREDOC>>')
    // POSIX single-quoted: everything literal up to the next single
    // quote (no backslash escapes inside per POSIX).
    .replace(/'[^']*'/g, "''")
    // Double-quoted: backslash escapes are honoured.
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    // Line comments.
    .replace(/#[^\n]*/g, '');
}

// Pull payload strings out of `bash -c '…'` / `sh -c "…"` etc so the
// pattern set can match destructive commands hidden inside a quoted
// span (which _stripQuotedSpans erases above as a single empty token).
function _extractShellCInner(s) {
  const out = [];
  const re = /\b(?:bash|sh|zsh|dash|ksh|ash)\s+(?:-[a-zA-Z]*c|--command)\s+(['"])([\s\S]*?)\1/g;
  let m;
  while ((m = re.exec(String(s || ''))) !== null) {
    out.push(m[2]);
  }
  return out;
}

export function getDestructiveCommandWarning(command) {
  const cleaned = _stripQuotedSpans(command);
  for (const [re, warning] of _PATTERNS) {
    if (re.test(cleaned)) return warning;
  }
  for (const inner of _extractShellCInner(command)) {
    const innerCleaned = _stripQuotedSpans(inner);
    for (const [re, warning] of _PATTERNS) {
      if (re.test(innerCleaned)) return warning;
    }
  }
  return null;
}
