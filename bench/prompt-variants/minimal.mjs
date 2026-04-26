// bench/prompt-variants/minimal.mjs
// One-line prompt — strips ALL guidance, leaves the model to its own
// trained defaults. Useful as a floor: if minimal matches baseline,
// the scaffolding is purely cosmetic.

export function buildExplorerPrompt(query, cwd) {
  const rootLine = cwd ? `cwd=${cwd}\n` : '';
  return `${rootLine}${query}`;
}

export function buildRecallPrompt(query, _cwd) {
  return query;
}

export function buildSearchPrompt(query, _cwd) {
  return query;
}
