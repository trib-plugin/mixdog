import { exec, spawn, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, statSync, existsSync, createReadStream, readdirSync, mkdirSync, openSync, readSync, closeSync, renameSync, unlinkSync, realpathSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { readFile } from 'fs/promises';
import { createInterface } from 'readline';
import { promisify } from 'util';
import * as nodeUtil from 'node:util';
import { homedir } from 'os';
import { createHash, randomBytes } from 'crypto';
import { getPluginData } from '../config.mjs';
import { markCodeGraphDirtyPaths } from './code-graph.mjs';
import { getCapabilities } from '../../../shared/config.mjs';
import { getAbortSignalForSession } from '../session/abort-lookup.mjs';
import { execShellCommand, stripAnsi as _shellStripAnsi } from './shell-command.mjs';
import { wrapCommandWithSnapshot } from './shell-snapshot.mjs';
import { interpretCommandResult } from './command-semantics.mjs';
import { getDestructiveCommandWarning, stripQuotedAndHeredoc, extractShellCInner } from './destructive-warning.mjs';
const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// User-cwd persistence bridge: hook writes user-cwd.txt on SessionStart so
// the MCP server (spawned from cache dir) resolves the correct sandbox root.
// ---------------------------------------------------------------------------
let _cachedUserCwd = undefined; // undefined = not yet resolved; null = absent
function _resolveDefaultUserCwd() {
    if (_cachedUserCwd !== undefined) return _cachedUserCwd;
    try {
        const txt = readFileSync(join(process.env.CLAUDE_PLUGIN_DATA || '', 'user-cwd.txt'), 'utf8').trim();
        _cachedUserCwd = txt || null;
    } catch {
        _cachedUserCwd = null;
    }
    return _cachedUserCwd;
}

// ANSI / VT control sequence stripper. Node v19.8+ ships a battle-tested
// implementation that handles CSI + OSC + DCS edge cases; older runtimes
// fall back to a regex covering CSI (ESC [ ... final-byte) and OSC
// (ESC ] ... BEL | ESC \\ | ST). Captured on bash tool output so progress
// bars / coloured diagnostics from CLIs (rg, cargo, npm, pytest) don't
// reach the model as noise that burns tokens and confuses downstream
// tooling. Function form of `.replace` is used to dodge the B35
// substitution-pattern foot-gun.
const _ANSI_REGEX = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\u0007|\u001B\\|\u009C))/g;
const _stripAnsi = typeof nodeUtil.stripVTControlCharacters === 'function'
    ? (s) => nodeUtil.stripVTControlCharacters(s)
    : (s) => s.replace(_ANSI_REGEX, () => '');
function stripAnsi(s) {
    if (typeof s !== 'string' || s.length === 0) return s;
    return _stripAnsi(s);
}
import { resolve, normalize, isAbsolute, relative, dirname, basename, extname, join, sep } from 'path';

// --- Atomic file write helper ---
//
// A plain `writeFileSync(target, content)` is NOT crash-safe: the kernel
// opens the target in O_TRUNC mode which zeroes the old bytes *before* the
// new bytes arrive. If the process dies (or the SSE stream hangs while a
// buffered bridge worker is mid-write) we're left with a 0-byte or
// truncated file on disk and the old content is gone.
//
// Fix: write to a tempfile in the same directory (so `rename` is guaranteed
// atomic on the same filesystem per POSIX / MSDN semantics), fsync the fd
// to force the data to stable storage, close the fd, then `rename` the
// tempfile over the target in one step. A crash at any point leaves
// either the old content intact (if rename hasn't happened yet) or the
// fully-new content (rename is atomic) — never a half-written file.
//
// Windows rename quirk: `MoveFileEx` can fail EACCES / EBUSY / EPERM when
// the destination has another open handle (antivirus, indexing service,
// another process with the file held). We retry up to 3 times with 50ms
// spacing on those specific error codes. Non-transient failures bail and
// clean up the tempfile so no residue is left behind.
//
// Tempfile naming: `.<basename>.mixdog-tmp-<8hex>` — the leading dot hides
// it from most listing tools and the 8-hex random suffix guarantees no
// collision between concurrent callers writing to adjacent paths.
//
// Exported so patch.mjs (and any future mutation tool) can reuse the
// same atomic primitive instead of re-rolling it.
const WINDOWS_RENAME_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const WINDOWS_RENAME_RETRY_MAX = 3;
const WINDOWS_RENAME_RETRY_DELAY_MS = 50;

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function atomicWrite(targetPath, content, { mode, signal, sessionId, flags } = {}) {
    let resolvedSignal = signal;
    if (!resolvedSignal && sessionId) {
        try { resolvedSignal = await getAbortSignalForSession(sessionId); } catch { resolvedSignal = null; }
    }
    const _abortReason = () => {
        const r = resolvedSignal?.reason;
        if (r instanceof Error) return r;
        if (typeof r === 'string' && r) return new Error(r);
        return new Error('atomicWrite aborted');
    };
    if (resolvedSignal?.aborted) throw _abortReason();

    const dir = dirname(targetPath);
    const rnd = randomBytes(4).toString('hex');
    const tmp = join(dir, `.${basename(targetPath)}.mixdog-tmp-${rnd}`);
    let effectiveMode = mode;
    if (effectiveMode === undefined) {
        try {
            const st = statSync(targetPath);
            effectiveMode = st.mode & 0o777;
        } catch { /* target doesn't exist — use default */ }
    }
    if (effectiveMode === undefined) effectiveMode = 0o644;

    let fh = null;
    try {
        fh = await fsPromises.open(tmp, 'w', effectiveMode);
        if (typeof _atomicWriteOverride === 'function') {
            await _atomicWriteOverride(fh, content, tmp);
        } else {
            await fh.writeFile(content);
        }
        await fh.sync();
    } catch (writeErr) {
        try { if (fh) await fh.close(); } catch { /* already closed */ }
        try { await fsPromises.unlink(tmp); } catch { /* already gone */ }
        throw writeErr;
    }
    try { await fh.close(); } catch (closeErr) {
        try { await fsPromises.unlink(tmp); } catch { /* already gone */ }
        throw closeErr;
    }

    // O_EXCL no-clobber: if caller requested wx semantics, atomically verify
    // the target does not exist by opening it exclusively. On EEXIST a racing
    // writer beat us; clean up the tmp and throw so the caller aborts.
    if (flags === 'wx') {
        let excl = null;
        try {
            excl = await fsPromises.open(targetPath, 'wx');
            await excl.close();
        } catch (exclErr) {
            if (excl) try { await excl.close(); } catch { /* already closed */ }
            try { await fsPromises.unlink(tmp); } catch { /* already gone */ }
            throw Object.assign(
                new Error(`create target already exists (race detected): ${targetPath}`),
                { code: 'EEXIST', __skip: true }
            );
        }
    }

    // Abort that arrived during the write phase: drop the tempfile and
    // throw so the caller sees a clean cancellation rather than a
    // half-published rename.
    if (resolvedSignal?.aborted) {
        try { await fsPromises.unlink(tmp); } catch { /* already gone */ }
        throw _abortReason();
    }

    const renameFn = typeof _atomicRenameOverride === 'function'
        ? _atomicRenameOverride
        : (src, dst) => fsPromises.rename(src, dst);
    let lastErr = null;
    const maxAttempts = process.platform === 'win32' ? WINDOWS_RENAME_RETRY_MAX : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            await renameFn(tmp, targetPath);
            return;
        } catch (err) {
            lastErr = err;
            const code = err && err.code;
            if (process.platform === 'win32' && WINDOWS_RENAME_RETRY_CODES.has(code) && attempt < maxAttempts - 1) {
                await _sleep(WINDOWS_RENAME_RETRY_DELAY_MS);
                continue;
            }
            break;
        }
    }
    try { await fsPromises.unlink(tmp); } catch { /* already gone */ }
    throw lastErr;
}

// Test hook — tests monkeypatch this to simulate rename failures without
// touching fsPromises.rename globally (which would affect unrelated callers).
// Production path: `null` means "use real fsPromises.rename". Assigning a
// function here makes atomicWrite call it instead, so a test can throw an
// ENOSPC / EACCES / synthetic error on demand.
let _atomicRenameOverride = null;
export function __setAtomicRenameOverrideForTest(fn) { _atomicRenameOverride = fn; }
let _atomicWriteOverride = null;
export function __setAtomicWriteOverrideForTest(fn) { _atomicWriteOverride = fn; }

function resolveShell() {
    if (process.platform !== 'win32') return { shell: '/bin/sh', shellArg: '-c' };
    const explicit = process.env.CLAUDE_CODE_SHELL;
    if (explicit && existsSync(explicit)) return { shell: explicit, shellArg: '-c' };
    const envShell = process.env.SHELL;
    if (envShell && (envShell.includes('bash') || envShell.includes('zsh')) && existsSync(envShell)) {
        return { shell: envShell, shellArg: '-c' };
    }
    const fallbacks = [
        'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
        'C:\\msys64\\usr\\bin\\bash.exe',
        'C:\\cygwin64\\bin\\bash.exe',
    ];
    for (const candidate of fallbacks) {
        if (existsSync(candidate)) return { shell: candidate, shellArg: '-c' };
    }
    return { shell: process.env.ComSpec || 'cmd.exe', shellArg: '/c' };
}

export function windowsPathToPosixPath(winPath) {
    if (typeof winPath !== 'string') return winPath;
    // UNC:  \\server\share  ->  //server/share
    if (winPath.startsWith('\\\\')) return winPath.replace(/\\/g, '/');
    // Drive letter:  C:\Users\foo  ->  /C/Users/foo  (case preserved)
    const m = winPath.match(/^([a-zA-Z]):[\\\/]/);
    if (m) return `/${m[1]}/${winPath.slice(3).replace(/\\/g, '/')}`;
    // Relative or unrecognised shape: unchanged
    return winPath;
}

