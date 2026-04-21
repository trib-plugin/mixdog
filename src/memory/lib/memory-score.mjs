export const CATEGORY_GRADE = {
  rule: 2.0, constraint: 1.9, decision: 1.8, fact: 1.6,
  goal: 1.5, preference: 1.4, task: 1.1, issue: 1.0,
}

export const CATEGORY_DECAY = {
  rule: 0.0, constraint: 0.06, decision: 0.15, fact: 0.25,
  goal: 0.30, preference: 0.35, task: 0.45, issue: 0.50,
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
