// Long-term essential memory policy.
//
// Single source of truth for "what qualifies as long-term essential" — used
// by the cycle2 promote prompt (template substitution) and any future-use
// downstream filter. NO regex / heuristic patterns here. Pure conceptual
// definitions; the LLM does the matching against entries.

export const LONGTERM_CONCEPTS = Object.freeze([
  {
    key: 'Identity',
    ko: '신상',
    description: 'Stable, non-derivable facts about the user — name, honorific, language/locale, email, role, organization, persistent context. Durable because it describes WHO the user is, regardless of behavior.',
  },
  {
    key: 'Preference',
    ko: '취향',
    description: 'Durable expressed taste / style / aesthetic / interaction preference. A stable preference, not a one-off mood.',
  },
  {
    key: 'Goal',
    ko: '주요 목표',
    description: 'Long-running goal or project the user is committed to. Stays in memory until completion or explicit retirement. Short-term tasks do NOT qualify.',
  },
  {
    key: 'Principle',
    ko: '원칙',
    description: 'A directive that prescribes or prohibits behavior, applying repeatedly across sessions. Without this entry, the agent would behave wrongly. The directive itself is the value, not the story behind it.',
  },
  {
    key: 'Policy',
    ko: '정책',
    description: 'An established standing decision the team commits to (format, language, naming convention, workflow gate, tool-use rule, model/provider selection). Stable across project versions.',
  },
  {
    key: 'Procedure',
    ko: '절차',
    description: 'A concrete recurring how-to for a frequently-needed task. Names the trigger condition, the steps, and the caveats. Qualifies only when the user invokes the same procedure repeatedly and the steps are not obvious.',
  },
  {
    key: 'Event',
    ko: '사건',
    description: 'A foundational happening that materially changed identity, scope, or capability and CANNOT be reconstructed from any rule it produced. Rare. If the change can be inferred from the resulting principle/policy, keep that — not the event narrative.',
  },
  {
    key: 'SystemConstant',
    ko: '시스템 상수',
    description: 'A durable structural invariant the agent MUST know to act correctly and that is NOT already in the rule files / CLAUDE.md (paths, schema layouts, model ids, channel ids, persistent endpoints). Qualifies only when the agent needs it repeatedly, it is stable across sessions, and it is not re-derivable from quick inspection.',
  },
])

// Concepts that disqualify an entry from long-term essential memory.
// Conceptual labels only — no pattern matching. The LLM identifies these.
export const REJECT_CONCEPTS = Object.freeze([
  {
    key: 'Narrative',
    description: 'Narrative about work happening (investigation, scoping, diagnosis, implementation, rollout, decision-making). Either it became a rule (then the rule entry holds the value) or it has not (then it is unfinished narrative). The narrative entry is not memory.',
  },
  {
    key: 'StaticFact',
    description: 'A static fact (tool anatomy, taxonomy, account-structure, version-state, count snapshot) that does NOT prescribe behavior, identify the user, express a preference, capture a goal, document a procedure, or constitute a needed system constant.',
  },
  {
    key: 'RuleMeta',
    description: 'Meta about the rule system itself (location of another rule, registration status, prompt structure, cycle internals). The source of truth holds the rule; metadata duplicates weight.',
  },
  {
    key: 'ResolvedBugLog',
    description: 'A resolved bug or one-time fix log. The commit log holds it. Reformulate as a standing principle if generalizable, otherwise reject.',
  },
  {
    key: 'DuplicateOfSourceOfTruth',
    description: 'Duplicate of a CLAUDE.md / rules file rule. The source of truth already holds it; mirroring is duplicate weight.',
  },
  {
    key: 'Snapshot',
    description: 'A measurement / count / version snapshot from a single run. State of one moment is not durable knowledge.',
  },
  {
    key: 'SessionScoped',
    description: 'A session-scoped or in-progress decision ("for now", "this time", "next cycle"). Bound to ephemera, not durable.',
  },
])

// Render the eight allowed concepts as numbered markdown for prompt injection.
export function renderConceptsBlock() {
  return LONGTERM_CONCEPTS.map((c, i) => (
    `${i + 1}. **${c.key} (${c.ko})** — ${c.description}`
  )).join('\n\n')
}

// Render the reject-concept catalog as a bullet list for prompt injection.
export function renderRejectBlock() {
  return REJECT_CONCEPTS.map(r => (
    `- **${r.key}** — ${r.description}`
  )).join('\n')
}

// The set of concept keys (for parser-side validation if ever needed).
// Matching is conceptual not regex; this is just the known-token list.
export const LONGTERM_CONCEPT_KEYS = Object.freeze(
  LONGTERM_CONCEPTS.map(c => c.key)
)
