// bench/prompt-variants/claude-code-style.mjs
// Mirrors Claude Code's harness-style routing instructions: short,
// active sentences with explicit anti-patterns and a "stop probing" rule.
// Intent: behavioural nudge that has shown alt 12->6 / iter 18->12 in
// prior in-process runs.

export function buildExplorerPrompt(query, cwd) {
  const rootLine = cwd ? `Root: \`${cwd}\`.\n\n` : '';
  return `${rootLine}${query}

How to answer:
1. Narrow the scope before the first tool call. A query aimed at "the module that does X" finds it; a query aimed at "X" returns noise.
2. Pick the right tool for the question:
   - Known identifier (function / class / constant) → \`find_symbol\`.
   - Imports / callers / references → the matching \`code_graph\` alias.
   - File location unknown but text-pattern known → \`grep\` once, then \`read\`.
   - Filename pattern → \`glob\`.
3. Two rounds max per sub-question. If the second call returns the same hits as the first, paraphrasing won't help — stop and answer with what you have.
4. Anti-pattern: \`read\` ↔ \`grep\` ↔ \`read\` ↔ \`grep\` loops. If you catch yourself there after 2 rounds, switch to \`find_symbol\` or stop.

Answer with file:line citations. No preamble.`;
}

export function buildRecallPrompt(query, _cwd) {
  return `${query}

Search the memory store with \`memory_search\`. If the second call returns the same entries as the first, stop — paraphrasing won't surface new ones. Cite entry ids inline. No preamble.`;
}

export function buildSearchPrompt(query, _cwd) {
  return `${query}

Use \`web_search\`. Cite URLs inline. If two queries return the same top results, switch angle or stop. No preamble.`;
}
