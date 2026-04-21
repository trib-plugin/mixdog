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

/**
 * @param {object} args
 * @param {string} args.model
 * @param {number} [args.inputTokens]
 * @param {number} [args.outputTokens]
 * @param {number} [args.cacheReadTokens]
 * @param {number} [args.cacheWriteTokens]
 * @returns {number} USD, rounded to 6 decimal places.
 */
export function computeCostUsd(args) {
    const meta = getModelMetadataSync(args?.model);
    if (!meta) return 0;
    const parts = [
        (args.inputTokens || 0) * (meta.inputCostPerM || 0),
        (args.outputTokens || 0) * (meta.outputCostPerM || 0),
        (args.cacheReadTokens || 0) * (meta.cacheReadCostPerM || 0),
        (args.cacheWriteTokens || 0) * (meta.cacheWriteCostPerM || 0),
    ];
    const total = parts.reduce((s, x) => s + x, 0) / 1_000_000;
    if (!Number.isFinite(total) || total <= 0) return 0;
    return Number(total.toFixed(6));
}
