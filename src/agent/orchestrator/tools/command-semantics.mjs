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
  // test / [ deliberately excluded — exit 1 there is the assertion
  // signal, not informational. Downgrading would silence real failures
  // in `test x = y && do_thing` style scripts.
  // cmp: 0=identical, 1=differ, 2+=error
  ['cmp', (c) => ({ isError: c >= 2, note: c === 1 ? 'files differ' : null })],
]);

// Heuristic: take the last segment of a pipeline (its exit code is what
// shells default to) and pull the base command. Skips env-var prefixes
// (`LANG=C grep ...`) and well-known wrapper commands so the underlying
// program's semantics are recovered. Strips a leading subshell/group
// prefix (`$(grep ...)`, `{ grep; }`).
//
// Per-wrapper option arity: each entry maps a wrapper name to either
// the literal flags that take an argument (`-n` for nice, `--signal`
// for timeout) or '*' to greedily eat any flag after the wrapper. The
// arity model prevents `nice -n 10 grep` from consuming `10` as the
// underlying program.
const _WRAPPER_ARITY = new Map([
  ['env', { withValue: new Set(), simpleFlags: true }],
  ['sudo', { withValue: new Set(['-u', '-g', '--user', '--group', '-p', '--prompt', '-C', '--close-from']), simpleFlags: true }],
  ['doas', { withValue: new Set(['-u', '-C']), simpleFlags: true }],
  ['nice', { withValue: new Set(['-n', '--adjustment']), simpleFlags: true }],
  ['stdbuf', { withValue: new Set(['-i', '-o', '-e', '--input', '--output', '--error']), simpleFlags: true }],
  ['chronic', { withValue: new Set(), simpleFlags: true }],
  ['time', { withValue: new Set(['-f', '--format', '-o', '--output']), simpleFlags: true }],
  ['timeout', { withValue: new Set(['-s', '--signal', '-k', '--kill-after']), simpleFlags: true, takesDuration: true }],
  ['nohup', { withValue: new Set(), simpleFlags: true }],
  ['setpriv', { withValue: new Set(['--reuid', '--regid', '--clear-groups', '--keep-groups', '--init-groups', '--groups', '--inh-caps', '--ambient-caps', '--bounding-set', '--securebits', '--pdeathsig', '--selinux-label', '--apparmor-profile', '--reset-env']), simpleFlags: true }],
  ['ionice', { withValue: new Set(['-c', '-n', '-p', '-P', '-u']), simpleFlags: true }],
  ['taskset', { withValue: new Set(['-p', '--pid', '-c', '--cpu-list']), simpleFlags: true }],
]);

// Quote-aware tokenizer (single + double quote spans stay intact).
function _tokenize(s) {
  const out = [];
  let cur = '', i = 0;
  const src = String(s || '');
  while (i < src.length) {
    const c = src[i];
    if (c === "'") { const e = src.indexOf("'", i + 1); if (e === -1) { cur += src.slice(i); break; } cur += src.slice(i, e + 1); i = e + 1; continue; }
    if (c === '"') { let j = i + 1; while (j < src.length) { if (src[j] === '\\' && j + 1 < src.length) { j += 2; continue; } if (src[j] === '"') break; j++; } if (j >= src.length) { cur += src.slice(i); break; } cur += src.slice(i, j + 1); i = j + 1; continue; }
    if (c === '\\' && i + 1 < src.length) { cur += src[i] + src[i + 1]; i += 2; continue; }
    if (c === ' ' || c === '\t' || c === '\n') { if (cur) { out.push(cur); cur = ''; } i++; continue; }
    if (c === ';' || c === '&' || c === '|') {
      if (cur) { out.push(cur); cur = ''; }
      if (src[i + 1] === c) { out.push(c + c); i += 2; } else { out.push(c); i++; }
      continue;
    }
    cur += c; i++;
  }
  if (cur) out.push(cur);
  return out;
}

function _lastSegment(tokens) {
  let lastSep = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === ';' || t === '&' || t === '&&' || t === '|' || t === '||') lastSep = i;
  }
  return tokens.slice(lastSep + 1);
}

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
  const allTokens = _tokenize(s);
  const tokens = _lastSegment(allTokens);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    const arity = _WRAPPER_ARITY.get(t);
    if (arity) {
      i++;
      while (i < tokens.length) {
        const u = tokens[i];
        if (arity.withValue.has(u)) { i += 2; continue; }
        if (u.startsWith('--') && u.includes('=')) { i++; continue; }
        if (arity.simpleFlags && /^-[A-Za-z]+$/.test(u)) { i++; continue; }
        if (arity.simpleFlags && u.startsWith('--') && !u.includes('=')) { i++; continue; }
        if (arity.takesDuration && /^\d+[smhd]?$/.test(u)) { i++; continue; }
        if (arity.takesDuration && /^\d+m\d+s?$/.test(u)) { i++; continue; }
        break;
      }
      continue;
    }
    return t.replace(/^['"]|['"]$/g, '');
  }
  return '';
}

export function interpretCommandResult(command, exitCode) {
  const base = extractBaseCommand(command);
  const semantic = _SEMANTICS.get(base) || DEFAULT_SEMANTIC;
  return semantic(exitCode);
}
