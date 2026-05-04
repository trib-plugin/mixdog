Phase: {{PHASE}}

## Current active core

{{CORE_MEMORY}}

## Entries to Evaluate

{{ITEMS}}

Active count: {{ACTIVE_COUNT}} / cap: {{ACTIVE_CAP}}.

---

## Core Memory definition

**Core Memory = information always needed to operate safely AND still valid after the current work ends.**

An entry earns promotion only when it passes an affirmative INCLUDE check AND clears the EXCLUDE filter. On any ambiguity, default action when no INCLUDE bullet matches: emit the phase default from the table below.

---

## INCLUDE — promote only if one of these matches

1. **User identity** — name, title, email, preferred honorifics, language/locale settings.
2. **Repeatable procedures** — multi-step workflows that recur across sessions (e.g. bump → dev-sync → restart sequence; plugin reload order; migration steps).
3. **Tool behavior constants** — documented limits or invariants of tools used in every session (e.g. /reload-plugins concurrency limit, MCP respawn rules, debounce thresholds).
4. **Permanent policies** — standing rules that govern all work (e.g. commit format `YYYY-MM-DD HH:MM <msg>`, no-push-without-approval, honorific style, Korean reply rule).
5. **System-structural constants** — stable paths, directories, file layouts that callers must know to navigate (e.g. `~/.claude/plugins/`, default config paths, workspace layout).

### Category-specific qualifiers (apply after INCLUDE/EXCLUDE)

- **decision**: qualifies ONLY if it is an architectural or standing-policy decision still actively in effect ("from now on we always use X"). A one-shot decision that has already been fully executed ("decided to commit with message Y", "chose to run Z this time") does NOT qualify — it is an event log entry.
- **fact**: qualifies ONLY if it is a permanent property of the system, tool, or user identity (e.g. "the plugin data directory is ~/.claude/data"). A measurement, metric, or status snapshot (e.g. "159 active entries", "distribution is 69/37/20") does NOT qualify — it is a single-shot count.
- **task**: tasks rarely qualify as Core. Only repeating procedural steps belong here (e.g. "run `dev-sync` after every plugin change"). An in-progress or one-time task ("implement chunk grouping", "fix bug in X") does NOT qualify — it is session-scoped work.

---

## EXCLUDE — archive immediately if any of these matches

The following pattern types are **never** Core Memory regardless of category label:

- **Single-shot measurements / counts** — "70 entries promoted", "distribution delta ±N", "n rows migrated", "P13 prompt DESC noted".
- **Event logs / completion markers** — "v0.6.30 deployed", "V4 applied", "Phase A-E completed", "Reviewer High 2 applied", "landed", "merged", "pushed".
- **Debugging findings** — "reviewer issue applied", "bug fixed in X", "patch applied", "workaround added for Y".
- **Task progress snapshots** — "Phase X done", "step 3 complete", "in progress", "working on Z".
- **Temporary / session-scoped decisions** — "this session only", "for now", "temporary workaround", "revert after".
- **Retrospective notes** — post-mortems, summaries of what happened, "as of today", "this run". These belong in Recap, not Core Memory.

Additional rejected examples for category tightening:
- "Phase A 완료; v0.6.30 배포 완료" → event log → archive
- "Active entries: 159 (decision=69, fact=37, task=20)" → single-shot measurement → archive
- "결정: 이번 커밋 메시지를 'fix typo'로 작성" → executed one-shot decision → archive
- "cycle2 phase3 작업 진행 중" → in-progress task → archive

Concrete rejected examples (match by pattern, not exact text):
- "V4 applied" → event log → archive
- "70 entries promoted" → single-shot count → archive
- "v0.6.30 deployed" → event log → archive
- "P13 prompt DESC noted" → debugging/observation note → archive
- "Reviewer High 2 applied" → event log → archive
- "Phase A-E completed" → task progress → archive
- "Push d4650e8..0ff6b0b, 7 files / 351 insertions" → event log → archive
- "변형 4 적용으로 분배 누수 해소: 변형 3 140/69(67%) → 변형 4 113/2(98.3%)" → single-shot measurement → archive
- "이번 세션엔 dev mode installPath로 진행" → temporary/session decision → archive
- "Phase A retrospective completed; ready for Phase B or Phase C based on next directive" → retrospective note → archive

---

## Decision rubric

1. **EXCLUDE check first** — does the entry match any EXCLUDE pattern? If yes → emit the EXCLUDE-by-phase verdict (phase1→`pending`, phase2→`keep`, phase3→`archived`). Stop. Do not evaluate INCLUDE.
2. **INCLUDE check second** — does the entry affirmatively match an INCLUDE bullet? If yes (and EXCLUDE did not fire) → **promote** (or **update** / **merge** as appropriate).
3. **Default last** — if neither EXCLUDE nor INCLUDE matched → emit the phase default from the per-phase table below.

### Phase 3 note on active candidates

Phase 3 candidates may already be `active`. In that case: EXCLUDE → emit `<id>|archived`, INCLUDE → omit the entry (keep active, no action needed), ambiguity → emit `<id>|demote`.

### EXCLUDE-by-phase verdicts

EXCLUDE matches are **not** treated the same as "no-qualify" defaults. Use the phase-specific verb below:

| Phase | EXCLUDE verdict | Rationale |
|---|---|---|
| 1 | `pending` | phase1 has no archive verb; defer to evaluation queue |
| 2 | `keep` | phase2 cannot archive; low-score signal only, no promotion |
| 3 | **`archived`** | active/pending rows matched by EXCLUDE must be archived, not omitted — emitting nothing leaves them active forever |

**Phase 3 EXCLUDE is the critical case**: if an entry matches any EXCLUDE pattern, emit `<id>|archived`. Do NOT omit the line.

**Status, not score, is the durable classifier. Score reflects recency only.**

## Per-phase default verdicts

The default action when an entry does NOT clearly qualify varies by phase. Emit the phase-correct verb — the
parser rejects unknown verbs silently, so an incorrect default causes the entry to be skipped entirely.

| Phase | Phase name | Default (no-qualify) | Valid action verbs |
|---|---|---|---|
| 1 | `phase1_new_chunks` | `pending` | `add`, `pending` |
| 2 | `phase2_reevaluate` | `keep` | `promote`, `keep`, `processed` |
| 3 | `phase3_active_review` | *(omit the entry)* | `demote`, `archived`, `update`, `merge` |

- Phase 1 `add` → entry is promoted to active core immediately.
- Phase 1 `pending` → entry stays in the evaluation queue for phase 2.
- Phase 2 `promote` → entry moves to active core now.
- Phase 2 `keep` → entry remains pending for another cycle; low-score signal only, no DB change.
- Phase 2 `processed` → entry is permanently excluded from promotion.
- Phase 3: emit a line only when an action is needed; omitting an entry = no change.

Merge candidates must share the same `project_id`. Do not merge entries with different `project_id` values.

---

Output format: one action per line, NO JSON, NO tool calls, NO prose, NO preamble. Format: `<entry_id>|<action>` (or `<entry_id>|update|<element>|<summary>` / `<entry_id>|merge|<target_id>|<source_ids_csv>|<element>|<summary>`). First character of your response must be a digit. Empty response (no lines) is valid when no action is needed.
