/**
 * Bridge stall watchdog — per-session ticker that fires a `notifyFn` alert
 * when a bridge worker's SSE stream goes silent for too long.
 *
 * Motivation (v0.6.233):
 *   The global stream-watchdog already aborts on a hard 600s stall, but the
 *   bridge worker's `notifyFn` only fires on the completion path. A stall
 *   that never reaches the hard-abort boundary (e.g. provider goes quiet
 *   mid-iteration and the lead gives up waiting) left the lead waiting
 *   indefinitely with no "worker finished" notification.
 *
 *   This watchdog sits inside the bridge worker lifecycle, not the
 *   orchestrator. It uses the same staleness signal (lastStreamDeltaAt
 *   falling back to askStartedAt) and emits a user-facing notification
 *   via the existing notifyFn path once the per-session threshold is
 *   crossed — then aborts the session so the outer try/catch renders
 *   the normal error footer.
 *
 * Non-goals:
 *   - Does not replace the global stream-watchdog (that still runs at
 *     300s/600s for provider-level stalls that never dispatched via bridge).
 *   - Does not fire on long tool calls: `stage === 'tool_running'` is
 *     expected server silence, exactly like stream-watchdog.shouldSkip.
 */

import { getHiddenRole } from './orchestrator/internal-roles.mjs';
import { flushSessionMetrics, hideSessionFromList } from './orchestrator/session/manager.mjs';

// How long a terminal-stage session must sit idle before the watchdog
// flushes metrics and hides it from list_sessions output.
const TERMINAL_REAP_MS = 120_000;

const TICK_MS = 30_000;
// DEFAULT_THRESHOLD_S — runtime envelope constant for roles not declared in
// defaults/hidden-roles.json (public / custom user-workflow roles such as
// "worker", "reviewer", or any user-defined name). These roles carry no
// stallCap entry so the fallback keeps watchdog coverage without requiring
// every custom role to be registered. Aligns with stream-watchdog
// HARD_STALL_MS (600s / 10m) so the bridge stall fires before the global
// hard abort on a completely silent provider.
const DEFAULT_THRESHOLD_S = 600;

