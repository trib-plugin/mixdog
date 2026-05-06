import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import os from 'os';
import { getPluginData } from './config.mjs';
import { normalizeUsage } from './smart-bridge/cache-obs.mjs';
import { isInclusiveProvider } from '../../shared/llm/cost.mjs';

const WARNED_KEYS = new Set();

// ---------------------------------------------------------------------------
// In-memory buffer + HTTP flush to memory-service /admin/trace-record
// ---------------------------------------------------------------------------
let _buffer = [];
const _BUFFER_MAX = 1000;
const _FLUSH_INTERVAL_MS = 1000;
const _FLUSH_BATCH_SIZE = 100;
let _flushTimer = null;
let _serviceUrl = null;

function _resolveServiceUrl() {
    if (_serviceUrl) return _serviceUrl;
    try {
        const portFile = join(os.tmpdir(), 'mixdog-memory', 'memory-port');
        if (!existsSync(portFile)) return null;
        const port = Number(readFileSync(portFile, 'utf-8').trim());
        if (!Number.isFinite(port) || port <= 0) return null;
        _serviceUrl = `http://127.0.0.1:${port}`;
        return _serviceUrl;
    } catch {
        return null;
    }
}

async function _flush() {
    _flushTimer = null;
    if (_buffer.length === 0) return;
    const url = _resolveServiceUrl();
    if (!url) {
        // Service not up yet — keep buffer, retry next timer tick
        if (!_flushTimer) _flushTimer = setTimeout(_flush, _FLUSH_INTERVAL_MS);
        return;
    }
    const batch = _buffer.splice(0, _FLUSH_BATCH_SIZE);
    try {
        const resp = await fetch(`${url}/admin/trace-record`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ events: batch }),
        });
        if (!resp.ok) {
            warnBridgeOnce('bridge-trace:flush-error', `[bridge-trace] /admin/trace-record returned ${resp.status} — dropping batch`);
        }
    } catch (err) {
        warnBridgeOnce('bridge-trace:flush-fetch', `[bridge-trace] flush fetch failed (${err?.message}) — dropping batch`);
    }
    if (_buffer.length >= _FLUSH_BATCH_SIZE) {
        // More pending — schedule another flush immediately
        setImmediate(_flush);
    }
}

function _scheduleFlush(immediate = false) {
    if (immediate) {
        if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
        setImmediate(_flush);
    } else if (!_flushTimer) {
        _flushTimer = setTimeout(_flush, _FLUSH_INTERVAL_MS);
    }
}

function normalizeSessionId(sessionId) {
    return sessionId ? String(sessionId) : 'no-session';
}

function appendBridgeTrace(record = {}) {
    // Test isolation — when run-all-tests.mjs sets this env, skip entirely.
    if (process.env.MIXDOG_BRIDGE_TRACE_DISABLE === '1') return;
    try {
        // Coerce ts to epoch ms integer at enqueue time
        let ts = record.ts || Date.now();
        if (typeof ts === 'string') ts = Date.parse(ts);
        ts = Number(ts);
        if (!Number.isFinite(ts)) ts = Date.now();

        const row = {
            ...record,
            ts,
            session_id: record.session_id ?? normalizeSessionId(record.sessionId),
            payload: record.payload ?? {},
        };
        // Drop actor-facing alias to keep schema tidy
        delete row.sessionId;

        if (_buffer.length >= _BUFFER_MAX) {
            _buffer.shift(); // drop oldest
            warnBridgeOnce('bridge-trace:buffer-full', '[bridge-trace] buffer full (1000) — dropping oldest event');
        }
        _buffer.push(row);
        _scheduleFlush(_buffer.length >= _FLUSH_BATCH_SIZE);
    }
    catch {
        // Never break bridge execution for telemetry
    }
}

function estimateProviderPayloadBytes(messages, model, tools) {
    try {
        return Buffer.byteLength(JSON.stringify({ model, messages, tools: tools || [] }), 'utf8');
    }
    catch {
        return null;
    }
}

function extractCachedTokens(usage) {
    const candidates = [
        usage?.input_tokens_details?.cached_tokens,
        usage?.prompt_tokens_details?.cached_tokens,
        usage?.inputTokensDetails?.cachedTokens,
        usage?.promptTokensDetails?.cachedTokens,
    ];
    for (const value of candidates) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return 0;
}

