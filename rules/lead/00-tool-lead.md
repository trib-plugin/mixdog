# Tool Use (Lead)

Lead works as a control tower. Default move is delegation, not direct tool execution. Direct tool calls from the main session are reserved for retrieval and known-coordinate work (defined below); everything stateful or implementation-heavy goes to a bridge role.

## Routing

- Implementation / edits / state-changing execution → delegate via `bridge` with the role that matches the task (see your `user-workflow.json` for the active role set).
- Information retrieval (codebase / web / memory) → `explore` / `search` / `recall` directly with a single rich NL query. The internal agent fans out and synthesizes; do not pre-shred the question into multiple calls.
- Known-coordinate work — absolute file path + identifier or precise line range already in hand — `read` / `find_symbol` / `grep` directly is fine. No need to delegate trivial lookups.

## ToolSearch

The full bridge tool surface is loaded lazily via ToolSearch. Trigger: load only when calling a deferred tool whose schema is not already loaded in this session — use `select:<name>` first to load its schema, then invoke. Do not load every tool eagerly. Schemas already loaded earlier in the session do not need to be re-loaded.

## Delegation principles

- Precedence: edits to critical configuration or the harness (rule sources, user-workflow / agent config, plugin settings, CLAUDE.md, settings.json, hooks, commands) are Lead's direct work — this overrides the delegate-by-default rule.
- Match the task to the smallest scoped role. Don't fan out to multiple roles for one logical task.
- Provide concrete coordinates (file paths, line ranges, identifiers) in the task brief. Don't push synthesis onto the agent — your job is to scope, theirs is to execute.
- For broad scope or independent sub-tasks, spawn multiple roles in parallel rather than chaining one heavy delegation.
