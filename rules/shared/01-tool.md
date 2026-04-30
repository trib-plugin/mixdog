# Tool Routing

**HARD RULE — file/code/memory/web lookup MUST start with `recall` (past) / `search` (web) / `explore` (codebase). Reaching for `bash` / `grep` / `glob` / `read` / `find_symbol` as the very first move on an unknown target is a violation. Shell and low-level file tools are reserved for known-coordinate work — exact path + line range or a precise literal pattern.**

First move — NARROW THE SCOPE before calling. A tool aimed at "the module responsible for X" finds it; a tool aimed at "X" returns noise.

## Parallelism — #1 iter saver

> **Independent tool calls go in ONE message as multiple tool_use blocks — never serialize what can run together.** One missed batch is one wasted turn. Each tool's description carries its own array / multi-form rules; this section is the meta principle.

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
- Skip preflight only when the query is a genuinely broad concept search.

## Routing

**Choose by scope, not hunch.** Past context → `recall`. External web / URL → `search`. Local filesystem → `explore`. The Decision Table below is the full first-tool mapping; tool descriptions carry the calling discipline (array form, dup-call avoidance, mode selection).

`bash` is shell-only work (git, build, test, run). Using `bash` with `ls` / `cat` / `find` / `head` / `tail` / `grep` for file or code lookup is a rule violation.

## Decision Table

Use these rules regardless of the current role name. Role-specific prompts may add nuance, but the first tool choice should follow this table unless the user explicitly asks otherwise.

| Query shape                                       | First tool                                          |
|---------------------------------------------------|-----------------------------------------------------|
| identifier name known, file unknown               | `find_symbol`                                       |
| callers / references / imports / dependents       | `find_symbol` with `mode:"callers"` / `"references"` / `"imports"` / `"dependents"` |
| broader structural graph / file overview / impact | `find_symbol` with `mode:"overview"` / `"symbols"` / `"impact"` / `"related"` |
| file path known                                   | `read`                                              |
| 2+ known file paths                               | one `read` with `path` as array                     |
| 2+ whole files to create/replace                  | `write` with `writes` array                         |
| symbolic token (env var / constant / config key name) | `find_symbol`                                   |
| free-text phrase or regex lookup (non-symbolic)   | `grep`                                              |
| filename pattern discovery                        | `glob`                                              |
| directory shape / recent files / mtime clues      | `list`                                              |
| external docs / web                               | `search`                                            |
| past project / session memory                     | `recall`                                            |
| exact edit across multiple files                  | `apply_patch`                                       |
| small local replacement in one file               | `edit`                                              |
| shell state needed across turns                   | `bash` with `persistent:true`                       |
| long background command launched                  | `job_wait`, then `read` the stdout/stderr path      |

## Anti-patterns

- Do not call `find_symbol` then `grep` (or vice versa) serially as fallback for the same identifier — they answer different questions (declaration vs usage). If both are genuinely needed, call them in parallel.
- Do not `read` a whole large file when `find_symbol` or `grep` can narrow the line window first.
- `grep`→`read` past two pairs on same target without locking a file+line span — switch tool family (`find_symbol` / `explore`) or commit to the edit; a third same-target pair is the violation.
- Do not use `bash` with `ls` / `cat` / `find` / `head` / `tail` / `grep` for file or code lookup.

## Scope boundaries

- `recall` — past context only. Not codebase, not web.
- `search` — external / web only. Not codebase, not memory.
- `explore` — local filesystem only. Not web, not memory.
- Pick the right tool; no silent cross-scope fan-out.

## Stop-and-reroute

Tool returns empty / wrong after 2 tries → don't loop. Change approach or ask.

Same-result loops count too: if the second call returns the same hits / coordinates / synthesis as the first, paraphrasing the query a third time will not help. Switch tools (cross-scope: `recall` ↔ `explore` ↔ `search` ↔ direct file `read`) or read the underlying source (transcript jsonl, log file, source file) directly.

## Heeding soft-warns

When a tool result begins with a `⚠ … soft-warn` marker, treat it as a self-enforced halt: the runtime won't stop you, you must stop yourself. Aborts only fire at the per-axis ceiling (100), which is far away — that is not a license to grind, it is the reason this rule exists.

### Per-marker response

- `⚠ Tool-loop soft-warn` — same call returned the same result/error 4× in a row.
  → **Stop the exact retry.** The signature (tool + args + error class) won't change by repeating. Change inputs *semantically* (different scope or different question, not just reworded) or switch tools.
- `⚠ Repeated-tool soft-warn` — the same tool has been called many times in this session.
  → **Batch or switch family.** Combine outstanding queries into one array-form call, or hand off to a *different family*. Three families: low-level file (`read` / `grep` / `glob` / `list`), structural (`find_symbol`), synthesized retrieval (`explore` / `recall` / `search`). Switching within one family does not count.
- `⚠ Mixed-tool soft-warn` — many consecutive low-level lookups across `read` / `grep` / `glob` / `list` without a productive call. ("Productive" = the call narrowed the scope — locked a file+line range, identified a symbol, or eliminated candidates. Mere hits without progress don't count.)
  → **Jump up.** `find_symbol` / `explore` for one decisive pass; or commit to the edit if the target is already locked.
- `⚠ Tool-budget soft-warn` — total tool calls in this session are getting high.
  → **Truncate scope.** Synthesize what you have, report partial findings honestly, and stop *new investigation threads*. Wrap up the current edit / answer; do not expand into adjacent questions or open a new probe.

### General rules (apply to every marker)

- **Synthesize first if possible.** If the evidence already gathered is enough to answer or commit to the edit, do that next — the cleanest exit.
- **Do not paraphrase and retry.** A near-identical follow-up call after a soft-warn is itself a violation.
- **No evidence yet?** If the warn fires before anything actionable was found (rare — usually means session-history pressure, not this turn's probes), report what was attempted and ask the user for direction. Do not guess.
- **Warning fired on a high-level tool itself?** (`recall` / `search` / `explore` repeats triggering `Repeated-tool` or `Tool-budget`.) Switching down to `read` / `grep` is a valid switch — but only with a known path or literal pattern. Otherwise, surface the partial result and ask.

### Second warn

If the same marker fires a second time in this session — your first response did not work. Do not repeat the same recovery move. Stop the current line of work, report what you have plus what failed, and hand back to the user.
