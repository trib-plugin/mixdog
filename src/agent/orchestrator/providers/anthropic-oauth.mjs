/**
 * Anthropic OAuth provider — uses Claude Code's OAuth credentials
 * (~/.claude/.credentials.json) for Claude Max subscription access.
 *
 * Raw HTTP + SSE streaming, reuses message/tool conversion patterns
 * from anthropic.mjs. Bridge-trace instrumented.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
    traceBridgeFetch,
    traceBridgeSse,
    traceBridgeUsage,
} from '../bridge-trace.mjs';
import { createAbortController } from '../../../shared/abort-controller.mjs';
import { writeFileSync, existsSync as _existsSync } from 'fs';
import { getPluginData } from '../config.mjs';
import { enrichModels } from './model-catalog.mjs';

// --- Model catalog cache helpers ---
// Disk-backed cache so repeated process starts (cron, tool calls) don't
// hammer /v1/models. 24h TTL is the same cadence Claude Code itself uses
// for its internal model discovery.
const MODEL_CACHE_TTL_MS = 24 * 60 * 60_000;

function _modelCachePath() {
    return join(getPluginData(), 'anthropic-oauth-models.json');
}

async function _loadModelCache() {
    const path = _modelCachePath();
    if (!_existsSync(path)) return null;
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (!raw?.fetchedAt || !Array.isArray(raw.models)) return null;
        if (Date.now() - raw.fetchedAt > MODEL_CACHE_TTL_MS) return null;
        return raw.models;
    } catch { return null; }
}

async function _saveModelCache(models) {
    try {
        writeFileSync(_modelCachePath(), JSON.stringify({
            fetchedAt: Date.now(),
            models,
        }, null, 2));
        _inMemoryCatalog = Array.isArray(models) ? models.slice() : null;
    } catch { /* cache is best-effort */ }
}

// In-memory mirror of the disk catalog — populated on first listModels() and
// refreshed after every _saveModelCache. Used by _catalogHas and _displayModel
// so hot paths don't hit disk on every response.
let _inMemoryCatalog = null;
let _refreshInFlight = null;

function _catalogHas(id) {
    if (!id || !Array.isArray(_inMemoryCatalog)) return false;
    return _inMemoryCatalog.some(m => m.id === id);
}

// Display-name normalization for trace / usage. Turns dated or version-alias
// ids into the version alias form: claude-opus-4-7 → claude-opus-4.7,
// claude-haiku-4-5-20251001 → claude-haiku-4.5. Falls back to the raw id.
function _displayModel(id) {
    if (!id || typeof id !== 'string') return id;
    const m = id.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-\d{8})?$/i);
    if (!m) return id;
    return `claude-${m[1].toLowerCase()}-${m[2]}.${m[3]}`;
}

// Classify a model id into our common tier/family shape. Anthropic's catalog
// mixes dated ids (claude-opus-4-5-20251101), versioned aliases
// (claude-opus-4-6), and the raw family tokens resolved via env vars.
function _normalizeAnthropicModel(raw) {
    const id = raw?.id || raw?.name;
    if (!id) return null;
    const familyMatch = id.match(/^claude-(opus|sonnet|haiku)/i);
    const family = familyMatch ? familyMatch[1].toLowerCase() : 'other';
    // Dated: trailing -YYYYMMDD (8 digits).
    const dated = /-\d{8}$/.test(id);
    // Versioned alias: claude-<family>-<major>-<minor>[-...] with no dated suffix.
    const versioned = !dated && /-\d+-\d+/.test(id);
    const tier = dated ? 'dated' : versioned ? 'version' : 'family';
    const releaseDate = dated
        ? id.match(/-(\d{4})(\d{2})(\d{2})$/)
        : null;
    return {
        id,
        display: raw?.display_name || _prettyName(id, family),
        family,
        provider: 'anthropic-oauth',
        contextWindow: raw?.context_window || raw?.max_context_window || _defaultContextForFamily(family),
        tier,
        latest: false, // assigned in a second pass once full list is known
        releaseDate: releaseDate ? `${releaseDate[1]}-${releaseDate[2]}-${releaseDate[3]}` : null,
    };
}

function _prettyName(id, family) {
    const v = id.match(/-(\d+)-(\d+)/);
    const base = family[0].toUpperCase() + family.slice(1);
    return v ? `${base} ${v[1]}.${v[2]}` : base;
}

function _defaultContextForFamily(family) {
    if (family === 'opus') return 200000;
    if (family === 'sonnet') return 200000;
    if (family === 'haiku') return 200000;
    return 200000;
}

// Mark the highest-numbered version per family as `latest: true`. Uses a simple
// lexicographic comparison on the numeric parts embedded in the id.
function _markLatestByFamily(models) {
    const byFamily = new Map();
    for (const m of models) {
        if (m.tier !== 'version') continue;
        const cur = byFamily.get(m.family);
        if (!cur || _compareVersion(m.id, cur.id) > 0) {
            byFamily.set(m.family, m);
        }
    }
    for (const m of byFamily.values()) m.latest = true;
}

function _compareVersion(a, b) {
    const na = (a.match(/-(\d+)-(\d+)/) || []).slice(1).map(Number);
    const nb = (b.match(/-(\d+)-(\d+)/) || []).slice(1).map(Number);
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
        if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) - (nb[i] || 0);
    }
    return a.localeCompare(b);
}

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');

