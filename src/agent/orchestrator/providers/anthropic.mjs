import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.mjs';
import { sanitizeToolPairs, sanitizeAnthropicContentPairs } from '../session/trim.mjs';

// 4-BP cache policy aligned with anthropic-oauth — tools + system + tier3
// + messages-tail. 1h TTL requires the extended-cache-ttl beta header,
// which we set on the client via defaultHeaders below.
const CACHE_TTL_STABLE = { type: 'ephemeral', ttl: '1h' };
const CACHE_TTL_VOLATILE = { type: 'ephemeral' };

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

function collectRecentCacheableMessageIndexes(messages, availableSlots = 1) {
    const slots = Math.max(0, Math.min(4, availableSlots));
    const marked = new Set();
    for (let i = messages.length - 1; i >= 0 && marked.size < slots; i--) {
        if (messages[i]?.role !== 'system') marked.add(i);
    }
    return marked;
}

// Mirrors anthropic-oauth.mjs gate: only the explicitly-tagged sessionMarker
// claims a 1h BP3 slot. composeSystemPrompt prefixes sessionMarker with
// `<!-- bp3-sentinel -->`; volatileTail (also a `<system-reminder>` user
// message) deliberately omits the sentinel so it stays on the 5m tail.
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

function resolveCacheTtls(opts) {
    const strategy = opts?.cacheStrategy || {};
    const pick = (layer, fallback) => {
        const v = strategy[layer];
        if (v === '1h') return CACHE_TTL_STABLE;
        if (v === '5m') return CACHE_TTL_VOLATILE;
        if (v === 'none') return null;
        return fallback;
    };
    return {
        tools: pick('tools', CACHE_TTL_STABLE),
        system: pick('system', CACHE_TTL_STABLE),
        tier3: pick('tier3', CACHE_TTL_STABLE),
        messages: pick('messages', CACHE_TTL_VOLATILE),
    };
}

const MODELS = [
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', provider: 'anthropic', contextWindow: 1000000 },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', contextWindow: 1000000 },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', contextWindow: 200000 },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic', contextWindow: 200000 },
];
// Family-based heuristic so new model ids (including custom user-configured
// ones) resolve a sensible max_tokens without requiring a code change.
function resolveMaxTokens(model) {
    const id = String(model || '').toLowerCase();
    if (id.includes('opus')) return 32768;
    if (id.includes('sonnet')) return 16384;
    if (id.includes('haiku')) return 8192;
    return 8192;
}

