// bash_session — persistent shell with state preserved across calls.
//
// Companion to the stateless `bash` tool. The default `bash` spawns a fresh
// subshell every call: cwd, exports, `source`d virtualenvs, shell functions
// all vanish between invocations. That's the safe default but it's clumsy
// for the common "cd into a project → activate venv → run three commands"
// workflow; each step has to reconstruct the prior shell context by hand.
//
// bash_session keeps a long-lived `bash` child process per session_id. The
// caller writes commands to stdin; we frame each command with a sentinel
// so we know when the command has finished and what its exit code was.
// State carried automatically: $PWD, exports, shell vars, readline history
// (not that we use it), aliases, function defs, `source`d files.
//
// Session lifecycle:
//   - session_id omitted         → mint a fresh id, spawn child, run command
//   - session_id matches pool    → reuse existing child
//   - session_id misses pool     → mint THAT id (stable resume semantics)
//   - close:true                 → terminate child after command returns
//   - idle > IDLE_TIMEOUT_MS     → reaper removes & kills the child
//   - pool > MAX_SESSIONS        → oldest-idle evicted at spawn time
//
// Output protocol:
//   write:  <command>\necho "__MIXDOG_END__:$?"\n
//   read:   everything on stdout up to (not including) the marker line
//   exit:   the N in __MIXDOG_END__:N
//   stderr: captured in parallel; sentinel not echoed there, so we flush
//           whatever arrived up to the command's completion. Small
//           quiescence window (STDERR_DRAIN_MS) after the stdout marker
//           so trailing writes on stderr don't get cut off.
//
// Safety: same BLOCKED_PATTERNS as the `bash` tool. The session holds state
// so a dangerous command can't hide in an earlier turn (we scan per call).
// Same ANSI strip + smart middle-truncate applied to stdout/stderr.
//
// Not guarded by isSafePath: this tool takes a command, not a file path.

import { spawn } from 'node:child_process';
import * as nodeUtil from 'node:util';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { invalidateBuiltinResultCache, analyzeShellCommandEffects, preflightShellLargeFileProbe } from './builtin.mjs';
import { markCodeGraphDirtyPaths } from './code-graph.mjs';

// CC parity: default 120 s, max 1800 s (matches the foreground `bash`
// tool in builtin.mjs). 30 s default left interactive build/test workflows
// timing out; the persistent shell carries longer-running pipelines than
// one-shot calls, so a generous max is appropriate.
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 1_800_000;
const IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_SESSIONS = 10;
const STDERR_DRAIN_MS = 25;
// Shared cap with the `bash` tool (SHELL_OUTPUT_MAX_CHARS). Duplicated here
// so bash-session stays decoupled from builtin.mjs's private constants.
const SHELL_OUTPUT_MAX_CHARS = 30_000;
const SMART_BASH_MAX_LINES = 400;
const SMART_BASH_MAX_BYTES = 30 * 1024;
const SMART_BASH_HEAD_LINES = 80;
const SMART_BASH_TAIL_LINES = 80;

// Marker prefix for per-command sentinels. A random suffix is added on each
// command so user output that happens to contain the static prefix does not
// terminate the command early.
const MARKER_PREFIX = '__MIXDOG_END__';

// --- ANSI strip (self-contained; mirrors builtin.mjs's implementation) ---
const _ANSI_REGEX = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\u0007|\u001B\\|\u009C))/g;
const _stripAnsi = typeof nodeUtil.stripVTControlCharacters === 'function'
    ? (s) => nodeUtil.stripVTControlCharacters(s)
    : (s) => s.replace(_ANSI_REGEX, () => '');
