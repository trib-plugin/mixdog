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

const TICK_MS = 30_000;
const DEFAULT_THRESHOLD_S = 3600;

// Role-aware thresholds. All roles default to 600s (10 min) to align with
// stream-watchdog HARD_STALL_MS — the bridge-stall path then notifies lead
// and aborts at the same wall-clock point as the global watchdog, instead
// of cutting deep work short and forcing lead-side retries that themselves
// create the hangs we're trying to prevent. Tighten via env STALL_TIMEOUT_S
// per-session if needed; tighten the role map below only if a specific role
// proves to spuriously consume the full budget without doing useful work.
const ROLE_THRESHOLDS_S = {
    reviewer: 600,
    debugger: 600,
    tester: 600,
    worker: 600,
    explorer: 600,
    'recall-agent': 600,
    'search-agent': 600,
    'cycle1-agent': 600,
    'cycle2-agent': 600,
};

// Per-role override for the tool_running window. Without an entry the default
// is `thresholdSeconds * 2` (matches pre-existing behaviour). Cycle/chunker
// roles should never spend more than a few minutes inside a single tool call;
// tightening these caps recovers a stuck fan-out shard inside ~5 min instead
// of waiting out the full 20 min default and starving the rest of the cycle.
const ROLE_TOOL_THRESHOLDS_S = {
    'cycle1-agent': 300,
    'cycle2-agent': 300,
    'memory-classification': 300,
    'recap-agent': 300,
};

function envThresholdSeconds() {
    const raw = process.env.STALL_TIMEOUT_S;
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

function resolveThresholdSeconds(role) {
    const envOverride = envThresholdSeconds();
    if (envOverride != null) return envOverride;
    if (role && Object.prototype.hasOwnProperty.call(ROLE_THRESHOLDS_S, role)) {
        return ROLE_THRESHOLDS_S[role];
    }
    return DEFAULT_THRESHOLD_S;
}

function resolveToolThresholdSeconds(role, thresholdSeconds) {
    if (role && Object.prototype.hasOwnProperty.call(ROLE_TOOL_THRESHOLDS_S, role)) {
        return ROLE_TOOL_THRESHOLDS_S[role];
    }
    return thresholdSeconds * 2;
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
 * Never treats `tool_running` as a stall (client-side work, not server
 * silence). Terminal stages (idle/done/error/cancelling) are skipped too
 * since askSession has already returned or is unwinding.
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

    const tick = () => {
        if (fired) return;
        let entry = null;
        try { entry = getRuntime(); } catch { entry = null; }
        const res = inspectBridgeEntry(entry, thresholdSeconds, Date.now(), role);
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
