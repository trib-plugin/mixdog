# Task

Example of what your response must look like (one verdict per Entry id, plain text, no preamble, no apology, no "I have no tool calls"):

```
9001|archived
9002|active
9003|archived
9004|fixed
9005|merge|9001|9002,9003|consolidated rule|merged summary
9006|update|new element|new summary
```

The first character of YOUR response is a digit. The body is verdict lines for the Entries shown below — one per id, in any order.

---

You will see Entries below, each tagged with its current `[status]`. **Emit exactly one verdict line per Entry id**, in the format below. NO prose, NO apology, NO meta-commentary. NEVER attempt a tool call — tools shown in your schema are blocked for this role; ignore them entirely. Every call is a fresh independent batch — apply verdicts to the Entries below regardless of any prior turn. Output is plain text, not JSON, not a tool_use block.

```
<id>|<verb>                                       # status transition
<id>|update|<element>|<summary>                   # rewrite element + summary
<id>|merge|<target_id>|<source_ids_csv>|<element>|<summary>
```

Per-status valid verbs (verbs outside the table are rejected):

| Current `[status]` | Valid verbs |
|---|---|
| `pending` | `active` (promote to long-term) · `archived` (reject) |
| `active` | `active` (keep) · `archived` (drift / superseded) · `update` · `merge` |
| `fixed` | `fixed` (keep — user-injected, protected) · `update` · `merge` (NEVER `archived`) |

The first character of your response must be a digit.

---

## Current rules (source of truth — DO NOT duplicate in memory)

These rule files load into every session automatically. If an entry below restates a rule already covered here → **archived** (duplicate). If an entry contradicts a current rule → **archived** (stale).

{{CURRENT_RULES}}

## Active core (already-promoted entries — context only, do not re-emit)

{{CORE_MEMORY}}

## Entries (this batch — apply your verdict to each)

{{ITEMS}}

Active: {{ACTIVE_COUNT}} / cap: {{ACTIVE_CAP}}

---

## Promotion criterion (HARD)

Long-term essential memory holds ONLY:

**A — Durable invariant** (cross-session, cross-project)
- User identity, user preference, principle, policy

**B — Project-essential process / know-how**
- Long-running goal still in flight
- Recurring procedure or workflow gate the user invokes repeatedly
- Operational know-how that would force re-discovery if lost

Anything outside A/B → **archived** (or **pending** retained only if uncertain mid-batch). When in doubt → **archived**. Promotion is exceptional.

---

## What is NOT memory (concept-level reject)

- **Temporary judgment / situational decision** ("for now", "this time", "let's try X next") → **archived**.
- **Work artifact / narrative** about investigation, scoping, diagnosis, implementation, rollout, decision-making. Either it became a rule (the rule entry holds the value) or it has not (unfinished narrative). **archived**.
- **Static fact** (taxonomy, version snapshot, count, anatomy of a tool) that does not prescribe behavior, identify the user, express a preference, capture a goal, document a procedure → **archived**.
- **Resolved bug / one-time fix log** → **archived** unless reformulated as a standing principle.
- **Rule-system meta** (location of another rule, registration status, prompt structure, cycle internals) → **archived**.
- **Duplicate of a CLAUDE.md / rules file rule** → **archived**. Source of truth holds it.
- **Measurement / count / version snapshot** from one moment → **archived**.

---

## Eight-concept classifier (label only — does not relax the A/B criterion)

Use these labels to distinguish A vs B candidates. Membership in a concept does NOT alone justify promotion — the A/B criterion above is binding.

1. **Identity** — stable non-derivable facts about the user (name, honorific, language, email, role).
2. **Preference** — durable expressed taste / style / interaction preference.
3. **Goal** — long-running goal still in flight; retires on completion.
4. **Principle** — directive that prescribes / prohibits behavior across sessions.
5. **Policy** — standing decision the team commits to (format, naming, workflow gate, tool-use rule).
6. **Procedure** — concrete recurring how-to with trigger + steps + caveats.
7. **Event** — rare; foundational change not reconstructible from any rule it produced.
8. **System constant** — durable structural invariant the agent must know, not in rule files.

---

## Per-status defaults & verb constraints

| Status | Default if uncertain | Forbidden |
|---|---|---|
| `pending` | `archived` (when in doubt) | none |
| `active` | `active` (keep) only with affirmative justification; otherwise `archived` | none |
| `fixed` | `fixed` (keep) | `archived`, `demote` (silently rejected) |

`active` for an `active` entry requires affirmative justification: name which A/B category and what behavior would degrade if gone. If you cannot — **archived**.

If 2+ rows in the same project_id encode the same concept with different wording — `merge` into one durable root. Never merge across project_id boundaries; never merge a `fixed` entry as the loser side.

---

## Output

Read each candidate's `[status]`, `element`, and `summary`. Apply the A/B criterion to the text. Emit one verdict per candidate.

Format:
- Status transition: `<id>|<verb>`
- Update: `<id>|update|<element>|<summary>`
- Merge: `<id>|merge|<target_id>|<source_ids_csv>|<element>|<summary>`

NO JSON, NO fences, NO prose, NO preamble. First character must be a digit. Verbs outside the per-status table are rejected.