function warnBridgeOnce(key, message) {
    if (!key || WARNED_KEYS.has(key)) return;
    WARNED_KEYS.add(key);
    try {
        process.stderr.write(`${message}\n`);
    }
    catch {
        // Ignore logging failures.
    }
}

function traceBridgeLoop({ sessionId, iteration, sendMs, messageCount, bodyBytesEst }) {
    appendBridgeTrace({
        sessionId,
        iteration,
        kind: 'loop',
        send_ms: sendMs,
        message_count: messageCount,
        body_bytes_est: bodyBytesEst,
    });
}

// Lightweight fingerprint of the conversation prefix. Hashes the first 4096
// characters of JSON.stringify(messages) — enough to detect prefix mutation
// across iterations (which invalidates the provider prompt cache) without
// hashing megabytes per turn. Truncated SHA1 keeps the trace row compact.
function messagePrefixHash(messages) {
    try {
        const json = JSON.stringify(messages || []);
        const slice = json.length > 4096 ? json.slice(0, 4096) : json;
        return createHash('sha1').update(slice).digest('hex').slice(0, 12);
    } catch {
        return null;
    }
}

function traceBridgeTrim({
    sessionId,
    iteration,
    prune_count,
    trim_changed,
    input_prefix_hash,
    before_count,
    after_count,
    before_bytes,
    after_bytes,
}) {
    appendBridgeTrace({
        sessionId,
        iteration,
        kind: 'trim_meta',
        prune_count: prune_count ?? 0,
        trim_changed: !!trim_changed,
        input_prefix_hash: input_prefix_hash || null,
        before_count: before_count ?? null,
        after_count: after_count ?? null,
        before_bytes: before_bytes ?? null,
        after_bytes: after_bytes ?? null,
    });
}

const TOOL_ARG_KEYS = {
    read: ['path', 'mode', 'n', 'offset', 'limit', 'full'],
    grep: ['pattern', 'path', 'glob', 'output_mode', 'head_limit', 'offset', 'type', '-i', '-n', '-A', '-B', '-C', 'context', 'multiline'],
    glob: ['pattern', 'path', 'head_limit', 'offset'],
    list: ['path', 'mode', 'depth', 'hidden', 'sort', 'type', 'head_limit', 'offset', 'name', 'min_size', 'max_size', 'modified_after', 'modified_before'],
    find_symbol: ['symbol', 'language', 'limit'],
    find_references: ['symbol', 'file', 'language'],
    find_callers: ['symbol', 'file', 'language'],
    code_graph: ['mode', 'file', 'symbol', 'language', 'limit'],
    bash: ['command', 'timeout', 'run_in_background', 'persistent', 'session_id'],
    job_wait: ['job_id', 'timeout_ms', 'poll_ms'],
    edit: ['path', 'replace_all', 'edits'],
    edit_many: ['edits'],
    write: ['path', 'writes'],
    apply_patch: ['base_path', 'dry_run', 'reject_partial'],
};

const REDACT_KEY_RE = /token|secret|password|passwd|credential|authorization|api[_-]?key/i;
const BODY_KEY_RE = /content|old_string|new_string|patch|rewrite/i;
// Redact bash `command` values that look like they carry secrets.
const SHELL_SECRET_RE = /(?:^|\s)(?:export\s+\w+=\S+|PASSWORD=|SECRET=|TOKEN=|API_KEY=)/i;

function _redactShellCommand(cmd) {
    if (typeof cmd !== 'string') return cmd;
    // Replace assignment RHS that looks like a secret token/password.
    return cmd.replace(/((?:PASSWORD|SECRET|TOKEN|API_KEY|APIKEY)\s*=\s*)\S+/gi, '$1[redacted]');
}

