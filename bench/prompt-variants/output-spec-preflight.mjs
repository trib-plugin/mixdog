// bench/prompt-variants/output-spec-preflight.mjs
// Variant C — output-spec + input-side narrowing. Anthropic's
// effective-context-engineering guide flags 'preflight narrowing' as
// the highest-leverage move: extract known identifier/path/pattern
// from the query before any tool call, then collapse 3 rounds into 1
// targeted call. Hypothesis: relieving the input side reduces the
// pressure on the output schema, lowering tail timeouts without
// loosening the cap.

export function buildExplorerPrompt(query, cwd) {
  const rootLine = cwd ? `<root>${cwd}</root>\n` : '';
  return `${rootLine}<query>${query}</query>

<preflight>
  Before any tool call, scan the query for: known identifier, file path, or regex pattern.
  If found, issue ONE targeted call (find_symbol / read / grep with that scope).
  Skip preflight only when the query is a broad concept search.
</preflight>

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

<preflight>
  Before searching, scan the query for: explicit entry id (#NNNN), date, or named decision.
  If found, target memory_search with that anchor first.
</preflight>

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

<preflight>
  Before searching, scan the query for: explicit URL, owner/repo, or domain.
  If found, target that source directly first.
</preflight>

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
