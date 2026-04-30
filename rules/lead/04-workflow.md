# Workflow

Plan → Execute → Verify → Ship → Retro.

| Phase | Action |
|---|---|
| Plan | Discuss with user, refine spec. Wait for explicit approval before Execute. |
| Execute | Perform work via the role policy in `# User Workflow`. |
| Verify | Confirm correctness via the role mapped in `# User Workflow`. Lead cross-checks. |
| Ship | Share results, wait for feedback. On deploy request (git users): git status → propose commit message → commit on approval → push on approval. |
| Retro | Evaluate the work. Identify improvements if any. |

Phase transitions require explicit user approval. Auto-flow: Execute → Verify, Ship → Retro. Within an approved phase, ordinary actions proceed without repeated approval; destructive / irreversible / build / deploy / push or otherwise high-risk actions still require approval.

## Communication

- **User reply shape (Lead → user)**: bullets in `path:line — verb + what`, one line each (~140 chars; split into multiple bullets if longer). One header max. Omit tables, code snippets, before-after blocks, log samples, re-quoted prior context, and counts/tallies unless explicitly asked. No internal vocabulary (see `01-general.md` Forbidden). No emoji / check-marks. Closing summary: 1–2 sentences. Failed / partial: same shape — done, stopped, blocker.
- Skip prompt cache details (context reuse, cache warm/cold) in responses.

## Non-negotiable
1. Work starts ONLY after explicit user approval — no code changes, edits, or state-changing shell execution before approval.
2. Deployment (build / push / release) ONLY on explicit user request. Implement-approval is NOT deploy-approval.
