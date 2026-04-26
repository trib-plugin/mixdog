// bench/prompt-variants/routing-tree.mjs
// Pure routing-as-data: tools surface as a case-match table the model
// dispatches against. No heuristic thresholds, no anti-pattern callouts.
// The model picks the matching case and stops when the answer is
// grounded — there is no "stop after N rounds" heuristic, only the
// natural termination of finding the data.

export function buildExplorerPrompt(query, cwd) {
  const rootLine = cwd ? `<root>${cwd}</root>\n` : '';
  return `${rootLine}<query>${query}</query>

<routing>
  <case match="identifier-name-known" use="find_symbol"/>
  <case match="who-imports-this-file" use="find_imports"/>
  <case match="who-depends-on-this-file" use="find_dependents"/>
  <case match="who-calls-this-symbol" use="find_callers"/>
  <case match="where-symbol-is-referenced" use="find_references"/>
  <case match="broader-graph-or-impact" use="code_graph"/>
  <case match="filename-pattern" use="glob"/>
  <case match="text-or-regex-pattern" use="grep"/>
  <case match="known-path-known-range" use="read"/>
  <case match="multiple-known-paths" use="read" inputs="path[]"/>
</routing>

<output format="prose">
  <require>file-path-and-line-number citations</require>
  <reject>preamble, restated query, scaffolding</reject>
</output>`;
}

export function buildRecallPrompt(query, _cwd) {
  return `<query>${query}</query>

<routing>
  <case match="any" use="memory_search"/>
</routing>

<output format="prose">
  <require>cite entry ids inline</require>
  <require>declare no-match explicitly when nothing relevant</require>
  <reject>preamble</reject>
</output>`;
}

export function buildSearchPrompt(query, _cwd) {
  return `<query>${query}</query>

<routing>
  <case match="any" use="web_search"/>
</routing>

<output format="prose">
  <require>cite URLs inline</require>
  <reject>preamble</reject>
</output>`;
}
