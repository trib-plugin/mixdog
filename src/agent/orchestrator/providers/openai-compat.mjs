import OpenAI from 'openai';
import { loadConfig } from '../config.mjs';
import { splitWithSidecars } from './sidecar-helper.mjs';
const PRESETS = {
    deepseek: {
        baseURL: 'https://api.deepseek.com',
        defaultModel: 'deepseek-v4-pro',
    },
    xai: {
        baseURL: 'https://api.x.ai/v1',
        defaultModel: 'grok-4-1-fast-reasoning',
    },
    nvidia: {
        baseURL: 'https://integrate.api.nvidia.com/v1',
        defaultModel: 'meta/llama-3.3-70b-instruct',
    },
    ollama: {
        baseURL: 'http://localhost:11434/v1',
        defaultModel: 'llama3.3:latest',
    },
    lmstudio: {
        baseURL: 'http://localhost:1234/v1',
        defaultModel: 'default',
    },
};
function toOpenAIMessages(messages) {
    const out = [];
    // Detach warnSidecar so the tool message content stays byte-identical
    // across iterations (cache prefix safe). Sidecar is re-emitted as a
    // separate user message right after the producing tool message.
    for (const { message: m, sidecar } of splitWithSidecars(messages)) {
        if (m.role === 'tool') {
            out.push({
                role: 'tool',
                tool_call_id: m.toolCallId || '',
                content: m.content,
            });
            if (sidecar) out.push({ role: 'user', content: sidecar });
            continue;
        }
        if (m.role === 'assistant' && m.toolCalls?.length) {
            out.push({
                role: 'assistant',
                content: m.content || null,
                tool_calls: m.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                })),
            });
            continue;
        }
        out.push({ role: m.role, content: m.content });
    }
    return out;
}
function toOpenAITools(tools) {
    return tools.map((t) => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
        },
    }));
}
function parseToolCalls(choice) {
    const calls = choice.message?.tool_calls;
    if (!calls?.length)
        return undefined;
    return calls
        .filter((tc) => tc.type === 'function')
        .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments || '{}'),
    }));
}
export class OpenAICompatProvider {
    name;
    client;
    defaultModel;
    config;
    constructor(name, config) {
        const preset = PRESETS[name];
        const baseURL = config.baseURL || preset?.baseURL || 'http://localhost:8080/v1';
        const apiKey = config.apiKey || 'no-key';
        this.name = name;
        this.config = config;
        this.defaultModel = preset?.defaultModel || 'default';
        this.client = new OpenAI({
            baseURL,
            apiKey,
            defaultHeaders: preset?.extraHeaders,
        });
    }
    reloadApiKey() {
        try {
            const freshConfig = loadConfig();
            const cfg = freshConfig.providers?.[this.name];
            const preset = PRESETS[this.name];
            const newKey = cfg?.apiKey || this.config.apiKey;
            const baseURL = cfg?.baseURL || this.config.baseURL || preset?.baseURL || 'http://localhost:8080/v1';
            if (newKey) {
                this.client = new OpenAI({
                    baseURL,
                    apiKey: newKey,
                    defaultHeaders: preset?.extraHeaders,
                });
            }
        } catch { /* best effort */ }
    }
    async send(messages, model, tools, sendOpts) {
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
        const useModel = model || this.defaultModel;
        const opts = sendOpts || {};
        const signal = opts.signal || null;
        if (signal?.aborted) {
            const reason = signal.reason;
            throw reason instanceof Error ? reason : new Error('OpenAI-compat request aborted by session close');
        }
        const params = {
            model: useModel,
            messages: toOpenAIMessages(messages),
        };
        if (tools?.length) {
            params.tools = toOpenAITools(tools);
        }
        // DeepSeek docs do not recognize prompt_cache_key — caching is fully
        // automatic on the server (KV cache hit measured 30~100% via
        // prompt_cache_hit_tokens depending on prefix unit overlap). No
        // steering field; we leave the request body untouched.
        const requestOpts = signal ? { signal } : undefined;
        const response = await this.client.chat.completions.create(params, requestOpts);
        const choice = response.choices[0];
        const toolCalls = choice ? parseToolCalls(choice) : undefined;
        return {
            content: choice?.message?.content || '',
            model: response.model,
            toolCalls,
            usage: response.usage ? (() => {
                const input = response.usage.prompt_tokens || 0;
                const cached = response.usage.prompt_tokens_details?.cached_tokens
                    || response.usage.prompt_cache_hit_tokens
                    || 0;
                // xAI Grok returns the actual billed amount in `cost_in_usd_ticks`
                // (1 tick = $1e-10, per docs.x.ai). Surface it as costUsd so the
                // session manager skips the catalog-rate fallback and records the
                // provider-billed value verbatim.
                const ticks = response.usage.cost_in_usd_ticks;
                const costUsd = typeof ticks === 'number' && ticks >= 0
                    ? Number((ticks * 1e-10).toFixed(8))
                    : undefined;
                return {
                    inputTokens: input,
                    outputTokens: response.usage.completion_tokens || 0,
                    cachedTokens: cached,
                    // Chat Completions prompt_tokens is already the total prompt
                    // the model ingested (cached is a subset) — alias directly.
                    promptTokens: input,
                    ...(costUsd != null ? { costUsd } : {}),
                };
            })() : undefined,
        };
    }
    async listModels() {
        try {
            const list = await this.client.models.list();
            const models = [];
            for await (const m of list) {
                models.push({
                    id: m.id,
                    name: m.id,
                    provider: this.name,
                    contextWindow: 0,
                    created: typeof m.created === 'number' ? m.created : null,
                });
            }
            return models;
        }
        catch {
            return [];
        }
    }
    async isAvailable() {
        try {
            await this.client.models.list();
            return true;
        }
        catch {
            return false;
        }
    }
}