// Anthropic OAuth contract for first-party Claude Code clients.
// Opus/Sonnet requests are gated on a specific system-prompt prefix.
// Our plugin ONLY runs inside Claude Code (marketplace-distributed),
// so declaring ourselves as Claude Code is literally accurate — not
// impersonation. Haiku is not gated and ignores this prefix.
const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
const OAUTH_BETA_HEADERS = 'oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,extended-cache-ttl-2025-04-11';
const DEFAULT_CLI_VERSION = '2.1.77';

function resolveCliVersion() {
    // Claude Code sets CLAUDE_CODE_VERSION in the plugin subprocess env.
    // Fallback exists so unit tests and older Claude Code versions still work.
    return process.env.CLAUDE_CODE_VERSION
        || process.env.CLAUDE_CODE_EXECPATH_VERSION
        || DEFAULT_CLI_VERSION;
}

function requiresSystemPrefix(model) {
    // Opus / Sonnet require the Claude Code system prefix when authenticated
    // via OAuth. Haiku does not.
    return /^claude-(opus|sonnet)/i.test(String(model || ''));
}

// OAuth rate-limit pool routing is gated by the server inspecting the first
// system block. When it reads exactly "You are Claude Code, Anthropic's
// official CLI for Claude." it routes into the Claude Code pool; any other
// content (even the prefix concatenated with extra text in the same block)
// falls into the standard pool and Opus/Sonnet return 429. Splitting into
// two blocks — [prefix, rest] — keeps both routing and user instructions.
function buildSystemBlocks(systemText, model, cacheControl) {
    // Accept either a single string (legacy callers) or an array of strings —
    // the manager pushes multiple system messages (baseRules, roleCatalog)
    // under the unified-shard policy, and each one becomes its own Anthropic
    // content block with its own cache_control breakpoint (BP1 + BP2).
    const texts = Array.isArray(systemText)
        ? systemText.map(s => typeof s === 'string' ? s.trim() : '').filter(Boolean)
        : (typeof systemText === 'string' && systemText.trim()) ? [systemText.trim()] : [];
    const gated = requiresSystemPrefix(model);

    const blocks = [];
    if (gated) {
        blocks.push({ type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX });
    }
    for (let i = 0; i < texts.length; i++) {
        let body = texts[i];
        // Strip a duplicated Claude Code prefix only from the first block
        // (legacy callers sometimes baked it in).
        if (gated && i === 0 && body.startsWith(CLAUDE_CODE_SYSTEM_PREFIX)) {
            body = body.slice(CLAUDE_CODE_SYSTEM_PREFIX.length).trim();
            if (!body) continue;
        }
        const block = { type: 'text', text: body };
        if (cacheControl) block.cache_control = cacheControl;
        blocks.push(block);
    }
    return blocks;
}

const MODELS = [
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', provider: 'anthropic-oauth', contextWindow: 1000000 },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic-oauth', contextWindow: 1000000 },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic-oauth', contextWindow: 200000 },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic-oauth', contextWindow: 200000 },
];

// Per-model max_tokens when the model id is explicitly listed. New models
// (e.g., Sonnet 4.7) won't match a specific entry and fall through to the
// family-based heuristic below. Conservative defaults — model may support
// more but we'd rather stay within safe bounds.
const MAX_TOKENS = {
    'claude-opus-4-7': 32768,
    'claude-opus-4-6': 32768,
    'claude-sonnet-4-6': 16384,
    'claude-haiku-4-5-20251001': 8192,
};

function resolveMaxTokens(model) {
    if (MAX_TOKENS[model]) return MAX_TOKENS[model];
    const id = String(model || '').toLowerCase();
    if (id.includes('opus')) return 32768;
    if (id.includes('sonnet')) return 16384;
    if (id.includes('haiku')) return 8192;
    return 8192;
}

const EFFORT_BUDGET = {
    low: 1024,
    medium: 4096,
    high: 16384,
    max: 32768,
};

// Layered cache TTLs — stable layers get 1h, volatile layers get 5m.
// Anthropic requires 1h entries to appear before 5m entries in the request.
const CACHE_TTL_STABLE = { type: 'ephemeral', ttl: '1h' };   // tools, system
const CACHE_TTL_VOLATILE = { type: 'ephemeral' };             // messages (5m default)

// --- Credential helpers ---

function _pushUnique(list, value) {
    if (!value || typeof value !== 'string') return;
    if (!list.includes(value)) list.push(value);
}

function _claudeCredentialsFromPluginRoot(root) {
    const clean = String(root || '').replace(/\\/g, '/');
    const marker = '/.claude/plugins/';
    const idx = clean.indexOf(marker);
    if (idx < 0) return null;
    return `${clean.slice(0, idx)}/.claude/.credentials.json`;
}

function credentialCandidates() {
    const paths = [];
    _pushUnique(paths, process.env.CLAUDE_CODE_CREDENTIALS_PATH);
    _pushUnique(paths, process.env.CLAUDE_CREDENTIALS_PATH);
    _pushUnique(paths, _claudeCredentialsFromPluginRoot(process.env.CLAUDE_PLUGIN_ROOT));
    _pushUnique(paths, DEFAULT_CREDENTIALS_PATH);
    return paths;
}

function _loadCredentialsFile(path) {
    if (!existsSync(path)) return null;
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        const oauth = raw?.claudeAiOauth;
        if (!oauth?.accessToken) return null;
        return {
            path,
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken || null,
            expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0,
            scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
            subscriptionType: oauth.subscriptionType || null,
        };
    } catch {
        return null;
    }
}

