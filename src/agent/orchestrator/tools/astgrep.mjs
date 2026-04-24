// ast-grep (sg) structural search / rewrite tools. Wraps the
// `sg` CLI (npm @ast-grep/cli) and exposes two MCP tools:
//
//   sg_search   — read-only structural search across files/dirs.
//   sg_rewrite  — pattern→rewrite transform. Dry-run by default (prints a
//                 unified diff); pass `apply: true` to actually write.
//
// Why a CLI wrap and not the @ast-grep/napi library? The CLI already
// handles .gitignore-driven walking, per-language parsing, the `--globs`
// filter, and unified-diff preview output — re-implementing those in
// Node would double the code size for no capability gain. The CLI is a
// single binary that starts in <50ms cold, so the wrapper tax is
// negligible.
//
// Binary resolution (see resolveSgBinary below):
//   1. Bundled `@ast-grep/cli` in the plugin's own node_modules — the
//      package's postinstall fetches a prebuilt platform binary and drops
//      it alongside its package.json, so `npm install` in the plugin dir
//      is enough. No global install step for users.
//   2. PATH-resolved `sg` as a fallback (legacy install path / globally
//      installed @ast-grep/cli).
//   3. Clean error naming both options when nothing is found.
//
// Language detection:
//   sg ships built-in extension tables (.js .jsx .ts .tsx .py .rs .go ...)
//   but does NOT map .mjs / .cjs to JavaScript. The bundled sgconfig.yml
//   (./sgconfig.yml, sibling file) patches this via `languageGlobs` and is
//   passed to every sg invocation with `--config`. This keeps detection
//   working regardless of the cwd the tool is called from — the caller's
//   project tree never needs its own sgconfig.yml.

import { exec, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve as pathResolve, isAbsolute, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  normalizeInputPath,
  normalizeOutputPath,
  isSafePath,
  invalidateBuiltinResultCache,
} from './builtin.mjs';
import { markCodeGraphDirtyPaths } from './code-graph.mjs';
import { getCapabilities } from '../../../shared/config.mjs';

const execAsync = promisify(exec);

const __dirname = dirname(fileURLToPath(import.meta.url));
const SGCONFIG_PATH = join(__dirname, 'sgconfig.yml');

// createRequire keeps `require.resolve` semantics (node_modules walk from
// this .mjs's location) available inside an ESM module.
const nodeRequire = createRequire(import.meta.url);

// On Windows the postinstall leaves `sg.exe` next to the package's
// package.json (the extensionless `sg` launcher is unlinked). On POSIX
// the binary is just `sg`. We prefer these names in order.
const SG_CANDIDATE_NAMES = process.platform === 'win32'
  ? ['sg.exe', 'sg.cmd', 'sg']
  : ['sg'];

// node_modules/.bin shim names as a secondary location. `npm` creates
// `.bin/sg`, `.bin/sg.cmd`, `.bin/sg.ps1` on Windows; just `.bin/sg`
// (symlink) on POSIX. We try these after the package-dir binary because
// the shim adds a layer of cmd-wrapping that isn't needed.
const SG_BIN_SHIM_NAMES = process.platform === 'win32'
  ? ['sg.cmd', 'sg.exe', 'sg']
  : ['sg'];

const SG_PATH_FALLBACK_NAMES = process.platform === 'win32'
  ? ['ast-grep.cmd', 'ast-grep.exe', 'ast-grep', 'sg.cmd', 'sg.exe', 'sg']
  : ['ast-grep', 'sg'];

// Cached resolution result. `undefined` = unresolved, `null` = resolved to
// the PATH fallback ('sg'), string = absolute binary path. A second cache
// slot (`_cache.error`) carries the "not found" sentinel so every call
// reports the same message instead of re-scanning the FS.
const _sgResolverCache = { resolved: undefined, error: null };