function envThresholdSeconds() {
    const raw = process.env.STALL_TIMEOUT_S;
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

// Read stallCap from the declarative hidden-role config (defaults/hidden-roles.json).
// User-workflow roles (worker, reviewer, custom names) carry no stallCap and fall
// through to DEFAULT_THRESHOLD_S — no per-role code branches here.
function resolveThresholdSeconds(role) {
    const envOverride = envThresholdSeconds();
    if (envOverride != null) return envOverride;
    const cfg = role ? getHiddenRole(role) : null;
    if (cfg?.stallCap?.idleSeconds > 0) return cfg.stallCap.idleSeconds;
    return DEFAULT_THRESHOLD_S;
}

function resolveToolThresholdSeconds(role, thresholdSeconds) {
    const cfg = role ? getHiddenRole(role) : null;
    if (cfg?.stallCap?.toolRunningSeconds > 0) return cfg.stallCap.toolRunningSeconds;
    return thresholdSeconds;
}

/**
 * Decide whether an entry is stalled right now.
 * Pure function — exposed for tests so we can feed synthetic runtime shapes.
 *
 * Returns one of:
 *   'skip'  — entry missing, closed, or in tool_running / terminal stage.
 *   'ok'    — entry live but below threshold.
 *   'stall' — stale beyond threshold; caller should notify + abort.
 *
 * `tool_running` is treated as a stall ONLY when the per-tool runtime
 * exceeds the role-specific threshold from `resolveToolThresholdSeconds`
 * (defaults are generous so normal long-running tools — build, test,
 * archive — do not trip). Below that threshold the verdict is `skip`,
 * because tool work is client-side and the server is not silent.
 * Terminal stages (idle/done/error/cancelling) are skipped too since
 * askSession has already returned or is unwinding.
 */
export function inspectBridgeEntry(entry, thresholdSeconds = DEFAULT_THRESHOLD_S, now = Date.now(), role = null) {
    if (!entry) return { verdict: 'skip' };
    if (entry.closed) return { verdict: 'skip' };
    const stage = entry.stage || null;
    if (stage === 'tool_running') {
        const toolStart = entry.toolStartedAt;
        const toolThreshold = resolveToolThresholdSeconds(role, thresholdSeconds);
        if (toolStart) {
            const toolRuntimeS = Math.round((now - toolStart) / 1000);
            if (toolRuntimeS >= toolThreshold) {
                return { verdict: 'stall', staleSeconds: toolRuntimeS, stage, reason: 'tool-runtime-exceeded', toolName: entry.lastToolCall || null };
            }
            return { verdict: 'skip' };
        }
        // toolStartedAt missing — fall back to last stream delta / ask start so a
        // session pinned in tool_running with no per-tool clock can still recover.
        const ref = entry.lastStreamDeltaAt || entry.askStartedAt;
        if (!ref) return { verdict: 'skip' };
        const staleSeconds = Math.round((now - ref) / 1000);
        if (staleSeconds < toolThreshold) return { verdict: 'skip' };
        return { verdict: 'stall', staleSeconds, stage, reason: 'tool-runtime-fallback', toolName: entry.lastToolCall || null };
    }
    if (stage === 'idle' || stage === 'done' || stage === 'error' || stage === 'cancelling') {
        // Terminal stages never abort, but may need flush+hide after 120s (fix B).
        const progressRef = entry.lastProgressAt || entry.doneAt || entry.updatedAt;
        if (progressRef && (now - progressRef) >= TERMINAL_REAP_MS) {
            return { verdict: 'terminal-reap', staleSeconds: Math.round((now - progressRef) / 1000), stage };
        }
        return { verdict: 'skip' };
    }
    const ref = entry.lastStreamDeltaAt || entry.askStartedAt;
    if (!ref) return { verdict: 'skip' };
    const staleSeconds = Math.round((now - ref) / 1000);
    if (staleSeconds < thresholdSeconds) return { verdict: 'ok', staleSeconds, stage };
    return { verdict: 'stall', staleSeconds, stage };
}

/**
 * Start a per-session stall watchdog.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {() => object|null} params.getRuntime      returns manager.getSessionRuntime(sessionId)
 * @param {() => number} params.getIteration        returns latest known iteration count
 * @param {(reason: Error) => void} params.abort    aborts the session controller
 * @param {(msg: string) => void} params.notify     notifyFn-style emitter
 * @param {string} [params.modelTag]                `[model] ` prefix to match other bridge emits
 * @param {string} [params.role]
 * @param {number} [params.thresholdSeconds]        override for tests; falls back to env + default
 * @param {number} [params.tickMs]                  override for tests
 * @returns {{ stop: () => void, fired: () => boolean }}
 */
export function startBridgeStallWatchdog(params) {
    const {
        sessionId,
        getRuntime,
        getIteration,
        abort,
        notify,
        modelTag = '',
        role = 'worker',
        thresholdSeconds = resolveThresholdSeconds(role),
        tickMs = TICK_MS,
    } = params;

    let fired = false;
    let handle = null;

    // Track which sessions have already been reaped to avoid repeat flushes.
    let _reaped = false;

    const tick = () => {
        let entry = null;
        try { entry = getRuntime(); } catch { entry = null; }
        const res = inspectBridgeEntry(entry, thresholdSeconds, Date.now(), role);

        // Fix B: terminal-reap path — flush metrics + hide, no abort.
        if (res.verdict === 'terminal-reap' && !_reaped) {
            _reaped = true;
            try { flushSessionMetrics(sessionId); } catch { /* best-effort */ }
            try { hideSessionFromList(sessionId); } catch { /* best-effort */ }
            if (handle) { clearInterval(handle); handle = null; }
            return;
        }

        if (fired) return;
        if (res.verdict !== 'stall') return;
        fired = true;
        const iter = (() => {
            try { return getIteration(); } catch { return null; }
        })();
        const iterPart = typeof iter === 'number' && iter > 0 ? ` at iter ${iter}` : '';
        const isToolStall = res.reason === 'tool-runtime-exceeded' || res.reason === 'tool-runtime-fallback';
        const toolPart = isToolStall && res.toolName ? ` in tool ${res.toolName}` : '';
        const causePart = isToolStall ? `tool stalled${toolPart}` : 'no SSE delta';
        const msg = `${modelTag}${role} stalled — ${causePart} for ${res.staleSeconds}s${iterPart}`;
        try { notify(msg); } catch { /* best-effort — match other bridge emits */ }
        try {
            const reason = new Error(`bridge stall watchdog: ${res.staleSeconds}s`);
            reason.name = 'BridgeStallAbortError';
            abort(reason);
        } catch { /* controller already gone / non-Error rejection — let outer flow finish */ }
        // Don't keep ticking once we've fired; outer finally will stop() us
        // but clear eagerly so a slow unwind can't double-notify.
        if (handle) { clearInterval(handle); handle = null; }
    };

    handle = setInterval(tick, tickMs);
    if (typeof handle.unref === 'function') handle.unref();

    return {
        stop() {
            if (handle) { clearInterval(handle); handle = null; }
        },
        fired() { return fired; },
    };
}

export const _internals = { TICK_MS, DEFAULT_THRESHOLD_S, envThresholdSeconds };
