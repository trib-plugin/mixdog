# Memory

- `recall` — past facts, work, decisions. Natural-language query; an internal agent searches the memory store and returns a synthesized answer. Caller iter cap and identical-result discipline live in the universal Stop-and-reroute (`01-tool.md`); same rule applies here.
- Only save to memory when the user explicitly requests it. Never proactively suggest or offer to save.
- Storage is automatic. Only retrieval is manual. Never access the database directly.
