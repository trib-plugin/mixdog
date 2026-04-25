import {
  cleanMemoryText,
  classifyCandidateConcept,
} from './memory-extraction.mjs'

const MEMORY_TOKEN_ALIASES = new Map([
  ['윈도우', 'windows'],
  ['호환성', 'compatibility'],
  ['대응', 'compatibility'],
  ['중복', 'duplicate'],
  ['메시지', 'message'],
  ['리콜', 'recall'],
  ['배포', 'deploy'],
  ['빌드', 'build'],
  ['커밋', 'commit'],
  ['푸시', 'push'],
  ['클라', 'client'],
  ['서버', 'server'],
  ['호칭', 'address'],
  ['말투', 'tone'],
  ['어투', 'tone'],
  ['시간대', 'timezone'],
  ['타임존', 'timezone'],
  ['deployment', 'deploy'],
  // dev & infra terms
  ['권한', 'permission'],
  ['스케줄', 'schedule'],
  ['채널', 'channel'],
  ['디스코드', 'discord'],
  ['파이프라인', 'pipeline'],
  ['트리거', 'trigger'],
  ['플러그인', 'plugin'],
  ['익스플로러', 'explorer'],
  ['탐색', 'explore'],
  ['임베딩', 'embedding'],
  ['벡터', 'vector'],
  ['모델', 'model'],
  ['프롬프트', 'prompt'],
  ['토큰', 'token'],
  ['데이터', 'data'],
  ['인덱스', 'index'],
  ['캐시', 'cache'],
  ['로그', 'log'],
  ['에러', 'error'],
  ['버그', 'bug'],
  ['테스트', 'test'],
  ['타입', 'type'],
  ['모드', 'mode'],
  ['훅', 'hook'],
  ['세션', 'session'],
  ['컨텍스트', 'context'],
  ['프로젝트', 'project'],
  ['워크스페이스', 'workspace'],
  ['알림', 'notification'],
  ['동기화', 'sync'],
  ['자동화', 'automation'],
  ['기능', 'feature'],
  ['인바운드', 'inbound'],
  ['아웃바운드', 'outbound'],
  ['포워딩', 'forwarding'],
  ['리팩터', 'refactor'],
  ['마이그레이션', 'migration'],
])

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

