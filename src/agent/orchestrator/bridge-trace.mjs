import { appendFileSync, mkdirSync, statSync, renameSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getPluginData } from './config.mjs';
import { normalizeUsage } from './smart-bridge/cache-obs.mjs';
import { isInclusiveProvider } from '../../shared/llm/cost.mjs';

const HISTORY_DIR = join(getPluginData(), 'history');
const TRACE_PATH = join(HISTORY_DIR, 'bridge-trace.jsonl');
const WARNED_KEYS = new Set();

// Rotation — bridge-trace grows a few thousand rows per day. Without a cap
// a single session file reaches hundreds of megabytes over a few months
// and post-hoc analysis tools start choking on it. Rotate on append when
// the live file crosses MAX_TRACE_BYTES, and keep at most MAX_ROTATIONS
// historical shards (older ones are deleted on rotation).
const MAX_TRACE_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_ROTATIONS = 5;                    // keep last 5 rotated shards
const ROTATION_CHECK_EVERY_N = 100;         // cheap size check cadence
let _appendsSinceCheck = 0;

function _rotateIfOversized() {
    try {
        const stat = statSync(TRACE_PATH);
        if (stat.size < MAX_TRACE_BYTES) return;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const rotated = `${TRACE_PATH}.${ts}`;
        renameSync(TRACE_PATH, rotated);
        _pruneOldRotations();
    } catch (err) {
        if (err?.code !== 'ENOENT') {
            // Rotation failure is non-fatal — fall through and keep appending
            // to the original file; next cycle may succeed.
        }
    }
}

function _pruneOldRotations() {
    try {
        const base = `${TRACE_PATH.split(/[\\/]/).pop()}.`;
        const files = readdirSync(HISTORY_DIR)
            .filter(name => name.startsWith(base))
            .sort()
            .reverse(); // newest first (ISO timestamps sort chronologically)
        for (const name of files.slice(MAX_ROTATIONS)) {
            try { unlinkSync(join(HISTORY_DIR, name)); } catch { /* ignore */ }
        }
    } catch { /* best-effort */ }
}

function normalizeSessionId(sessionId) {
    return sessionId ? String(sessionId) : 'no-session';
}

function appendBridgeTrace(record = {}) {
    // Test isolation — when run-all-tests.mjs sets this env, fixture
    // sessionIds (s1..s7, m1..m3) and other test-driven trace events
    // would otherwise pollute the production bridge-trace.jsonl, skewing
    // post-hoc stall / loop analysis. Skip the write entirely.
    if (process.env.MIXDOG_BRIDGE_TRACE_DISABLE === '1') return;
    try {
        mkdirSync(HISTORY_DIR, { recursive: true });
        if (++_appendsSinceCheck >= ROTATION_CHECK_EVERY_N) {
            _appendsSinceCheck = 0;
            if (existsSync(TRACE_PATH)) _rotateIfOversized();
        }
        const row = {
            ts: record.ts || new Date().toISOString(),
            ...record,
            sessionId: normalizeSessionId(record.sessionId),
        };
        appendFileSync(TRACE_PATH, `${JSON.stringify(row)}\n`, 'utf8');
    }
    catch {
        // Never break bridge execution for telemetry.
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

function compactTraceArgValue(value, key = '', depth = 0) {
    if (REDACT_KEY_RE.test(key)) return '[redacted]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
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

function traceToolLoopDetected({ sessionId, iteration, info }) {
    appendBridgeTrace({
        sessionId,
        iteration,
        kind: 'tool_loop_detected',
        signature: info.signature,
        tool_name: info.toolName,
        error_category: info.errorCategory,
        attempt_count: info.attemptCount,
        args_sample: info.argsSample,
        error_sample: info.errorSample,
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
        args_sample: info.argsSample,
        error_sample: info.errorSample,
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

function traceBridgeSse({ sessionId, sseParseMs }) {
    appendBridgeTrace({
        sessionId,
        kind: 'sse',
        sse_parse_ms: sseParseMs,
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
    traceBridgeFetch,
    traceBridgeLoop,
    traceBridgePreset,
    traceBridgeSse,
    traceBridgeTool,
    traceBridgeUsage,
    traceStreamAborted,
    traceStreamStalled,
    traceToolLoopAborted,
    traceToolLoopDetected,
    traceToolLoopWarn,
    warnBridgeOnce,
};
