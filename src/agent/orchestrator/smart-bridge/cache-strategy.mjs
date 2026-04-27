/**
 * Smart Bridge — Cache Strategy
 *
 * Provider-level cache policy. Anthropic supports explicit cache_control
 * breakpoints (up to 4 per request) — we use all 4 slots. Non-breakpoint
 * providers rely on server-side automatic prefix matching or dedicated
 * cache objects.
 *
 * Anthropic 4-BP layout (bridge/agent use case — no interactive idle):
 *   BP_1  tools      (1h)  — tool schemas, stable per role
 *   BP_2  system     (1h)  — Tier 2 shared rules
 *   BP_3  tier3      (1h)  — role/permission meta (messages[1] system-reminder)
 *   BP_4  messages   (5m)  — last message only; sliding extends prefix loss-free
 *
 * Tier 3 gets its own BP because role meta is stable per dispatch, so a
 * dedicated slot gives a reliable hit across the entire tool loop while
 * the sliding messages BP handles volatile tool_result accumulation.
 *
 * Non-breakpoint providers:
 *   - OpenAI (public): prompt_cache_key + prompt_cache_retention=24h
 *   - OpenAI OAuth (Codex): prompt_cache_key only (server in-memory 5-10min)
 *   - Gemini: explicit cachedContent object, 1h TTL, append-extension reuse
 *   - Groq: auto 50% cache (gpt-oss-120b) — no knob
 *   - Copilot / xAI / Ollama / LMStudio: no API-level cache
 */

/**
 * Return the layered cache policy for Anthropic-family providers.
 *
 * Values:
 *   '1h'   → ephemeral 1h TTL  (2x write premium, 0.1x read)
 *   '5m'   → ephemeral 5m TTL  (1.25x write premium, 0.1x read)
 *   'none' → no cache_control  (1x flat, no premium, no cache)
 *
 * Bridge/agent calls never experience interactive idle that would threaten
 * the 5m tail TTL, so a single policy applies to every role.
 */
export function resolveCacheStrategy() {
    return { tools: '1h', system: '1h', tier3: '1h', messages: '5m' };
}

/**
 * Build provider-specific sendOpts.
 *
 * @param {string} provider
 * @param {string} [sessionId]
 * @returns {object} partial sendOpts — spread into provider.send call
 */
export function buildProviderCacheOpts(provider, sessionId) {
    const ttls = resolveCacheStrategy();

    switch (provider) {
        case 'anthropic-oauth':
        case 'anthropic':
            // 2026-03-06 Anthropic dropped default TTL 1h→5m. We send
            // extended-cache-ttl-2025-04-11 header to retain 1h.
            // Verified 2026-04-17 (ephemeral_1h_input_tokens=4722).
            return { cacheStrategy: ttls };

        case 'openai-oauth':
            // Codex endpoint rejects prompt_cache_retention. We rely on the
            // server-side default in_memory cache (5-10min). The server still
            // prefix-caches if the prefix is reused within the in-memory window.
            return {};

        case 'openai':
            // Public OpenAI API supports prompt_cache_retention. Both cache
            // types want extended retention — the prefix is shared across
            // every Pool B call in the workspace.
            return { cacheRetention: '24h' };

        case 'gemini':
            // Gemini uses cache objects. Signal intent; the provider layer
            // creates/updates the object separately from the message.
            return {
                geminiCache: {
                    enabled: true,
                    ttlSeconds: ttlToSeconds(ttls.system),
                },
            };

        case 'deepseek':
            // Automatic context cache, hit token reported via prompt_cache_hit_tokens
            return {};

        case 'ollama':
            // Local KV cache only, no API-level surface
            return {};

        case 'lmstudio':
            // Local, no API cache
            return {};

        default:
            return {};
    }
}

/**
 * Prefix content used to derive the cache hash for registry tracking.
 * Excludes the volatile user message — only the stable prefix (tools,
 * system) determines whether our cache is "still warm". The Pool B prefix
 * is workspace-wide, so a single hash represents every Pool B caller.
 *
 * `systemPrompt` accepts either a single string (legacy callers — hashed
 * as a single-element sequence) or an array of system-role message
 * contents in their send order (BP1 / BP2 / ...). Arrays are serialized
 * deterministically as a JSON array so the registry hash captures the
 * full ordered provider prefix — missing BP2 (role catalog) caused the
 * registry snapshot to be incomplete.
 */
export function computePrefixContent(systemPrompt, tools) {
    let systemMessages;
    if (Array.isArray(systemPrompt)) {
        systemMessages = systemPrompt.map(s => s == null ? '' : String(s));
    } else {
        systemMessages = [systemPrompt == null ? '' : String(systemPrompt)];
    }
    return {
        systemPrompt: JSON.stringify(systemMessages),
        tools: (tools || []).map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        })),
    };
}

/**
 * Longest-lived layer TTL (seconds) for registry expiry tracking.
 */
export function ttlSecondsForCache() {
    const ttls = resolveCacheStrategy();
    return Math.max(
        ttlToSeconds(ttls.tools),
        ttlToSeconds(ttls.system),
        ttlToSeconds(ttls.messages),
    );
}

// --- Helpers ---

function ttlToSeconds(v) {
    if (v === '24h') return 86400;
    if (v === '1h') return 3600;
    if (v === '5m') return 300;
    return 0;
}