export function posixPathToWindowsPath(posixPath) {
    if (process.platform !== 'win32') return posixPath;  // safety guard — Linux paths like /c/Users are valid absolute paths
    if (typeof posixPath !== 'string') return posixPath;
    // Cygwin:  /cygdrive/c/...  ->  c:\...  (case preserved)
    const cyg = posixPath.match(/^\/cygdrive\/([a-zA-Z])\//);
    if (cyg) return `${cyg[1]}:\\${posixPath.slice(11).replace(/\//g, '\\')}`;
    // MSYS/Git Bash:  /c/Users/...  ->  c:\Users\...  (case preserved)
    const m = posixPath.match(/^\/([a-zA-Z])\//);
    if (m) return `${m[1]}:\\${posixPath.slice(3).replace(/\//g, '\\')}`;
    // UNC:  //server/share  ->  \\server\share
    if (posixPath.startsWith('//')) return posixPath.replace(/\//g, '\\');
    // Relative or unrecognised shape: unchanged
    return posixPath;
}

export function normalizeInputPath(p) {
    if (typeof p !== 'string') return p;
    let out = p;
    // `~` expansion — callers can pass `~/.claude/...` without hardcoding
    // the user's home. Matches Claude Code's expandPath semantics so MCP
    // tool args stay portable across machines. Bare `~` and `~\` also
    // handled for Windows-quoted strings. `~user/...` (named-home) is NOT
    // expanded — POSIX-only and rarely used in MCP call sites.
    if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
        out = homedir() + out.slice(1);
    }
    if (process.platform === 'win32') {
        const looksPosixDrive = /^\/[a-zA-Z]\//.test(out);
        const looksCygdrive = /^\/cygdrive\/[a-zA-Z]\//.test(out);
        const looksUnc = out.startsWith('//');
        if (looksPosixDrive || looksCygdrive || looksUnc) {
            out = posixPathToWindowsPath(out);
        }
    }
    try { out = out.normalize('NFC'); } catch { /* ignore */ }
    return out;
}

function normalizeSearchPattern(p) {
    if (typeof p !== 'string') return p;
    try { return p.normalize('NFC'); } catch { return p; }
}

// Normalise output paths for display: on Windows, unify all separators to
// forward slash so mixed-slash strings don't reach the model. Native Windows
// APIs accept forward slashes too, so this is a purely cosmetic (and
// downstream copy-paste friendly) normalisation.
export function normalizeOutputPath(p) {
    if (typeof p !== 'string') return p;
    if (process.platform !== 'win32') return p;
    // Forward-slash unify + drive letter uppercase. LSP / fileURLToPath
    // returns `c:/...` lowercase, but every other tool emits `C:/...`
    // uppercase — this single point keeps the convention consistent.
    return p.replace(/\\/g, '/').replace(/^([a-z]):/, (_, d) => d.toUpperCase() + ':');
}

// Grep output lines shaped as "<path>:<lineno>:<content>" (content mode),
// "<path>:<count>" (count mode), or bare "<path>" (files_with_matches).
// Only the path portion should have separators swapped; content that
// happens to contain a backslash (regex escapes, string literals) must
// survive intact. Drive-letter colon at position 1 is skipped when
// locating the first path/value delimiter.
function normalizeGrepLine(line) {
    if (process.platform !== 'win32') return line;
    const searchFrom = /^[A-Za-z]:/.test(line) ? 2 : 0;
    // rg emits three shapes after any optional drive-letter prefix:
    //   match:    path:lineNo:content  (output_mode content default, count)
    //   context:  path-lineNo-content  (-A / -B / -C context lines)
    //   summary:  path                 (files_with_matches mode)
    // Path itself may contain `-`, so we cannot pick the first dash; the
    // line-number is always digits surrounded by the same delimiter on
    // both sides. Match `:N:` or `-N-` to find the path/lineNo split.
    // Without this, dash-context lines normalised the entire line as path
    // and content with `\` (e.g. `queries\.slice`) got corrupted.
    const delim = line.slice(searchFrom).match(/([:\-])(\d+)\1/);
    if (!delim) {
        const colonIdx = line.indexOf(':', searchFrom);
        if (colonIdx === -1) return line.replace(/\\/g, '/');
        return line.slice(0, colonIdx).replace(/\\/g, '/') + line.slice(colonIdx);
    }
    const splitIdx = searchFrom + delim.index;
    return line.slice(0, splitIdx).replace(/\\/g, '/') + line.slice(splitIdx);
}

function _primaryIdentifierPattern(patterns) {
    if (!Array.isArray(patterns) || patterns.length !== 1) return null;
    const token = String(patterns[0] || '').trim();
    return /^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(token) ? token : null;
}

function _parseGrepContentLine(line) {
    const text = String(line || '');
    if (!text || text === '--' || text.startsWith('... [')) return null;
    const searchFrom = /^[A-Za-z]:/.test(text) ? 2 : 0;
    const firstColon = text.indexOf(':', searchFrom);
    if (firstColon === -1) return null;
    const secondColon = text.indexOf(':', firstColon + 1);
    if (secondColon === -1) return null;
    const path = text.slice(0, firstColon);
    const lineNo = Number(text.slice(firstColon + 1, secondColon));
    if (!Number.isFinite(lineNo)) return null;
    const content = text.slice(secondColon + 1).trim();
    return { path, lineNo, content };
}

function _buildGrepContentSummary(lines, patterns) {
    const token = _primaryIdentifierPattern(patterns);
    if (!token) return '';
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declRe = new RegExp(`\\b(?:const|let|var|function|class|interface|type|enum|export)\\b[^\\n]*\\b${escaped}\\b`);
    const exactRe = new RegExp(`\\b${escaped}\\b`);
    const scored = [];
    for (const line of lines) {
        const parsed = _parseGrepContentLine(line);
        if (!parsed) continue;
        if (!exactRe.test(parsed.content)) continue;
        let score = 0;
        if (declRe.test(parsed.content)) score += 5;
        if (parsed.content.startsWith('export ')) score += 2;
        if (parsed.content.startsWith('import ')) score -= 1;
        if (parsed.content.length <= 140) score += 1;
        if (/\/(?:scripts?|test|tests|__tests__|bench|dev)\//i.test(parsed.path.replace(/\\/g, '/'))) score -= 3;
        scored.push({ ...parsed, score });
    }
    if (!scored.length) return '';
    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.lineNo - b.lineNo);
    const top = scored.slice(0, 3).map((hit, idx) => {
        const kind = declRe.test(hit.content) ? 'decl' : 'hit';
        return `${idx + 1}. ${hit.path}:${hit.lineNo} [${kind}] ${hit.content.slice(0, 180)}`;
    });
    return ['# top candidates', ...top].join('\n');
}

// Suggest a sibling file the caller may have meant when the requested
// path is missing: same stem with a different extension, or a same-name
// sibling differing only in case. Pure best-effort; any fs error returns
// null so the caller falls back to the bare "not found" message.
function findSimilarFile(fullPath) {
    try {
        const dir = dirname(fullPath);
        const base = basename(fullPath);
        const stem = basename(fullPath, extname(fullPath));
        const entries = readdirSync(dir);
        const sameStem = entries.find((e) => e !== base && basename(e, extname(e)) === stem);
        if (sameStem) return join(dir, sameStem);
        const caseMatch = entries.find((e) => e !== base && e.toLowerCase() === base.toLowerCase());
        if (caseMatch) return join(dir, caseMatch);
        return null;
    } catch { return null; }
}

function cwdRelativePath(fullPath, workDir) {
    try {
        const rel = relative(workDir, fullPath);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) return fullPath;
        return rel;
    } catch { return fullPath; }
}

// Node's native fs errors embed the failing path wrapped in single quotes
// using OS-native separators ('C:\\Users\\foo\\bar.mjs' on Windows). Without
// this pass, read error bodies surface backslash paths that
// break the forward-slash convention the rest of the tool output keeps.
// Only quoted drive-letter paths are rewritten so unrelated backslash
// sequences in the message text are untouched.
function normalizeErrorMessage(msg) {
    if (process.platform !== 'win32' || typeof msg !== 'string') return msg;
    return msg.replace(
        /(['"])([A-Za-z]:[\\\/][^'"]+)\1/g,
        (_m, q, p) => `${q}${p.replace(/\\/g, '/')}${q}`,
    );
}

function extractGlobBaseDirectory(pattern) {
    const wildcardIdx = pattern.search(/[\*\?\[\{]/);
    const staticPrefix = wildcardIdx === -1 ? pattern : pattern.slice(0, wildcardIdx);
    const lastSep = Math.max(
        staticPrefix.lastIndexOf('/'),
        staticPrefix.lastIndexOf('\\'),
    );
    if (lastSep === -1) return { baseDir: null, relativePattern: pattern };
    let baseDir = staticPrefix.slice(0, lastSep);
    const relativePattern = pattern.slice(lastSep + 1);
    if (process.platform === 'win32' && /^[A-Za-z]:$/.test(baseDir)) {
        baseDir = baseDir + '\\';
    }
    return { baseDir: baseDir || null, relativePattern };
}

// Cap matches Claude Code's BashTool default (BASH_MAX_OUTPUT_DEFAULT in
// utils/shell/outputLimits.ts, 30_000 chars). Claude Code falls back to a
// persisted stdout file the model can re-read via FileRead; this orchestrator
// has no such sidecar store, so the head slice is the full record the model
// ever sees. Raised to 100_000 (TaskOutputTool parity). Larger raw outputs (seen in the wild: a 160k-token Grep result on
// 2026-04-19) blow the context budget and crater the server-side prompt
// cache, so the cap is the primary guard.
const SHELL_OUTPUT_MAX_CHARS = 100_000;

// v0.6.231 smart truncation. Big raw payloads (large `read`, 500-line `bash`
// dumps) bloat Pool B cache_write by 30-40k tokens per iter. These thresholds
// trigger head/tail summarisation so the agent still sees the interesting
// frames (start of file, tail of log) without paying for the middle mass.
// Explicit offset/limit on `read` — or `full:true` — bypasses the cap so
// targeted reads remain byte-exact.
const SMART_READ_MAX_BYTES = 30 * 1024;
const SMART_READ_MAX_LINES = 600;
const SMART_READ_HEAD_LINES = 200;
const SMART_READ_TAIL_LINES = 100;
const SMART_BASH_MAX_LINES = 400;
const SMART_BASH_MAX_BYTES = 30 * 1024;
const SMART_BASH_HEAD_LINES = 80;
const SMART_BASH_TAIL_LINES = 80;

// Middle-elision helper for shell output. Head + tail framed with a
// self-describing marker so the agent sees both the command prologue and the
// tail (exit-code, final log entries) instead of losing the tail to a pure
// head slice. Arrow-function replacer convention (see B35 comment elsewhere)
// is honoured; no String.prototype.replace calls here.
function smartMiddleTruncate(content) {
    const s = typeof content === 'string' ? content : String(content ?? '');
    if (s.length <= SMART_BASH_MAX_BYTES) {
        // Byte cap clear. Still gate on line count — a narrow file of 500
        // single-byte rows slips under the byte cap yet prints 500 lines.
        const fastLines = s.split('\n');
        if (fastLines.length <= SMART_BASH_MAX_LINES) return s;
        const head = fastLines.slice(0, SMART_BASH_HEAD_LINES).join('\n');
        const tail = fastLines.slice(-SMART_BASH_TAIL_LINES).join('\n');
        const middle = fastLines.length - SMART_BASH_HEAD_LINES - SMART_BASH_TAIL_LINES;
        return `${head}\n\n... [TRUNCATED — ${middle} lines middle elided; total ${fastLines.length} lines. Rerun with tighter filters for more] ...\n\n${tail}`;
    }
    const lines = s.split('\n');
    if (lines.length <= SMART_BASH_MAX_LINES) {
        // Byte cap tripped but line count is moderate (one giant row). Fall
        // back to the legacy head-only cap so we don't invent a split that
        // cuts a single logical line in half.
        const head = s.slice(0, SMART_BASH_MAX_BYTES);
        return `${head}\n\n... [TRUNCATED — output exceeded ${Math.round(SMART_BASH_MAX_BYTES / 1024)} KB on a single line] ...`;
    }
    const head = lines.slice(0, SMART_BASH_HEAD_LINES).join('\n');
    const tail = lines.slice(-SMART_BASH_TAIL_LINES).join('\n');
    const middle = lines.length - SMART_BASH_HEAD_LINES - SMART_BASH_TAIL_LINES;
    const totalKb = Math.round(s.length / 1024);
    return `${head}\n\n... [TRUNCATED — ${middle} lines middle elided; total ${lines.length} lines / ${totalKb} KB. Rerun with tighter filters for more] ...\n\n${tail}`;
}

// Shared smart-truncate for file bodies (read). Returns the
// original rendered text unchanged when the file is small. When the file is
// big AND the caller didn't pin a range, returns a head/tail framed summary
// plus a truncation flag so the array-form aggregator can annotate each
// per-file header.
function smartReadTruncate(renderedWithLineNos, totalLines, fileBytes) {
    const overByBytes = fileBytes > SMART_READ_MAX_BYTES;
    const overByLines = totalLines > SMART_READ_MAX_LINES;
    if (!overByBytes && !overByLines) {
        return { text: renderedWithLineNos, truncated: false, totalLines };
    }
    const rows = renderedWithLineNos.split('\n');
    const head = rows.slice(0, SMART_READ_HEAD_LINES).join('\n');
    const tail = rows.slice(-SMART_READ_TAIL_LINES).join('\n');
    const kb = Math.round(fileBytes / 1024);
    const marker = `... [TRUNCATED — file is ${totalLines} lines / ${kb} KB. Use offset/limit for a specific range, or full:true for the whole file] ...`;
    return { text: `${head}\n${marker}\n${tail}`, truncated: true, totalLines };
}

// Default ignores for grep/glob shell-outs. Matches the directories ripgrep
// already skips when a repo is initialized (.gitignore-driven) plus the
// common build-artefact dirs that are almost never interesting to search.
// Without these, rg walks node_modules on plugin-source trees and spikes to
// ~10-12% CPU per process (three concurrent reviewer rg calls observed
// burning 34% CPU aggregate, 2026-04-19).
const DEFAULT_IGNORE_GLOBS = [
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

function capShellOutput(content) {
    const s = typeof content === 'string' ? content : String(content ?? '');
    if (s.length <= SHELL_OUTPUT_MAX_CHARS && s.split('\n').length <= SMART_BASH_MAX_LINES) return s;
    return smartMiddleTruncate(s);
}
// Read tool caps. Two-stage protection mirrors Anthropic Claude Code's
// FileReadTool/limits.ts pattern: pre-stat byte cap throws ~100B error vs
// truncation that fills 25K tokens at the cap. Throw is decisively more
// token-efficient (Anthropic #21841 reverted truncation experiment).
const READ_MAX_SIZE_BYTES = 256 * 1024;
const READ_MAX_OUTPUT_BYTES = 100 * 1024;

// --- PDF text extraction (pdf-parse CJS via createRequire) ---
import { createRequire as _createRequire } from 'module';
const _require = _createRequire(import.meta.url);
async function _extractPdfText(fullPath, pagesArg) {
    try {
        const pdfParse = _require('pdf-parse');
        const buf = readFileSync(fullPath);
        // Parse page range: "1-5", "3", "10-20" (1-based, max 20 pages)
        let pageFilter = null;
        if (pagesArg && typeof pagesArg === 'string') {
            const m = pagesArg.trim().match(/^(\d+)(?:-(\d+))?$/);
            if (m) {
                const from = parseInt(m[1], 10);
                const to = m[2] ? Math.min(parseInt(m[2], 10), from + 19) : from;
                pageFilter = { from, to };
            }
        }
        let pageTexts = [];
        const data = await pdfParse(buf, {
            pagerender: (pageData) => {
                const pageNum = pageData.pageIndex + 1;
                if (pageFilter && (pageNum < pageFilter.from || pageNum > pageFilter.to)) return Promise.resolve('');
                return pageData.getTextContent().then(tc => {
                    const text = tc.items.map(i => i.str).join(' ');
                    pageTexts.push({ page: pageNum, text });
                    return text;
                });
            },
        });
        let out;
        if (pageFilter) {
            out = pageTexts.map(p => `--- Page ${p.page} ---\n${p.text}`).join('\n\n');
        } else {
            out = data.text || '';
        }
        // Trim to output cap with a continuation hint
        if (out.length > READ_MAX_OUTPUT_BYTES) {
            out = out.slice(0, READ_MAX_OUTPUT_BYTES) + `\n\n... [PDF output truncated at ${Math.round(READ_MAX_OUTPUT_BYTES/1024)} KB; use pages param to narrow]`;
        }
        return out || '(no text content extracted from PDF)';
    } catch (err) {
        return `Error: pdf-parse failed — ${err instanceof Error ? err.message : String(err)}`;
    }
}

// --- .ipynb notebook text extraction (no external deps) ---
function _extractIpynbText(fullPath) {
    try {
        const raw = readFileSync(fullPath, 'utf-8');
        const nb = JSON.parse(raw);
        const cells = Array.isArray(nb.cells) ? nb.cells : [];
        const parts = [];
        for (const cell of cells) {
            const src = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
            if (cell.cell_type === 'markdown') {
                parts.push(src);
            } else if (cell.cell_type === 'code') {
                let block = src;
                const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
                for (const out of outputs) {
                    const data = out.data || {};
                    if (data['text/plain']) {
                        const txt = Array.isArray(data['text/plain']) ? data['text/plain'].join('') : data['text/plain'];
                        block += '\n# Output:\n' + txt;
                    } else if (out.text) {
                        const txt = Array.isArray(out.text) ? out.text.join('') : out.text;
                        block += '\n# Output:\n' + txt;
                    } else if (data['image/png'] || data['image/jpeg']) {
                        block += '\n# Output: [image output omitted]';
                    }
                }
                parts.push('```python\n' + block + '\n```');
            }
        }
        let out = parts.join('\n\n');
        if (out.length > READ_MAX_OUTPUT_BYTES) {
            out = out.slice(0, READ_MAX_OUTPUT_BYTES) + `\n\n... [notebook output truncated at ${Math.round(READ_MAX_OUTPUT_BYTES/1024)} KB]`;
        }
        return out || '(empty notebook)';
    } catch (err) {
        return `Error: ipynb parse failed — ${err instanceof Error ? err.message : String(err)}`;
    }
}

// Binary detection: reading a PNG / ELF / zip / compressed blob as utf-8
// pollutes the context with U+FFFD characters and wastes tokens. Sample the
// head and tail of the file and look for a null byte — the canonical signal
// that the file is not plain text. Head window scales with file size:
// min(fileSize, 64KB) head + 4KB tail, so a 250KB file with a null byte at
// 9KB or 249KB is caught equally. The sampling is synchronous and cheap
// relative to the 256KB read budget it guards.
// Callers inside the ≤READ_MAX_SIZE_BYTES branch should pass st.size so the
// tail probe fires; callers above the cap pass the real size from err.size.
function isBinaryFile(fullPath, fileSize = 0) {
    const HEAD_CAP = 64 * 1024;   // 64 KB max head window
    const TAIL_SIZE = 4 * 1024;   // 4 KB tail probe
    const headBytes = fileSize > 0 ? Math.min(fileSize, HEAD_CAP) : HEAD_CAP;
    let fd = null;
    try {
        fd = openSync(fullPath, 'r');
        // Head probe
        const headBuf = Buffer.allocUnsafe(headBytes);
        const nHead = readSync(fd, headBuf, 0, headBytes, 0);
        if (nHead === 0) return false;
        for (let i = 0; i < nHead; i++) {
            if (headBuf[i] === 0) return true;
        }
        // Tail probe (only when file is larger than head window)
        if (fileSize > headBytes && fileSize > TAIL_SIZE) {
            const tailOffset = fileSize - TAIL_SIZE;
            const tailBuf = Buffer.allocUnsafe(TAIL_SIZE);
            const nTail = readSync(fd, tailBuf, 0, TAIL_SIZE, tailOffset);
            for (let i = 0; i < nTail; i++) {
                if (tailBuf[i] === 0) return true;
            }
        }
        return false;
    } catch {
        return false;
    } finally {
        if (fd !== null) { try { closeSync(fd); } catch {} }
    }
}

// Streaming path for large files when offset/limit is provided. Mirrors
// Claude Code's FileReadTool large-file branch: instead of loading the
// whole file into memory (which blows the 256KB cap for legitimate
// targeted reads), line-stream through readline and materialise only the
// requested window. Output format matches the fast path so downstream
// line-citation parsing is unchanged.
async function streamReadRange(fullPath, offset, limit) {
    return new Promise((resolve, reject) => {
        const stream = createReadStream(fullPath, { encoding: 'utf-8' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        const collected = [];
        let lineIdx = 0;
        let collectedBytes = 0;
        let truncated = false;
        let stoppedAtLimit = false;
        // W1 H: track first/last emitted line numbers (1-based) so callers
        // snapshot only what was rendered. Byte-cap truncation can stop
        // the stream short of `offset+limit`; recording the request
        // marked unread lines as editable.
        let firstEmitted = 0;
        let lastEmitted = 0;
        rl.on('line', (line) => {
            if (lineIdx < offset) { lineIdx++; return; }
            if (collected.length >= limit) {
                stoppedAtLimit = true;
                rl.close();
                stream.destroy();
                return;
            }
            if (lineIdx === 0 && line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
            const rendered = `${lineIdx + 1}\t${line}`;
            collectedBytes += rendered.length + 1; // +1 for newline
            if (collectedBytes > READ_MAX_OUTPUT_BYTES) {
                truncated = true;
                rl.close();
                stream.destroy();
                return;
            }
            collected.push(rendered);
            if (firstEmitted === 0) firstEmitted = lineIdx + 1;
            lastEmitted = lineIdx + 1;
            lineIdx++;
        });
        rl.on('close', () => {
            let out = collected.join('\n');
            if (truncated) {
                out += `\n\n... [output truncated at ${Math.round(READ_MAX_OUTPUT_BYTES/1024)} KB] ...`;
            } else if (stoppedAtLimit) {
                out += `${out ? '\n' : ''}... [range limit reached; next offset: ${offset + collected.length}]`;
            } else if (!out && offset >= lineIdx) {
                out = `(no lines in range; file has ${lineIdx} lines)`;
            }
            resolve({ text: out, firstEmitted, lastEmitted });
        });
        rl.on('error', reject);
        stream.on('error', reject);
    });
}

// Shared display helper: produce the cwd-relative, forward-slash path the
// model sees. Multiple tools need the same recipe; exporting it here keeps
// the convention (relative when inside cwd, normalized separators) pinned
// to one location.
export function toDisplayPath(abs, cwd) {
    return normalizeOutputPath(cwdRelativePath(abs, cwd));
}

// ISO-ish mtime formatter shared by list / find_files. A single hyphen is
// used for zero/missing mtime so entries that failed stat still render a
// stable column.
function formatMtime(mtimeMs) {
    if (!mtimeMs) return '-';
    return new Date(mtimeMs).toISOString().slice(0, 19).replace('T', ' ');
}

function formatPaginationHint(remaining, nextOffset) {
    const n = Number(remaining);
    const label = Number.isFinite(n) && n > 0 ? `${n} more entries` : 'more entries';
    return `... [${label}; next offset: ${nextOffset}]`;
}

function parseOffsetArg(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function parseLineLimitArg(value, defaultValue) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(1, Math.trunc(n)) : defaultValue;
}

// G6: device path block list (Claude Code parity). Reading these paths
// would either hang (waiting for stdin / tty) or produce infinite output
// (/dev/zero, /dev/random). isSafePath already restricts scope, but a
// user-allowed path can still hit these pseudo-files on POSIX hosts.
const BLOCKED_DEVICE_PATHS = new Set([
    '/dev/zero', '/dev/random', '/dev/urandom', '/dev/full',
    '/dev/stdin', '/dev/tty', '/dev/console',
    '/dev/stdout', '/dev/stderr',
    '/dev/fd/0', '/dev/fd/1', '/dev/fd/2',
]);

function isBlockedDevicePath(p) {
    if (BLOCKED_DEVICE_PATHS.has(p)) return true;
    // /proc/self/fd/0-2 and /proc/<pid>/fd/0-2 are Linux aliases for stdio.
    if (typeof p === 'string' && p.startsWith('/proc/')
        && (p.endsWith('/fd/0') || p.endsWith('/fd/1') || p.endsWith('/fd/2'))) return true;
    return false;
}

function isUncPath(p) {
    // Windows UNC (\\\\server\\share) or POSIX-style equivalent (//server).
    // Reading a UNC path can leak NTLM credentials to a remote SMB share
    // because Windows automatically authenticates outbound SMB requests.
    return typeof p === 'string' && (p.startsWith('\\\\') || p.startsWith('//'));
}

// CC parity: 2000-char threshold (was 520). Long lines that fit in 2K are
// passed through untouched; over 2K we keep ~1500 head + ~300 tail with a
// truncation marker between.
const READ_MAX_RENDERED_LINE_CHARS = 2_000;
function renderReadLine(lineNo, line, { truncateLongLine = true } = {}) {
    let text = String(line ?? '');
    if (truncateLongLine && text.length > READ_MAX_RENDERED_LINE_CHARS) {
        const head = text.slice(0, 1_500);
        const tail = text.slice(-300);
        text = `${head} ... [line truncated: ${text.length} chars total] ... ${tail}`;
    }
    return `${lineNo}\t${text}`;
}
// TODO: truncated-line edit-validation needs hint

// Shared file-open prologue for read-flavoured tools (tail / wc / diff).
// Consolidates the normalize → isSafePath → stat → findSimilarFile-hint →
// size-cap sequence so every consumer funnels through the same pipeline
// (F9 / F12). Throws tagged errors (code=EARG/EOUTSIDE/ENOENT/ETOOBIG)
// instead of returning strings so callers can branch on ETOOBIG for
// large-file fallbacks without resorting to message regexes.
//
// B35 note: `err.message` is returned verbatim by callers — no
// String.prototype.replace with substitution-capable strings. If a caller
// needs to massage the message, use an arrow-function replacer.
async function openForRead(filePath, workDir, opts = {}) {
    if (typeof filePath !== 'string' || !filePath) {
        throw Object.assign(new Error('path is required'), { code: 'EARG' });
    }
    const norm = normalizeInputPath(filePath);
    const allowHome = opts.allowHome === true;
    const allowPluginData = opts.allowPluginData === true;
    if (!isSafePath(norm, workDir, { allowHome, allowPluginData })) {
        throw Object.assign(
            new Error(`path outside allowed scope — ${normalizeOutputPath(norm)}`),
            { code: 'EOUTSIDE' });
    }
    const fullPath = resolveAgainstCwd(norm, workDir);
    let st;
    try { st = statSync(fullPath); }
    catch (err) {
        const similar = findSimilarFile(fullPath);
        const hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
        const msg = normalizeErrorMessage(err instanceof Error ? err.message : String(err)) + hint;
        throw Object.assign(new Error(msg), { code: 'ENOENT' });
    }
    if (st.size > READ_MAX_SIZE_BYTES) {
        throw Object.assign(
            new Error(`file size ${st.size} bytes exceeds ${READ_MAX_SIZE_BYTES}-byte cap`),
            { code: 'ETOOBIG', size: st.size, fullPath, st });
    }
    if (isBinaryFile(fullPath, st.size)) {
        throw Object.assign(
            new Error(`file appears to be binary (contains null bytes): ${normalizeOutputPath(norm)}`),
            { code: 'EBINARY' });
    }
    const content = await readFile(fullPath, 'utf-8');
    return { fullPath, content, displayPath: normalizeOutputPath(norm), st };
}

// Simple glob-to-RegExp compiler for name filters (find_files, future
// tools). Callers pass foo*.mjs style patterns, not full brace/POSIX-class
// globs. The arrow-function form of .replace is mandatory here: B35
// (v0.6.216) demonstrated that String.prototype.replace with a string
// replacement interprets substitution sequences and silently corrupts
// patterns that happen to contain them. The arrow form opts out of
// substitution entirely.
function compileSimpleGlob(pattern) {
    if (!pattern) return null;
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, (ch) => '\\' + ch);
    const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    const DOLLAR = '\x24';
    return new RegExp('^' + body + DOLLAR, 'i');
}

// Unified directory walk used by list / tree / find_files. The visitor
// callback owns the "should I record this entry?" decision; returning
// literal false aborts the whole walk (used by list / find_files to stop
// as soon as head_limit is satisfied, fixing F1 where the old loops kept
// stat-calling entries after reaching the cap).
//
// - hidden:false skips dotfiles before the visitor runs
// - maxDepth limits recursion (1 = direct children only)
// - sort runs per-directory before visiting, so ordering is stable
// - visit(ent, entPath, ctx) where ctx = { depth, index, total, isLast }
//   exposes per-level ordering so tree-style renderers can draw branch
//   prefixes without reimplementing the walk.
function walkDir(root, { hidden = false, maxDepth = Infinity, visit, sort } = {}) {
    const _walk = (dir, depth) => {
        if (depth > maxDepth) return true;
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); }
        catch { return true; }
        if (!hidden) entries = entries.filter(e => !e.name.startsWith('.'));
        if (sort) entries.sort(sort);
        const total = entries.length;
        for (let i = 0; i < total; i++) {
            const ent = entries[i];
            const entPath = join(dir, ent.name);
            const ctx = { depth, index: i, total, isLast: i === total - 1 };
            const cont = visit(ent, entPath, ctx);
            if (cont === false) return false;
            if (ent.isDirectory()) {
                if (_walk(entPath, depth + 1) === false) return false;
            }
        }
        return true;
    };
    _walk(root, 1);
}

// --- Tool definitions for external models ---
//
// Ordered to match the previous hand-maintained tools.json entries
// (read / edit / write / bash / grep / glob) so
// build-tools-manifest reproduces the legacy ordering.
// Shape mirrors tools.json: title + annotations + compact descriptions.
// The previous long-form descriptions have been trimmed to the tools.json
// versions — those are what external models actually saw in the prefix.
// `BUILTIN_TOOLS` name is preserved because session/manager.mjs and the
// isBuiltinTool check in this file both reference it by that symbol.
export const BUILTIN_TOOLS = [
    {
        name: 'read',
        title: 'Read',
        annotations: { title: 'Read', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Read file(s). `path` accepts a single string or array (`["a.mjs","b.mjs"]`) for parallel multi-file batches. `mode`: full (default) | head | tail | count. `n` sets head/tail line count; `offset`/`limit` set the full-mode line window. Files over the byte cap require offset/limit, head, tail, count, or `grep`. PDF and .ipynb files are automatically extracted as text. Do not repeat an identical read on the same file/range — open a wider window or different range instead. For per-file differing offset/limit/mode, use `reads:[{path,offset,limit,mode?,n?},…]` instead of separate `path` array calls.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'File path string, or array of paths for parallel multi-file read.' },
                mode: { type: 'string', enum: ['full', 'head', 'tail', 'count'], description: 'full (default) | head | tail | count.' },
                n: { type: 'number', description: 'Lines for head / tail mode. Default 20.' },
                offset: { type: 'number', description: 'Start line for full mode (0-based; mixdog convention).' },
                limit: { type: 'number', description: 'Max lines for full mode (default 2000).' },
                full: { type: 'boolean', description: 'Opt out of the big-file head/tail cap. Default false.' },
                pages: { type: 'string', description: 'PDF only: page range to extract, e.g. "1-5", "3", "10-20". Max 20 pages.' },
                reads: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string' },
                            offset: { type: 'number' },
                            limit: { type: 'number' },
                            mode: { type: 'string', enum: ['full', 'head', 'tail', 'count'] },
                            n: { type: 'number' },
                        },
                        required: ['path'],
                    },
                    description: 'Per-file read with independent offset/limit/mode. Use this OR `path`, not both.',
                },
            },
        },
    },
    {
        name: 'edit',
        title: 'Edit',
        annotations: { title: 'Edit', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Replace text in file(s). For multiple edits prefer the `edits` array form — same file applies sequentially, different files run in parallel. Single form (`path` + `old_string` + `new_string`) is for a one-off only; serial single edits waste iters. `replace_all:true` drops the uniqueness check.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path (single-edit form).' },
                old_string: { type: 'string', description: 'Text to find (single-edit form, unique unless replace_all).' },
                new_string: { type: 'string', description: 'Replacement (single-edit form).' },
                replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring unique match.' },
                edits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Per-edit path. Omit to reuse the top-level path.' },
                            old_string: { type: 'string' },
                            new_string: { type: 'string' },
                            replace_all: { type: 'boolean' },
                        },
                        required: ['old_string', 'new_string'],
                    },
                    minItems: 1,
                    description: 'Array of edits. Each may specify its own `path`; otherwise reuses top-level `path`. Same-file edits sequential, cross-file parallel.',
                },
            },
        },
    },
    {
        name: 'write',
        title: 'Write',
        annotations: { title: 'Write', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Create or overwrite a file. Prefer `apply_patch` for multi-file or context-heavy edits; use `write` when you are creating a new file or replacing the whole contents intentionally. For multiple whole-file writes in one turn, pass `writes` array.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path.' },
                content: { type: 'string', description: 'UTF-8 content.' },
                writes: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Target file path.' },
                            content: { type: 'string', description: 'UTF-8 content.' },
                        },
                        required: ['path', 'content'],
                    },
                    minItems: 1,
                    description: 'Batch whole-file writes. Use when creating/replacing several files in one call.',
                },
            },
        },
    },
    {
        name: 'bash',
        title: 'Bash',
        annotations: { title: 'Bash', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: 'Execute a shell command. DEFAULT = one-shot shell. BATCH RELATED COMMANDS with `&&` (stop on fail) or `;` (always run) in a single call — two separate bash turns for dependent work waste a round-trip. Pass `persistent:true` to keep cwd/env/venv across calls in the same session (the bridge reuses one shell). Set `run_in_background:true` for long builds/tests/servers, then `job_wait` to block until it finishes and `read` the stdout/stderr paths for logs. Destructive patterns (rm -rf /, force-push, format) are blocked.',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command.' },
                timeout: { type: 'number', description: 'ms, default 120000 (2 min). Set a larger value for long-running commands.' },
                merge_stderr: { type: 'boolean', description: 'Merge stderr into stdout (2>&1). Default false: stderr surfaced as separate `[stderr]` block.' },
                run_in_background: { type: 'boolean', description: 'Run command in the background and return a job id immediately. Use for long builds/tests/servers.' },
                persistent: { type: 'boolean', description: 'Keep shell state (cwd, env, venv, functions) across calls. One shared shell per session.' },
                session_id: { type: 'string', description: 'Explicit persistent shell session id to reuse. Prefer `persistent:true` unless targeting a specific shell.' },
            },
            required: ['command'],
        },
    },
    {
        name: 'job_wait',
        title: 'Wait For Background Job',
        annotations: { title: 'Wait For Background Job', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        description: 'Wait for a background shell job to finish and return its latest status/summary in one call.',
        inputSchema: {
            type: 'object',
            properties: {
                job_id: { type: 'string', description: 'Background job id returned by bash with run_in_background:true.' },
                timeout_ms: { type: 'number', description: 'Maximum time to wait before returning the current running state. Default 30000.' },
                poll_ms: { type: 'number', description: 'Polling interval while waiting. Default 250 ms.' },
            },
            required: ['job_id'],
        },
    },
    {
        name: 'grep',
        title: 'Grep',
        annotations: { title: 'Grep', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'ripgrep content search. `pattern` accepts a single regex string (use `|` for alternation: `pattern:"foo|bar"`) OR an array of patterns (`pattern:["foo","bar"]`, OR-joined). `glob` follows the same shape — single string or array. Prefer the array form when patterns are long or genuinely independent; serial greps are not allowed. For identifier/symbol lookup where you know the name but not the file, prefer `find_symbol` instead of grep. Use `grep` for content confirmation, broader text search, or regex. Output modes: `files_with_matches` (default), `content`, `count`. Use `multiline:true` for patterns spanning lines.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Regex string (use `|` for alternation) or array of patterns (OR-joined).' },
                path: { type: 'string', description: 'Search root. Default: cwd.' },
                glob: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Glob filter (`{a,b}` brace expansion supported) or array of filters.' },
                output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] },
                head_limit: { type: 'number', description: 'Default 250; 0 = unlimited.' },
                offset: { type: 'number', description: 'Skip N entries before head_limit.' },
                '-i': { type: 'boolean', description: 'Case-insensitive match.' },
                '-n': { type: 'boolean', description: 'Show line numbers (content mode, default true).' },
                '-A': { type: 'number', description: 'Lines after each match (content mode).' },
                '-B': { type: 'number', description: 'Lines before each match (content mode).' },
                '-C': { type: 'number', description: 'Lines before+after (content mode).' },
                context: { type: 'number', description: 'Alias for -C.' },
                multiline: { type: 'boolean', description: 'Allow patterns to span lines (rg -U --multiline-dotall).' },
                type: { type: 'string', description: 'File type filter (e.g. js, py, rust, go).' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'glob',
        title: 'Glob',
        annotations: { title: 'Glob', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'File path search via `rg --files`. Returns paths sorted by modification time (newest first). `pattern` accepts a single glob string (use `{a,b}` brace expansion for compact alternation: `pattern:"**/*.{mjs,json}"`) OR an array of globs (`pattern:["**/*route*.mjs","**/*policy*.json"]`). Prefer the array form when categories are genuinely independent; do not emit two `glob` calls in the same assistant turn — merge them into one call with all requested categories. Use `grep` for in-file content search.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Glob string (`{a,b}` brace expansion supported) or array of glob patterns.' },
                path: { type: 'string', description: 'Base dir. Default: cwd. Result rows emitted as absolute paths.' },
                head_limit: { type: 'number', description: 'Max file paths to return. Default 100; 0 = unlimited.' },
                offset: { type: 'number', description: 'Skip N file paths before applying head_limit.' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'list',
        title: 'List Directory',
        annotations: { title: 'List Directory', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Directory inspection. `mode`: list (default, metadata rows: name/type/size/mtime) | tree (ASCII visualization) | find (filter by name/size/mtime). Use this for quick local shape checks (recent files, candidate directories, size/mtime clues). For newest-file tasks, use `list` with `sort:"mtime", type:"file"` or `find` and read the top hit directly; do not list the workspace root again just to verify. Use `find` mode to filter by filename pattern within a directory tree; for repository-wide filename pattern search use `glob` instead, and for in-file content search use `grep`. Use `find_symbol` for identifier lookup.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Root directory. Default cwd. Supports `~`. All result rows emitted as absolute paths.' },
                mode: { type: 'string', enum: ['list', 'tree', 'find'], description: 'list (default) | tree | find.' },
                depth: { type: 'number', description: 'Recursion depth. list: 1 default, max 10. tree: 3 default, max 6.' },
                hidden: { type: 'boolean', description: 'Include dotfiles (`.foo`). Default false.' },
                sort: { type: 'string', enum: ['name', 'mtime', 'size'], description: 'list mode sort key. Default name.' },
                type: { type: 'string', enum: ['any', 'file', 'dir'], description: 'Filter by entry type. Default any.' },
                head_limit: { type: 'number', description: 'Max rows/lines. 0 = unlimited.' },
                offset: { type: 'number', description: 'Skip N rows/entries before applying head_limit.' },
                name: { type: 'string', description: 'find mode: filename glob (e.g. `*.mjs`).' },
                min_size: { type: 'number', description: 'find mode: minimum size in bytes (file only).' },
                max_size: { type: 'number', description: 'find mode: maximum size in bytes (file only).' },
                modified_after: { type: 'string', description: 'find mode: ISO 8601 date or relative `Nh`/`Nd` (e.g. `24h`, `7d`).' },
                modified_before: { type: 'string', description: 'find mode: ISO 8601 date or relative `Nh`/`Nd`.' },
            },
            required: [],
        },
    },
];
// --- Short-TTL result cache for idempotent read-only tools ---
//
// Anthropic prompt cache already covers the messages layer; this layer
// dedupes back-to-back builtin tool calls with identical args so spawning
// ripgrep or re-reading the same file is avoided when the agent loops on
// the same query in a tight iter. Mutations invalidate affected cache
// entries by path/scope where possible; shell commands still fall back to
// a full clear because arbitrary commands can mutate anything.
const RESULT_CACHE = new Map(); // key → { ts, value, paths, scopes, readSnapshotMeta }
const RESULT_CACHE_TTL_MS = 30_000;
const RESULT_CACHE_MAX_ENTRIES = 200;
const STAT_CACHE = new Map(); // fullPath → { ts, stat }
const STAT_CACHE_TTL_MS = 5_000;
const STAT_CACHE_MAX_ENTRIES = 2_000;
const BUILTIN_CACHE_STATS = {
    hits: 0,
    misses: 0,
    sets: 0,
    pathInvalidations: 0,
    globalInvalidations: 0,
    invalidatedResultEntries: 0,
    invalidatedStatEntries: 0,
};
function _canonicalCachePath(p) {
    const full = normalize(resolve(String(p || '')));
    return process.platform === 'win32' ? full.toLowerCase() : full;
}
function _normalizeCacheMetaPaths(values) {
    if (!Array.isArray(values)) return [];
    return Array.from(new Set(
        values
            .filter(Boolean)
            .map((v) => _canonicalCachePath(v)),
    ));
}
function _cachePathsOverlap(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`)
        || b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`);
}
function _cacheEntryOverlapsPaths(entry, affectedPaths) {
    const entryPaths = Array.isArray(entry?.paths) ? entry.paths : [];
    const entryScopes = Array.isArray(entry?.scopes) ? entry.scopes : [];
    for (const affected of affectedPaths) {
        for (const p of entryPaths) {
            if (_cachePathsOverlap(p, affected)) return true;
        }
        for (const scope of entryScopes) {
            if (_cachePathsOverlap(scope, affected)) return true;
        }
    }
    return false;
}
function _cacheGetEntry(key) {
    const entry = RESULT_CACHE.get(key);
    if (!entry) {
        BUILTIN_CACHE_STATS.misses++;
        return null;
    }
    if (Date.now() - entry.ts > RESULT_CACHE_TTL_MS) {
        RESULT_CACHE.delete(key);
        BUILTIN_CACHE_STATS.misses++;
        return null;
    }
    BUILTIN_CACHE_STATS.hits++;
    return entry;
}
function _cacheGet(key) {
    return _cacheGetEntry(key)?.value ?? null;
}
function _cacheSet(key, value, meta = {}) {
    if (RESULT_CACHE.size >= RESULT_CACHE_MAX_ENTRIES) {
        const oldest = RESULT_CACHE.keys().next().value;
        if (oldest) RESULT_CACHE.delete(oldest);
    }
    RESULT_CACHE.set(key, {
        ts: Date.now(),
        value,
        paths: _normalizeCacheMetaPaths(meta.paths),
        scopes: _normalizeCacheMetaPaths(meta.scopes),
        readSnapshotMeta: meta.readSnapshotMeta || null,
    });
    BUILTIN_CACHE_STATS.sets++;
}
function _statCacheGet(fullPath, now = Date.now()) {
    const entry = STAT_CACHE.get(fullPath);
    if (!entry) return null;
    if (now - entry.ts > STAT_CACHE_TTL_MS) {
        STAT_CACHE.delete(fullPath);
        return null;
    }
    return entry.stat;
}
function _statCacheSet(fullPath, stat, now = Date.now()) {
    if (STAT_CACHE.size >= STAT_CACHE_MAX_ENTRIES) {
        const oldest = STAT_CACHE.keys().next().value;
        if (oldest) STAT_CACHE.delete(oldest);
    }
    STAT_CACHE.set(fullPath, { ts: now, stat });
}
export function getCachedReadOnlyStat(fullPath, loader = statSync, now = Date.now()) {
    const cached = _statCacheGet(fullPath, now);
    if (cached) return cached;
    const stat = loader(fullPath);
    _statCacheSet(fullPath, stat, now);
    return stat;
}
function _cacheInvalidateAll() {
    BUILTIN_CACHE_STATS.globalInvalidations++;
    BUILTIN_CACHE_STATS.invalidatedResultEntries += RESULT_CACHE.size;
    BUILTIN_CACHE_STATS.invalidatedStatEntries += STAT_CACHE.size;
    RESULT_CACHE.clear();
    STAT_CACHE.clear();
}
function _cacheInvalidatePaths(paths) {
    const affectedPaths = _normalizeCacheMetaPaths(Array.isArray(paths) ? paths : [paths]);
    if (affectedPaths.length === 0) {
        _cacheInvalidateAll();
        return;
    }
    BUILTIN_CACHE_STATS.pathInvalidations++;
    for (const [key, entry] of RESULT_CACHE) {
        if (_cacheEntryOverlapsPaths(entry, affectedPaths)) {
            RESULT_CACHE.delete(key);
            BUILTIN_CACHE_STATS.invalidatedResultEntries++;
        }
    }
    for (const key of [...STAT_CACHE.keys()]) {
        if (affectedPaths.some((affected) => _cachePathsOverlap(_canonicalCachePath(key), affected))) {
            STAT_CACHE.delete(key);
            BUILTIN_CACHE_STATS.invalidatedStatEntries++;
        }
    }
}
export function invalidateBuiltinResultCache(paths = null) {
    if (Array.isArray(paths) ? paths.length > 0 : Boolean(paths)) {
        _cacheInvalidatePaths(paths);
        return;
    }
    _cacheInvalidateAll();
}
export function recordReadSnapshotForPath(fullPath, scope = null, meta = {}) {
    try {
        _recordReadSnapshot(fullPath, undefined, scope, meta);
    } catch { /* ignore snapshot failures */ }
}
export function clearReadSnapshotForPath(fullPath, scope = null) {
    try {
        if (scope !== null && scope !== undefined) {
            _readFilesForScope(scope).delete(fullPath);
            return;
        }
        for (const readFiles of _readFilesByScope.values()) {
            readFiles.delete(fullPath);
        }
    } catch { /* ignore */ }
}
export function resetBuiltinCacheStatsForTesting() {
    BUILTIN_CACHE_STATS.hits = 0;
    BUILTIN_CACHE_STATS.misses = 0;
    BUILTIN_CACHE_STATS.sets = 0;
    BUILTIN_CACHE_STATS.pathInvalidations = 0;
    BUILTIN_CACHE_STATS.globalInvalidations = 0;
    BUILTIN_CACHE_STATS.invalidatedResultEntries = 0;
    BUILTIN_CACHE_STATS.invalidatedStatEntries = 0;
}
export function getBuiltinCacheStatsForTesting() {
    return { ...BUILTIN_CACHE_STATS };
}

