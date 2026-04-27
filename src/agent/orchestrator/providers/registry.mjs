import { OpenAICompatProvider } from './openai-compat.mjs';
import { AnthropicProvider } from './anthropic.mjs';
import { GeminiProvider } from './gemini.mjs';
import { OpenAIOAuthProvider } from './openai-oauth.mjs';
import { AnthropicOAuthProvider } from './anthropic-oauth.mjs';
import { OpenAIDirectProvider } from './openai-ws.mjs';
const OPENAI_COMPAT_PROVIDERS = ['deepseek', 'xai', 'ollama', 'lmstudio'];
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
            else if (name === 'openai-oauth') {
                providers.set(name, new OpenAIOAuthProvider(cfg));
            }
            else if (name === 'anthropic-oauth') {
                providers.set(name, new AnthropicOAuthProvider(cfg));
            }
            else if (name === 'openai') {
                providers.set(name, new OpenAIDirectProvider(cfg));
            }
            else if (OPENAI_COMPAT_PROVIDERS.includes(name)) {
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
