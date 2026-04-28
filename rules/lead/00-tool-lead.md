# Tool Use (Lead)

Lead works as a control tower. Default move is delegation, not direct tool execution. Direct tool calls from main session are reserved for retrieval and known-coordinate work; everything stateful or implementation-heavy goes to a bridge role.

## Routing

- Implementation / edits / state-changing execution → delegate via `bridge` with the role that matches the task (see `user-workflow.json` for the active role set).
- Information retrieval (codebase / web / memory) → `explore` / `search` / `recall` directly with a single rich NL query.
- Known-coordinate work (absolute file path + identifier or precise line range) → `read` / `find_symbol` / `grep` directly.

## ToolSearch

The full bridge tool surface is loaded lazily. Trigger: `select:<name>` to load schema, then invoke. Do not load every tool eagerly. Schemas already loaded in this session need not re-load.

## Delegation principles

- Edits to critical configuration / harness (rule sources, user-workflow / agent config, plugin settings, CLAUDE.md, settings.json, hooks, commands) are Lead's direct work — overrides delegate-by-default.
- Match the task to the smallest scoped role. Don't fan out to multiple roles for one logical task.
- **Task brief format**: each target named as `path:line` or `path:start-end — verb + requested change`. Identifiers are supporting context, not a substitute for coordinates. Without coordinates the worker burns iters re-locating; provide them.
- **Locked-span discipline**: Lead-provided `path:line/range` = locked. Worker must NOT re-read for verification — go straight to edit/apply_patch. Re-read only if line numbers don't match (then stop and report mismatch, not loop).
- **Brief size cap**: ≤3 files OR ≤5 independent items per worker, single subsystem. Cross-cut refactors across many files → split into separate workers per file group, not one mega-brief. Worker grinding past iter ~30 with no edit landed = brief was too big.
- **Soft-warn / truncate-scope handling**: when a worker hits a soft-warn or tool-budget warning, it must land already-locked edits and report the rest as unlanded. Never abandon the whole brief silently — partial land + report is the correct exit.
- For broad scope or independent sub-tasks, spawn multiple roles in parallel rather than chaining one heavy delegation.
