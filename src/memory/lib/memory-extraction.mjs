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

// classifyMemorySentence removed: topic regex tables and admission branches deleted.
// Classification belongs in the cycle1 LLM chunker prompt, not the extraction layer.

// classifyCandidateConcept removed: role/category regex branches and admission gating deleted.
// Role tag (user/assistant/tool) is structural metadata carried by the caller; LLM chunker decides.

// shouldKeepFact removed: confidence cutoffs (0.82/0.75/0.74/0.86) and minWords gates deleted.
// shouldKeepSignal removed: 0.72 threshold and minWords gate deleted.
// Admission decisions belong in the cycle1 LLM chunker prompt.
