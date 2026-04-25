// Single source of truth: lib/text-utils.cjs (also required by hooks/session-start.cjs).
import { createRequire } from 'module'
const _require = createRequire(import.meta.url)
const { cleanMemoryText: _cleanMemoryText } = _require('../../../lib/text-utils.cjs')
export const cleanMemoryText = _cleanMemoryText

function compactClause(label, value) {
  const clean = cleanMemoryText(value)
  if (!clean) return ''
  return `${label}: ${clean}`
}

export function parseTaskDetails(details = '') {
  const text = cleanMemoryText(details)
  if (!text) return { currentState: '', nextStep: '', scope: '', activity: '', description: '' }

  const pick = (label) => {
    const match = text.match(new RegExp(`(?:^|\\n|\\|\\s*)${label}:\\s*([^\\n|]+)`, 'i'))
    return match?.[1]?.trim() ?? ''
  }

  const currentState = pick('current_state')
  const nextStep = pick('next_step')
  const scope = pick('scope')
  const activity = pick('activity')
  const description = text
    .replace(/(?:^|\n|\|\s*)current_state:\s*[^\n|]+/gi, '')
    .replace(/(?:^|\n|\|\s*)next_step:\s*[^\n|]+/gi, '')
    .replace(/(?:^|\n|\|\s*)scope:\s*[^\n|]+/gi, '')
    .replace(/(?:^|\n|\|\s*)activity:\s*[^\n|]+/gi, '')
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/^[\s|]+|[\s|]+$/g, '')
    .trim()

  return { currentState, nextStep, scope, activity, description }
}

export function formatTaskDetails({ description = '', currentState = '', nextStep = '', scope = '', activity = '', extras = [] } = {}) {
  const lines = []
  const cleanDescription = cleanMemoryText(description)
  if (cleanDescription) lines.push(cleanDescription)
  if (cleanMemoryText(scope)) lines.push(`scope: ${cleanMemoryText(scope)}`)
  if (cleanMemoryText(activity)) lines.push(`activity: ${cleanMemoryText(activity)}`)
  if (cleanMemoryText(currentState)) lines.push(`current_state: ${cleanMemoryText(currentState)}`)
  if (cleanMemoryText(nextStep)) lines.push(`next_step: ${cleanMemoryText(nextStep)}`)
  const extraLine = extras.filter(Boolean).join(' | ')
  if (extraLine) lines.push(extraLine)
  return lines.join('\n').trim()
}

export function composeTaskDetails(task = {}) {
  const parsed = parseTaskDetails(task?.details ?? '')
  const extras = [
    compactClause('Goal', task?.goal),
    compactClause('Integration', task?.integration_point),
    compactClause('Blocked by', task?.blocked_by),
    compactClause('Related', Array.isArray(task?.related_to) && task.related_to.length
      ? task.related_to.join(', ')
      : task?.related_to),
  ].filter(Boolean)
  return formatTaskDetails({
    description: parsed.description,
    scope: task?.scope ?? parsed.scope,
    activity: task?.activity ?? parsed.activity,
    currentState: task?.current_state ?? parsed.currentState,
    nextStep: task?.next_step ?? parsed.nextStep,
    extras,
  })
}

export function isProfileRelatedText(text = '') {
  const clean = cleanMemoryText(text).toLowerCase()
  return /\b(language|tone|response style|response_style|address|honorific|timezone|work hours|expertise|wording|communication style)\b/.test(clean)
    || /언어|말투|어투|톤|호칭|존댓말|반말|응답 스타일|시간대|작업 시간|전문성|한국어|영어/.test(text)
}

