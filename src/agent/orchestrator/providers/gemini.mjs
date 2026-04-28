import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { GoogleAICacheManager } from '@google/generative-ai/server';
import { loadConfig } from '../config.mjs';
import { estimateGeminiTokens } from '../bridge-trace.mjs';
import { splitWithSidecars } from './sidecar-helper.mjs';

const MODELS = [
    { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', provider: 'gemini', contextWindow: 1000000 },
    { id: 'gemini-3-pro', name: 'Gemini 3 Pro', provider: 'gemini', contextWindow: 1000000 },
    { id: 'gemini-3-flash', name: 'Gemini 3 Flash', provider: 'gemini', contextWindow: 1000000 },
];

/**
 * Convert JSON Schema type string to Gemini SchemaType.
 * Gemini SDK uses its own enum instead of plain strings.
 */
function toSchemaType(t) {
    const map = {
        string: SchemaType.STRING,
        number: SchemaType.NUMBER,
        integer: SchemaType.INTEGER,
        boolean: SchemaType.BOOLEAN,
        array: SchemaType.ARRAY,
        object: SchemaType.OBJECT,
    };
    return map[t] ?? SchemaType.STRING;
}

/**
 * Recursively convert a JSON Schema object to Gemini's FunctionDeclarationSchema.
 * Gemini requires `type` to be a SchemaType enum, not a plain string, and
 * rejects several JSON Schema fields the API does not understand
 * (additionalProperties, $schema, $ref, const, examples, definitions,
 * patternProperties). We strip those at every level.
 */
const GEMINI_SCHEMA_STRIP = new Set([
    'additionalProperties',
    '$schema',
    '$ref',
    'const',
    'examples',
    'definitions',
    'patternProperties',
]);
function convertSchema(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    const result = {};
    for (const [k, v] of Object.entries(schema)) {
        if (GEMINI_SCHEMA_STRIP.has(k)) continue;
        result[k] = v;
    }
    if (typeof result.type === 'string') {
        result.type = toSchemaType(result.type);
    }
    if (result.properties && typeof result.properties === 'object') {
        const props = {};
        for (const [key, val] of Object.entries(result.properties)) {
            props[key] = convertSchema(val);
        }
        result.properties = props;
    }
    if (result.items && typeof result.items === 'object') {
        result.items = convertSchema(result.items);
    }
    return result;
}

function toGeminiTools(tools) {
    return {
        functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: convertSchema(t.inputSchema),
        })),
    };
}

function toGeminiContent(message) {
    if (!message || message.role === 'system') return null;
    if (message.role === 'assistant' && message.toolCalls?.length) {
        const parts = [];
        if (message.content) parts.push({ text: message.content });
        for (const tc of message.toolCalls) {
            // Gemini 3 requires the original thoughtSignature to be echoed back
            // on every functionCall part so the cached thinking prefix stays
            // valid. Older models (1.5/2.x) and the first turn of a session
            // simply have no signature; emit the part without the field then.
            // Send under both casings so whichever the v1beta endpoint accepts
            // is honoured — the API rejects a missing signature, not an extra
            // alias field.
            const fc = { name: tc.name, args: tc.arguments };
            if (tc.thoughtSignature) {
                fc.thoughtSignature = tc.thoughtSignature;
                fc.thought_signature = tc.thoughtSignature;
            }
            parts.push({ functionCall: fc });
        }
        return { role: 'model', parts };
    }
    if (message.role === 'tool') {
        // Tool result content stays byte-identical for cache prefix
        // stability; sidecar (if any) is appended as a separate user
        // turn by toGeminiContents below.
        return {
            role: 'function',
            parts: [{ functionResponse: { name: message.toolCallId || '', response: { result: message.content } } }],
        };
    }
    return {
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
    };
}

function toGeminiContents(messages) {
    const contents = [];
    for (const { message, sidecar } of splitWithSidecars(messages)) {
        const content = toGeminiContent(message);
        if (content) contents.push(content);
        if (sidecar) {
            contents.push({ role: 'user', parts: [{ text: sidecar }] });
        }
    }
    return contents;
}

