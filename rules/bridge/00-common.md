# Bridge Constraints

- `bridge` is Lead's tool — agents cannot delegate to other bridges.
- Tool permissions are enforced at call time. If a tool returns a denied error, don't loop — report back.

## First-move discipline

Two rules dominate iter waste. Apply BEFORE the first tool call:

1. **One assistant turn = many parallel tool calls.** Independent calls on different tools with no data dependency MUST go in ONE message as multiple tool_use blocks. Reads, greps, status lookups, log peeks — if none depend on each other's output, they go together. Sequential single-tool turns are the #1 iter waste; default to multi-block until proven dependent. Array form on `read` / `grep` / `glob` / `edit` follows the same rule (`rules/shared/01-tool.md` covers the full Decision Table).
2. **2 rounds per sub-problem, not per turn.** Locate → confirm → commit. A third round on the same sub-problem means the approach is wrong (switch tool family or report) — not that one more grep will save it.

Lead-provided `path:line/range` coordinates are LOCKED — go straight to edit/apply_patch, never re-read for verification. Only re-read if line numbers don't match (then stop and report mismatch, not loop).

## First Tool Heuristic

Before free-form planning, map the request to the most decisive first tool:

- **Lead provided `path:line` or `path:start-end` coordinates** → treat the target as already located; edit directly unless the task is read-only/review. Do not re-locate via `find_symbol` / `grep` / `glob`; re-locate only if coordinates are invalid (file moved, line range missed the symbol).
- If the user explicitly says to use a specific tool, call that tool before answering.
- When the request names an exact marker, identifier, or `KEY=VALUE` token, extract from that exact match.
- Directory metadata constraints (size, mtime, newest/oldest) → `list mode:"find"` first.
- Concrete directory path named (e.g. `src`, `releases`) → `list` on that directory directly; do not list parent first.
- Once a tool result visibly contains the requested marker/value/field, answer immediately. Do not repeat an identical `read`/`grep`/`list` call to re-check.

Beyond these, follow the Decision Table in `rules/shared/01-tool.md` — the single source of truth for query-shape → first-tool mapping, including direct-alias preference for imports / callers / references / dependents.

If a direct alias (`find_imports` / `find_dependents` / `find_callers` / `find_references`) is not exposed in the current bridge tool list, use `code_graph(mode='imports'|'dependents'|'callers'|'references')` instead — same backend.

Do not spend a turn "thinking about which tool to use" when the query already matches one of the cases above.

## Large tasks: split, don't grind

- Task spans many files / renames / rewrites / verifications → do NOT finish in one turn. Tool-budget aborts (120× bash, 32× read) signal scope was too big, not retry hint.
- Pick a narrow axis (one concern, one directory, one check) and finish it cleanly. Report delta and stop. Lead dispatches follow-ups.
- Prefer one broad command (single `rg` across tree) over many per-file reads. Same file-level probe 5+ times → switch to aggregate query.
- Approaching tool-family budget (≈70% used) → stop adding scope. Wrap up.
- Aborted budget → never restart same plan. Next call must use narrower scope or different strategy.

## Reporting style — final reply to Lead

Lead is human, output tokens are billed. Same shape as Lead’s user reply (`lead/04-workflow.md` Communication).

- Bullets only: `path:line — verb + what`. One line each (~140 chars). Split into multiple bullets if longer.
- One header max. No tables, no `**path**` bolding, no nested sub-bullets, no emoji / check-marks.
- Omit code blocks / before-after / log samples / re-quoted brief / counts unless Lead asked.
- Verification: one inline line (pass/fail + tool name). Version bump: inline (e.g. `version 0.1.232 → 0.1.233`). No separate sections.
- No spec echo, no preamble, no closing list of what wasn’t done. Failed / partial: same shape — done, stopped, blocker.
- Verification briefs (N items): one bullet per — `<id>: OK | BLOCK: <reason>` + `path:line`. Final line: `verdict: merge | request-changes`.
- **Wrap the final reply in `<final-answer>...</final-answer>` tags.** Anything outside the tags is discarded by the runtime, so put nothing inside that you don't want Lead to read. Inner deliberation, self-correction, tool-result echoes, scratch work — keep them outside or omit entirely. If the question's premise is wrong, say so inside the tags in one bullet.
