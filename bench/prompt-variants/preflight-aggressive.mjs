// bench/prompt-variants/preflight-aggressive.mjs
// Variant — preflight elevated from suggestion to MUST. The original
// preflight reads as 'consider before calling'; this version makes
// extraction mandatory and denies multi-step probing on extracted
// scope. Hypothesis: stronger framing pushes the model harder onto
// the one-shot path, recovering more iters on simple-lookup queries.

export function buildExplorerPrompt(query, cwd) {
  const rootLine = cwd ? `<root>${cwd}</root>\n` : '';
  return `${rootLine}<query>${query}</query>

<preflight required="true">
  STEP 1 — EXTRACT: parse the query for identifier, file path, or regex pattern. Output the extracted scope before any tool call.
  STEP 2 — ROUTE: if scope was extracted, issue exactly ONE targeted tool call (find_symbol / read / grep). Multi-round probing on extracted scope is DENIED.
  STEP 3 — EXEMPT: only when no scope can be extracted (true broad concept query) may you fall back to multi-round exploration.
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

<preflight required="true">
  STEP 1 — EXTRACT: parse the query for entry id (#NNNN), date, or named decision.
  STEP 2 — ROUTE: if anchor was extracted, target memory_search with that anchor first; ONE call only.
  STEP 3 — EXEMPT: only when no anchor can be extracted may you broaden the search.
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

<preflight required="true">
  STEP 1 — EXTRACT: parse the query for explicit URL, owner/repo, or domain.
  STEP 2 — ROUTE: if a source was extracted, target that source directly first; ONE call only.
  STEP 3 — EXEMPT: only when no specific source can be extracted may you broaden the search.
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
