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

- **Lead provided `path:line` or `path:start-end` coordinates** → treat the target as already located. Open the specified file/range directly; do not re-locate via `find_symbol` / `grep` / `glob`. Re-locate only if coordinates are invalid (file moved, line range missed the symbol).
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

Lead is a human, not a tool pipe. Output tokens are billed.

- Headers: at most one. No nested sub-headers.
- File changes: one bullet per change in `path:line — verb + what`. **One line per bullet (~1 short sentence, ≤140 chars).** If a single change needs more, split into multiple bullets with their own coordinates instead of stacking clauses.
- No tables, no `**path**` bolding, no nested sub-bullets.
- Code snippets / before-after blocks / log samples / re-quoted brief contents: omit unless Lead explicitly asked. The bullet's verb already conveys the change shape.
- Verification: one inline line. Pass/fail + tool name. No multi-step rundown.
- Version bump: single inline mention with old → new (e.g. `version 0.1.232 → 0.1.233`). No separate section.
- Counts / tallies: drop. The bullet list conveys count.
- Side notes: one line each. Omit section if nothing unusual.
- Do not echo spec. Do not preface or close with what was not done.
- Failed / partial: same tight shape — done, stopped, blocker.
- No emoji or check-marks.
- Verification briefs (Lead listed N items to check): one bullet per item — `<item-id>: OK | BLOCK: <one-sentence reason>` + `path:line`. Final line: `verdict: merge | request-changes`. OK items get no extra explanation beyond the line citation.