function stripAnsi(s) {
    if (typeof s !== 'string' || s.length === 0) return s;
    return _stripAnsi(s);
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Smart middle-truncate (shared with bash tool) ---
function smartMiddleTruncate(content) {
    const s = typeof content === 'string' ? content : String(content ?? '');
    if (s.length <= SMART_BASH_MAX_BYTES) {
        const fastLines = s.split('\n');
        if (fastLines.length <= SMART_BASH_MAX_LINES) return s;
        const head = fastLines.slice(0, SMART_BASH_HEAD_LINES).join('\n');
        const tail = fastLines.slice(-SMART_BASH_TAIL_LINES).join('\n');
        const middle = fastLines.length - SMART_BASH_HEAD_LINES - SMART_BASH_TAIL_LINES;
        return `${head}\n\n... [TRUNCATED — ${middle} lines middle elided; total ${fastLines.length} lines. Rerun with tighter filters for more] ...\n\n${tail}`;
    }
    const lines = s.split('\n');
    if (lines.length <= SMART_BASH_MAX_LINES) {
        const head = s.slice(0, SMART_BASH_MAX_BYTES);
        return `${head}\n\n... [TRUNCATED — output exceeded ${Math.round(SMART_BASH_MAX_BYTES / 1024)} KB on a single line] ...`;
    }
    const head = lines.slice(0, SMART_BASH_HEAD_LINES).join('\n');
    const tail = lines.slice(-SMART_BASH_TAIL_LINES).join('\n');
    const middle = lines.length - SMART_BASH_HEAD_LINES - SMART_BASH_TAIL_LINES;
    const totalKb = Math.round(s.length / 1024);
    return `${head}\n\n... [TRUNCATED — ${middle} lines middle elided; total ${lines.length} lines / ${totalKb} KB. Rerun with tighter filters for more] ...\n\n${tail}`;
}

// --- Blocked patterns (same set as bash tool; duplicated to keep module
// standalone). Any drift should be fixed in BOTH files.
const _CMD_START = '(?:^|[;&|\\n(){}]\\s*|\\$[\\({]\\s*|[<>]\\(\\s*|`\\s*)';
const BLOCKED_PATTERNS = [
    // Synced with builtin.mjs BLOCKED_PATTERNS rm rule — catch -rf, -fr,
    // split flags, `--` separator. Target restricted to / or ~.
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
function isBlocked(command) {
    for (const pat of BLOCKED_PATTERNS) {
        if (pat.test(command)) return true;
    }
    return false;
}

// Locate a usable bash binary. On Windows, Git Bash / MSYS ships one; on
// POSIX, /bin/bash is ubiquitous. We deliberately pin bash (not sh) since
// the feature set depended on by the sentinel echo and `$?` is bash-shaped.
function resolveBash() {
    if (process.platform !== 'win32') {
        if (existsSync('/bin/bash')) return '/bin/bash';
        if (existsSync('/usr/bin/bash')) return '/usr/bin/bash';
        return '/bin/sh'; // fallback; `$?` + echo still work
    }
    const fallbacks = [
        'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
        'C:\\msys64\\usr\\bin\\bash.exe',
        'C:\\cygwin64\\bin\\bash.exe',
    ];
    for (const c of fallbacks) if (existsSync(c)) return c;
    // Last resort — let spawn error surface clearly.
    return 'bash';
}

// --- Session pool ---
// Map<id, { proc, lastUsed, stdoutBuf, stderrBuf, busy }>
const _sessions = new Map();
let _reaperTimer = null;

function _startReaper() {
    if (_reaperTimer) return;
    _reaperTimer = setInterval(() => {
        const now = Date.now();
        for (const [id, s] of _sessions) {
            if (!s.busy && now - s.lastUsed > IDLE_TIMEOUT_MS) {
                _killSession(id, 'idle-timeout');
            }
        }
        if (_sessions.size === 0) {
            clearInterval(_reaperTimer);
            _reaperTimer = null;
        }
    }, 30_000);
    // Don't keep the event loop alive just for the reaper.
    if (typeof _reaperTimer.unref === 'function') _reaperTimer.unref();
}

// Kill a spawned shell along with any child processes it forked. Posix path
// signals the process group (pgid == pid because we spawn with detached:true),
// so `sleep 1000 &` or a node server started inside the session is reaped
// instead of being left orphaned holding pipes open. Windows uses taskkill
// /T /F to walk the process tree. SIGTERM is sent first so well-behaved
// children can shut down cleanly; a SIGKILL escalation timer (3 s) forces the
// issue if they don't. Safe to call multiple times — all errors swallowed.
function _killProcessTree(proc) {
    if (!proc || proc.killed) return;
    const pid = proc.pid;
    if (!pid) return;
    try {
        if (process.platform === 'win32') {
            // /T walks the tree, /F forces — no graceful SIGTERM on win.
            spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        } else {
            try { process.kill(-pid, 'SIGTERM'); }
            catch { try { proc.kill('SIGTERM'); } catch { /* ignore */ } }
        }
    } catch { /* ignore */ }
    // Escalate to SIGKILL if still alive. Windows taskkill /F is already
    // forceful, so only posix needs the escalation timer.
    if (process.platform !== 'win32') {
        const esc = setTimeout(() => {
            if (proc.killed) return;
            try { process.kill(-pid, 'SIGKILL'); }
            catch { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }
        }, 3000);
        if (typeof esc.unref === 'function') esc.unref();
    }
}

function _killSession(id, _reason) {
    const s = _sessions.get(id);
    if (!s) return;
    _sessions.delete(id);
    try { s.proc.stdin?.end(); } catch { /* ignore */ }
    _killProcessTree(s.proc);
}

function _evictOldestIfFull() {
    if (_sessions.size < MAX_SESSIONS) return;
    // Prefer an idle session. If all are busy we can't evict safely; throw.
    let oldestId = null;
    let oldestTs = Infinity;
    for (const [id, s] of _sessions) {
        if (s.busy) continue;
        if (s.lastUsed < oldestTs) {
            oldestTs = s.lastUsed;
            oldestId = id;
        }
    }
    if (oldestId) {
        _killSession(oldestId, 'pool-full');
        return;
    }
    throw new Error(`bash_session pool full (${MAX_SESSIONS} concurrent sessions, all busy)`);
}

// Build the env handed to the child bash. On Windows, Node inherits the
// host cmd.exe PATH, which usually does NOT include Git Bash's `usr/bin`
// — so the child bash starts with no coreutils (grep / sed / head / awk).
// We prepend the Git Bash / MSYS tool dirs so the user gets the familiar
// POSIX environment they expect from a bash shell.
function buildBashEnv() {
    const env = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
    if (process.platform === 'win32') {
        const toolDirs = [
            'C:\\Program Files\\Git\\usr\\bin',
            'C:\\Program Files\\Git\\mingw64\\bin',
            'C:\\Program Files (x86)\\Git\\usr\\bin',
            'C:\\msys64\\usr\\bin',
            'C:\\msys64\\mingw64\\bin',
        ];
        const existing = env.PATH || env.Path || '';
        const prefix = toolDirs.filter((p) => existsSync(p)).join(';');
        if (prefix) env.PATH = prefix + (existing ? ';' + existing : '');
    }
    return env;
}

function _spawnSession(id, initialCwd = process.cwd()) {
    _evictOldestIfFull();
    const shell = resolveBash();
    const proc = spawn(shell, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildBashEnv(),
        cwd: initialCwd,
        windowsHide: true,
        // detached:true on posix gives the child its own process group so
        // _killProcessTree can signal the whole group (catches `sleep 1000 &`
        // and similar backgrounded children). Skipped on win32 where
        // detached has different semantics (no console attached, used for
        // daemonization — unwanted here).
        detached: process.platform !== 'win32',
    });
    proc.stdout.setEncoding('utf-8');
    proc.stderr.setEncoding('utf-8');
    const entry = {
        proc,
        lastUsed: Date.now(),
        cwd: initialCwd,
        stdoutBuf: '',
        stderrBuf: '',
        busy: false,
        dead: false,
        exitInfo: null,
    };
    proc.stdout.on('data', (chunk) => { entry.stdoutBuf += chunk; });
    proc.stderr.on('data', (chunk) => { entry.stderrBuf += chunk; });
    proc.on('error', (err) => {
        entry.dead = true;
        entry.exitInfo = { error: err?.message || String(err) };
    });
    proc.on('exit', (code, signal) => {
        entry.dead = true;
        entry.exitInfo = { code, signal };
        _sessions.delete(id);
    });
    _sessions.set(id, entry);
    _startReaper();
    return entry;
}

function _getOrCreate(sessionId, initialCwd = process.cwd()) {
    const id = sessionId || `sess_${randomUUID()}`;
    let entry = _sessions.get(id);
    if (entry && entry.dead) {
        _sessions.delete(id);
        entry = null;
    }
    if (!entry) entry = _spawnSession(id, initialCwd);
    return { id, entry };
}

// Core command-run: frame with sentinel, wait for marker on stdout, flush
// stderr with a small drain window, return { stdout, stderr, exit_code }.
function _runCommand(entry, command, timeoutMs, abortSignal = null) {
    return new Promise((resolve, reject) => {
        entry.busy = true;
        // Reset buffers for this command. Anything left from a prior run is
        // unexpected (we only return after the marker), but be defensive.
        entry.stdoutBuf = '';
        entry.stderrBuf = '';

        let finished = false;
        let timeoutHandle = null;
        let abortHandler = null;
        const marker = `${MARKER_PREFIX}:${randomUUID()}`;
        const markerRe = new RegExp(`^${escapeRegex(marker)}:(-?\\d+)\\s*$`, 'm');

        const onExit = () => {
            if (finished) return;
            fail(new Error('bash_session: shell exited before command completed'));
        };

        const cleanup = () => {
            finished = true;
            entry.busy = false;
            entry.lastUsed = Date.now();
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (abortSignal && abortHandler) {
                try { abortSignal.removeEventListener('abort', abortHandler); } catch {}
            }
            entry.proc.stdout.removeListener('data', onStdout);
            entry.proc.removeListener('exit', onExit);
        };

        const settle = (result) => {
            if (finished) return;
            cleanup();
            resolve(result);
        };

        const fail = (err) => {
            if (finished) return;
            cleanup();
            reject(err);
        };

        const onStdout = () => {
            const m = markerRe.exec(entry.stdoutBuf);
            if (!m) return;
            const exitCode = Number(m[1]);
            // Everything before the marker line is the real stdout.
            const before = entry.stdoutBuf.slice(0, m.index);
            // Drain any pending stderr writes before returning. 25 ms is
            // plenty in practice — bash flushes stderr synchronously on
            // command completion, but a forked child's dying writes may
            // land a tick later.
            setTimeout(() => {
                const stderr = entry.stderrBuf;
                entry.stdoutBuf = '';
                entry.stderrBuf = '';
                settle({ stdout: before, stderr, exit_code: exitCode });
            }, STDERR_DRAIN_MS);
        };

        // Caller-driven abort (ESC / new prompt / session close). Kill the
        // shell immediately and resolve with an aborted marker so the agent
        // sees the cancellation rather than waiting for timeoutMs.
        if (abortSignal) {
            const fireAbort = () => {
                if (finished) return;
                const partialOut = entry.stdoutBuf || '';
                const partialErr = entry.stderrBuf || '';
                entry.stdoutBuf = '';
                entry.stderrBuf = '';
                _killProcessTree(entry.proc);
                cleanup();
                resolve({
                    stdout: partialOut,
                    stderr: partialErr,
                    exit_code: null,
                    signal: 'SIGTERM',
                    aborted: true,
                });
            };
            if (abortSignal.aborted) { fireAbort(); return; }
            abortHandler = fireAbort;
            abortSignal.addEventListener('abort', abortHandler, { once: true });
        }

        entry.proc.stdout.on('data', onStdout);
        // Check the buffer in case the marker already arrived (tiny commands).
        onStdout();

        entry.proc.on('exit', onExit);

        timeoutHandle = setTimeout(() => {
            // Timeout: surface what we have but don't leave the shell in a
            // half-run state. Killing the process is the only reliable way
            // to interrupt a stuck command; the caller can mint a new session.
            const partialOut = entry.stdoutBuf;
            const partialErr = entry.stderrBuf;
            entry.stdoutBuf = '';
            entry.stderrBuf = '';
            _killProcessTree(entry.proc);
            cleanup();
            // Return a structured result (not a reject) so the caller
            // renders a proper exit/stderr block instead of a bare Error.
            resolve({
                stdout: partialOut,
                stderr: partialErr,
                exit_code: null,
                signal: 'SIGTERM',
                timed_out: true,
                timeout_ms: timeoutMs,
            });
        }, timeoutMs);

        // Write the command + sentinel. Newline before `echo` in case the
        // command didn't end with one. `$?` captures the final pipeline's
        // exit status as of bash semantics.
        const payload = `${command}\necho "${marker}:$?"\n`;
        try {
            entry.proc.stdin.write(payload, 'utf-8');
        } catch (err) {
            fail(err);
        }
    });
}

async function _syncSessionCwd(entry, timeoutMs) {
    try {
        const result = await _runCommand(entry, 'pwd', Math.min(timeoutMs, 2000));
        if (result?.exit_code !== 0) return;
        const stdout = stripAnsi(result.stdout || '').trim();
        if (!stdout) return;
        const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (lines.length > 0) entry.cwd = lines[lines.length - 1];
    } catch {
        // Best-effort only — a failed cwd sync should never fail the user's command.
    }
}

async function bash_session(args, cwd = process.cwd(), opts = {}) {
    const abortSignal = opts && opts.abortSignal ? opts.abortSignal : null;
    const command = typeof args?.command === 'string' ? args.command : '';
    if (!command) return 'Error: command is required';
    if (isBlocked(command)) {
        return `Error: blocked command pattern — "${command}" matches safety rule`;
    }
    const baseCwd = (() => {
        const explicitId = typeof args?.session_id === 'string' ? args.session_id : '';
        if (explicitId) {
            const existing = _sessions.get(explicitId);
            if (existing?.cwd) return existing.cwd;
        }
        return cwd || process.cwd();
    })();
    const largeProbe = preflightShellLargeFileProbe(command, baseCwd);
    if (largeProbe) return `Error: ${largeProbe.message}`;
    const rawTimeout = typeof args?.timeout === 'number' ? args.timeout : DEFAULT_TIMEOUT_MS;
    // Accept seconds OR milliseconds for ergonomics: values ≤ 600 are
    // treated as seconds (matches the spec's "max 600s"); larger values
    // are taken as ms. Cap either way.
    const timeoutMs = rawTimeout <= 600 ? rawTimeout * 1000 : rawTimeout;
    const effectiveTimeout = Math.min(Math.max(timeoutMs, 1000), MAX_TIMEOUT_MS);
    const close = args?.close === true;

    const { id, entry } = _getOrCreate(args?.session_id, baseCwd);
    const shellEffects = analyzeShellCommandEffects(command, entry.cwd || baseCwd);

    if (entry.busy) {
        return `Error: session "${id}" is busy executing a prior command`;
    }

    let result;
    try {
        result = await _runCommand(entry, command, effectiveTimeout, abortSignal);
    } catch (err) {
        return `Error: ${err?.message || String(err)}`;
    }
    if (result.exit_code === 0 && shellEffects.finalCwd) {
        entry.cwd = shellEffects.finalCwd;
    }
    if (!close && !result.timed_out) {
        await _syncSessionCwd(entry, effectiveTimeout);
    }
    if (shellEffects.mutationMode === 'paths') {
        invalidateBuiltinResultCache(shellEffects.paths);
        markCodeGraphDirtyPaths(entry.cwd || baseCwd, shellEffects.paths);
    } else if (shellEffects.mutationMode === 'global') {
        invalidateBuiltinResultCache();
    }

    if (close) {
        _killSession(id, 'close-requested');
    }

    const stdoutClean = stripAnsi(result.stdout || '');
    const stderrClean = stripAnsi(result.stderr || '');
    const stdoutT = smartMiddleTruncate(stdoutClean);
    const stderrT = stderrClean ? smartMiddleTruncate(stderrClean) : '';

    // Structured header so the agent can parse session_id + exit_code out
    // of the text response without bespoke JSON. Keeps parity with the
    // `bash` tool's free-form `[exit code: N]` marker but additive.
    const headerLines = [`[session: ${id}]`];
    if (result.aborted) {
        headerLines.push(`[aborted: caller cancelled — session killed]`);
    } else if (result.timed_out) {
        headerLines.push(`[timeout: ${result.timeout_ms} ms — session killed]`);
    } else if (result.exit_code !== 0 && result.exit_code !== null) {
        headerLines.push(`[exit code: ${result.exit_code}]`);
    }
    if (close) headerLines.push(`[closed]`);
    const header = headerLines.join('\n');

    const body = stdoutT || (stderrT ? '' : '(no output)');
    const stderrBlock = stderrT ? `\n\n[stderr]\n${stderrT}` : '';
    return `${header}\n\n${body}${stderrBlock}`;
}

// BASH_SESSION_TOOL_DEFS removed in 0.1.126: the `bash` tool's
// `persistent:true` option absorbed every use case; the dedicated
// `bash_session` schema only added prompt bytes and triggered LLM
// hallucinations of the legacy name. Implementation (executeBashSessionTool,
// closeBashSession) stays — `bash` with persistent:true routes here.
export async function executeBashSessionTool(name, args, _cwd, opts = {}) {
    switch (name) {
        case 'bash_session':
            return bash_session(args || {}, _cwd || process.cwd(), opts);
        default:
            throw new Error(`Unknown bash-session tool: ${name}`);
    }
}

export function closeBashSession(sessionId, reason = 'external-close') {
    if (!sessionId || !_sessions.has(sessionId)) return false;
    _killSession(sessionId, reason);
    return true;
}

export function __getBashSessionStateForTesting(sessionId) {
    const entry = _sessions.get(sessionId);
    if (!entry) return null;
    return {
        busy: entry.busy,
        dead: entry.dead,
        cwd: entry.cwd,
        exitListenerCount: entry.proc.listenerCount('exit'),
    };
}

// Best-effort cleanup on process exit so orphan bash children don't linger
// when the plugin host shuts down. Not registered if the process has no
// `exit` event (shouldn't happen on Node).
if (typeof process?.on === 'function') {
    process.on('exit', () => {
        for (const id of [..._sessions.keys()]) _killSession(id, 'process-exit');
    });
}
