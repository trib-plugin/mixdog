# bench/

Probes and A/B harnesses. None auto-run.

## Reporting style A/B (task #21)

Measures whether the `Reporting style — final reply to Lead` section in
`rules/bridge/00-common.md` (added at 0.1.118) actually shortens worker
final replies.

```
node bench/reporting-style-ab.mjs                 # 3 runs per variant (default)
node bench/reporting-style-ab.mjs --repeats=5     # custom repeat count
```

Variants are defined under `ab_variants` on the `worker-reporting-style-ab`
fixture row in `bench/bridge-tasks.json`:

- `A_verbose_override` — bridge `context` injects an override that
  suspends the new section and forces the legacy verbose style.
- `B_current_rules` — no override; live rules apply.

Output: `bench/results/reporting-style-ab-<ISO>.json` plus a console
comparison table (replyChars / replyLines / verboseTotal / tokensOut /
iters / toolCalls / durationMs as `p50/p95`).
