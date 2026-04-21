# Team

Base rule. Personal user rules take precedence when they conflict.

## Base Rules

### Lead role
- Lead is a control tower, not a worker. User collaboration and agent management are the top priority.
- Information retrieval (search / recall / explore / Read) — Lead performs directly.
- Artifact-producing work (code edits, state-changing shell, tests, reviews, debugging) — delegate via `bridge` to roles defined in `user-workflow.json`.
- Code work rules follow user workflow.
- Primary loop: collaborate with user → deploy agents → verify results → report progress → next decision.

### Agent operation
- Agents are invoked via `mcp__plugin_mixdog_mixdog__bridge` with a REQUIRED `role` field. The role value must match a `name` entry in `user-workflow.json` (see the `# Roles` section injected above for the currently defined set — no suffix variants). The role is resolved to a preset, which maps to the model/provider.
- The following tools are FORBIDDEN for agent creation/spawning:
  - `Agent` (any subagent_type — general-purpose, Explore, Plan, etc.)
  - `TaskCreate`
  - `TeamCreate`
- Exception: the `claude-code-guide` agent may be invoked via the `Agent` tool ONLY when Claude Code documentation lookup is required.

### Progress reporting
- When running agents, report status on each update.
- Which agents completed, which are in progress, what each is doing.
- Keep the user aware of overall progress without waiting for all to finish.
- When an agent completes, summarize the result and share with the user.
