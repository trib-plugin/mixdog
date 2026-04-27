/**
 * Per-call cost estimator for bridge-trace usage rows.
 *
 * Pricing is pulled from the LiteLLM catalog (already warmed by providers/
 * agent bootstrap). All four token slots — input / output / cacheRead /
 * cacheWrite — are multiplied by their matching $/M rate from the catalog
 * and summed. Missing rates are treated as 0 (no extrapolation).
 *
 * The catalog is looked up synchronously: if it has not been warmed yet
 * (fresh process, first call), this returns 0 without blocking. The next
 * call will pick up the cache.
 */

import { getModelMetadataSync } from '../../agent/orchestrator/providers/model-catalog.mjs';

// OpenAI / Codex / Gemini report `input_tokens` as the total prompt token
// count *including* the cached portion (inclusive). Anthropic reports the
// uncached remainder only and bills cached_read / cached_write as separate
// additive slots (additive). Cost and prompt-total math has to branch on this.
export function isInclusiveProvider(provider) {
    if (!provider) return false;
    const p = String(provider).toLowerCase();
    return p.includes('openai') || p.includes('codex') || p.includes('gemini') || p.includes('google');
}

/**
 * @param {object} args
 * @param {string} args.model
 * @param {string} [args.provider]
 * @param {number} [args.inputTokens]
 * @param {number} [args.outputTokens]
 * @param {number} [args.cacheReadTokens]
 * @param {number} [args.cacheWriteTokens]
 * @returns {number} USD, rounded to 6 decimal places.
 */
export function computeCostUsd(args) {
    const meta = getModelMetadataSync(args?.model);
    if (!meta) return 0;
    const inputTokens = args.inputTokens || 0;
    const outputTokens = args.outputTokens || 0;
    const cacheReadTokens = args.cacheReadTokens || 0;
    const cacheWriteTokens = args.cacheWriteTokens || 0;
    const billableInput = isInclusiveProvider(args.provider)
        ? Math.max(inputTokens - cacheReadTokens - cacheWriteTokens, 0)
        : inputTokens;
    const parts = [
        billableInput * (meta.inputCostPerM || 0),
        outputTokens * (meta.outputCostPerM || 0),
        cacheReadTokens * (meta.cacheReadCostPerM || 0),
        cacheWriteTokens * (meta.cacheWriteCostPerM || 0),
    ];
    const total = parts.reduce((s, x) => s + x, 0) / 1_000_000;
    if (!Number.isFinite(total) || total <= 0) return 0;
    return Number(total.toFixed(6));
}
