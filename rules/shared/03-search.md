# Search

- All external information lookups MUST use the `search` tool. Built-in `WebSearch` / `WebFetch` are forbidden.
- Accepts natural language. Include a URL to trigger scrape; mention `owner/repo` for GitHub code / issues / repos. An internal agent picks the provider and returns a synthesized answer.
- One `search` dispatch = up to 2 inner `web_search` calls (hard-capped at 4 by the runtime). If the answer comes back with a `sparse` note, narrow the query yourself and re-issue — do not expect a single dispatch to widen internally.
- When unsure, search first. Never guess.
