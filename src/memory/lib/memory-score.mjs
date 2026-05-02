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
// drop after 30d so vague-time queries don't get dominated by older
// fact-rich entries.
export function freshnessFactor(ts, nowMs = Date.now()) {
  const ts_ = Number(ts ?? 0)
  if (!Number.isFinite(ts_) || ts_ <= 0) return 0.85
  const ageH = Math.max(0, (nowMs - ts_) / 3_600_000)
  if (ageH < 6) return 1.60
  if (ageH < 24) return 1.40
  if (ageH < 24 * 3) return 1.20
  if (ageH < 24 * 7) return 1.00
  if (ageH < 24 * 30) return 0.70
  return 0.50
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