// Effort → thinking budget tokens (Anthropic extended thinking)
const EFFORT_BUDGET = {
    low: 1024,
    medium: 4096,
    high: 16384,
    max: 32768,
};
function toAnthropicTools(tools) {
    return tools.map((t) => ({
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
            // warnSidecar is loop.mjs's soft-warn channel. Emitted as a
            // separate text block AFTER cache_control so the tool_result
            // hash stays stable across turns.
            const sidecarBlock = m.warnSidecar
                ? { type: 'text', text: m.warnSidecar }
                : null;
            if (last?.role === 'user' && Array.isArray(last.content)) {
                last.content.push(block);
                if (anyCache(idx)) {
                    last.content = appendCacheControl(last.content, pickTtl(idx));
                }
                if (sidecarBlock) last.content.push(sidecarBlock);
            }
            else {
                let content = [block];
                if (anyCache(idx)) content = appendCacheControl(content, pickTtl(idx));
                if (sidecarBlock) content = [...content, sidecarBlock];
                result.push({ role: 'user', content });
            }
            continue;
        }
        const content = anyCache(idx)
            ? appendCacheControl(m.content, pickTtl(idx))
            : m.content;
        result.push({ role: m.role, content });
    }
    return sanitizeAnthropicContentPairs(result);
}
function parseToolCalls(response) {
    const blocks = response.content.filter((b) => b.type === 'tool_use');
    if (!blocks.length)
        return undefined;
    return blocks.map((b) => ({
        id: b.id,
        name: b.name,
        arguments: (b.input ?? {}),
    }));
}
export class AnthropicProvider {
    name = 'anthropic';
    client;
    config;
    constructor(config) {
        this.config = config;
        this.client = new Anthropic({
            apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
            defaultHeaders: { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' },
        });
    }
    reloadApiKey() {
        try {
            const freshConfig = loadConfig();
            const cfg = freshConfig.providers?.anthropic;
            const newKey = cfg?.apiKey || process.env.ANTHROPIC_API_KEY;
            if (newKey) {
                this.client = new Anthropic({
                    apiKey: newKey,
                    defaultHeaders: { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' },
                });
            }
        } catch { /* best effort */ }
    }
    async send(messages, model, tools, sendOpts) {
        // Defense-in-depth: enforce tool_use / tool_result pairing before
        // the Anthropic API call. Mirror of the OAuth path; loop.mjs only
        // runs sanitizeToolPairs when budget is exceeded, so an under-budget
        // dispatch with an aborted-mid-flight tool_use would otherwise hit
        // the provider as a hard 400 (`tool_use ids ... without tool_result`).
        messages = sanitizeToolPairs(messages);
        try {
            return await this._doSend(messages, model, tools, sendOpts);
        } catch (err) {
            if (err.message && (err.message.includes('401') || err.message.includes('403'))) {
                process.stderr.write(`[provider] Auth error, re-reading config...\n`);
                this.reloadApiKey();
                return await this._doSend(messages, model, tools, sendOpts);
            }
            throw err;
        }
    }
    async _doSend(messages, model, tools, sendOpts) {
        if (!model) throw new Error('[anthropic] model is required — pass it from the caller preset');
        const useModel = model;
        const maxTokens = resolveMaxTokens(useModel);
        const opts = sendOpts || {};
        const ttls = resolveCacheTtls(opts);

        const systemMsgs = messages.filter(m => m.role === 'system');
        const chatMsgs = messages.filter(m => m.role !== 'system');
        const systemText = systemMsgs.map(m => m.content).join('\n\n') || undefined;

        // 4-BP budget: aligned with anthropic-oauth. tools BP is dropped —
        // system BP covers the tools prefix via Anthropic prefix semantics
        // (order: tools → system → messages). That frees 1 slot for
        // messages-tail.
        const toolsBpUsed = 0;
        const systemBpUsed = ttls.system && systemText ? 1 : 0;
        const tier3Idx = ttls.tier3 ? findTier3Index(chatMsgs) : -1;
        const tier3BpUsed = tier3Idx >= 0 ? 1 : 0;
        const usedSlots = toolsBpUsed + systemBpUsed + tier3BpUsed;
        const msgSlots = ttls.messages ? Math.max(0, 4 - usedSlots) : 0;
        const cacheableIndexes = collectRecentCacheableMessageIndexes(chatMsgs, msgSlots);
        if (tier3Idx >= 0) cacheableIndexes.delete(tier3Idx);

        const anthropicMessages = toAnthropicMessages(
            chatMsgs,
            cacheableIndexes,
            ttls.messages,
            tier3Idx,
            ttls.tier3,
        );

        const params = {
            model: useModel,
            max_tokens: maxTokens,
            system: systemText
                ? [ttls.system
                    ? { type: 'text', text: systemText, cache_control: ttls.system }
                    : { type: 'text', text: systemText }]
                : undefined,
            messages: anthropicMessages,
        };
        if (tools?.length) {
            // No cache_control on tools — the system BP covers tools via
            // Anthropic prefix semantics (order: tools → system → messages).
            params.tools = toAnthropicTools(tools);
        }
        // Effort → extended thinking budget
        if (opts.effort && EFFORT_BUDGET[opts.effort]) {
            params.thinking = { type: 'enabled', budget_tokens: EFFORT_BUDGET[opts.effort] };
        }
        // Fast mode → speed: "fast" (Opus 4.6 only, infrastructure priority routing)
        if (opts.fast === true) {
            params.speed = 'fast';
        }
        const requestOpts = {};
        if (opts.signal) requestOpts.signal = opts.signal;
        const response = await this.client.messages.create(params, requestOpts);
        const textBlock = response.content.find(b => b.type === 'text');
        const toolCalls = parseToolCalls(response);
        return {
            content: textBlock?.type === 'text' ? textBlock.text : '',
            model: response.model,
            toolCalls,
            usage: (() => {
                const input = response.usage.input_tokens || 0;
                const cacheRead = response.usage.cache_read_input_tokens || 0;
                const cacheWrite = response.usage.cache_creation_input_tokens || 0;
                return {
                    inputTokens: input,
                    outputTokens: response.usage.output_tokens || 0,
                    cachedTokens: cacheRead,
                    cacheWriteTokens: cacheWrite,
                    // Unified prompt volume — what the model actually ingested,
                    // regardless of cache splitting. Anthropic reports input
                    // uncached-only; sum the three billable slots so the
                    // cross-provider `promptTokens` field has consistent meaning.
                    promptTokens: input + cacheRead + cacheWrite,
                };
            })(),
        };
    }
    async listModels() {
        return MODELS;
    }
    async isAvailable() {
        try {
            await this.client.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 1,
                messages: [{ role: 'user', content: 'hi' }],
            });
            return true;
        }
        catch {
            return false;
        }
    }
}
