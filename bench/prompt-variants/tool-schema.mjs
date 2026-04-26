// bench/prompt-variants/tool-schema.mjs
// Each tool gets a small structured spec (role + accepts) instead of an
// imperative routing instruction. The model reads tool capabilities like
// API docs and selects on its own. No "FIRST", no "MUST", no thresholds.

export function buildExplorerPrompt(query, cwd) {
  const rootLine = cwd ? `<root>${cwd}</root>\n` : '';
  return `${rootLine}<query>${query}</query>

<tools>
  <tool name="find_symbol"     accepts="identifier-name"           returns="declaration locations"/>
  <tool name="find_imports"    accepts="file-path"                 returns="files importing it"/>
  <tool name="find_dependents" accepts="file-path"                 returns="files depending on it"/>
  <tool name="find_callers"    accepts="symbol-name"               returns="call sites"/>
  <tool name="find_references" accepts="symbol-name"               returns="all references"/>
  <tool name="code_graph"      accepts="mode + symbol-or-path"     returns="structural graph slice"/>
  <tool name="glob"            accepts="filename-pattern"          returns="matching paths"/>
  <tool name="grep"            accepts="regex + optional-glob"     returns="matching lines"/>
  <tool name="read"            accepts="path | path[]"             returns="file contents"/>
  <tool name="multi_read"      accepts="path[]"                    returns="batched contents"/>
  <tool name="list"            accepts="path + mode(list|tree|find)" returns="directory shape"/>
</tools>

<output format="prose" cite="file:line"/>`;
}

export function buildRecallPrompt(query, _cwd) {
  return `<query>${query}</query>

<tools>
  <tool name="memory_search" accepts="natural-language" returns="ranked memory entries"/>
</tools>

<output format="prose" cite="entry-id" no-match="declare-explicitly"/>`;
}

export function buildSearchPrompt(query, _cwd) {
  return `<query>${query}</query>

<tools>
  <tool name="web_search" accepts="natural-language" returns="ranked web results"/>
</tools>

<output format="prose" cite="url"/>`;
}
