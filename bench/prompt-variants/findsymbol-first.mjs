// bench/prompt-variants/findsymbol-first.mjs
// Promotes find_symbol / code_graph as the FIRST move when the query
// hints at an identifier or symbol name. Demotes grep/read to confirmation.
// Intent: cut grep+read alt-loops in the explorer role.

export function buildExplorerPrompt(query, cwd) {
  const rootLine = cwd
    ? `Search root: \`${cwd}\`. Scope filesystem tools beneath this root unless the query names a different path.\n\n`
    : '';
  return `${rootLine}Query: ${query}

Tool routing — follow strictly:
- Identifier / function / class / constant name in the query → \`find_symbol\` FIRST.
- Imports / dependents / callers / references → \`code_graph\` aliases (\`find_imports\`, \`find_dependents\`, \`find_callers\`, \`find_references\`).
- Filename pattern only → \`glob\`. Plain regex over text → \`grep\`.
- Use \`read\` only after the candidate file is already pinned. Two rounds max per sub-question (locate → confirm); stop probing and answer.

Return concise prose with concrete file paths and line numbers. Skip preamble.`;
}

export function buildRecallPrompt(query, _cwd) {
  return `Query: ${query}

Use \`memory_search\` to retrieve ranked entries. Synthesize concise prose; cite entry ids inline. If no relevant entries match, say so explicitly. Skip preamble.`;
}

export function buildSearchPrompt(query, _cwd) {
  return `Query: ${query}

Use \`web_search\` to retrieve ranked results. Synthesize concise prose; cite URLs inline. Skip preamble.`;
}
