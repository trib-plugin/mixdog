---
name: retro-skill-proposer
description: Use ONLY during the Retro phase of a Plan/Execute/Verify/Ship/Retro workflow to evaluate whether the completed session produced a reusable pattern worth saving as a skill draft. Never triggers during other phases. Skip if session was trivial or no distinctive pattern emerged. User-approval gated — never saves without explicit OK.
version: 0.1.0
---

# Retro Skill Proposer

## When to invoke

Only at the Retro phase of the `Plan -> Execute -> Verify -> Ship -> Retro` workflow. Never during Plan/Execute/Verify/Ship. If the session did not follow this workflow at all (pure Q&A, quick lookup, etc.), do not invoke.

Skip entirely when any of:
- Fewer than 5 tool calls in session
- Pure reading / research with no state change
- No distinctive pattern emerged
- An existing skill already covers the pattern (check `~/.claude/skills/`, `~/.claude/skills/auto/`, `~/.claude/skills/auto-drafts/`, plugin bundled skills)

## Trigger conditions (ANY ONE is sufficient)

1. **Complex success** — a 5+ tool call workflow completed successfully
2. **Error recovery** — got past an error and found a working path
3. **User correction** — user revealed a better approach mid-session
4. **Novel sequence** — a non-obvious reusable tool chain worth remembering

## Procedure

1. **Silent scan** — review the current session's tool calls, decisions, user corrections. Do NOT narrate this step.
2. **Match conditions** — evaluate against the four trigger conditions above.
3. **Dedup check** — compare the candidate pattern against existing skills in:
   - `~/.claude/skills/` (user global)
   - `~/.claude/skills/auto/` (auto-generated, promoted)
   - `~/.claude/skills/auto-drafts/` (auto-generated, pending)
   - plugin bundled skills
4. **Propose** — if eligible and non-duplicate, write a concise proposal in Korean:
   - Skill name (slug form)
   - Which trigger condition matched
   - When to invoke the skill
   - Procedure (step by step)
   - Verification method
   - Why this is worth saving (1-2 sentences)
5. **Wait for user approval** — the user MUST explicitly say "save" or equivalent. Silence or ambiguity means skip.
6. **On approval** — use the Write tool to create:
   - `~/.claude/skills/auto-drafts/{name}/SKILL.md` with proper frontmatter (name, description, version: 0.1.0)
   - Include the full procedure in markdown body
7. **On skip or rejection** — leave no trace, no explanation needed. Continue the Retro normally.

## Non-goals

- Do NOT propose for every session
- Do NOT save without explicit user approval
- Do NOT duplicate existing skills
- Do NOT modify CLAUDE.md or bridge common instructions
- Do NOT propose during Plan/Execute/Verify/Ship phases
- Do NOT force-inject the skill into future sessions — saved drafts sit dormant until the LLM naturally picks them up via Progressive Disclosure

## SKILL.md frontmatter template for the draft

```yaml
---
name: <slug-form-name>
description: <one-line trigger description; keep under 200 chars; lead with "Use when..."; be specific about conditions so the LLM can match accurately>
version: 0.1.0
source: retro-skill-proposer
session: <current session id or date>
---
```

## Proposal output format (to the user, in Korean)

```
Proposed skill: {name}
Trigger: {which of the 4 conditions matched}
When to use: {when to invoke this skill}

Procedure:
1. ...
2. ...
3. ...

Verification: {how to confirm the skill worked}

Why it is worth saving: {1-2 sentences}

On approval, save to ~/.claude/skills/auto-drafts/{name}/SKILL.md.
```

## Verification

After saving, confirm the file exists at the expected path and the frontmatter parses cleanly. Do not auto-test the skill — it sits as a draft until:
- A batch run promotes it to `auto/` after frequency validation, OR
- The user manually moves it to `~/.claude/skills/`