// --- Read-before-Edit tracking (Claude Code parity) ---
//
// Anthropic FileEditTool enforces that a file must have been Read before
// it can be Edited. Prevents "phantom edits" where the model invents an
// old_string based on cached assumptions and accidentally rewrites a
// file that has drifted on disk. Also unblocks write-then-edit: after a
// successful Write the path is marked read-known so a subsequent Edit
// does not have to round-trip through Read.
//
// Value stores the mtime + size at read-time. Edit stats the
// file again and reject with error [code 7] when the current mtime has
// advanced — detects lint/formatter/external-write drift the way
// Anthropic's readFileState timestamp check does.
const DEFAULT_READ_STATE_SCOPE = '__global__';
const _readFilesByScope = new Map(); // scope → Map(fullPath → { mtimeMs, size, ...meta })

// Per-path mutex for concurrent Edit/Write operations. Maps absPath → Promise
// chain so that overlapping calls for the same file are serialised in-process.
const _editLocks = new Map();

function _withPathLock(absPath, fn) {
    const prev = _editLocks.get(absPath) ?? Promise.resolve();
    const next = prev.then(fn, fn); // pass through errors so chain never stalls
    _editLocks.set(absPath, next.then(
        () => { if (_editLocks.get(absPath) === next) _editLocks.delete(absPath); },
        () => { if (_editLocks.get(absPath) === next) _editLocks.delete(absPath); },
    ));
    return next;
}

function _readScopeKey(scope) {
    return scope ? String(scope) : DEFAULT_READ_STATE_SCOPE;
}

function _readFilesForScope(scope) {
    const key = _readScopeKey(scope);
    let readFiles = _readFilesByScope.get(key);
    if (!readFiles) {
        readFiles = new Map();
        _readFilesByScope.set(key, readFiles);
    }
    return readFiles;
}

function _hashText(text) {
    return createHash('sha256').update(String(text ?? '')).digest('hex');
}

function _recordReadSnapshot(fullPath, st, scope = null, meta = {}) {
    const readFiles = _readFilesForScope(scope);
    let mtimeMs;
    let size;
    try {
        if (st && typeof st.mtimeMs === 'number') {
            mtimeMs = st.mtimeMs;
            size = st.size;
        } else {
            const fresh = statSync(fullPath);
            mtimeMs = fresh.mtimeMs;
            size = fresh.size;
        }
    } catch {
        mtimeMs = Date.now();
        size = 0;
    }
    const incomingRanges = Array.isArray(meta.ranges) && meta.ranges.length > 0
        ? meta.ranges
        : [{ startLine: 1, endLine: Infinity }];
    const existing = readFiles.get(fullPath);
    const sameFile = existing
        && existing.mtimeMs === mtimeMs
        && existing.size === size
        && Array.isArray(existing.ranges);
    const merged = sameFile
        ? _mergeReadRanges([...existing.ranges, ...incomingRanges])
        : _mergeReadRanges(incomingRanges);
    const { ranges: _omitRanges, ...restMeta } = meta;
    const next = { ...restMeta, mtimeMs, size, ranges: merged };
    if (!next.contentHash && sameFile && existing.contentHash) {
        next.contentHash = existing.contentHash;
    }
    // Full-coverage snapshots without a contentHash are stale-blind: same-mtime
    // (≤1ms FS resolution on Windows NTFS) + same-size external rewrites slip
    // past _isSnapshotStale. Compute the hash here so write-side CAS detects
    // the rewrite even when timestamp/size invariants hold.
    if (!next.contentHash && _snapshotCoversFullFile(next)) {
        try {
            const content = readFileSync(fullPath, 'utf-8');
            next.contentHash = _hashText(content);
        } catch { /* unreadable — leave hashless */ }
    }
    readFiles.set(fullPath, next);
}

function _mergeReadRanges(ranges) {
    const filtered = (Array.isArray(ranges) ? ranges : [])
        .filter((r) => r && Number.isFinite(Number(r.startLine)) && (Number.isFinite(Number(r.endLine)) || r.endLine === Infinity))
        .map((r) => ({
            startLine: Math.max(1, Number(r.startLine)),
            endLine: r.endLine === Infinity ? Infinity : Number(r.endLine),
        }))
        .filter((r) => r.endLine === Infinity || r.endLine >= r.startLine)
        .sort((a, b) => a.startLine - b.startLine);
    if (filtered.length === 0) return [];
    const out = [{ ...filtered[0] }];
    for (let i = 1; i < filtered.length; i++) {
        const top = out[out.length - 1];
        const cur = filtered[i];
        const topEnd = top.endLine === Infinity ? Infinity : top.endLine;
        const adjacent = topEnd === Infinity ? true : cur.startLine <= topEnd + 1;
        if (adjacent) {
            top.endLine = top.endLine === Infinity || cur.endLine === Infinity
                ? Infinity
                : Math.max(top.endLine, cur.endLine);
        } else {
            out.push({ ...cur });
        }
    }
    return out;
}

function _snapshotCoversFullFile(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.ranges)) return false;
    return snapshot.ranges.some((r) => r.startLine <= 1 && r.endLine === Infinity);
}

function _getReadSnapshot(fullPath, scope = null) {
    return _readFilesForScope(scope).get(fullPath);
}

function _isSnapshotStale(stat, snapshot, fullPath = '') {
    // W1 H: any mtime drift counts as stale. Restored / rewound mtimes
    // (touch -d, tar restore, file revert) preserve size while shifting
    // mtime backward; the prior `> +1` check let those pass when size
    // matched. Treat any delta beyond 1ms FS-resolution noise as drift.
    if (Math.abs(stat.mtimeMs - snapshot.mtimeMs) > 1) return true;
    // Same-mtime contentHash mismatch on full snapshots: in-place rewrite
    // with identical length within FS timestamp resolution.
    if (snapshot.contentHash) {
        if (!fullPath) return false;
        try {
            const cur = readFileSync(fullPath, 'utf-8');
            // No `cur &&` guard — empty-file rewrite must still hash-mismatch
            // against a non-empty snapshot hash.
            if (_hashText(cur) !== snapshot.contentHash) return true;
        } catch { /* stat race or unreadable — skip hash check */ }
    }
    // CC parity: same-mtime size drift counts as stale. NTFS / exFAT
    // 1 s mtime resolution lets a fast rewrite preserve mtimeMs while
    // the byte length changes; size check catches that case.
    if (typeof snapshot.size === 'number' && stat.size !== snapshot.size) return true;
    // D-R1-1: partial range reads >64KiB carry a rangeHash (SHA-256 of the
    // read-range text). Same-mtime+same-size external rewrites inside the
    // range slip past the mtime/size checks above; rangeHash catches them.
    // The snapshot has no contentHash in this path (partial read), so the
    // contentHash branch above is a no-op. Check rangeHash lazily here.
    if (snapshot.rangeHash && !snapshot.contentHash && fullPath) {
        try {
            const _raw = readFileSync(fullPath, 'utf-8');
            const _lines = _raw.split('\n')
            const _ranges = Array.isArray(snapshot.ranges) ? snapshot.ranges : [];
            if (_ranges.length > 0) {
                const _r = _ranges[0];
                const _startIdx = Math.max(0, (_r.startLine || 1) - 1);
                const _endIdx = _r.endLine === Infinity ? _lines.length : Math.min(_lines.length, _r.endLine);
                const _rangeText = _lines.slice(_startIdx, _endIdx).join('\n');
                if (_hashText(_rangeText) !== snapshot.rangeHash) return true;
            }
        } catch { /* unreadable - skip */ }
    }
    return false;
}

function _readContentIfSnapshotHashMatches(fullPath, snapshot) {
    if (!snapshot || !snapshot.contentHash) return null;
    try {
        const content = readFileSync(fullPath, 'utf-8');
        return _hashText(content) === snapshot.contentHash ? content : null;
    } catch {
        return null;
    }
}

// Reject edits whose target text sits outside any line window the
// snapshot actually covered. The snapshot tracks one or more ranges
// (full reads → [{1, ∞}]; partial reads accumulate the union of
// windows for the same mtime/size). An edit passes when its match
// line range is contained in at least one snapshot range. Full
// coverage bypasses the check; missing/empty ranges → reject.
function _validatePartialSnapshotCoverage(content, oldStr, snapshot, filePath) {
    if (!snapshot) return null;
    if (_snapshotCoversFullFile(snapshot)) return null;
    if (typeof oldStr !== 'string' || oldStr.length === 0) return null;
    const ranges = Array.isArray(snapshot.ranges) ? snapshot.ranges : [];
    if (ranges.length === 0) {
        return `Error [code 6]: edit target lies outside the read window for ${filePath} — re-read the file (or read with a wider range covering the edit) before editing`;
    }
    let idx = 0;
    while ((idx = content.indexOf(oldStr, idx)) !== -1) {
        const startLine = _lineForIndex(content, idx);
        const endLine = startLine + oldStr.split('\n').length - 1;
        const covered = ranges.some((r) => r.startLine <= startLine && (r.endLine === Infinity || r.endLine >= endLine));
        if (!covered) {
            const windows = ranges.map((r) => `${r.startLine}-${r.endLine === Infinity ? 'EOF' : r.endLine}`).join(', ');
            return `Error [code 6]: edit target at lines ${startLine}-${endLine} lies outside the read windows [${windows}] for ${filePath} — re-read the file (or read with a wider range covering the edit) before editing`;
        }
        idx += oldStr.length;
    }
    return null;
}

// Lenient widening: when a unique `old_string` match is found in the
// current on-disk content of a snapshot whose mtime/size still matches,
// extend the snapshot's ranges to cover the match site. Skips a forced
// re-read when the model edits adjacent to (but outside) what it
// already read. Multi-match keeps the strict reject upstream.
function _maybeExtendSnapshotForUniqueMatch(_content, _oldStr, _snapshot) {
    // W1 H: auto-widening removed. Silently mutating snapshot.ranges to
    // admit an unread match defeated the partial-read edit gate — the
    // model could edit lines it never saw as long as old_string was
    // unique. Callers must explicitly re-read with a window covering
    // the edit target.
    return false;
}

function _countOccurrences(haystack, needle) {
    if (typeof needle !== 'string' || needle.length === 0) return 0;
    let count = 0;
    let idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) {
        count++;
        idx += needle.length;
    }
    return count;
}

function _lineContextAround(content, startLine, endLine, radius = 3, maxChars = 1600) {
    const lines = String(content ?? '').split('\n');
    const total = lines.length;
    const start = Math.max(1, Math.min(total, startLine) - radius);
    const end = Math.min(total, Math.max(startLine, endLine) + radius);
    let out = lines
        .slice(start - 1, end)
        .map((line, i) => `${start + i}\t${line}`)
        .join('\n');
    if (out.length > maxChars) {
        const head = out.slice(0, Math.floor(maxChars * 0.6));
        const tail = out.slice(Math.max(0, out.length - Math.floor(maxChars * 0.4)));
        out = `${head}\n... [context middle omitted] ...\n${tail}`;
    }
    return out;
}

function _lineForIndex(content, index) {
    if (index <= 0) return 1;
    return content.slice(0, index).split('\n').length;
}

function _primeReadSnapshotForEdit({ fullPath, filePath, st, scope, oldStrings = [], lineRange = null }) {
    if (!st || st.size > READ_MAX_SIZE_BYTES || isBinaryFile(fullPath, st.size)) return null;
    let content;
    try { content = readFileSync(fullPath, 'utf-8'); }
    catch { return null; }
    const lines = content.split('\n');
    _recordReadSnapshot(fullPath, st, scope, {
        source: 'auto_snapshot',
        contentHash: _hashText(content),
    });

    const out = [
        `Error [code 6]: file has not been read yet — snapshot recorded now for ${normalizeOutputPath(filePath)}. Retry the edit directly; no separate read call is needed.`,
    ];
    const checks = [];
    let firstContext = null;
    for (let i = 0; i < Math.min(oldStrings.length, 5); i++) {
        const entry = oldStrings[i] || {};
        const label = entry.label || `edit ${i}`;
        const oldString = entry.old_string;
        if (typeof oldString !== 'string' || oldString.length === 0) continue;
        const count = _countOccurrences(content, oldString);
        checks.push(`${label}: old_string ${count === 1 ? 'found once' : count === 0 ? 'not found' : `found ${count} times`}`);
        if (!firstContext && count > 0) {
            const idx = content.indexOf(oldString);
            const startLine = _lineForIndex(content, idx);
            const endLine = startLine + oldString.split('\n').length - 1;
            firstContext = _lineContextAround(content, startLine, endLine);
        }
    }
    if (checks.length > 0) out.push(`Match check: ${checks.join('; ')}`);
    if (lineRange) {
        out.push(`Line check: requested ${lineRange.startLine}-${lineRange.endLine}; file has ${lines.length} lines.`);
        out.push(`Context around requested lines:\n${_lineContextAround(content, lineRange.startLine, lineRange.endLine)}`);
    } else if (firstContext) {
        out.push(`Context around first match:\n${firstContext}`);
    }
    return out.join('\n');
}

function getShellJobsDir() {
    const dir = join(getPluginData(), 'shell-jobs');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}
