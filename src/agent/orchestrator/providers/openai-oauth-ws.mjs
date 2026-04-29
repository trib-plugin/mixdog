/**
 * OpenAI Codex OAuth — WebSocket transport.
 *
 * Single dispatch path for the openai-oauth provider (SSE removed in
 * v0.6.117). Uses the `responses_websockets=2026-02-06` beta WebSocket
 * upgrade on chatgpt.com/backend-api/codex/responses. Per-session
 * connections are pooled (5 min idle TTL, up to 8 parallel sockets per
 * key) so subsequent tool-loop iterations can send only the incremental
 * `input` delta plus `previous_response_id`, skipping the full
 * tools/system/history prefix each turn.
 *
 * References:
 * - pi-mono packages/ai/src/providers/openai-codex-responses.ts
 *   (acquireWebSocket/release, get_incremental_items delta logic).
 * - openai/codex codex-rs/core/src/client.rs (turn-state echo header).
 *
 * Exposes:
 *   sendViaWebSocket({ auth, body, sendOpts, onStreamDelta, onToolCall,
 *                      onStageChange, externalSignal, poolKey, cacheKey, iteration,
 *                      useModel, traceCtx })
 *
 * The caller (openai-oauth.mjs) supplies a fully built request body and the
 * auth bundle; this module handles connection caching, delta framing, event
 * parsing, and tracing.
 */
import WebSocket from 'ws';
import {
    extractCachedTokens,
    traceBridgeFetch,
    traceBridgeSse,
    traceBridgeUsage,
    appendBridgeTrace,
} from '../bridge-trace.mjs';

const CODEX_WS_URL = 'wss://chatgpt.com/backend-api/codex/responses';
const OPENAI_WS_URL = 'wss://api.openai.com/v1/responses';
const WS_IDLE_MS = 5 * 60_000;
const WS_HANDSHAKE_TIMEOUT_MS = 30_000;

// Handshake retry policy. The `ws` library surfaces a bare
// `Opening handshake has timed out` Error after handshakeTimeout; transient
// network blips (DNS, reset, 5xx) similarly produce single-shot failures that
// waste the caller's turn when they'd succeed on retry. We wrap the acquire
// step with bounded exponential backoff. Permanent auth/quota (4xx) must NOT
// retry because a second attempt will hit the same deterministic server
// decision and just double the user-visible latency.
const HANDSHAKE_MAX_ATTEMPTS = 3;
const HANDSHAKE_BACKOFF_BASE_MS = 500;
const HANDSHAKE_BACKOFF_CAP_MS = 5000;
// Codex can stall for 50+s between chunks on long reasoning requests
// (observed: iter 5 of a multi-file review produced sse_parse_ms=58265).
// Iter-boundary reasoning pauses after large tool_output batches (e.g.
// 8-file array-form read) have been observed past 120s, so raising the ceiling
// to 300s. armPreStreamWatchdog releases on first chunk, so healthy
// requests are unaffected by the larger cap.
const WS_STREAM_IDLE_MS = 300_000;
// WS socket pool buckets are keyed by `poolKey` (the per-call sessionId)
// to isolate parallel bridge invocations — each gets its own socket so
// a second caller cannot grab a sibling's mid-turn entry (Codex would
// otherwise reject the new response.create with "No tool output found
// for function call ..."). The Codex handshake `session_id` header/URL
// uses `cacheKey` — a provider-scoped unified key (e.g. 'mixdog-codex')
// built in manager.mjs via providerCacheKey(). All orchestrator-internal
// dispatches targeting this provider share the same cacheKey, so the
// server-side prompt-cache shard is shared across every role/source.
// Codex dedupes cache by handshake session_id, not by
// body.prompt_cache_key alone (measured 2026-04-19 after the v0.6.151
// regression).
const MAX_POOLED_SOCKETS_PER_KEY = 8;

// poolKey -> Entry[]
// Entry: { socket, busy, idleTimer, lastResponseId, lastRequestSansInput,
//          lastInputLen, turnState, closing, ephemeral }
const _wsPool = new Map();

function _getPoolArr(poolKey) {
    if (!poolKey) return null;
    let arr = _wsPool.get(poolKey);
    if (!arr) {
        arr = [];
        _wsPool.set(poolKey, arr);
    }
    return arr;
}

function _removeFromPool(poolKey, entry) {
    if (!poolKey) return;
    const arr = _wsPool.get(poolKey);
    if (!arr) return;
    const idx = arr.indexOf(entry);
    if (idx >= 0) arr.splice(idx, 1);
    if (arr.length === 0) _wsPool.delete(poolKey);
}

function _scheduleIdleClose(poolKey, entry) {
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
        if (entry.busy) return;
        try { entry.socket.close(1000, 'idle_timeout'); } catch {}
        _removeFromPool(poolKey, entry);
    }, WS_IDLE_MS);
}

