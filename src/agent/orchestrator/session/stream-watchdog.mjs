/**
 * Stream watchdog — aborts sessions that have been silent too long.
 *
 * Measures the wall-clock gap since each session's last stream delta.
 * Long total duration is fine; no progress for too long is not.
 *
 * Thresholds:
 *   300s (5m) — soft: emit tool_stream_stalled telemetry once per session.
 *   600s (10m) — hard: abort the session's controller with a StreamStalledAbortError,
 *                emit tool_stream_aborted telemetry, stop tracking it.
 *                Kept well above the provider adapter's own idle ceiling
 *                (openai-oauth-ws.mjs WS_STREAM_IDLE_MS = 300s) so this
 *                watchdog acts as a backup net, not the primary cutoff.
 *
 * Tick interval is 15s, so a real stall is noticed within (threshold + 15s).
 */
import { traceStreamAborted, traceStreamStalled } from '../bridge-trace.mjs';

const SOFT_STALL_MS = 300_000;
const HARD_STALL_MS = 600_000;
const TICK_MS = 15_000;

let _tickHandle = null;
const _softWarned = new Set(); // sessionIds that already received a soft warning

export class StreamStalledAbortError extends Error {
    constructor(info) {
        super(`stream stalled ${info.staleSeconds}s (last: ${info.lastToolCall || 'unknown'}, stage: ${info.stage || 'unknown'})`);
        this.name = 'StreamStalledAbortError';
        this.info = info;
    }
}

function computeStaleSeconds(entry) {
    if (!entry) return null;
    // Prefer the last stream delta when one has arrived; fall back to
    // askStartedAt so a provider that never streams the first token still
    // accumulates a stale window the watchdog can act on.
    const ref = entry.lastStreamDeltaAt || entry.askStartedAt;
    if (!ref) return null;
    return Math.round((Date.now() - ref) / 1000);
}

function shouldSkip(sessionId, entry) {
    if (!sessionId || !entry) return true;
    if (entry.closed) return true;
    if (!entry.controller || entry.controller.signal?.aborted) return true;
    // Watchdog is active once an ask has started, even before the first
    // stream delta lands. Connect-phase hangs were invisible before — a
    // provider that accepted the request but never returned a first token
    // would stay 'running' forever. askStartedAt closes that gap.
    if (!entry.lastStreamDeltaAt && !entry.askStartedAt) return true;
    // Server silence while the client runs a tool is expected, not a stall.
    // The next streaming phase refreshes lastStreamDeltaAt on its own.
    if (entry.stage === 'tool_running') return true;
    return false;
}

/**
 * Examine one runtime entry and apply watchdog logic.
 * Exposed for tests — pass a fake entry shape and observe effects.
 *
 * @param {string} sessionId
 * @param {object} entry - runtime entry (must carry controller, lastStreamDeltaAt, etc.)
 * @param {{onSoft?: Function, onHard?: Function}} [hooks]
 * @returns {'skip'|'continue'|'soft'|'hard'}
 */
export function inspectEntry(sessionId, entry, hooks = {}) {
    if (shouldSkip(sessionId, entry)) return 'skip';
    const staleSeconds = computeStaleSeconds(entry);
    if (staleSeconds === null) return 'skip';

    const info = {
        sessionId,
        staleSeconds,
        lastToolCall: entry.lastToolCall || null,
        stage: entry.stage || null,
    };

    if (staleSeconds * 1000 >= HARD_STALL_MS) {
        traceStreamAborted({ sessionId, info });
        try {
            entry.controller.abort(new StreamStalledAbortError(info));
        } catch {
            // Abort controller may reject non-Error reasons on older runtimes — fall through.
        }
        _softWarned.delete(sessionId);
        hooks.onHard?.(info);
        return 'hard';
    }

    if (staleSeconds * 1000 >= SOFT_STALL_MS) {
        if (!_softWarned.has(sessionId)) {
            _softWarned.add(sessionId);
            traceStreamStalled({ sessionId, info });
            hooks.onSoft?.(info);
        }
        return 'soft';
    }

    // Delta updated under soft threshold — clear any prior warn mark so
    // a fresh stall later can warn again.
    if (_softWarned.has(sessionId) && staleSeconds * 1000 < SOFT_STALL_MS) {
        _softWarned.delete(sessionId);
    }
    return 'continue';
}

/**
 * Start the periodic watchdog. Single global timer; iterates all sessions
 * via the supplied accessor on each tick.
 *
 * @param {() => Iterable<[string, object]>} runtimeIterator - returns [sessionId, entry] pairs
 */
export function startWatchdog(runtimeIterator) {
    if (_tickHandle) return;
    const tick = () => {
        try {
            for (const [sessionId, entry] of runtimeIterator()) {
                inspectEntry(sessionId, entry);
            }
        } catch (e) {
            process.stderr.write(`[stream-watchdog] tick failed: ${e.message}\n`);
        }
    };
    _tickHandle = setInterval(tick, TICK_MS);
    // Do not keep the process alive just for the watchdog.
    if (typeof _tickHandle.unref === 'function') _tickHandle.unref();
}

export function stopWatchdog() {
    if (_tickHandle) {
        clearInterval(_tickHandle);
        _tickHandle = null;
    }
    _softWarned.clear();
}

export const _thresholds = { SOFT_STALL_MS, HARD_STALL_MS, TICK_MS };
