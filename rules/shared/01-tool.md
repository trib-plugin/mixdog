# Tool Routing

**HARD RULE — file/code/memory/web lookup MUST start with `recall` (past) / `search` (web) / `explore` (codebase). Reaching for `bash` / `grep` / `glob` / `read` / `find_symbol` as the very first move on an unknown target is a violation. Shell and low-level file tools are reserved for known-coordinate work — exact path + line range or a precise literal pattern. `bash` is shell-only (git, build, test, run); using it with `ls` / `cat` / `find` / `head` / `tail` / `grep` for file/code lookup is a violation.**

First move — NARROW THE SCOPE before calling. A tool aimed at "the module responsible for X" finds it; a tool aimed at "X" returns noise.

## Parallelism — #1 iter saver

Independent tool calls go in ONE message as multiple tool_use blocks — never serialize what can run together. One missed batch is one wasted turn. Each tool's description carries its own array / multi-form rules; this section is the meta principle.

- Independent calls on DIFFERENT tools with no data dependency — send in ONE message, not sequential turns.
- Same-tool repeats: use the array form documented in the tool description; serial repeats are violations.
- Two-turn read-then-edit pattern: turn 1 — all `read` calls in parallel; turn 2 — all `edit` / `apply_patch` / `write` calls in parallel. Do not interleave reads and writes across turns.

## General Iter Budget

- Work in **2 rounds max per sub-problem** (locate → confirm). Repeated retrieval → ask what NEW information the next call adds; enough evidence → stop probing and move to the edit / answer.

## Preflight

Before any tool call, scan the query for known scope and collapse multiple rounds into one targeted call:

- code lookup → known identifier, file path, or regex pattern → ONE call to `find_symbol` / `read` / `grep`.
- past memory → known entry id (`#NNNN`), date, or named decision → ONE `recall` anchored on that.
- external → explicit URL, owner/repo, or domain → ONE `search` scoped to that source.

## Decision Table

| Query shape                                       | First tool                                          |
|---------------------------------------------------|-----------------------------------------------------|
| identifier name known, file unknown               | `find_symbol`                                       |
| callers / references / imports / dependents       | `find_symbol` with `mode:"callers"` / `"references"` / `"imports"` / `"dependents"` |
| broader structural graph / file overview / impact | `find_symbol` with `mode:"overview"` / `"symbols"` / `"impact"` / `"related"` |
| file path known                                   | `read`                                              |
| 2+ known file paths                               | one `read` with `path` as array                     |
| 2+ whole files to create/replace                  | `write` with `writes` array                         |
| symbolic token (env var / constant / config key name) | `find_symbol`                                   |
| exact edit across multiple files                  | `apply_patch`                                       |
| small local replacement in one file               | `edit`                                              |
| shell state needed across turns                   | `bash` with `persistent:true`                       |
| long background command launched                  | `job_wait`, then `read` the stdout/stderr path      |
| scope-obvious shorthand                           | free-text/regex → `grep`, filename → `glob`, dir shape → `list`, web → `search`, past memory → `recall` |

## Anti-patterns

- Do not call `find_symbol` then `grep` (or vice versa) serially as fallback for the same identifier — they answer different questions (declaration vs usage). If both are genuinely needed, call them in parallel.
- Do not `read` a whole large file when `find_symbol` or `grep` can narrow the line window first.
- `grep`→`read` past two pairs on same target without locking a file+line span — switch tool family (`find_symbol` / `explore`) or commit to the edit; a third same-target pair is the violation.

## Soft-warn handling

When a tool result begins with a `⚠ … soft-warn` marker, treat it as a self-enforced halt: the runtime won't stop you (aborts only fire at the per-axis ceiling of 100), you must stop yourself. Same-result loops count too — paraphrasing the query a third time is itself a violation.

| Marker | Recovery |
|--------|----------|
| `⚠ Tool-loop` (same call+args 4× in a row) | Stop the exact retry. Change inputs *semantically* or switch tool. |
| `⚠ Repeated-tool` (one tool called many times) | Batch outstanding queries into one array-form call, or hand off to a different family — low-level file (`read` / `grep` / `glob` / `list`), structural (`find_symbol`), synthesized retrieval (`explore` / `recall` / `search`). |
| `⚠ Mixed-tool` (consecutive low-level lookups w/o progress) | Jump up to `find_symbol` / `explore` for one decisive pass, or commit to the edit if target locked. |
| `⚠ Tool-budget` (total calls high) | Truncate scope — synthesize what you have, report partial findings honestly, stop new investigation threads. |

**General rules**: synthesize first if evidence is enough; never paraphrase-and-retry; if no actionable evidence yet, surface what was attempted and ask. If a high-level tool itself triggered the warn, switching down to `read` / `grep` is valid only with a known path or literal pattern. **Second warn for the same marker** = your first recovery did not work; do not repeat it. Stop the line of work, report what you have plus what failed, hand back to the user.