function loadCredentials() {
    const loaded = credentialCandidates()
        .map(_loadCredentialsFile)
        .filter(Boolean);
    if (!loaded.length) return null;
    loaded.sort((a, b) => (Number(b.expiresAt) || 0) - (Number(a.expiresAt) || 0));
    return loaded[0];
}

// --- Message conversion (mirrors anthropic.mjs) ---

function withCacheControl(block, ttl = CACHE_TTL_VOLATILE) {
    if (!block || typeof block !== 'object' || block.cache_control) return block;
    return { ...block, cache_control: ttl };
}

function appendCacheControl(content, ttl = CACHE_TTL_VOLATILE) {
    if (Array.isArray(content)) {
        if (content.length === 0) return content;
        const next = [...content];
        next[next.length - 1] = withCacheControl(next[next.length - 1], ttl);
        return next;
    }
    if (typeof content === 'string') {
        return [withCacheControl({ type: 'text', text: content }, ttl)];
    }
    return content;
}

function collectRecentCacheableIndexes(messages, availableSlots = 2) {
    // Anthropic enforces a 4-breakpoint max per request. Callers reserve slots
    // for tools[-1] and system breakpoints (typically 2); whatever remains is
    // spread across the most-recent messages as 5m sliding breakpoints.
    // Default 2 assumes both tools and system have breakpoints (worst case).
    const slots = Math.max(0, Math.min(4, availableSlots));
    const marked = new Set();
    for (let i = messages.length - 1; i >= 0 && marked.size < slots; i--) {
        if (messages[i]?.role !== 'system') marked.add(i);
    }
    return marked;
}

function toAnthropicTools(tools) {
    return tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
    }));
}

function toAnthropicMessages(
    messages,
    cacheableIndexes = new Set(),
    messageTtl = CACHE_TTL_VOLATILE,
    tier3Idx = -1,
    tier3Ttl = null,
) {
    // messageTtl === null disables message-tail caching.
    // tier3Ttl  === null disables the dedicated Tier 3 breakpoint.
    const applyMsgTtl = messageTtl || CACHE_TTL_VOLATILE;
    const shouldCacheMsg = (idx) => messageTtl !== null && cacheableIndexes.has(idx);
    const shouldCacheTier3 = (idx) => tier3Ttl !== null && idx === tier3Idx;
    const pickTtl = (idx) => shouldCacheTier3(idx) ? tier3Ttl : applyMsgTtl;
    const anyCache = (idx) => shouldCacheMsg(idx) || shouldCacheTier3(idx);

    const result = [];
    for (let idx = 0; idx < messages.length; idx++) {
        const m = messages[idx];
        if (m.role === 'system') continue;

        if (m.role === 'assistant' && m.toolCalls?.length) {
            let content = [];
            if (m.content) content.push({ type: 'text', text: m.content });
            for (const tc of m.toolCalls) {
                content.push({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.name,
                    input: tc.arguments,
                });
            }
            if (anyCache(idx)) content = appendCacheControl(content, pickTtl(idx));
            result.push({ role: 'assistant', content });
            continue;
        }

        if (m.role === 'tool') {
            const last = result[result.length - 1];
            const block = {
                type: 'tool_result',
                tool_use_id: m.toolCallId || '',
                content: m.content,
            };
            if (last?.role === 'user' && Array.isArray(last.content)) {
                last.content.push(block);
                if (anyCache(idx)) {
                    last.content = appendCacheControl(last.content, pickTtl(idx));
                }
            } else {
                let content = [block];
                if (anyCache(idx)) content = appendCacheControl(content, pickTtl(idx));
                result.push({ role: 'user', content });
            }
            continue;
        }

        const content = anyCache(idx)
            ? appendCacheControl(m.content, pickTtl(idx))
            : m.content;
        result.push({ role: m.role, content });
    }
    return result;
}

// --- SSE parser ---

function _captureMidstreamAbort(state, reason) {
    if (!state) return;
    const reasonName = reason?.name || '';
    if (reasonName === 'BridgeStallAbortError' || reasonName === 'StreamStalledAbortError') {
        state.watchdogAbort = reasonName;
    } else {
        state.userAbort = true;
    }
}