function _clearIdle(entry) {
    if (entry?.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
    }
}

function _isOpen(entry) {
    return entry?.socket?.readyState === WebSocket.OPEN;
}

function _buildHandshakeHeaders({ auth, sessionToken, turnState }) {
    const headers = auth.type === 'openai-direct'
        ? {
            'Authorization': `Bearer ${auth.apiKey}`,
            'OpenAI-Beta': 'responses_websockets=2026-02-06',
        }
        : {
            'Authorization': `Bearer ${auth.access_token}`,
            'chatgpt-account-id': auth.account_id || '',
            'originator': 'mixdog',
            'OpenAI-Beta': 'responses_websockets=2026-02-06',
        };
    if (sessionToken) {
        const sid = String(sessionToken);
        headers['session_id'] = sid;
        headers['x-client-request-id'] = sid;
    }
    if (turnState) headers['x-codex-turn-state'] = turnState;
    return headers;
}

// handshake session_id is the per-socket conversation slot Codex uses for
// in-memory prefix state. Use the cacheKey verbatim so all calls sharing
// the same logical conversation land on the same server-side slot, matching
// codex-rs which keys both the slot and prompt_cache_key off conversation_id.
// Per-socket randomization was tried (unique policy) and measured worse at
// every turn depth: cross-call baseline never hit, deep iters hit cached=0
// from server-side eviction. See recap 04-29 02:09–02:18.
function _mintSessionToken(cacheKey) {
    return cacheKey || 'mixdog-default';
}

function _openSocket({ auth, sessionToken, turnState }) {
    const headers = _buildHandshakeHeaders({ auth, sessionToken, turnState });
    const baseUrl = auth.type === 'openai-direct' ? OPENAI_WS_URL : CODEX_WS_URL;
    const url = baseUrl + (sessionToken ? `?session_id=${encodeURIComponent(String(sessionToken))}` : '');
    return new Promise((resolve, reject) => {
        let settled = false;
        const socket = new WebSocket(url, { headers, handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS });
        const capturedHeaders = { turnState: null };
        socket.once('upgrade', (res) => {
            try {
                const ts = res?.headers?.['x-codex-turn-state'];
                if (typeof ts === 'string' && ts.length) capturedHeaders.turnState = ts;
            } catch {}
        });
        socket.once('open', () => {
            if (settled) return;
            settled = true;
            resolve({ socket, turnState: capturedHeaders.turnState });
        });
        socket.once('error', (err) => {
            if (settled) return;
            settled = true;
            try { socket.terminate(); } catch {}
            reject(err);
        });
        socket.once('unexpected-response', (_req, res) => {
            if (settled) return;
            settled = true;
            const status = res?.statusCode || 0;
            let body = '';
            res.on('data', c => { if (body.length < 2048) body += c.toString('utf-8'); });
            res.on('end', () => {
                try { socket.terminate(); } catch {}
                reject(Object.assign(new Error(`Codex WS handshake ${status}: ${body.slice(0, 200)}`), { httpStatus: status, httpBody: body }));
            });
        });
    });
}

async function acquireWebSocket({ auth, poolKey, cacheKey, forceFresh }) {
    if (poolKey && !forceFresh) {
        const arr = _wsPool.get(poolKey) || [];
        // Prune dead entries first.
        for (let i = arr.length - 1; i >= 0; i--) {
            if (!_isOpen(arr[i]) || arr[i].closing) {
                _clearIdle(arr[i]);
                arr.splice(i, 1);
            }
        }
        if (arr.length === 0) _wsPool.delete(poolKey);
        // Reuse any idle open entry (cache-warm path).
        const idle = arr.find(e => !e.busy);
        if (idle) {
            _clearIdle(idle);
            idle.busy = true;
            return { entry: idle, reused: true };
        }
        // All entries busy and bucket at cap: fall through to ephemeral socket.
        if (arr.length >= MAX_POOLED_SOCKETS_PER_KEY) {
            const ephSessionToken = _mintSessionToken(cacheKey);
            const { socket, turnState } = await _openSocket({ auth, sessionToken: ephSessionToken, turnState: null });
            const entry = {
                socket,
                busy: true,
                idleTimer: null,
                lastResponseId: null,
                lastRequestSansInput: null,
                lastInputLen: 0,
                turnState: turnState || null,
                closing: false,
                ephemeral: true,
                sessionToken: ephSessionToken,
            };
            socket.on('close', () => { entry.closing = true; });
            return { entry, reused: false };
        }
    }
    // Parallel sockets must not inherit sibling turnState or the Codex server
    // treats the new request as a continuation of another in-flight turn and
    // returns "No tool output found for function call …". turnState only
    // propagates within a single entry across its own iterations.
    const sessionToken = _mintSessionToken(cacheKey);
    const { socket, turnState } = await _openSocket({ auth, sessionToken, turnState: null });
    const entry = {
        socket,
        busy: true,
        idleTimer: null,
        lastResponseId: null,
        lastRequestSansInput: null,
        lastInputLen: 0,
        turnState: turnState || null,
        closing: false,
        ephemeral: false,
        sessionToken,
    };
    if (poolKey && !forceFresh) _getPoolArr(poolKey).push(entry);
    socket.on('close', () => {
        entry.closing = true;
        _removeFromPool(poolKey, entry);
    });
    return { entry, reused: false };
}

