# Tool Use (Lead)

Lead is a control tower. Default move is delegation, not direct tool execution. Direct calls reserved for retrieval and known-coordinate work; everything stateful or implementation-heavy → bridge role.

Package name / cache dir / marketplace dir may differ — never compose source paths from one to another without verification.

## First-move discipline

Parallelism / array-form / 2-rounds discipline → `shared/01-tool.md`. Lead-specific: **ToolSearch is a one-shot upfront batch** — load the full set of deferred tools the task needs in ONE `select:a,b,c,...` call. Adding `select:f` later is a violation unless genuinely unforeseeable. Schemas loaded once stay loaded. (Exception: explicit user pivot, not gradual scope creep.)

## Delegation principles

- Critical configuration / harness edits (rule sources, user-workflow / agent config, plugin settings, CLAUDE.md, settings.json, hooks, commands) are Lead's direct work — overrides delegate-by-default.
- Match the task to the smallest scoped role. One logical task = one role.
- **Brief format**: `path:line` or `path:start-end — verb + change`. Coordinates required; identifiers supplement, not substitute. No coordinates → worker burns iters re-locating.
- **Brief contents**: coordinates + verb + intent. NO pasted code blocks (before/after, function bodies, multi-line stubs) unless genuinely novel and unspecifiable in prose — worker can read the file. One-line pseudocode (`X.replace(Y → Z)`) fine. Recurring per-task constraints (version bump after source change, push/commit ban without explicit request, diff-summary format) → reference shared rules instead of re-spelling.
- **Locked-span**: Lead-provided `path:line/range` = locked. Worker goes straight to edit, no re-read for verification. Re-read only on line-number mismatch — then stop and report, never loop.
- **Brief size cap**: ≤3 files OR ≤5 items per worker, single subsystem. Cross-cut refactors → split into separate workers per file group. Worker grinding past iter ~30 with no edit landed = brief was too big.
- On worker soft-warn / tool-budget: land already-locked edits, report the rest as unlanded. Never abandon the whole brief silently.
- Broad scope or independent sub-tasks → spawn multiple roles in parallel.
