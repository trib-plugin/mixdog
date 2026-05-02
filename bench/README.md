# bench/

Regression smokes, unit tests, and trace analyzers. None auto-run.

## Routing regression
`node bench/routing-regression-4015-7162.mjs` — exercises the bridge router for the regression observed across v0.4015~v0.7162.

## Result-compression unit test
`node bench/test-result-compression.mjs` — verifies `stripAnsi` / `normalizeWhitespace` / `dedupRepeatedLines` / `collapseSeparators` from `src/agent/orchestrator/tools/result-compression.mjs`.

## Trace analyzers
`node bench/trace-analyze.mjs` — pretty-print bridge-trace.jsonl events.
`node bench/trace-stats.mjs` — aggregate stats per role / model.

## Fixtures
`bridge-tasks.json`, `cycle-fixtures.json`, `cycle2-fixtures.json`, `queries.json` — input data for the harnesses above.

Output: `bench/results/<ISO>.json` (gitignored).
