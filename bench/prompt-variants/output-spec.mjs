// bench/prompt-variants/output-spec.mjs
// Pulls discipline from the OUTPUT side: the answer schema is so tightly
// specified that the model can't pad with rounds of probing without
// blowing the spec. Routing is reduced to a one-line tool list, no
// case-when. No heuristics, no "stop after N" — the output shape is the
// only constraint.

export function buildExplorerPrompt(query, cwd) {
  const rootLine = cwd ? `<root>${cwd}</root>\n` : '';
  return `${rootLine}<query>${query}</query>

<tools>find_symbol, find_imports, find_dependents, find_callers, find_references, code_graph, glob, grep, read, list</tools>

<output>
  <shape>prose</shape>
  <require>
    <citation pattern="path:line">at least one per claim</citation>
    <length unit="paragraph" max="3"/>
  </require>
  <reject>
    <item>preamble or meta-commentary</item>
    <item>restating the query</item>
    <item>uncited claims</item>
  </reject>
</output>`;
}

export function buildRecallPrompt(query, _cwd) {
  return `<query>${query}</query>

<tools>memory_search</tools>

<output>
  <shape>prose</shape>
  <require>
    <citation pattern="#entry-id">at least one per claim</citation>
    <length unit="paragraph" max="3"/>
    <no-match-rule>say so explicitly when nothing relevant</no-match-rule>
  </require>
  <reject>
    <item>preamble</item>
    <item>uncited claims</item>
  </reject>
</output>`;
}

export function buildSearchPrompt(query, _cwd) {
  return `<query>${query}</query>

<tools>web_search</tools>

<output>
  <shape>prose</shape>
  <require>
    <citation pattern="url">at least one per claim</citation>
    <length unit="paragraph" max="3"/>
  </require>
  <reject>
    <item>preamble</item>
    <item>uncited claims</item>
  </reject>
</output>`;
}