function findBundledSgPath() {
  // `require.resolve('@ast-grep/cli/package.json')` walks up from this
  // .mjs's node_modules chain. Works whether the plugin was installed
  // standalone (own node_modules) or hoisted (workspace root).
  let pkgPath;
  try {
    pkgPath = nodeRequire.resolve('@ast-grep/cli/package.json');
  } catch {
    return null;
  }
  const pkgDir = dirname(pkgPath);
  // The `bin` field in @ast-grep/cli package.json points at the launcher
  // filenames ({ sg: 'sg', 'ast-grep': 'ast-grep' }). After postinstall,
  // Windows replaces those with sg.exe / ast-grep.exe. We probe both.
  try {
    const pkg = nodeRequire('@ast-grep/cli/package.json');
    const sgBin = pkg?.bin?.sg;
    if (sgBin) {
      for (const candidate of [sgBin, `${sgBin}.exe`, `${sgBin}.cmd`]) {
        const full = join(pkgDir, candidate);
        if (existsSync(full)) return full;
      }
    }
  } catch {
    // Falls through to the directory probe below.
  }
  for (const name of SG_CANDIDATE_NAMES) {
    const full = join(pkgDir, name);
    if (existsSync(full)) return full;
  }
  return null;
}

function findNodeModulesBinShim() {
  // `.bin/sg` is what `npm` creates for every dependency's bin field.
  // We walk from the package's own package.json up to its parent
  // node_modules (the `.bin` sibling of `@ast-grep`).
  let pkgPath;
  try {
    pkgPath = nodeRequire.resolve('@ast-grep/cli/package.json');
  } catch {
    return null;
  }
  // pkgPath = .../node_modules/@ast-grep/cli/package.json
  //  dirname ×3 → .../node_modules
  const nodeModulesDir = dirname(dirname(dirname(pkgPath)));
  const binDir = join(nodeModulesDir, '.bin');
  for (const name of SG_BIN_SHIM_NAMES) {
    const full = join(binDir, name);
    if (existsSync(full)) return full;
  }
  return null;
}

function looksLikeAstGrepBinary(candidate) {
  if (!candidate) return false;
  try {
    const res = spawnSync(candidate, ['--help'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      env: process.env,
    });
    const text = `${res.stdout || ''}\n${res.stderr || ''}`;
    return /ast-grep/i.test(text);
  } catch {
    return false;
  }
}

// Returns either an absolute path (bundled binary) or the bare string
// 'sg' meaning "trust PATH". Throws a clean error when neither is usable.
function resolveSgBinary() {
  if (_sgResolverCache.resolved !== undefined) {
    if (_sgResolverCache.error) throw _sgResolverCache.error;
    return _sgResolverCache.resolved;
  }
  const bundled = findBundledSgPath();
  if (bundled && looksLikeAstGrepBinary(bundled)) {
    _sgResolverCache.resolved = bundled;
    return bundled;
  }
  const shim = findNodeModulesBinShim();
  if (shim && looksLikeAstGrepBinary(shim)) {
    _sgResolverCache.resolved = shim;
    return shim;
  }
  for (const candidate of SG_PATH_FALLBACK_NAMES) {
    if (!looksLikeAstGrepBinary(candidate)) continue;
    _sgResolverCache.resolved = candidate;
    return candidate;
  }
  const err = Object.assign(
    new Error('ast-grep binary not found. Run `npm install` in the plugin dir or install `@ast-grep/cli` globally.'),
    { code: 'ESGNOTFOUND' });
  _sgResolverCache.error = err;
  throw err;
}

// Escape hatch for tests: lets them drop the cached resolution so
// findBundledSgPath / findNodeModulesBinShim re-run against (e.g.) a
// monkey-patched nodeRequire or a freshly restored fixture tree.
export function __resetSgResolverCache() {
  _sgResolverCache.resolved = undefined;
  _sgResolverCache.error = null;
}

// Exposed for tests — lets assertions check "did we pick the bundled
// binary?" without shelling out and parsing stderr.
export function __resolveSgBinaryForTest() {
  return { bundled: findBundledSgPath(), shim: findNodeModulesBinShim() };
}

