import OpenAI from 'openai';
import { loadConfig } from '../config.mjs';
import { warnBridgeOnce } from '../bridge-trace.mjs';
const PRESETS = {
    openai: {
        baseURL: 'https://api.openai.com/v1',
        defaultModel: 'gpt-5.5',
    },
    groq: {
        baseURL: 'https://api.groq.com/openai/v1',
        defaultModel: 'llama-3.3-70b-versatile',
    },
    openrouter: {
        baseURL: 'https://openrouter.ai/api/v1',
        defaultModel: 'anthropic/claude-sonnet-4.6',
        extraHeaders: { 'HTTP-Referer': 'mixdog-agent', 'X-Title': 'mixdog-agent' },
    },
    xai: {
        baseURL: 'https://api.x.ai/v1',
        defaultModel: 'grok-3-beta',
    },
    ollama: {
        baseURL: 'http://localhost:11434/v1',
        defaultModel: 'llama3.3:latest',
    },
    lmstudio: {
        baseURL: 'http://localhost:1234/v1',
        defaultModel: 'default',
    },
    local: {
        baseURL: 'http://localhost:8080/v1',
        defaultModel: 'default',
    },
};
function toOpenAIMessages(messages) {
    return messages.map((m) => {
        if (m.role === 'tool') {
            return {
                role: 'tool',
                tool_call_id: m.toolCallId || '',
                content: m.content,
            };
        }
        if (m.role === 'assistant' && m.toolCalls?.length) {
            return {
                role: 'assistant',
                content: m.content || null,
                tool_calls: m.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                })),
            };
        }
        return { role: m.role, content: m.content };
    });
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
        const isReasoningModel = opts.effort || /^(gpt-5|o[13])/i.test(useModel);
        if (this.name === 'openai' && isReasoningModel && tools?.length) {
            return await this._sendViaResponsesAPI(messages, useModel, tools, opts);
        }
        const params = {
            model: useModel,
            messages: toOpenAIMessages(messages),
        };
        if (tools?.length) {
            params.tools = toOpenAITools(tools);
        }
        // Apply effort/fast only on the official OpenAI endpoint — other compat
        // providers (groq, ollama, lmstudio, openrouter, xai) ignore these.
        if (this.name === 'openai') {
            if (opts.effort) {
                // OpenAI Chat Completions takes a flat string field.
                params.reasoning_effort = opts.effort;
            }
            if (opts.fast === true) {
                params.service_tier = 'priority';
            }
        }
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
                const cached = response.usage.prompt_tokens_details?.cached_tokens || 0;
                return {
                    inputTokens: input,
                    outputTokens: response.usage.completion_tokens || 0,
                    cachedTokens: cached,
                    // Chat Completions prompt_tokens is already the total prompt
                    // the model ingested (cached is a subset) — alias directly.
                    promptTokens: input,
                };
            })() : undefined,
        };
    }
    async _sendViaResponsesAPI(messages, model, tools, opts) {
        const systemMsgs = messages.filter((m) => m.role === 'system');
        const instructions = systemMsgs.map((m) => m.content).join('\n\n') || 'You are a helpful assistant.';
        const input = [];
        for (const m of messages) {
            if (m.role === 'system')
                continue;
            if (m.role === 'tool') {
                input.push({
                    type: 'function_call_output',
                    call_id: m.toolCallId || '',
                    output: m.content,
                });
                continue;
            }
            if (m.role === 'assistant' && m.toolCalls?.length) {
                if (m.content) {
                    input.push({ role: 'assistant', content: m.content });
                }
                for (const tc of m.toolCalls) {
                    input.push({
                        type: 'function_call',
                        call_id: tc.id,
                        name: tc.name,
                        arguments: JSON.stringify(tc.arguments),
                    });
                }
                continue;
            }
            input.push({
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: m.content,
            });
        }
        const toolsFlat = tools?.map((t) => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
        }));
        const body = {
            model,
            instructions,
            input,
            reasoning: { effort: opts.effort || 'medium' },
        };
        // Stable scope key (role × workspace from session) wins over the
        // volatile sessionId so the same cache shard is reused across
        // dispatches within a role.
        const cacheKey = opts.promptCacheKey || opts.sessionId;
        if (cacheKey && this.name === 'openai') {
            body.prompt_cache_key = String(cacheKey);
        }
        else if (cacheKey && this.name !== 'openai') {
            warnBridgeOnce(`prompt-cache-skip:${this.name}`, `[bridge-cache] ${this.name} responses endpoint: prompt_cache_key unsupported, skipping`);
        }
        if (toolsFlat?.length)
            body.tools = toolsFlat;
        if (opts.fast === true)
            body.service_tier = 'priority';
        const signal = opts.signal || null;
        const requestOpts = signal ? { signal } : undefined;
        const response = await this.client.responses.create(body, requestOpts);
        let content = '';
        const toolCalls = [];
        for (const item of response.output || []) {
            if (item.type === 'message') {
                for (const c of item.content || []) {
                    if (c.type === 'output_text')
                        content += c.text || '';
                }
            }
            else if (item.type === 'function_call') {
                toolCalls.push({
                    id: item.call_id,
                    name: item.name,
                    arguments: JSON.parse(item.arguments || '{}'),
                });
            }
        }
        return {
            content,
            model: response.model,
            toolCalls: toolCalls.length ? toolCalls : undefined,
            usage: response.usage ? (() => {
                const input = response.usage.input_tokens || 0;
                const cached = response.usage.input_tokens_details?.cached_tokens
                    || response.usage.prompt_tokens_details?.cached_tokens
                    || 0;
                return {
                    inputTokens: input,
                    outputTokens: response.usage.output_tokens || 0,
                    cachedTokens: cached,
                    // Responses API input_tokens is total (cached is subset).
                    promptTokens: input,
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