function compactTraceArgValue(value, key = '', depth = 0) {
    if (REDACT_KEY_RE.test(key)) return '[redacted]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        // Redact shell commands that embed secrets before length-truncating.
        if (key === 'command') {
            value = _redactShellCommand(value);
        }
        const limit = BODY_KEY_RE.test(key) ? 60 : 180;
        return value.length > limit ? `${value.slice(0, limit)}...` : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        if (depth >= 2) return `[${value.length} items]`;
        return value.slice(0, 6).map((v) => compactTraceArgValue(v, key, depth + 1));
    }
    if (typeof value === 'object') {
        if (depth >= 2) return '{...}';
        const out = {};
        for (const [k, v] of Object.entries(value).slice(0, 12)) {
            out[k] = compactTraceArgValue(v, k, depth + 1);
        }
        return out;
    }
    return String(value);
}

function summarizeToolArgs(toolName, args) {
    if (!args || typeof args !== 'object') return null;
    const keys = TOOL_ARG_KEYS[String(toolName || '')] || Object.keys(args).slice(0, 8);
    const out = {};
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(args, key)) out[key] = compactTraceArgValue(args[key], key);
    }
    for (const countKey of ['edits', 'writes']) {
        if (Array.isArray(args[countKey])) out[`${countKey}_count`] = args[countKey].length;
    }
    if (toolName === 'read' && Array.isArray(args.path)) {
        out.path_count = args.path.length;
    }
    return Object.keys(out).length ? out : null;
}

function traceBridgeTool({ sessionId, iteration, toolName, toolKind, toolMs, toolArgs }) {
    appendBridgeTrace({
        sessionId,
        iteration,
        kind: 'tool',
        tool_name: toolName,
        tool_kind: toolKind,
        tool_ms: toolMs,
        tool_args: summarizeToolArgs(toolName, toolArgs),
    });
}

// Compression layer trace (result-compression.mjs). One row per tool call
// where compression actually changed the byte count, so `gain` analytics
// can sum savings_pct over a window (mirrors RTK's `rtk gain` model
// without an external binary). No-op rows are dropped at the call site.
export function traceBridgeCompress({ sessionId, toolName, before, after }) {
    appendBridgeTrace({
        sessionId,
        kind: 'compress',
        tool_name: toolName,
        bytes_before: before,
        bytes_after: after,
        savings_pct: before > 0 ? Math.round((1 - after / before) * 100) : 0,
    });
}

// Per-turn batch shape — one row per assistant turn with the number of
// tool calls observed. Lets a consumer compute Lead-side multi-tool
// adoption ratio (calls > 1 / total turns) directly from trace rows
// instead of re-parsing every assistant message body.
export function traceBridgeBatch({ sessionId, toolCallCount }) {
    appendBridgeTrace({
        sessionId,
        kind: 'batch',
        tool_call_count: toolCallCount,
    });
}

function _sanitizeSample(sample, toolName) {
    if (sample == null) return sample;
    if (typeof sample === 'string') {
        return compactTraceArgValue(sample, '', 0);
    }
    if (typeof sample === 'object') {
        return compactTraceArgValue(sample, '', 0);
    }
    return sample;
}

function traceToolLoopDetected({ sessionId, iteration, info }) {
    appendBridgeTrace({
        sessionId,
        iteration,
        kind: 'tool_loop_detected',
        signature: info.signature,
        tool_name: info.toolName,
        error_category: info.errorCategory,
        attempt_count: info.attemptCount,
        args_sample: _sanitizeSample(info.argsSample, info.toolName),
        error_sample: _sanitizeSample(info.errorSample, info.toolName),
    });
}

function traceToolLoopAborted({ sessionId, iteration, info }) {
    appendBridgeTrace({
        sessionId,
        iteration,
        kind: 'tool_loop_aborted',
        signature: info.signature,
        tool_name: info.toolName,
        error_category: info.errorCategory,
        attempt_count: info.attemptCount,
        family_key: info.familyKey || null,
        threshold: info.threshold ?? null,
        tools: Array.isArray(info.tools) ? info.tools : null,
        args_sample: _sanitizeSample(info.argsSample, info.toolName),
        error_sample: _sanitizeSample(info.errorSample, info.toolName),
    });
}

function traceToolLoopWarn({ sessionId, iteration, warnType, info = {} }) {
    appendBridgeTrace({
        sessionId,
        iteration,
        kind: 'tool_loop_warn',
        warn_type: warnType,
        tool_name: info.toolName || null,
        family_key: info.familyKey || null,
        threshold: info.threshold ?? null,
        count: info.count ?? null,
        tools: Array.isArray(info.tools) ? info.tools : null,
    });
}