// Keep in sync with builtin.mjs's SHELL_OUTPUT_MAX_CHARS. Not imported
// because builtin.mjs doesn't export it — duplicating the number is
// cheaper than widening the public surface for one constant.
const SHELL_OUTPUT_MAX_CHARS = 30_000;
const EXEC_TIMEOUT_MS = 30_000;

// Default ignores are covered by sg's built-in .gitignore walking. We add
// a small safety list for directories that commonly aren't gitignored
// (e.g. vendored libs checked into the tree) and would otherwise make
// a bare search walk the whole node_modules tree. ast-grep accepts the
// same `!glob` exclude syntax ripgrep uses via --globs.
const DEFAULT_EXCLUDE_GLOBS = [
  '!node_modules/**',
  '!.git/**',
  '!dist/**',
  '!build/**',
  '!.next/**',
  '!coverage/**',
  '!.turbo/**',
  '!.venv/**',
  '!__pycache__/**',
];

function capOutput(content) {
  const s = typeof content === 'string' ? content : String(content ?? '');
  if (s.length <= SHELL_OUTPUT_MAX_CHARS) return s;
  const head = s.slice(0, SHELL_OUTPUT_MAX_CHARS);
  const tail = s.slice(SHELL_OUTPUT_MAX_CHARS);
  const remainingLines = (tail.match(/\n/g) || []).length + 1;
  return `${head}\n\n... [${remainingLines} lines truncated] ...`;
}