function shellJobDetailPath(jobId) { return join(getShellJobsDir(), `${jobId}.json`); }
function shellJobStdoutPath(jobId) { return join(getShellJobsDir(), `${jobId}.stdout.log`); }
function shellJobStderrPath(jobId) { return join(getShellJobsDir(), `${jobId}.stderr.log`); }
function shellJobExitPath(jobId) { return join(getShellJobsDir(), `${jobId}.exit`); }
function shellJobDonePath(jobId) { return join(getShellJobsDir(), `${jobId}.done`); }
const JOB_STATUS_PREVIEW_MAX_BYTES = 4096;
const JOB_STATUS_PREVIEW_MAX_LINES = 20;
const JOB_STATUS_PREVIEW_MAX_CHARS = 1200;
function writeShellJobDetail(detail) {
    writeFileSync(shellJobDetailPath(detail.jobId), JSON.stringify(detail, null, 2), 'utf-8');
}
function readShellJobDetail(jobId) {
    try {
        const p = shellJobDetailPath(jobId);
        if (!existsSync(p)) return null;
        return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
        return null;
    }
}
function isPidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
function killProcessTree(pid, signal = 'SIGTERM') {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        } else {
            try { process.kill(-pid, signal); }
            catch { process.kill(pid, signal); }
        }
        return true;
    } catch {
        return false;
    }
}
function shellQuoteSingle(s) {
    return `'${String(s).replace(/'/g, `'\"'\"'`)}'`;
}
function readTailPreviewSync(filePath, { maxBytes = JOB_STATUS_PREVIEW_MAX_BYTES, maxLines = JOB_STATUS_PREVIEW_MAX_LINES, maxChars = JOB_STATUS_PREVIEW_MAX_CHARS } = {}) {
    try {
        if (!filePath || !existsSync(filePath)) return null;
        const st = statSync(filePath);
        if (!st.isFile()) return null;
        const size = st.size;
        if (size <= 0) return { bytes: 0, preview: '' };
        const readBytes = Math.min(size, maxBytes);
        const fd = openSync(filePath, 'r');
        try {
            const buf = Buffer.alloc(readBytes);
            readSync(fd, buf, 0, readBytes, size - readBytes);
            let text = buf.toString('utf8');
            if (size > readBytes) {
                const nl = text.indexOf('\n');
                if (nl !== -1) text = text.slice(nl + 1);
            }
            let lines = text.split(/\r?\n/);
            if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
            let truncated = size > readBytes;
            if (lines.length > maxLines) {
                lines = lines.slice(-maxLines);
                truncated = true;
            }
            let preview = lines.join('\n');
            if (preview.length > maxChars) {
                preview = preview.slice(preview.length - maxChars);
                const nl = preview.indexOf('\n');
                if (nl !== -1) preview = preview.slice(nl + 1);
                truncated = true;
            }
            return {
                bytes: size,
                preview,
                truncated,
            };
        } finally {
            try { closeSync(fd); } catch { /* ignore */ }
        }
    } catch {
        return null;
    }
}
function attachJobPreview(detail) {
    if (!detail || typeof detail !== 'object') return detail;
    const withPreview = { ...detail };
    const stdoutInfo = readTailPreviewSync(detail.stdoutPath);
    if (stdoutInfo) {
        withPreview.stdoutBytes = stdoutInfo.bytes;
        if (stdoutInfo.preview) withPreview.stdoutPreview = stdoutInfo.preview;
        if (stdoutInfo.truncated) withPreview.stdoutPreviewTruncated = true;
    }
    if (detail.mergeStderr !== true) {
        const stderrInfo = readTailPreviewSync(detail.stderrPath);
        if (stderrInfo) {
            withPreview.stderrBytes = stderrInfo.bytes;
            if (stderrInfo.preview) withPreview.stderrPreview = stderrInfo.preview;
            if (stderrInfo.truncated) withPreview.stderrPreviewTruncated = true;
        }
    }
    return withPreview;
}
function summarizeJobPreviewText(text, maxChars = 160) {
    if (typeof text !== 'string' || !text.trim()) return '';
    const lines = text
        .split(/\r?\n/)
        .map((line) => stripAnsi(line).replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    if (lines.length === 0) return '';
    let summary = lines[lines.length - 1];
    if (summary.length > maxChars) summary = `${summary.slice(0, maxChars - 1)}…`;
    return summary;
}
function attachJobInsights(detail) {
    const withPreview = attachJobPreview(detail);
    if (!withPreview || typeof withPreview !== 'object') return withPreview;
    let summary = '';
    let summarySource = '';
    if (withPreview.status === 'completed') {
        summary = summarizeJobPreviewText(withPreview.stdoutPreview)
            || summarizeJobPreviewText(withPreview.stderrPreview);
        summarySource = summary ? (withPreview.stdoutPreview ? 'stdout' : 'stderr') : '';
    } else if (withPreview.status === 'failed') {
        summary = summarizeJobPreviewText(withPreview.stderrPreview)
            || summarizeJobPreviewText(withPreview.stdoutPreview)
            || String(withPreview.error || '').trim();
        summarySource = summary ? (withPreview.stderrPreview ? 'stderr' : (withPreview.stdoutPreview ? 'stdout' : 'status')) : '';
    } else if (withPreview.status === 'cancelled') {
        summary = 'cancelled before completion';
        summarySource = 'status';
    } else if (withPreview.status === 'running') {
        summary = summarizeJobPreviewText(withPreview.stdoutPreview)
            || summarizeJobPreviewText(withPreview.stderrPreview);
        summarySource = summary ? (withPreview.stdoutPreview ? 'stdout' : 'stderr') : '';
    }
    if (summary) {
        withPreview.summary = summary;
        withPreview.summarySource = summarySource;
    }
    return withPreview;
}
async function waitForShellJob(jobId, { timeoutMs = 30_000, pollMs = 250 } = {}) {
    const started = Date.now();
    const deadline = started + Math.max(0, timeoutMs);
    let detail = refreshShellJob(jobId);
    if (!detail) return null;
    while (detail && detail.status === 'running' && Date.now() < deadline) {
        await _sleep(Math.max(25, pollMs));
        detail = refreshShellJob(jobId);
    }
    const withInsights = attachJobInsights(detail);
    if (!withInsights) return null;
    withInsights.waitedMs = Date.now() - started;
    if (withInsights.status === 'running') withInsights.waitTimedOut = true;
    return withInsights;
}
function refreshShellJob(jobId) {
    const detail = readShellJobDetail(jobId);
    if (!detail) return null;
    if (detail.status !== 'running') return detail;
    const exitPath = shellJobExitPath(jobId);
    if (existsSync(exitPath)) {
        let exitCode = null;
        try {
            const raw = readFileSync(exitPath, 'utf-8').trim();
            const parsed = parseInt(raw, 10);
            exitCode = Number.isFinite(parsed) ? parsed : null;
        } catch { /* ignore */ }
        let finishedAt = new Date().toISOString();
        try {
            finishedAt = new Date(statSync(exitPath).mtimeMs).toISOString();
        } catch { /* ignore */ }
        detail.status = exitCode === 0 ? 'completed' : 'failed';
        detail.exitCode = exitCode;
        detail.finishedAt = finishedAt;
        writeShellJobDetail(detail);
        return detail;
    }
    const timeoutMs = Number(detail.timeoutMs || 0);
    const startedAtMs = Date.parse(detail.startedAt || '');
    if (timeoutMs > 0 && Number.isFinite(startedAtMs) && Date.now() - startedAtMs > timeoutMs) {
        killProcessTree(detail.pid, 'SIGTERM');
        detail.status = 'failed';
        detail.exitCode = 124;
        detail.finishedAt = new Date().toISOString();
        detail.error = `timed out after ${timeoutMs} ms`;
        writeShellJobDetail(detail);
        return detail;
    }
    if (detail.pid && !isPidAlive(detail.pid)) {
        detail.status = 'failed';
        detail.finishedAt = new Date().toISOString();
        detail.error = 'process exited without completion marker';
        writeShellJobDetail(detail);
    }
    return detail;
}
function startBackgroundShellJob({ command, timeoutMs, workDir, mergeStderr, spawnEnv, shell, shellArg }) {
    // POSIX-shell guard: the wrapper below uses `command -v timeout`,
    // `if ... fi`, single-quote escape, and POSIX exit-code propagation.
    // Windows-native cmd.exe / pwsh.exe parses none of that; refuse early
    // with an actionable error. Git Bash / MSYS / WSL bash all qualify.
    const _shellLower = String(shell || '').toLowerCase();
    if (process.platform === 'win32'
        && !(_shellLower.includes('bash') || _shellLower.endsWith('/sh') || _shellLower.endsWith('\\sh.exe'))) {
        const jobId = `job_${Date.now()}_unsupported`;
        return {
            jobId,
            kind: 'bash',
            status: 'failed',
            error: `background bash jobs require a POSIX-compatible shell on Windows (resolved=${shell}); install Git Bash or use WSL`,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
        };
    }
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const stdoutPath = shellJobStdoutPath(jobId);
    const stderrPath = shellJobStderrPath(jobId);
    const exitPath = shellJobExitPath(jobId);
    const donePath = shellJobDonePath(jobId);
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    // P2 fix: wrap with POSIX `timeout` so the kernel terminates the
    // process at deadline regardless of mixdog parent state. Previously
    // only the setTimeout below enforced; a mixdog restart between spawn
    // and deadline would orphan the runaway. --preserve-status keeps the
    // user command's exit code on success; on timeout the wrapper exits 124.
    // `timeout` ships with GNU coreutils (Linux + Git Bash on Windows) and
    // brew coreutils on macOS; absent platforms fall through to the inner
    // command (the parent setTimeout still calls refreshShellJob to clean up).
    const _userCmdQuoted = shellQuoteSingle(command);
    // P2 fix: invoke the resolved shell (not bash -c) so zsh / dash /
    // alternate shells run snapshot-aware commands correctly. Drop
    // --preserve-status so timeout returns 124 unambiguously, making
    // it trivial to distinguish a timeout (124) from a user-side
    // SIGTERM exit (143).
    const _innerShellQ = shellQuoteSingle(shell);
    const _innerArgQ = shellQuoteSingle(shellArg);
    const wrapped = `{ if command -v timeout >/dev/null 2>&1; then timeout ${timeoutSeconds} ${_innerShellQ} ${_innerArgQ} ${_userCmdQuoted}; else ${_innerShellQ} ${_innerArgQ} ${_userCmdQuoted}; fi; rc=$?; printf '%s' \"$rc\" > ${shellQuoteSingle(exitPath)}; touch ${shellQuoteSingle(donePath)}; exit $rc; }`;
    // W1 L: keep the parent fds so we can close them once the child has
    // dup'd them. Leaking these meant a long-running mixdog process held
    // a growing handle table for every background job.
    const _stdoutFd = openSync(stdoutPath, 'a');
    const _stderrFd = mergeStderr ? _stdoutFd : openSync(mergeStderr ? stdoutPath : stderrPath, 'a');
    const child = spawn(shell, [shellArg, wrapped], {
        cwd: workDir,
        env: spawnEnv,
        detached: true,
        stdio: ['ignore', _stdoutFd, _stderrFd],
        windowsHide: true,
    });
    child.unref();
    try { closeSync(_stdoutFd); } catch { /* already inherited by child */ }
    if (_stderrFd !== _stdoutFd) {
        try { closeSync(_stderrFd); } catch { /* already inherited */ }
    }
    const detail = {
        jobId,
        kind: 'bash',
        status: 'running',
        command,
        cwd: workDir,
        pid: child.pid,
        mergeStderr,
        timeoutMs,
        timeoutSeconds,
        stdoutPath,
        stderrPath: mergeStderr ? stdoutPath : stderrPath,
        exitPath,
        donePath,
        startedAt: new Date().toISOString(),
    };
    writeShellJobDetail(detail);
    const timer = setTimeout(() => { refreshShellJob(jobId); }, timeoutMs + 25);
    if (typeof timer.unref === 'function') timer.unref();
    return detail;
}

// --- Blocked commands for safety ---
// Anchor for "command start": line start, after ; && || | (with optional whitespace)
const _CMD_START = '(?:^|[;&|\\n(){}]\\s*|\\$[\\({]\\s*|[<>]\\(\\s*|`\\s*)';
const BLOCKED_PATTERNS = [
    // rm — catch -rf, -fr, split flags (-r -f / -f -r), and `--` separator;
    // target restricted to / or ~ so legitimate `rm -rf .build` still passes.
    // W1 H: allow any number of intervening options (e.g. --no-preserve-root)
    // between the recursive-force flag and the root target. Prior pattern
    // only allowed bare `--` and missed `rm -rf --no-preserve-root /`.
    /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-[rR]\s+-[fF]|-[fF]\s+-[rR])(?:\s+(?:--?[a-zA-Z][\w-]*))*\s+[\/~]/i,
    // W1 H: force-push variants. --force, -f, --force-with-lease, and the
    // leading-plus refspec form (`git push origin +branch`) all rewrite
    // remote history without warning.
    /\bgit\s+push\s+(?:[^\n]*\s)?(?:--force(?:-with-lease)?|-f)\b/i,
    /\bgit\s+push\s+\S+\s+\+/i,
    /\bgit\s+reset\s+--hard/i,
    /\bformat\s+[a-z]:/i,
    /\b(shutdown|reboot|halt)\b/i,
    /\bdel\s+\/[sfq]/i,
    // W1 H: Windows root removal via cmd builtins. `rmdir /s /q C:\` and
    // its alias `rd /s /q D:\` wipe an entire drive without confirmation.
    /\b(?:rmdir|rd)\s+(?:\/[sq]\s+)+[a-zA-Z]:\\?/i,
    new RegExp(_CMD_START + 'mkfs(?:\\.|\\b)', 'i'),
    new RegExp(_CMD_START + 'dd\\s+[^\\n]*\\bif=/dev/', 'i'),
    // W1 H: dd writing to a block device (disk wipe). Block of=/dev/* the
    // same way if=/dev/* (read from device) is blocked.
    new RegExp(_CMD_START + 'dd\\s+[^\\n]*\\bof=/dev/', 'i'),
    new RegExp(_CMD_START + 'diskpart\\b[^\\n]*\\bclean\\b', 'i'),
    /:\(\)\s*\{[^}]*:\|:&[^}]*\};\s*:/, // bash fork-bomb signature (idempotent string)
];
const SHELL_MUTATION_PATTERN = /(?:^|[;&|\n]\s*)(?:touch|mkdir|mktemp|rm|rmdir|mv|cp|install|ln|chmod|chown|truncate|dd|sed\s+-i|perl\s+-pi|npm\s+(?:install|i|ci|uninstall)|pnpm\s+(?:install|i|add|remove|update|up)|yarn\s+(?:install|add|remove|up)|bun\s+(?:install|add|remove|update|up)|pip(?:3)?\s+install|python(?:3)?\s+-m\s+pip\s+install|git\s+(?:checkout|switch|restore|clean|apply|am|cherry-pick|merge|rebase|stash|pull|reset)|cargo\s+(?:build|install|clean)|go\s+(?:build|install|generate)|make|cmake)\b/i;
const SHELL_READ_ONLY_SEGMENT_RE = /^(?:cd|pwd|echo|printf|env|printenv|set|unset|export|alias|unalias|source|\.|type|which|whereis|ls|dir|cat|head|tail|wc|grep|rg|find|git\s+(?:status|diff|show|log|rev-parse|branch|remote|ls-files)|stat|readlink|realpath|basename|dirname|sort|uniq|cut|sed\s+-n|awk|ps|whoami|uname|date|true|false|test|\[)\b/i;
const SHELL_GLOBAL_MUTATORS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'python', 'python3', 'git', 'cargo', 'go', 'make', 'cmake', 'dd']);
export function isSafePath(filePath, cwd, { allowHome = false, allowPluginData = false, allowPluginTree = false } = {}) {
    const baseCwd = normalize(resolve(cwd));
    const normalized = normalize(resolve(baseCwd, filePath));
    // Boundary-aware containment check: a path is "inside" baseCwd iff
    // it equals baseCwd or starts with baseCwd + separator. Without the
    // trailing-separator guard, `/home/u` would falsely contain
    // `/home/u2`. Windows uses case-insensitive compare (NTFS default).
    const isInside = (child, parent) => {
        if (!parent) return false;
        const c = process.platform === 'win32' ? child.toLowerCase() : child;
        const p = process.platform === 'win32' ? parent.toLowerCase() : parent;
        if (c === p) return true;
        return c.startsWith(p.endsWith(sep) ? p : p + sep);
    };
    const allowedRoots = [baseCwd];
    // HOME fallback is now an explicit opt-in capability (B2). When
    // `allowHome=false` (the default), paths outside cwd are rejected
    // outright — no silent widening to $HOME. The main-agent path
    // gate passes `allowHome` from `capabilities.homeAccess`.
    if (allowHome) {
        const home = process.env.HOME || process.env.USERPROFILE || '';
        if (home) allowedRoots.push(normalize(home));
    }
    // Tool-result offload files live under the plugin data directory, which
    // is often outside the workspace and sometimes outside HOME in tests.
    // Read-like tools may opt into this root so the advertised "read saved
    // output" recovery path actually works without widening write tools.
    if (allowPluginData) {
        try { allowedRoots.push(normalize(resolve(getPluginData()))); } catch { /* plugin data unavailable in standalone tests */ }
    }
    // Plugin tree opt-in: ~/.claude/plugins/marketplaces and ~/.claude/plugins/cache.
    // Never granted by default; callers must pass allowPluginTree: true explicitly.
    // WRITE tools must never pass this flag.
    if (allowPluginTree) {
        const pluginBase = join(homedir(), '.claude', 'plugins');
        allowedRoots.push(normalize(join(pluginBase, 'marketplaces')));
        allowedRoots.push(normalize(join(pluginBase, 'cache')));
    }
    const isInsideAllowedRoot = (candidate) => allowedRoots.some((root) => isInside(candidate, root));
    if (!isInsideAllowedRoot(normalized)) {
        return false;
    }
    // Symlink scope re-check. A symlink inside cwd (or any intermediate
    // symlink in the path) can point outside cwd; without this resolve step
    // the containment check above passes on the link path while the
    // downstream readFile / writeFile follows the link to the outside
    // target, bypassing the sandbox. realpathSync throws on nonexistent
    // paths — in that case we defer to the natural failure of the caller
    // (no escape is possible since the path never resolves).
    try {
        const real = normalize(realpathSync(normalized));
        // Symlink/junction inside cwd can resolve to \\server\share —
        // re-check for UNC after realpath so an in-sandbox link can't
        // trigger SMB / NTLM lookup downstream.
        if (isUncPath(real)) return false;
        if (real !== normalized && !isInsideAllowedRoot(real)) {
            return false;
        }
    } catch {
        // Path doesn't resolve — typically a Write target that doesn't
        // exist yet. Realpath the parent so an in-scope symlink dir that
        // targets out-of-scope (or UNC) can't be used to create a file
        // outside the sandbox.
        try {
            // W1 H: walk up to nearest existing ancestor and realpath that.
            // Single-level parent realpath let an in-scope symlink ancestor
            // (e.g. /cwd/links/dir → /etc/) escape the sandbox when the
            // immediate parent didn't exist yet but a grand-ancestor did.
            let cur = dirname(normalized);
            let prev = '';
            // Bound the walk so a pathological path can't loop forever.
            for (let i = 0; i < 64 && cur && cur !== prev; i++) {
                let real;
                try { real = realpathSync(cur); }
                catch { prev = cur; cur = dirname(cur); continue; }
                const realNorm = normalize(real);
                if (isUncPath(realNorm)) return false;
                if (!isInsideAllowedRoot(realNorm)) return false;
                break;
            }
        } catch { /* nothing resolved — let caller fail naturally */ }
    }
    return true;
}
function resolveAgainstCwd(filePath, cwd) {
    return resolve(cwd, filePath);
}
function _shellSplitSegments(command) {
    const parts = [];
    let current = '';
    let quote = null;
    let escape = false;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (escape) {
            current += ch;
            escape = false;
            continue;
        }
        if (ch === '\\') {
            current += ch;
            escape = true;
            continue;
        }
        if (quote) {
            current += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '\'' || ch === '"') {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === '\n' || ch === ';') {
            if (current.trim()) parts.push(current.trim());
            current = '';
            continue;
        }
        if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
            if (current.trim()) parts.push(current.trim());
            current = '';
            i++;
            continue;
        }
        current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}
function _shellTokenize(segment) {
    const tokens = [];
    let current = '';
    let quote = null;
    let escape = false;
    const push = () => {
        if (current !== '') tokens.push(current);
        current = '';
    };
    for (let i = 0; i < segment.length; i++) {
        const ch = segment[i];
        if (escape) {
            current += ch;
            escape = false;
            continue;
        }
        if (ch === '\\') {
            escape = true;
            continue;
        }
        if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
            continue;
        }
        if (ch === '\'' || ch === '"') {
            quote = ch;
            continue;
        }
        if (/\s/.test(ch)) {
            push();
            continue;
        }
        if (ch === '>') {
            push();
            if (segment[i + 1] === '>') {
                tokens.push('>>');
                i++;
            } else {
                tokens.push('>');
            }
            continue;
        }
        current += ch;
    }
    if (quote) return null;
    push();
    return tokens;
}
function _stripShellAssignments(tokens) {
    const out = [...tokens];
    while (out.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0])) out.shift();
    return out;
}
function _resolveShellPathToken(token, cwd) {
    const value = String(token || '').trim();
    if (!value) return null;
    if (value === '>' || value === '>>') return null;
    if (value.startsWith('-')) return null;
    if (/[`$*?[\]{}]/.test(value)) return null;
    return resolveAgainstCwd(normalizeInputPath(value), cwd);
}
function _isShellOutputRedirectToken(tok) {
    const lower = String(tok || '').toLowerCase();
    return lower === '>' || lower === '>>'
        || /^(?:\d+>>?|\d+>|&>>?|&>)$/.test(lower);
}
function _isShellInputRedirectToken(tok) {
    const lower = String(tok || '').toLowerCase();
    return lower === '<' || lower === '<<'
        || /^(?:\d*<<?)$/.test(lower);
}
function _extractShellPathArgs(tokens, cwd, { minIndex = 1 } = {}) {
    const out = [];
    for (let i = minIndex; i < tokens.length; i++) {
        const tok = tokens[i];
        if (!tok || tok === '--') continue;
        if (/^\d+$/.test(tok) && (_isShellOutputRedirectToken(tokens[i + 1]) || _isShellInputRedirectToken(tokens[i + 1]))) {
            continue;
        }
        if (_isShellOutputRedirectToken(tok)) {
            i++;
            continue;
        }
        if (_isShellInputRedirectToken(tok)) {
            const redirected = _resolveShellPathToken(tokens[i + 1], cwd);
            if (redirected) out.push(redirected);
            i++;
            continue;
        }
        const outputInline = /^(?:\d+>>?|\d+>|&>>?|&>)(.+)?$/i.exec(tok);
        if (outputInline) continue;
        const inputInline = /^(?:\d*<<?)(.+)$/i.exec(tok);
        if (inputInline) {
            const redirected = _resolveShellPathToken(inputInline[1], cwd);
            if (redirected) out.push(redirected);
            continue;
        }
        const resolved = _resolveShellPathToken(tok, cwd);
        if (resolved) out.push(resolved);
    }
    return out;
}
const LARGE_SHELL_FILE_PROBE_BYTES = 50 * 1024;
const CODE_GRAPH_HINT_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const LARGE_FILE_READ_CMDS = new Set(['cat', 'less', 'more', 'view', 'bat']);

function _isExplicitAbsoluteShellPath(value) {
    return isAbsolute(value)
        || /^[A-Za-z]:[\\/]/.test(value)
        || value.startsWith('\\\\');
}

function _hasDynamicShellBits(value) {
    return /[`$*?[\]{}]/.test(String(value || ''));
}

function _shellSplitPipelineSegments(segment) {
    const parts = [];
    let current = '';
    let quote = null;
    let escape = false;
    for (let i = 0; i < segment.length; i++) {
        const ch = segment[i];
        if (escape) {
            current += ch;
            escape = false;
            continue;
        }
        if (ch === '\\') {
            current += ch;
            escape = true;
            continue;
        }
        if (quote) {
            current += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '\'' || ch === '"') {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === '|') {
            if (current.trim()) parts.push(current.trim());
            current = '';
            if (segment[i + 1] === '&') i++;
            continue;
        }
        current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

function _stripShellProbeWrappers(tokens) {
    const out = _stripShellAssignments(tokens || []);
    let idx = 0;
    while (idx < out.length) {
        const tok = String(out[idx] || '').toLowerCase();
        if (!tok) { idx++; continue; }
        if (tok === 'sudo' || tok === 'nohup' || tok === 'exec') {
            out.splice(idx, 1);
            continue;
        }
        if (tok === 'command') {
            out.splice(idx, 1);
            while (idx < out.length && String(out[idx] || '').startsWith('-')) out.splice(idx, 1);
            continue;
        }
        if (tok === 'env') {
            out.splice(idx, 1);
            while (idx < out.length) {
                const cur = String(out[idx] || '');
                const lower = cur.toLowerCase();
                if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cur) || lower === '-i') {
                    out.splice(idx, 1);
                    continue;
                }
                if (lower === '-u' && idx + 1 < out.length) {
                    out.splice(idx, 2);
                    continue;
                }
                break;
            }
            continue;
        }
        break;
    }
    return out;
}

function _shellOptionConsumesValue(cmd, tok) {
    const lower = String(tok || '').toLowerCase();
    if (cmd === 'grep' || cmd === 'rg') {
        if (['-e', '-f', '-g', '--glob', '-A', '-B', '-C', '--context', '-t', '--type', '--type-add', '-m', '--max-count'].includes(lower)) return true;
        if (/^-[AABCegfmt]$/.test(lower)) return true;
    }
    if (cmd === 'sed') {
        if (['-e', '-f'].includes(lower)) return true;
    }
    if (cmd === 'awk') {
        if (['-f', '-F', '-v'].includes(lower)) return true;
    }
    return false;
}

function _isHeadTailBounded(tokens) {
    for (let i = 1; i < tokens.length; i++) {
        const tok = String(tokens[i] || '').toLowerCase();
        if (tok === '-n' || tok === '-c') return true;
        if (/^-(?:n|c)\d+$/.test(tok)) return true;
        if (/^-\d+$/.test(tok)) return true;
    }
    return false;
}

function _isGrepBounded(tokens) {
    for (let i = 1; i < tokens.length; i++) {
        const tok = String(tokens[i] || '').toLowerCase();
        if (tok === '-m' || tok === '--max-count') return true;
        if (/^-m\d+$/.test(tok)) return true;
        if (/^--max-count=/.test(tok)) return true;
    }
    return false;
}

function _isSedBounded(tokens) {
    const hasN = tokens.some((tok) => String(tok || '').toLowerCase() === '-n');
    if (!hasN) return false;
    const scriptIdx = tokens.findIndex((tok, idx) => idx > 0 && !String(tok || '').startsWith('-'));
    if (scriptIdx === -1) return false;
    const script = String(tokens[scriptIdx] || '');
    return /\b\d+(?:,\d+)?p\b/.test(script) || /^\d+(?:,\d+)?p$/.test(script);
}

function _isAwkBounded(tokens) {
    const scriptIdx = tokens.findIndex((tok, idx) => idx > 0 && !String(tok || '').startsWith('-'));
    if (scriptIdx === -1) return false;
    const script = String(tokens[scriptIdx] || '');
    return /\bNR\s*(?:==|<=|<|>=|>)\s*\d+/.test(script) || /NR\s*>=\s*\d+\s*&&\s*NR\s*<=\s*\d+/.test(script);
}

function _classifyShellProbeToken(token, cwd, { cwdKnown = true } = {}) {
    const value = String(token || '').trim();
    if (!value || value === '--') return { kind: 'skip' };
    if (_hasDynamicShellBits(value)) return { kind: 'dynamic', raw: value };
    const normalized = normalizeInputPath(value);
    if (!cwdKnown && !_isExplicitAbsoluteShellPath(normalized)) {
        return { kind: 'relative-unknown', raw: value };
    }
    return { kind: 'path', path: resolveAgainstCwd(normalized, cwd), raw: value };
}

function _extractShellProbeTargets(tokens, cwd, { minIndex = 1, cwdKnown = true } = {}) {
    const out = { paths: [], dynamicToken: null, skippedRelativeUnknown: false };
    for (let i = minIndex; i < tokens.length; i++) {
        const tok = tokens[i];
        if (!tok || tok === '--') continue;
        if (/^\d+$/.test(tok) && (_isShellOutputRedirectToken(tokens[i + 1]) || _isShellInputRedirectToken(tokens[i + 1]))) {
            continue;
        }
        if (_isShellOutputRedirectToken(tok)) {
            i++;
            continue;
        }
        if (_isShellInputRedirectToken(tok)) {
            const info = _classifyShellProbeToken(tokens[i + 1], cwd, { cwdKnown });
            if (info.kind === 'path') out.paths.push(info.path);
            else if (info.kind === 'dynamic' && !out.dynamicToken) out.dynamicToken = info.raw;
            else if (info.kind === 'relative-unknown') out.skippedRelativeUnknown = true;
            i++;
            continue;
        }
        const outputInline = /^(?:\d+>>?|\d+>|&>>?|&>)(.+)?$/i.exec(tok);
        if (outputInline) continue;
        const inputInline = /^(?:\d*<<?)(.+)$/i.exec(tok);
        if (inputInline) {
            const info = _classifyShellProbeToken(inputInline[1], cwd, { cwdKnown });
            if (info.kind === 'path') out.paths.push(info.path);
            else if (info.kind === 'dynamic' && !out.dynamicToken) out.dynamicToken = info.raw;
            else if (info.kind === 'relative-unknown') out.skippedRelativeUnknown = true;
            continue;
        }
        const info = _classifyShellProbeToken(tok, cwd, { cwdKnown });
        if (info.kind === 'path') out.paths.push(info.path);
        else if (info.kind === 'dynamic' && !out.dynamicToken) out.dynamicToken = info.raw;
        else if (info.kind === 'relative-unknown') out.skippedRelativeUnknown = true;
    }
    return out;
}

function _extractShellProbePaths(tokens, cwd, { cwdKnown = true } = {}) {
    const cmd = String(tokens?.[0] || '').toLowerCase();
    if (!cmd) return { paths: [], dynamicToken: null, skippedRelativeUnknown: false, cmd: '' };
    if (LARGE_FILE_READ_CMDS.has(cmd)) {
        return { ..._extractShellProbeTargets(tokens, cwd, { minIndex: 1, cwdKnown }), cmd };
    }
    if (cmd === 'head' || cmd === 'tail') {
        if (_isHeadTailBounded(tokens)) return { paths: [], dynamicToken: null, skippedRelativeUnknown: false, cmd };
        return { ..._extractShellProbeTargets(tokens, cwd, { minIndex: 1, cwdKnown }), cmd };
    }
    if (cmd === 'grep' || cmd === 'rg') {
        if (_isGrepBounded(tokens)) return { paths: [], dynamicToken: null, skippedRelativeUnknown: false, cmd };
        let i = 1;
        let sawPattern = false;
        while (i < tokens.length) {
            const tok = tokens[i];
            if (!tok) { i++; continue; }
            if (!sawPattern) {
                if (tok === '--') { i++; continue; }
                if (tok.startsWith('-')) {
                    i += _shellOptionConsumesValue(cmd, tok) ? 2 : 1;
                    continue;
                }
                sawPattern = true;
                i++;
                continue;
            }
            break;
        }
        return { ..._extractShellProbeTargets(tokens, cwd, { minIndex: i, cwdKnown }), cmd };
    }
    if (cmd === 'sed') {
        if (_isSedBounded(tokens)) return { paths: [], dynamicToken: null, skippedRelativeUnknown: false, cmd };
        let i = 1;
        while (i < tokens.length) {
            const tok = tokens[i];
            if (!tok) { i++; continue; }
            if (tok === '--') { i++; break; }
            if (tok.startsWith('-')) {
                i += _shellOptionConsumesValue(cmd, tok) ? 2 : 1;
                continue;
            }
            // First non-option token is the script/program. Remaining
            // path-like args are candidate target files.
            i++;
            break;
        }
        return { ..._extractShellProbeTargets(tokens, cwd, { minIndex: i, cwdKnown }), cmd };
    }
    if (cmd === 'awk') {
        if (_isAwkBounded(tokens)) return { paths: [], dynamicToken: null, skippedRelativeUnknown: false, cmd };
        let i = 1;
        while (i < tokens.length) {
            const tok = tokens[i];
            if (!tok) { i++; continue; }
            if (tok === '--') { i++; break; }
            if (tok.startsWith('-')) {
                i += _shellOptionConsumesValue(cmd, tok) ? 2 : 1;
                continue;
            }
            i++;
            break;
        }
        return { ..._extractShellProbeTargets(tokens, cwd, { minIndex: i, cwdKnown }), cmd };
    }
    return { paths: [], dynamicToken: null, skippedRelativeUnknown: false, cmd };
}

function _buildLargeShellFileProbeMessage(fullPath, sizeBytes, cmd, cwd) {
    const kb = Math.round(sizeBytes / 1024);
    const display = normalizeOutputPath(cwdRelativePath(fullPath, cwd));
    const lines = [
        `large-file shell probe blocked: \`${cmd}\` is targeting \`${display}\` (${kb} KB).`,
        'Use higher-signal tools instead:',
        '- `read` with `offset`/`limit` for targeted inspection',
        '- builtin `grep` with array patterns for content search',
        '- `edit` with `edits` array or `apply_patch` for changes',
    ];
    if (CODE_GRAPH_HINT_EXTS.has(extname(fullPath).toLowerCase())) {
        lines.push('- `code_graph` for structural navigation (imports, symbols, dependents)');
    }
    lines.push('If shell state is truly required, narrow the file/range first and retry with a smaller target.');
    return lines.join('\n');
}

export function preflightShellLargeFileProbe(command, cwd) {
    const text = String(command || '').trim();
    let localCwd = resolve(cwd || process.cwd());
    let cwdKnown = true;
    if (!text) return null;
    for (const segment of _shellSplitSegments(text)) {
        for (const stage of _shellSplitPipelineSegments(segment)) {
            const parsed = _shellTokenize(stage);
            if (!parsed) return null;
            const tokens = _stripShellProbeWrappers(parsed);
            if (tokens.length === 0) continue;
            const joined = tokens.join(' ');
            if (/^cd\b/i.test(joined)) {
                const target = tokens[1] || process.env.HOME || process.env.USERPROFILE || localCwd;
                if (_hasDynamicShellBits(target)) {
                    cwdKnown = false;
                } else {
                    const resolved = _resolveShellPathToken(target, localCwd);
                    if (resolved) {
                        localCwd = resolved;
                        cwdKnown = true;
                    } else {
                        cwdKnown = false;
                    }
                }
                continue;
            }
            const probe = _extractShellProbePaths(tokens, localCwd, { cwdKnown });
            if (probe.dynamicToken) {
                return {
                    cmd: probe.cmd,
                    path: null,
                    sizeBytes: null,
                    message: `shell probe requires an explicit path: \`${probe.cmd}\` is using dynamic path token \`${probe.dynamicToken}\`. Expand variables/globs first and retry with an explicit file path.`,
                };
            }
            if (probe.skippedRelativeUnknown && probe.paths.length === 0) {
                continue;
            }
            for (const candidate of probe.paths) {
                try {
                    const st = statSync(candidate);
                    if (!st.isFile()) continue;
                    if (st.size < LARGE_SHELL_FILE_PROBE_BYTES) continue;
                    return {
                        cmd: probe.cmd,
                        path: candidate,
                        sizeBytes: st.size,
                        message: _buildLargeShellFileProbeMessage(candidate, st.size, probe.cmd, localCwd),
                    };
                } catch {
                    // Ignore nonexistent / inaccessible candidates — shell can
                    // surface those normally if the command proceeds.
                }
            }
        }
    }
    return null;
}

export function analyzeShellCommandEffects(command, cwd) {
    const text = String(command || '').trim();
    let localCwd = resolve(cwd || process.cwd());
    if (!text) return { mutationMode: 'none', paths: [], finalCwd: localCwd };
    // W1 M: redirect / tee detection must run before the read-only fast
    // path. `echo x > file` and pipelines containing tee write to disk
    // even though every segment starts with a read-only verb; previously
    // these slipped through with mutationMode='none' and never
    // invalidated caches or the code-graph.
    const _hasRedirect = /(?:^|[^0-9&<>])>>?(?!\&)/.test(text) || /\btee\b/.test(text);
    if (!SHELL_MUTATION_PATTERN.test(text) && !_hasRedirect) {
        const readOnly = _shellSplitSegments(text).every((segment) => {
            const tokens = _stripShellProbeWrappers(_shellTokenize(segment) || []);
            if (tokens.length === 0) return true;
            const joined = tokens.join(' ');
            if (/^cd\b/i.test(joined)) {
                const target = tokens[1] || process.env.HOME || process.env.USERPROFILE || localCwd;
                const resolved = _resolveShellPathToken(target, localCwd);
                if (resolved) localCwd = resolved;
                return true;
            }
            return SHELL_READ_ONLY_SEGMENT_RE.test(joined);
        });
        return { mutationMode: readOnly ? 'none' : 'global', paths: [], finalCwd: localCwd };
    }
    const paths = new Set();
    let global = false;
    for (const segment of _shellSplitSegments(text)) {
        const parsed = _shellTokenize(segment);
        if (!parsed) return { mutationMode: 'global', paths: [], finalCwd: localCwd };
        // W1 M: strip env / sudo / nohup / exec / command wrappers so
        // `env FOO=1 npm install` is still detected as a mutator (it was
        // classified read-only because the first token was `env`).
        const tokens = _stripShellProbeWrappers(parsed);
        if (tokens.length === 0) continue;
        const cmd = tokens[0].toLowerCase();
        const joined = tokens.join(' ');
        if (cmd === 'cd') {
            const target = tokens[1] || process.env.HOME || process.env.USERPROFILE || localCwd;
            const resolved = _resolveShellPathToken(target, localCwd);
            if (resolved) localCwd = resolved;
            else global = true;
            continue;
        }
        // W1 M: a pipeline starting with a read-only verb can still mutate
        // via `| tee file` or `> file`. Don't short-circuit on read-only
        // when the segment contains a tee or write redirect.
        const _segmentMutates = tokens.includes('tee') || tokens.includes('>') || tokens.includes('>>');
        if (!_segmentMutates && SHELL_READ_ONLY_SEGMENT_RE.test(joined)) continue;
        if (_segmentMutates) {
            // Extract tee path args + redirect targets even though `cmd` is
            // a read-only verb; otherwise mutationMode falls through to
            // 'global' (over-broad cache invalidation).
            const _segPaths = [];
            const _teeIdx = tokens.indexOf('tee');
            if (_teeIdx !== -1) {
                _segPaths.push(..._extractShellPathArgs(tokens, localCwd, { minIndex: _teeIdx + 1 }));
            }
            for (let _i = 0; _i < tokens.length; _i++) {
                if (tokens[_i] === '>' || tokens[_i] === '>>') {
                    const r = _resolveShellPathToken(tokens[_i + 1], localCwd);
                    if (r) _segPaths.push(r);
                }
            }
            if (_segPaths.length === 0) { global = true; continue; }
            for (const p of _segPaths) paths.add(p);
            continue;
        }
        if (SHELL_GLOBAL_MUTATORS.has(cmd)) {
            if (cmd === 'git') {
                const sub = String(tokens[1] || '').toLowerCase();
                if (['status', 'diff', 'show', 'log', 'rev-parse', 'branch', 'remote', 'ls-files'].includes(sub)) continue;
            }
            if (cmd === 'python' || cmd === 'python3') {
                if (!(tokens[1] === '-m' && tokens[2] === 'pip' && /^install$/i.test(tokens[3] || ''))) continue;
            }
            global = true;
            continue;
        }
        let segmentPaths = [];
        if (['touch', 'mkdir', 'mktemp', 'rm', 'rmdir', 'chmod', 'chown', 'truncate'].includes(cmd)) {
            segmentPaths = _extractShellPathArgs(tokens, localCwd, { minIndex: 1 });
        } else if (['mv', 'cp', 'install', 'ln'].includes(cmd)) {
            segmentPaths = _extractShellPathArgs(tokens, localCwd, { minIndex: 1 });
        } else if (cmd === 'sed' && tokens.includes('-i')) {
            segmentPaths = _extractShellPathArgs(tokens, localCwd, { minIndex: tokens.lastIndexOf('-i') + 1 });
        } else if (cmd === 'perl' && tokens.some((t) => /^-p/i.test(t) || /^-i/i.test(t))) {
            segmentPaths = _extractShellPathArgs(tokens, localCwd, { minIndex: 1 });
        } else if (cmd === 'tee') {
            segmentPaths = _extractShellPathArgs(tokens, localCwd, { minIndex: 1 });
        }
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i] === '>' || tokens[i] === '>>') {
                const redirected = _resolveShellPathToken(tokens[i + 1], localCwd);
                if (redirected) segmentPaths.push(redirected);
            }
        }
        if (segmentPaths.length === 0) {
            global = true;
            continue;
        }
        for (const p of segmentPaths) paths.add(p);
    }
    if (global) return { mutationMode: 'global', paths: [], finalCwd: localCwd };
    if (paths.size > 0) return { mutationMode: 'paths', paths: [...paths], finalCwd: localCwd };
    return { mutationMode: 'none', paths: [], finalCwd: localCwd };
}

