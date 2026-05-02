# Tool Routing

**HARD RULE — file/code/memory/web lookup MUST start with `recall` (past) / `search` (web) / `explore` (codebase). Reaching for `bash` / `grep` / `glob` / `read` / `find_symbol` as the very first move on an unknown target (unknown target excludes known identifiers, paths, or regex — those routes are listed in the decision table below) is a violation. Shell and low-level file tools are reserved for known-coordinate work — exact path + line range or a precise literal pattern. `bash` is shell-only (git, build, test, run); using it with `ls` / `cat` / `find` / `head` / `tail` / `grep` for file/code lookup is a violation.**

Recap-visible coordinates count as past context — use them or `recall` before any probing. Never compose source paths from package / cache / marketplace directory names without verification.

## Parallelism — #1 iter saver

Independent tool calls go in ONE message as multiple tool_use blocks — never serialize what can run together. One missed batch = one wasted turn. Each tool description carries its own array / multi-form rules; this section is the meta principle.

- Different tools, no data dependency → ONE message.
- Same-tool repeats → array form per tool description; serial repeats are violations.
- Two-turn read-then-edit: turn 1 all `read` parallel; turn 2 all `edit` / `apply_patch` / `write` parallel. No interleaving.

## Iter budget

Work in **2 rounds max per sub-problem** (locate → confirm). Repeated retrieval → ask what NEW info the next call adds; enough evidence → stop probing, move to edit/answer.

## Query brevity

`recall` / `search` / `explore` queries and `bridge` briefs: one core question + coord hint when known + verb/intent. Drop version annotations, conditional branches ("if X then Y"), and rationale paragraphs — internal agents probe on their own. Long queries inflate cost and bias the agent toward surface keywords. Same compression applies to expected output: ask for the answer, not the search trace.

## Decision table

Scan query for known scope and collapse to ONE targeted call: known identifier / path / regex → `find_symbol` / `read` / `grep`; known entry id / date / decision → `recall`; explicit URL / repo / domain → `search`.

| Query shape | First tool |
|---|---|
| identifier known, file unknown | `find_symbol` |
| callers / references / imports / dependents / overview / symbols / impact / related | `find_symbol` with matching `mode` |
| file path known (1 or many) | `read` (array for 2+) |
| 2+ whole files to create / replace | `write` with `writes` array |
| symbolic token (env var, constant, config key name) | `find_symbol` |
| exact edit, multiple files | `apply_patch` |
| small local replacement, one file | `edit` |
| shell state across turns | `bash` with `persistent:true` |
| long background command | `job_wait`, then `read` stdout/stderr path |
| free-text / regex content | `grep` |
| filename pattern | `glob` |
| dir shape | `list` |
| past memory | `recall` |
| external web | `search` |

## Anti-patterns

- `find_symbol` ↔ `grep` serial fallback for the same identifier — they answer different questions (declaration vs usage). Genuinely need both → call in parallel.
- `find_symbol` `mode:"callers"`/`"references"`/`"dependents"` returning empty for a recently-created or recently-edited file is **inconclusive**, not authoritative — likely cause is **cwd mismatch**. The graph cache is keyed by cwd; pass the explicit `cwd` parameter exposed on `find_symbol` / `code_graph` (tools.json:1274) to target the correct project root. Invalidation hooks are wired but only fire when the same cwd is used; if results remain empty after setting `cwd`, confirm with a targeted `grep`.
- `read` a whole large file when `find_symbol` / `grep` can narrow the line window first.
- `grep` → `read` past two pairs on same target without locking file+line span — switch tool family (`find_symbol` / `explore`) or commit to edit; third same-target pair = violation. (See `rules/bridge/02-public-work-principles.md` §Edit Ordering for the bridge-specific rule.)
- Same file, multiple chunks (different `offset`/`limit` on the same path) → MUST use `read({reads:[…]})`, not N parallel `read` tool_use blocks. Splitting same-file chunks across separate tool_use slots inflates iter accounting and is a violation.
- 2+ files in one turn with shared opts → `read({path:[a,b,c]})`. Per-file different `offset`/`limit`/`mode` → `read({reads:[{path,offset,limit,mode?,n?}, …]})`. Same parallelism rule applies to `edit` (`edits` array), `write` (`writes` array), `grep`/`glob` (pattern array).
- 2+ hunks across multiple files (cross-file refactor, coordinated rename, import + definition move) → prefer `apply_patch` atomic over `edit({edits:[…]})`. Atomic apply gives all-or-nothing semantics + context validation, which avoids the snapshot-stale retry loop that hits `edit` when files were modified between read and write (common after `dev-sync` or other writers touched the file). `edit edits` array is fine for single-file 2+ hunks where snapshot freshness is guaranteed.
- Tool family consistency — when editing with `mixdog edit` / `apply_patch`, the matching `read` must come from mixdog too. Mixing built-in `Read` with mixdog `edit` (or vice versa) fails the second call's snapshot check because the two stores do not share state.

## Soft-warn handling

`⚠ … soft-warn` markers = self-enforced halt (runtime aborts only at per-axis ceiling of 100). Same-result loops count; paraphrasing the same query a third time is itself a violation.

| Marker | Recovery |
|---|---|
| `⚠ Tool-loop` (same call+args 4×) | Stop the exact retry. Change inputs *semantically* or switch tool. |
| `⚠ Repeated-tool` (one tool many times) | Batch outstanding queries into one array-form call, or hand off to a different family — low-level (`read` / `grep` / `glob` / `list`), structural (`find_symbol`), synthesized (`explore` / `recall` / `search`). |
| `⚠ Mixed-tool` (consecutive low-level lookups w/o progress) | Jump up to `find_symbol` / `explore` for one decisive pass, or commit to the edit if target locked. |
| `⚠ Tool-budget` (total calls high) | Truncate scope. Synthesize what you have, report partial findings honestly, stop new investigation threads. |

If evidence is enough, synthesize first. Never paraphrase-and-retry. If no actionable evidence yet, surface what was attempted and ask. High-level tool itself triggered the warn → switching down to `read` / `grep` valid only with a known path or literal pattern. **Second warn for the same marker** = first recovery did not work; do not repeat. Stop the line of work, report what you have plus what failed, hand back to the user.
