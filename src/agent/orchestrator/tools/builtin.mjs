import { exec, spawn, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, statSync, existsSync, createReadStream, readdirSync, mkdirSync, openSync, readSync, closeSync, renameSync, unlinkSync, realpathSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { readFile } from 'fs/promises';
import { createInterface } from 'readline';
import { promisify } from 'util';
import * as nodeUtil from 'node:util';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { getPluginData } from '../config.mjs';
import { markCodeGraphDirtyPaths } from './code-graph.mjs';
import { getCapabilities } from '../../../shared/config.mjs';
const execAsync = promisify(exec);

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

export async function atomicWrite(targetPath, content, { mode } = {}) {
    const dir = dirname(targetPath);
    const rnd = randomBytes(4).toString('hex');
    const tmp = join(dir, `.${basename(targetPath)}.mixdog-tmp-${rnd}`);
    // Preserve existing file mode on overwrite so we don't inadvertently
    // widen permissions via the default 0o644. Only applied when the
    // caller didn't pin an explicit mode.
    let effectiveMode = mode;
    if (effectiveMode === undefined) {
        try {
            const st = statSync(targetPath);
            effectiveMode = st.mode & 0o777;
        } catch { /* target doesn't exist — use default */ }
    }
    if (effectiveMode === undefined) effectiveMode = 0o644;

    // Open + write + fsync + close. Any failure here is caught and the
    // tempfile is unlinked before we rethrow so no residue remains.
    let fh = null;
    try {
        fh = await fsPromises.open(tmp, 'w', effectiveMode);
        if (typeof _atomicWriteOverride === 'function') {
            await _atomicWriteOverride(fh, content, tmp);
        } else {
            await fh.writeFile(content);
        }
        try { await fh.sync(); } catch { /* fsync can fail on some FS — proceed anyway, rename is still the durability gate */ }
    } catch (writeErr) {
        try { if (fh) await fh.close(); } catch { /* already closed */ }
        try { await fsPromises.unlink(tmp); } catch { /* already gone */ }
        throw writeErr;
    }
    try { await fh.close(); } catch { /* already closed */ }

    // Rename with Windows-specific retry. On POSIX `rename(2)` is atomic
    // within a filesystem and the retry loop is a no-op.
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
    // Rename failed — clean up the tempfile so no residue is left.
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
    const colonIdx = line.indexOf(':', searchFrom);
    if (colonIdx === -1) return line.replace(/\\/g, '/');
    return line.slice(0, colonIdx).replace(/\\/g, '/') + line.slice(colonIdx);
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
// this pass, read / multi_read error bodies surface backslash paths that
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
// ever sees. Larger raw outputs (seen in the wild: a 160k-token Grep result on
// 2026-04-19) blow the context budget and crater the server-side prompt
// cache, so the cap is the primary guard.
const SHELL_OUTPUT_MAX_CHARS = 30_000;

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

// Shared smart-truncate for file bodies (read / multi_read). Returns the
// original rendered text unchanged when the file is small. When the file is
// big AND the caller didn't pin a range, returns a head/tail framed summary
// plus a truncation flag so multi_read can annotate its per-file header.
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
    if (s.length <= SHELL_OUTPUT_MAX_CHARS) return s;
    const head = s.slice(0, SHELL_OUTPUT_MAX_CHARS);
    const tail = s.slice(SHELL_OUTPUT_MAX_CHARS);
    const remainingLines = (tail.match(/\n/g) || []).length + 1;
    return `${head}\n\n... [${remainingLines} lines truncated] ...`;
}
// Read tool caps. Two-stage protection mirrors Anthropic Claude Code's
// FileReadTool/limits.ts pattern: pre-stat byte cap throws ~100B error vs
// truncation that fills 25K tokens at the cap. Throw is decisively more
// token-efficient (Anthropic #21841 reverted truncation experiment).
const READ_MAX_SIZE_BYTES = 256 * 1024;
const READ_MAX_OUTPUT_BYTES = 100 * 1024;

// Binary detection: reading a PNG / ELF / zip / compressed blob as utf-8
// pollutes the context with U+FFFD characters and wastes tokens. Sample the
// first 4 KB and look for a null byte — the canonical signal that the file
// is not plain text. The sampling is synchronous (small) and only runs on
// files that have already passed the size cap and safe-path checks.
function isBinaryFile(fullPath, bytesToSample = 4096) {
    let fd = null;
    try {
        fd = openSync(fullPath, 'r');
        const buf = Buffer.alloc(Math.min(bytesToSample, 4096));
        const n = readSync(fd, buf, 0, buf.length, 0);
        if (n === 0) return false;
        for (let i = 0; i < n; i++) {
            if (buf[i] === 0) return true;
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
        rl.on('line', (line) => {
            if (lineIdx < offset) { lineIdx++; return; }
            if (collected.length >= limit) {
                rl.close();
                stream.destroy();
                return;
            }
            const rendered = `${lineIdx + 1}\t${line}`;
            collectedBytes += rendered.length + 1; // +1 for newline
            if (collectedBytes > READ_MAX_OUTPUT_BYTES) {
                truncated = true;
                rl.close();
                stream.destroy();
                return;
            }
            collected.push(rendered);
            lineIdx++;
        });
        rl.on('close', () => {
            let out = collected.join('\n');
            if (truncated) {
                out += `\n\n... [output truncated at ${Math.round(READ_MAX_OUTPUT_BYTES/1024)} KB] ...`;
            }
            resolve(out);
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
    if (!isSafePath(norm, workDir, { allowHome })) {
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
    if (isBinaryFile(fullPath)) {
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
// (read / edit / write / bash / grep / glob / multi_edit / multi_read /
// batch_edit) so build-tools-manifest reproduces the legacy ordering.
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
        description: 'Read file(s). PREFER ARRAY `path` to read multiple files in ONE call — serial reads waste turns and are the #1 iter waste. Use this AFTER you already have a concrete file candidate (`find_symbol`, `code_graph`, `grep`, `glob`, `list`). `mode`: full (default) | head | tail | count. head/tail read the first/last `n` lines; count returns line/word/byte stats. Files over the byte cap return a short error unless you use offset/limit, head, tail, count, or `grep`; moderately large default reads return a compact head+tail summary.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'File path, or array of paths for parallel read.' },
                mode: { type: 'string', enum: ['full', 'head', 'tail', 'count'], description: 'full (default) | head | tail | count.' },
                n: { type: 'number', description: 'Lines for head / tail mode. Default 20.' },
                offset: { type: 'number', description: 'Start line for full mode (0-based).' },
                limit: { type: 'number', description: 'Max lines for full mode (default 2000).' },
                full: { type: 'boolean', description: 'Opt out of the big-file head/tail cap. Default false.' },
            },
            required: ['path'],
        },
    },
    {
        name: 'multi_read',
        title: 'Multi Read',
        annotations: { title: 'Multi Read', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Read multiple files in ONE call. Use this when 2+ file paths are already known. Each entry supports the same options as `read` (`mode`, `n`, `offset`, `limit`, `full`) and runs in parallel.',
        inputSchema: {
            type: 'object',
            properties: {
                reads: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'File path.' },
                            mode: { type: 'string', enum: ['full', 'head', 'tail', 'count'], description: 'full (default) | head | tail | count.' },
                            n: { type: 'number', description: 'Lines for head / tail mode. Default 20.' },
                            offset: { type: 'number', description: 'Start line for full mode (0-based).' },
                            limit: { type: 'number', description: 'Max lines for full mode (default 2000).' },
                            full: { type: 'boolean', description: 'Opt out of the big-file head/tail cap. Default false.' },
                        },
                        required: ['path'],
                    },
                    minItems: 1,
                    description: 'List of file reads to execute in parallel.',
                },
            },
            required: ['reads'],
        },
    },
    {
        name: 'edit',
        title: 'Edit',
        annotations: { title: 'Edit', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Replace text in file(s). PREFER MULTI-EDIT FORM — pass `edits` array to batch N edits in one call; same file applies sequentially, different files run in parallel. Single form (`path` + `old_string` + `new_string`) is for a one-off only; serial single edits waste iters. `replace_all:true` drops the uniqueness check.',
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
                    description: 'Multi-edit form: array of edits. Each item may specify its own path; if omitted, falls back to the top-level `path`.',
                },
            },
            required: [],
        },
    },
    {
        name: 'multi_edit',
        title: 'Multi Edit',
        annotations: { title: 'Multi Edit', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Apply multiple ordered replacements to ONE file in one call. Use this when the file is already known and you need several edits without serial `edit` turns. All-or-nothing on that file.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Target file path.' },
                edits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            old_string: { type: 'string' },
                            new_string: { type: 'string' },
                            replace_all: { type: 'boolean' },
                        },
                        required: ['old_string', 'new_string'],
                    },
                    minItems: 1,
                    description: 'Ordered replacements for the same file.',
                },
            },
            required: ['path', 'edits'],
        },
    },
    {
        name: 'batch_edit',
        title: 'Batch Edit',
        annotations: { title: 'Batch Edit', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Apply edits across MULTIPLE files in one call. Different files run in parallel; repeated edits within the same file are grouped and executed as `multi_edit`. Use this instead of serial `edit` across several files.',
        inputSchema: {
            type: 'object',
            properties: {
                edits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Target file path.' },
                            old_string: { type: 'string' },
                            new_string: { type: 'string' },
                            replace_all: { type: 'boolean' },
                        },
                        required: ['path', 'old_string', 'new_string'],
                    },
                    minItems: 1,
                    description: 'Edits across one or more files.',
                },
            },
            required: ['edits'],
        },
    },
    {
        name: 'edit_lines',
        title: 'Edit Lines (line-number based)',
        annotations: { title: 'Edit Lines', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Replace lines [start_line, end_line] inclusive (1-based) with new_content. Use this when unique-string match in `edit` / `multi_edit` is awkward — large files, repeated substrings, or pure line-replace. Pair with `read` (note line numbers) -> `edit_lines`. mtime drift is enforced like `edit`: must `read` first; concurrent external writes return errorCode 7.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path. Supports `~` expansion.' },
                start_line: { type: 'number', description: 'First line to replace (1-based, inclusive).' },
                end_line: { type: 'number', description: 'Last line to replace (1-based, inclusive). Must be >= start_line.' },
                new_content: { type: 'string', description: 'Replacement content. Newlines inside are preserved. Set empty string to delete the range.' },
            },
            required: ['path', 'start_line', 'end_line', 'new_content'],
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
                    description: 'Batch whole-file writes. Each item writes one file. Use this when you need to create/replace several files in one call.',
                },
            },
            required: [],
        },
    },
    {
        name: 'write_many',
        title: 'Write Many',
        annotations: { title: 'Write Many', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Create or overwrite multiple files in one call. Use this for batch whole-file writes; prefer `apply_patch` for multi-file edits that depend on surrounding context.',
        inputSchema: {
            type: 'object',
            properties: {
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
                    description: 'Batch whole-file writes. Each item writes one file.',
                },
            },
            required: ['writes'],
        },
    },
    {
        name: 'bash',
        title: 'Bash',
        annotations: { title: 'Bash', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: 'Execute a shell command. DEFAULT = one-shot shell. BATCH RELATED COMMANDS with `&&` (stop on fail) or `;` (always run) in a single call — two separate bash turns for dependent work waste a round-trip. Only opt into persistent shell state when you truly need cwd/env/venv continuity: pass `persistent:true` (bridge sessions) or call `bash_session` directly. Set `run_in_background:true` for long builds/tests/servers, then inspect with `job_status` / `job_wait` / `job_read` / `jobs_list`. Destructive patterns (rm -rf /, force-push, format) are blocked.',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command.' },
                timeout: { type: 'number', description: 'ms, default 30000, max 600000.' },
                merge_stderr: { type: 'boolean', description: 'Merge stderr into stdout (legacy 2>&1 behaviour). Default false: stderr is surfaced as a separate `[stderr]` block.' },
                run_in_background: { type: 'boolean', description: 'Run command in the background and return a job id immediately. Use for long builds/tests/servers.' },
                persistent: { type: 'boolean', description: 'Bridge sessions only: opt into persistent shell state. When true, the bridge routes this `bash` call through `bash_session` and reuses the shell on later `persistent:true` calls.' },
                session_id: { type: 'string', description: 'Bridge sessions only: explicit persistent shell session id to reuse. Prefer `persistent:true` unless you need to target a specific shell.' },
            },
            required: ['command'],
        },
    },
    {
        name: 'jobs_list',
        title: 'List Background Jobs',
        annotations: { title: 'List Background Jobs', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'List recent background shell jobs with status, pid, and start time. Use this to discover job ids before `job_wait`, `job_status`, or `job_read`.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'job_status',
        title: 'Background Job Status',
        annotations: { title: 'Background Job Status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Get one snapshot for a background shell job: pid, command, output paths, and completion state. Do NOT poll this in a loop — prefer `job_wait` while the job is still running.',
        inputSchema: {
            type: 'object',
            properties: {
                job_id: { type: 'string', description: 'Background job id returned by bash with run_in_background:true.' },
            },
            required: ['job_id'],
        },
    },
    {
        name: 'job_wait',
        title: 'Wait For Background Job',
        annotations: { title: 'Wait For Background Job', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        description: 'Wait for a background shell job to finish and return its latest status/summary in one call. Prefer this over repeated job_status polling.',
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
        name: 'job_read',
        title: 'Read Background Job Output',
        annotations: { title: 'Read Background Job Output', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Read stdout/stderr from a background shell job using the same line-oriented behavior as read/tail. Prefer `job_wait` first; use `job_read` when you need the actual log text after completion or when the status summary is insufficient.',
        inputSchema: {
            type: 'object',
            properties: {
                job_id: { type: 'string', description: 'Background job id.' },
                stream: { type: 'string', enum: ['stdout', 'stderr'], description: 'Which stream to read. Default stdout.' },
                mode: { type: 'string', enum: ['full', 'head', 'tail', 'count'], description: 'Read mode. Default tail.' },
                n: { type: 'number', description: 'Lines for head/tail mode. Default 40.' },
                offset: { type: 'number', description: 'Start line for full mode (0-based).' },
                limit: { type: 'number', description: 'Max lines for full mode.' },
            },
            required: ['job_id'],
        },
    },
    {
        name: 'job_cancel',
        title: 'Cancel Background Job',
        annotations: { title: 'Cancel Background Job', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        description: 'Terminate a running background shell job.',
        inputSchema: {
            type: 'object',
            properties: {
                job_id: { type: 'string', description: 'Background job id.' },
            },
            required: ['job_id'],
        },
    },
    {
        name: 'grep',
        title: 'Grep',
        annotations: { title: 'Grep', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'ripgrep content search. PREFER ARRAY `pattern` and/or `glob` — OR-joined in ONE call instead of serial greps (biggest iter saver). For identifier/symbol lookup where you know the name but not the file, prefer `find_symbol` instead of grep. Use `grep` for content confirmation, broader text search, or regex. Output modes: `files_with_matches` (default), `content`, `count`. Use `multiline:true` for patterns spanning lines.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Regex pattern(s). String or array (OR-joined).' },
                path: { type: 'string', description: 'Search root. Default: cwd.' },
                glob: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Glob filter(s). String or array.' },
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
            },
            required: ['pattern'],
        },
    },
    {
        name: 'glob',
        title: 'Glob',
        annotations: { title: 'Glob', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'File path search via `rg --files`. PREFER ARRAY `pattern` — OR-joined multi-pattern search in ONE call instead of serial globs. Use `grep` for in-file content search.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Glob pattern(s).' },
                path: { type: 'string', description: 'Base dir. Default: cwd. Capped at 100.' },
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
        description: 'Directory inspection. `mode`: list (default, metadata rows: name/type/size/mtime) | tree (ASCII visualization) | find (filter by name/size/mtime). Use this for quick local shape checks (recent files, candidate directories, size/mtime clues). Use `find` mode to filter by filename pattern within a directory tree; for repository-wide filename pattern search use `glob` instead, and for in-file content search use `grep`. Use `find_symbol` for identifier lookup.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Root directory. Defaults to cwd. Supports `~` expansion.' },
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

    {
        name: 'diff',
        title: 'Unified Diff',
        annotations: { title: 'Unified Diff', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Unified diff between two files (or two raw strings). Useful for explaining a change before applying it via `edit` / `multi_edit`. Output is standard `--- from\n+++ to\n@@ ... @@` format. Pass `from_text:true` and/or `to_text:true` to treat the value as inline text instead of a path.',
        inputSchema: {
            type: 'object',
            properties: {
                from: { type: 'string', description: 'Path of the "before" file, or raw text when `from_text:true`.' },
                to: { type: 'string', description: 'Path of the "after" file, or raw text when `to_text:true`.' },
                from_text: { type: 'boolean', description: 'Treat `from` as inline text. Default false.' },
                to_text: { type: 'boolean', description: 'Treat `to` as inline text. Default false.' },
                context: { type: 'number', description: 'Context lines around hunks. Default 3, clamp [0, 10].' },
            },
            required: ['from', 'to'],
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
const RESULT_CACHE = new Map(); // key → { ts, value, paths, scopes }
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
function _cacheGet(key) {
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
    return entry.value;
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
export function recordReadSnapshotForPath(fullPath) {
    try {
        _recordReadSnapshot(fullPath);
    } catch { /* ignore snapshot failures */ }
}
export function clearReadSnapshotForPath(fullPath) {
    try { _readFiles.delete(fullPath); } catch { /* ignore */ }
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
// Value stores the mtime + size at read-time. Edit/multi_edit stat the
// file again and reject with error [code 7] when the current mtime has
// advanced — detects lint/formatter/external-write drift the way
// Anthropic's readFileState timestamp check does.
const _readFiles = new Map(); // fullPath → { mtimeMs, size }

function _recordReadSnapshot(fullPath, st) {
    try {
        if (st && typeof st.mtimeMs === 'number') {
            _readFiles.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size });
            return;
        }
        const fresh = statSync(fullPath);
        _readFiles.set(fullPath, { mtimeMs: fresh.mtimeMs, size: fresh.size });
    } catch {
        _readFiles.set(fullPath, { mtimeMs: Date.now(), size: 0 });
    }
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
function listShellJobDetails() {
    try {
        return readdirSync(getShellJobsDir())
            .filter((f) => f.endsWith('.json'))
            .map((f) => {
                try { return JSON.parse(readFileSync(join(getShellJobsDir(), f), 'utf-8')); }
                catch { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
    } catch {
        return [];
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
    if (detail.pid && !isPidAlive(detail.pid)) {
        detail.status = 'failed';
        detail.finishedAt = new Date().toISOString();
        detail.error = 'process exited without completion marker';
        writeShellJobDetail(detail);
    }
    return detail;
}
function startBackgroundShellJob({ command, timeoutMs, workDir, mergeStderr, spawnEnv, shell, shellArg }) {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const stdoutPath = shellJobStdoutPath(jobId);
    const stderrPath = shellJobStderrPath(jobId);
    const exitPath = shellJobExitPath(jobId);
    const donePath = shellJobDonePath(jobId);
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const wrapped = `{ ${command}; rc=$?; printf '%s' \"$rc\" > ${shellQuoteSingle(exitPath)}; touch ${shellQuoteSingle(donePath)}; exit $rc; }`;
    const child = spawn(shell, [shellArg, wrapped], {
        cwd: workDir,
        env: spawnEnv,
        detached: true,
        stdio: [
            'ignore',
            openSync(stdoutPath, 'a'),
            openSync(mergeStderr ? stdoutPath : stderrPath, 'a'),
        ],
        windowsHide: true,
    });
    child.unref();
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
    return detail;
}

// --- Blocked commands for safety ---
// Anchor for "command start": line start, after ; && || | (with optional whitespace)
const _CMD_START = '(?:^|[;&|\\n(){}]\\s*|\\$[\\({]\\s*|[<>]\\(\\s*|`\\s*)';
const BLOCKED_PATTERNS = [
    /\brm\s+-rf\s+[/~]/i,
    /\bgit\s+push\s+--force/i,
    /\bgit\s+reset\s+--hard/i,
    /\bformat\s+[a-z]:/i,
    /\b(shutdown|reboot|halt)\b/i,
    /\bdel\s+\/[sfq]/i,
    new RegExp(_CMD_START + 'mkfs(?:\\.|\\b)', 'i'),
    new RegExp(_CMD_START + 'dd\\s+[^\\n]*\\bif=/dev/', 'i'),
    new RegExp(_CMD_START + 'diskpart\\b[^\\n]*\\bclean\\b', 'i'),
    /:\(\)\s*\{[^}]*:\|:&[^}]*\};\s*:/, // bash fork-bomb signature (idempotent string)
];
const SHELL_MUTATION_PATTERN = /(?:^|[;&|\n]\s*)(?:touch|mkdir|mktemp|rm|rmdir|mv|cp|install|ln|chmod|chown|truncate|dd|sed\s+-i|perl\s+-pi|npm\s+(?:install|i|ci|uninstall)|pnpm\s+(?:install|i|add|remove|update|up)|yarn\s+(?:install|add|remove|up)|bun\s+(?:install|add|remove|update|up)|pip(?:3)?\s+install|python(?:3)?\s+-m\s+pip\s+install|git\s+(?:checkout|switch|restore|clean|apply|am|cherry-pick|merge|rebase|stash|pull|reset)|cargo\s+(?:build|install|clean)|go\s+(?:build|install|generate)|make|cmake)\b/i;
const SHELL_READ_ONLY_SEGMENT_RE = /^(?:cd|pwd|echo|printf|env|printenv|set|unset|export|alias|unalias|source|\.|type|which|whereis|ls|dir|cat|head|tail|wc|grep|rg|find|git\s+(?:status|diff|show|log|rev-parse|branch|remote|ls-files)|stat|readlink|realpath|basename|dirname|sort|uniq|cut|sed\s+-n|awk|ps|whoami|uname|date|true|false|test|\[)\b/i;
const SHELL_GLOBAL_MUTATORS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'python', 'python3', 'git', 'cargo', 'go', 'make', 'cmake', 'dd']);
export function isSafePath(filePath, cwd, { allowHome = false } = {}) {
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
    if (!isInside(normalized, baseCwd)) {
        // HOME fallback is now an explicit opt-in capability (B2). When
        // `allowHome=false` (the default), paths outside cwd are rejected
        // outright — no silent widening to $HOME. The main-agent path
        // gate passes `allowHome` from `capabilities.homeAccess`.
        if (!allowHome) return false;
        const home = process.env.HOME || process.env.USERPROFILE || '';
        if (home && isInside(normalized, normalize(home))) return true;
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
        if (real !== normalized && !isInside(real, baseCwd)) {
            if (!allowHome) return false;
            const home = process.env.HOME || process.env.USERPROFILE || '';
            if (home && isInside(real, normalize(home))) return true;
            return false;
        }
    } catch { /* path doesn't resolve — let caller fail naturally */ }
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
    if (!SHELL_MUTATION_PATTERN.test(text) && !/(^|[^0-9])>>?/.test(text) && !/\btee\b/.test(text)) {
        const readOnly = _shellSplitSegments(text).every((segment) => {
            const tokens = _stripShellAssignments(_shellTokenize(segment) || []);
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
        const tokens = _stripShellAssignments(parsed);
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
        if (SHELL_READ_ONLY_SEGMENT_RE.test(joined)) continue;
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

// --- Tool execution ---
export async function executeBuiltinTool(name, args, cwd) {
    const workDir = cwd || process.cwd();
    // B2 path policy: capability-gated HOME access. When
    // `capabilities.homeAccess` is false (default), all path-validation
    // helpers below reject any path outside `workDir`; when true, the
    // old HOME fallback is re-enabled. Read once per tool invocation so
    // config changes apply immediately on the next call without a
    // process restart.
    let allowHome = false;
    try { allowHome = getCapabilities().homeAccess === true; } catch { allowHome = false; }
    const pathOpts = { allowHome };
    switch (name) {
        case 'bash': {
            const command = args.command;
            if (!command)
                return 'Error: command is required';
            for (const pattern of BLOCKED_PATTERNS) {
                if (pattern.test(command)) {
                    return `Error: blocked command pattern — "${command}" matches safety rule`;
                }
            }
            const largeProbe = preflightShellLargeFileProbe(command, workDir);
            if (largeProbe) {
                return `Error: ${largeProbe.message}`;
            }
            const shellEffects = analyzeShellCommandEffects(command, workDir);
            const timeout = args.timeout || 30000;
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
                if (args.run_in_background === true) {
                    const job = startBackgroundShellJob({
                        command,
                        timeoutMs: timeout,
                        workDir,
                        mergeStderr,
                        spawnEnv,
                        shell,
                        shellArg,
                    });
                    return [
                        `[job: ${job.jobId}]`,
                        `[pid: ${job.pid}]`,
                        `[stdout: ${normalizeOutputPath(job.stdoutPath)}]`,
                        mergeStderr ? null : `[stderr: ${normalizeOutputPath(job.stderrPath)}]`,
                        '',
                        `Background job started for command: ${command}`,
                        `Use jobs_list / job_status / job_read / job_cancel to inspect it.`,
                    ].filter(Boolean).join('\n');
                }
                const result = spawnSync(shell, [shellArg, command], {
                    encoding: 'utf-8',
                    timeout,
                    // spawnSync's 1MB default maxBuffer throws ENOBUFS on
                    // large outputs (e.g. 200k-line dumps). capShellOutput
                    // slices to SHELL_OUTPUT_MAX_CHARS anyway, so we just
                    // need enough headroom for the raw capture. *4 keeps
                    // the buffer proportional to the cap; cross-OS uniform.
                    maxBuffer: SHELL_OUTPUT_MAX_CHARS * 4,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    cwd: workDir,
                    env: spawnEnv,
                    windowsHide: true,
                });
                if (result.error) return `Error: ${result.error.message}`;
                // Strip ANSI / VT control sequences before the model sees
                // them — progress bars, coloured diagnostics, cursor moves.
                const stdout = stripAnsi(result.stdout || '');
                const stderr = stripAnsi(result.stderr || '');
                // Exit code / signal surfacing. Non-zero status or a signal
                // kill (timeout -> SIGTERM) prepends a marker line so the
                // agent never has to guess at a silent failure. Zero exit
                // + no signal stays quiet to avoid noise on the success path.
                const signal = result.signal ? String(result.signal) : null;
                const exitCode = signal ? null : result.status;
                const statusMarker = signal
                    ? `[signal: ${signal}]`
                    : (exitCode !== 0 && exitCode !== null ? `[exit code: ${exitCode}]` : '');
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
                const payload = `${body}${stderrBlock}`;
                if (statusMarker) return `${statusMarker}\n\n${payload}`;
                return payload;
            }
            finally {
                if (shellEffects.mutationMode === 'paths') {
                    invalidateBuiltinResultCache(shellEffects.paths);
                    markCodeGraphDirtyPaths(workDir, shellEffects.paths);
                } else if (shellEffects.mutationMode === 'global') invalidateBuiltinResultCache();
            }
        }
        case 'jobs_list': {
            const jobs = listShellJobDetails().map((detail) => attachJobInsights(refreshShellJob(detail.jobId) || detail));
            if (jobs.length === 0) return '(no background jobs)';
            return jobs.map((job) =>
                `${job.jobId}\t${job.status}\tpid=${job.pid ?? '-'}\t${job.startedAt || '-'}\t${job.command || ''}${job.summary ? `\t${job.summary}` : ''}`
            ).join('\n');
        }
        case 'job_status': {
            const jobId = typeof args.job_id === 'string' ? args.job_id : '';
            if (!jobId) return 'Error: job_id is required';
            const job = refreshShellJob(jobId);
            if (!job) return `Error: job not found: ${jobId}`;
            return JSON.stringify(attachJobInsights(job), null, 2);
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
        case 'job_read': {
            const jobId = typeof args.job_id === 'string' ? args.job_id : '';
            if (!jobId) return 'Error: job_id is required';
            const job = refreshShellJob(jobId);
            if (!job) return `Error: job not found: ${jobId}`;
            const stream = args.stream === 'stderr' ? 'stderr' : 'stdout';
            const path = stream === 'stderr' ? job.stderrPath : job.stdoutPath;
            if (!path) return `Error: ${stream} path missing for job ${jobId}`;
            const mode = args.mode || 'tail';
            const jobCwd = getPluginData();
            if (mode === 'head') return executeBuiltinTool('head', { path, n: args.n || 40 }, jobCwd);
            if (mode === 'count') return executeBuiltinTool('wc', { path }, jobCwd);
            if (mode === 'full') {
                return executeBuiltinTool('read', {
                    path,
                    offset: typeof args.offset === 'number' ? args.offset : 0,
                    limit: typeof args.limit === 'number' ? args.limit : 2000,
                }, jobCwd);
            }
            return executeBuiltinTool('tail', { path, n: args.n || 40 }, jobCwd);
        }
        case 'job_cancel': {
            const jobId = typeof args.job_id === 'string' ? args.job_id : '';
            if (!jobId) return 'Error: job_id is required';
            const job = refreshShellJob(jobId);
            if (!job) return `Error: job not found: ${jobId}`;
            if (job.status !== 'running') return `Job ${jobId} already ${job.status}`;
            if (!job.pid || !isPidAlive(job.pid)) {
                job.status = 'failed';
                job.finishedAt = new Date().toISOString();
                job.error = 'process not running';
                writeShellJobDetail(job);
                return `Job ${jobId} is no longer running`;
            }
            try {
                process.kill(job.pid, 'SIGTERM');
            } catch (err) {
                return `Error: failed to cancel ${jobId}: ${err?.message || String(err)}`;
            }
            job.status = 'cancelled';
            job.finishedAt = new Date().toISOString();
            writeShellJobDetail(job);
            return `Cancelled job ${jobId}`;
        }
        case 'read': {
            // Unified-read dispatch (v0.6.283+):
            //   path: string[]              → multi_read (parallel per-file)
            //   mode: 'head'|'tail'|'count' → head / tail / wc handlers
            //   else                        → single-file read below.
            // Single turn can touch many files or swap modes without
            // the agent iterating across multiple tool names.
            if (Array.isArray(args.path)) {
                // Propagate per-call options (mode / n / offset / limit / full)
                // to each per-file entry so schema-advertised options don't get
                // silently dropped when path is an array.
                const reads = args.path.map((p) => {
                    if (p && typeof p === 'object') return p;
                    const entry = { path: p };
                    if (args.mode !== undefined) entry.mode = args.mode;
                    if (args.n !== undefined) entry.n = args.n;
                    if (args.offset !== undefined) entry.offset = args.offset;
                    if (args.limit !== undefined) entry.limit = args.limit;
                    if (args.full !== undefined) entry.full = args.full;
                    return entry;
                });
                return executeBuiltinTool('multi_read', { reads }, workDir);
            }
            if (args.mode === 'head') return executeBuiltinTool('head', { path: args.path, n: args.n }, workDir);
            if (args.mode === 'tail') return executeBuiltinTool('tail', { path: args.path, n: args.n }, workDir);
            if (args.mode === 'count') return executeBuiltinTool('wc', { path: args.path }, workDir);
            args.path = normalizeInputPath(args.path);
            const filePath = args.path;
            if (!filePath)
                return 'Error: path is required';
            if (!isSafePath(filePath, workDir, pathOpts))
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
            const offset = typeof args.offset === 'number' ? args.offset : 0;
            const limit = typeof args.limit === 'number' ? args.limit : 2000;
            const hasRangeArgs = typeof args.offset === 'number' || typeof args.limit === 'number';
            let st;
            try {
                st = statSync(fullPath);
            } catch (err) {
                const similar = findSimilarFile(fullPath);
                const hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}${hint}`;
            }
            const wantFull = args.full === true;
            const cacheKey = `read|${fullPath}|${st.mtimeMs}|${st.size}|${typeof args.offset === 'number' ? args.offset : 'd'}|${typeof args.limit === 'number' ? args.limit : 'd'}|${wantFull ? 'f' : 's'}`;
            const cached = _cacheGet(cacheKey);
            if (cached !== null) return cached;
            if (st.size > READ_MAX_SIZE_BYTES) {
                if (!hasRangeArgs) {
                    return `Error: file size ${st.size} bytes exceeds ${READ_MAX_SIZE_BYTES}-byte cap. Use offset+limit to read a range.`;
                }
                if (isBinaryFile(fullPath)) {
                    return `Error: file appears to be binary (contains null bytes): ${normalizeOutputPath(filePath)}`;
                }
                try {
                    const out = await streamReadRange(fullPath, offset, limit);
                    _cacheSet(cacheKey, out, { paths: [fullPath] });
                    _recordReadSnapshot(fullPath, st);
                    return out;
                } catch (err) {
                    return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
                }
            }
            if (isBinaryFile(fullPath)) {
                return `Error: file appears to be binary (contains null bytes): ${normalizeOutputPath(filePath)}`;
            }
            try {
                const content = await readFile(fullPath, 'utf-8');
                const lines = content.split('\n');
                const sliced = lines.slice(offset, offset + limit);
                const rendered = sliced.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
                // Output byte cap protects against many-line slices that
                // individually pass the file-size check but explode after
                // line-number prefixing.
                let out;
                if (rendered.length > READ_MAX_OUTPUT_BYTES) {
                    out = rendered.slice(0, READ_MAX_OUTPUT_BYTES) + `\n\n... [output truncated at ${Math.round(READ_MAX_OUTPUT_BYTES/1024)} KB] ...`;
                } else {
                    out = rendered;
                }
                // v0.6.231 smart cap. Only engages when the caller asked for
                // the default read (no offset/limit, full:false) AND the file
                // is over the line/byte threshold. Explicit ranges always see
                // byte-exact output.
                if (!hasRangeArgs && !wantFull) {
                    const { text } = smartReadTruncate(out, lines.length, st.size);
                    out = text;
                }
                _cacheSet(cacheKey, out, { paths: [fullPath] });
                _recordReadSnapshot(fullPath, st);
                return out;
            }
            catch (err) {
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
            }
        }
        case 'multi_read': {
            const reads = Array.isArray(args.reads) ? args.reads : [];
            for (const r of reads) { if (r && typeof r === 'object') r.path = normalizeInputPath(r.path); }
            if (reads.length === 0) return 'Error: reads array is required';
            // Parallel dispatch of the individual reads via the same case
            // above — reuses size cap, isSafePath, line-number formatting.
            // Per-file errors come back as their own string and are pasted
            // into the aggregate rather than aborting the whole batch.
            const results = await Promise.all(reads.map(async (entry) => {
                if (!entry || !entry.path) return { path: '(missing-path)', body: 'Error: path is required' };
                const body = await executeBuiltinTool('read', entry, workDir);
                return { path: entry.path, body };
            }));
            // Header path → forward slash; error bodies already normalised
            // inside the read case's catch blocks. When `read` emitted a
            // smart-cap marker, surface the truncation state in the header
            // so downstream skimming spots it without parsing the body.
            return results.map(r => {
                const match = /\[TRUNCATED — file is (\d+) lines \/ (\d+) KB\./.exec(r.body || '');
                const suffix = match ? ` (truncated, ${match[1]} total lines / ${match[2]} KB — pass full:true or offset/limit for more)` : '';
                return `### ${normalizeOutputPath(r.path)}${suffix}\n${r.body}`;
            }).join('\n\n');
        }
        case 'write_many': {
            return executeBuiltinTool('write', { writes: args.writes }, workDir);
        }
        case 'multi_edit': {
            // Claude Code native MultiEdit semantics: one file, many ordered
            // replacements, all-or-nothing. We apply the chain in memory
            // first — any failure aborts before the file is written so the
            // tree never lands in a half-edited state.
            args.path = normalizeInputPath(args.path);
            const filePath = args.path;
            const edits = Array.isArray(args.edits) ? args.edits : [];
            if (!filePath) return 'Error: path is required';
            if (edits.length === 0) return 'Error: edits array is required';
            if (!isSafePath(filePath, workDir, pathOpts)) return `Error: path outside allowed scope — ${normalizeOutputPath(filePath)}`;
            const fullPath = resolveAgainstCwd(filePath, workDir);
            // F2 fix: one stat syscall covers both existence check and mtime
            // read. existsSync + statSync was a TOCTOU window where the file
            // could vanish between probes; ENOENT from statSync now produces
            // the same file-not-found hint the existsSync branch used to.
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
            const mEditSnapshot = _readFiles.get(fullPath);
            if (!mEditSnapshot) {
                return `Error [code 6]: file has not been read yet — read before editing: ${filePath}`;
            }
            if (mEditStat.mtimeMs > mEditSnapshot.mtimeMs + 1) {
                return `Error [code 7]: file modified since read (lint / formatter / external write) — read it again before editing: ${filePath}`;
            }
            try {
                let content;
                try { content = readFileSync(fullPath, 'utf-8'); }
                catch (err) { return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`; }
                for (let i = 0; i < edits.length; i++) {
                    const entry = edits[i];
                    if (!entry || typeof entry.old_string !== 'string' || typeof entry.new_string !== 'string') {
                        return `Error: edit ${i} must have old_string and new_string`;
                    }
                    const { old_string, new_string, replace_all } = entry;
                    if (replace_all === true) {
                        if (!content.includes(old_string)) {
                            return `Error [code 8]: edit ${i} — old_string not found in ${filePath}`;
                        }
                        content = content.split(old_string).join(new_string);
                    } else {
                        const count = content.split(old_string).length - 1;
                        if (count === 0) return `Error [code 8]: edit ${i} — old_string not found in ${filePath}`;
                        if (count > 1) return `Error [code 9]: edit ${i} — old_string found ${count} times in ${filePath}; set replace_all:true or provide more unique context`;
                        // B35 fix: String.prototype.replace(str, str) interprets
                        // substitution patterns (dollar-ampersand, dollar-digit,
                        // double-dollar, etc.) in the second arg and splices the
                        // matched text / capture groups / literal dollar into the
                        // result. Corrupts any new_string that legitimately contains
                        // such sequences (e.g. regex escape code in source). The
                        // function form opts out of substitution entirely.
                        content = content.replace(old_string, () => new_string);
                    }
                }
                // v0.6.248: atomic write — tempfile + fsync + rename.
                // Serial edits all land in `content`; a single atomicWrite
                // publishes the final state.
                await atomicWrite(fullPath, content);
                invalidateBuiltinResultCache([fullPath]);
                markCodeGraphDirtyPaths(workDir, [fullPath]);
                _recordReadSnapshot(fullPath);
                return `Edited: ${normalizeOutputPath(filePath)} (${edits.length} replacements applied)`;
            } catch (err) {
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
            }
        }
        case 'batch_edit': {
            const edits = Array.isArray(args.edits) ? args.edits : [];
            if (edits.length === 0) return 'Error: edits array is required';
            for (const e of edits) { if (e && typeof e === 'object') e.path = normalizeInputPath(e.path); }
            // Fan-out: group edits by path so different files run in parallel
            // (Promise.all) while same-file edits stay sequential (via
            // multi_edit) to avoid concurrent writes on the same target.
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
                return colonIdx !== -1 ? first.slice(colonIdx + 2) : first;
            };
            const groupResults = await Promise.all([...groups.entries()].map(async ([path, items]) => {
                if (items.length === 1) {
                    const body = await executeBuiltinTool('edit', items[0], workDir);
                    const errMsg = parseLeadError(body);
                    return errMsg
                        ? `FAIL ${normalizeOutputPath(path)}: ${errMsg}`
                        : `OK ${normalizeOutputPath(path)}`;
                }
                const body = await executeBuiltinTool('multi_edit', {
                    path,
                    edits: items.map(({ path: _p, ...rest }) => rest),
                }, workDir);
                const errMsg = parseLeadError(body);
                return errMsg
                    ? `FAIL ${normalizeOutputPath(path)}: ${errMsg}`
                    : `OK ${normalizeOutputPath(path)} (${items.length})`;
            }));
            const missingLines = missingPath.map(() => 'FAIL (missing-path): path is required');
            return [...groupResults, ...missingLines].join('\n');
        }
        case 'write': {
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
                    try {
                        const fullPath = resolveAgainstCwd(filePath, workDir);
                        mkdirSync(dirname(fullPath), { recursive: true });
                        await atomicWrite(fullPath, content);
                        dirtyPaths.push(fullPath);
                        _recordReadSnapshot(fullPath);
                        results.push(`OK ${normalizeOutputPath(filePath)}`);
                    }
                    catch (err) {
                        results.push(`FAIL ${normalizeOutputPath(filePath)}: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`);
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
            try {
                const fullPath = resolveAgainstCwd(filePath, workDir);
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
                await atomicWrite(fullPath, content);
                invalidateBuiltinResultCache([fullPath]);
                markCodeGraphDirtyPaths(workDir, [fullPath]);
                // Write establishes the on-disk state the model just
                // authored, so a subsequent Edit does not need a fresh
                // Read round-trip.
                _recordReadSnapshot(fullPath);
                return `Written: ${normalizeOutputPath(filePath)}`;
            }
            catch (err) {
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
            }
        }
        case 'edit': {
            // Unified-edit dispatch (v0.6.283+):
            //   edits array present → multi_edit (single file) or batch_edit
            //     (multiple files), inferred from per-item path homogeneity.
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
                    return executeBuiltinTool('multi_edit', {
                        path: onePath,
                        edits: items.map(({ path: _p, ...rest }) => rest),
                    }, workDir);
                }
                return executeBuiltinTool('batch_edit', {
                    edits: items.map((x) => ({
                        path: x.path, old_string: x.old_string, new_string: x.new_string, replace_all: x.replace_all,
                    })),
                }, workDir);
            }
            args.path = normalizeInputPath(args.path);
            const filePath = args.path;
            const oldStr = args.old_string;
            const newStr = args.new_string;
            const replaceAll = args.replace_all === true;
            if (!filePath || !oldStr)
                return 'Error: path and old_string are required';
            if (!isSafePath(filePath, workDir, pathOpts))
                return `Error: path outside allowed scope — ${normalizeOutputPath(filePath)}`;
            const fullPath = resolveAgainstCwd(filePath, workDir);
            // F2 fix: single stat syscall replaces existsSync + statSync pair.
            // ENOENT -> Error [code 4] with similar-file hint; mtime drift ->
            // Error [code 7]. Collapsing the two probes also closes the TOCTOU
            // window where the file could be deleted between checks.
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
            // Error [code 6]: Read-before-Edit enforcement. Prevents phantom
            // edits where the model invents an old_string based on cached
            // assumptions against a file that has drifted.
            const editSnapshot = _readFiles.get(fullPath);
            if (!editSnapshot) {
                return `Error [code 6]: file has not been read yet — read before editing: ${filePath}`;
            }
            // Error [code 7]: detect stale read via mtime drift (Anthropic
            // readFileState timestamp check parity). +1ms slack absorbs
            // filesystem timestamp resolution noise on NTFS/exFAT.
            if (editStat.mtimeMs > editSnapshot.mtimeMs + 1) {
                return `Error [code 7]: file modified since read (lint / formatter / external write) — read it again before editing: ${filePath}`;
            }
            try {
                const content = readFileSync(fullPath, 'utf-8');
                const count = content.split(oldStr).length - 1;
                if (count === 0)
                    return `Error [code 8]: old_string not found in ${filePath}`;
                if (count > 1 && !replaceAll)
                    return `Error [code 9]: old_string found ${count} times — set replace_all:true or provide more unique context`;
                const updated = replaceAll
                    ? content.split(oldStr).join(newStr)
                    : content.replace(oldStr, () => newStr);
                // v0.6.248: atomic write — see `write` handler for rationale.
                await atomicWrite(fullPath, updated);
                invalidateBuiltinResultCache([fullPath]);
                markCodeGraphDirtyPaths(workDir, [fullPath]);
                // Refresh the snapshot to the post-write mtime so a chain
                // of edits against the same file doesn't trip the stale
                // check on the second hop.
                _recordReadSnapshot(fullPath);
                return `Edited: ${normalizeOutputPath(filePath)}`;
            }
            catch (err) {
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
            }
        }
        case 'edit_lines': {
            // v0.6.223: line-number based replacement. Complement to `edit` /
            // `multi_edit` for cases where unique-substring match is awkward
            // (large files, repeated lines, or pure line-replace). Shares the
            // same Read-before-Edit + mtime-drift contract as `edit`.
            args.path = normalizeInputPath(args.path);
            const filePath = args.path;
            const startLine = parseInt(args.start_line, 10);
            const endLine = parseInt(args.end_line, 10);
            const newContent = String(args.new_content ?? '');
            if (!filePath) return 'Error: path is required';
            if (!Number.isFinite(startLine) || startLine < 1) return 'Error: start_line must be >= 1';
            if (!Number.isFinite(endLine) || endLine < startLine) return 'Error: end_line must be >= start_line';
            if (!isSafePath(filePath, workDir, pathOpts))
                return `Error: path outside allowed scope — ${normalizeOutputPath(filePath)}`;
            const fullPath = resolveAgainstCwd(filePath, workDir);
            let elStat;
            try { elStat = statSync(fullPath); }
            catch (err) {
                if (err && err.code === 'ENOENT') {
                    const similar = findSimilarFile(fullPath);
                    const hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
                    return `Error [code 4]: file not found: ${filePath}${hint}`;
                }
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
            }
            const elSnapshot = _readFiles.get(fullPath);
            if (!elSnapshot) {
                return `Error [code 6]: file has not been read yet — read before editing: ${filePath}`;
            }
            if (elStat.mtimeMs > elSnapshot.mtimeMs + 1) {
                return `Error [code 7]: file modified since read (lint / formatter / external write) — read it again before editing: ${filePath}`;
            }
            try {
                const content = readFileSync(fullPath, 'utf-8');
                const lines = content.split('\n');
                const totalLines = lines.length;
                if (startLine > totalLines) return `Error: start_line ${startLine} exceeds file's ${totalLines} lines`;
                if (endLine > totalLines) return `Error: end_line ${endLine} exceeds file's ${totalLines} lines`;
                // Pure split/join — no String.prototype.replace second-arg
                // substitution pattern risk (B35). new_content is spliced
                // verbatim.
                const newLines = newContent === '' ? [] : newContent.split('\n');
                const updated = [
                    ...lines.slice(0, startLine - 1),
                    ...newLines,
                    ...lines.slice(endLine),
                ];
                const newFileContent = updated.join('\n');
                // v0.6.248: atomic write — tempfile + fsync + rename.
                await atomicWrite(fullPath, newFileContent);
                invalidateBuiltinResultCache([fullPath]);
                markCodeGraphDirtyPaths(workDir, [fullPath]);
                _recordReadSnapshot(fullPath);
                const replacedCount = endLine - startLine + 1;
                const insertedCount = newLines.length;
                return `Edited: ${normalizeOutputPath(filePath)} (lines ${startLine}-${endLine} replaced, ${replacedCount} -> ${insertedCount} lines)`;
            }
            catch (err) {
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
            }
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
            const globPatterns = (Array.isArray(rawGlob)
                ? rawGlob.filter(g => typeof g === 'string' && g)
                : (rawGlob ? [String(rawGlob)] : [])).map(normalizeInputPath);
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
                const lines = headLimit === Infinity ? windowed : windowed.slice(0, headLimit);
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
                } catch {
                    // rg exits 1 on no matches; best-effort ignore
                }
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
                catch { return { path: p, mtime: 0 }; }
            });
            withStat.sort((a, b) => b.mtime - a.mtime);
            const windowed = offset > 0 ? withStat.slice(offset) : withStat;
            const capped = (headLimit === Infinity ? windowed : windowed.slice(0, headLimit)).map((entry) => {
                // Relativise against workDir when the file lives inside it
                // — matches Anthropic GlobTool toRelativePath and trims the
                // redundant absolute prefix from the model's context.
                const displayed = cwdRelativePath(entry.full || entry.path, workDir);
                return normalizeOutputPath(displayed);
            });
            const remaining = windowed.length - capped.length;
            const out = capShellOutput((capped.join('\n') + (remaining > 0 ? `\n... [${remaining} more entries]` : '')) || '(no files found)');
            _cacheSet(cacheKey, out, { scopes: [...groups.keys()].map((root) => resolveAgainstCwd(root, workDir)) });
            return out;
        }
        case 'list': {
            // Unified-list dispatch (v0.6.283+):
            //   mode:'tree'  → tree handler (ASCII visualization)
            //   mode:'find'  → find_files handler (name/size/mtime filter)
            //   default      → list below (metadata rows).
            if (args.mode === 'tree') return executeBuiltinTool('tree', args, workDir);
            if (args.mode === 'find') return executeBuiltinTool('find_files', args, workDir);
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
                        path: cwdRelativePath(entPath, workDir),
                        type: entType,
                        size,
                        mtimeMs,
                        fullPath: entPath,
                    });
                    if (gatherLimit > 0 && rows.length >= gatherLimit) return false;
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
            const lines = [`${normalizeOutputPath(basename(fullPath))}/`];
            // F5: share walkDir with list / find_files. Prefix state lives in
            // a stack keyed by depth — walkDir exposes {depth, index, total,
            // isLast} via ctx so branch drawing works without an own walk.
            const prefixStack = [''];
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
                    const display = ent.isDirectory() ? `${ent.name}/` : ent.name;
                    lines.push(`${prefix}${branch}${display}`);
                    if (ent.isDirectory()) {
                        prefixStack[ctx.depth] = prefix + (ctx.isLast ? '    ' : '│   ');
                    }
                    const gatherLimit = headLimit > 0 ? offset + headLimit + 1 : 0;
                    if (gatherLimit > 0 && lines.length >= gatherLimit) return false;
                },
            });
            const root = lines[0];
            const body = lines.slice(1);
            const windowed = offset > 0 ? body.slice(offset) : body;
            const sliced = headLimit > 0 ? windowed.slice(0, headLimit) : windowed;
            const outLines = [root, ...sliced];
            if (windowed.length > sliced.length) outLines.push('... (truncated, increase head_limit)');
            const out = outLines.join('\n');
            _cacheSet(cacheKey, out, { scopes: [fullPath] });
            return out;
        }
        case 'find_files': {
            args.path = normalizeInputPath(args.path);
            const inputPath = args.path || '.';
            const namePattern = typeof args.name === 'string' ? args.name : null;
            const typeFilter = ['any', 'file', 'dir'].includes(args.type) ? args.type : 'any';
            const minSize = typeof args.min_size === 'number' ? args.min_size : null;
            const maxSize = typeof args.max_size === 'number' ? args.max_size : null;
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
            // F5: walkDir handles dotfile skip + recursion. Returning false
            // stops the walk as soon as headLimit is satisfied (F1 fix).
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
                    matches.push({ path: cwdRelativePath(entPath, workDir), size: stat.size, mtimeMs: stat.mtimeMs });
                    const gatherLimit = headLimit > 0 ? offset + headLimit : 0;
                    if (gatherLimit > 0 && matches.length >= gatherLimit) return false;
                },
            });

            matches.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
            const windowed = offset > 0 ? matches.slice(offset) : matches;
            const sliced = headLimit > 0 ? windowed.slice(0, headLimit) : windowed;
            const lines = sliced.map(m =>
                `${normalizeOutputPath(m.path)}\t${m.size}\t${formatMtime(m.mtimeMs)}`);
            if (windowed.length > sliced.length) lines.push(`... ${windowed.length - sliced.length} more entries`);
            const out = lines.join('\n') || '(no matches)';
            _cacheSet(cacheKey, out, { scopes: [fullPath] });
            return out;
        }
        case 'head': {
            // Thin wrapper around `read` with offset:0+limit:n. Keeps all
            // caching, safe-path, and size-cap semantics in one place.
            const n = Math.max(1, Math.min(parseInt(args.n ?? 20, 10) || 20, 2000));
            return executeBuiltinTool('read', { path: args.path, offset: 0, limit: n }, workDir);
        }
        case 'tail': {
            const n = Math.max(1, Math.min(parseInt(args.n ?? 20, 10) || 20, 2000));
            // F9: share normalize/isSafePath/stat/similar-hint with wc/diff
            // via openForRead. ETOOBIG escapes to the large-file fallback
            // so behaviour is unchanged for files past READ_MAX_SIZE_BYTES.
            let opened;
            try { opened = await openForRead(args.path, workDir, pathOpts); }
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
        case 'wc': {
            // F9: share normalize/isSafePath/stat/similar-hint with tail/diff
            // via openForRead. ETOOBIG escapes to the streaming fallback so
            // files past READ_MAX_SIZE_BYTES still report lines + bytes.
            let opened;
            try { opened = await openForRead(args.path, workDir, pathOpts); }
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
        case 'diff': {
            let fromContent, toContent;
            let fromLabel = args.from_text ? '(text)' : String(args.from ?? '');
            let toLabel = args.to_text ? '(text)' : String(args.to ?? '');
            // F12: route file-mode reads through openForRead so diff
            // inherits the same size-cap (ETOOBIG), safe-path, and
            // similar-file hint behaviour as read/tail/wc. Previously the
            // raw readFile call sidestepped all three and would happily
            // slurp a multi-MB file into memory with no hint on typos.
            try {
                if (args.from_text) {
                    fromContent = String(args.from ?? '');
                    const bytes = Buffer.byteLength(fromContent, 'utf-8');
                    if (bytes > READ_MAX_SIZE_BYTES) {
                        return `Error: from inline text ${bytes} bytes exceeds ${READ_MAX_SIZE_BYTES}-byte cap`;
                    }
                } else {
                    if (args.from == null || args.from === '') return 'Error: from is required';
                    const opened = await openForRead(args.from, workDir, pathOpts);
                    fromContent = opened.content;
                    fromLabel = opened.displayPath;
                }
                if (args.to_text) {
                    toContent = String(args.to ?? '');
                    const bytes = Buffer.byteLength(toContent, 'utf-8');
                    if (bytes > READ_MAX_SIZE_BYTES) {
                        return `Error: to inline text ${bytes} bytes exceeds ${READ_MAX_SIZE_BYTES}-byte cap`;
                    }
                } else {
                    if (args.to == null || args.to === '') return 'Error: to is required';
                    const opened = await openForRead(args.to, workDir, pathOpts);
                    toContent = opened.content;
                    toLabel = opened.displayPath;
                }
            } catch (err) {
                // err.message is already normalized/hinted by openForRead —
                // no String.replace with substitution-capable strings (B35).
                return `Error: ${err.message}`;
            }
            const rawCtx = parseInt(args.context ?? 3, 10);
            const context = Math.max(0, Math.min(Number.isFinite(rawCtx) ? rawCtx : 3, 10));
            // Drop the trailing empty entry split produces for newline-terminated files.
            const splitLines = (s) => {
                const parts = s.split('\n');
                if (parts.length > 0 && parts[parts.length - 1] === '' && s.endsWith('\n')) parts.pop();
                return parts;
            };
            const fromLines = splitLines(fromContent);
            const toLines = splitLines(toContent);
            const out = computeUnifiedDiff(fromLines, toLines, context, fromLabel, toLabel);
            return out || '(no differences)';
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
