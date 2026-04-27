// bench/prompt-variants/structured-deep.mjs
// Combines tool capability schema (what each tool does) with a routing
// table (when to use each). Both are pure data — the model reads them
// like an API reference and dispatches without imperative guidance.

export function buildExplorerPrompt(query, cwd) {
  const rootLine = cwd ? `<root>${cwd}</root>\n` : '';
  return `${rootLine}<query>${query}</query>

<tools>
  <tool name="find_symbol"     accepts="identifier-name"     returns="declaration locations"/>
  <tool name="find_imports"    accepts="file-path"           returns="files importing it"/>
  <tool name="find_dependents" accepts="file-path"           returns="files depending on it"/>
  <tool name="find_callers"    accepts="symbol-name"         returns="call sites"/>
  <tool name="find_references" accepts="symbol-name"         returns="all references"/>
  <tool name="code_graph"      accepts="mode + target"       returns="graph slice"/>
  <tool name="glob"            accepts="filename-pattern"    returns="paths"/>
  <tool name="grep"            accepts="regex"               returns="matching lines"/>
  <tool name="read"            accepts="path | path[]"       returns="contents (single or batched)"/>
  <tool name="list"            accepts="path + mode"         returns="directory shape"/>
</tools>

<routing>
  <case input="identifier-name"           tool="find_symbol"/>
  <case input="who-imports-X"             tool="find_imports"/>
  <case input="who-depends-on-X"          tool="find_dependents"/>
  <case input="who-calls-X"               tool="find_callers"/>
  <case input="where-X-referenced"        tool="find_references"/>
  <case input="broader-graph"             tool="code_graph"/>
  <case input="filename-pattern"          tool="glob"/>
  <case input="text-or-regex"             tool="grep"/>
  <case input="known-path"                tool="read"/>
  <case input="multiple-known-paths"      tool="read" args="path[]"/>
  <case input="directory-shape"           tool="list"/>
</routing>

<output format="prose" cite="file:line">
  <reject>preamble, restated query, scaffolding</reject>
</output>`;
}

export function buildRecallPrompt(query, _cwd) {
  return `<query>${query}</query>

<tools>
  <tool name="memory_search" accepts="natural-language" returns="ranked entries"/>
</tools>

<routing>
  <case input="any" tool="memory_search"/>
</routing>

<output format="prose" cite="entry-id" no-match="declare-explicitly">
  <reject>preamble</reject>
</output>`;
}

export function buildSearchPrompt(query, _cwd) {
  return `<query>${query}</query>

<tools>
  <tool name="web_search" accepts="natural-language" returns="ranked results"/>
</tools>

<routing>
  <case input="any" tool="web_search"/>
</routing>

<output format="prose" cite="url">
  <reject>preamble</reject>
</output>`;
}
