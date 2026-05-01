'use strict';
// Destructive command detector.
//
// Returns a short human-readable warning string when the command matches
// a known data-loss / hard-to-reverse pattern. Purely informational — the
// caller (case 'bash' in builtin.mjs) prepends the warning to the result
// envelope so the agent sees the risk inline. Does NOT block execution;
// hard blocks remain in BLOCKED_PATTERNS in builtin.mjs / bash-session.mjs.

const _SHELL_NAMES = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);
const _WRAPPER_NAMES = new Set([
  'env', 'sudo', 'doas', 'nice', 'stdbuf', 'chronic', 'time', 'timeout',
  'nohup', 'setpriv', 'ionice', 'taskset',
]);

export function stripQuotedAndHeredoc(s) { return _stripQuotedSpans(s); }
export function extractShellCInner(s) { return _extractShellCInner(s); }

function _stripQuotedSpans(s) {
  return String(s || '')
    .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, '<<HEREDOC>>')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/#[^\n]*/g, '');
}

// Heredoc bodies (shell-exec contexts route the body through scanning).
function _extractHeredocBodies(s) {
  const out = [];
  const re = /<<-?\s*['"]?(\w+)['"]?([\s\S]*?)\n\1\b/g;
  let m;
  while ((m = re.exec(String(s || ''))) !== null) out.push(m[2]);
  return out;
}

// Shell-aware tokenizer. Quoted spans stay intact; separators become
// their own token so callers can split pipeline segments cleanly.
function _tokenize(s) {
  const t = [], src = String(s || '');
  let cur = '', i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'") { const e = src.indexOf("'", i + 1); if (e === -1) { cur += src.slice(i); break; } cur += src.slice(i, e + 1); i = e + 1; continue; }
    if (c === '"') { let j = i + 1; while (j < src.length) { if (src[j] === '\\' && j + 1 < src.length) { j += 2; continue; } if (src[j] === '"') break; j++; } if (j >= src.length) { cur += src.slice(i); break; } cur += src.slice(i, j + 1); i = j + 1; continue; }
    if (c === '\\' && i + 1 < src.length) { cur += src[i] + src[i + 1]; i += 2; continue; }
    if (c === ' ' || c === '\t') { if (cur) { t.push(cur); cur = ''; } i++; continue; }
    if (c === '\n' || c === ';') { if (cur) { t.push(cur); cur = ''; } t.push(c); i++; continue; }
    if (c === '&' || c === '|') { if (cur) { t.push(cur); cur = ''; } if (src[i + 1] === c) { t.push(c + c); i += 2; } else { t.push(c); i++; } continue; }
    cur += c; i++;
  }
  if (cur) t.push(cur);
  return t;
}

function _splitSegments(tokens) {
  const segs = [], SEP = new Set([';', '&', '&&', '|', '||', '\n']);
  let cur = [];
  for (const t of tokens) { if (SEP.has(t)) { if (cur.length) segs.push(cur); cur = []; } else cur.push(t); }
  if (cur.length) segs.push(cur);
  return segs;
}

function _stripQuotes(t) {
  if (t.length >= 2) { const a = t[0], b = t[t.length - 1]; if ((a === "'" && b === "'") || (a === '"' && b === '"')) return t.slice(1, -1); }
  return t;
}

