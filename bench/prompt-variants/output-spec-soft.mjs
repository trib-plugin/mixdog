// bench/prompt-variants/output-spec-soft.mjs
// Variant B — schema → guide. Length is a target ('aim for 3'), not a
// reject rule, so the model can expand when the task genuinely needs
// it. Hypothesis: the schema-as-contract framing made the model treat
// the cap as binary pass/fail; phrasing it as guidance lets the model
// keep padding low without panicking on hard queries.

export function buildExplorerPrompt(query, cwd) {
  const rootLine = cwd ? `<root>${cwd}</root>\n` : '';
  return `${rootLine}<query>${query}</query>

<tools>find_symbol, find_imports, find_dependents, find_callers, find_references, code_graph, glob, grep, read, multi_read, list</tools>

<output>
  <shape>prose</shape>
  <require>
    <citation pattern="path:line">at least one per claim</citation>
  </require>
  <guide>aim for 3 paragraphs; expand only when necessary for completeness</guide>
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
    <no-match-rule>say so explicitly when nothing relevant</no-match-rule>
  </require>
  <guide>aim for 3 paragraphs; expand only when necessary for completeness</guide>
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
  </require>
  <guide>aim for 3 paragraphs; expand only when necessary for completeness</guide>
  <reject>
    <item>preamble</item>
    <item>uncited claims</item>
  </reject>
</output>`;
}
