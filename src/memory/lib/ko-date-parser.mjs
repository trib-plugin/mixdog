/**
 * Korean + English date parser — replaces Python dateparser dependency.
 *
 * Exports:
 *   parseKoreanDate(text, refDate?)  → { text, start: 'YYYY-MM-DD', end: null } | null
 *   searchDates(text, refDate?)      → [{ text, start: 'YYYY-MM-DD', end: null }, ...] | []
 *   parseTemporalHint(query)         → { start, end, exact } | null   (drop-in for memory-query-plan)
 */

// ── Helpers ──────────────────────────────────────────────────────────

function fmt(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDays(d, n) {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function addMonths(d, n) {
  const r = new Date(d)
  r.setMonth(r.getMonth() + n)
  return r
}

function startOfWeek(d) {
  // Monday = start of week
  const day = d.getDay()
  const diff = (day + 6) % 7
  return addDays(d, -diff)
}

function lastDayOfMonth(year, month) {
  // month is 0-indexed
  const d = new Date(year, month + 1, 0)
  return d.getDate()
}

const WEEKDAY_MAP = { '일': 0, '월': 1, '화': 2, '수': 3, '목': 4, '금': 5, '토': 6 }

// ── Korean patterns ──────────────────────────────────────────────────

const KO_PATTERNS = [
  // Exact single-day (longer patterns first to prevent partial match)
  { re: /오늘/, fn: (d) => ({ date: d, exact: true }) },
  { re: /어제/, fn: (d) => ({ date: addDays(d, -1), exact: true }) },
  { re: /엊그제|엊그저께/, fn: (d) => ({ start: addDays(d, -3), end: addDays(d, -2), exact: false }) },
  { re: /그저께|그제/, fn: (d) => ({ date: addDays(d, -2), exact: true }) },
  { re: /내일/, fn: (d) => ({ date: addDays(d, 1), exact: true }) },
  { re: /모레/, fn: (d) => ({ date: addDays(d, 2), exact: true }) },

  // N일/주/달/개월/년 전
  { re: /(\d+)\s*일\s*전/, fn: (d, m) => ({ date: addDays(d, -parseInt(m[1])), exact: true }) },
  { re: /(\d+)\s*주\s*전/, fn: (d, m) => {
    const weeks = parseInt(m[1])
    return { start: addDays(d, -weeks * 7 - 6), end: addDays(d, -(weeks - 1) * 7), exact: false }
  }},
  { re: /(\d+)\s*(?:달|개월)\s*전/, fn: (d, m) => {
    const n = parseInt(m[1])
    const s = addMonths(d, -n)
    return { start: s, end: addDays(addMonths(d, -(n - 1)), -1), exact: false }
  }},
  { re: /(\d+)\s*년\s*전/, fn: (d, m) => {
    const n = parseInt(m[1])
    const y = d.getFullYear() - n
    return { start: new Date(y, 0, 1), end: new Date(y, 11, 31), exact: false }
  }},

  // 지난/이번/다음 주/달
  { re: /지난\s*주/, fn: (d) => {
    const thisMonday = startOfWeek(d)
    return { start: addDays(thisMonday, -7), end: addDays(thisMonday, -1), exact: false }
  }},
  { re: /이번\s*주/, fn: (d) => {
    const thisMonday = startOfWeek(d)
    return { start: thisMonday, end: addDays(thisMonday, 6), exact: false }
  }},
  { re: /다음\s*주/, fn: (d) => {
    const thisMonday = startOfWeek(d)
    return { start: addDays(thisMonday, 7), end: addDays(thisMonday, 13), exact: false }
  }},
  { re: /지난\s*달/, fn: (d) => {
    const prev = addMonths(d, -1)
    const y = prev.getFullYear(), m = prev.getMonth()
    return { start: new Date(y, m, 1), end: new Date(y, m, lastDayOfMonth(y, m)), exact: false }
  }},
  { re: /이번\s*달/, fn: (d) => {
    const y = d.getFullYear(), m = d.getMonth()
    return { start: new Date(y, m, 1), end: new Date(y, m, lastDayOfMonth(y, m)), exact: false }
  }},
  { re: /다음\s*달/, fn: (d) => {
    const next = addMonths(d, 1)
    const y = next.getFullYear(), m = next.getMonth()
    return { start: new Date(y, m, 1), end: new Date(y, m, lastDayOfMonth(y, m)), exact: false }
  }},

  // 작년/올해/내년
  { re: /작년|지난\s*해/, fn: (d) => {
    const y = d.getFullYear() - 1
    return { start: new Date(y, 0, 1), end: new Date(y, 11, 31), exact: false }
  }},
  { re: /올해/, fn: (d) => {
    const y = d.getFullYear()
    return { start: new Date(y, 0, 1), end: new Date(y, 11, 31), exact: false }
  }},
  { re: /내년/, fn: (d) => {
    const y = d.getFullYear() + 1
    return { start: new Date(y, 0, 1), end: new Date(y, 11, 31), exact: false }
  }},

  // 방금/아까/조금 전
  { re: /방금|아까|조금\s*전/, fn: (d) => ({ date: d, exact: false }) },

  // 최근/요즘
  { re: /최근|요즘/, fn: (d) => ({ start: addDays(d, -3), end: d, exact: false }) },

  // YYYY년 M월 D일
  { re: /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/, fn: (_d, m) => {
    return { date: new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])), exact: true }
  }},

  // M월 D일 (current year)
  { re: /(\d{1,2})월\s*(\d{1,2})일/, fn: (d, m) => {
    return { date: new Date(d.getFullYear(), parseInt(m[1]) - 1, parseInt(m[2])), exact: true }
  }},

  // M월 (whole month, current year)
  { re: /(\d{1,2})월/, fn: (d, m) => {
    const mo = parseInt(m[1]) - 1
    const y = d.getFullYear()
    return { start: new Date(y, mo, 1), end: new Date(y, mo, lastDayOfMonth(y, mo)), exact: false }
  }},

  // 지난 X요일
  { re: /지난\s*([일월화수목금토])요일/, fn: (d, m) => {
    const target = WEEKDAY_MAP[m[1]]
    if (target == null) return null
    const current = d.getDay()
    let diff = ((current - target) + 7) % 7 || 7
    return { date: addDays(d, -diff), exact: true }
  }},

  // 이번 X요일
  { re: /이번\s*([일월화수목금토])요일/, fn: (d, m) => {
    const target = WEEKDAY_MAP[m[1]]
    if (target == null) return null
    const thisMonday = startOfWeek(d)
    const targetOffset = (target + 6) % 7 // Mon=0, Tue=1, ..., Sun=6
    return { date: addDays(thisMonday, targetOffset), exact: true }
  }},

  // 다음 X요일
  { re: /다음\s*([일월화수목금토])요일/, fn: (d, m) => {
    const target = WEEKDAY_MAP[m[1]]
    if (target == null) return null
    const thisMonday = startOfWeek(d)
    const nextMonday = addDays(thisMonday, 7)
    const targetOffset = (target + 6) % 7
    return { date: addDays(nextMonday, targetOffset), exact: true }
  }},
]