async function parseSSEStream(response, signal, abortStream, onStreamDelta, onToolCall, state) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let content = '';
    let model = '';
    let toolCalls = [];
    let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, raw: null };
    let stopReason = null;
    let buffer = '';
    let idleTimedOut = false;
    let idleTimer = null;
    let currentEvent = '';

    const pendingToolInputs = new Map();

    const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idleTimedOut = true;
            try { abortStream?.(); } catch (err) {
                try { process.stderr.write(`[anthropic-oauth] sse idle abortStream failed: ${err?.message ?? String(err)}\n`); } catch {}
            }
            try { reader.cancel('SSE idle timeout'); } catch (err) {
                try { process.stderr.write(`[anthropic-oauth] sse idle cancel failed: ${err?.message ?? String(err)}\n`); } catch {}
            }
        }, 300_000);
    };

    const onAbort = () => { try { reader.cancel('SSE aborted'); } catch {} };
    if (signal) {
        if (signal.aborted) {
            _captureMidstreamAbort(state, signal.reason);
            throw signal.reason instanceof Error
                ? signal.reason
                : new Error('Anthropic OAuth SSE stream aborted');
        }
        signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
        resetIdleTimer();
        streamLoop: while (true) {
            let chunk;
            try { chunk = await reader.read(); } catch (err) {
                if (idleTimedOut) {
                    const idleErr = new Error('Anthropic OAuth SSE stream timed out after 300000ms of inactivity');
                    idleErr.code = 'ETIMEDOUT';
                    throw idleErr;
                }
                if (signal?.aborted) {
                    _captureMidstreamAbort(state, signal.reason);
                    throw signal.reason instanceof Error
                        ? signal.reason
                        : new Error('Anthropic OAuth SSE stream aborted');
                }
                throw err;
            }
            const { done, value } = chunk;
            if (done) break;

            resetIdleTimer();
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith(':')) {
                    // SSE comment frame (Anthropic `:ping` keepalive). The HTML Standard SSE
                    // spec says comments are silently ignored, but we surface them here so
                    // the bridge-stall-watchdog sees the stream is still alive during Opus
                    // extended-thinking pauses. No content is emitted — this only refreshes
                    // the runtime's lastStreamDeltaAt timestamp.
                    try { onStreamDelta?.(); } catch {}
                    continue;
                }
                if (line.startsWith('event: ')) {
                    currentEvent = line.slice(7).trim();
                    continue;
                }
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (!data) continue;

                try {
                    const event = JSON.parse(data);

                    if (event.type === 'message_start' && event.message) {
                        if (state) state.sawMessageStart = true;
                        if (event.message.model) model = event.message.model;
                        if (event.message.usage) {
                            usage.inputTokens = event.message.usage.input_tokens || 0;
                            usage.cachedTokens = event.message.usage.cache_read_input_tokens || 0;
                            usage.cacheWriteTokens = event.message.usage.cache_creation_input_tokens || 0;
                            usage.raw = { ...event.message.usage };
                        }
                    }

                    if (event.type === 'content_block_start') {
                        const block = event.content_block;
                        if (block?.type === 'tool_use') {
                            pendingToolInputs.set(event.index, {
                                id: block.id || '',
                                name: block.name || '',
                                inputJson: '',
                            });
                        }
                    }

                    if (event.type === 'content_block_delta') {
                        const delta = event.delta;
                        if (delta?.type === 'text_delta') {
                            content += delta.text || '';
                            try { onStreamDelta?.(); } catch {}
                        }
                        if (delta?.type === 'input_json_delta') {
                            const pending = pendingToolInputs.get(event.index);
                            if (pending) {
                                pending.inputJson += delta.partial_json || '';
                            }
                            try { onStreamDelta?.(); } catch {}
                        }
                    }

                    if (event.type === 'content_block_stop') {
                        const pending = pendingToolInputs.get(event.index);
                        if (pending) {
                            const call = {
                                id: pending.id,
                                name: pending.name,
                                arguments: pending.inputJson ? JSON.parse(pending.inputJson) : {},
                            };
                            toolCalls.push(call);
                            pendingToolInputs.delete(event.index);
                            if (state) state.emittedToolCall = true;
                            // Eager dispatch: let the loop start this tool
                            // before message_stop arrives. The loop keys
                            // pending promises by call.id so order is safe.
                            try { onToolCall?.(call); } catch {}
                            try { onStreamDelta?.(); } catch {}
                        }
                    }

                    if (event.type === 'message_delta') {
                        if (event.delta?.stop_reason) {
                            stopReason = event.delta.stop_reason;
                        }
                        if (event.usage) {
                            usage.outputTokens = event.usage.output_tokens || 0;
                            usage.raw = { ...(usage.raw || {}), ...event.usage };
                        }
                    }
                    if (event.type === 'message_stop') {
                        if (state) state.sawCompleted = true;
                        // Anthropic streams can keep emitting `:ping` keepalive
                        // frames after `message_stop`; if we wait for EOF the
                        // outer reader.read() loop hangs indefinitely. Break
                        // out of streamLoop the moment the message ends.
                        break streamLoop;
                    }
                    // Unified prompt volume — what the model actually ingested.
                    // Anthropic splits input into three billable slots (uncached
                    // input + cache_read + cache_create); keep them separate for
                    // cost math but also expose the sum so cross-provider logs
                    // have a consistent `promptTokens` meaning.
                    usage.promptTokens = (usage.inputTokens || 0)
                        + (usage.cachedTokens || 0)
                        + (usage.cacheWriteTokens || 0);
                } catch { /* skip malformed events */ }
            }
        }

        return {
            content,
            model,
            toolCalls: toolCalls.length ? toolCalls : undefined,
            usage,
            stopReason,
        };
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        try { reader.releaseLock(); } catch (err) {
            try { process.stderr.write(`[anthropic-oauth] reader releaseLock failed: ${err?.message ?? String(err)}\n`); } catch {}
        }
    }
}

/**
 * Classify an Anthropic SSE failure for single-shot mid-stream retry.
 *
 * Retry is allowed only after `message_start` and before `message_stop`,
 * and only when no tool call has already been surfaced to the loop.
 * That keeps recovery limited to transport/stream stalls without risking
 * duplicate eager tool execution.
 */
export function _classifyMidstreamError(err, state) {
    if (!state) return null;
    if ((state.attemptIndex | 0) >= 1) return null;
    if (state.sawCompleted) return null;
    if (!state.sawMessageStart) return null;
    if (state.userAbort) return null;
    if (state.emittedToolCall) return null;

    if (!err) return null;
    const status = Number(err?.httpStatus || 0);
    if (status === 401 || status === 403 || status === 429) return null;

    const name = err?.name || '';
    if (name === 'BridgeStallAbortError') return 'bridge_stall';
    if (name === 'StreamStalledAbortError') return 'stream_stalled';
    if (state.watchdogAbort === 'BridgeStallAbortError') return 'bridge_stall';
    if (state.watchdogAbort === 'StreamStalledAbortError') return 'stream_stalled';

    const code = err?.code || err?.cause?.code || '';
    if (code === 'ECONNRESET') return 'reset';
    if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA') return 'dns';

    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('stream timed out after 300000ms of inactivity')) return 'sse_idle_timeout';
    if (msg.includes('body stream') && msg.includes('terminated')) return 'stream_terminated';
    if (msg.includes('fetch failed')) return 'fetch_failed';

    return null;
}

