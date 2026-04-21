/**
 * File-based session store.
 * Sessions are saved to disk so CLI and MCP server can share state,
 * and sessions survive server restarts (resume).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { getPluginData } from '../config.mjs';

const WINDOWS_RENAME_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const WINDOWS_RENAME_RETRY_MAX = 3;
const WINDOWS_RENAME_RETRY_DELAY_MS = 50;

function _sleepSync(ms) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        // Busy-wait is acceptable here because the session store is already
        // synchronous and the retry window is tiny.
    }
}

function _renameWithRetrySync(tmp, target) {
    const maxAttempts = process.platform === 'win32' ? WINDOWS_RENAME_RETRY_MAX : 1;
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            renameSync(tmp, target);
            return;
        } catch (err) {
            lastErr = err;
            if (process.platform === 'win32'
                && WINDOWS_RENAME_RETRY_CODES.has(err?.code)
                && attempt < maxAttempts - 1) {
                _sleepSync(WINDOWS_RENAME_RETRY_DELAY_MS);
                continue;
            }
            break;
        }
    }
    // Antivirus / indexer handle contention on Windows can still make rename
    // lose after a few short retries. Fall back to replace-or-copy so a
    // session save does not take down the whole bridge turn.
    try {
        unlinkSync(target);
    } catch (err) {
        if (err?.code !== 'ENOENT') {
            // Keep going — the copy fallback below may still succeed.
        }
    }
    try {
        renameSync(tmp, target);
        return;
    } catch {}
    writeFileSync(target, readFileSync(tmp), 'utf-8');
    try { unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
    if (lastErr) {
        try {
            process.stderr.write(`[session-store] rename fallback used for ${target}: ${lastErr.code || lastErr.message}\n`);
        } catch { /* ignore logging failure */ }
    }
}

function getStoreDir() {
    const dir = join(getPluginData(), 'sessions');
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    return dir;
}
function sessionPath(id) {
    return join(getStoreDir(), `${id}.json`);
}
/**
 * Ensure generation/closed defaults on every session object.
 * Older persisted sessions predate these fields; we normalise at load and save.
 */
function _ensureLifecycleFields(session) {
    if (typeof session.generation !== 'number') session.generation = 0;
    if (typeof session.closed !== 'boolean') session.closed = false;
    return session;
}

/** Module-level map tracking in-flight saves per session ID to prevent concurrent write corruption. */
const _savePending = new Map();

/**
 * Persist a session. `opts.expectedGeneration` guards against resurrecting a
 * session that was closed mid-flight: before the rename, we re-read the file
 * on disk and, if it's already marked closed with a >= generation, drop the
 * write. `opts.allowClosed=true` is used by `markSessionClosed` itself when
 * writing the tombstone.
 */
export function saveSession(session, opts) {
    _ensureLifecycleFields(session);
    const id = session.id;
    const payload = { session, opts: opts || null };
    if (_savePending.get(id)) {
        _savePending.set(id, { queued: payload });
        return;
    }
    _savePending.set(id, { writing: true });
    _doSave(payload);
}

function _shouldDrop(id, opts) {
    if (!opts || opts.allowClosed) return false;
    const expected = typeof opts.expectedGeneration === 'number' ? opts.expectedGeneration : null;
    if (expected === null) return false;
    // Re-read current tombstone state from disk. If the session is closed with
    // a generation >= expected, our write is stale — drop it.
    const target = sessionPath(id);
    if (!existsSync(target)) return false;
    try {
        const onDisk = JSON.parse(readFileSync(target, 'utf-8'));
        const diskGen = typeof onDisk.generation === 'number' ? onDisk.generation : 0;
        return onDisk.closed === true && diskGen >= expected;
    } catch {
        return false;
    }
}

function _drainQueue(id) {
    const pending = _savePending.get(id);
    if (pending && pending.queued) {
        const next = pending.queued;
        _savePending.set(id, { writing: true });
        _doSave(next);
    } else {
        _savePending.delete(id);
    }
}

