'use strict';
// Command-specific exit-code semantics.
//
// Many CLI tools use exit codes for information rather than success/failure:
// `grep` returns 1 when there are no matches, `diff` returns 1 when files
// differ, `test` returns 1 when the condition is false. The default exit
// model in builtin.mjs treats every non-zero status as an error, which
// makes a benign "no matches found" surface as `[exit code: 1]` and the
// agent re-runs the command thinking it failed.
//
// interpretCommandResult returns whether the result should render an
// error marker, and an optional human-readable note that downgrades the
// non-zero exit to a benign signal.

const DEFAULT_SEMANTIC = (exitCode) => ({
  isError: exitCode !== 0,
  note: null,
});

const _SEMANTICS = new Map([
  // grep: 0=match, 1=no matches, 2+=error
  ['grep', (c) => ({ isError: c >= 2, note: c === 1 ? 'no matches' : null })],
  // ripgrep: same
  ['rg', (c) => ({ isError: c >= 2, note: c === 1 ? 'no matches' : null })],
  // ugrep (embedded): same
  ['ugrep', (c) => ({ isError: c >= 2, note: c === 1 ? 'no matches' : null })],
  // find: 0=ok, 1=partial (some dirs inaccessible), 2+=error
  ['find', (c) => ({ isError: c >= 2, note: c === 1 ? 'some directories were inaccessible' : null })],
  // bfs (embedded): same as find
  ['bfs', (c) => ({ isError: c >= 2, note: c === 1 ? 'some directories were inaccessible' : null })],
  // diff: 0=identical, 1=differences, 2+=error
  ['diff', (c) => ({ isError: c >= 2, note: c === 1 ? 'files differ' : null })],
  // test / [: 0=true, 1=false, 2+=error
  ['test', (c) => ({ isError: c >= 2, note: c === 1 ? 'condition is false' : null })],
  ['[', (c) => ({ isError: c >= 2, note: c === 1 ? 'condition is false' : null })],
  // cmp: 0=identical, 1=differ, 2+=error
  ['cmp', (c) => ({ isError: c >= 2, note: c === 1 ? 'files differ' : null })],
]);

// Heuristic: take the last segment of a pipeline (its exit code is what
// shells default to) and pull the base command. Skips env-var prefixes
// (`LANG=C grep ...`) and well-known wrapper commands (`env`, `setpriv`,
// `nice`, `stdbuf`, `chronic`, `time`, `timeout`) so the underlying
// program's semantics are recovered. Strips a leading subshell/group
// prefix (`$(grep ...)`, `{ grep; }`).
const _WRAPPER_COMMANDS = new Set([
  'env', 'setpriv', 'nice', 'stdbuf', 'chronic', 'time', 'timeout',
  'nohup', 'sudo', 'doas',
]);

function extractBaseCommand(command) {
  let s = String(command || '').trim();
  // Strip the surrounding subshell / group syntax so `$(grep ...)` or
  // `{ grep; }` reduce to `grep ...`.
  while (true) {
    const subMatch = s.match(/^\$\(\s*([\s\S]*?)\s*\)$/);
    if (subMatch) { s = subMatch[1].trim(); continue; }
    const grpMatch = s.match(/^\{\s*([\s\S]*?)\s*;?\s*\}$/);
    if (grpMatch) { s = grpMatch[1].trim(); continue; }
    break;
  }
  const segments = s.split(/[|;&]+/);
  const last = (segments[segments.length - 1] || '').trim();
  const tokens = last.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.includes('=')) { i++; continue; }
    if (_WRAPPER_COMMANDS.has(t)) { i++; continue; }
    // After timeout/sudo, the next token is often a flag or duration
    // value (e.g. `timeout 30 grep`); skip those too if they look like
    // a number or short flag.
    return t.replace(/^['"]|['"]$/g, '');
  }
  return '';
}

export function interpretCommandResult(command, exitCode) {
  const base = extractBaseCommand(command);
  const semantic = _SEMANTICS.get(base) || DEFAULT_SEMANTIC;
  return semantic(exitCode);
}
