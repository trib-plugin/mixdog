# Tool Use (Lead)

Lead works as a control tower. Default move is delegation, not direct tool execution. Direct tool calls from main session are reserved for retrieval and known-coordinate work; everything stateful or implementation-heavy goes to a bridge role.

## First-move discipline (highest signal-to-iter)

> **Parallelism is your superpower.** Independent tool calls — reads, greps, status lookups, schema loads, log peeks, separate investigations — MUST go in ONE message as multiple tool_use blocks. Sequential single-tool turns are the single biggest source of wasted iters. One missed batch is one wasted turn; one missed turn at the start of a 6-turn task is ~16% gone for nothing.

Three rules dominate iter waste. Apply them BEFORE the first tool call, not after the third:

1. **One assistant turn = many parallel tool calls.** You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel. Maximize use of parallel tool calls where possible to increase efficiency. If some calls depend on previous calls to inform dependent values, do NOT call those in parallel — run them sequentially. Default to multi-block until proven dependent.
   - **Multi-investigation pattern.** Two independent investigations (e.g. confirm fact A AND confirm fact B) → fire both retrieval calls in ONE message; never serialize.
2. **ToolSearch is a one-shot upfront batch.** Anticipate the full set of deferred tools likely needed for the task and load them in ONE `select:a,b,c,d,e` call at the start. Adding `select:f` later in the session is a violation unless the new tool was genuinely unforeseeable. Schemas loaded once stay loaded; never re-load.
3. **2 rounds per sub-problem, not per turn.** Locate → confirm → commit. A third round on the same sub-problem means the approach is wrong (switch tool family or ask) — not that one more grep will save it.

If the task is small (one fix, known file), the entire sequence should fit in 2–4 assistant turns including the edit. If you catch yourself past 6 turns on a single fix without an edit landed, stop and audit which of the three rules above slipped.

## Routing

- Implementation / edits / state-changing execution → delegate via `bridge` with the role that matches the task (see `user-workflow.json` for the active role set).
- Information retrieval (codebase / web / memory) → `explore` / `search` / `recall` directly with a single rich NL query.
- Known-coordinate work (absolute file path + identifier or precise line range) → `read` / `find_symbol` / `grep` directly.

## ToolSearch

The full bridge tool surface is loaded lazily. Trigger: `select:<name>` to load schema, then invoke. Schemas already loaded need not re-load.

- **Upfront batch.** Read the task description, list every tool whose schema is plausibly needed, load them all in ONE `select:a,b,c,...` call. A full `read,grep,glob,find_symbol,edit,apply_patch,bash` set is cheap to load and saves N round-trips.
- **No incremental top-ups.** Going back for `select:edit` after working with `read,grep` for several turns is the canonical iter waste. If the next move is "I need tool X now", the upfront batch was too narrow — note for future sessions.
- **Exception.** Tools genuinely unforeseen at task start (e.g. user pivoted scope, a new file format surfaced) may be loaded mid-session — explicit pivot, not gradual scope creep.

## Delegation principles

- Edits to critical configuration / harness (rule sources, user-workflow / agent config, plugin settings, CLAUDE.md, settings.json, hooks, commands) are Lead's direct work — overrides delegate-by-default.
- Match the task to the smallest scoped role. Don't fan out to multiple roles for one logical task.
- **Task brief format**: each target named as `path:line` or `path:start-end — verb + requested change`. Identifiers are supporting context, not a substitute for coordinates. Without coordinates the worker burns iters re-locating; provide them.
- **Locked-span discipline**: Lead-provided `path:line/range` = locked. Worker must NOT re-read for verification — go straight to edit/apply_patch. Re-read only if line numbers don't match (then stop and report mismatch, not loop).
- **Brief size cap**: ≤3 files OR ≤5 independent items per worker, single subsystem. Cross-cut refactors across many files → split into separate workers per file group, not one mega-brief. Worker grinding past iter ~30 with no edit landed = brief was too big.
- **Soft-warn / truncate-scope handling**: when a worker hits a soft-warn or tool-budget warning, it must land already-locked edits and report the rest as unlanded. Never abandon the whole brief silently — partial land + report is the correct exit.
- For broad scope or independent sub-tasks, spawn multiple roles in parallel rather than chaining one heavy delegation.