function parseToolCalls(parts) {
    const calls = parts.filter((p) => 'functionCall' in p && !!p.functionCall);
    if (!calls.length)
        return undefined;
    // The @google/generative-ai 0.24.1 SDK predates Gemini 3 thinking — its
    // FunctionCall type only declares { name, args }. The runtime object,
    // however, retains whatever the wire response carried, which means the
    // signature may sit under any of:
    //   • part.functionCall.thoughtSignature   (camelCase, expected)
    //   • part.functionCall.thought_signature  (snake_case, raw protobuf)
    //   • part.thoughtSignature / part.thought_signature (sibling on Part)
    // Read all four and use the first non-empty hit. Set MIXDOG_DEBUG_GEMINI=1
    // to dump the raw parts so we can confirm the actual key location on the
    // next session and harden the parser.
    if (process.env.MIXDOG_DEBUG_GEMINI === '1') {
        try { process.stderr.write(`[gemini fc raw] ${JSON.stringify(parts)}\n`); } catch {}
    }
    return calls.map((p, i) => {
        const fc = p.functionCall;
        const sig = fc.thoughtSignature
            || fc.thought_signature
            || p.thoughtSignature
            || p.thought_signature
            || null;
        const call = {
            id: `gemini_${Date.now()}_${i}`,
            name: fc.name,
            arguments: (fc.args ?? {}),
        };
        if (sig) call.thoughtSignature = sig;
        return call;
    });
}

function buildGeminiCacheShapeFingerprint({ model, systemInstruction, tools }) {
    // Shape fingerprint covers the stable context identity (model + system +
    // tools). When this changes the cache is incompatible. Separated from the
    // prefix snapshot so extension-only sends can reuse the cache.
    try {
        return JSON.stringify({
            model,
            systemInstruction: systemInstruction || null,
            tools: tools || null,
        });
    }
    catch {
        return '';
    }
}

function buildGeminiPrefixSnapshot(prefixContents) {
    // Per-content snapshots let us check "new prefix extends old prefix" via
    // elementwise equality instead of full-string compare. Serializing each
    // entry once keeps the check O(cached.length).
    const out = new Array(prefixContents.length);
    for (let i = 0; i < prefixContents.length; i++) {
        try {
            out[i] = JSON.stringify(prefixContents[i]);
        } catch {
            out[i] = null;
        }
    }
    return out;
}

function isPrefixExtension(prevSnapshot, nextSnapshot) {
    // True when nextSnapshot is prevSnapshot (equal) or starts with it (extension).
    // Strict equality each slot — single null makes the slot ineligible.
    if (!Array.isArray(prevSnapshot) || !Array.isArray(nextSnapshot)) return false;
    if (prevSnapshot.length === 0) return false;
    if (nextSnapshot.length < prevSnapshot.length) return false;
    for (let i = 0; i < prevSnapshot.length; i++) {
        if (prevSnapshot[i] === null || nextSnapshot[i] === null) return false;
        if (prevSnapshot[i] !== nextSnapshot[i]) return false;
    }
    return true;
}

const GEMINI_CACHE_TTL_MS = 60 * 60 * 1000;
const GEMINI_CACHE_MIN_TOKENS = 1024;

export class GeminiProvider {
    name = 'gemini';
    genAI;
    cacheManager;
    config;
    _geminiSessionCaches = new Map();

    constructor(config) {
        this.config = config;
        const apiKey = config.apiKey || process.env.GEMINI_API_KEY || '';
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.cacheManager = new GoogleAICacheManager(apiKey);
    }

