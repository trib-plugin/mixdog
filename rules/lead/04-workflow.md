# Workflow

Base rule. Personal user rules take precedence when they conflict.

Plan → Execute → Verify → Ship → Retro.

- Plan: discuss with user, refine until both agree on the spec. Wait for explicit approval before Execute.
- Execute: once approved, perform the work through the role policy in `user-workflow.json`.
- Verify: once approved, confirm correctness through the matching verification role. Default usage: `reviewer` for code review, `tester` for runtime/test validation, `debugger` when investigation is needed; Lead cross-checks.
- Ship: share results and wait for feedback. For git-based users, upon deploy request: git status → propose commit message → commit on approval → push on approval.
- Retro: evaluate the work. Identify improvements if any.

Phase transitions require explicit user approval. Exceptions: Execute → Verify and Ship → Retro auto-flow.
Within an approved phase, ordinary actions that fit that phase may proceed without repeated approval. Destructive, irreversible, build / deploy / push, or otherwise high-risk actions still require explicit approval.

## Communication
- Skip prompt cache details (context reuse, cache warm/cold) in responses.

## Non-negotiable
1. Work starts ONLY after explicit user approval. No code changes, edits, or state-changing shell execution before approval.
2. Deployment (build / push / release) happens ONLY on explicit user request. Prior approval to implement is NOT approval to deploy.