function releaseWebSocket({ entry, poolKey, keep }) {
    if (!entry) return;
    entry.busy = false;
    if (!keep || !_isOpen(entry) || !poolKey || entry.ephemeral) {
        try { entry.socket.close(1000, keep ? 'no_session' : 'release_no_keep'); } catch {}
        _removeFromPool(poolKey, entry);
        return;
    }
    _scheduleIdleClose(poolKey, entry);
}

// Port of pi-mono get_incremental_items: if the cached request (sans input)
// matches the current one and the current input starts with the cached input,
// return only the tail. Otherwise return the full input (fresh turn).
function _sansInput(body) {
    const { input: _ignored, ...rest } = body;
    return rest;
}

function _stableStringify(obj) {
    // Shallow stable-ish: JSON.stringify with sorted top-level keys. Nested
    // arrays (tools, include) are order-sensitive and reflect intent, so we
    // do not sort them.
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return JSON.stringify(obj);
    const keys = Object.keys(obj).sort();
    const parts = [];
    for (const k of keys) parts.push(JSON.stringify(k) + ':' + _stableStringify(obj[k]));
    return '{' + parts.join(',') + '}';
}

function _computeDelta({ entry, body }) {
    if (!entry || !entry.lastRequestSansInput || !entry.lastResponseId) {
        return { mode: 'full', frame: { type: 'response.create', ...body } };
    }
    const curSans = _stableStringify(_sansInput(body));
    if (curSans !== entry.lastRequestSansInput) {
        return { mode: 'full', frame: { type: 'response.create', ...body } };
    }
    const prevLen = entry.lastInputLen | 0;
    const curInput = Array.isArray(body.input) ? body.input : [];
    if (curInput.length < prevLen) {
        return { mode: 'full', frame: { type: 'response.create', ...body } };
    }
    const tail = curInput.slice(prevLen);
    return {
        mode: 'delta',
        frame: {
            ...body,
            type: 'response.create',
            previous_response_id: entry.lastResponseId,
            input: tail,
        },
    };
}

function _estimateFrameTokens(frame) {
    try {
        const s = JSON.stringify(frame);
        return Math.ceil(s.length / 4);
    } catch { return 0; }
}

function _parseEvent(raw) {
    try { return JSON.parse(raw); } catch { return null; }
}

