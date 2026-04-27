// bench/prompt-variants/structured.mjs
// XML-tagged structured prompt — separates query / constraints / output
// shape into explicit blocks. Some models follow structured prompts more
// reliably than free-prose ones; useful as a control variant.

export function buildExplorerPrompt(query, cwd) {
  const rootLine = cwd ? `<root>${cwd}</root>\n` : '';
  return `${rootLine}<query>${query}</query>

<tools>
  <prefer>find_symbol, code_graph, glob, grep, read, list</prefer>
  <route>
    <case when="identifier-known">find_symbol</case>
    <case when="imports-or-callers">code_graph alias (find_imports/find_dependents/find_callers/find_references)</case>
    <case when="filename-pattern">glob</case>
    <case when="text-regex">grep then read</case>
  </route>
  <budget rounds="2" stop-on="same-results"/>
</tools>

<output>concise prose, file:line citations, no preamble</output>`;
}

export function buildRecallPrompt(query, _cwd) {
  return `<query>${query}</query>

<tool>memory_search</tool>
<output>cite entry ids inline; declare no-match explicitly; no preamble</output>`;
}

export function buildSearchPrompt(query, _cwd) {
  return `<query>${query}</query>

<tool>web_search</tool>
<output>cite URLs inline; no preamble</output>`;
}