// Shell-quote a single argument. Node's `exec` picks the platform shell:
// cmd.exe on Windows, /bin/sh elsewhere. The two have different escape
// rules — cmd.exe doesn't interpret `$` / `` ` `` / `\` inside double
// quotes (only `"` needs handling, via `""`), while /bin/sh does interpret
// `$` / `` ` `` / `\` even inside double quotes, so those must be
// backslash-escaped. ast-grep patterns routinely contain `$` (metavariables)
// and file paths on Windows contain `\`, so getting this right matters —
// an earlier version backslash-escaped on every platform and mangled
// Windows paths into `c:\\P...` which cmd.exe passed through literally.
function quote(a) {
  const s = String(a);
  if (process.platform === 'win32') {
    // cmd.exe: `"` inside "..." is represented as `""`. That's the only
    // transformation needed — every other character (including `\`, `$`,
    // and backticks) is literal inside double quotes.
    return `"${s.replace(/"/g, '""')}"`;
  }
  // POSIX sh: `"`, `\`, `$`, `` ` `` all need escaping inside "...".
  return `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

function normalizeGlobsArg(globs) {
  if (globs == null) return [];
  if (Array.isArray(globs)) return globs.filter(g => typeof g === 'string' && g);
  if (typeof globs === 'string') return [globs];
  return [];
}

function resolvePath(cwd, p) {
  const norm = normalizeInputPath(p);
  return isAbsolute(norm) ? pathResolve(norm) : pathResolve(cwd, norm);
}

function scopeCheck(label, rawPath, cwd) {
  const norm = normalizeInputPath(rawPath);
  let allowHome = false;
  try { allowHome = getCapabilities().homeAccess === true; } catch { allowHome = false; }
  if (!isSafePath(norm, cwd, { allowHome })) {
    throw Object.assign(
      new Error(`${label}: path outside allowed scope — ${normalizeOutputPath(norm)}`),
      { code: 'EOUTSIDE', path: normalizeOutputPath(norm) });
  }
}

function buildCommonArgs({ pattern, lang, globs }) {
  const args = ['run', '--config', SGCONFIG_PATH, '--color', 'never', '-p', pattern];
  if (lang) args.push('--lang', lang);
  // Always append default excludes first so caller-supplied include globs
  // can override them (ast-grep: later globs win, matching gitignore).
  for (const g of DEFAULT_EXCLUDE_GLOBS) args.push('--globs', g);
  for (const g of normalizeGlobsArg(globs)) args.push('--globs', g);
  return args;
}

// Detect "binary literally not found" from a child_process.exec error.
// cmd.exe: "is not recognized as an internal or external command"
// /bin/sh: "sg: command not found" / "sg: not found"
// Node errno: ENOENT when the shell itself rejects the command.
function isBinaryMissingError(err) {
  if (!err) return false;
  if (err.code === 'ENOENT') return true;
  const msg = String(err.stderr || err.message || '');
  return /not recognized as an internal or external|command not found|: not found/i.test(msg);
}

async function runSg(args, cwd) {
  const bin = resolveSgBinary();
  // Pass the resolved absolute path through quote() so paths with spaces
  // survive cmd.exe / /bin/sh word splitting. Bare 'sg' (PATH fallback)
  // quoting to `"sg"` is still a no-op for the shell.
  const cmd = quote(bin) + ' ' + args.map(quote).join(' ');
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
      // 10 MB — generous so a whole-tree scan emitting many matches
      // doesn't blow out before we can head-limit. capOutput still
      // truncates the text we hand back to the model.
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: stdout || '', stderr: stderr || '', code: 0 };
  } catch (err) {
    // `sg` exits 0 when nothing matches (search) and when dry-run preview
    // has no changes (rewrite). A non-zero exit is either a real error
    // (bad pattern, unknown language) or a signal from the CLI. Surface
    // stderr + stdout so the caller can diagnose without guessing.
    if (isBinaryMissingError(err) && bin === 'sg') {
      // Only throw the install-hint error when we fell back to PATH and
      // PATH came up empty. If the resolver picked a bundled path and it
      // still spawn-failed, a different thing is wrong — surface the raw
      // error rather than mislead the user into reinstalling.
      throw Object.assign(
        new Error('ast-grep binary not found. Run `npm install` in the plugin dir or install `@ast-grep/cli` globally.'),
        { code: 'ESGNOTFOUND' });
    }
    const code = typeof err?.code === 'number' ? err.code : -1;
    const stdout = err?.stdout || '';
    const stderr = err?.stderr || err?.message || '';
    return { stdout, stderr, code };
  }
}

async function sgSearch(args, cwd) {
  const { pattern, path, lang, globs } = args || {};
  if (!pattern || typeof pattern !== 'string') {
    throw new Error('sg_search: "pattern" is required (string)');
  }
  if (!path || typeof path !== 'string') {
    throw new Error('sg_search: "path" is required (file or directory)');
  }
  scopeCheck('sg_search', path, cwd);
  const absPath = resolvePath(cwd, path);

  const context = Number.isFinite(args.context) && args.context > 0
    ? Math.floor(args.context)
    : 0;
  const headLimitRaw = args.head_limit;
  const headLimit = headLimitRaw === 0
    ? Infinity
    : (Number.isFinite(headLimitRaw) && headLimitRaw > 0 ? Math.floor(headLimitRaw) : 100);

  const cliArgs = buildCommonArgs({ pattern, lang, globs });
  // --heading never keeps every line prefixed with `path:line:` so output
  // is trivially sliceable. -C gives symmetric before/after context.
  cliArgs.push('--heading', 'never');
  if (context > 0) cliArgs.push('-C', String(context));
  cliArgs.push(absPath);

  const { stdout, stderr, code } = await runSg(cliArgs, cwd);
  if (code !== 0 && code !== 1 && stderr) {
    // code 1 on sg means "no matches" — treat as empty. Anything else
    // with stderr content is a real error worth surfacing.
    return `Error: ${stderr.trim().slice(0, 500)}`;
  }
  const rawLines = stdout.split('\n').filter(Boolean);
  if (rawLines.length === 0) return '(no matches)';
  const limited = headLimit === Infinity ? rawLines : rawLines.slice(0, headLimit);
  const remaining = rawLines.length - limited.length;
  const suffix = remaining > 0 ? `\n... [${remaining} more entries]` : '';
  // Normalise path separators for consistency with the grep tool's output.
  const normalized = limited.map(line => {
    if (process.platform !== 'win32') return line;
    const from = /^[A-Za-z]:/.test(line) ? 2 : 0;
    const colonIdx = line.indexOf(':', from);
    if (colonIdx === -1) return line.replace(/\\/g, '/');
    return line.slice(0, colonIdx).replace(/\\/g, '/') + line.slice(colonIdx);
  });
  return capOutput(normalized.join('\n') + suffix);
}

async function sgRewrite(args, cwd) {
  const { pattern, rewrite, path, lang, globs, apply, confirm } = args || {};
  if (!pattern || typeof pattern !== 'string') {
    throw new Error('sg_rewrite: "pattern" is required (string)');
  }
  if (typeof rewrite !== 'string') {
    throw new Error('sg_rewrite: "rewrite" is required (string; empty string allowed for deletions)');
  }
  if (!path || typeof path !== 'string') {
    throw new Error('sg_rewrite: "path" is required (file or directory)');
  }
  // Require an explicit confirm token when apply:true is set. The rewrite
  // is non-atomic per-file (see the ATOMICITY LIMITATION block below) and
  // can crash mid-run, leaving files half-written. The confirm gate makes
  // accidental apply in automation infeasible — the caller must affirm.
  if (apply === true && confirm !== 'APPLY REWRITE') {
    return 'Error: sg_rewrite apply:true requires confirm: "APPLY REWRITE" (non-atomic per-file rewrite; see description for crash-sensitive paths)';
  }
  scopeCheck('sg_rewrite', path, cwd);
  const absPath = resolvePath(cwd, path);

  // ------------------------------------------------------------------
  // ATOMICITY LIMITATION (known; see worker-28 brief, v0.6.248):
  //
  // `sg -U` rewrites matched files in-place using the ast-grep CLI's
  // own writer. It does NOT expose a staging-directory flag (ast-grep
  // 0.25 has no `--output` or `--dry-run-to-dir` option — only `--json`
  // for preview, which doesn't give us byte-identical replacement
  // content for every matched file). A crash during `sg -U` can
  // therefore still leave individual files half-written.
  //
  // Workarounds considered and rejected:
  //   1. Run `--json`, read back each original file, compute the post-
  //      rewrite content ourselves, and atomicWrite each — ast-grep's
  //      JSON output reports match ranges but not the assembled output,
  //      so we'd be duplicating the rewrite engine. Fragile.
  //   2. Copy the whole target tree to a temp dir, run `sg -U` there,
  //      then atomic-rename each modified file — doubles disk IO and
  //      fails on large repos. Not a clean win.
  //
  // Until ast-grep adds a staging-dir flag (upstream issue to file),
  // `sg_rewrite apply:true` remains NON-ATOMIC per-file. Callers should
  // prefer dry-run preview + explicit `edit` for
  // crash-sensitive paths. TODO(mixdog): revisit when ast-grep
  // ships `--output-dir` or equivalent.
  // ------------------------------------------------------------------

  const cliArgs = buildCommonArgs({ pattern, lang, globs });
  cliArgs.push('-r', rewrite);
  if (apply === true) {
    // -U applies every rewrite without the interactive prompt. Without
    // it, sg would stall waiting on stdin.
    cliArgs.push('-U');
  }
  cliArgs.push(absPath);

  const { stdout, stderr, code } = await runSg(cliArgs, cwd);
  if (code !== 0 && code !== 1 && stderr) {
    return `Error: ${stderr.trim().slice(0, 500)}`;
  }

  const body = stdout.trim();
  if (apply === true) {
    // `sg -U` prints its `Applied N changes` summary on *stderr*, not
    // stdout, and leaves stdout empty. Combine the two so the caller
    // sees the count; if both are empty it genuinely matched nothing.
    const err = (stderr || '').trim();
    if (!body && !err) return '(no changes applied)';
    // Cache invalidation — mirrors patch.mjs / bash-session.mjs /
    // builtin.mjs write paths. sg's apply output does not enumerate which
    // files were touched, so fall back to a conservative global
    // invalidate: better noise than stale `read`/`grep` results or stale
    // code-graph edges. Best-effort — never let cache bookkeeping break
    // the tool return.
    try { invalidateBuiltinResultCache(); } catch { /* ignore */ }
    try { markCodeGraphDirtyPaths(cwd, [absPath]); } catch { /* ignore */ }
    const WARNING = '⚠ sg_rewrite apply is NOT atomic per-file — a crash during the `sg -U` run can leave individual files partially written. For crash-sensitive paths prefer dry-run preview + explicit `edit` (which uses atomic rename).\n\n';
    return WARNING + capOutput([body, err].filter(Boolean).join('\n'));
  }

  // Dry-run: sg already prints a unified-diff-ish preview. Forward it
  // verbatim so the model sees exactly what `apply: true` would write.
  if (!body) return '(no matches — nothing to rewrite)';
  return capOutput(body);
}

// Tool definitions consumed by build-tools-manifest. Shape mirrors the other
// orchestrator tool modules — title / annotations / description / inputSchema —
// so server.mjs can route dispatches without extra wiring.
export const ASTGREP_TOOL_DEFS = [
  {
    name: 'sg_search',
    title: 'AST-Grep Search',
    annotations: { title: 'AST-Grep Search', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Structural (AST-level) code search via ast-grep. Matches syntax shapes, not text — e.g. `function $NAME($$$)` finds every function declaration regardless of whitespace / comments / arg count. Prefer over `grep` for code constructs (class declarations, try-catch blocks, `foo(...).then(...)` chains) rather than literal strings. Args: `pattern`, `path`, optional `lang` (auto-detect from extension; .mjs/.cjs mapped to JavaScript via bundled sgconfig.yml).',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'ast-grep pattern. Use `$NAME` for single captures, `$$$` for sequences, `$$_` for single anonymous. Example: `function $NAME($$$) { $$$ }`.' },
        path: { type: 'string', description: 'File or directory to search. Absolute or cwd-relative.' },
        lang: { type: 'string', description: 'Language override (typescript|javascript|python|rust|go|c|cpp|java|ruby|php|html|css|json|yaml|...). Omit to let ast-grep auto-detect from the file extension.' },
        globs: { description: 'gitignore-style include / exclude glob(s). Prefix with `!` to exclude. Later globs take precedence over earlier ones.', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        context: { type: 'number', description: 'Lines of context around each match (equivalent to ripgrep -C). Default 0.' },
        head_limit: { type: 'number', description: 'Max output lines. Default 100, 0 = unlimited.' },
      },
      required: ['pattern', 'path'],
    },
  },
  {
    name: 'sg_rewrite',
    title: 'AST-Grep Rewrite',
    annotations: { title: 'AST-Grep Rewrite', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Structural rewrite via ast-grep. Match a syntax pattern + substitute rewrite template — safer than text search-and-replace because matches respect the language AST (no string literals / comments / unrelated-scope rebinding). **Dry-run by default**; pass `apply:true` to write. Example: `pattern: "$OBJ.foo($$$)"` + `rewrite: "$OBJ?.foo($$$)"` converts every `x.foo(...)` call site to optional chaining.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'ast-grep pattern to match (same syntax as sg_search).' },
        rewrite: { type: 'string', description: 'Rewrite template. Metavariables from the pattern (`$NAME`, `$$$`) are substituted. Empty string deletes the match.' },
        path: { type: 'string', description: 'File or directory to rewrite. Absolute or cwd-relative.' },
        lang: { type: 'string', description: 'Language override. See sg_search.' },
        globs: { description: 'Include / exclude glob(s). See sg_search.', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        apply: { type: 'boolean', description: 'Apply the rewrite and write to disk. Default false (dry-run preview only). When true, `confirm: "APPLY REWRITE"` is also required.' },
        confirm: { type: 'string', description: 'Required when apply:true — must equal exactly "APPLY REWRITE". Gates against accidental non-atomic file rewrites.' },
      },
      required: ['pattern', 'rewrite', 'path'],
    },
  },
];

export async function executeAstGrepTool(name, args, cwd) {
  const effectiveCwd = cwd || process.cwd();
  switch (name) {
    case 'sg_search': return sgSearch(args, effectiveCwd);
    case 'sg_rewrite': return sgRewrite(args, effectiveCwd);
    default: throw new Error(`Unknown ast-grep tool: ${name}`);
  }
}
