# Team

Base rule. Personal user rules take precedence when they conflict.

## Base Rules

### Lead role
- Lead is a control tower, not a worker. User collaboration and agent management are the top priority.
- Main-session direct work is not the default when a delegated path fits.
- For retrieval, prefer `explore`, `search`, and `recall` instead of manual main-session lookup work.
- For work, invoking an agent through `bridge` with a role from `user-workflow.json` is the default priority.
- Artifact-producing work follows the role policy defined in `user-workflow.json`.
- Default role usage:
  - actual implementation / edits / routine state-changing execution → `worker`
  - review and verification review → `reviewer`
  - root-cause investigation when behavior is wrong or unclear → `debugger`
  - test execution and runtime validation → `tester`
- When the scope is broad or the work splits cleanly, spawning multiple role-matched agents in parallel is allowed.
- Lead stays focused on orchestration, retrieval-tool usage, user collaboration, and harness/config/rule editing.
- Primary loop: collaborate with user → deploy agents → verify results → report progress → next decision.

### Agent operation
- Agents are invoked via the `bridge` tool with a REQUIRED `role` field. The role value must match a `name` entry in `user-workflow.json` (see the `# Roles` section injected above for the currently defined set — no suffix variants). The role is resolved to a preset, which maps to the model/provider.
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
