/**
 * Model Catalog Enricher
 *
 * Providers' native /v1/models endpoints return ids but rarely include
 * metadata (context window, output limit, pricing). We fetch LiteLLM's
 * public catalog — a community-maintained JSON of 2600+ models across
 * 140+ providers — and use it as the metadata source.
 *
 * Source: https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
 *
 * The catalog is cached on disk for 24h. On fetch failure, providers fall
 * back to whatever metadata their native endpoint exposed (usually nothing
 * beyond the id). Pricing stays null in that case; UI shows "-" instead of
 * a stale number.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPluginData } from '../config.mjs';

const CATALOG_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CATALOG_CACHE_FILE = 'litellm-catalog.json';
const CATALOG_TTL_MS = 24 * 60 * 60_000;

let _memCache = null;
let _memCacheAt = 0;

function cachePath() {
    return join(getPluginData(), CATALOG_CACHE_FILE);
}

async function loadCatalog() {
    if (_memCache && (Date.now() - _memCacheAt) < CATALOG_TTL_MS) return _memCache;
    // Disk cache first
    try {
        if (existsSync(cachePath())) {
            const raw = JSON.parse(readFileSync(cachePath(), 'utf-8'));
            if (raw?.fetchedAt && (Date.now() - raw.fetchedAt) < CATALOG_TTL_MS && raw.data) {
                _memCache = raw.data;
                _memCacheAt = raw.fetchedAt;
                return _memCache;
            }
        }
    } catch { /* fall through */ }
    // Remote fetch
    try {
        const res = await fetch(CATALOG_URL);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        try {
            writeFileSync(cachePath(), JSON.stringify({ fetchedAt: Date.now(), data }));
        } catch { /* cache is best-effort */ }
        _memCache = data;
        _memCacheAt = Date.now();
        return data;
    } catch (err) {
        process.stderr.write(`[model-catalog] fetch failed: ${err.message}\n`);
        return {};
    }
}

function warmFromDiskSync() {
    if (_memCache) return;
    try {
        const raw = JSON.parse(readFileSync(cachePath(), 'utf-8'));
        if (raw?.data) {
            _memCache = raw.data;
            _memCacheAt = raw.fetchedAt || Date.now();
        }
    } catch { /* disk cache unavailable — stay cold, async warm will fill later */ }
}

/**
 * Sync lookup. Warm order:
 *   1. in-memory cache (hot path),
 *   2. disk cache one-shot read if memory is cold (first call after boot),
 *   3. null if neither is available (async loadCatalog will fill later).
 *
 * Used by hot-path loggers (bridge-trace usage row) that must not await.
 * The disk fallback is a single ~5ms blocking read on cold start; all
 * subsequent calls hit memory. TTL is intentionally ignored here — stale
 * catalog beats no catalog, and the async path refreshes on schedule.
 */
export function getModelMetadataSync(id) {
    if (!id) return null;
    if (!_memCache) warmFromDiskSync();
    if (!_memCache) return null;
    const catalog = _memCache;
    if (catalog[id]) return _normalize(catalog[id]);
    for (const prefix of ['anthropic/', 'openai/', 'gemini/', 'google/', 'openrouter/anthropic/', 'openrouter/openai/']) {
        if (catalog[prefix + id]) return _normalize(catalog[prefix + id]);
    }
    for (const prefix of ['anthropic.', 'bedrock/anthropic.']) {
        const v1 = catalog[prefix + id + '-v1:0'];
        if (v1) return _normalize(v1);
    }
    return null;
}

/**
 * Look up metadata for a model id. Returns null if the catalog doesn't
 * have the model. Matches exact id first, then with common prefix variants
 * ("anthropic/", "openai/", etc.) to bridge provider conventions.
 */
export async function getModelMetadata(id) {
    if (!id) return null;
    const catalog = await loadCatalog();
    // Exact match
    if (catalog[id]) return _normalize(catalog[id]);
    // Provider-prefixed variants
    for (const prefix of ['anthropic/', 'openai/', 'gemini/', 'google/', 'openrouter/anthropic/', 'openrouter/openai/']) {
        if (catalog[prefix + id]) return _normalize(catalog[prefix + id]);
    }
    // AWS Bedrock variants (anthropic.claude-...-v1:0)
    for (const prefix of ['anthropic.', 'bedrock/anthropic.']) {
        const v1 = catalog[prefix + id + '-v1:0'];
        if (v1) return _normalize(v1);
    }
    return null;
}

function _normalize(entry) {
    if (!entry || typeof entry !== 'object') return null;
    return {
        contextWindow: entry.max_input_tokens || entry.max_tokens || null,
        outputTokens: entry.max_output_tokens || null,
        inputCostPerM: entry.input_cost_per_token != null ? entry.input_cost_per_token * 1_000_000 : null,
        outputCostPerM: entry.output_cost_per_token != null ? entry.output_cost_per_token * 1_000_000 : null,
        cacheReadCostPerM: entry.cache_read_input_token_cost != null ? entry.cache_read_input_token_cost * 1_000_000 : null,
        cacheWriteCostPerM: entry.cache_creation_input_token_cost != null ? entry.cache_creation_input_token_cost * 1_000_000 : null,
        supportsVision: entry.supports_vision === true,
        supportsFunctionCalling: entry.supports_function_calling === true,
        supportsPromptCaching: entry.supports_prompt_caching === true,
        mode: entry.mode || null,
    };
}

/**
 * Enrich a list of {id} models with catalog metadata in parallel. Missing
 * entries keep their original shape (no metadata) so callers can distinguish
 * "known in catalog" from "no metadata available".
 */
export async function enrichModels(models) {
    if (!Array.isArray(models)) return models;
    const catalog = await loadCatalog();
    return models.map(m => {
        const id = m.id || m.name;
        if (!id) return m;
        // Same lookup logic as getModelMetadata but inlined for speed.
        let entry = catalog[id];
        if (!entry) {
            for (const prefix of ['anthropic/', 'openai/', 'gemini/', 'google/']) {
                if (catalog[prefix + id]) { entry = catalog[prefix + id]; break; }
            }
        }
        if (!entry) {
            for (const prefix of ['anthropic.', 'bedrock/anthropic.']) {
                if (catalog[prefix + id + '-v1:0']) { entry = catalog[prefix + id + '-v1:0']; break; }
            }
        }
        const meta = entry ? _normalize(entry) : null;
        if (!meta) return m;
        return {
            ...m,
            contextWindow: meta.contextWindow || m.contextWindow || null,
            outputTokens: meta.outputTokens || m.outputTokens || null,
            inputCostPerM: meta.inputCostPerM,
            outputCostPerM: meta.outputCostPerM,
            cacheReadCostPerM: meta.cacheReadCostPerM,
            cacheWriteCostPerM: meta.cacheWriteCostPerM,
            supportsVision: meta.supportsVision,
            supportsFunctionCalling: meta.supportsFunctionCalling,
            supportsPromptCaching: meta.supportsPromptCaching,
            mode: meta.mode || m.mode || null,
        };
    });
}

/**
 * Force-refresh the catalog by ignoring cached data and re-fetching.
 * Exposed so a user-initiated "refresh catalog" action in the UI can
 * bypass the 24h TTL.
 */
export async function refreshCatalog() {
    _memCache = null;
    _memCacheAt = 0;
    try {
        if (existsSync(cachePath())) {
            const fs = await import('fs');
            fs.unlinkSync(cachePath());
        }
    } catch { /* ignore */ }
    return loadCatalog();
}