function traceStreamStalled({ sessionId, info }) {
    appendBridgeTrace({
        sessionId,
        kind: 'stream_stalled',
        stale_seconds: info.staleSeconds,
        last_tool_call: info.lastToolCall,
        stage: info.stage,
    });
}

function traceStreamAborted({ sessionId, info }) {
    appendBridgeTrace({
        sessionId,
        kind: 'stream_aborted',
        stale_seconds: info.staleSeconds,
        last_tool_call: info.lastToolCall,
        stage: info.stage,
    });
}

function traceBridgePreset({ sessionId, role, presetName, model, provider, parentSessionId }) {
    // Fires once per dispatch right after the preset has been resolved and
    // its runtime spec (provider/model) assembled. Useful for after-the-fact
    // routing analysis: "which role landed on which preset / provider / model
    // on this request?"
    appendBridgeTrace({
        sessionId,
        kind: 'preset_assign',
        role: role || null,
        preset_name: presetName || null,
        model: model || null,
        provider: provider || null,
        parent_session_id: parentSessionId || null,
    });
}

function traceBridgeFetch({ sessionId, headersMs, httpStatus }) {
    appendBridgeTrace({
        sessionId,
        kind: 'fetch',
        headers_ms: headersMs,
        http_status: httpStatus,
    });
}

function traceBridgeSse({ sessionId, sseParseMs, ttftMs }) {
    appendBridgeTrace({
        sessionId,
        kind: 'sse',
        sse_parse_ms: sseParseMs,
        ttft_ms: ttftMs,
    });
}

function traceBridgeUsage({ sessionId, iteration, inputTokens, outputTokens, cachedTokens, cacheWriteTokens, promptTokens, model, modelDisplay, responseId, rawUsage, provider }) {
    // Phase H: attach normalized cache observation when provider info is available
    let normalized = undefined;
    if (rawUsage && provider) {
        try {
            normalized = normalizeUsage(provider, rawUsage);
        } catch {
            // cache-obs normalization failed — skip, keep rawUsage intact
        }
    } else if (rawUsage && !provider) {
        warnBridgeOnce(
            'bridge-trace:missing-provider',
            `[bridge-trace] rawUsage present but no provider field — skipping normalizeUsage. Provider should pass {provider: '...'} to traceBridgeUsage.`,
        );
    }
    const inclusive = isInclusiveProvider(provider);
    const inTok = inputTokens || 0;
    const cacheRead = cachedTokens || 0;
    const cacheWrite = cacheWriteTokens || 0;
    const uncachedInputTokens = inclusive ? Math.max(inTok - cacheRead - cacheWrite, 0) : inTok;
    appendBridgeTrace({
        sessionId,
        iteration,
        kind: 'usage_raw',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cached_tokens: cachedTokens,
        cache_write_tokens: cacheWrite,
        uncached_input_tokens: uncachedInputTokens,
        // Unified total-prompt field. Anthropic = input+cache_read+cache_write,
        // OpenAI/Gemini = input_tokens (cached is already a subset).
        prompt_tokens: typeof promptTokens === 'number'
            ? promptTokens
            : (inclusive
                ? Math.max(inTok, cacheRead + cacheWrite)
                : inTok + cacheRead + cacheWrite),
        model: model || null,
        model_display: modelDisplay || null,
        response_id: responseId || null,
        raw_usage: rawUsage || null,
        normalized,
    });
}

function estimateGeminiTokens(contents = []) {
    try {
        let chars = 0;
        for (const item of contents) {
            chars += JSON.stringify(item).length;
        }
        return Math.ceil(chars / 4);
    }
    catch {
        return 0;
    }
}

export {
    appendBridgeTrace,
    estimateGeminiTokens,
    estimateProviderPayloadBytes,
    extractCachedTokens,
    messagePrefixHash,
    traceBridgeFetch,
    traceBridgeLoop,
    traceBridgePreset,
    traceBridgeSse,
    traceBridgeTool,
    traceBridgeTrim,
    traceBridgeUsage,
    traceStreamAborted,
    traceStreamStalled,
    traceToolLoopAborted,
    traceToolLoopDetected,
    traceToolLoopWarn,
    warnBridgeOnce,
};
