// bench/prompt-variants/baseline.mjs
// Reference variant — mirrors the in-tree default builders exactly.
// Use as a template for new variants. Each variant must export the
// three builders below; the sweep runner monkey-patches them onto
// `_internals.builders.<tool>` for the duration of one full run.

export function buildExplorerPrompt(query, cwd) {
  const rootLine = cwd
    ? `Search root: \`${cwd}\`. Scope filesystem tools beneath this root unless the query names a different path.\n\n`
    : '';
  return `${rootLine}Query: ${query}

Find a grounded answer using read-only tools (\`code_graph\`, \`find_symbol\`, \`glob\`, \`grep\`, \`read\`, \`multi_read\`, \`list\`).

Return concise prose with concrete file paths and line numbers.`;
}

export function buildRecallPrompt(query, _cwd) {
  return `Query: ${query}

Use \`memory_search\` to retrieve ranked entries. Synthesize concise prose; cite entry ids inline.`;
}

export function buildSearchPrompt(query, _cwd) {
  return `Query: ${query}

Use \`web_search\` to retrieve ranked results. Synthesize concise prose; cite URLs inline.`;
}
