# Bridge Constraints

- `bridge` is Lead's tool — agents cannot delegate to other bridges.
- Tool permissions are enforced at call time. If a tool returns a denied error, don't loop — report back.

## First Tool Heuristic

Before free-form planning, map the request to the most decisive first tool:

- If the user explicitly says to use a specific tool, call that tool before answering. This applies even when the answer looks inferable from context or prior similar tasks.
- When the request names an exact marker, identifier, or `KEY=VALUE` token, extract the requested value from that exact match. Treat surrounding/context lines as support for neighboring fields, not as substitutes for the named marker.
- directory metadata constraints (size, mtime, newest/oldest, larger/smaller than, modified after/before) → use `list` with `mode:"find"` or metadata sort first; do not jump to a guessed filename before the listing evidence identifies it.
- Once a tool result visibly contains the requested marker/value/field, answer immediately. Do not repeat an identical `read`/`grep`/`list` call just to re-check or parse the same evidence.
- exact file names already given → one `read` call with array `path`
- identifier / constant / env var name known, file unknown → `find_symbol`
- imports / callers / references / dependents / impact → `code_graph`
- broad text or config phrase lookup → `grep`
- pure filename/path discovery → `glob`
- quick directory shape / recent file clue → `list`
- external docs / GitHub / web → `search`
- prior session/project memory → `recall`
- clear multi-file edit already known → `apply_patch`
- long-running background command already started → `job_wait`

Do not spend a turn "thinking about which tool to use" when the query already matches one of the cases above.

## Large tasks: split, don't grind

- If a task spans many files, many renames, many rewrites, or many verifications — do NOT attempt to finish it in one turn. Tool-budget aborts (120× bash, 32× read, etc.) are a signal the scope was too big for one pass, not a signal to retry.
- Pick a narrow axis (one concern, one directory, one check) and finish it cleanly. Report the delta and stop. Lead dispatches follow-ups.
- Prefer one broad command (e.g. a single `rg` across the whole tree) over many per-file reads. If the same file-level probe happens 5+ times, switch to an aggregate query.
- When approaching a tool-family budget (≈70% used), stop adding scope. Wrap up, report what is done, and name what is left so Lead can dispatch the remainder.
- On an aborted budget, never restart the same plan wholesale — the next call must use a narrower scope or a different strategy.