    reloadApiKey() {
        try {
            const freshConfig = loadConfig();
            const cfg = freshConfig.providers?.gemini;
            const newKey = cfg?.apiKey || process.env.GEMINI_API_KEY;
            if (newKey) {
                this.genAI = new GoogleGenerativeAI(newKey);
                this.cacheManager = new GoogleAICacheManager(newKey);
                this._geminiSessionCaches.clear();
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

    async _getCachedGeminiModel(cacheKey, useModel, systemInstruction, geminiTools, prefixContents, signal) {
        if (!cacheKey) return null;
        const now = Date.now();
        const shapeFingerprint = buildGeminiCacheShapeFingerprint({
            model: useModel,
            systemInstruction,
            tools: geminiTools,
        });
        // Index by (cacheKey + model + shape) so single-shot calls sharing the
        // same provider-scoped cacheKey collapse onto one cached resource.
        // Previously keyed by sessionId — every new bridge invocation got a
        // fresh session and therefore a fresh cache, which defeated BP1 reuse
        // for the typical reviewer/debugger fan-out shape.
        const cacheIndex = `${cacheKey}::${useModel}::${shapeFingerprint}`;
        const prefixSnapshot = buildGeminiPrefixSnapshot(prefixContents);

        // Token-budget check applies to the actual cache payload (BP1 = system +
        // tools + any prefix messages). Single-shot calls have empty prefix but
        // a system prompt that easily clears the 1024-token floor.
        const cachePayloadTokens = estimateGeminiTokens(prefixContents)
            + (systemInstruction ? Math.ceil(systemInstruction.length / 4) : 0);
        if (cachePayloadTokens < GEMINI_CACHE_MIN_TOKENS) return null;

        const existing = this._geminiSessionCaches.get(cacheIndex);
        if (
            existing
            && existing.shapeFingerprint === shapeFingerprint
            && (now - existing.createdAt) < GEMINI_CACHE_TTL_MS
            && isPrefixExtension(existing.prefixSnapshot, prefixSnapshot)
        ) {
            return this.genAI.getGenerativeModelFromCachedContent(existing.cachedContent);
        }

        // Gemini cacheManager.create requires non-empty contents. For
        // single-shot calls (prefixContents = []) we synthesize a single
        // user-role placeholder so systemInstruction + tools become the actual
        // BP1 payload. The placeholder text never leaks into the model's view
        // of the live conversation because subsequent generateContent calls
        // pass the real user message after the cached prefix.
        const createContents = prefixContents.length > 0
            ? prefixContents
            : [{ role: 'user', parts: [{ text: '.' }] }];

        const cachedContent = await this.cacheManager.create({
            model: useModel,
            contents: createContents,
            ttlSeconds: 3600,
            ...(geminiTools ? { tools: geminiTools } : {}),
            ...(systemInstruction ? { systemInstruction } : {}),
            displayName: `mixdog-bridge-${cacheIndex.slice(0, 60)}`,
        });
        if (signal?.aborted) {
            const reason = signal.reason;
            throw reason instanceof Error ? reason : new Error('Gemini cache creation aborted by session close');
        }
        this._geminiSessionCaches.set(cacheIndex, {
            cachedContent,
            shapeFingerprint,
            prefixSnapshot,
            createdAt: now,
        });
        return this.genAI.getGenerativeModelFromCachedContent(cachedContent);
    }

    async _doSend(messages, model, tools, sendOpts) {
        const opts = sendOpts || {};
        const signal = opts.signal || null;
        if (signal?.aborted) {
            const reason = signal.reason;
            throw reason instanceof Error ? reason : new Error('Gemini request aborted by session close');
        }

        const useModel = model || 'gemini-3-flash';
        const systemInstruction = messages
            .filter(m => m.role === 'system')
            .map(m => m.content)
            .join('\n\n') || undefined;
        const chatMsgs = messages.filter(m => m.role !== 'system');
        const contents = toGeminiContents(chatMsgs);
        if (!contents.length)
            throw new Error('No messages to send');

        const geminiTools = tools?.length ? [toGeminiTools(tools)] : undefined;
        const requestOpts = signal ? { signal } : undefined;

        let genModel = this.genAI.getGenerativeModel({
            model: useModel,
            systemInstruction,
            tools: geminiTools,
        });
        let requestContents = contents;

        // Cache key prefers the provider-scoped promptCacheKey so single-shot
        // calls across roles collapse onto one cached BP1 resource. Falls back
        // to sessionId for legacy callers that don't supply promptCacheKey.
        const cacheKey = opts.promptCacheKey || opts.sessionId || null;
        // Always-on cache. `_getCachedGeminiModel` throws on cache-create
        // failure — the error propagates through send() to the caller with
        // no silent fallback. Empty-prefix single-shot calls are now allowed:
        // the cache payload is systemInstruction + tools (BP1).
        if (cacheKey) {
            const prefixContents = contents.slice(0, -1);
            const cachedModel = await this._getCachedGeminiModel(
                cacheKey,
                useModel,
                systemInstruction,
                geminiTools,
                prefixContents,
                signal,
            );
            if (cachedModel) {
                genModel = cachedModel;
                const shapeFingerprint = buildGeminiCacheShapeFingerprint({
                    model: useModel,
                    systemInstruction,
                    tools: geminiTools,
                });
                const cacheIndex = `${cacheKey}::${useModel}::${shapeFingerprint}`;
                const cached = this._geminiSessionCaches.get(cacheIndex);
                const cachedLen = cached?.prefixSnapshot?.length ?? prefixContents.length;
                requestContents = contents.slice(cachedLen);
            }
        }

        const result = await genModel.generateContent({ contents: requestContents }, requestOpts);
        const response = result.response;
        const textParts = response.candidates?.[0]?.content?.parts?.filter(p => 'text' in p) ?? [];
        const content = textParts.map(p => 'text' in p ? p.text : '').join('');
        const toolCalls = parseToolCalls(response.candidates?.[0]?.content?.parts ?? []);
        return {
            content,
            model: useModel,
            toolCalls,
            usage: response.usageMetadata ? (() => {
                const input = response.usageMetadata.promptTokenCount || 0;
                return {
                    inputTokens: input,
                    outputTokens: response.usageMetadata.candidatesTokenCount || 0,
                    cachedTokens: response.usageMetadata.cachedContentTokenCount || 0,
                    // Gemini promptTokenCount is total (cachedContentTokenCount
                    // is a subset). Alias directly into promptTokens.
                    promptTokens: input,
                };
            })() : undefined,
        };
    }

    async listModels() {
        // Dynamic lookup via Gemini v1beta /models. Requires API key.
        const apiKey = this.config.apiKey || process.env.GEMINI_API_KEY;
        if (!apiKey) return MODELS; // no key — return minimal static list
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`gemini list_models ${res.status}`);
            const data = await res.json();
            const items = Array.isArray(data?.models) ? data.models : [];
            // Filter to Gemini family; skip embedding/imagen endpoints.
            const normalized = items
                .filter(m => (m?.name || '').includes('gemini'))
                .filter(m => !/embedding|aqa|imagen/.test(m?.name || ''))
                .map(m => {
                    const id = (m.name || '').replace(/^models\//, '');
                    const family = /flash-lite/.test(id) ? 'gemini-flash-lite'
                        : /flash/.test(id) ? 'gemini-flash'
                        : /pro/.test(id) ? 'gemini-pro'
                        : 'gemini';
                    return {
                        id,
                        display: m.displayName || id,
                        family,
                        provider: 'gemini',
                        contextWindow: m.inputTokenLimit || 1000000,
                        outputTokens: m.outputTokenLimit || 8192,
                        tier: 'version',
                        latest: false,
                        description: m.description || '',
                    };
                });
            // LiteLLM catalog overlays pricing and updated metadata.
            const { enrichModels } = await import('./model-catalog.mjs');
            return await enrichModels(normalized);
        } catch (err) {
            process.stderr.write(`[gemini] listModels fetch failed (${err.message})\n`);
            return MODELS;
        }
    }

    async isAvailable() {
        try {
            const model = this.genAI.getGenerativeModel({ model: 'gemini-3-flash' });
            await model.generateContent('hi');
            return true;
        }
        catch {
            return false;
        }
    }
}