async function _streamResponse({ entry, externalSignal, onStreamDelta, onToolCall, state }) {
    const socket = entry.socket;
    let content = '';
    let model = '';
    let responseId = '';
    const toolCalls = [];
    const pendingCalls = new Map();
    // Reasoning items collected from response.output_item.done (or salvaged
    // from response.completed.response.output). When include:['reasoning.
    // encrypted_content'] is set on the request, each reasoning item carries
    // an `encrypted_content` blob the model must see again on the NEXT
    // input to keep the server prompt cache prefix warm. Replay path lives
    // in convertMessagesToResponsesInput in openai-oauth.mjs.
    const reasoningItems = [];
    const pushReasoningItem = (item) => {
        if (!item || item.type !== 'reasoning') return;
        if (!item.encrypted_content) return;
        reasoningItems.push({
            id: item.id || '',
            encrypted_content: item.encrypted_content,
            summary: Array.isArray(item.summary) ? item.summary : [],
        });
    };
    let usage;
    let done = false;
    let terminalError = null;
    // Mid-stream retry classifier needs to distinguish "stream died before we
    // even saw response.created" from "stream died after we had a partial
    // response but before completion". Mutate the shared state object so the
    // caller can inspect flags on the error path without us having to attach
    // them manually at every reject site.
    const midState = state || {};
    midState.sawResponseCreated = midState.sawResponseCreated || false;
    midState.sawCompleted = midState.sawCompleted || false;
    midState.wsCloseCode = null;
    midState.responseFailedPayload = null;
    let idleTimer = null;
    let keepaliveTimer = null;
    let abortHandler = null;
    let messageHandler = null;
    let closeHandler = null;
    let errorHandler = null;

    return new Promise((resolve, reject) => {
        // Pre-stream watchdog only: the timer fires if the server never sends
        // a first chunk within WS_STREAM_IDLE_MS after our last frame. Once
        // any chunk arrives, we consider the stream live and cancel the
        // timer — silent gaps between chunks (e.g. Codex spending 50s+
        // producing reasoning tokens mid-turn) are normal and should not
        // abort the turn. Truly stuck streams are caught by the external
        // signal (session close / user cancel), not by a heuristic idle.
        const armPreStreamWatchdog = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                terminalError = new Error(`Codex WS stream no first chunk within ${WS_STREAM_IDLE_MS}ms`);
                try { socket.close(4000, 'idle_timeout'); } catch {}
            }, WS_STREAM_IDLE_MS);
        };
        const resetIdle = () => {
            // First chunk disarms the watchdog for the rest of the stream.
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
        };
        const cleanup = () => {
            if (idleTimer) clearTimeout(idleTimer);
            if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
            if (messageHandler) socket.off('message', messageHandler);
            if (closeHandler) socket.off('close', closeHandler);
            if (errorHandler) socket.off('error', errorHandler);
            if (abortHandler && externalSignal) externalSignal.removeEventListener('abort', abortHandler);
        };
        const finish = () => {
            cleanup();
            if (terminalError) { reject(terminalError); return; }
            resolve({
                content,
                model,
                reasoningItems: reasoningItems.length ? reasoningItems : undefined,
                toolCalls: toolCalls.length ? toolCalls : undefined,
                usage,
                responseId: responseId || undefined,
            });
        };

        messageHandler = (data) => {
            resetIdle();
            // Every WebSocket frame (content deltas + non-content events like
            // response.output_item.added + server keepalives) refreshes the
            // stream-delta timestamp so bridge-stall-watchdog does not
            // false-positive during long reasoning pauses. Parallels the
            // `:ping` SSE handling in anthropic-oauth.mjs.
            try { onStreamDelta?.(); } catch {}
            const text = typeof data === 'string' ? data : data.toString('utf-8');
            const event = _parseEvent(text);
            if (!event || typeof event.type !== 'string') return;
            switch (event.type) {
                case 'response.created':
                    midState.sawResponseCreated = true;
                    if (event.response?.model) model = event.response.model;
                    if (event.response?.id) responseId = event.response.id;
                    break;
                case 'response.output_text.delta':
                    content += event.delta || '';
                    try { onStreamDelta?.(); } catch {}
                    break;
                case 'response.output_item.added':
                    if (event.item?.type === 'function_call') {
                        pendingCalls.set(event.item.id || '', {
                            name: event.item.name || '',
                            callId: event.item.call_id || '',
                        });
                    }
                    break;
                case 'response.function_call_arguments.delta':
                    try { onStreamDelta?.(); } catch {}
                    break;
                case 'response.function_call_arguments.done': {
                    const itemId = event.item_id || '';
                    const pending = pendingCalls.get(itemId);
                    let args = {};
                    try { args = JSON.parse(event.arguments || '{}'); } catch {}
                    const call = {
                        id: pending?.callId || `tc_${Date.now()}_${toolCalls.length}`,
                        name: pending?.name || '',
                        arguments: args,
                    };
                    toolCalls.push(call);
                    try { onToolCall?.(call); } catch {}
                    try { onStreamDelta?.(); } catch {}
                    break;
                }
                case 'response.output_item.done':
                    // function_call / output_text already captured via their
                    // dedicated streaming events. The one shape we still need
                    // here is `reasoning` — carries encrypted_content that
                    // must be replayed on the next input to keep the Codex
                    // server-side prompt cache prefix warm.
                    if (event.item?.type === 'reasoning') pushReasoningItem(event.item);
                    break;
                case 'response.completed': {
                    if (event.response?.usage) {
                        const u = event.response.usage;
                        usage = {
                            inputTokens: u.input_tokens || 0,
                            outputTokens: u.output_tokens || 0,
                            cachedTokens: extractCachedTokens(u),
                            // OpenAI Codex reports input_tokens as the total
                            // prompt volume (cached portion is a subset, not
                            // additive). Alias into the cross-provider
                            // `promptTokens` field so downstream loggers have
                            // uniform semantics.
                            promptTokens: u.input_tokens || 0,
                            raw: u,
                        };
                    }
                    if (!model && event.response?.model) model = event.response.model;
                    if (!responseId && event.response?.id) responseId = event.response.id;
                    if (event.response?.output) {
                        for (const item of event.response.output) {
                            if (!content && item.type === 'message') {
                                for (const c of item.content || []) {
                                    if (c.type === 'output_text') content += c.text || '';
                                }
                            }
                            // Salvage path: some streams emit reasoning only
                            // inside the final response.completed.output
                            // bundle (no per-item .done event). Dedup by id.
                            if (item.type === 'reasoning'
                                && !reasoningItems.some(r => r.id === item.id)) {
                                pushReasoningItem(item);
                            }
                        }
                    }
                    midState.sawCompleted = true;
                    done = true;
                    finish();
                    break;
                }
                case 'response.done':
                case 'response.incomplete':
                    done = true;
                    finish();
                    break;
                case 'response.failed': {
                    // Stash the payload so the mid-stream classifier can sniff
                    // network_error / stream_disconnected without re-parsing.
                    midState.responseFailedPayload = event;
                    const msg = event.response?.error?.message
                        || event.error?.message
                        || event.message
                        || 'response.failed';
                    terminalError = Object.assign(new Error(`Codex WS response.failed: ${msg}`), {
                        responseFailed: event,
                    });
                    finish();
                    break;
                }
                case 'error':
                    terminalError = new Error(`Codex WS error: ${event.message || event.error?.message || 'unknown'}`);
                    finish();
                    break;
                default:
                    // Trace-only events (response.in_progress, reasoning.*, etc.)
                    break;
            }
        };
        closeHandler = (code, reason) => {
            if (done) return;
            midState.wsCloseCode = code;
            if (!terminalError) {
                const r = reason?.toString?.('utf-8') || '';
                terminalError = Object.assign(
                    new Error(`Codex WS closed before response.completed (code=${code}${r ? `, reason=${r}` : ''})`),
                    { wsCloseCode: code, wsCloseReason: r },
                );
            } else if (terminalError && !terminalError.wsCloseCode) {
                try { terminalError.wsCloseCode = code; } catch {}
            }
            finish();
        };
        errorHandler = (err) => {
            if (done) return;
            terminalError = err instanceof Error ? err : new Error(String(err));
            try { socket.close(4001, 'stream_error'); } catch {}
            finish();
        };
        if (externalSignal) {
            abortHandler = () => {
                if (done) return;
                const reason = externalSignal.reason;
                terminalError = reason instanceof Error ? reason : new Error('Codex WS aborted by session close');
                // Tag: was this a user/caller abort, or a watchdog abort?
                // Mid-stream retry must skip user aborts but may retry watchdog
                // aborts. The caller-owned AbortController surfaces through
                // externalSignal; bridge-stall-watchdog signals via a reason
                // object whose name === 'BridgeStallAbortError'. stream-watchdog
                // uses StreamStalledAbortError. Anything else → treat as user.
                const reasonName = reason?.name || '';
                if (reasonName === 'BridgeStallAbortError'
                    || reasonName === 'StreamStalledAbortError') {
                    midState.watchdogAbort = reasonName;
                } else {
                    midState.userAbort = true;
                }
                try { socket.close(4002, 'aborted'); } catch {}
                finish();
            };
            if (externalSignal.aborted) { abortHandler(); return; }
            externalSignal.addEventListener('abort', abortHandler, { once: true });
        }
        socket.on('message', messageHandler);
        socket.on('close', closeHandler);
        socket.on('error', errorHandler);
        armPreStreamWatchdog();
        // Periodic client-side WS ping while the stream is active. Codex's
        // server closes with 1011 "keepalive ping timeout" when it thinks the
        // peer is silent during long reasoning windows where no data frames
        // flow. Sending a ping every 18s from our side keeps the socket warm.
        // The interval is unref'd so it never holds the event loop open, and
        // cleanup() clears it on every terminal path (completed / close /
        // error / abort / mid-stream retry teardown).
        keepaliveTimer = setInterval(() => {
            try {
                if (socket.readyState !== WebSocket.OPEN) return;
                socket.ping();
            } catch {}
        }, 18_000);
        try { keepaliveTimer.unref?.(); } catch {}
    });
}

