import {
  cleanMemoryText,
} from './memory-extraction.mjs'

const MEMORY_TOKEN_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'did', 'do', 'does', 'for', 'from',
  'how', 'i', 'if', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our', 'so', 'that', 'the',
  'their', 'them', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'who', 'why', 'you',
  'your', 'unless', 'with',
  'user', 'assistant', 'requested', 'request', 'asked', 'ask', 'stated', 'state', 'reported', 'report',
  'mentioned', 'mention', 'clarified', 'clarify', 'explicitly', 'currently',
  '사용자', '유저', '요청', '질문', '답변', '언급', '말씀', '설명', '보고', '무슨', '뭐야', '했지', 'user', 'asks', 'asked', 'request', 'requested', 'question', 'answer', 'reply', 'said', 'mentioned', 'explained', 'reported', 'what', 'huh',
])

const SUBJECT_STOPWORDS = new Set([
  ...MEMORY_TOKEN_STOPWORDS,
  'active', 'current', 'ongoing', 'issue', 'issues', 'problem', 'weakness', 'weaknesses', 'thing', 'things',
  '현재', '핵심', '문제', '약점', '이슈',
])

export function firstTextContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}


export function looksLowSignalQuery(text) {
  const clean = cleanMemoryText(text)
  if (!clean) return true
  if (clean.includes('[Request interrupted by user]')) return true
  const compact = clean.replace(/\s+/g, '')
  if (!/[\p{L}\p{N}]/u.test(compact)) return true
  if (compact.length <= 1) return true
  return false
}

export function normalizeMemoryToken(token) {
  let normalized = String(token ?? '').trim().toLowerCase()
  if (!normalized) return ''

  // Korean suffix stripping: basic particles + compound endings
  if (/[\uAC00-\uD7AF]/.test(normalized) && normalized.length > 2) {
    const stripped = normalized
      .replace(/(했었지|했더라|됐었나|됐던가|했는지|였는지|인건가|하려면|에서는|이라서|였더라|에서도|이었지|으로도|거였지|한건지|이었나)$/u, '')
      .replace(/(했던|했지|됐던|됐지|하게|되던|이라|에서|으로|하는|없는|있는|었던|하자|않게|할때|인지|인데|인건|이고|보다|처럼|까지|부터|마다|밖에|없이)$/u, '')
      .replace(/(은|는|이|가|을|를|랑|과|와|도|에|의|로|만|며|나|고|서|자|요)$/u, '')
    if (stripped.length >= 2) normalized = stripped
  }

  if (/^[a-z][a-z0-9_-]+$/i.test(normalized)) {
    if (normalized.length > 5 && normalized.endsWith('ing')) normalized = normalized.slice(0, -3)
    else if (normalized.length > 4 && normalized.endsWith('ed')) normalized = normalized.slice(0, -2)
    else if (normalized.length > 4 && normalized.endsWith('es')) normalized = normalized.slice(0, -2)
    else if (normalized.length > 3 && normalized.endsWith('s')) normalized = normalized.slice(0, -1)
  }

  return normalized
}

export function tokenizeMemoryText(text) {
  return cleanMemoryText(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .map(token => normalizeMemoryToken(token))
    .filter(token => token.length >= 2)
    .filter(token => !MEMORY_TOKEN_STOPWORDS.has(token))
    .slice(0, 24)
}

// Extract normalized tokens from Korean compound words (for query-side overlap boost)
const KO_COMPOUND_KEYWORDS = [
  '스트럭쳐드', '싱글톤', '디스코드', '벤치마크', '아웃풋', '플러그인',
  '바인딩', '리스타트', '프로바이더', '슬래시커맨드', '스케쥴러',
  '임베딩', '임베드', '포워더', '포워드', '리트리벌', '아키텍처',
  '인젝션', '트리거', '컨솔리', '메모리', '메시지', '메세지',
  '타이밍', '리콜', '채널', '동기화', '세션', '승인', '동기',
  '수신', '즉시', '인라인', '클리어', '결과', '처리', '기준',
  '비교', '구조', '역할', '훅', '설정', '검색', '저장', '삭제',
  '복원', '테스트',
].sort((a, b) => b.length - a.length)

export function extractKoCompoundTokens(text) {
  const lower = cleanMemoryText(text).toLowerCase()
  const tokens = []
  for (const kw of KO_COMPOUND_KEYWORDS) {
    if (lower.includes(kw)) {
      const normalized = normalizeMemoryToken(kw)
      if (normalized.length >= 2 && !MEMORY_TOKEN_STOPWORDS.has(normalized)) {
        tokens.push(normalized)
      }
    }
  }
  return tokens
}

export function extractExplicitDate(text) {
  const clean = cleanMemoryText(text)
  const isoDateMatch = clean.match(/(\d{4})[-.](\d{2})[-.](\d{2})/)
  if (isoDateMatch) return `${isoDateMatch[1]}-${isoDateMatch[2]}-${isoDateMatch[3]}`
  const koreanDateMatch = clean.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/)
  if (koreanDateMatch) {
    return `${koreanDateMatch[1]}-${String(koreanDateMatch[2]).padStart(2, '0')}-${String(koreanDateMatch[3]).padStart(2, '0')}`
  }
  return null
}

export function propositionSubjectTokens(text) {
  return tokenizeMemoryText(text).filter(token => !SUBJECT_STOPWORDS.has(token))
}

export function buildFtsQuery(text) {
  const tokens = tokenizeMemoryText(text)
  if (tokens.length === 0) return ''
  // Include 2-char Korean tokens (they carry meaning unlike 2-char English)
  const ftsTokens = [...new Set(tokens)].filter(t => t.length >= 3 || (t.length === 2 && /[\uAC00-\uD7AF]/.test(t)))
  if (ftsTokens.length === 0) return ''
  // websearch_to_tsquery handles tokenization + OR/AND/quoting itself; pass plain tokens space-joined.
  return ftsTokens.map(t => t.replace(/["']/g, '')).filter(t => t.length > 0).join(' ')
}

export function getShortTokensForLike(text) {
  const tokens = tokenizeMemoryText(text)
  return [...new Set(tokens)].filter(t => t.length === 2)
}

export function shortTokenMatchScore(content, shortTokens = []) {
  const clean = cleanMemoryText(content)
  if (!clean || shortTokens.length === 0) return 0
  const matched = shortTokens.filter(token => clean.includes(token)).length
  if (matched === 0) return 0
  return -(matched / shortTokens.length) * 1.5
}

function escapeLikeToken(token) {
  return token.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

export function buildTokenLikePatterns(text) {
  const clean = cleanMemoryText(text)
  if (!clean) return []
  const tokens = [...new Set(tokenizeMemoryText(clean))]
  if (tokens.length > 0) return tokens.map(token => `%${escapeLikeToken(token)}%`)
  return [`%${escapeLikeToken(clean)}%`]
}

/**
 * Local-timezone ISO-like timestamp: "2026-04-01T17:30:00.123"
 * Uses system timezone (not hardcoded to KST).
 */
export function localNow() {
  const d = new Date()
  const pad = (n, len = 2) => String(n).padStart(len, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/**
 * Convert any Date-parseable string to local-timezone ISO-like format.
 * e.g. "2026-04-06T10:15:00.000Z" → "2026-04-06T19:15:00.000" on KST system.
 */
export function toLocalTs(input) {
  const d = new Date(input)
  if (isNaN(d.getTime())) return input  // unparseable → return as-is
  const pad = (n, len = 2) => String(n).padStart(len, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/**
 * Local-timezone date string: "2026-04-01"
 */
export function localDateStr(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
