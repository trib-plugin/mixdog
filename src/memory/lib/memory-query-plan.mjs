import { cleanMemoryText } from './memory-extraction.mjs'
import { parseTemporalHint } from './ko-date-parser.mjs'
export { parseTemporalHint }

export function isDoneTaskQuery(query = '') {
  const clean = cleanMemoryText(query).toLowerCase()
  const explicitDone = /\b(done|completed|finished|resolved)\b/.test(clean) || /완료|끝났|끝난|끝난거/.test(query)
  const statusCue = /\bstatus\b/.test(clean) || /상태/.test(query)
  const taskCue = /\b(task|tasks|work|issue|todo|ticket|bug|fix|compatibility)\b/.test(clean) || /작업|할 일|할일|이슈|버그|수정|호환성/.test(query)
  return explicitDone || (statusCue && taskCue)
}

export function isOngoingTaskQuery(query = '') {
  const clean = cleanMemoryText(query).toLowerCase()
  const taskCue = /\b(task|tasks|work|working|project|todo|ticket|issue)\b/.test(clean) || /작업|할 일|할일|일|프로젝트/.test(query)
  const ongoingCue =
    /\b(current|currently|ongoing|still|active|in progress|right now|these days|lately|keep doing)\b/.test(clean) ||
    /현재|지금|진행 중|진행중|요즘|계속|아직|지속/.test(query)
  return taskCue && ongoingCue
}

export function isRuleQuery(query = '') {
  const clean = cleanMemoryText(query).toLowerCase()
  return /\b(rule|policy|forbidden|allowed|constraint|prompt|transcript|durable memory)\b/.test(clean) || /규칙|정책|제약|금지|허용|prompt|transcript|durable memory/.test(query)
}

export function isRelationQuery(query = '') {
  const clean = cleanMemoryText(query).toLowerCase()
  return /\b(relation|related|relationship|between|connect|connected|uses|use|depends|dependency|integrates|integrated|part of|where.*used|what.*used|role|pair|pairing|frontend|backend|client|server|boundary|ownership|integration point)\b/.test(clean)
    || /관계|연결|역할|용도|어디에 쓰|어디 쓰|의존|통합|연동|사용|짝|쌍|클라|서버|프론트|백엔드|경계|소유권|연결점/.test(query)
}

export function isHistoryQuery(query = '') {
  const clean = cleanMemoryText(query).toLowerCase()
  return /\b(history|timeline|discuss|discussion|discussed|happened|what did we discuss|summarize the discussion)\b/.test(clean)
    || /기억|타임라인|논의|대화|얘기|뭐라고 했|요약/.test(query)
}

export function getResultDayKey(item) {
  const sourceTs = String(item?.source_ts ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(sourceTs)) return sourceTs.slice(0, 10)
  const updatedAt = String(item?.updated_at ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(updatedAt)) return updatedAt.slice(0, 10)
  return ''
}

export function buildMemoryQueryPlan(query, intent, options = {}) {
  const clean = cleanMemoryText(query)
  const temporal = options.temporal ?? parseTemporalHint(clean)
  const includeDoneTasks = Boolean(options.includeDoneTasks) || isDoneTaskQuery(clean)
  const preferActiveTasks = Boolean(options.preferActiveTasks) || isOngoingTaskQuery(clean)
  const isHistoryExact = Boolean(temporal?.exact) && (intent?.primary === 'history' || intent?.primary === 'event')
  const filters = options.filters ?? {}
  const retriever = (intent?.primary === 'history' || intent?.primary === 'event') ? 'history' : 'decision'

  return {
    query: clean,
    intent,
    temporal,
    includeDoneTasks,
    preferActiveTasks,
    explicitRelationQuery: false,
    preferRelations: false,
    isHistoryExact,
    retriever,
    graphFirst: false,
    filters,
    limit: Math.max(1, Number(options.limit ?? 8)),
  }
}