// ── English patterns ─────────────────────────────────────────────────

const EN_PATTERNS = [
  { re: /\btoday\b/i, fn: (d) => ({ date: d, exact: true }) },
  { re: /\byesterday\b/i, fn: (d) => ({ date: addDays(d, -1), exact: true }) },
  { re: /\btomorrow\b/i, fn: (d) => ({ date: addDays(d, 1), exact: true }) },
  { re: /\b(?:two days ago|day before yesterday)\b/i, fn: (d) => ({ date: addDays(d, -2), exact: true }) },
  { re: /\b(\d+)\s+days?\s+ago\b/i, fn: (d, m) => ({ date: addDays(d, -parseInt(m[1])), exact: true }) },
  { re: /\b(\d+)\s+weeks?\s+ago\b/i, fn: (d, m) => {
    const w = parseInt(m[1])
    return { start: addDays(d, -w * 7 - 6), end: addDays(d, -(w - 1) * 7), exact: false }
  }},
  { re: /\b(\d+)\s+months?\s+ago\b/i, fn: (d, m) => {
    const n = parseInt(m[1])
    return { start: addMonths(d, -n), end: addDays(addMonths(d, -(n - 1)), -1), exact: false }
  }},
  { re: /\blast\s*week\b/i, fn: (d) => {
    const thisMonday = startOfWeek(d)
    return { start: addDays(thisMonday, -7), end: addDays(thisMonday, -1), exact: false }
  }},
  { re: /\bthis[-_\s]*week\b/i, fn: (d) => {
    const thisMonday = startOfWeek(d)
    return { start: thisMonday, end: addDays(thisMonday, 6), exact: false }
  }},
  { re: /\bnext\s*week\b/i, fn: (d) => {
    const thisMonday = startOfWeek(d)
    return { start: addDays(thisMonday, 7), end: addDays(thisMonday, 13), exact: false }
  }},
  { re: /\blast\s*month\b/i, fn: (d) => {
    const prev = addMonths(d, -1)
    const y = prev.getFullYear(), m = prev.getMonth()
    return { start: new Date(y, m, 1), end: new Date(y, m, lastDayOfMonth(y, m)), exact: false }
  }},
  { re: /\bthis\s*month\b/i, fn: (d) => {
    const y = d.getFullYear(), m = d.getMonth()
    return { start: new Date(y, m, 1), end: new Date(y, m, lastDayOfMonth(y, m)), exact: false }
  }},
  { re: /\blast\s*year\b/i, fn: (d) => {
    const y = d.getFullYear() - 1
    return { start: new Date(y, 0, 1), end: new Date(y, 11, 31), exact: false }
  }},
  { re: /\bthis\s*year\b/i, fn: (d) => {
    const y = d.getFullYear()
    return { start: new Date(y, 0, 1), end: new Date(y, 11, 31), exact: false }
  }},
  { re: /\brecently\b/i, fn: (d) => ({ start: addDays(d, -3), end: d, exact: false }) },
]