/**
 * Classify a handshake error for retry eligibility.
 *
 * Default-deny: anything we don't recognize as transient returns null (treat
 * as permanent). Permanent buckets (401/403/404/429) also return null — the
 * server has made a deterministic decision that a retry can't change.
 *
 * Returns one of:
 *   'timeout' — `ws` handshakeTimeout fired
 *   'reset'   — ECONNRESET / socket hang up
 *   'dns'     — EAI_AGAIN / ENOTFOUND / EAI_NODATA
 *   'refused' — ECONNREFUSED
 *   'network' — ENETUNREACH / EHOSTUNREACH / EPIPE
 *   'http_5xx' (with specific status e.g. 'http_503') — server overload
 *   null      — not retryable
 */
export function _classifyHandshakeError(err) {
    if (!err) return null;
    const code = err.code || '';
    const msg = String(err.message || '');
    const status = Number(err.httpStatus || 0);

    // Permanent HTTP (auth / quota / not-found) short-circuits.
    if (status === 401 || status === 403 || status === 404 || status === 429) {
        return null;
    }
    // 5xx transient.
    if (status >= 500 && status < 600) {
        return `http_${status}`;
    }

    // Node errno codes.
    if (code === 'ECONNRESET') return 'reset';
    if (code === 'EAI_AGAIN' || code === 'ENOTFOUND' || code === 'EAI_NODATA') return 'dns';
    if (code === 'ECONNREFUSED') return 'refused';
    if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
    if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || code === 'EPIPE') return 'network';

    // `ws` library's handshake-timeout path: thrown as a bare Error.
    if (/opening handshake has timed out/i.test(msg)) return 'timeout';
    if (/socket hang up/i.test(msg)) return 'reset';

    return null;
}

