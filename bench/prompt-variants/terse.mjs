// bench/prompt-variants/terse.mjs
// Compressed variant — strips the soft "concise prose" framing and
// drops the per-tool list, leaving only the query + a one-line goal.
// Useful for measuring whether the longer baseline scaffolding
// actually changes pass-rate or just burns tokens.

export function buildExplorerPrompt(query, cwd) {
  const rootLine = cwd ? `cwd=${cwd}\n` : '';
  return `${rootLine}Q: ${query}\nAnswer with file:line citations.`;
}

export function buildRecallPrompt(query, _cwd) {
  return `Q: ${query}\nAnswer from memory_search; cite entry ids.`;
}

export function buildSearchPrompt(query, _cwd) {
  return `Q: ${query}\nAnswer from web_search; cite URLs.`;
}
