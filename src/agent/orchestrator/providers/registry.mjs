import { OpenAICompatProvider } from './openai-compat.mjs';
import { AnthropicProvider } from './anthropic.mjs';
import { GeminiProvider } from './gemini.mjs';
import { OpenAIOAuthProvider } from './openai-oauth.mjs';
import { AnthropicOAuthProvider } from './anthropic-oauth.mjs';
import { getCopilotBearerToken } from './copilot-auth.mjs';
const OPENAI_COMPAT_PROVIDERS = ['openai', 'groq', 'openrouter', 'xai', 'ollama', 'lmstudio', 'local'];
/**
 * Copilot wrapper — recreates the inner OpenAI client when the bearer token expires.
 */
class CopilotProvider {
    name = 'copilot';
    inner = null;
    config;
    constructor(config) {
        this.config = config;
    }
    async ensureClient() {
        const token = await getCopilotBearerToken();
        if (!token)
            throw new Error('Failed to obtain Copilot bearer token');
        // getCopilotBearerToken returns cached token if still valid,
        // or refreshes if expired — so recreating is cheap when cached
        this.inner = new OpenAICompatProvider('copilot', {
            ...this.config,
            apiKey: token,
            baseURL: this.config.baseURL || 'https://api.githubcopilot.com',
        });
        return this.inner;
    }
    async send(messages, model, tools, sendOpts) {
        const client = await this.ensureClient();
        return client.send(messages, model, tools, sendOpts);
    }
    async listModels() {
        try {
            const client = await this.ensureClient();
            return client.listModels();
        }
        catch {
            return [];
        }
    }
    async isAvailable() {
        try {
            await this.ensureClient();
            return true;
        }
        catch {
            return false;
        }
    }
}
const providers = new Map();
export async function initProviders(config) {
    providers.clear();
    for (const [name, cfg] of Object.entries(config)) {
        if (!cfg.enabled)
            continue;
        try {
            if (name === 'anthropic') {
                providers.set(name, new AnthropicProvider(cfg));
            }
            else if (name === 'gemini') {
                providers.set(name, new GeminiProvider(cfg));
            }
            else if (name === 'copilot') {
                providers.set(name, new CopilotProvider(cfg));
            }
            else if (name === 'openai-oauth') {
                providers.set(name, new OpenAIOAuthProvider(cfg));
            }
            else if (name === 'anthropic-oauth') {
                providers.set(name, new AnthropicOAuthProvider(cfg));
            }
            else if (OPENAI_COMPAT_PROVIDERS.includes(name)) {
                providers.set(name, new OpenAICompatProvider(name, cfg));
            }
            else {
                providers.set(name, new OpenAICompatProvider(name, cfg));
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[provider] Skipping "${name}": ${msg}\n`);
        }
    }
}
export function getProvider(name) {
    return providers.get(name);
}
export function getAllProviders() {
    return providers;
}
export function listProviderNames() {
    return [...providers.keys()];
}