/**
 * Classify a mid-stream error for single-shot retry eligibility.
 *
 * Only fires AFTER `response.created` is observed and BEFORE
 * `response.completed`. The window is narrow on purpose: retrying a handshake
 * or a pre-create connect failure is owned by _acquireWithRetry; retrying
 * after completion would replay a finished turn.
 *
 * Retry buckets:
 *   'bridge_stall'       — BridgeStallAbortError from bridge-stall-watchdog
 *   'stream_stalled'     — StreamStalledAbortError from stream-watchdog
 *   'ws_1006'            — abnormal close (connection lost)
 *   'ws_1011'            — server unexpected condition
 *   'ws_1012'            — service restart
 *   'ws_4000'            — our armPreStreamWatchdog close with idle_timeout
 *   'response_failed_network'       — response.failed with network_error
 *   'response_failed_disconnected'  — response.failed with stream_disconnected
 *
 * Deny buckets (return null):
 *   - externalSignal aborted by user (state.userAbort)
 *   - state.sawCompleted === true (already done)
 *   - state.sawResponseCreated === false (still pre-stream; handshake retry
 *     owns that window) — EXCEPT for WS close 1011/1012, which can fire
 *     after the 101 upgrade but before the first response.created event
 *     and are permitted a single mid-stream retry here
 *   - HTTP 401 / 403 / 429 surfaced on the error
 *   - state.attemptIndex >= 1 (we've already retried once)
 */
export function _classifyMidstreamError(err, state) {
    if (!state) return null;
    // Already retried once — single-shot only, no laddering.
    if ((state.attemptIndex | 0) >= 1) return null;
    // Already completed (shouldn't throw, but defensive).
    if (state.sawCompleted) return null;
    // Pre-stream failures normally belong to the handshake retry layer. BUT
    // WS close 1011 / 1012 can fire after the 101 upgrade but BEFORE the
    // first response.created event when the server's keepalive times out or
    // the service restarts. Neither the handshake retry layer (it only sees
    // pre-upgrade failures) nor the existing mid-stream gate covers this
    // window, so permit a single retry here for those two codes only.
    if (!state.sawResponseCreated) {
        const closeCode = Number(err?.wsCloseCode || state.wsCloseCode || 0);
        if (closeCode !== 1011 && closeCode !== 1012) return null;
    }
    // User/caller abort — never retry.
    if (state.userAbort) return null;

    if (!err) return null;
    const status = Number(err?.httpStatus || 0);
    if (status === 401 || status === 403 || status === 429) return null;

    const name = err?.name || '';
    if (name === 'BridgeStallAbortError') return 'bridge_stall';
    if (name === 'StreamStalledAbortError') return 'stream_stalled';

    // Watchdog abort surfaced via externalSignal handler → err is the reason
    // itself. state.watchdogAbort captures the class name when the error
    // shape was preserved but the name was stripped by some wrapper.
    if (state.watchdogAbort === 'BridgeStallAbortError') return 'bridge_stall';
    if (state.watchdogAbort === 'StreamStalledAbortError') return 'stream_stalled';

    // WS close codes: prefer the decorated property, fall back to state.
    const closeCode = Number(err?.wsCloseCode || state.wsCloseCode || 0);
    if (closeCode === 1006) return 'ws_1006';
    if (closeCode === 1011) return 'ws_1011';
    if (closeCode === 1012) return 'ws_1012';
    if (closeCode === 4000) return 'ws_4000';

    // response.failed payload mentioning network_error / stream_disconnected.
    const failed = err?.responseFailed || state.responseFailedPayload;
    if (failed) {
        try {
            const blob = JSON.stringify(failed).toLowerCase();
            if (blob.includes('stream_disconnected')) return 'response_failed_disconnected';
            if (blob.includes('network_error')) return 'response_failed_network';
        } catch {}
    }

    // Unknown → default-deny (don't risk a second full-cost turn for an error
    // class we haven't proven is transient).
    return null;
}

function _backoffFor(attempt) {
    // attempt is 1-based. retry 1 → 500, retry 2 → 1000, retry 3 → 2000 … capped.
    const raw = HANDSHAKE_BACKOFF_BASE_MS * (1 << (attempt - 1));
    return Math.min(raw, HANDSHAKE_BACKOFF_CAP_MS);
}

const _defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `_acquire({auth, poolKey, cacheKey})` with bounded exponential-backoff
 * retry on transient handshake failures. The injection seams (`_acquire`,
 * `_sleepFn`, `onRetry`) let unit tests drive the state machine without
 * opening real sockets.
 *
 * On exhaustion the thrown error is tagged with:
 *   err.attempts         — 1..HANDSHAKE_MAX_ATTEMPTS
 *   err.retryClassifier  — final classifier string, or null for permanent
 */
