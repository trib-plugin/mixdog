export const CATEGORY_GRADE = {
  rule: 2.0, constraint: 1.9, decision: 1.8, fact: 1.6,
  goal: 1.5, preference: 1.4, task: 1.1, issue: 1.0,
}

export const CATEGORY_DECAY = {
  rule: 0.0, constraint: 0.06, decision: 0.15, fact: 0.25,
  goal: 0.30, preference: 0.35, task: 0.45, issue: 0.50,
}

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

export function computeEntryScore(category, lastSeenAt, nowMs) {
  const grade = CATEGORY_GRADE[category]
  const rate = CATEGORY_DECAY[category]
  if (grade == null || rate == null) return null
  const anchor = Number.isFinite(Number(lastSeenAt)) ? Number(lastSeenAt) : nowMs
  const ageDays = Math.max(0, (nowMs - anchor) / 86_400_000)
  const adjustedAge = ageDays * rate
  const decay = 1 / Math.pow(1 + adjustedAge / 30, 0.3)
  return Math.min(grade, grade * decay)
}