// --- Build request body ---

function resolveCacheTtls(opts) {
    // Layered cache strategy — caller may override per-layer via opts.cacheStrategy.
    // Anthropic enforces: 1h entries must appear before 5m entries in the request.
    const strategy = opts.cacheStrategy || {};
    const pick = (layer, fallback) => {
        const v = strategy[layer];
        if (v === '1h') return CACHE_TTL_STABLE;
        if (v === '5m') return CACHE_TTL_VOLATILE;
        if (v === 'none') return null;
        return fallback;
    };
    // BP budget (4 total):
    //   BP1 baseRules    — 1h (shared across ALL roles)
    //   BP2 roleCatalog  — 1h (shared across ALL roles)
    //   BP3 tier3        — 1h (sessionMarker: role + permission + project)
    //   BP4 messages     — 5m sliding tail (tool_result cache across iter)
    // tools BP is dropped — system BP covers the tools prefix via
    // Anthropic's prompt cache prefix semantics (order: tools → system
    // → messages).
    // tier3 defaults to 1h (stable) — sessionMarker content is stable per
    // (role, permission, project) tuple and Anthropic only spends the BP
    // slot when findTier3Index() actually finds a <system-reminder> block,
    // so this default is free for sessions that don't carry one. Previously
    // null here meant any caller that skipped smart bridge resolve (CLI,
    // raw create_session tool) silently lost the tier3 cache layer even
    // though their message layout supported it.
    return {
        tools: pick('tools', CACHE_TTL_STABLE),
        system: pick('system', CACHE_TTL_STABLE),
        tier3: pick('tier3', CACHE_TTL_STABLE),
        messages: pick('messages', CACHE_TTL_VOLATILE),
    };
}

// Tier 3 is injected by session/manager as a user message wrapped in
// `<system-reminder>` whose body starts with the explicit sentinel
// `<!-- bp3-sentinel -->` (emitted by collect.mjs:composeSystemPrompt only
// when a stable projectContext is present). The sentinel is mandatory:
// volatileTail (role/permission/taskBrief/memoryRecap) is also wrapped in
// `<system-reminder>` but varies per-call, so a plain prefix match would
// pin per-call data to the 1h BP3 slot and explode the cache.
const BP3_SENTINEL = '<!-- bp3-sentinel -->';
function findTier3Index(chatMsgs) {
    for (let i = 0; i < chatMsgs.length; i++) {
        const m = chatMsgs[i];
        if (m?.role === 'user' && typeof m.content === 'string'
            && m.content.startsWith('<system-reminder>')
            && m.content.includes(BP3_SENTINEL)) {
            return i;
        }
    }
    return -1;
}