// Ripgrep wrapper. Ripgrep occasionally fails with EAGAIN on Windows when
// thread/resource pressure spikes (observed 2026-04-19 with three
// concurrent reviewer rg calls). On EAGAIN we retry once with `-j 1` to
// force single-threaded execution; the second attempt almost always
// succeeds. rg exit code 1 is "no matches" — surfaced as empty stdout
// rather than an error so callers can render "(no matches)" uniformly.
// Spawn rg directly — bypass the shell so arbitrary bytes in `pattern`
// (quotes, backticks, shell keywords like `read`) reach ripgrep verbatim.
// shell-mode execAsync was the root cause of "'read' is not a command"
// style failures on Windows cmd when a regex contained reserved words.
function _spawnRg(argsList, execOptions) {
    const timeoutMs = Number(execOptions?.timeout ?? 20000);
    return new Promise((resolve, reject) => {
        const proc = spawn('rg', argsList, {
            cwd: execOptions?.cwd,
            env: execOptions?.env || process.env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        }, timeoutMs);
        proc.stdout.setEncoding('utf-8');
        proc.stderr.setEncoding('utf-8');
        proc.stdout.on('data', (d) => { stdout += d; });
        proc.stderr.on('data', (d) => { stderr += d; });
        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (timedOut) {
                const e = new Error(`rg timed out after ${timeoutMs} ms`);
                e.code = 'ETIMEDOUT';
                return reject(e);
            }
            if (code === 0) return resolve(stdout);
            if (code === 1) return resolve(''); // rg: no matches
            const e = new Error(`rg exited with code ${code}: ${stderr.trim()}`);
            e.code = code;
            e.stderr = stderr;
            reject(e);
        });
    });
}

async function runRg(argsList, execOptions = {}) {
    try {
        return await _spawnRg(argsList, execOptions);
    } catch (err) {
        const msg = String(err?.message || err?.stderr || '');
        if (/EAGAIN/i.test(msg) && !argsList.includes('-j')) {
            return _spawnRg(['-j', '1', ...argsList], execOptions);
        }
        throw err;
    }
}

export function buildGrepCacheKey(parts) {
    const {
        patterns,
        searchPath,
        globPatterns,
        outputMode,
        headLimit,
        offset,
        caseInsensitive,
        showLineNumbers,
        beforeN,
        afterN,
        contextN,
        multilineMode,
        fileType,
    } = parts;
    return [
        'grep',
        patterns.join('\x01'),
        searchPath,
        globPatterns.join('\x01'),
        outputMode,
        String(headLimit),
        String(offset),
        caseInsensitive ? 'i1' : 'i0',
        showLineNumbers ? 'n1' : 'n0',
        beforeN ?? '',
        afterN ?? '',
        contextN ?? '',
        multilineMode ? 'm1' : 'm0',
        fileType || '',
    ].join('|');
}

export function buildGrepRgArgs(parts) {
    const {
        patterns,
        searchPath,
        globPatterns,
        outputMode,
        caseInsensitive,
        showLineNumbers,
        beforeN,
        afterN,
        contextN,
        multilineMode,
        fileType,
    } = parts;
    const rgArgs = ['--color', 'never'];
    if (outputMode === 'files_with_matches') {
        rgArgs.push('--files-with-matches');
    } else if (outputMode === 'count') {
        rgArgs.push('--count');
    } else {
        rgArgs.push('--no-heading');
        if (showLineNumbers) rgArgs.push('--line-number');
        if (beforeN !== null) rgArgs.push('-B', String(beforeN));
        if (afterN !== null) rgArgs.push('-A', String(afterN));
        if (contextN !== null) rgArgs.push('-C', String(contextN));
        rgArgs.push('--max-columns=500', '--max-columns-preview');
    }
    if (caseInsensitive) rgArgs.push('-i');
    if (multilineMode) rgArgs.push('-U', '--multiline-dotall');
    if (fileType) rgArgs.push('--type', fileType);
    for (const ex of DEFAULT_IGNORE_GLOBS) rgArgs.push('--glob', ex);
    for (const g of globPatterns) rgArgs.push('--glob', g);
    for (const p of patterns) rgArgs.push('-e', p);
    rgArgs.push(searchPath);
    return rgArgs;
}

export function buildGlobCacheKey({ patterns, basePath, headLimit, offset }) {
    return ['glob', patterns.join('\x01'), basePath, headLimit ?? '', offset ?? ''].join('|');
}

export function buildListCacheKey(parts) {
    const {
        mode,
        inputPath,
        depth,
        hidden,
        sort,
        typeFilter,
        headLimit,
        offset,
        namePattern,
        minSize,
        maxSize,
        modifiedAfter,
        modifiedBefore,
    } = parts;
    return [
        'list',
        mode,
        inputPath,
        depth,
        hidden ? 'h1' : 'h0',
        sort || '',
        typeFilter || '',
        headLimit,
        offset ?? '',
        namePattern || '',
        minSize ?? '',
        maxSize ?? '',
        modifiedAfter || '',
        modifiedBefore || '',
    ].join('|');
}
// --- Unified diff computation (LCS-based) ---
//
// Self-contained unified diff so the plugin does not need to take on an
// external `diff` npm dep. LCS dynamic-programming table is O(n*m) memory
// and time — fine for the file sizes the builtin tools already gate
// through (read cap keeps inputs well under 10k lines in practice). For
// truly large inputs we fall back to a "files differ" summary rather
// than spending multi-GB on the DP table.
function computeUnifiedDiff(a, b, ctx, fromLabel, toLabel) {
    const n = a.length, m = b.length;
    // Guard: n * m > 4M cells (~16 MB Int32Array rows total) — bail out.
    if (n > 10000 || m > 10000 || n * m > 4_000_000) {
        if (n === m) {
            let same = true;
            for (let k = 0; k < n; k++) { if (a[k] !== b[k]) { same = false; break; } }
            if (same) return '';
        }
        return `--- ${fromLabel}\n+++ ${toLabel}\n(files too large for inline diff — ${n} vs ${m} lines)`;
    }

    // dp[i][j] = LCS length of a[i..] and b[j..].
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        const aI = a[i];
        const rowI = dp[i];
        const rowI1 = dp[i + 1];
        for (let j = m - 1; j >= 0; j--) {
            if (aI === b[j]) rowI[j] = rowI1[j + 1] + 1;
            else rowI[j] = rowI1[j] >= rowI[j + 1] ? rowI1[j] : rowI[j + 1];
        }
    }

    // Backtrack into an ops list. Each op: ['=', line] | ['-', line] | ['+', line].
    // aLine / bLine track 1-based line numbers for hunk headers.
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { ops.push(['=', a[i]]); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i]]); i++; }
        else { ops.push(['+', b[j]]); j++; }
    }
    while (i < n) { ops.push(['-', a[i++]]); }
    while (j < m) { ops.push(['+', b[j++]]); }

    if (!ops.some(o => o[0] !== '=')) return '';

    // Split ops into hunks. A run of '=' longer than 2*ctx breaks a hunk;
    // we keep ctx leading + ctx trailing context lines around each change
    // cluster. Tracks original/target line numbers as we walk.
    const hunks = [];
    let aLine = 1, bLine = 1;
    let current = null;
    let eqRun = 0;

    const openHunk = (aStart, bStart) => ({ aStart, bStart, aCount: 0, bCount: 0, lines: [] });

    for (let k = 0; k < ops.length; k++) {
        const [op, line] = ops[k];
        if (op === '=') {
            if (current) {
                // Decide whether to absorb this context line or close the hunk.
                // Look ahead: is there another change within ctx lines?
                let nextChangeWithin = false;
                for (let la = 1; la <= ctx && k + la < ops.length; la++) {
                    if (ops[k + la][0] !== '=') { nextChangeWithin = true; break; }
                }
                if (nextChangeWithin || eqRun < ctx) {
                    current.lines.push([' ', line]);
                    current.aCount++;
                    current.bCount++;
                    eqRun++;
                } else {
                    // Close hunk; trailing ctx already appended during the
                    // first `ctx` equal lines after the last change.
                    hunks.push(current);
                    current = null;
                    eqRun = 0;
                }
            }
            aLine++;
            bLine++;
        } else {
            if (!current) {
                // Open a new hunk with up to `ctx` leading context from prior '=' ops.
                const leading = [];
                let leadA = 0, leadB = 0;
                for (let back = k - 1; back >= 0 && leading.length < ctx; back--) {
                    if (ops[back][0] !== '=') break;
                    leading.unshift([' ', ops[back][1]]);
                    leadA++; leadB++;
                }
                const aStart = aLine - leadA;
                const bStart = bLine - leadB;
                current = openHunk(aStart, bStart);
                current.lines.push(...leading);
                current.aCount += leadA;
                current.bCount += leadB;
            }
            if (op === '-') {
                current.lines.push(['-', line]);
                current.aCount++;
                aLine++;
            } else { // '+'
                current.lines.push(['+', line]);
                current.bCount++;
                bLine++;
            }
            eqRun = 0;
        }
    }
    if (current) hunks.push(current);

    const out = [`--- ${fromLabel}`, `+++ ${toLabel}`];
    for (const h of hunks) {
        const aHdr = h.aCount === 0 ? `${h.aStart - 1},0` : (h.aCount === 1 ? `${h.aStart}` : `${h.aStart},${h.aCount}`);
        const bHdr = h.bCount === 0 ? `${h.bStart - 1},0` : (h.bCount === 1 ? `${h.bStart}` : `${h.bStart},${h.bCount}`);
        out.push(`@@ -${aHdr} +${bHdr} @@`);
        for (const [sign, line] of h.lines) out.push(`${sign}${line}`);
    }
    return out.join('\n');
}

// Lightweight nearest-match hint for `Error [code 8]: old_string not
// found`. Probes by the first non-empty line of `old_string` (trimmed,
// capped at 60 chars then 30) so callers see where they likely meant
// to land. Substring only — no fuzzy diff — to keep the failure path
// cheap.
function _findEditHint(content, oldStr, snapshot = null) {
    const firstNonEmpty = String(oldStr || '').split(/\r?\n/).find((l) => l.trim().length > 0) || '';
    const trimmed = firstNonEmpty.trim();
    if (trimmed.length < 8) return '';
    const probes = [trimmed.slice(0, 60), trimmed.slice(0, 30)].filter((p) => p.length >= 8);
    const lines = String(content).split('\n');
    // When the caller's snapshot only covered a partial window
    // (head/tail or offset+limit read), restrict the hint search to
    // that window. Otherwise a "Nearest match at line N" pointer can
    // dangle outside the region the model has actually read, inviting
    // a follow-up edit against unread content. Same window fields as
    // _validatePartialSnapshotCoverage (offset+limit, 1-based inclusive).
    let winStart = 1;
    let winEnd = lines.length;
    if (snapshot && !_snapshotCoversFullFile(snapshot)) {
        const ranges = Array.isArray(snapshot.ranges) ? snapshot.ranges : [];
        if (ranges.length === 0) return '';
        // Restrict the hint search to the smallest envelope spanning all
        // covered ranges. The validator below still enforces per-range
        // membership at edit time; this is just to avoid pointing the
        // model at a line outside any read window.
        winStart = ranges[0].startLine;
        const last = ranges[ranges.length - 1];
        winEnd = last.endLine === Infinity ? lines.length : Math.min(lines.length, last.endLine);
    }
    for (const probe of probes) {
        for (let i = winStart - 1; i < winEnd; i++) {
            if (lines[i] !== undefined && lines[i].includes(probe)) {
                const preview = lines[i].length > 80 ? lines[i].slice(0, 77) + '...' : lines[i];
                return ` Nearest match at line ${i + 1}: ${JSON.stringify(preview)}`;
            }
        }
    }
    return '';
}

