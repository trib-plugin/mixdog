/**
 * OpenAI Direct API — WebSocket transport via Responses API.
 *
 * Uses the same `sendViaWebSocket` plumbing as openai-oauth (Codex), with two
 * differences encoded in the `auth.type === 'openai-direct'` branch inside
 * openai-oauth-ws.mjs:
 *   1. Authorization header: Bearer <OPENAI_API_KEY> (no account_id, no
 *      originator).
 *   2. Endpoint: wss://api.openai.com/v1/responses.
 *
 * The Responses API request body is reused from openai-oauth (`buildRequestBody`)
 * so prompt_cache_key, reasoning effort, and tool wiring stay byte-identical
 * across the two providers — only the transport endpoint and auth header change.
 */
import { sendViaWebSocket } from './openai-oauth-ws.mjs';
import { buildRequestBody } from './openai-oauth.mjs';

export class OpenAIDirectProvider {
    name = 'openai';
    config;
    constructor(config) {
        this.config = config || {};
    }
    _ensureKey() {
        const k = this.config.apiKey;
        if (!k) throw new Error('OPENAI_API_KEY not configured (providers.openai.apiKey)');
        return k;
    }
    async send(messages, model, tools, sendOpts) {
        const opts = sendOpts || {};
        const onStageChange = typeof opts.onStageChange === 'function' ? opts.onStageChange : null;
        const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
        const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
        const externalSignal = opts.signal || null;
        const apiKey = this._ensureKey();
        const useModel = model || 'gpt-5.5';
        const body = buildRequestBody(messages, useModel, tools, sendOpts);
        // Public Responses API supports prompt_cache_retention='24h' at no
        // extra cost (same cached_input_tokens billing as the default 5–10
        // min in-memory cache). Codex/oauth rejects the parameter, so it's
        // injected only on the direct path. See openai-oauth.mjs:290-294
        // for the rationale.
        body.prompt_cache_retention = '24h';
        const poolKey  = opts.sessionId || opts.promptCacheKey || null;
        const cacheKey = opts.promptCacheKey || opts.sessionId || null;
        const iteration = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null;
        const auth = { type: 'openai-direct', apiKey };
        return sendViaWebSocket({
            auth,
            body,
            sendOpts: opts,
            onStreamDelta,
            onToolCall,
            onStageChange,
            externalSignal,
            poolKey,
            cacheKey,
            iteration,
            useModel,
            displayModel: (id) => id,
        });
    }
    async listModels() {
        try {
            const apiKey = this._ensureKey();
            const res = await fetch('https://api.openai.com/v1/models', {
                headers: { 'Authorization': `Bearer ${apiKey}` },
            });
            if (!res.ok) return [];
            const j = await res.json();
            return (j.data || []).map((m) => ({
                id: m.id,
                name: m.id,
                provider: 'openai',
                contextWindow: 200000,
            }));
        } catch {
            return [];
        }
    }
    async isAvailable() {
        return !!this.config.apiKey;
    }
}