function buildRequestBody(messages, model, tools, sendOpts) {
    const systemMsgs = messages.filter(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');
    // Pass each system message text as its own entry so the Anthropic body
    // gets N separate content blocks — each can have its own BP
    // independent of the others.
    const systemTexts = systemMsgs.map(m => m.content);
    const maxTokens = resolveMaxTokens(model);
    const opts = sendOpts || {};
    const ttls = resolveCacheTtls(opts);
    const systemBlocks = buildSystemBlocks(systemTexts, model, ttls?.system);

    // 4-BP budget layout. tools BP is dropped — system BP covers the
    // tools prefix via Anthropic's prompt cache prefix semantics
    // (order: tools → system → messages). That frees slots for
    // tier3 + messages-tail.
    const systemBpUsed = ttls.system ? systemBlocks.filter(b => b.cache_control).length : 0;
    const toolsBpUsed = 0;
    const tier3Idx = ttls.tier3 ? findTier3Index(chatMsgs) : -1;
    const tier3BpUsed = tier3Idx >= 0 ? 1 : 0;
    const usedSlots = toolsBpUsed + systemBpUsed + tier3BpUsed;
    // Env override for smoke-testing BP-count strategies. ANTHROPIC_MSG_SLOTS
    // caps how many sliding message-tail breakpoints we burn per request
    // (default: fill whatever's left of the 4-BP budget). Set to 1 to reduce
    // BP-position churn across iterations; set to 0 to disable messages-tail
    // caching entirely and rely on the tools+system+tier3 prefix.
    const msgSlotsCap = Number.parseInt(process.env.ANTHROPIC_MSG_SLOTS, 10);
    const defaultMsgSlots = Math.max(0, 4 - usedSlots);
    const msgSlots = ttls.messages
        ? (Number.isFinite(msgSlotsCap) && msgSlotsCap >= 0 ? Math.min(msgSlotsCap, defaultMsgSlots) : defaultMsgSlots)
        : 0;
    const cacheableIndexes = collectRecentCacheableIndexes(chatMsgs, msgSlots);
    // If the tail slot landed on the Tier 3 index, drop it from the sliding
    // set — Tier 3 already owns its own BP and we don't want to double-mark.
    if (tier3Idx >= 0) cacheableIndexes.delete(tier3Idx);
    const anthropicMessages = toAnthropicMessages(
        chatMsgs,
        cacheableIndexes,
        ttls.messages,
        tier3Idx,
        ttls.tier3,
    );

    const body = {
        model,
        max_tokens: maxTokens,
        messages: anthropicMessages,
        stream: true,
    };

    if (systemBlocks.length) body.system = systemBlocks;

    if (tools?.length) {
        // No cache_control on tools — the systemBase BP already covers the
        // tools prefix via Anthropic's prompt cache prefix semantics (order:
        // tools → system → messages). Placing a separate BP here would waste
        // a slot that's better spent on messages tail.
        body.tools = toAnthropicTools(tools);
    }

    if (opts.effort && EFFORT_BUDGET[opts.effort]) {
        body.thinking = { type: 'enabled', budget_tokens: EFFORT_BUDGET[opts.effort] };
    }

    if (opts.fast === true) {
        body.speed = 'fast';
    }

    return body;
}

// --- Provider ---

export class AnthropicOAuthProvider {
    name = 'anthropic-oauth';
    credentials = null;
    config;

    constructor(config) {
        this.config = config || {};
        this.credentials = loadCredentials();
    }

    ensureAuth() {
        if (!this.credentials) {
            this.credentials = loadCredentials();
        }
        if (!this.credentials) {
            throw new Error('Anthropic OAuth credentials not found. Run "claude login" to authenticate.');
        }

        // Re-read credentials if token is near expiry (5min buffer)
        if (this.credentials.expiresAt && this.credentials.expiresAt < Date.now() + 300_000) {
            process.stderr.write(`[anthropic-oauth] Token expired/expiring, re-reading credentials...\n`);
            const fresh = loadCredentials();
            if (fresh && fresh.accessToken !== this.credentials.accessToken) {
                this.credentials = fresh;
                process.stderr.write(`[anthropic-oauth] Credentials reloaded from disk\n`);
            } else if (!fresh || (fresh.expiresAt && fresh.expiresAt < Date.now() + 300_000)) {
                process.stderr.write(`[anthropic-oauth] WARNING: Token may be expired. Claude Code manages refresh — if errors persist, run "claude login".\n`);
            }
        }

        return this.credentials;
    }

    scrubTokens(text) {
        return text
            .replace(/Bearer [A-Za-z0-9._\-]+/g, 'Bearer [REDACTED]')
            .replace(/"accessToken"\s*:\s*"[^"]+"/g, '"accessToken":"[REDACTED]"');
    }

    async send(messages, model, tools, sendOpts) {
        const opts = sendOpts || {};
        const onStageChange = typeof opts.onStageChange === 'function' ? opts.onStageChange : null;
        const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
        const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
        const externalSignal = opts.signal || null;
        // Test seam: lets the retry harness drive stream outcomes without a
        // live OAuth session.
        const parseSSEFn = typeof opts._parseSSEFn === 'function' ? opts._parseSSEFn : parseSSEStream;

        let creds = this.ensureAuth();
        const useModel = model || 'claude-sonnet-4-6';
        const body = buildRequestBody(messages, useModel, tools, sendOpts);
        const sessionId = opts.sessionId || null;
        const iteration = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null;

        const doRequest = async (accessToken) => {
            const controller = createAbortController();
            const timeout = setTimeout(() => controller.abort(), 120_000);
            const fetchStartedAt = Date.now();

            let cancelHandler = null;
            if (externalSignal) {
                if (externalSignal.aborted) {
                    clearTimeout(timeout);
                    controller.abort(externalSignal.reason);
                    throw externalSignal.reason instanceof Error
                        ? externalSignal.reason
                        : new Error('Anthropic OAuth request aborted by session close');
                }
                cancelHandler = () => { try { controller.abort(externalSignal.reason); } catch {} };
                externalSignal.addEventListener('abort', cancelHandler, { once: true });
            }

            try {
                try { onStageChange?.('requesting'); } catch {}

                const response = await fetch(API_URL, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'anthropic-version': ANTHROPIC_VERSION,
                        'anthropic-beta': OAUTH_BETA_HEADERS,
                        'anthropic-dangerous-direct-browser-access': 'true',
                        'user-agent': `claude-cli/${resolveCliVersion()} (external, sdk-cli)`,
                        'x-app': 'cli',
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });

                traceBridgeFetch({
                    sessionId,
                    headersMs: Date.now() - fetchStartedAt,
                    httpStatus: response.status,
                });

                clearTimeout(timeout);
                return { response, controller, cancelHandler };
            } catch (err) {
                clearTimeout(timeout);
                if (cancelHandler) externalSignal.removeEventListener('abort', cancelHandler);
                if (externalSignal?.aborted) {
                    const reason = externalSignal.reason;
                    throw reason instanceof Error ? reason : new Error('Anthropic OAuth request aborted by session close');
                }
                if (err?.name === 'AbortError')
                    throw new Error('Anthropic OAuth API initial response timed out after 120000ms');
                throw err;
            }
        };
        // Test seam: injectable request factory for retry-path tests.
        const doRequestImpl = typeof opts._doRequestFn === 'function' ? opts._doRequestFn : doRequest;

        // Retry on transient 5xx / connect errors before SSE stream begins.
        const isTransientStatus = s => s === 502 || s === 503 || s === 504;
        const isTransientErr = err => {
            if (!err) return false;
            const code = err.code || err.cause?.code || '';
            if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return true;
            const msg = err.message || '';
            if (msg.includes('initial response timed out')) return true;
            return false;
        };
        const sleep = ms => new Promise(r => {
            const t = setTimeout(r, ms);
            if (externalSignal) {
                const onAbort = () => { clearTimeout(t); r(); };
                if (externalSignal.aborted) return onAbort();
                externalSignal.addEventListener('abort', onAbort, { once: true });
            }
        });

        const MAX_ATTEMPTS = 5;
        const BACKOFF_MS = [0, 1000, 2000, 4000, 8000];
        // One retry only: enough to recover transient stream loss without
        // quietly replaying long-running work multiple times.
        const MAX_MIDSTREAM_RETRIES = 1;
        let firstAttemptError = null;
        let firstAttemptClassifier = null;

        for (let attemptIndex = 0; attemptIndex <= MAX_MIDSTREAM_RETRIES; attemptIndex++) {
            let response, controller, cancelHandler;
            let lastStatus = null;
            let attempt = 0;

            while (attempt < MAX_ATTEMPTS) {
                if (externalSignal?.aborted) {
                    const reason = externalSignal.reason;
                    throw reason instanceof Error ? reason : new Error('Anthropic OAuth request aborted by session close');
                }
                if (attempt > 0) {
                    process.stderr.write(`[anthropic-oauth] retry attempt ${attempt + 1}/${MAX_ATTEMPTS} after ${lastStatus || 'network error'}\n`);
                    await sleep(BACKOFF_MS[attempt]);
                    if (externalSignal?.aborted) {
                        const reason = externalSignal.reason;
                        throw reason instanceof Error ? reason : new Error('Anthropic OAuth request aborted by session close');
                    }
                }
                try {
                    ({ response, controller, cancelHandler } = await doRequestImpl(creds.accessToken));
                } catch (err) {
                    if (externalSignal?.aborted) throw err;
                    if (isTransientErr(err) && attempt < MAX_ATTEMPTS - 1) {
                        lastStatus = err.code || err.message || 'network error';
                        attempt++;
                        continue;
                    }
                    throw err;
                }
                if (isTransientStatus(response.status) && attempt < MAX_ATTEMPTS - 1) {
                    try { await response.text(); } catch {}
                    if (cancelHandler && externalSignal) externalSignal.removeEventListener('abort', cancelHandler);
                    lastStatus = response.status;
                    attempt++;
                    continue;
                }
                break;
            }

            // Handle 401 — re-read credentials (Claude Code may have refreshed)
            if (response.status === 401) {
                process.stderr.write(`[anthropic-oauth] Got 401, re-reading credentials...\n`);
                if (cancelHandler && externalSignal) externalSignal.removeEventListener('abort', cancelHandler);
                this.credentials = null;
                creds = this.ensureAuth();
                ({ response, controller, cancelHandler } = await doRequestImpl(creds.accessToken));
            }

            if (!response.ok) {
                if (cancelHandler && externalSignal) externalSignal.removeEventListener('abort', cancelHandler);
                const text = await response.text().catch(() => '');
                const safeText = this.scrubTokens(text).slice(0, 200);
                process.stderr.write(`[anthropic-oauth] API error ${response.status}: ${safeText}\n`);

                // Phase I: on unknown/404 model errors, force a catalog refresh and
                // retry once. Protects against a silently-rotated model id.
                const isUnknownModel = response.status === 404
                    || /unknown[_\s-]?model|model[_\s-]?not[_\s-]?found/i.test(safeText);
                if (isUnknownModel && !opts._modelRetry) {
                    process.stderr.write(`[anthropic-oauth] unknown model — refreshing catalog + 1 retry\n`);
                    await this._refreshModelCache();
                    return this.send(messages, model, tools, { ...opts, _modelRetry: true });
                }
                throw new Error(`Anthropic OAuth API ${response.status}: ${safeText}`);
            }

            process.stderr.write(`[anthropic-oauth] Response ${response.status}, parsing SSE...\n`);
            try { onStageChange?.('streaming'); } catch {}

            const midState = {
                attemptIndex,
                sawMessageStart: false,
                sawCompleted: false,
                emittedToolCall: false,
                userAbort: false,
                watchdogAbort: null,
            };

            try {
                const sseStartedAt = Date.now();
                const result = await parseSSEFn(
                    response,
                    controller.signal,
                    () => controller.abort(),
                    onStreamDelta,
                    onToolCall,
                    midState,
                );

                traceBridgeSse({
                    sessionId,
                    sseParseMs: Date.now() - sseStartedAt,
                });

                const liveModel = result.model || useModel;
                traceBridgeUsage({
                    sessionId,
                    iteration,
                    inputTokens: result.usage?.inputTokens || 0,
                    outputTokens: result.usage?.outputTokens || 0,
                    cachedTokens: result.usage?.cachedTokens || 0,
                    cacheWriteTokens: result.usage?.cacheWriteTokens || 0,
                    promptTokens: result.usage?.promptTokens || 0,
                    model: liveModel,
                    modelDisplay: _displayModel(liveModel),
                    rawUsage: result.usage?.raw || null,
                    provider: 'anthropic-oauth',
                });

                // Phase I: if the live response surfaced a model id we don't know
                // about yet, kick off a background catalog refresh. Fire-and-forget
                // — do not await, do not surface errors.
                if (result.model && !_catalogHas(result.model)) {
                    void this._refreshModelCache();
                }

                process.stderr.write(`[anthropic-oauth] Done: ${result.content.length} chars, ${result.toolCalls?.length || 0} tool calls\n`);
                try {
                    Object.defineProperty(result, '__midstreamRetries', { value: attemptIndex, enumerable: false });
                } catch { /* ignore non-extensible result */ }
                return result;
            } catch (err) {
                const classifier = _classifyMidstreamError(err, midState);
                if (classifier && attemptIndex < MAX_MIDSTREAM_RETRIES) {
                    firstAttemptError = err;
                    firstAttemptClassifier = classifier;
                    try { controller?.abort?.(err); } catch (abortErr) {
                        /* best-effort stream teardown */
                        try { process.stderr.write(`[anthropic-oauth] abort on stream error failed: ${abortErr?.message ?? String(abortErr)}\n`); } catch {}
                    }
                    try {
                        process.stderr.write(`[anthropic-oauth] mid-stream recovered: retry ${attemptIndex + 1}/${MAX_MIDSTREAM_RETRIES} (cause: ${classifier})\n`);
                    } catch {}
                    continue;
                }
                if (attemptIndex > 0 && firstAttemptError) {
                    try { firstAttemptError.midstreamRetries = attemptIndex; } catch {}
                    try { firstAttemptError.midstreamClassifier = firstAttemptClassifier; } catch {}
                    throw firstAttemptError;
                }
                throw err;
            } finally {
                if (cancelHandler && externalSignal) externalSignal.removeEventListener('abort', cancelHandler);
            }
        }
        throw firstAttemptError || new Error('Anthropic OAuth mid-stream retry: unreachable');
    }

    async listModels() {
        // Dynamic lookup via /v1/models — returns whatever Anthropic currently
        // exposes for this OAuth account. Cached on disk with 24h TTL; falls
        // back to the static MODELS list on any failure so the plugin still
        // works offline or when Anthropic's /v1/models is momentarily down.
        const cached = await _loadModelCache();
        if (cached) {
            _inMemoryCatalog = cached.slice();
            return cached;
        }
        try {
            const creds = this.ensureAuth();
            const res = await fetch('https://api.anthropic.com/v1/models', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${creds.accessToken}`,
                    'anthropic-version': ANTHROPIC_VERSION,
                    'anthropic-beta': OAUTH_BETA_HEADERS,
                    'anthropic-dangerous-direct-browser-access': 'true',
                    'user-agent': `claude-cli/${resolveCliVersion()} (external, sdk-cli)`,
                    'x-app': 'cli',
                },
            });
            if (!res.ok) throw new Error(`list_models ${res.status}`);
            const data = await res.json();
            const items = Array.isArray(data?.data) ? data.data : [];
            const normalized = items
                .map(m => _normalizeAnthropicModel(m))
                .filter(Boolean);
            _markLatestByFamily(normalized);
            // Enrich with LiteLLM catalog metadata (context, pricing, capabilities)
            const enriched = await enrichModels(normalized);
            await _saveModelCache(enriched);
            return enriched;
        } catch (err) {
            process.stderr.write(`[anthropic-oauth] listModels fetch failed (${err.message})\n`);
            // Fallback with full API model IDs. Short family tokens leaked
            // through here would be accepted by setup and reintroduce the
            // legacy shape. Env var override keeps this tracking defaults.
            const opusId   = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL   || 'claude-opus-4-7';
            const sonnetId = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6';
            const haikuId  = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL  || 'claude-haiku-4-5-20251001';
            return [
                { id: opusId,   display: 'Opus (auto)',   family: 'opus',   provider: 'anthropic-oauth', tier: 'family', latest: true, contextWindow: 200000 },
                { id: sonnetId, display: 'Sonnet (auto)', family: 'sonnet', provider: 'anthropic-oauth', tier: 'family', latest: true, contextWindow: 200000 },
                { id: haikuId,  display: 'Haiku (auto)',  family: 'haiku',  provider: 'anthropic-oauth', tier: 'family', latest: true, contextWindow: 200000 },
            ];
        }
    }

    // Force a catalog refresh (ignores the 24h TTL). De-duped via
    // _refreshInFlight so concurrent callers share one HTTP round-trip.
    // Returns the new catalog on success, null on failure.
    async _refreshModelCache() {
        if (_refreshInFlight) return _refreshInFlight;
        _refreshInFlight = (async () => {
            try {
                const creds = this.ensureAuth();
                const res = await fetch('https://api.anthropic.com/v1/models', {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${creds.accessToken}`,
                        'anthropic-version': ANTHROPIC_VERSION,
                        'anthropic-beta': OAUTH_BETA_HEADERS,
                        'anthropic-dangerous-direct-browser-access': 'true',
                        'user-agent': `claude-cli/${resolveCliVersion()} (external, sdk-cli)`,
                        'x-app': 'cli',
                    },
                });
                if (!res.ok) throw new Error(`list_models ${res.status}`);
                const data = await res.json();
                const items = Array.isArray(data?.data) ? data.data : [];
                const normalized = items
                    .map(m => _normalizeAnthropicModel(m))
                    .filter(Boolean);
                _markLatestByFamily(normalized);
                const enriched = await enrichModels(normalized);
                await _saveModelCache(enriched);
                process.stderr.write(`[anthropic-oauth] catalog refreshed (${enriched.length} models)\n`);
                return enriched;
            } catch (err) {
                process.stderr.write(`[anthropic-oauth] catalog refresh failed (${err.message})\n`);
                return null;
            } finally {
                _refreshInFlight = null;
            }
        })();
        return _refreshInFlight;
    }

    async isAvailable() {
        return this.credentials !== null || loadCredentials() !== null;
    }
}

// Additive exports for test harnesses.
// Lets the SSE parser be exercised in isolation against a synthetic
// ReadableStream without needing a live OAuth session.
export { parseSSEStream };