export async function _acquireWithRetry({
    auth,
    poolKey,
    cacheKey,
    forceFresh,
    onRetry,
    _acquire = acquireWebSocket,
    _sleepFn = _defaultSleep,
} = {}) {
    let lastErr = null;
    let lastClassifier = null;
    for (let attempt = 1; attempt <= HANDSHAKE_MAX_ATTEMPTS; attempt++) {
        try {
            return await _acquire({ auth, poolKey, cacheKey, forceFresh });
        } catch (err) {
            lastErr = err;
            const classifier = _classifyHandshakeError(err);
            lastClassifier = classifier;
            // Permanent (or unknown → default-deny): stop immediately.
            if (!classifier) {
                if (err && typeof err === 'object') {
                    try { err.attempts = attempt; } catch {}
                    try { err.retryClassifier = null; } catch {}
                }
                throw err;
            }
            // Transient but exhausted: surface with tagging.
            if (attempt >= HANDSHAKE_MAX_ATTEMPTS) {
                if (err && typeof err === 'object') {
                    try { err.attempts = attempt; } catch {}
                    try { err.retryClassifier = classifier; } catch {}
                }
                try {
                    process.stderr.write(
                        `[openai-oauth-ws] handshake failed after ${attempt}/${HANDSHAKE_MAX_ATTEMPTS} attempts: ${err?.message || err}\n`,
                    );
                } catch {}
                throw err;
            }
            // Schedule backoff and emit progress.
            const backoff = _backoffFor(attempt);
            try {
                process.stderr.write(
                    `[openai-oauth-ws] worker retry ${attempt}/${HANDSHAKE_MAX_ATTEMPTS} (transient: ${classifier}, backoff ${backoff}ms)\n`,
                );
            } catch {}
            try {
                onRetry?.({
                    attempt,
                    max: HANDSHAKE_MAX_ATTEMPTS,
                    classifier,
                    backoffMs: backoff,
                    error: err,
                });
            } catch {}
            await _sleepFn(backoff);
        }
    }
    // Unreachable — the loop either returns or throws above — but keep the
    // typing honest.
    if (lastErr && typeof lastErr === 'object') {
        try { lastErr.attempts = HANDSHAKE_MAX_ATTEMPTS; } catch {}
        try { lastErr.retryClassifier = lastClassifier; } catch {}
    }
    throw lastErr || new Error('acquireWithRetry: unreachable');
}

/**
 * Dispatch one tool-loop iteration over a per-session cached WebSocket.
 * Returns the same shape as the SSE path: { content, model, toolCalls, usage }.
 */