export function looksLowSignal(text) {
  const clean = cleanMemoryText(text)
  if (!clean) return true
  if (clean.includes('[Request interrupted by user]')) return true
  if (/<event-result[\s>]|<event\s/i.test(String(text ?? ''))) return true
  if (/^(read|list|show|count|find|tell me|summarize)\b/i.test(clean) && /(\/|\.jsonl\b|\.md\b|\.csv\b|\bfilenames?\b)/i.test(clean)) return true
  if (/^no response requested\.?$/i.test(clean)) return true
  if (/^stop hook error:/i.test(clean)) return true
  if (/^you are consolidating high-signal long-term memory candidates/i.test(clean)) return true
  if (/^you are improving retrieval quality for a long-term memory system/i.test(clean)) return true
  if (/^analyze the conversation and output only markdown/i.test(clean)) return true
  if (/^you are analyzing (today's|a day's) conversation to generate/i.test(clean)) return true
  if (/^summarize the conversation below\.?/i.test(clean)) return true
  if (/history directory:/i.test(clean) && /data sources/i.test(clean)) return true
  if (/use read tool/i.test(clean) && /existing files/i.test(clean)) return true
  if (/return this exact shape:/i.test(clean)) return true
  if (/^mixdog-memory setup\b/i.test(clean) && /parse the command arguments/i.test(clean)) return true
  if (/\b(chat_id|gmail_search_messages|newer_than:\d+[dh]|query:\s*")/i.test(clean)) return true
  if (/^new session started\./i.test(clean) && /one short message only/i.test(clean)) return true
  if (/^before starting any work/i.test(clean) && /tell the user/i.test(clean)) return true
  const compact = clean.replace(/\s+/g, '')
  const hasKorean = /[\uAC00-\uD7AF]/.test(compact)
  const shortKoreanMeaningful =
    hasKorean &&
    compact.length >= 2 &&
    (
      /[?？]$/.test(clean) ||
      /일정|상태|시간|규칙|정책|언어|말투|호칭|기억|검색|중복|설정|오류|버그|왜|뭐|언제|어디|누구|무엇/.test(clean) ||
      /해봐|해줘|진행|시작|고쳐|수정|확인|돌려|ㄱㄱ|ㅇㅇ|ㄴㄴ|좋아|오케이/.test(clean) ||
      classifyCandidateConcept(clean, 'user')?.admit
    )
  const minCompactLen = hasKorean ? 4 : 8
  if (compact.length < minCompactLen && !shortKoreanMeaningful) return true
  const words = clean.split(/\s+/).filter(Boolean)
  if (words.length < 2 && compact.length < (hasKorean ? 4 : 16) && !shortKoreanMeaningful) return true
  const symbolCount = (clean.match(/[^\p{L}\p{N}\s]/gu) ?? []).length
  if (symbolCount > clean.length * 0.45) return true
  return false
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

  normalized = MEMORY_TOKEN_ALIASES.get(normalized) ?? normalized
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
  return ftsTokens.map(token => `"${token.replace(/"/g, '""')}"`).join(' OR ')
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

export function buildTokenLikePatterns(text) {
  const clean = cleanMemoryText(text)
  if (!clean) return []
  const tokens = [...new Set(tokenizeMemoryText(clean))]
  if (tokens.length > 0) return tokens.map(token => `%${token}%`)
  return [`%${clean}%`]
}


export function generateQueryVariants(query) {
  const clean = cleanMemoryText(query)
  if (!clean) return [clean]

  const baseVariants = [clean]
  const tokens = tokenizeMemoryText(clean)

  // 1. Token alias applied version (Korean → English)
  const aliasedTokens = tokens.map(t => {
    const alias = MEMORY_TOKEN_ALIASES.get(t)
    return alias && alias !== t ? alias : t
  })
  const aliased = aliasedTokens.join(' ')
  const aliasVariants = aliased !== tokens.join(' ') ? [aliased] : []

  // 2. Remove Korean particles + reinforce English keywords
  const koToEn = {
    '수정': 'fix', '상태': 'status', '구조': 'structure', '방식': 'method',
    '설정': 'config settings', '작업': 'task work', '규칙': 'rule policy',
    '목록': 'list', '관련': 'related', '현재': 'current', '진행': 'progress',
    '이관': 'migration', '정리': 'cleanup', '안정화': 'stabilize',
    '아키텍처': 'architecture', '검색': 'search retrieval', '저장': 'storage',
    '인증': 'authentication auth', '메모리': 'memory', '언어': 'language',
    '호칭': 'address name honorific', '응답': 'response', '형식': 'format style',
    '캐주얼': 'casual informal', '누적': 'accumulate',
    // extended coverage for cross-lingual retrieval
    '권한': 'permission access', '스케줄': 'schedule cron', '채널': 'channel',
    '모드': 'mode', '디스코드': 'discord', '파이프라인': 'pipeline',
    '트리거': 'trigger', '플러그인': 'plugin', '임베딩': 'embedding vector',
    '프롬프트': 'prompt', '토큰': 'token', '데이터': 'data', '인덱스': 'index',
    '에러': 'error', '버그': 'bug', '테스트': 'test', '모델': 'model',
    '훅': 'hook', '세션': 'session', '컨텍스트': 'context', '알림': 'notification',
    '동기화': 'sync synchronize', '분류': 'classification classify',
    '후보': 'candidate', '점수': 'score', '가중치': 'weight', '벡터': 'vector',
    '차원': 'dimension dims', '프로젝트': 'project', '워크스페이스': 'workspace',
    '인바운드': 'inbound', '아웃바운드': 'outbound', '포워딩': 'forwarding',
    '리팩터': 'refactor', '마이그레이션': 'migration', '중복': 'duplicate dedup',
    '삭제': 'delete remove', '추가': 'add create', '변경': 'change update modify',
    '확인': 'check verify', '실행': 'execute run', '종료': 'stop terminate',
    '시작': 'start begin', '재시작': 'restart', '배포': 'deploy',
    '호출': 'call invoke', '반환': 'return', '파싱': 'parse parsing',
    '캐시': 'cache', '타임아웃': 'timeout', '재시도': 'retry',
    '자동화': 'automation webhook schedule trigger workflow',
    '기능': 'feature capability tool',
    '익스플로러': 'explorer explore codebase',
    '탐색': 'explore explorer search',
    '리콜': 'recall memory',
  }
  const translated = tokens.map(t => koToEn[t] ?? t).join(' ')
  const translatedVariants = translated !== tokens.join(' ') ? [translated] : []

  // 3. Phrase-level architectural / operational expansions
  const phraseExpansions = []
  if (/단독|독립|분리|standalone|independent|separate/i.test(clean)) {
    phraseExpansions.push(`${clean} standalone independent separate plugin`)
  }
  if (/동작가능|동작 가능|작동가능|작동 가능|가능해|가능하/i.test(clean)) {
    phraseExpansions.push(`${clean} supported capability standalone`)
  }
  if (/채널 ?id|채널아이디|channel id|mapping|매핑/i.test(clean)) {
    phraseExpansions.push(`${clean} channel id mapping access config inbound`)
  }
  if (/자동바인딩|자동 바인딩|binding|바인딩/i.test(clean)) {
    phraseExpansions.push(`${clean} automatic binding reconnect restore discord`)
  }
  if (/인바운드|inbound/i.test(clean)) {
    phraseExpansions.push(`${clean} inbound delivery binding discord channel receive`)
  }
  if (/메세지안옴|메시지안옴|message.*not|안옴|안 와|안와/i.test(clean)) {
    phraseExpansions.push(`${clean} message delivery inbound discord notification`)
  }
  if ((/임베드|embed|embedding/i.test(clean)) && (/즉시|timing|immediate/i.test(clean))) {
    phraseExpansions.push(`${clean} inline embedding immediate timing`)
  }
  if (/자동화|automation/i.test(clean)) {
    phraseExpansions.push(`${clean} automation webhook schedule trigger workflow receiver`)
  }
  if (/익스플로러|explorer|탐색/i.test(clean)) {
    phraseExpansions.push(`${clean} explorer explore codebase grep read`)
  }
  if (/리콜|recall/i.test(clean)) {
    phraseExpansions.push(`${clean} recall memory retrieval past context`)
  }
  // 4. English→Korean reverse mapping (for en queries matching ko content)
  const enToKo = {
    'permission': '권한 접근', 'schedule': '스케줄 예약', 'channel': '채널',
    'discord': '디스코드', 'pipeline': '파이프라인', 'plugin': '플러그인',
    'embedding': '임베딩 벡터', 'model': '모델', 'prompt': '프롬프트',
    'hook': '훅', 'session': '세션', 'context': '컨텍스트',
    'notification': '알림', 'config': '설정', 'settings': '설정',
    'deploy': '배포', 'test': '테스트', 'search': '검색',
    'memory': '메모리 기억', 'cache': '캐시', 'trigger': '트리거',
    'inbound': '인바운드 수신', 'project': '프로젝트', 'sync': '동기화',
    'migration': '마이그레이션 이관', 'refactor': '리팩터 정리',
    'error': '에러 오류', 'bug': '버그', 'mode': '모드',
    'automation': '자동화 웹훅 스케줄 트리거', 'feature': '기능 capability',
    'explorer': '익스플로러 탐색', 'explore': '탐색 익스플로러',
    'recall': '리콜 기억 메모리',
  }
  const reverseTokens = tokens.map(t => enToKo[t] ?? t).join(' ')
  const reverseVariants = reverseTokens !== tokens.join(' ') ? [reverseTokens] : []

  const variants = [
    ...baseVariants,
    ...phraseExpansions,
    ...aliasVariants,
    ...translatedVariants,
    ...reverseVariants,
  ]

  // Remove duplicates
  return [...new Set(variants)].slice(0, 6)
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