// Skip env-var assignments and known wrapper commands (with their
// option arguments) so the underlying program reaches classification.
function _peelWrappers(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    if (_WRAPPER_NAMES.has(t)) {
      i++;
      while (i < tokens.length && (/^[-+]/.test(tokens[i]) || /^\d+[smhd]?$/.test(tokens[i]) || /^\d+m\d+s?$/.test(tokens[i]))) i++;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

// Extract `-c <payload>` (and `--command <payload>`) for shell invocations.
// Walks options including combined short flags like `-lc`, `-ic`, `-ec`.
function _extractShellCInner(s) {
  const out = [];
  const tokens = _tokenize(s);
  const segs = _splitSegments(tokens);
  for (const seg of segs) {
    const peeled = _peelWrappers(seg);
    if (!peeled.length || !_SHELL_NAMES.has(peeled[0])) continue;
    for (let i = 1; i < peeled.length; i++) {
      const t = peeled[i];
      if (t === '-c' || t === '--command' || /^-[a-zA-Z]+c$/.test(t)) {
        const arg = peeled[i + 1];
        if (arg) out.push(_stripQuotes(arg));
        break;
      }
      if (t === '--rcfile' || t === '--init-file' || t === '-O' || t === '+O') { i++; continue; }
      if (t.startsWith('-') || t.startsWith('+')) continue;
      break;
    }
  }
  return out;
}

// rm: detect -r/-R/--recursive AND -f/--force across split or combined
// short-flag tokens.
function _classifyRm(args) {
  let r = false, f = false;
  for (const t of args) {
    if (t === '--') break;
    if (t === '--recursive' || t === '-r' || t === '-R') { r = true; continue; }
    if (t === '--force' || t === '-f') { f = true; continue; }
    if (/^-[a-zA-Z]+$/.test(t)) { if (/[rR]/.test(t)) r = true; if (/f/.test(t)) f = true; continue; }
    if (t.startsWith('-')) continue;
    break;
  }
  if (r && f) return 'may recursively force-remove files';
  if (r) return 'may recursively remove files';
  if (f) return 'may force-remove files';
  return null;
}

// git: skip global options (-C path, -c key=val, --git-dir=..., --no-pager
// etc.) before reading the subcommand.
function _classifyGit(args) {
  let i = 0;
  while (i < args.length) {
    const t = args[i];
    if (t === '-C' || t === '-c') { i += 2; continue; }
    if (/^--(git-dir|work-tree|namespace)(=|$)/.test(t)) { i += t.includes('=') ? 1 : 2; continue; }
    if (t === '--no-pager' || t === '--paginate' || t === '--bare' || t === '--exec-path' || /^--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs$/.test(t)) { i++; continue; }
    if (/^--exec-path=|^--list-cmds=/.test(t)) { i++; continue; }
    break;
  }
  const sub = args[i]; if (!sub) return null;
  const rest = args.slice(i + 1);
  if (sub === 'reset' && rest.includes('--hard')) return 'may discard uncommitted changes';
  if (sub === 'push' && rest.some(t => t === '--force' || t === '-f' || t === '--force-with-lease' || t.startsWith('--force-with-lease=') || /^\+[\w/.-]+/.test(t))) return 'may overwrite remote history';
  if (sub === 'clean') {
    const dry = rest.some(t => t === '-n' || t === '--dry-run' || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(t));
    const force = rest.some(t => t === '-f' || t === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t));
    if (!dry && force) return 'may permanently delete untracked files';
  }
  if ((sub === 'checkout' || sub === 'restore') && rest.includes('.')) return 'may discard all working tree changes';
  if (sub === 'stash' && (rest[0] === 'drop' || rest[0] === 'clear')) return 'may permanently remove stashed changes';
  if (sub === 'branch' && (rest.includes('-D') || (rest.includes('--delete') && rest.includes('--force')))) return 'may force-delete a branch';
  if ((sub === 'commit' || sub === 'push' || sub === 'merge') && rest.includes('--no-verify')) return 'may skip safety hooks';
  if (sub === 'commit' && rest.includes('--amend')) return 'may rewrite the last commit';
  return null;
}

const _KUBECTL_VAL = new Set(['--context','--cluster','--namespace','-n','--user','--kubeconfig','--token','--server','--as','--as-group','--certificate-authority','--client-certificate','--client-key','--request-timeout','--cache-dir','--v','-v','--profile','--profile-output']);

function _classifyKubectl(args) {
  let i = 0;
  while (i < args.length) {
    const t = args[i];
    if (_KUBECTL_VAL.has(t)) { i += 2; continue; }
    if (t.startsWith('--') && t.includes('=')) { i++; continue; }
    if (t.startsWith('-')) { i++; continue; }
    break;
  }
  return args[i] === 'delete' ? 'may delete Kubernetes resources' : null;
}

function _classifyTerraform(args) {
  let i = 0;
  while (i < args.length) {
    const t = args[i];
    if (/^-chdir=/.test(t) || t === '-help' || t === '-version' || t === '-h') { i++; continue; }
    break;
  }
  return args[i] === 'destroy' ? 'may destroy Terraform infrastructure' : null;
}

function _classifyDd(args) {
  for (const t of args) {
    if (/^if=\/dev\//.test(t)) return 'may read from a raw device';
    if (/^of=\/dev\//.test(t)) return 'may write to a raw device';
  }
  return null;
}

const _DB_PATTERNS = [
  [/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, 'may drop or truncate database objects'],
  [/\bDELETE\s+FROM\s+\w+[ \t]*(;|"|'|\n|$)/i, 'may delete all rows from a database table'],
];

function _classifySegment(tokens) {
  const peeled = _peelWrappers(tokens);
  if (!peeled.length) return null;
  const cmd = peeled[0], rest = peeled.slice(1);
  if (cmd === 'rm') return _classifyRm(rest);
  if (cmd === 'git') return _classifyGit(rest);
  if (cmd === 'kubectl') return _classifyKubectl(rest);
  if (cmd === 'terraform') return _classifyTerraform(rest);
  if (cmd === 'dd') return _classifyDd(rest);
  if (cmd === 'rmdir' || cmd === 'rd') {
    const hasS = rest.some(t => /^\/s$/i.test(t));
    const hasDriveRoot = rest.some(t => /^[A-Za-z]:\\?$/.test(t));
    if (hasS && hasDriveRoot) return 'may recursively remove a drive root';
  }
  return null;
}

export function getDestructiveCommandWarning(command) {
  const raw = String(command || '');
  // Per-statement DB scan (split on `;`, `&&`, `||`, `|`, `\n`) so a
  // destructive statement past a separator still surfaces.
  const cleaned = _stripQuotedSpans(raw);
  for (const stmt of cleaned.split(/[;&|\n]+/)) {
    for (const [re, warning] of _DB_PATTERNS) if (re.test(stmt)) return warning;
  }
  // Tokenized walk per pipeline segment.
  const segs = _splitSegments(_tokenize(raw));
  for (const seg of segs) {
    const peeled = _peelWrappers(seg);
    if (!peeled.length) continue;
    if (_SHELL_NAMES.has(peeled[0])) {
      for (const inner of _extractShellCInner(seg.join(' '))) {
        const w = getDestructiveCommandWarning(inner);
        if (w) return w;
      }
      for (const body of _extractHeredocBodies(raw)) {
        const w = getDestructiveCommandWarning(body);
        if (w) return w;
      }
      continue;
    }
    const w = _classifySegment(seg);
    if (w) return w;
  }
  for (const inner of _extractShellCInner(raw)) {
    const w = getDestructiveCommandWarning(inner);
    if (w) return w;
  }
  return null;
}