export async function sendViaWebSocket({
    auth,
    body,
    sendOpts,
    onStreamDelta,
    onToolCall,
    onStageChange,
    externalSignal,
    poolKey,
    cacheKey,
    iteration,
    useModel,
    displayModel,
    // Test seams (undefined in production). Let the unit test drive the
    // retry state machine without opening real sockets or touching the
    // handshake-retry layer.
    _acquireWithRetryFn = _acquireWithRetry,
    _streamFn = _streamResponse,
    _sendFrameFn = null,
}) {
    // Single-shot mid-stream retry: if the first attempt's stream dies after
    // response.created but before response.completed from a transient cause
    // (watchdog abort / ws 1006/1011/1012/4000 / response.failed with network
    // error), tear down the socket and reissue the full request from scratch
    // exactly once. No delta resume — content restarts, which is the accepted
    // tradeoff for reviewer/worker flows that need the complete answer.
    // Retries are layered ABOVE the handshake retry loop (_acquireWithRetry
    // owns connect-level transience); the two never interleave because we
    // force a brand-new acquire for the retry attempt.
    const MAX_MIDSTREAM_RETRIES = 1;
    let firstAttemptError = null;
    let firstAttemptClassifier = null;
    const emittedProgress = [];

    for (let attemptIndex = 0; attemptIndex <= MAX_MIDSTREAM_RETRIES; attemptIndex++) {
        const handshakeStart = Date.now();
        let acquired;
        try { onStageChange?.('requesting'); } catch {}
        try {
            acquired = await _acquireWithRetryFn({
                auth,
                poolKey,
                cacheKey,
                // Retry attempt must not reuse a pooled socket — the prior
                // one is either torn down or in an unknown state.
                forceFresh: attemptIndex > 0,
            });
        } catch (err) {
            if (err?.httpStatus) {
                traceBridgeFetch({
                    sessionId: poolKey,
                    headersMs: Date.now() - handshakeStart,
                    httpStatus: err.httpStatus,
                });
            }
            // Handshake-layer failure. Don't double-wrap: if this is the retry
            // attempt, surface the ORIGINAL first-attempt error (which is what
            // the caller's turn actually tripped on).
            if (attemptIndex > 0 && firstAttemptError) {
                try { firstAttemptError.midstreamRetries = attemptIndex; } catch {}
                throw firstAttemptError;
            }
            throw err;
        }
        const { entry, reused } = acquired;
        traceBridgeFetch({
            sessionId: poolKey,
            headersMs: Date.now() - handshakeStart,
            httpStatus: reused ? 0 : 101,
        });

        const { mode, frame } = _computeDelta({ entry, body });
        const deltaTokens = _estimateFrameTokens(frame);

        try {
            if (_sendFrameFn) _sendFrameFn(entry, frame);
            else entry.socket.send(JSON.stringify(frame));
        } catch (err) {
            releaseWebSocket({ entry, poolKey, keep: false });
            const wrapped = err instanceof Error ? err : new Error(String(err));
            if (attemptIndex > 0 && firstAttemptError) {
                try { firstAttemptError.midstreamRetries = attemptIndex; } catch {}
                throw firstAttemptError;
            }
            throw wrapped;
        }

        try { onStageChange?.('streaming'); } catch {}
        const sseStart = Date.now();
        const midState = {
            attemptIndex,
            sawResponseCreated: false,
            sawCompleted: false,
        };
        let result;
        try {
            result = await _streamFn({
                entry,
                externalSignal,
                onStreamDelta,
                onToolCall,
                state: midState,
            });
        } catch (err) {
            releaseWebSocket({ entry, poolKey, keep: false });
            // Mid-stream classification.
            const classifier = _classifyMidstreamError(err, midState);
            if (classifier && attemptIndex < MAX_MIDSTREAM_RETRIES) {
                // Retry-eligible: stash the first-attempt error, emit progress,
                // and loop. The subsequent acquire uses forceFresh so no socket
                // is shared between attempts.
                firstAttemptError = err;
                firstAttemptClassifier = classifier;
                try { err.midstreamClassifier = classifier; } catch {}
                try {
                    const line = `[openai-oauth-ws] mid-stream recovered: retry ${attemptIndex + 1}/${MAX_MIDSTREAM_RETRIES} (cause: ${classifier})\n`;
                    process.stderr.write(line);
                    emittedProgress.push(line);
                } catch {}
                continue;
            }
            // Not retryable, OR we've already exhausted the one retry.
            if (attemptIndex > 0 && firstAttemptError) {
                // Exhausted path: surface the first-attempt error (the one
                // the user's turn actually tripped on), tag retries=1.
                try { firstAttemptError.midstreamRetries = attemptIndex; } catch {}
                try { firstAttemptError.midstreamClassifier = firstAttemptClassifier; } catch {}
                throw firstAttemptError;
            }
            throw err;
        }
        traceBridgeSse({ sessionId: poolKey, sseParseMs: Date.now() - sseStart });

        // Update cache state for the next iteration in this session.
        if (result.responseId) {
            entry.lastResponseId = result.responseId;
            entry.lastRequestSansInput = _stableStringify(_sansInput(body));
            entry.lastInputLen = Array.isArray(body.input) ? body.input.length : 0;
        }

        const liveModel = result.model || useModel;
        traceBridgeUsage({
            sessionId: poolKey,
            iteration,
            inputTokens: result.usage?.inputTokens || 0,
            outputTokens: result.usage?.outputTokens || 0,
            cachedTokens: result.usage?.cachedTokens || 0,
            promptTokens: result.usage?.promptTokens || 0,
            model: liveModel,
            modelDisplay: displayModel ? displayModel(liveModel) : liveModel,
            responseId: result.responseId || null,
            rawUsage: result.usage?.raw || null,
            provider: 'openai-oauth',
        });
        // Extra WS-specific observability: transport + per-iteration delta bytes.
        try {
            appendBridgeTrace({
                sessionId: poolKey,
                iteration,
                kind: 'transport',
                transport: 'websocket',
                ws_mode: mode,
                iteration_delta_tokens: deltaTokens,
                reused_connection: reused,
                midstream_retries: attemptIndex,
            });
        } catch {}

        releaseWebSocket({ entry, poolKey, keep: true });
        const { responseId: _ignored, ...out } = result;
        // Leave a breadcrumb on the result so downstream callers can observe
        // that a retry was used (0 = first-try success, 1 = one retry used).
        try { Object.defineProperty(out, '__midstreamRetries', { value: attemptIndex, enumerable: false }); } catch {}
        return out;
    }
    // Unreachable — the loop either returns or throws above.
    throw firstAttemptError || new Error('sendViaWebSocket: unreachable');
}

// Test/debug surface — lets callers force-close all pooled sockets (e.g. on
// plugin unload). Not part of the send path.
export function _closeAllPooledSockets(reason = 'shutdown') {
    for (const arr of _wsPool.values()) {
        for (const entry of arr) {
            try { entry.socket.close(1000, reason); } catch {}
        }
    }
    _wsPool.clear();
}
