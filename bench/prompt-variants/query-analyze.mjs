// bench/prompt-variants/query-analyze.mjs
// Adds a structured self-classification step: the model fills the
// <analyze> hints based on the query, then routes from the table. No
// heuristic thresholds — the analysis is a data shape the model fills
// in, not a rule the model is told to obey.

export function buildExplorerPrompt(query, cwd) {
  const rootLine = cwd ? `<root>${cwd}</root>\n` : '';
  return `${rootLine}<query>${query}</query>

<analyze>
  <hint name="identifier-bound"   type="boolean">query names a specific function / class / constant / variable</hint>
  <hint name="graph-shaped"       type="boolean">query asks about imports, dependents, callers, or references</hint>
  <hint name="multi-file"         type="boolean">answer likely spans more than one file</hint>
  <hint name="known-path"         type="boolean">query already names the file or directory</hint>
  <hint name="filename-pattern"   type="boolean">query asks for files matching a name pattern</hint>
</analyze>

<routing>
  <case when="identifier-bound"           use="find_symbol"/>
  <case when="graph-shaped"               use="find_imports | find_dependents | find_callers | find_references | code_graph"/>
  <case when="filename-pattern"           use="glob"/>
  <case when="known-path AND multi-file"  use="multi_read"/>
  <case when="known-path"                 use="read"/>
  <case otherwise="true"                  use="grep then read"/>
</routing>

<output format="prose" cite="file:line">
  <reject>preamble, restated query, scaffolding</reject>
</output>`;
}

export function buildRecallPrompt(query, _cwd) {
  return `<query>${query}</query>

<routing>
  <case otherwise="true" use="memory_search"/>
</routing>

<output format="prose" cite="entry-id" no-match="declare-explicitly">
  <reject>preamble</reject>
</output>`;
}

export function buildSearchPrompt(query, _cwd) {
  return `<query>${query}</query>

<routing>
  <case otherwise="true" use="web_search"/>
</routing>

<output format="prose" cite="url">
  <reject>preamble</reject>
</output>`;
}
