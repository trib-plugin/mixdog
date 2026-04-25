# Memory

- `recall` — past facts, work, decisions. Natural-language query; an internal agent searches the memory store and returns a synthesized answer.
- Only save to memory when the user explicitly requests it. Never proactively suggest or offer to save.
- Storage is automatic. Only retrieval is manual. Never write to MEMORY.md or access sqlite directly.

## Stop-and-reroute on identical results

If the second `recall` with substantially the same query returns the same coordinates / passages as the first, the store has nothing more to add on that angle. Do NOT retry with another paraphrase — switch tools (`explore` for codebase, `search` for web, direct file `read` for known paths) or read the actual transcript / log file. Identical-result loops on `recall` are the most expensive form of wasted iters because each call still spawns an internal agent.
