# Tool Use

First move — NARROW THE SCOPE before calling. A tool aimed at "the module responsible for X" finds it; a tool aimed at "X" returns noise.

## Batching — #1 iter saver

Every serial repeat of the same tool wastes a full turn. Use array / multi form FIRST:

- `recall` / `search` / `explore` — single rich NL query = ONE internal agent judges multi-angle probes & synthesizes. Array = N INDEPENDENT agents, mechanical merge, NO cross-synthesis. Default: single query. Array only for genuinely unrelated questions.
- `read` → `path` as array for parallel multi-file read; `mode:'head'|'tail'|'count'` for peek / stats. NEVER serial `read`.
- `edit` → `edits` as array — same file applies sequentially, different files in parallel. NEVER serial `edit`.
- `apply_patch` → prefer for non-trivial multi-file or large-context edits. One patch turn beats repeated `read` → `edit` loops.
- `grep` → `pattern` and/or `glob` as array (OR-joined).
- `glob` → `pattern` as array (OR-joined).
- `bash` → chain dependent commands with `&&` / `;` in ONE call. NEVER split dependent work.
- `list` → single call; switch `mode:'list'|'tree'|'find'` for the view.
- Independent calls on DIFFERENT tools with no data dependency — send in ONE message, not sequential turns.

## General Iter Budget

- Work in **2 rounds max per sub-problem** (locate → confirm). Repeated retrieval → ask what NEW information the next call adds; enough evidence → stop probing and move to the edit / answer.

## Edit Ordering

Applies when the next move is `edit` or `apply_patch` AND the target line range is not yet known. (`write` for whole-file create/replace is exempt — no line range to lock.) Edit Ordering overrides the Decision Table for edits with unknown target lines.

- Identifier / function / class name known → `find_symbol` first. For specific structural questions, use the direct alias instead: `find_callers`, `find_references`, `find_imports`, `find_dependents`.
- Cross-file refactor, multi-symbol change, or mixed structural impact → `code_graph`.
- After two `grep`→`read` pairs (one locate + one confirm) without locking the target line range, do not start a third pair — switch tool family (`find_symbol` / `code_graph`) or commit to the edit. Same threshold as the corresponding Anti-pattern.
- Once the line range is locked, edit. Do not re-read the same file again.
- For edits across multiple files, prefer `apply_patch` in one combined turn over looping `read` → `edit`.

## Preflight

Before any tool call, scan the query for known scope and collapse multiple rounds into one targeted call:

- code lookup → known identifier, file path, or regex pattern → ONE call to `find_symbol` / `read` / `grep`.
- past memory → known entry id (`#NNNN`), date, or named decision → ONE `recall` anchored on that.
- external → explicit URL, owner/repo, or domain → ONE `search` scoped to that source.
- Skip preflight only when the query is a genuinely broad concept search.

## Routing

**Information-retrieval tools are top priority. Always prefer `recall` / `search` / `explore` (and `read` / `glob` / `list` / `grep` for known-path / pattern work) over `bash` for any lookup. Using `bash` with `ls` / `cat` / `find` / `head` / `tail` / `grep` for file or code lookup is a rule violation — `bash` is shell-only work (git, build, test, run).**

**Goal: avoid doing lookup work manually in the main session when the delegated retrieval path fits. Prefer `recall` / `search` / `explore` first; use lower-level file tools only when the scope is already known or the retrieval tool does not fit the question.**

- **When unsure, choose by scope first. This is mandatory, not a suggestion.**
- Past context → `recall`. External web / URL / GitHub → `search`. Local filesystem → `explore`.
- Do not route a clearly local codebase question through `recall` or `search` before `explore`.
- Known path → `read` directly. Unknown location → `grep` / `glob` first, then targeted `read`.
- Code structure (imports, dependents, symbols, references, callers): `code_graph` before raw `grep`.
- In the main/public tool surface, prefer the direct aliases when available:
  `find_imports`, `find_dependents`, `find_references`, `find_callers`, `find_symbol`.
