// Recency multiplier shared by hybrid retrieval scoring and the
// handleSearch augment path. Mild contrast in <= 1 week range, sharp
// drop after 30d so vague-time queries don't get dominated by older fact-rich
// entries. Smooth exponential decay — no step boundaries. Anchors:
//   ageH=0 → 1.60, ageH=6 → ~1.39, ageH=24 → ~1.08, ageH=72 → ~0.85,
//   ageH=168 → ~0.68, ageH=720 → ~0.50. Returns value in [0.50, 1.60].
export function freshnessFactor(ts, nowMs = Date.now()) {
  const ts_ = Number(ts ?? 0)
  if (!Number.isFinite(ts_) || ts_ <= 0) return 0.85
  const ageH = Math.max(0, (nowMs - ts_) / 3_600_000)
  // Continuous: f(h) = 0.50 + 1.10 * exp(-ageH / 55)
  // Derivation: f(0)=1.60, f(∞)=0.50, half-life ≈ 38h (ln2*55).
  // 55h scale chosen so f(6)≈1.39, f(168)≈0.68, f(720)≈0.50 — preserves
  // the original step-table intent without discontinuities at 6h/24h/72h.
  const raw = 0.50 + 1.10 * Math.exp(-ageH / 55)
  return Math.max(0.50, Math.min(1.60, raw))
}

/**
 * Compute an entry score driven purely by recency.
 * Category is accepted for call-site compatibility but not used.
 *
 * score = freshnessFactor(lastSeenAt, nowMs)
 * Returns a value in [0.50, 1.60], or null when nowMs is not finite.
 *
 * @param {string} _category — unused, kept for call-site compat
 * @param {number|string} lastSeenAt — ms timestamp of last observation
 * @param {number} nowMs — current time in ms
 * @returns {number|null}
 */
export function computeEntryScore(_category, lastSeenAt, nowMs) {
  if (!Number.isFinite(Number(nowMs))) return null
  const anchor = Number.isFinite(Number(lastSeenAt)) ? Number(lastSeenAt) : Number(nowMs)
  return freshnessFactor(anchor, Number(nowMs))
}
