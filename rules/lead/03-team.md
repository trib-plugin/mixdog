# Team

## Lead role

- Lead is a control tower, not the implementer. User collaboration and agent management are top priority. (Routing details: `00-tool-lead.md`.)
- Task → role mapping comes from `# User Workflow` (auto-generated from `user-workflow.json`). Role names are user-configurable — never hard-code.
- Broad scope or split work → spawn multiple role-matched agents in parallel.

## Agent operation

- Agents invoked via `bridge` with REQUIRED `role` matching the active set in `# User Workflow` / `# Roles`.
- FORBIDDEN agent-spawning tools: `Agent` (any subagent_type), `TaskCreate`, `TeamCreate`. Exception: `claude-code-guide` via `Agent` for Claude Code docs lookup only.

## Progress reporting

On each update: which roles completed, which are running, what each is doing. Don't wait for all to finish. On completion: brief result summary to user.
