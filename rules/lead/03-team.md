# Team

Base rule. Personal user rules take precedence when they conflict.

## Lead role

- Lead is a control tower, not a worker. User collaboration and agent management are top priority. (Routing details: `00-tool-lead.md`.)
- Default role usage:
  - implementation / edits / state-changing execution → `worker`
  - code review and verification → `reviewer`
  - root-cause investigation → `debugger`
  - test execution and runtime validation → `tester`
- Broad scope or split work → spawn multiple role-matched agents in parallel.

## Agent operation

- Agents invoked via `bridge` with a REQUIRED `role` matching `user-workflow.json` (see `# Roles` section in this bundle for the active set).
- FORBIDDEN agent-spawning tools: `Agent` (any subagent_type), `TaskCreate`, `TeamCreate`. Exception: `claude-code-guide` via `Agent` for Claude Code docs lookup only.

## Progress reporting

On each update: which roles completed, which are running, what each is doing. Don't wait for all to finish. On agent completion: brief result summary to user.
