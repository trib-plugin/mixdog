'use strict';
// Shell execution security policy — shared constants used by both
// destructive-warning.mjs (heuristic classifier) and bash-session.mjs
// (hard block list). Centralised here so the two files stay in sync
// without requiring manual "drift should be fixed in BOTH files" notes.
//
// These are documented security-policy allowlists, not heuristic
// classifiers: membership is explicit and reviewed on addition.

// Shells whose `-c` payloads must be recursively scanned for destructive
// commands. Expand when a new shell interpreter is supported.
export const SHELL_NAMES = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'ash',
]);

// Wrapper programs that transparently exec their first non-option argument.
// We peel these (and their option args) before reading the real command name.
export const WRAPPER_NAMES = new Set([
  'env', 'sudo', 'doas', 'nice', 'stdbuf', 'chronic', 'time', 'timeout',
  'nohup', 'setpriv', 'ionice', 'taskset',
]);

// Hard-block patterns shared by the stateless bash tool (builtin.mjs) and
// the persistent bash_session tool (bash-session.mjs). Adding a pattern
// here propagates to both without manual sync.
//
// These block outright data-destructive or system-destabilising operations
// that the agent must never execute regardless of context. Informational
// warnings (non-blocking) live in destructive-warning.mjs instead.
const _CMD_START = '(?:^|[;&|\\n(){}]\\s*|\\$[\\({]\\s*|[<>]\\(\\s*|`\\s*)';
export const BLOCKED_PATTERNS = [
  // rm -rf / rm -fr targeting root or home — covers split flags, --
  /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-[rR]\s+-[fF]|-[fF]\s+-[rR])(?:\s+--)?\s+[\/~]/i,
  /\bgit\s+push\s+--force/i,
  /\bgit\s+reset\s+--hard/i,
  /\bformat\s+[a-z]:/i,
  /\b(shutdown|reboot|halt)\b/i,
  /\bdel\s+\/[sfq]/i,
  new RegExp(_CMD_START + 'mkfs(?:\\.|\\b)', 'i'),
  new RegExp(_CMD_START + 'dd\\s+[^\\n]*\\bif=/dev/', 'i'),
  new RegExp(_CMD_START + 'diskpart\\b[^\\n]*\\bclean\\b', 'i'),
  /:\(\)\s*\{[^}]*:\|:&[^}]*\};\s*:/, // bash fork-bomb signature
];

export function isBlockedCommand(command) {
  for (const pat of BLOCKED_PATTERNS) {
    if (pat.test(command)) return true;
  }
  return false;
}
