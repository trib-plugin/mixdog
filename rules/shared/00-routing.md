# Tool Routing

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

## Preflight

Before any tool call, scan the query for known scope and collapse multiple rounds into one targeted call:

- code lookup → known identifier, file path, or regex pattern → ONE call to `find_symbol` / `read` / `grep`.
- past memory → known entry id (`#NNNN`), date, or named decision → ONE `recall` anchored on that.
- external → explicit URL, owner/repo, or domain → ONE `search` scoped to that source.
- Skip preflight only when the query is a genuinely broad concept search.

## Routing

**Information-retrieval tools are top priority. Always prefer `recall` / `search` / `explore` (and `read` / `glob` / `list` / `grep` for known-path / pattern work) over `bash` for any lookup. Using `bash` with `ls` / `cat` / `find` / `head` / `tail` / `grep` for file or code lookup is a rule violation — `bash` is shell-only work (git, build, test, run).**

- **When unsure, choose by scope first. This is mandatory, not a suggestion.**
- Past context → `recall`. External web / URL / GitHub → `search`. Local filesystem → `explore`.
- Do not route a clearly local codebase question through `recall` or `search` before `explore`.
- Known path → `read` directly. Unknown location → `grep` / `glob` first, then targeted `read`.
- Code structure (imports, dependents, symbols, references, callers): `code_graph` before raw `grep`.
- Multi-file or already-clear edits: `apply_patch` before repeated `read` → `edit`.
- Shell work across turns: pass `persistent:true` to `bash` to reuse shell state — don't replay setup in repeated one-shot `bash` calls.
- For long background commands, use `job_wait` to block until completion; `read` the stdout/stderr path for logs.
- Large tool outputs may be saved to a path with a preview; only `read` that path if the preview is insufficient.
- `recall` / `search` / `explore` — a single rich NL query is the default; internal agent judges multi-angle probes (glob/grep, web, memory) and returns a synthesized answer. Array only when asks are genuinely unrelated.

## Scope boundaries

- `recall` — past context only. Not codebase, not web.
- `search` — external / web only. Not codebase, not memory.
- `explore` — local filesystem only. Not web, not memory.
- Pick the right tool; no silent cross-scope fan-out.

## Stop-and-reroute

Tool returns empty / wrong after 2 tries → don't loop. Change approach or ask.

Same-result loops count too: if the second call returns the same hits / coordinates / synthesis as the first, paraphrasing the query a third time will not help. Switch tools (cross-scope: `recall` ↔ `explore` ↔ `search` ↔ direct file `read`) or read the underlying source (transcript jsonl, log file, source file) directly.

## Retrieval tool essentials

Detailed per-surface usage lives with each retrieval role; callers only need these basics:

- `recall` — single rich NL query over past memory. The internal agent fans out and synthesizes. If a second call returns the same hits as the first, switch tools — don't paraphrase a third time. Storage is automatic; never write to memory directly.
- `search` — external web / URL / GitHub only. Not for codebase or memory lookup.
- `explore` — local filesystem only. The `cwd` argument is the authoritative search root (absolute path or `~` expansion). **Never target broad roots**: `~`, `$HOME`, `/`, `C:/`, `D:/`, drive roots, or `~/.claude` itself — these scan millions of files and have killed the mcp server in the past. If the right narrower subdir isn't obvious, run a `list` over the parent first to pick one, then `explore` against that subdir.