export function classifyMemorySentence(factType, text) {
  const clean = cleanMemoryText(text)
  const hasImperative = /\b(should|must|needs to|need to|expected to|prefer|preferred|do not|don't|must not|should not)\b/i.test(clean)
    || /해야|하지 마|하면 안|금지|우선|선호/.test(clean)
  const hasTaskVerb = /\b(implement|finalize|add|remove|move|fix|investigate|analyze|review|refactor|clean(?: ?up)?|persist|deduplicate|harden|align|extend|wire)\b/i.test(clean)
    || /구현|마무리|추가|제거|이동|수정|조사|분석|리뷰|리팩터|정리|저장|중복 제거|강화|맞추|연결/.test(clean)
  const proposalLike = /\b(should|could|let's|what about|how about)\b/i.test(clean)
    || /어때|하자|넣자|두자|맞아|되게|가게|전환|구현하자|저장해서/.test(clean)
  const isRequestNarration = /\bthe user (asked|requested|wants|wanted|is actively improving|explicitly asked)\b/i.test(clean)
    || /사용자가 .*요청했|유저가 .*요청했|분석해달라고 요청|계속 진행해달라고 요청|please .*(analyze|continue|proceed)|asks? .*to (analyze|continue|proceed)/i.test(clean)

  const operationRuleTopic = /\b(commit|push|build|deploy|approval|language|tone|timezone|transcript prompt|durable memory|profile source of truth|identity storage)\b/i.test(clean)
    || /커밋|푸시|빌드|배포|승인|언어|말투|어투|시간대|장기기억|transcript prompt|source of truth|정체성 저장/.test(clean)
  const jsonOutputRuleTopic = (
    (
      /\bjson\b/i.test(clean) && /\b(output|return|format|schema|only|strictly)\b/i.test(clean)
    ) || (
      /JSON|스키마/.test(clean) && /출력은|출력만|형식|반환|지켜|만 사용/.test(clean)
    )
  )
  const userRuleTopic = operationRuleTopic || jsonOutputRuleTopic

  const externalMemoryContractTopic = /\b(sqlite|context\.md|source of truth|primary store|profiles db|identity storage|storage boundary|persistence path)\b/i.test(clean)
    || /SQLite|context\.md|source of truth|profiles DB|저장 경계|저장 경로|정체성 저장/.test(clean)

  const internalArchitectureTopic = /\b(provider|model selection|embedding model|update cadence|cycle schedule|schema|crud|action field|manual injection|profile\.md|bot\.json|bot role|context generation|memory architecture|md document|manual docs|three[- ]cycle|three[- ]tier|3[- ]cycle|3[- ]tier)\b/i.test(clean)
    || /프로바이더|모델 선택|임베딩 모델|갱신 주기|사이클 주기|스키마|CRUD|action 필드|수동 주입|Profile\.md|bot\.json|봇 역할|context 생성|메모리 구조|MD 문서|md 문서|수동 문서|3-cycle|3-tier|3사이클|3티어/.test(clean)

  const currentStateObservationTopic = /\b(currently empty|currently noisy|data is missing|consolidation is not running|pipeline looks empty|memory is empty|backlog is high)\b/i.test(clean)
    || /데이터가 없|비어 있|노이즈|consolidation이 돌지 않|파이프라인이 비어|백로그/.test(clean)

  const internalMaintenanceTopic = /\b(mcp|session start|startup|profile hints?|memory-context|current time|notification|output|discord-visible|verify(?:ing|ication)?|ambiguous hints?|source episodes?|state file|cycle status|catch-up execution|candidate|cycle\s*\d|stale cleanup|dedup(?:lication)?|ingestion|pipeline|routing parameters|provider abstraction|config|schema\/readme|benchmark|vacuum|tool-call output|memory-edit actions?)\b/i.test(clean)
    || /세션 시작|시작 시|프로필 힌트|memory-context|현재 시간|알림|출력|verify|검증 체인|애매한 힌트|source episode|state file|cycle status|catch-up|candidate|cycle|stale cleanup|중복|ingestion|파이프라인|provider abstraction|설정|벤치마크|vacuum|tool-call output|memory-edit/.test(clean)

  const internalDataModelCommentary = /\b(profiles? currently overwrite|signals use additive scoring|automatic .* not yet fully wired|instructions are sent once|sections are maintained as|implemented with .* parameters|uses two memory injection paths)\b/i.test(clean)
    || /현재 overwrite-on-write|signals .* additive|아직 fully wired|instructions are sent once|섹션 구성|파라미터를 포함해 구현|두 개의 memory injection path/.test(clean)
  const internalPerformanceCommentary = /\b(preprocessing|postprocessing|pipeline cost|bottleneck|latency|llm inference|response delay|throughput)\b/i.test(clean)
    || /전처리|후처리|파이프라인 비용|병목|지연|응답 지연|처리량|LLM 추론/.test(clean)

  if (isRequestNarration) return { category: 'request_narration', keepFact: false, admit: false }
  if (jsonOutputRuleTopic) return { category: 'user_rule', keepFact: true, admit: true }
  if (userRuleTopic && !internalArchitectureTopic) return { category: 'user_rule', keepFact: true, admit: true }
  if (currentStateObservationTopic && (hasImperative || hasTaskVerb || proposalLike)) return { category: 'maintenance_task', keepFact: false, admit: true }
  if (currentStateObservationTopic) return { category: 'internal_commentary', keepFact: false, admit: false }
  if (internalDataModelCommentary) return { category: 'internal_commentary', keepFact: false, admit: false }
  if (internalPerformanceCommentary) return { category: 'internal_commentary', keepFact: false, admit: false }
  if (externalMemoryContractTopic && !internalMaintenanceTopic) return { category: 'storage_decision', keepFact: true, admit: true }
  if (internalArchitectureTopic && (hasImperative || hasTaskVerb || proposalLike)) return { category: 'maintenance_task', keepFact: false, admit: true }
  if (internalArchitectureTopic) return { category: 'internal_commentary', keepFact: false, admit: false }
  if (internalMaintenanceTopic && (hasImperative || hasTaskVerb || proposalLike)) return { category: 'maintenance_task', keepFact: false, admit: true }
  if (internalMaintenanceTopic) return { category: 'internal_commentary', keepFact: false, admit: false }
  if (factType === 'preference') return { category: 'preference', keepFact: true, admit: true }
  return { category: 'generic', keepFact: true, admit: true }
}

export function classifyCandidateConcept(text, role = 'user') {
  const clean = cleanMemoryText(text)
  if (!clean) return { category: 'drop', admit: false }

  const isQuestionOnly = /\?$/.test(clean) && !/\b(commit|push|build|deploy|json|schema|language|tone|timezone|source of truth|sqlite|context\.md)\b/i.test(clean)
  const ruleLike = /\b(do not|don't|must not|should not|forbidden|blocked|approval|explicitly requested|json|schema)\b/i.test(clean)
    || /하지 마|하면 안|금지|승인|명시|JSON|스키마/.test(clean)
  const preferenceLike = /\b(prefer|preferred|want|wants|style|tone|language|timezone)\b/i.test(clean)
    || /선호|원해|말투|어투|언어|시간대|존댓말/.test(clean)
  const taskLike = /\b(fix|implement|investigate|review|refactor|cleanup|deduplicate|analyze|check|verify)\b/i.test(clean)
    || /수정|구현|조사|리뷰|리팩터|정리|중복 제거|분석|확인|검증/.test(clean)
  const proposalLike = /\b(should|could|let's|what about|how about)\b/i.test(clean)
    || /어때|하자|넣자|두자|맞아|되게|가게|전환|구현하자|저장해서|방향이 맞아/.test(clean)
  const storageDecisionLike = /\b(sqlite|context\.md|source of truth|long-term memory|profile data|identity storage|persistence)\b/i.test(clean)
    || /SQLite|context\.md|source of truth|장기 메모리|프로필 데이터|정체성 저장|저장 구조/.test(clean)
  const internalArchitectureLike = /\b(provider|model selection|embedding model|update cadence|cycle schedule|schema|crud|action field|manual injection|profile\.md|bot\.json|bot role|context generation|memory architecture|three[- ]cycle|three[- ]tier|3[- ]cycle|3[- ]tier)\b/i.test(clean)
    || /프로바이더|모델 선택|임베딩 모델|갱신 주기|사이클 주기|스키마|CRUD|action 필드|수동 주입|Profile\.md|bot\.json|봇 역할|context 생성|메모리 구조|3-cycle|3-tier|3사이클|3티어/.test(clean)
  const stateObservationLike = /\b(currently empty|currently noisy|data is missing|consolidation is not running|pipeline looks empty|memory is empty|backlog is high)\b/i.test(clean)
    || /데이터가 없|비어 있|노이즈|consolidation이 돌지 않|파이프라인이 비어|백로그/.test(clean)
  const internalMetaLike = /\b(mcp|profile hints?|memory-context|notification|output|verify chain|state file|cycle status|cycle state|catch-up|pipeline|benchmark|provider abstraction|tool-call|latency|throughput)\b/i.test(clean)
    || /프로필 힌트|memory-context|알림|출력|verify 체인|state file|cycle status|cycle state|catch-up|파이프라인|벤치마크|provider abstraction|지연|처리량|주기 실행/.test(clean)
  const requestNarrationLike = /\bthe user (asked|requested|wants|wanted)\b/i.test(clean)
    || /사용자가 .*요청했|유저가 .*요청했|심층분석해달라고|please .*(analyze|investigate)|asks? .*for .*(deep |thorough )?(analysis|review)/i.test(clean)

  if (role !== 'user') return { category: 'assistant_evidence', admit: false }
  if (requestNarrationLike) return { category: 'request_narration', admit: false }
  if (stateObservationLike && (taskLike || proposalLike)) return { category: 'maintenance_task', admit: true }
  if (stateObservationLike) return { category: 'internal_meta', admit: false }
  if (internalArchitectureLike && (taskLike || proposalLike)) return { category: 'maintenance_task', admit: true }
  if (internalArchitectureLike && !ruleLike && !storageDecisionLike) return { category: 'internal_meta', admit: false }
  if (internalMetaLike && (taskLike || proposalLike)) return { category: 'maintenance_task', admit: true }
  if (internalMetaLike && !ruleLike && !storageDecisionLike) return { category: 'internal_meta', admit: false }
  if (ruleLike) return { category: 'user_rule', admit: true }
  if (preferenceLike) return { category: 'preference', admit: true }
  if (taskLike) return { category: 'active_task', admit: true }
  if (storageDecisionLike) return { category: 'storage_decision', admit: true }
  if (isQuestionOnly) return { category: 'question', admit: true }
  return { category: 'generic', admit: true }
}

export function shouldKeepFact(factType, text, confidence) {
  const clean = cleanMemoryText(text)
  if (!clean) return false
  const classification = classifyMemorySentence(factType, clean)
  if (!classification.keepFact) return false
  const compact = clean.replace(/\s+/g, '')
  if (compact.length < 18) return false
  const words = clean.split(/\s+/).filter(Boolean).length
  if (words < 4) return false
  const score = Number(confidence ?? 0.6)
  const minScore =
    factType === 'decision' ? 0.82 :
    factType === 'constraint' ? 0.75 :
    factType === 'preference' ? 0.74 :
    0.86
  const minWords =
    factType === 'decision' || factType === 'fact' ? 6 : 5
  if (words < minWords) return false
  return score >= minScore
}

export function shouldKeepSignal(kind, value, score) {
  const clean = cleanMemoryText(value)
  if (!clean) return false
  const compact = clean.replace(/\s+/g, '')
  if (compact.length < 18) return false
  const words = clean.split(/\s+/).filter(Boolean).length
  if (words < 5) return false
  return Number(score ?? 0.5) >= 0.72
}
