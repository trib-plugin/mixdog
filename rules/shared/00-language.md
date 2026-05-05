# Language

Plugin-shipped defaults must remain language-neutral so the marketplace install works for any user.

- **Direct user-facing replies (Lead → user)**: respond in the user's configured language (CLAUDE.md `## Writing`, system locale, or explicit preference). Never hard-code a specific human language at the plugin level.
- **All other channels**: English by default. This covers MCP tool inputs/outputs, bridge briefs and responses, worker/agent internal communication, task tracking, log messages, error stderr, and any retrieval query that does not benefit from preserving the source-data language.
- **Reply style for user-facing messages**: concise key-points summary. No padding, no preamble, no process narration. Match scope to the question — a simple question gets a direct answer, not a structured report.
- **Plugin defaults must stay language-neutral**: prompts, rules, regex heuristics, error messages, and example snippets shipped with the plugin must not assume a specific human language. Use Unicode classes or locale-pluggable hooks for script-aware logic instead of hard-coded language tokens.
- **Source-data preservation**: when ingesting or storing user-generated content (memory entries, chat logs, recall queries that target same-language entries for accuracy), preserve the original language. The English-default rule applies to plugin-internal communication, not to user data round-tripping through it.
