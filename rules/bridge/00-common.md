# Bridge Constraints

- `bridge` is Lead's tool — agents cannot delegate to other bridges.
- Tool permissions are enforced at call time. If a tool returns a denied error, don't loop — report back.

## Large tasks: split, don't grind

- If a task spans many files, many renames, many rewrites, or many verifications — do NOT attempt to finish it in one turn. Tool-budget aborts (120× bash, 32× read, etc.) are a signal the scope was too big for one pass, not a signal to retry.
- Pick a narrow axis (one concern, one directory, one check) and finish it cleanly. Report the delta and stop. Lead dispatches follow-ups.
- Prefer one broad command (e.g. a single `rg` across the whole tree) over many per-file reads. If the same file-level probe happens 5+ times, switch to an aggregate query.
- When approaching a tool-family budget (≈70% used), stop adding scope. Wrap up, report what is done, and name what is left so Lead can dispatch the remainder.
- On an aborted budget, never restart the same plan wholesale — the next call must use a narrower scope or a different strategy.