async function _runMultiEdit(args, workDir, readStateScope, pathOpts, options = {}) {
    args.path = normalizeInputPath(args.path);
    const filePath = args.path;
    const edits = Array.isArray(args.edits) ? args.edits : [];
    if (!filePath) return 'Error: path is required';
    if (edits.length === 0) return 'Error: edits array is required';
    if (!isSafePath(filePath, workDir, pathOpts)) return `Error: path outside allowed scope — ${normalizeOutputPath(filePath)}`;
    const fullPath = resolveAgainstCwd(filePath, workDir);
    let mEditStat;
    try { mEditStat = statSync(fullPath); }
    catch (err) {
        if (err && err.code === 'ENOENT') {
            const similar = findSimilarFile(fullPath);
            const hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
            return `Error [code 4]: file not found: ${filePath}${hint}`;
        }
        return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
    }
    const mEditSnapshot = _getReadSnapshot(fullPath, readStateScope);
    if (!mEditSnapshot) {
        return _primeReadSnapshotForEdit({
            fullPath,
            filePath,
            st: mEditStat,
            scope: readStateScope,
            oldStrings: edits.map((entry, i) => ({
                label: `edit ${i}`,
                old_string: entry?.old_string,
            })),
        }) || `Error [code 6]: file has not been read yet — read before editing: ${filePath}`;
    }
    let mEditPreloadedContent = null;
    if (_isSnapshotStale(mEditStat, mEditSnapshot, fullPath)) {
        mEditPreloadedContent = _readContentIfSnapshotHashMatches(fullPath, mEditSnapshot);
        if (mEditPreloadedContent === null) {
            return `Error [code 7]: file modified since read (lint / formatter / external write) — read it again before editing: ${filePath}`;
        }
    }
    try {
        let content = mEditPreloadedContent;
        try { if (content === null) content = readFileSync(fullPath, 'utf-8'); }
        catch (err) { return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`; }
        for (let i = 0; i < edits.length; i++) {
            const entry = edits[i];
            if (!entry || typeof entry.old_string !== 'string' || typeof entry.new_string !== 'string') {
                return `Error: edit ${i} must have old_string and new_string`;
            }
            const { old_string, new_string, replace_all } = entry;
            // Validate against the snapshot's window before each step so a
            // partial read can't be used as cover for editing unread regions.
            // Validation is on the pre-edit content for step i — `content`
            // here already incorporates earlier edits, but the line window
            // anchors to the current text, which is the buffer the model
            // is targeting in this hop.
            let partialCoverageErr = _validatePartialSnapshotCoverage(content, old_string, mEditSnapshot, filePath);
            if (partialCoverageErr) {
                // Lenient path: if the snapshot's mtime/size still matches
                // the on-disk file and `old_string` is unique in the buffer,
                // widen the snapshot's ranges to cover the match site and
                // proceed. Multi-match keeps the strict reject.
                if (_maybeExtendSnapshotForUniqueMatch(content, old_string, mEditSnapshot)) {
                    partialCoverageErr = _validatePartialSnapshotCoverage(content, old_string, mEditSnapshot, filePath);
                }
                if (partialCoverageErr) return partialCoverageErr.replace('Error [code 6]:', `Error [code 6]: edit ${i} —`);
            }
            if (replace_all === true) {
                if (!content.includes(old_string)) {
                    return `Error [code 8]: edit ${i} — old_string not found in ${filePath}.${_findEditHint(content, old_string, mEditSnapshot)}`;
                }
                content = content.split(old_string).join(new_string);
            } else {
                const count = content.split(old_string).length - 1;
                if (count === 0) return `Error [code 8]: edit ${i} — old_string not found in ${filePath}.${_findEditHint(content, old_string, mEditSnapshot)}`;
                if (count > 1) return `Error [code 9]: edit ${i} — old_string found ${count} times in ${filePath}; set replace_all:true or provide more unique context`;
                content = content.replace(old_string, () => new_string);
            }
        }
        await atomicWrite(fullPath, content, { sessionId: options?.sessionId });
        invalidateBuiltinResultCache([fullPath]);
        markCodeGraphDirtyPaths(workDir, [fullPath]);
        _recordReadSnapshot(fullPath, undefined, readStateScope, {
            source: 'edit',
            contentHash: _hashText(content),
        });
        return `Edited: ${normalizeOutputPath(filePath)} (${edits.length} replacements applied)`;
    } catch (err) {
        return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
    }
}

async function _runBatchEdit(args, workDir, readStateScope, pathOpts, executeChildBuiltinTool, options = {}) {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    if (edits.length === 0) return 'Error: edits array is required';
    for (const e of edits) { if (e && typeof e === 'object') e.path = normalizeInputPath(e.path); }
    const groups = new Map();
    const missingPath = [];
    for (const e of edits) {
        if (!e || !e.path) { missingPath.push(e); continue; }
        if (!groups.has(e.path)) groups.set(e.path, []);
        groups.get(e.path).push(e);
    }
    const parseLeadError = (body) => {
        const first = String(body).split('\n')[0] || '';
        if (!/^Error(\s|\[)/.test(first)) return null;
        const colonIdx = first.indexOf(': ');
        const msg = colonIdx !== -1 ? first.slice(colonIdx + 2) : first;
        const retryHint = String(body).includes('snapshot recorded now') && !msg.includes('Retry the edit directly')
            ? ' (snapshot recorded; retry the same edit directly, no read needed)'
            : '';
        return `${msg}${retryHint}`;
    };
    const groupResults = await Promise.all([...groups.entries()].map(async ([path, items]) => {
        if (items.length === 1) {
            const body = await executeChildBuiltinTool('edit', items[0], workDir);
            const errMsg = parseLeadError(body);
            return errMsg
                ? `FAIL ${normalizeOutputPath(path)}: ${errMsg}`
                : `OK ${normalizeOutputPath(path)}`;
        }
        const body = await _runMultiEdit({
            path,
            edits: items.map(({ path: _p, ...rest }) => rest),
        }, workDir, readStateScope, pathOpts, options);
        const errMsg = parseLeadError(body);
        return errMsg
            ? `FAIL ${normalizeOutputPath(path)}: ${errMsg}`
            : `OK ${normalizeOutputPath(path)} (${items.length})`;
    }));
    const missingLines = missingPath.map(() => 'FAIL (missing-path): path is required');
    return [...groupResults, ...missingLines].join('\n');
}

// --- Tool execution ---
export async function executeBuiltinTool(name, args, cwd, options = {}) {
    const workDir = cwd || _resolveDefaultUserCwd() || process.cwd();
    const readStateScope = options?.readStateScope ?? options?.sessionId ?? null;
    const executeChildBuiltinTool = (childName, childArgs, childCwd = workDir) =>
        executeBuiltinTool(childName, childArgs, childCwd, options);
    // B2 path policy: capability-gated HOME access. When
    // `capabilities.homeAccess` is false (default), all path-validation
    // helpers below reject any path outside `workDir`; when true, the
    // old HOME fallback is re-enabled. Read once per tool invocation so
    // config changes apply immediately on the next call without a
    // process restart.
    let allowHome = false;
    try { allowHome = getCapabilities().homeAccess === true; } catch { allowHome = false; }
    const pathOpts = { allowHome };
    const readPathOpts = { allowHome, allowPluginData: true };
    switch (name) {
        case 'bash': {
            // P2 fix: route persistent / session_id BEFORE the command-required
            // guard so {session_id, close:true} (close-only calls without a new
            // command) can reach the session module. The session owns its own
            // command/close validation — builtin.mjs should not pre-empt it.
            if (args.persistent === true || typeof args.session_id === 'string') {
                const { executeBashSessionTool } = await import('./bash-session.mjs');
                // Plumb session-scoped AbortSignal so ESC / new-prompt cancels
                // a long-running persistent command (matches the one-shot
                // path's getAbortSignalForSession hookup in execShellCommand).
                // W1 M: getAbortSignalForSession is async; the previous code
                // passed the Promise itself as abortSignal. Await the lookup
                // and key on options.sessionId (the function's contract).
                let _persistAbort = null;
                try { _persistAbort = (await getAbortSignalForSession(options?.sessionId)) || null; }
                catch { _persistAbort = null; }
                return executeBashSessionTool('bash_session', args, workDir, { abortSignal: _persistAbort });
            }
            const command = args.command;
            if (!command)
                return 'Error: command is required';
            // Quote/heredoc-aware block matching: strip quoted spans + heredoc
            // bodies before testing patterns so a destructive token inside a
            // string literal (`echo "rm -rf /"`) doesn't false-positive,
            // while `bash -c 'rm -rf /'` payloads are extracted and re-tested.
            const _blockTargets = [stripQuotedAndHeredoc(command), ...extractShellCInner(command).map(stripQuotedAndHeredoc)];
            for (const pattern of BLOCKED_PATTERNS) {
                if (_blockTargets.some((t) => pattern.test(t))) {
                    return `Error: blocked command pattern — "${command}" matches safety rule`;
                }
            }
            // G4: surface destructive-command warning inline (informational
            // only; BLOCKED_PATTERNS above handles hard blocks).
            const _destructiveWarning = getDestructiveCommandWarning(command);
            const largeProbe = preflightShellLargeFileProbe(command, workDir);
            if (largeProbe) {
                return `Error: ${largeProbe.message}`;
            }
            const shellEffects = analyzeShellCommandEffects(command, workDir);
            // Timeout: CC parity default 120 s, mixdog max 1800 s (CC max
            // is 600 s but build/test workloads regularly exceed it). User
            // explicit timeout up to 1800 s honored; missing/0/non-numeric
            // → default. Hard cap on output remains SHELL_OUTPUT_DISK_CAP.
            const _DEFAULT_BASH_TIMEOUT_MS = 120_000;
            const _MAX_BASH_TIMEOUT_MS = 600_000; // CC parity (src/utils/timeouts.ts:3)
            const _rawTimeout = (typeof args.timeout === 'number' && args.timeout > 0)
                ? args.timeout : _DEFAULT_BASH_TIMEOUT_MS;
            const timeout = Math.min(_rawTimeout, _MAX_BASH_TIMEOUT_MS);
            const mergeStderr = args.merge_stderr === true;
            try {
                const { shell, shellArg } = resolveShell();
                // Locale normalisation: many CLI tools vary date / number /
                // message formatting by LANG/LC_ALL, which makes output
                // non-deterministic across machines and burns agent tokens
                // on spurious "diff" chatter. Forcing C.UTF-8 (universally
                // available on glibc and musl; Windows shells ignore but
                // the key is still set for any embedded POSIX tool).
                // process.env is merged underneath so user exports still
                // win if they precede our override; we only set the locale
                // pair, nothing else is mutated.
                const spawnEnv = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
                // On Windows, when the resolved shell is bash/sh, the child
                // inherits Node's cmd-shaped PATH and thus cannot find POSIX
                // coreutils (grep / sed / head / awk / ...). Prepend Git Bash
                // and MSYS tool dirs so shell scripts and one-liners that
                // rely on coreutils behave the same as on POSIX.
                if (process.platform === 'win32'
                    && (shell.toLowerCase().includes('bash') || shell.toLowerCase().endsWith('sh.exe'))) {
                    const toolDirs = [
                        'C:\\Program Files\\Git\\usr\\bin',
                        'C:\\Program Files\\Git\\mingw64\\bin',
                        'C:\\Program Files (x86)\\Git\\usr\\bin',
                        'C:\\msys64\\usr\\bin',
                        'C:\\msys64\\mingw64\\bin',
                    ];
                    const existing = spawnEnv.PATH || spawnEnv.Path || '';
                    const prefix = toolDirs.filter((p) => existsSync(p)).join(';');
                    if (prefix) spawnEnv.PATH = prefix + (existing ? ';' + existing : '');
                }
                // P2 fix: compute the snapshot-wrapped form ONCE so both the
                // run_in_background path and the foreground execShellCommand
                // path use it. Previously the background branch ran the raw
                // command without alias / function support.
                // W1 M: surface wrapper failure instead of silently running
                // the raw command (alias / function support gone, snapshot
                // not initialised). Errors propagate as a tool-level Error
                // string so the agent retries with awareness.
                let _wrappedCommand;
                if (process.platform === 'win32'
                    ? shell.toLowerCase().endsWith('bash.exe')
                    : (shell.includes('bash') || shell.includes('zsh'))) {
                    try {
                        _wrappedCommand = await wrapCommandWithSnapshot(shell, command);
                    } catch (wrapErr) {
                        return `Error: shell snapshot wrapper failed — ${normalizeErrorMessage(wrapErr instanceof Error ? wrapErr.message : String(wrapErr))}`;
                    }
                } else {
                    _wrappedCommand = command;
                }
                // W1 M: foreground bash also needs the POSIX-shell guard
                // (background path enforces at startBackgroundShellJob).
                // Without this, a Windows host without Git Bash fell back
                // to cmd.exe and silently mis-parsed POSIX wrappers.
                if (process.platform === 'win32') {
                    const _shLower = String(shell || '').toLowerCase();
                    const _isPosixShell = _shLower.includes('bash')
                        || _shLower.endsWith('/sh') || _shLower.endsWith('\\sh.exe')
                        || _shLower.includes('zsh');
                    if (!_isPosixShell) {
                        return `Error: bash one-shot requires a POSIX-compatible shell on Windows (resolved=${shell}); install Git Bash or use WSL`;
                    }
                }
                if (args.run_in_background === true) {
                    const job = startBackgroundShellJob({
                        command: _wrappedCommand,
                        timeoutMs: timeout,
                        workDir,
                        mergeStderr,
                        spawnEnv,
                        shell,
                        shellArg,
                    });
                    if (job && job.error) return `Error: ${job.error}`;
                    return [
                        `[job: ${job.jobId}]`,
                        `[pid: ${job.pid}]`,
                        `[stdout: ${normalizeOutputPath(job.stdoutPath)}]`,
                        mergeStderr ? null : `[stderr: ${normalizeOutputPath(job.stderrPath)}]`,
                        '',
                        `Background job started for command: ${command}`,
                        `Use job_wait to block until it finishes; read the stdout/stderr paths above for logs.`,
                    ].filter(Boolean).join('\n');
                }
                // v0.1.252 (G1): spawnSync → execShellCommand (async).
                // Improvements:
                //   - tree-kill on timeout so forked grandchildren come down
                //     with the parent (sleep & + node servers etc).
                //   - external AbortSignal hookup so session-scoped cancel
                //     (ESC, new prompt) interrupts the run cleanly.
                //   - automatic disk spill past SHELL_OUTPUT_MAX_CHARS*4
                //     bytes; the resulting stdoutPath is rendered as an
                //     outputFilePath marker so the model can read the full
                //     output via the read tool without losing the tail past
                //     the inline cap.
                // W1 M: await the async lookup; passing the unresolved
                // Promise as abortSignal silently disabled cancellation.
                let _bashAbortSignal = null;
                try { _bashAbortSignal = (await getAbortSignalForSession(options?.sessionId)) || null; }
                catch { _bashAbortSignal = null; }
                // _wrappedCommand was computed above (after resolveShell) so
                // run_in_background and the foreground path share one wrap.
                const result = await execShellCommand({
                    shell, shellArg, command: _wrappedCommand,
                    env: spawnEnv,
                    cwd: workDir,
                    timeoutMs: timeout,
                    abortSignal: _bashAbortSignal,
                });
                // Strip ANSI / VT control sequences before the model sees
                // them — progress bars, coloured diagnostics, cursor moves.
                const stdout = stripAnsi(result.stdout || '');
                const stderr = stripAnsi(result.stderr || '');
                // Exit code / signal surfacing. Non-zero status or a signal
                // kill (timeout -> SIGTERM) prepends a marker line so the
                // agent never has to guess at a silent failure. Zero exit
                // + no signal stays quiet to avoid noise on the success path.
                const signal = result.timedOut
                    ? 'SIGTERM'
                    : (result.killed ? 'SIGKILL' : (result.signal || null));
                const exitCode = signal ? null : result.exitCode;
                // G4: command-aware exit interpretation. grep / find /
                // diff / test return non-zero for benign signals (no
                // matches, files differ, false condition); render those
                // as informational notes instead of [exit code: N] so the
                // agent doesn't re-run the command thinking it failed.
                const _semantic = interpretCommandResult(
                    command,
                    exitCode != null ? exitCode : -1,
                );
                const _isReallyErrored = !!signal
                    || (exitCode !== 0 && exitCode !== null && _semantic.isError);
                const statusMarker = signal
                    ? `[signal: ${signal}]`
                    : (_isReallyErrored
                        ? `[exit code: ${exitCode}]`
                        : (_semantic.note ? `[${_semantic.note}]` : ''));
                if (mergeStderr) {
                    // Legacy back-compat path for callers that parsed the old
                    // merged form. Concatenate stdout + stderr; no separator
                    // block, just a marker prefix on failure.
                    const merged = stdout + stderr;
                    if (statusMarker) return smartMiddleTruncate(`${statusMarker}\n\n${merged || '(no output)'}`);
                    return smartMiddleTruncate(merged || '(no output)');
                }
                // Default: stdout primary, stderr appended as a labelled block
                // only when non-empty so clean runs stay noise-free. Smart
                // middle-truncation is applied per stream so a massive stdout
                // cannot blot out a short stderr diagnostic (and vice versa).
                const truncatedStdout = smartMiddleTruncate(stdout);
                const truncatedStderr = stderr ? smartMiddleTruncate(stderr) : '';
                const body = truncatedStdout || (truncatedStderr ? '' : '(no output)');
                const stderrBlock = truncatedStderr ? `\n\n[stderr]\n${truncatedStderr}` : '';
                // Disk-spill marker: when execShellCommand wrote past the
                // inline cap to $PLUGIN_DATA/shell-output, the body above
                // only shows head/tail. Surface the path so the model can
                // read the missing middle.
                let spillBlock = '';
                if (result.stdoutPath) {
                    const sizeKb = Math.round((result.stdoutFileSize || 0) / 1024);
                    spillBlock += `\n\n[stdout: ${normalizeOutputPath(result.stdoutPath)} (${sizeKb} KB) — read({path, offset, limit}) for the full output]`;
                }
                if (result.stderrPath && (result.stderrFileSize || 0) > 0) {
                    const sizeKb = Math.round((result.stderrFileSize || 0) / 1024);
                    spillBlock += `\n[stderr: ${normalizeOutputPath(result.stderrPath)} (${sizeKb} KB)]`;
                }
                const warningBlock = _destructiveWarning ? `[note: ${_destructiveWarning}]\n` : '';
                const payload = `${body}${stderrBlock}${spillBlock}`;
                if (statusMarker) return `${warningBlock}${statusMarker}\n\n${payload}`;
                return warningBlock ? `${warningBlock}\n${payload}` : payload;
            }
            finally {
                if (shellEffects.mutationMode === 'paths') {
                    invalidateBuiltinResultCache(shellEffects.paths);
                    markCodeGraphDirtyPaths(workDir, shellEffects.paths);
                } else if (shellEffects.mutationMode === 'global') invalidateBuiltinResultCache();
            }
        }
        case 'job_wait': {
            const jobId = typeof args.job_id === 'string' ? args.job_id : '';
            if (!jobId) return 'Error: job_id is required';
            const job = await waitForShellJob(jobId, {
                timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : 30_000,
                pollMs: typeof args.poll_ms === 'number' ? args.poll_ms : 250,
            });
            if (!job) return `Error: job not found: ${jobId}`;
            return JSON.stringify(job, null, 2);
        }
        case 'read': {
            // CC `file_path` alias — official SDK schema uses `file_path`;
            // mixdog has historically used `path`. Honor `file_path` so a
            // CC-trained agent's call shape works without translation.
            if (typeof args.file_path === 'string' && !args.path) args.path = args.file_path;
            // Unified-read dispatch (v0.6.283+):
            //   reads: [{path, mode?, n?, offset?, limit?, full?}]
            //                               → per-file batch (different
            //                                 ranges per file in one call)
            //   path: string[]              → parallel per-file batch
            //                                 (top-level opts apply uniformly)
            //   mode: 'head'|'tail'|'count' → head / tail / wc handlers
            //   else                        → single-file read below.
            // Single turn can touch many files or swap modes without
            // the agent iterating across multiple tool names.
            if (Array.isArray(args.reads)) {
                // Per-file batch: each entry carries its own options.
                const entries = args.reads.map((r) => {
                    const entry = { path: normalizeInputPath(r?.path ?? '') };
                    if (r?.mode !== undefined) entry.mode = r.mode;
                    if (r?.n !== undefined) entry.n = r.n;
                    if (r?.offset !== undefined) entry.offset = r.offset;
                    if (r?.limit !== undefined) entry.limit = r.limit;
                    if (r?.full !== undefined) entry.full = r.full;
                    return entry;
                });
                if (entries.length === 0) return 'Error: reads array must not be empty';
                // Reuse the same parallel-dispatch path as args.path[] below.
                args = { ...args, path: entries.map(e => e.path) };
                // Strip top-level uniform opts; the per-entry loop below would
                // re-apply them. Mark entries override via args._readsEntries.
                args._readsEntries = entries;
                args.mode = undefined; args.n = undefined; args.offset = undefined; args.limit = undefined; args.full = undefined;
            }
            if (Array.isArray(args.path)) {
                // Schema is `path: string | string[]` — array entries are
                // strings only. Top-level mode / n / offset / limit / full
                // apply uniformly to every entry in the batch (the only
                // caller is the manager prefetch helper, which already
                // shapes its calls that way). When _readsEntries is set,
                // per-entry options override the uniform set.
                const overrides = Array.isArray(args._readsEntries) ? args._readsEntries : null;
                const entries = args.path.map((p, i) => {
                    if (overrides && overrides[i]) return overrides[i];
                    const entry = { path: normalizeInputPath(p) };
                    if (args.mode !== undefined) entry.mode = args.mode;
                    if (args.n !== undefined) entry.n = args.n;
                    if (args.offset !== undefined) entry.offset = args.offset;
                    if (args.limit !== undefined) entry.limit = args.limit;
                    if (args.full !== undefined) entry.full = args.full;
                    return entry;
                });
                if (entries.length === 0) return 'Error: path array must not be empty';
                // Parallel dispatch of the individual reads via the same case
                // above — reuses size cap, isSafePath, line-number formatting.
                // Per-file errors come back as their own string and are pasted
                // into the aggregate rather than aborting the whole batch.
                const results = await Promise.all(entries.map(async (entry) => {
                    if (!entry || !entry.path) return { path: '(missing-path)', mode: 'full', body: 'Error: path is required' };
                    const body = await executeChildBuiltinTool('read', entry, workDir);
                    return { path: entry.path, mode: entry.mode || 'full', n: entry.n, body };
                }));
                // Header path → forward slash; error bodies already normalised
                // inside the read case's catch blocks. When `read` emitted a
                // smart-cap marker, surface the truncation state in the header
                // so downstream skimming spots it without parsing the body.
                const summaries = [];
                for (const r of results) {
                    if (r.mode === 'count') {
                        const m = String(r.body || '').match(/lines\t(\d+)/);
                        if (m) summaries.push(`${normalizeOutputPath(r.path)} has ${m[1]} lines`);
                    }
                }
                const summaryLine = summaries.length ? ` ${summaries.join('; ')}` : '';
                const header = `read ${results.length}${summaryLine}`;
                const body = results.map(r => {
                    const match = /\[TRUNCATED — file is (\d+) lines \/ (\d+) KB\./.exec(r.body || '');
                    const suffix = match ? ` (truncated ${match[1]}L/${match[2]}KB)` : '';
                    const mode = r.n !== undefined ? `${r.mode} n=${r.n}` : r.mode;
                    return `${normalizeOutputPath(r.path)} [${mode}]${suffix}\n${r.body}`;
                }).join('\n\n');
                return `${header}\n\n${body}`;
            }
            // W1 H: device-file / UNC / scope guards must run BEFORE mode
            // dispatches so head/tail/wc internal readers can't bypass the
            // /dev/* and UNC blocks that the default-mode branch enforces.
            if (typeof args.path === 'string' && args.path) {
                const _modeProbePath = normalizeInputPath(args.path);
                if (isBlockedDevicePath(_modeProbePath))
                    return `Error: cannot read device file (would block or produce infinite output): ${normalizeOutputPath(_modeProbePath)}`;
                if (isUncPath(_modeProbePath))
                    return `Error: UNC paths are not supported (NTLM credential leak risk): ${normalizeOutputPath(_modeProbePath)}`;
            }
            if (args.mode === 'head') return executeChildBuiltinTool('head', { path: args.path, n: args.n }, workDir);
            if (args.mode === 'tail') return executeChildBuiltinTool('tail', { path: args.path, n: args.n }, workDir);
            if (args.mode === 'count') return executeChildBuiltinTool('wc', { path: args.path }, workDir);
            args.path = normalizeInputPath(args.path);
            const filePath = args.path;
            if (!filePath)
                return 'Error: path is required';
            // G6: block device pseudo-files (would hang / produce infinite
            // output) and UNC paths (NTLM credential leak risk on Windows).
            if (isBlockedDevicePath(filePath))
                return `Error: cannot read device file (would block or produce infinite output): ${normalizeOutputPath(filePath)}`;
            if (isUncPath(filePath))
                return `Error: UNC paths are not supported (NTLM credential leak risk): ${normalizeOutputPath(filePath)}`;
            if (!isSafePath(filePath, workDir, readPathOpts))
                return `Error: path outside allowed scope — ${normalizeOutputPath(filePath)}`;
            const fullPath = resolveAgainstCwd(filePath, workDir);
            // Pre-read size cap (Anthropic FileReadTool/limits.ts pattern):
            // throw a small error response when the file is too big rather
            // than truncating to 25K tokens of content. Throw is decisively
            // more token-efficient (Anthropic #21841 reverted truncation).
            // Large-file branch: if offset/limit is provided, stream the
            // requested line window instead of throwing (Task B). Without
            // range args the cap still throws so small-file default path
            // can't be weaponised to pull megabytes by accident.
            const hasOffsetArg = args.offset !== undefined && args.offset !== null;
            const hasLimitArg = args.limit !== undefined && args.limit !== null;
            const hasRangeArgs = hasOffsetArg || hasLimitArg;
            const offset = parseOffsetArg(args.offset);
            const limit = parseLineLimitArg(args.limit, 2000);
            let st;
            try {
                st = statSync(fullPath);
            } catch (err) {
                const similar = findSimilarFile(fullPath);
                const hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}${hint}`;
            }
            const wantFull = args.full === true;
            const cacheKey = `read|${fullPath}|${st.mtimeMs}|${st.size}|${hasOffsetArg ? offset : 'd'}|${hasLimitArg ? limit : 'd'}|${wantFull ? 'f' : 's'}`;
            // Race-guard helper: same-mtime same-size rapid rewrite (NTFS / exFAT 1 s
            // resolution) can pass mtimeMs+size yet differ in content. When the cache
            // entry stores a contentPrefixHash, recompute the current prefix and bail
            // to a fresh read on mismatch. Helper kept local (not hoisted) so it can
            // close over fullPath and st without an extra arg.
            const _readPrefixHashForCacheGuard = () => {
                try {
                    if (st.size <= 65536) {
                        return _hashText(readFileSync(fullPath, 'utf-8'));
                    }
                    const _fd = openSync(fullPath, 'r');
                    try {
                        const _buf = Buffer.allocUnsafe(65536);
                        const _n = readSync(_fd, _buf, 0, 65536, 0);
                        return _hashText(_buf.slice(0, _n).toString('utf-8'));
                    } finally { try { closeSync(_fd); } catch {} }
                } catch { return ''; }
            };
            const cachedEntry = _cacheGetEntry(cacheKey);
            if (cachedEntry !== null) {
                let _entryStillValid = true;
                if (cachedEntry.contentPrefixHash) {
                    const _curHash = _readPrefixHashForCacheGuard();
                    if (!_curHash || _curHash !== cachedEntry.contentPrefixHash) {
                        _entryStillValid = false;
                    }
                }
                // Stronger gate: when the cached snapshot meta carries a full
                // contentHash (set by full-file reads at :3190 and writes at
                // :3235), recompute a fresh sha over the on-disk body and
                // reject the stub on mismatch. The 64KiB prefix hash misses
                // same-mtime+same-size rewrites that mutate bytes past the
                // 64KiB head — Edit on a stale stub would operate on ghost
                // content. A read failure here drops to the fresh read path.
                if (_entryStillValid) {
                    const _snapHash = cachedEntry.readSnapshotMeta?.contentHash;
                    if (_snapHash) {
                        try {
                            const _freshHash = _hashText(readFileSync(fullPath, 'utf-8'));
                            if (_freshHash !== _snapHash) _entryStillValid = false;
                        } catch { _entryStillValid = false; }
                    }
                }
                if (_entryStillValid) {
                    _recordReadSnapshot(fullPath, st, readStateScope, cachedEntry.readSnapshotMeta || { source: 'read_cached' });
                    // G6: file_unchanged stub. The full body is already in the
                    // prior tool_result; resending it wastes cache_creation
                    // tokens (Claude Code upstream measured ~18% on Read calls).
                    // The stub keeps the snapshot tracking intact (Edit
                    // validation still works) while collapsing the response
                    // payload. Falls back to the full body when the cached
                    // value is itself a stub-incompatible error string.
                    const _cachedVal = cachedEntry.value;
                    if (typeof _cachedVal === 'string' && !_cachedVal.startsWith('Error:')) {
                        return `[file unchanged: ${normalizeOutputPath(filePath)} — same content as previous read; scroll up for the body]`;
                    }
                    return _cachedVal;
                }
                // Race detected — fall through to fresh read below.
            }
            if (st.size > READ_MAX_SIZE_BYTES) {
                // Large PDF/ipynb: extract text regardless of range args
                const _extLarge = extname(fullPath).toLowerCase();
                if (_extLarge === '.pdf') return _extractPdfText(fullPath, args.pages);
                if (_extLarge === '.ipynb') return _extractIpynbText(fullPath);
                if (!hasRangeArgs) {
                    return `Error: file size ${st.size} bytes exceeds ${READ_MAX_SIZE_BYTES}-byte cap. Use offset+limit to read a range.`;
                }
                if (isBinaryFile(fullPath, st.size)) {
                    return `Error: file appears to be binary (contains null bytes): ${normalizeOutputPath(filePath)}`;
                }
                try {
                    const _streamRes = await streamReadRange(fullPath, offset, limit);
                    const out = _streamRes.text;
                    // W1 H: snapshot only emitted line bounds, not the
                    // requested window — byte-cap truncation can stop short.
                    const _emittedRanges = (_streamRes.firstEmitted && _streamRes.lastEmitted)
                        ? [{ startLine: _streamRes.firstEmitted, endLine: _streamRes.lastEmitted }]
                        : [];
                    const snapshotMeta = {
                        source: 'read',
                        ranges: _emittedRanges,
                        // D-R1-1: rangeHash covers the exact text returned so
                        // _isSnapshotStale can detect same-mtime+same-size
                        // rewrites within the read window at edit time.
                        // Fix J-1 (b): hash raw line text, not rendered
                        // "N\ttext" form, to match _isSnapshotStale which
                        // hashes _lines.slice().join('\n') (raw content).
                        // Strip the "N\t" prefix from each rendered line of
                        // `out` before hashing so the two sides are comparable.
                        rangeHash: _hashText(out.split('\n').map(l => { const ti = l.indexOf('\t'); return ti >= 0 ? l.slice(ti + 1) : l; }).join('\n')),
                    };
                    // Compute prefix hash for race-guard on next cache hit.
                    const _streamPrefixHash = (() => {
                        try {
                            if (st.size <= 65536) return _hashText(readFileSync(fullPath, 'utf-8'));
                            const _fd = openSync(fullPath, 'r');
                            try {
                                const _buf = Buffer.allocUnsafe(65536);
                                const _n = readSync(_fd, _buf, 0, 65536, 0);
                                return _hashText(_buf.slice(0, _n).toString('utf-8'));
                            } finally { try { closeSync(_fd); } catch {} }
                        } catch { return ''; }
                    })();
                    _cacheSet(cacheKey, out, { paths: [fullPath], readSnapshotMeta: snapshotMeta, contentPrefixHash: _streamPrefixHash });
                    _recordReadSnapshot(fullPath, st, readStateScope, snapshotMeta);
                    return out;
                } catch (err) {
                    return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
                }
            }
            // Non-text special formats: intercept before binary check
            const _ext = extname(fullPath).toLowerCase();
            if (_ext === '.pdf') return _extractPdfText(fullPath, args.pages);
            if (_ext === '.ipynb') return _extractIpynbText(fullPath);
            if (isBinaryFile(fullPath, st.size)) {
                return `Error: file appears to be binary (contains null bytes): ${normalizeOutputPath(filePath)}`;
            }
            try {
                const content = await readFile(fullPath, 'utf-8');
                // W1 M: re-stat after the async readFile so a concurrent
                // Write that landed during the read is detected before
                // the cache + snapshot record stale bytes.
                let _stPostRead;
                try { _stPostRead = statSync(fullPath); } catch { _stPostRead = st; }
                if (_stPostRead.mtimeMs !== st.mtimeMs || _stPostRead.size !== st.size) {
                    st = _stPostRead;
                }
                const lines = content.split(/\r?\n/);
                if (lines.length > 0 && lines[0].charCodeAt(0) === 0xFEFF) lines[0] = lines[0].slice(1);
                const sliced = lines.slice(offset, offset + limit);
                const rendered = sliced
                    .map((line, i) => renderReadLine(offset + i + 1, line, { truncateLongLine: !wantFull }))
                    .join('\n');
                // Output byte cap protects against many-line slices that
                // individually pass the file-size check but explode after
                // line-number prefixing.
                let out;
                // W1 H: track lines actually rendered so the snapshot below
                // doesn't mark byte-cap-truncated lines as editable.
                let _renderedLineCount = sliced.length;
                if (rendered.length > READ_MAX_OUTPUT_BYTES) {
                    const linesShown = (() => {
                        const slice = rendered.slice(0, READ_MAX_OUTPUT_BYTES);
                        return slice.split('\n').length;
                    })();
                    const nextOffset = offset + linesShown;
                    _renderedLineCount = linesShown;
                    out = rendered.slice(0, READ_MAX_OUTPUT_BYTES) + `\n\n... [output truncated at ${Math.round(READ_MAX_OUTPUT_BYTES/1024)} KB] ...\nnext_call: read({path, offset:${nextOffset}, limit:${limit}})`;
                } else {
                    out = rendered;
                }
                if (hasRangeArgs && rendered.length <= READ_MAX_OUTPUT_BYTES) {
                    if (sliced.length === 0 && offset >= lines.length) {
                        out = `(no lines in range; file has ${lines.length} lines)`;
                    } else if (offset + sliced.length < lines.length) {
                        out += `${out ? '\n' : ''}${formatPaginationHint(lines.length - offset - sliced.length, offset + sliced.length)}`;
                    }
                }
                // v0.6.231 smart cap. Only engages when the caller asked for
                // the default read (no offset/limit, full:false) AND the file
                // is over the line/byte threshold. Explicit ranges always see
                // byte-exact output.
                // W1 H: smart-middle elision drops lines the model never
                // saw — don't claim full-file coverage when it triggered.
                let _smartTruncated = false;
                if (!hasRangeArgs && !wantFull) {
                    const sm = smartReadTruncate(out, lines.length, st.size);
                    out = sm.text;
                    _smartTruncated = sm.truncated === true;
                }
                // CC parity: empty file gets a system-reminder instead of a
                // bare `1\t` line. The reminder makes the empty-state
                // explicit so the agent doesn't assume content was elided.
                if (content.length === 0) {
                    // W1 M: filename can contain `<` or `</system-reminder>`
                    // sequences; XML-escape before interpolation so a hostile
                    // path can't terminate the envelope and inject markup.
                    const _safePath = normalizeOutputPath(filePath)
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;');
                    out = `<system-reminder>File exists but has empty contents: ${_safePath}</system-reminder>`;
                }
                const isFullFileView = offset === 0 && offset + limit >= lines.length && !_smartTruncated;
                const snapshotMeta = {
                    source: 'read',
                    ranges: isFullFileView
                        ? [{ startLine: 1, endLine: Infinity }]
                        : [{ startLine: offset + 1, endLine: Math.min(lines.length, offset + _renderedLineCount) }],
                    ...(isFullFileView ? { contentHash: _hashText(content) } : {}),
                };
                // Race-guard prefix hash. content variable is the full file body
                // here (regular branch, st.size <= READ_MAX_SIZE_BYTES) so the
                // hash equals the in-memory content; for files <= 64KiB this is
                // a content-equivalent fingerprint, otherwise a head-only one
                // (sufficient to detect a same-mtime / same-size rewrite of any
                // bytes within the first 64KiB — the common case).
                const _regPrefixHash = _hashText(content.length <= 65536 ? content : content.slice(0, 65536));
                _cacheSet(cacheKey, out, { paths: [fullPath], readSnapshotMeta: snapshotMeta, contentPrefixHash: _regPrefixHash });
                _recordReadSnapshot(fullPath, st, readStateScope, snapshotMeta);
                return out;
            }
            catch (err) {
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
            }
        }
        case 'write': {
            // CC `file_path` alias.
            if (typeof args.file_path === 'string' && !args.path) args.path = args.file_path;
            if (Array.isArray(args.writes) && args.writes.length > 0) {
                const items = args.writes.map((entry) => ({
                    path: normalizeInputPath(entry?.path),
                    content: entry?.content,
                }));
                const missing = items.filter((entry) => !entry.path || entry.content === undefined);
                if (missing.length > 0) {
                    return 'Error: each write entry requires path and content';
                }
                const results = [];
                const dirtyPaths = [];
                for (const entry of items) {
                    const filePath = entry.path;
                    const content = entry.content;
                    if (!isSafePath(filePath, workDir, pathOpts)) {
                        results.push(`FAIL ${normalizeOutputPath(filePath)}: path outside allowed scope`);
                        continue;
                    }
                    {
                        const fullPath = resolveAgainstCwd(filePath, workDir);
                        // W1 H: read-before-overwrite gate + per-path mutex (CAS guard).
                        const _batchResult = await _withPathLock(fullPath, async () => {
                            try {
                                const _existing = statSync(fullPath);
                                if (_existing.isFile() && !_getReadSnapshot(fullPath, readStateScope)) {
                                    return `FAIL ${normalizeOutputPath(filePath)}: file exists but has not been read yet — read before overwriting`;
                                }
                                if (_existing.isFile()) {
                                    const _bsnap = _getReadSnapshot(fullPath, readStateScope);
                                    if (_bsnap && !_snapshotCoversFullFile(_bsnap)) {
                                        return `FAIL ${normalizeOutputPath(filePath)}: partial-read snapshot — read full file before overwriting`;
                                    }
                                    if (_bsnap && _isSnapshotStale(_existing, _bsnap, fullPath)) {
                                        const _bhashOk = _readContentIfSnapshotHashMatches(fullPath, _bsnap);
                                        if (_bhashOk === null) {
                                            return `FAIL ${normalizeOutputPath(filePath)}: file modified since read — read it again before overwriting`;
                                        }
                                    }
                                }
                            } catch { /* doesn't exist — new-file write OK */ }
                            try {
                                mkdirSync(dirname(fullPath), { recursive: true });
                                await atomicWrite(fullPath, content, { sessionId: options?.sessionId });
                                _recordReadSnapshot(fullPath, undefined, readStateScope, {
                                    source: 'write',
                                    contentHash: _hashText(content),
                                });
                                return `OK ${normalizeOutputPath(filePath)}:${fullPath}`;
                            }
                            catch (err) {
                                return `FAIL ${normalizeOutputPath(filePath)}: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
                            }
                        });
                        if (typeof _batchResult === 'string' && _batchResult.startsWith(`OK ${normalizeOutputPath(filePath)}:`)) {
                            dirtyPaths.push(fullPath);
                            results.push(`OK ${normalizeOutputPath(filePath)}`);
                        } else {
                            results.push(_batchResult);
                        }
                    }
                }
                if (dirtyPaths.length > 0) {
                    invalidateBuiltinResultCache(dirtyPaths);
                    markCodeGraphDirtyPaths(workDir, dirtyPaths);
                }
                return results.join('\n');
            }
            args.path = normalizeInputPath(args.path);
            const filePath = args.path;
            const content = args.content;
            if (!filePath)
                return 'Error: path is required';
            if (content === undefined)
                return 'Error: content is required';
            if (!isSafePath(filePath, workDir, pathOpts))
                return `Error: path outside allowed scope — ${normalizeOutputPath(filePath)}`;
            {
                const fullPath = resolveAgainstCwd(filePath, workDir);
                return _withPathLock(fullPath, async () => {
                    // Read-before-overwrite gate (CC parity). Refuse to clobber an
                    // existing file the model has not Read in this session. New
                    // file creation (no statSync) is allowed. Prior Edits/Writes
                    // by us count as "read" since they recordReadSnapshot below.
                    try {
                        const _existing = statSync(fullPath);
                        if (_existing.isFile() && !_getReadSnapshot(fullPath, readStateScope)) {
                            return `Error [code 6]: file exists but has not been read yet — read before overwriting: ${filePath}`;
                        }
                        // W1 H: stale-snapshot validation. Existing-snapshot only
                        // proved the model read SOMETHING; without re-stat the file
                        // could have drifted via lint / external write since.
                        if (_existing.isFile()) {
                            const _snap = _getReadSnapshot(fullPath, readStateScope);
                            // Partial-view guard (CC FileWriteTool parity): refuse to
                            // overwrite when the snapshot only covered a range of the
                            // file — the model never saw the full content so the write
                            // could silently drop lines outside the viewed window.
                            if (_snap && !_snapshotCoversFullFile(_snap)) {
                                return `Error [code 10]: partial-read snapshot — read full file before overwriting: ${filePath}`;
                            }
                            if (_snap && _isSnapshotStale(_existing, _snap, fullPath)) {
                                const _hashOk = _readContentIfSnapshotHashMatches(fullPath, _snap);
                                if (_hashOk === null) {
                                    return `Error [code 7]: file modified since read — read it again before overwriting: ${filePath}`;
                                }
                            }
                        }
                    } catch { /* doesn't exist — new file write OK */ }
                    try {
                        // Auto-create missing parent directories so deep new paths
                        // like `.v0610_test/deep/nested/file.txt` succeed in one
                        // shot, matching Claude Code's Write tool behaviour.
                        // `recursive:true` is a no-op when the directory already
                        // exists and is cross-OS safe (POSIX + NTFS).
                        mkdirSync(dirname(fullPath), { recursive: true });
                        // v0.6.248: atomic write via tempfile + fsync + rename.
                        // Non-atomic writeFileSync leaves a 0-byte / truncated file
                        // on disk if the process dies mid-write (observed 2026-XX
                        // when a bridge worker's SSE stream hung during an Edit on
                        // openai-oauth-ws.mjs). atomicWrite preserves the file mode
                        // on overwrite so we don't inadvertently widen 0o600 → 0o644.
                        await atomicWrite(fullPath, content, { sessionId: options?.sessionId });
                        invalidateBuiltinResultCache([fullPath]);
                        markCodeGraphDirtyPaths(workDir, [fullPath]);
                        // Write establishes the on-disk state the model just
                        // authored, so a subsequent Edit does not need a fresh
                        // Read round-trip.
                        _recordReadSnapshot(fullPath, undefined, readStateScope, {
                            source: 'write',
                            contentHash: _hashText(content),
                        });
                        return `Written: ${normalizeOutputPath(filePath)}`;
                    }
                    catch (err) {
                        return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
                    }
                });
            }
        }
        case 'edit': {
            // CC `file_path` alias — also normalize per-edit `file_path`.
            if (typeof args.file_path === 'string' && !args.path) args.path = args.file_path;
            if (Array.isArray(args.edits)) {
                for (const _e of args.edits) {
                    if (_e && typeof _e.file_path === 'string' && !_e.path) _e.path = _e.file_path;
                }
            }
            // Unified-edit dispatch:
            //   edits array present → single-file (same path across items) or
            //     cross-file fan-out, inferred from per-item path homogeneity.
            //   Omitted path on an edit item falls back to top-level `path`.
            //   Otherwise single-edit semantics below.
            if (Array.isArray(args.edits) && args.edits.length > 0) {
                const items = args.edits.map((e) => ({
                    path: e?.path || args.path,
                    old_string: e?.old_string,
                    new_string: e?.new_string,
                    replace_all: e?.replace_all,
                }));
                const paths = new Set(items.map((x) => x.path).filter(Boolean));
                if (paths.size === 0) return 'Error: each edit requires a path (either on the item or at top level)';
                if (paths.size === 1) {
                    const onePath = [...paths][0];
                    return _runMultiEdit({
                        path: onePath,
                        edits: items.map(({ path: _p, ...rest }) => rest),
                    }, workDir, readStateScope, pathOpts, options);
                }
                return _runBatchEdit({
                    edits: items.map((x) => ({
                        path: x.path, old_string: x.old_string, new_string: x.new_string, replace_all: x.replace_all,
                    })),
                }, workDir, readStateScope, pathOpts, executeChildBuiltinTool, options);
            }
            args.path = normalizeInputPath(args.path);
            const filePath = args.path;
            const oldStr = args.old_string;
            const newStr = args.new_string;
            const replaceAll = args.replace_all === true;
            if (!filePath || typeof oldStr !== 'string' || oldStr.length === 0)
                return 'Error: path and non-empty old_string are required';
            if (typeof newStr !== 'string')
                return 'Error: new_string must be a string';
            if (newStr === oldStr)
                return 'Error: new_string must differ from old_string';
            // Line-prefix guard: Read returns `<n>\t<content>`. If the model
            // pasted the prefix into old_string the on-disk content has no
            // matching tab-prefixed line, so the match would silently fail.
            // Surface a precise error instead.
            if (/^\s*\d+\t/.test(oldStr))
                return `Error: old_string starts with a Read line-number prefix (\"<n>\\t\") — strip the prefix before Edit: ${filePath}`;
            if (!isSafePath(filePath, workDir, pathOpts))
                return `Error: path outside allowed scope — ${normalizeOutputPath(filePath)}`;
            const fullPath = resolveAgainstCwd(filePath, workDir);
            // F2 fix: single stat syscall replaces existsSync + statSync pair.
            // ENOENT -> Error [code 4] with similar-file hint; mtime drift ->
            // Error [code 7]. Collapsing the two probes also closes the TOCTOU
            // window where the file could be deleted between checks.
            {
                let _preLockStat;
                try { _preLockStat = statSync(fullPath); }
                catch (err) {
                    if (err && err.code === 'ENOENT') {
                        const similar = findSimilarFile(fullPath);
                        const hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
                        return `Error [code 4]: file not found: ${filePath}${hint}`;
                    }
                    return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
                }
                // Error [code 6]: Read-before-Edit enforcement. Prevents phantom
                // edits where the model invents an old_string based on cached
                // assumptions against a file that has drifted.
                const _preLockSnap = _getReadSnapshot(fullPath, readStateScope);
                if (!_preLockSnap) {
                    return _primeReadSnapshotForEdit({
                        fullPath,
                        filePath,
                        st: _preLockStat,
                        scope: readStateScope,
                        oldStrings: [{ label: 'edit', old_string: oldStr }],
                    }) || `Error [code 6]: file has not been read yet — read before editing: ${filePath}`;
                }
            }
            // CAS guard: serialise concurrent edits to the same path.
            // After acquiring the lock, re-stat + re-hash to detect drift
            // that occurred between the pre-lock snapshot check and now.
            return _withPathLock(fullPath, async () => {
                let editStat;
                try { editStat = statSync(fullPath); }
                catch (err) {
                    if (err && err.code === 'ENOENT') {
                        const similar = findSimilarFile(fullPath);
                        const hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
                        return `Error [code 4]: file not found: ${filePath}${hint}`;
                    }
                    return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
                }
                const editSnapshot = _getReadSnapshot(fullPath, readStateScope);
                if (!editSnapshot)
                    return `Error [code 6]: file has not been read yet — read before editing: ${filePath}`;
                // Error [code 7]: detect stale read via mtime drift (Anthropic
                // readFileState timestamp check parity). +1ms slack absorbs
                // filesystem timestamp resolution noise on NTFS/exFAT.
                let editPreloadedContent = null;
                if (_isSnapshotStale(editStat, editSnapshot, fullPath)) {
                    editPreloadedContent = _readContentIfSnapshotHashMatches(fullPath, editSnapshot);
                    if (editPreloadedContent === null) {
                        return `Error [code 7]: file modified since read (lint / formatter / external write) — read it again before editing: ${filePath}`;
                    }
                }
                try {
                    try {
                        const _editSz = statSync(fullPath).size;
                        if (_editSz > 1073741824) {
                            return `Error: edit refused: file too large (size: ${_editSz}B, cap: 1GiB)`;
                        }
                    } catch { /* statSync failed — fall through to readFileSync error */ }
                    // D-R1-3: refuse edits on non-UTF-8 files before the
                    // utf-8 decode round-trip silently corrupts bytes via
                    // U+FFFD replacement. Use Buffer.isUtf8 (Node>=18) or
                    // a byte-level walk as fallback.
                    // Fix J-3: always read raw bytes and validate encoding,
                    // even when editPreloadedContent was set via contentHash
                    // preload — the cached string bypasses the guard otherwise.
                    {
                        const _rawBuf = editPreloadedContent === null
                            ? readFileSync(fullPath)
                            : Buffer.from(editPreloadedContent, 'utf-8');
                        const _isUtf8Valid = (() => {
                            if (typeof Buffer.isUtf8 === 'function') return Buffer.isUtf8(_rawBuf);
                            // Fix J-2: strict manual UTF-8 walk for Node <18.
                            // Rejects overlong sequences, surrogates, out-of-range
                            // code points, and 5/6-byte sequences (Unicode §3.9
                            // Table 3-7).
                            let idx2 = 0;
                            while (idx2 < _rawBuf.length) {
                                const b0 = _rawBuf[idx2];
                                if (b0 < 0x80) { idx2++; continue; }
                                let seqLen = 0;
                                if ((b0 & 0xE0) === 0xC0) seqLen = 2;
                                else if ((b0 & 0xF0) === 0xE0) seqLen = 3;
                                else if ((b0 & 0xF8) === 0xF0) seqLen = 4;
                                else return false; // continuation byte or 5/6-byte leader
                                if (idx2 + seqLen > _rawBuf.length) return false;
                                // Reject overlong 2-byte: C0/C1 (< U+0080)
                                if (seqLen === 2 && b0 <= 0xC1) return false;
                                const b1 = _rawBuf[idx2 + 1];
                                // Reject overlong 3-byte: E0 80–9F (< U+0800)
                                if (seqLen === 3 && b0 === 0xE0 && b1 < 0xA0) return false;
                                // Reject surrogates: ED A0–BF (U+D800–U+DFFF)
                                if (seqLen === 3 && b0 === 0xED && b1 >= 0xA0) return false;
                                // Reject overlong 4-byte: F0 80–8F (< U+10000)
                                if (seqLen === 4 && b0 === 0xF0 && b1 < 0x90) return false;
                                // Reject out-of-range 4-byte: F4 90–BF or F5+ (> U+10FFFF)
                                if (seqLen === 4 && (b0 > 0xF4 || (b0 === 0xF4 && b1 >= 0x90))) return false;
                                for (let k = 1; k < seqLen; k++) {
                                    if ((_rawBuf[idx2 + k] & 0xC0) !== 0x80) return false;
                                }
                                idx2 += seqLen;
                            }
                            return true;
                        })();
                        if (!_isUtf8Valid) {
                            return `Error: file appears to be non-UTF-8 (Shift-JIS/Latin-1/binary mix). Edit aborted to prevent silent corruption. Path: ${filePath}`;
                        }
                    }
                    let content = editPreloadedContent === null
                        ? readFileSync(fullPath, 'utf-8')
                        : editPreloadedContent;
                    // W1 M: Read renders CRLF as LF and strips BOM. Edit must
                    // accept old_string in the displayed shape: try the raw
                    // bytes first, then a CRLF→LF / BOM-stripped retry. On
                    // success the writeback preserves the original line
                    // endings so Edit doesn't silently convert files.
                    let _origContentForWrite = content;
                    let _normalisedView = false;
                    if (!content.includes(oldStr)
                        && (content.indexOf('\r\n') !== -1 || content.charCodeAt(0) === 0xFEFF)) {
                        const _stripped = (content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content)
                            .replace(/\r\n/g, '\n');
                        if (_stripped.includes(oldStr)) {
                            content = _stripped;
                            _normalisedView = true;
                        }
                    }
                    let partialCoverageErr = _validatePartialSnapshotCoverage(content, oldStr, editSnapshot, filePath);
                    if (partialCoverageErr) {
                        // Lenient path: snapshot's mtime/size still matches on-disk
                        // file + unique `old_string` match → widen ranges and proceed.
                        // Multi-match keeps the strict reject below via Error [code 9].
                        if (_maybeExtendSnapshotForUniqueMatch(content, oldStr, editSnapshot)) {
                            partialCoverageErr = _validatePartialSnapshotCoverage(content, oldStr, editSnapshot, filePath);
                        }
                        if (partialCoverageErr) return partialCoverageErr;
                    }
                    const count = content.split(oldStr).length - 1;
                    if (count === 0)
                        return `Error [code 8]: old_string not found in ${filePath}.${_findEditHint(content, oldStr, editSnapshot)}`;
                    if (count > 1 && !replaceAll)
                        return `Error [code 9]: old_string found ${count} times — set replace_all:true or provide more unique context`;
                    let updated = replaceAll
                        ? content.split(oldStr).join(newStr)
                        : content.replace(oldStr, () => newStr);
                    // W1 M: if we matched against the normalised view, restore
                    // the original CRLF endings + BOM so Edit doesn't silently
                    // convert line endings or strip the byte-order mark.
                    if (_normalisedView) {
                        const _hadBom = _origContentForWrite.charCodeAt(0) === 0xFEFF;
                        const _hadCrlf = _origContentForWrite.indexOf('\r\n') !== -1;
                        if (_hadCrlf) updated = updated.replace(/\n/g, '\r\n');
                        if (_hadBom && updated.charCodeAt(0) !== 0xFEFF) updated = '\uFEFF' + updated;
                    }
                    // v0.6.248: atomic write — see `write` handler for rationale.
                    await atomicWrite(fullPath, updated, { sessionId: options?.sessionId });
                    invalidateBuiltinResultCache([fullPath]);
                    markCodeGraphDirtyPaths(workDir, [fullPath]);
                    // Refresh the snapshot to the post-write mtime so a chain
                    // of edits against the same file doesn't trip the stale
                    // check on the second hop.
                    _recordReadSnapshot(fullPath, undefined, readStateScope, {
                        source: 'edit',
                        contentHash: _hashText(updated),
                    });
                    return `Edited: ${normalizeOutputPath(filePath)}`;
                }
                catch (err) {
                    return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
                }
            });
        }
        case 'grep': {
            args.path = normalizeInputPath(args.path);
            const rawPattern = args.pattern;
            const patterns = (Array.isArray(rawPattern)
                ? rawPattern.filter(p => typeof p === 'string' && p)
                : (rawPattern ? [String(rawPattern)] : [])).map(normalizeSearchPattern);
            if (patterns.length === 0)
                return 'Error: pattern is required';
            const searchPath = args.path || '.';
            if (!isSafePath(searchPath, workDir, pathOpts)) {
                return `Error: path outside allowed scope — ${normalizeOutputPath(searchPath)}`;
            }
            const rawGlob = args.glob;
            const rawGlobs = (Array.isArray(rawGlob)
                ? rawGlob.filter(g => typeof g === 'string' && g)
                : (rawGlob ? [String(rawGlob)] : [])).map(normalizeInputPath);
            // CC GrepTool parity: when a caller passes an absolute glob
            // (e.g. after `~` expansion or fully-qualified path matching),
            // rg --glob would receive `<root>/<absolute-glob>` and match
            // nothing. Strip the absolute prefix to the relative tail so
            // glob behaves the same way the glob tool already handles it.
            const globPatterns = [];
            for (const g of rawGlobs) {
                if (isAbsolute(g)) {
                    const { relativePattern } = extractGlobBaseDirectory(g);
                    globPatterns.push(relativePattern);
                } else {
                    globPatterns.push(g);
                }
            }
            // output_mode mirrors Anthropic GrepTool: files_with_matches
            // (default — paths only, lowest token cost), content (matched
            // lines + path + line number), count (per-file match counts).
            const outputMode = args.output_mode || 'files_with_matches';
            const headLimitRaw = args.head_limit;
            const headLimit = headLimitRaw === 0 ? Infinity : (headLimitRaw || 250);
            const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0;
            // Extended rg flag decoding (Anthropic GrepTool parity): case
            // fold, line numbers, -A/-B/-C windowing, and multiline dot.
            // Context flags and line numbers are silently ignored outside
            // content mode since rg rejects them there.
            const caseInsensitive = args['-i'] === true;
            const showLineNumbers = args['-n'] !== false; // default true for content mode
            const afterN = typeof args['-A'] === 'number' ? args['-A'] : null;
            const beforeN = typeof args['-B'] === 'number' ? args['-B'] : null;
            const contextN = typeof args['-C'] === 'number'
                ? args['-C']
                : (typeof args.context === 'number' ? args.context : null);
            const multilineMode = args.multiline === true;
            const fileType = typeof args.type === 'string' && args.type.trim()
                ? args.type.trim()
                : '';
            const cacheKey = buildGrepCacheKey({
                patterns,
                searchPath,
                globPatterns,
                outputMode,
                headLimit,
                offset,
                caseInsensitive,
                showLineNumbers,
                beforeN,
                afterN,
                contextN,
                multilineMode,
                fileType,
            });
            const cached = _cacheGet(cacheKey);
            if (cached !== null) return cached;
            try {
                const rgArgs = buildGrepRgArgs({
                    patterns,
                    searchPath,
                    globPatterns,
                    outputMode,
                    caseInsensitive,
                    showLineNumbers,
                    beforeN,
                    afterN,
                    contextN,
                    multilineMode,
                    fileType,
                });
                const stdout = await runRg(rgArgs, { cwd: workDir });
                const allLines = stdout.split('\n').filter(Boolean);
                // Apply offset before head_limit so pagination is predictable:
                // page 1 = offset 0, page 2 = offset + head_limit, etc.
                const windowed = offset > 0 ? allLines.slice(offset) : allLines;
                // Hard cap for content-mode grep when head_limit is unset/0/Infinity.
                // Without this a `grep -n` with no head_limit on a busy term would
                // dump every match into the LLM context. Match CC GrepTool's
                // 250-default semantic at the floor; explicit head_limit overrides.
                const GREP_CONTENT_HARD_CAP = 1000;
                // When caller explicitly passes head_limit:0, headLimitRaw===0
                // which was converted to Infinity above. Treat that as "truly
                // unlimited" — do NOT apply the hard cap. Only apply the cap
                // when head_limit was absent (headLimitRaw was undefined/null).
                const _callerExplicitUnlimited = headLimitRaw === 0;
                const effectiveHeadLimit = headLimit === Infinity
                    ? (_callerExplicitUnlimited ? Infinity : (outputMode === 'content' ? GREP_CONTENT_HARD_CAP : Infinity))
                    : headLimit;
                const lines = effectiveHeadLimit === Infinity ? windowed : windowed.slice(0, effectiveHeadLimit);
                // Unify separators in the path portion so Windows results
                // don't surface mixed `C:/.../foo\bar.mjs` lines.
                const normalized = lines.map(normalizeGrepLine);
                const summarySource = (headLimit === Infinity ? windowed : windowed.slice(0, Math.max(lines.length, 120))).map(normalizeGrepLine);
                const summary = outputMode === 'content'
                    ? _buildGrepContentSummary(summarySource, patterns)
                    : '';
                const remaining = windowed.length - lines.length;
                const truncated = remaining > 0
                    ? `\n... [${remaining} more entries]`
                    : '';
                const body = (normalized.join('\n') + truncated) || '(no matches)';
                const out = capShellOutput((summary ? `${summary}\n\n${body}` : body));
                _cacheSet(cacheKey, out, { scopes: [resolveAgainstCwd(searchPath, workDir)] });
                return out;
            }
            catch (err) {
                // `runRg` swallows rg exit-1 (no match) and returns ''; any
                // error reaching here is a real failure (invalid regex,
                // permission denied, spawn error). Surface rg's stderr so
                // the caller can diagnose rather than mistake it for no-match.
                const stderr = err?.stderr ? String(err.stderr).trim() : '';
                const msg = stderr || err?.message || String(err);
                return `Error: ${msg.slice(0, 500)}`;
            }
        }
        case 'glob': {
            args.path = normalizeInputPath(args.path);
            const rawPattern = args.pattern;
            const patterns = (Array.isArray(rawPattern)
                ? rawPattern.filter(p => typeof p === 'string' && p)
                : (rawPattern ? [String(rawPattern)] : [])).map(normalizeInputPath);
            if (patterns.length === 0)
                return 'Error: pattern is required';
            const basePath = args.path || '.';
            const headLimitRaw = args.head_limit;
            const headLimit = headLimitRaw === 0 ? Infinity : (headLimitRaw || 100);
            const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0;
            // Group patterns by resolved baseDir so multiple absolute roots
            // (e.g. C:\a\**\*.js and D:\b\*.ts) each get their own rg pass.
            const groups = new Map();
            function addToGroup(root, rel) {
                if (!groups.has(root)) groups.set(root, []);
                groups.get(root).push(rel);
            }
            for (const p of patterns) {
                if (isAbsolute(p)) {
                    const { baseDir, relativePattern } = extractGlobBaseDirectory(p);
                    addToGroup(baseDir || basePath, relativePattern);
                } else {
                    addToGroup(basePath, p);
                }
            }
            for (const root of groups.keys()) {
                if (!isSafePath(root, workDir, pathOpts)) {
                    return `Error: path outside allowed scope — ${normalizeOutputPath(root)}`;
                }
            }
            const cacheKey = buildGlobCacheKey({ patterns, basePath, headLimit, offset });
            const cached = _cacheGet(cacheKey);
            if (cached !== null) return cached;
            const allFiles = [];
            const rgErrors = [];
            for (const [root, rels] of groups) {
                const rgArgs = ['--files'];
                for (const ex of DEFAULT_IGNORE_GLOBS) rgArgs.push('--glob', ex);
                for (const rel of rels) rgArgs.push('--glob', rel);
                rgArgs.push(root);
                try {
                    const stdout = await runRg(rgArgs, { cwd: workDir, timeout: 10000 });
                    for (const line of stdout.split('\n')) {
                        const trimmed = line.trim();
                        if (trimmed) allFiles.push(trimmed);
                    }
                } catch (err) {
                    // _spawnRg already maps code 1 (no matches) → resolve('')
                    // so this catch only fires on real errors (invalid glob,
                    // permission denied, missing rg binary, timeout). Surface
                    // them instead of silently returning "no files found",
                    // which masked typos and OS-level access failures as
                    // empty results.
                    const stderr = String(err?.stderr || err?.message || err).trim().split('\n').slice(0, 3).join('; ');
                    rgErrors.push(`rg failed for ${normalizeOutputPath(root)}: ${stderr || 'unknown error'}`);
                }
            }
            if (rgErrors.length > 0 && allFiles.length === 0) {
                return `Error: ${rgErrors.join(' | ')}`;
            }
            const unique = Array.from(new Set(allFiles));
            // Sort by mtime descending (Anthropic GlobTool parity): recent
            // edits surface first, so the agent sees the file it just
            // touched at the top of a wide match. stat failures degrade
            // to mtime=0 so missing/race-condition entries land at the
            // end rather than aborting the whole sort.
            const withStat = unique.map((p) => {
                const full = isAbsolute(p) ? p : resolveAgainstCwd(p, workDir);
                try { return { path: p, full, mtime: getCachedReadOnlyStat(full).mtimeMs }; }
                catch { return { path: p, full, mtime: 0 }; }
            });
            withStat.sort((a, b) => b.mtime - a.mtime);
            const windowed = offset > 0 ? withStat.slice(offset) : withStat;
            const capped = (headLimit === Infinity ? windowed : windowed.slice(0, headLimit)).map((entry) => {
                // Emit relative paths for files under cwd (GlobTool parity:
                // GlobTool.ts:165 emits relative). Absolute only when the
                // match lives outside the working directory (cross-root glob).
                const abs = entry.full || resolveAgainstCwd(entry.path, workDir);
                const normalizedWorkDir = normalizeOutputPath(workDir);
                const normalizedAbs = normalizeOutputPath(abs);
                if (normalizedAbs.startsWith(normalizedWorkDir + '/') || normalizedAbs.startsWith(normalizedWorkDir + '\\')) {
                    return normalizedAbs.slice(normalizedWorkDir.length + 1);
                }
                return normalizedAbs;
            });
            const remaining = windowed.length - capped.length;
            const errSuffix = rgErrors.length > 0 ? `\n... [warning] ${rgErrors.join(' | ')}` : '';
            const out = capShellOutput((capped.join('\n') + (remaining > 0 ? `\n... [${remaining} more entries]` : '') + errSuffix) || '(no files found)');
            _cacheSet(cacheKey, out, { scopes: [...groups.keys()].map((root) => resolveAgainstCwd(root, workDir)) });
            return out;
        }
        case 'list': {
            // Unified-list dispatch (v0.6.283+):
            //   mode:'tree'  → tree handler (ASCII visualization)
            //   mode:'find'  → find_files handler (name/size/mtime filter)
            //   default      → list below (metadata rows).
            if (args.mode === 'tree') return executeChildBuiltinTool('tree', args, workDir);
            if (args.mode === 'find') return executeChildBuiltinTool('find_files', args, workDir);
            args.path = normalizeInputPath(args.path);
            const inputPath = args.path || '.';
            const depth = Math.min(Math.max(parseInt(args.depth ?? 1, 10) || 1, 1), 10);
            const hidden = Boolean(args.hidden);
            const sort = ['name', 'mtime', 'size'].includes(args.sort) ? args.sort : 'name';
            const typeFilter = ['any', 'file', 'dir'].includes(args.type) ? args.type : 'any';
            const headLimit = parseInt(args.head_limit ?? 200, 10);
            const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0;
            const gatherLimit = headLimit > 0 ? offset + headLimit : 0;
            const needsGlobalStat = sort === 'mtime' || sort === 'size';
            const cacheKey = buildListCacheKey({
                mode: 'list',
                inputPath,
                depth,
                hidden,
                sort,
                typeFilter,
                headLimit,
                offset,
            });
            if (!isSafePath(inputPath, workDir, pathOpts)) {
                return `Error: path outside allowed scope — ${normalizeOutputPath(inputPath)}`;
            }
            const cached = _cacheGet(cacheKey);
            if (cached !== null) return cached;
            const fullPath = resolveAgainstCwd(inputPath, workDir);
            let st;
            try { st = getCachedReadOnlyStat(fullPath); }
            catch (err) { return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`; }
            if (!st.isDirectory()) return `Error: not a directory — ${normalizeOutputPath(fullPath)}`;

            const rows = [];
            // F5: walkDir handles dotfile filter, depth cap, and recursion.
            // Visitor returns false to abort the walk once headLimit is
            // satisfied (F1 fix — old loop kept stat-calling after cap).
            walkDir(fullPath, {
                hidden,
                maxDepth: depth,
                visit: (ent, entPath) => {
                    const isDir = ent.isDirectory();
                    const isFile = ent.isFile();
                    if (typeFilter === 'file' && !isFile) return;
                    if (typeFilter === 'dir' && !isDir) return;
                    const entType = isDir ? 'dir' : (isFile ? 'file' : (ent.isSymbolicLink() ? 'symlink' : 'other'));
                    let size = 0, mtimeMs = 0;
                    if (needsGlobalStat) {
                        try { const s = getCachedReadOnlyStat(entPath); size = s.size; mtimeMs = s.mtimeMs; }
                        catch { /* keep zero */ }
                    }
                    rows.push({
                        // Absolute path always — keep all list/tree/find
                        // outputs uniform so downstream callers don't have
                        // to disambiguate cwd-relative vs absolute rows.
                        path: entPath,
                        type: entType,
                        size,
                        mtimeMs,
                        fullPath: entPath,
                    });
                    // Only stop early when output order matches traversal order
                    // (lexicographic). For mtime/size, the global top-N requires
                    // a full sweep before sort.
                    if (sort === 'name' && gatherLimit > 0 && rows.length >= gatherLimit) return false;
                },
            });

            if (sort === 'mtime') rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
            else if (sort === 'size') rows.sort((a, b) => b.size - a.size);
            else rows.sort((a, b) => a.path.localeCompare(b.path));

            const windowed = offset > 0 ? rows.slice(offset) : rows;
            const sliced = headLimit > 0 ? windowed.slice(0, headLimit) : windowed;
            if (!needsGlobalStat) {
                for (const row of sliced) {
                    try {
                        const s = getCachedReadOnlyStat(row.fullPath);
                        row.size = s.size;
                        row.mtimeMs = s.mtimeMs;
                    } catch { /* keep zero */ }
                }
            }
            const lines = sliced.map(r =>
                `${normalizeOutputPath(r.path)}\t${r.type}\t${r.size}\t${formatMtime(r.mtimeMs)}`);
            if (windowed.length > sliced.length) lines.push(`... ${windowed.length - sliced.length} more entries`);
            const out = lines.join('\n') || '(empty directory)';
            _cacheSet(cacheKey, out, { scopes: [fullPath] });
            return out;
        }
        case 'tree': {
            args.path = normalizeInputPath(args.path);
            const inputPath = args.path || '.';
            const depth = Math.min(Math.max(parseInt(args.depth ?? 3, 10) || 3, 1), 6);
            const hidden = Boolean(args.hidden);
            const headLimit = parseInt(args.head_limit ?? 200, 10);
            const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0;
            const cacheKey = buildListCacheKey({
                mode: 'tree',
                inputPath,
                depth,
                hidden,
                sort: '',
                typeFilter: '',
                headLimit,
                offset,
            });
            if (!isSafePath(inputPath, workDir, pathOpts)) {
                return `Error: path outside allowed scope — ${normalizeOutputPath(inputPath)}`;
            }
            const cached = _cacheGet(cacheKey);
            if (cached !== null) return cached;
            const fullPath = resolveAgainstCwd(inputPath, workDir);
            let st;
            try { st = getCachedReadOnlyStat(fullPath); }
            catch (err) { return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`; }
            if (!st.isDirectory()) return `Error: not a directory — ${normalizeOutputPath(fullPath)}`;
            // Root header carries the absolute path so the tree caption is
            // self-contained — same rule as list / find: every emitted
            // path is absolute, no cwd-relative basename surprise.
            const lines = [`${normalizeOutputPath(fullPath)}/`];
            // F5: share walkDir with list / find_files. Prefix state lives in
            // a stack keyed by depth — walkDir exposes {depth, index, total,
            // isLast} via ctx so branch drawing works without an own walk.
            const prefixStack = [''];
            // Hoisted so the visit closure can short-circuit traversal as
            // soon as the eventual cap is reached, instead of walking the
            // whole tree before the post-walk slice. Without this, a
            // mode:tree without head_limit on a 50k-entry repo walks all
            // 50k entries first, then trims to 500 — wall time blows up
            // on large trees.
            const TREE_BRANCH_LINE_CAP = 500;
            walkDir(fullPath, {
                hidden,
                maxDepth: depth,
                sort: (a, b) => {
                    const ad = a.isDirectory(), bd = b.isDirectory();
                    if (ad !== bd) return ad ? -1 : 1;
                    return a.name.localeCompare(b.name);
                },
                visit: (ent, _entPath, ctx) => {
                    const prefix = prefixStack[ctx.depth - 1] || '';
                    const branch = ctx.isLast ? '└── ' : '├── ';
                    // Branches carry the basename only — the root header
                    // already pins the absolute path, and emitting it on
                    // every branch destroys the visual hierarchy that
                    // mode:tree exists to convey. Callers needing exact
                    // paths use mode:list / mode:find which retain the
                    // absolute-path policy.
                    const display = ent.isDirectory() ? `${ent.name}/` : ent.name;
                    lines.push(`${prefix}${branch}${display}`);
                    if (ent.isDirectory()) {
                        prefixStack[ctx.depth] = prefix + (ctx.isLast ? '    ' : '│   ');
                    }
                    // Stop walking as soon as we have enough lines for the
                    // eventual slice. headLimit > 0 uses caller-provided
                    // budget; unset/0 still bounds via TREE_BRANCH_LINE_CAP
                    // so the walk does not run unbounded on huge trees.
                    const gatherLimit = headLimit > 0
                        ? offset + headLimit + 1
                        : offset + TREE_BRANCH_LINE_CAP + 1;
                    if (lines.length >= gatherLimit) return false;
                },
            });
            const root = lines[0];
            const body = lines.slice(1);
            const windowed = offset > 0 ? body.slice(offset) : body;
            // Tree branch line cap. Mirrors CC LSTool's truncated-flag pattern
            // so a default-`list mode:tree` over a populated repo cannot dump
            // 50k branch lines into the LLM context. Explicit head_limit > 0
            // still wins; this is the floor for the unset-or-0 case.
            // (TREE_BRANCH_LINE_CAP is hoisted above for traversal early-stop.)
            const branchLimit = headLimit > 0 ? headLimit : TREE_BRANCH_LINE_CAP;
            const sliced = windowed.slice(0, branchLimit);
            const outLines = [root, ...sliced];
            if (windowed.length > sliced.length) {
                outLines.push(`... +${windowed.length - sliced.length} more entries (raise head_limit or narrow path)`);
            }
            // Char cap on the joined output. Even bounded line counts can still
            // exceed a sane context budget when names are long; truncate at 50KB
            // to match CC's GlobTool / GrepTool spill threshold and append a
            // pagination hint so the caller knows how to widen.
            const TREE_OUTPUT_CHAR_CAP = 50_000;
            let out = outLines.join('\n');
            if (out.length > TREE_OUTPUT_CHAR_CAP) {
                out = out.slice(0, TREE_OUTPUT_CHAR_CAP) + `\n... [output truncated at ${Math.round(TREE_OUTPUT_CHAR_CAP/1024)} KB; narrow path or lower depth]`;
            }
            _cacheSet(cacheKey, out, { scopes: [fullPath] });
            return out;
        }
        // INTERNAL ONLY — not exposed in tools.json. Reached via list mode='find'
        // child dispatch (see case 'list' above). Do not call directly from
        // external callers; use list({ mode: 'find', ... }) instead.
        case 'find_files': {
            args.path = normalizeInputPath(args.path);
            const inputPath = args.path || '.';
            const namePattern = typeof args.name === 'string' ? args.name : null;
            const typeFilter = ['any', 'file', 'dir'].includes(args.type) ? args.type : 'any';
            const minSize = typeof args.min_size === 'number' && args.min_size > 0 ? args.min_size : null;
            const maxSize = typeof args.max_size === 'number' && args.max_size > 0 ? args.max_size : null;
            const headLimit = parseInt(args.head_limit ?? 100, 10);
            const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0;
            const cacheKey = buildListCacheKey({
                mode: 'find',
                inputPath,
                depth: '',
                hidden: false,
                sort: '',
                typeFilter,
                headLimit,
                offset,
                namePattern,
                minSize,
                maxSize,
                modifiedAfter: args.modified_after || '',
                modifiedBefore: args.modified_before || '',
            });
            if (!isSafePath(inputPath, workDir, pathOpts)) {
                return `Error: path outside allowed scope — ${normalizeOutputPath(inputPath)}`;
            }
            const cached = _cacheGet(cacheKey);
            if (cached !== null) return cached;

            const parseTime = (v) => {
                if (typeof v !== 'string') return null;
                const m = v.match(/^(\d+)([hd])$/);
                if (m) {
                    const n = parseInt(m[1], 10);
                    const unit = m[2] === 'h' ? 3600 * 1000 : 86400 * 1000;
                    return Date.now() - n * unit;
                }
                const t = Date.parse(v);
                return isNaN(t) ? null : t;
            };
            const after = parseTime(args.modified_after);
            const before = parseTime(args.modified_before);

            // F6: glob-to-regex compiler extracted so the $-escape safety
            // note lives in one place (see compileSimpleGlob).
            const nameRegex = compileSimpleGlob(namePattern);

            const fullPath = resolveAgainstCwd(inputPath, workDir);
            let rootStat;
            try { rootStat = getCachedReadOnlyStat(fullPath); }
            catch (err) { return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`; }
            if (!rootStat.isDirectory()) return `Error: not a directory — ${normalizeOutputPath(fullPath)}`;

            const matches = [];
            // Hard absolute cap to bound memory/time on huge trees. The
            // sort key (mtime, newest first) does not align with walk
            // order, so an early stop at `offset+headLimit` would yield
            // a partial sort and give the wrong "newest N" answer
            // whenever newer files live deeper in the walk. Walk fully
            // (up to the absolute cap), then sort, then page.
            const FIND_ABSOLUTE_CAP = 50_000;
            let truncatedByCap = false;
            walkDir(fullPath, {
                hidden: false,
                visit: (ent, entPath) => {
                    const isDir = ent.isDirectory();
                    const isFile = ent.isFile();
                    if (typeFilter === 'file' && !isFile) return;
                    if (typeFilter === 'dir' && !isDir) return;
                    if (nameRegex && !nameRegex.test(ent.name)) return;
                    let stat;
                    try { stat = getCachedReadOnlyStat(entPath); } catch { return; }
                    if (isFile) {
                        if (minSize !== null && stat.size < minSize) return;
                        if (maxSize !== null && stat.size > maxSize) return;
                    }
                    if (after !== null && stat.mtimeMs < after) return;
                    if (before !== null && stat.mtimeMs > before) return;
                    matches.push({ path: entPath, size: stat.size, mtimeMs: stat.mtimeMs });
                    if (matches.length >= FIND_ABSOLUTE_CAP) {
                        truncatedByCap = true;
                        return false;
                    }
                },
            });

            matches.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
            const windowed = offset > 0 ? matches.slice(offset) : matches;
            const sliced = headLimit > 0 ? windowed.slice(0, headLimit) : windowed;
            const lines = sliced.map(m =>
                `${normalizeOutputPath(m.path)}\t${m.size}\t${formatMtime(m.mtimeMs)}`);
            if (windowed.length > sliced.length) lines.push(`... ${windowed.length - sliced.length} more entries`);
            if (truncatedByCap) lines.push(`... walk truncated at ${FIND_ABSOLUTE_CAP} matches; narrow the scope (path/name/modified_after) for accurate global sort`);
            const out = lines.join('\n') || '(no matches)';
            _cacheSet(cacheKey, out, { scopes: [fullPath] });
            return out;
        }
        // INTERNAL ONLY — not exposed in tools.json. Reached via read mode='head'
        // child dispatch (see case 'read' above). The string "head" in
        // tools.json appears only as a read.mode enum value, not as a tool name.
        // Do not call directly from external callers; use read({ mode: 'head', ... }).
        case 'head': {
            const n = Math.max(1, Math.min(parseInt(args.n ?? 20, 10) || 20, 2000));
            let opened;
            try { opened = await openForRead(args.path, workDir, readPathOpts); }
            catch (err) {
                if (err && err.code === 'ETOOBIG') {
                    // W1 M: re-run binary check before streaming. openForRead
                    // throws ETOOBIG before isBinaryFile, so the fallback
                    // would happily stream a 300KB PNG as utf-8.
                    if (err.fullPath && isBinaryFile(err.fullPath, err.size ?? 0)) {
                        return `Error: file appears to be binary (contains null bytes): ${normalizeOutputPath(err.fullPath)}`;
                    }
                    try {
                        const stream = createReadStream(err.fullPath, { encoding: 'utf-8' });
                        const rl = createInterface({ input: stream, crlfDelay: Infinity });
                        const collected = [];
                        for await (let line of rl) {
                            if (collected.length === 0 && line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
                            collected.push(`${collected.length + 1}\t${line}`);
                            if (collected.length >= n) { rl.close(); stream.destroy(); break; }
                        }
                        return capShellOutput(collected.join('\n'));
                    } catch (err2) {
                        return `Error: ${normalizeErrorMessage(err2 instanceof Error ? err2.message : String(err2))}`;
                    }
                }
                return `Error: ${err.message}`;
            }
            const lines = opened.content.split('\n');
            if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
            if (lines.length > 0 && lines[0].charCodeAt(0) === 0xFEFF) lines[0] = lines[0].slice(1);
            const sliced = lines.slice(0, n);
            return capShellOutput(sliced.map((l, i) => `${i + 1}\t${l}`).join('\n'));
        }
        // INTERNAL ONLY — not exposed in tools.json. Reached via read mode='tail'
        // child dispatch (see case 'read' above). Use read({ mode: 'tail', ... }).
        case 'tail': {
            const n = Math.max(1, Math.min(parseInt(args.n ?? 20, 10) || 20, 2000));
            // F9: share normalize/isSafePath/stat/similar-hint with wc/diff
            // via openForRead. ETOOBIG escapes to the large-file fallback
            // so behaviour is unchanged for files past READ_MAX_SIZE_BYTES.
            let opened;
            try { opened = await openForRead(args.path, workDir, readPathOpts); }
            catch (err) {
                if (err && err.code === 'ETOOBIG') {
                    try {
                        const { fullPath, st } = err;
                        // Large-file fallback: read only the trailing window. 200
                        // bytes/line is a rough average; the tail slice after split
                        // may be slightly > or < n lines — marked as (approx) so
                        // the caller knows line numbers are not from file start.
                        const tailBytes = Math.min(st.size, Math.max(n * 200, 4096));
                        const fd = openSync(fullPath, 'r');
                        const buf = Buffer.alloc(tailBytes);
                        try { readSync(fd, buf, 0, tailBytes, st.size - tailBytes); }
                        finally { closeSync(fd); }
                        const text = buf.toString('utf-8');
                        const tailLines = text.split('\n');
                        // First fragment is likely a partial line — drop it when
                        // we didn't start from byte 0 of the file.
                        if (tailBytes < st.size && tailLines.length > 1) tailLines.shift();
                        if (tailLines.length > 0 && tailLines[tailLines.length - 1] === '') tailLines.pop();
                        const sliced = tailLines.slice(-n);
                        // F10: cap large-window output so a multi-MB last-chunk
                        // doesn't blow past SHELL_OUTPUT_MAX_CHARS downstream.
                        return capShellOutput(sliced.map((l, i) => `(approx)${i + 1}\t${l}`).join('\n'));
                    } catch (err2) {
                        return `Error: ${normalizeErrorMessage(err2 instanceof Error ? err2.message : String(err2))}`;
                    }
                }
                return `Error: ${err.message}`;
            }
            const lines = opened.content.split('\n');
            // Trailing newline produces an empty element — drop it so
            // the reported line count matches what `wc -l` would show.
            if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
            const sliced = lines.slice(-n);
            const startIdx = lines.length - sliced.length;
            // F10: apply the same output cap used by shell/grep/find_files
            // so pathological single-line files (e.g. minified bundles)
            // don't dump 200 KB into the model context.
            return capShellOutput(sliced.map((l, i) => `${startIdx + i + 1}\t${l}`).join('\n'));
        }
        // INTERNAL ONLY — not exposed in tools.json. Reached via read mode='count'
        // child dispatch (see case 'read' above). Use read({ mode: 'count', ... }).
        case 'wc': {
            // F9: share normalize/isSafePath/stat/similar-hint with tail/diff
            // via openForRead. ETOOBIG escapes to the streaming fallback so
            // files past READ_MAX_SIZE_BYTES still report lines + bytes.
            let opened;
            try { opened = await openForRead(args.path, workDir, readPathOpts); }
            catch (err) {
                if (err && err.code === 'ETOOBIG') {
                    // F11: words are skipped for files past the cap because
                    // computing them needs the full content. The tool
                    // description advertises this limitation explicitly.
                    let lines = 0;
                    const stream = createReadStream(err.fullPath, { encoding: 'utf-8' });
                    const rl = createInterface({ input: stream, crlfDelay: Infinity });
                    for await (const _ of rl) lines++;
                    return `lines\t${lines}\twords\t-\tbytes\t${err.size}\t(words skipped: file > cap)`;
                }
                return `Error: ${err.message}`;
            }
            const { content, st } = opened;
            // Trailing newline should not inflate the line count — this
            // matches `wc -l` behaviour (final newline terminates, does
            // not begin, a new line).
            const lines = content.length === 0
                ? 0
                : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
            const words = (content.match(/\S+/g) || []).length;
            return `lines\t${lines}\twords\t${words}\tbytes\t${st.size}`;
        }
        default:
            return `Error: unknown builtin tool "${name}"`;
    }
}
/**
 * Check if a tool name is a builtin tool.
 */
export function isBuiltinTool(name) {
    return BUILTIN_TOOLS.some(t => t.name === name);
}

// Test-only exports for smart truncation helpers (see
// scripts/test-smart-truncation.mjs). Runtime callers inside this module
// use the local bindings unchanged; these named exports just make the
// same functions + constants reachable from the test harness.
export {
    computeUnifiedDiff,
    smartMiddleTruncate,
    smartReadTruncate,
    SMART_READ_MAX_BYTES,
    SMART_READ_MAX_LINES,
    SMART_READ_HEAD_LINES,
    SMART_READ_TAIL_LINES,
    SMART_BASH_MAX_LINES,
    SMART_BASH_MAX_BYTES,
    SMART_BASH_HEAD_LINES,
    SMART_BASH_TAIL_LINES,
};
