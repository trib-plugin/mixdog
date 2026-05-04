// Runtime envelope limits for explore output. These are not classifier
// heuristics — they cap raw string allocation to stay clear of V8's
// max-string-length (~512 MB) when concatenating subagent responses across
// a broad cwd (e.g. the whole ~/.claude tree). Lowering these would silently
// truncate legitimate output; raising them risks OOM crashes in the MCP server.
export const EXPLORE_OUTPUT_CHAR_CAP = 50_000_000
export const EXPLORE_PER_PIECE_CHAR_CAP = 5_000_000
export const EXPLORE_TRUNCATION_MARKER = '\n\n[explore: output truncated at 50MB cap; narrow cwd or split queries to see more]'