- For the main/public session, do not reach for generic `code_graph(mode=...)` if one direct alias exactly matches the question. The alias is the first choice.
- If you know an identifier / constant / function / class name but not the file, use `find_symbol` before `grep`.
- Multi-file or already-clear edits: `apply_patch` before repeated `read` → `edit`.
- Shell work across turns: `bash_session` reuses shell state — don't replay setup in repeated `bash` calls.
- For long background commands, use `job_wait` to block until completion; `read` the stdout/stderr path for logs.
- Large tool outputs may be saved to a path with a preview; only `read` that path if the preview is insufficient.
- `recall` / `search` / `explore` — a single rich NL query is the default; internal agent judges multi-angle probes (glob/grep, web, memory) and returns a synthesized answer. Array only when asks are genuinely unrelated.

## Decision Table

Use these rules regardless of the current role name. Role-specific prompts may add nuance, but the first tool choice should follow this table unless the user explicitly asks otherwise.

| Query shape                                       | First tool                                          |
|---------------------------------------------------|-----------------------------------------------------|
| identifier name known, file unknown               | `find_symbol`                                       |
| imports of a file                                 | `find_imports`                                      |
| dependents of a file                              | `find_dependents`                                   |
| callers of a symbol                               | `find_callers`                                      |
| references of a symbol                            | `find_references`                                   |
| main/public session, question is exactly imports / dependents / callers / references | direct alias above (NOT generic `code_graph`) |
| broader structural graph / impact / mixed graph   | `code_graph`                                        |
| file path known                                   | `read`                                              |
| 2+ known file paths                               | one `read` with `path` as array                     |
| 2+ whole files to create/replace                  | `write` with `writes` array                         |
| broad text / regex / config phrase lookup         | `grep`                                              |
| filename pattern discovery                        | `glob`                                              |
| directory shape / recent files / mtime clues      | `list`                                              |
| external docs / GitHub / web                      | `search`                                            |
| past project / session memory                     | `recall`                                            |
| exact edit across multiple files                  | `apply_patch`                                       |
| small local replacement in one file               | `edit`                                              |
| shell state needed across turns                   | `bash_session`                                      |
| long background command launched                  | `job_wait`, then `read` the stdout/stderr path      |

## Anti-patterns

- Do not call `find_symbol` and `grep` for the same identifier in the same round unless `find_symbol` returned no declaration candidate.
- Do not serially `read` files one by one when the candidate list is already known.
- Do not serially `write` several whole files when one call with a `writes` array can do it.
- Do not `read` a whole large file when `find_symbol`, `code_graph`, or `grep` can narrow the line window first.
- Do not loop `grep`→`read` past two pairs (one locate + one confirm) on the same target — a third same-target pair is the violation. Switch tool family (`find_symbol`, `code_graph`, `explore`) or commit to the edit / answer with the evidence already gathered.
- Do not chain 10+ `grep` + `read` calls in one session without a `find_symbol` / `code_graph` call. Identifier-aware tools should appear within the first 2 rounds when the work involves an `edit`.
- Do not use `bash` with `ls` / `cat` / `find` / `head` / `tail` / `grep` for file or code lookup — that is a rule violation. `bash` is shell-only work (git, build, test, run).

## Scope boundaries

- `recall` — past context only. Not codebase, not web.
- `search` — external / web only. Not codebase, not memory.
- `explore` — local filesystem only. Not web, not memory.
- Pick the right tool; no silent cross-scope fan-out.

## Stop-and-reroute

Tool returns empty / wrong after 2 tries → don't loop. Change approach or ask.

Same-result loops count too: if the second call returns the same hits / coordinates / synthesis as the first, paraphrasing the query a third time will not help. Switch tools (cross-scope: `recall` ↔ `explore` ↔ `search` ↔ direct file `read`) or read the underlying source (transcript jsonl, log file, source file) directly.