function _doSave(payload) {
    const { session, opts } = payload;
    const id = session.id;
    // First check: upfront, before any disk I/O. Cheap short-circuit when a
    // tombstone is already on disk when the caller arrives.
    if (_shouldDrop(id, opts)) {
        _drainQueue(id);
        return;
    }
    const target = sessionPath(id);
    const tmp = target + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
        writeFileSync(tmp, JSON.stringify(session), 'utf-8');
        // Second check: between the temp write and the rename, closeSession()
        // may have planted a tombstone. Re-check on disk; if a newer tombstone
        // now exists, discard our temp file rather than let rename clobber it.
        if (_shouldDrop(id, opts)) {
            try { unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
            process.stderr.write(`[session-store] ${id}: dropped stale save (tombstone planted during write)\n`);
            _drainQueue(id);
            return;
        }
        _renameWithRetrySync(tmp, target);
    } catch (err) {
        try { unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
        _savePending.delete(id);
        throw err;
    }
    _drainQueue(id);
}

/**
 * Atomically mark a session closed on disk with a bumped generation.
 * Returns the new generation, or null if the session file doesn't exist.
 * Used by closeSession() to plant a tombstone that races against in-flight
 * saveSession() calls.
 */
export function markSessionClosed(id, reason = 'manual') {
    const existing = loadSession(id);
    if (!existing) return null;
    const newGen = (typeof existing.generation === 'number' ? existing.generation : 0) + 1;
    const tombstone = { ...existing, closed: true, closedReason: reason, generation: newGen, updatedAt: Date.now() };
    // Bypass the queue + guard — this IS the tombstone write.
    const target = sessionPath(id);
    const tmp = target + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
        writeFileSync(tmp, JSON.stringify(tombstone), 'utf-8');
        _renameWithRetrySync(tmp, target);
    } catch {
        try { unlinkSync(tmp); } catch { /* ignore */ }
        return null;
    }
    return newGen;
}

export function loadSession(id) {
    const path = sessionPath(id);
    if (!existsSync(path))
        return null;
    try {
        return _ensureLifecycleFields(JSON.parse(readFileSync(path, 'utf-8')));
    }
    catch {
        return null;
    }
}
export function deleteSession(id) {
    const path = sessionPath(id);
    if (!existsSync(path))
        return false;
    try {
        unlinkSync(path);
        return true;
    }
    catch {
        return false;
    }
}
const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes idle — aligned with Anthropic 5m messages tier and OpenAI in-memory cache window
// Hard wall-clock ceiling for sessions stuck in status='running'. The
// stream-watchdog should abort stalled streams within ~120s, but if it misses
// one (process crash, watchdog not started, provider never returned), this
// backstop reclaims the file so the sweep doesn't leak zombies indefinitely.
const RUNNING_STALL_MS = 10 * 60 * 1000;

export function listStoredSessions(_ttlMs) {
    const dir = getStoreDir();
    if (!existsSync(dir))
        return [];
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    const sessions = [];
    for (const f of files) {
        try {
            const session = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
            sessions.push(session);
        }
        catch { /* skip corrupt */ }
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Raw directory scan — returns every parseable session file without any
 * TTL-based inline deletion. Callers (e.g. sweepTombstones) need to own the
 * unlink decision and log it themselves.
 */
export function getStoredSessionsRaw() {
    const dir = getStoreDir();
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    const sessions = [];
    for (const f of files) {
        try {
            sessions.push(JSON.parse(readFileSync(join(dir, f), 'utf-8')));
        } catch { /* skip corrupt */ }
    }
    return sessions;
}

/**
 * Proactive sweep: delete session files idle longer than ttlMs.
 * Returns { cleaned, remaining, details } for logging.
 */
export function sweepStaleSessions(ttlMs) {
    const maxAge = ttlMs || DEFAULT_SESSION_TTL_MS;
    const dir = getStoreDir();
    if (!existsSync(dir))
        return { cleaned: 0, remaining: 0, details: [] };
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    const now = Date.now();
    let cleaned = 0;
    let remaining = 0;
    const details = [];
    for (const f of files) {
        try {
            const session = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
            const lastActive = session.updatedAt || session.createdAt || 0;
            // Only sweep bridge sessions
            if (session.owner !== 'bridge') { remaining++; continue; }
            // Running sessions are normally reaped by the stream-watchdog
            // within ~120s. Skip them here unless they've been silent past
            // RUNNING_STALL_MS, at which point they are treated as zombies.
            if (session.status === 'running' && now - lastActive <= RUNNING_STALL_MS) {
                remaining++;
                continue;
            }
            if (now - lastActive > maxAge) {
                try { unlinkSync(join(dir, f)); } catch { continue; }
                cleaned++;
                details.push({
                    id: session.id,
                    owner: session.owner || 'unknown',
                    idleMinutes: Math.round((now - lastActive) / 60000),
                    bashSessionId: session.implicitBashSessionId || null,
                });
            } else {
                remaining++;
            }
        }
        catch { /* skip corrupt */ }
    }
    return { cleaned, remaining, details };
}
