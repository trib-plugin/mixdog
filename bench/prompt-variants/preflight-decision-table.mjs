// bench/prompt-variants/preflight-decision-table.mjs
// Variant — preflight + 1-line decision table. Combines input-side
// narrowing with explicit query-shape → first-tool routing. Hypothesis:
// when the model already extracted scope (preflight), an explicit
// dispatch table further compresses the routing decision, removing
// the few cases where preflight extracts scope but picks a sub-optimal
// tool.

export function buildExplorerPrompt(query, cwd) {
  const rootLine = cwd ? `<root>${cwd}</root>\n` : '';
  return `${rootLine}<query>${query}</query>

<preflight>
  Before any tool call, scan the query for: known identifier, file path, or regex pattern.
  If found, issue ONE targeted call using the decision table below.
  Skip preflight only when the query is a broad concept search.
</preflight>

<decision-table>
  identifier known, file unknown   → find_symbol
  who imports / depends / calls    → find_imports / find_dependents / find_callers
  where referenced                 → find_references
  filename / glob pattern          → glob
  text / regex content match       → grep
  known absolute path              → read
  directory shape / mtime          → list
</decision-table>

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

<decision-table>
  entry id (#NNNN) cited      → memory_search anchored on that id
  date / time window mentioned → memory_search filtered by that range
  named decision / event       → memory_search keyed on that name
  broad topic                  → memory_search natural language
</decision-table>

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

<decision-table>
  explicit URL          → web_search anchored on that URL
  owner/repo or domain  → web_search scoped to that source
  named library/tool    → web_search keyed on that name + 'docs'
  broad concept         → web_search natural language
</decision-table>

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
