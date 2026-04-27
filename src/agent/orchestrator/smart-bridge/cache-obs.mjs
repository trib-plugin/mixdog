/**
 * Smart Bridge — Cache Observability
 *
 * Normalizes raw provider usage objects into a unified CacheObservation
 * for cross-provider cache performance comparison.
 *
 * @typedef {Object} CacheObservation
 * @property {string}  provider           — provider name
 * @property {number}  cache_hit_tokens   — tokens read from cache
 * @property {number}  cache_write_tokens — tokens written to cache
 * @property {string|null} cache_ttl_tier — '5m' | '1h' | null
 * @property {number|null} cache_hit_ratio — 0.0–1.0, null if not computable
 * @property {boolean} cache_observable   — whether the provider reports cache metrics
 */

/**
 * Normalize raw provider usage into a CacheObservation.
 *
 * @param {string} provider — one of the 10 supported providers
 * @param {object} rawUsage — raw usage object from provider response
 * @returns {CacheObservation}
 */
export function normalizeUsage(provider, rawUsage) {
    if (!rawUsage) {
        return _empty(provider, false);
    }

    switch (provider) {
        case 'anthropic':
        case 'anthropic-oauth':
            return _normalizeAnthropic(provider, rawUsage);

        case 'openai':
        case 'openai-oauth':
            return _normalizeOpenai(provider, rawUsage);

        case 'gemini':
            return _normalizeGemini(provider, rawUsage);

        case 'deepseek':
            return _normalizeOpenai(provider, rawUsage);

        case 'ollama':
        case 'lmstudio':
            return _empty(provider, false);

        default:
            return _empty(provider, false);
    }
}

// --- Per-provider extractors ---

function _normalizeAnthropic(provider, u) {
    const hit = _num(u.cache_read_input_tokens);
    const write = _num(u.cache_creation_input_tokens);
    const input = _num(u.input_tokens);

    // TTL tier: pick from cache_creation breakdown
    let ttlTier = null;
    if (u.cache_creation) {
        if (_num(u.cache_creation.ephemeral_1h_input_tokens) > 0) ttlTier = '1h';
        else if (_num(u.cache_creation.ephemeral_5m_input_tokens) > 0) ttlTier = '5m';
    }

    const total = hit + input + write;
    const ratio = total > 0 ? hit / total : null;

    return {
        provider,
        cache_hit_tokens: hit,
        cache_write_tokens: write,
        cache_ttl_tier: ttlTier,
        cache_hit_ratio: ratio,
        cache_observable: true,
    };
}

function _normalizeOpenai(provider, u) {
    // OpenAI: cached_tokens in prompt_tokens_details or input_tokens_details
    const hit = _num(u.prompt_tokens_details?.cached_tokens)
             || _num(u.input_tokens_details?.cached_tokens)
             || 0;
    const input = _num(u.prompt_tokens) || _num(u.input_tokens) || 0;
    const ratio = input > 0 ? hit / input : null;

    return {
        provider,
        cache_hit_tokens: hit,
        cache_write_tokens: 0,
        cache_ttl_tier: null,
        cache_hit_ratio: ratio,
        cache_observable: true,
    };
}

function _normalizeGemini(provider, u) {
    // Gemini: usageMetadata.cachedContentTokenCount
    const meta = u.usageMetadata || u;
    const hit = _num(meta.cachedContentTokenCount);
    const observable = 'cachedContentTokenCount' in (meta || {});
    const input = _num(meta.promptTokenCount) || _num(meta.totalTokenCount) || 0;
    const ratio = input > 0 && hit > 0 ? hit / input : null;

    return {
        provider,
        cache_hit_tokens: hit,
        cache_write_tokens: 0,
        cache_ttl_tier: null,
        cache_hit_ratio: ratio,
        cache_observable: observable,
    };
}

// --- Helpers ---

function _empty(provider, observable) {
    return {
        provider,
        cache_hit_tokens: 0,
        cache_write_tokens: 0,
        cache_ttl_tier: null,
        cache_hit_ratio: null,
        cache_observable: observable,
    };
}

function _num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}
