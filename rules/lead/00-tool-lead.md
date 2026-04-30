# Tool Use (Lead)

Lead works as a control tower. Default move is delegation, not direct tool execution. Direct tool calls from main session are reserved for retrieval and known-coordinate work; everything stateful or implementation-heavy goes to a bridge role.

## First-move discipline

Parallelism / array-form / 2-rounds discipline lives in `shared/01-tool.md`. Lead-specific rule on top: **ToolSearch is a one-shot upfront batch** — anticipate the full set of deferred tools the task will need and load them in ONE `select:a,b,c,...` call at the start. Adding `select:f` later is a violation unless the new tool was genuinely unforeseeable. Schemas loaded once stay loaded; never re-load. (Exception: explicit user pivot, not gradual scope creep.)

## Routing

- Implementation / edits / state-changing execution → delegate via `bridge` with the role that matches the task (see `user-workflow.json` for the active role set).
- Retrieval and known-coordinate work → direct, per Decision Table in `shared/01-tool.md`.

## Delegation principles

- Edits to critical configuration / harness (rule sources, user-workflow / agent config, plugin settings, CLAUDE.md, settings.json, hooks, commands) are Lead's direct work — overrides delegate-by-default.
- Match the task to the smallest scoped role. Don't fan out to multiple roles for one logical task.
- **Task brief format**: each target named as `path:line` or `path:start-end — verb + requested change`. Identifiers are supporting context, not a substitute for coordinates. Without coordinates the worker burns iters re-locating; provide them.
- **Brief contents discipline**: brief = coordinates + verb + intent. Do NOT paste full code blocks (before/after replacements, function bodies, multi-line stubs) unless the change is genuinely novel and unspecifiable in prose. Worker can read the file. Pasting code 3-5× inflates input tokens for no signal gain. One-line pseudocode (`X.replace(Y → Z)`) is fine.
- **Standard footer reuse**: recurring per-task constraints (version bump after source change, push/commit ban without explicit user request, diff-summary report format) are codified in shared rules. Don't re-spell them per brief — a single line reference (e.g. `# Per bridge/00-common.md reporting + version bump 0.1.X`) suffices.
- **Locked-span discipline**: Lead-provided `path:line/range` = locked. Worker must NOT re-read for verification — go straight to edit/apply_patch. Re-read only if line numbers don't match (then stop and report mismatch, not loop).
- **Brief size cap**: ≤3 files OR ≤5 independent items per worker, single subsystem. Cross-cut refactors across many files → split into separate workers per file group, not one mega-brief. Worker grinding past iter ~30 with no edit landed = brief was too big.
- **Soft-warn / truncate-scope handling**: when a worker hits a soft-warn or tool-budget warning, it must land already-locked edits and report the rest as unlanded. Never abandon the whole brief silently — partial land + report is the correct exit.
- For broad scope or independent sub-tasks, spawn multiple roles in parallel rather than chaining one heavy delegation.
