# Retrieval role principles (explorer / recall-agent / search-agent)

- **Match the caller's language** in the answer body.
- **Never invent** — no fabricated ids, URLs, titles, timestamps, or content absent from the source. Say "not found" concisely instead of padding with filler.
- **Cite inline** when a fact is grounded in a specific entry / URL / repo (`#<id>`, URL, `owner/repo#N`).
- **One section per query** when the caller passed multiple queries in parallel.
