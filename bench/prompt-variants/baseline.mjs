// bench/prompt-variants/baseline.mjs
// Reference variant — mirrors the in-tree default builders exactly.
// Use as a template for new variants. Each variant must export the
// three builders below; the sweep runner monkey-patches them onto
// `_internals.builders.<tool>` for the duration of one full run.
//
// The active default is the per-tool hybrid:
//   recall   = aggressive (MUST step 1-2-3)
//   search   = strict     (cap 2 paragraph)
//   explore  = plain preflight (cap 3 paragraph)
// chosen from the 3-run cumulative sweep where this combination took
// the lowest wall and stable p50 across all three tools.

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

<preflight>
  Before searching, scan the query for: explicit URL, owner/repo, or domain.
  If found, target that source directly first.
</preflight>

<tools>web_search</tools>

<output>
  <shape>prose</shape>
  <require>
    <citation pattern="url">at least one per claim</citation>
    <length unit="paragraph" max="2"/>
  </require>
  <reject>
    <item>preamble</item>
    <item>uncited claims</item>
  </reject>
</output>`;
}