// ── ISO / slash date patterns (language-neutral) ─────────────────────

const NEUTRAL_PATTERNS = [
  // YYYY-MM-DD or YYYY.MM.DD
  { re: /(\d{4})[-.](\d{2})[-.](\d{2})/, fn: (_d, m) => {
    return { date: new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])), exact: true }
  }},
  // YYYY-MM (whole month)
  { re: /(\d{4})[-.](\d{2})(?![-.]\d)/, fn: (_d, m) => {
    const y = parseInt(m[1]), mo = parseInt(m[2]) - 1
    if (mo < 0 || mo > 11) return null
    return { start: new Date(y, mo, 1), end: new Date(y, mo, lastDayOfMonth(y, mo)), exact: false }
  }},
  // M/D (current year)
  { re: /\b(\d{1,2})\/(\d{1,2})\b/, fn: (d, m) => {
    const mo = parseInt(m[1]) - 1, day = parseInt(m[2])
    if (mo < 0 || mo > 11 || day < 1 || day > 31) return null
    return { date: new Date(d.getFullYear(), mo, day), exact: true }
  }},
]

const ALL_PATTERNS = [...KO_PATTERNS, ...EN_PATTERNS, ...NEUTRAL_PATTERNS]

// ── Core: resolve a pattern result to { text, start, end } ───────────

function resolveResult(matched, match) {
  if (!matched) return null
  if (matched.date) {
    const s = fmt(matched.date)
    return { text: match[0], start: s, end: null, exact: matched.exact ?? true }
  }
  if (matched.start) {
    return {
      text: match[0],
      start: fmt(matched.start),
      end: fmt(matched.end ?? matched.start),
      exact: matched.exact ?? false,
    }
  }
  return null
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Parse a single Korean/English date expression.
 * Returns { text, start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' | null } or null.
 * Compatible with Python dateparser /temporal endpoint output format.
 */
export function parseKoreanDate(text, refDate) {
  const ref = refDate ? new Date(refDate) : new Date()
  for (const { re, fn } of ALL_PATTERNS) {
    const match = text.match(re)
    if (match) {
      const result = fn(ref, match)
      const resolved = resolveResult(result, match)
      if (resolved) return resolved
    }
  }
  return null
}

/**
 * Search for date expressions within longer text (like dateparser.search.search_dates).
 * Returns array of { text, start, end }.
 */
export function searchDates(text, refDate) {
  const ref = refDate ? new Date(refDate) : new Date()
  const results = []
  const usedRanges = []

  for (const { re, fn } of ALL_PATTERNS) {
    // Use global flag for search
    const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    let match
    while ((match = globalRe.exec(text)) !== null) {
      const matchStart = match.index
      const matchEnd = match.index + match[0].length

      // Skip if this range overlaps with an already-found match
      const overlaps = usedRanges.some(([s, e]) => matchStart < e && matchEnd > s)
      if (overlaps) continue

      const result = fn(ref, match)
      const resolved = resolveResult(result, match)
      if (resolved) {
        results.push(resolved)
        usedRanges.push([matchStart, matchEnd])
      }
    }
  }

  return results
}

/**
 * Drop-in replacement for parseTemporalHint in memory-query-plan.mjs.
 * Returns { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', exact: boolean } or null.
 */
export function parseTemporalHint(query) {
  const parsed = parseKoreanDate(query)
  if (!parsed) return null
  return {
    start: parsed.start,
    end: parsed.end ?? parsed.start,
    exact: parsed.exact ?? true,
  }
}
