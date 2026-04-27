# Bridge Tool Patterns

Direct-tool patterns for bridge agents (worker / reviewer / debugger / tester / hidden retrieval roles). Lead works through ToolSearch + bridge delegation, so this section does not apply to the main session.

## Edit Ordering

Applies when the next move is `edit` or `apply_patch` AND the target span is not yet locked. **Locked = exact file path AND a unique line range you can edit without re-reading.** (`write` for whole-file create/replace is exempt — no line range to lock.) Edit Ordering overrides the Decision Table for edits with unknown target spans.

- Identifier / function / class name known → `find_symbol` immediately. Do not start with a `grep`→`read` pair when an identifier is in hand. For specific structural questions, use the direct alias instead: `find_callers`, `find_references`, `find_imports`, `find_dependents`.
- Cross-file refactor, multi-symbol change, or mixed structural impact → `code_graph`.
- After two `grep`→`read` pairs **on the same target** — same intended edit area, or the same requirement pointing at that area, even if the keywords differ (e.g. `grep "fooHandler"` → `grep "handle_foo"` on the same goal still counts) — without the target span being **Locked** (definition above: exact file path AND a unique line range you can edit without re-reading), a third pair is the violation. Switch tool family (`find_symbol` / `code_graph`) or commit to the edit only if the span now meets the **Locked** definition — that exact file path and unique line range are uniquely inferable from evidence already gathered, equivalent to having read it directly. Same threshold as the corresponding Anti-pattern.
  - Tiny example: `grep X → read A`, then `grep X-variant → read A` (or A+B) = two pairs; the next move must be `find_symbol` / `code_graph` / `edit`, not a third `grep`→`read`.
- Once the span is locked, edit. Do not re-read the same file again.
- For edits across multiple files, prefer `apply_patch` in one combined turn over looping `read` → `edit`.

## Decision Table

Use these rules regardless of the current role name. Role-specific prompts may add nuance, but the first tool choice should follow this table unless the user explicitly asks otherwise.

> **Edit precedence:** when the next move is `edit` / `apply_patch` and the target span is not yet locked, the **Edit Ordering** section above takes precedence over this table. The table applies once the span is locked or for non-edit lookups.

| Query shape                                       | First tool                                          |
|---------------------------------------------------|-----------------------------------------------------|
| identifier name known, file unknown               | `find_symbol`                                       |
| imports of a file                                 | `find_imports`                                      |
| dependents of a file                              | `find_dependents`                                   |
| callers of a symbol                               | `find_callers`                                      |
| references of a symbol                            | `find_references`                                   |
| broader structural graph / impact / mixed graph   | `code_graph`                                        |
| file path known                                   | `read`                                              |
| 2+ known file paths                               | one `read` with `path` as array                     |
| 2+ whole files to create/replace                  | `write` with `writes` array                         |
| broad text / regex / config phrase lookup         | `grep`                                              |
| filename pattern discovery                        | `glob`                                              |
| directory shape / recent files / mtime clues      | `list`                                              |
| external docs / GitHub / web                      | `search`                                            |
| past project / session memory                     | `recall`                                            |
| exact edit across multiple files                  | `apply_patch`                                       |
| small local replacement in one file               | `edit`                                              |
| shell state needed across turns                   | `bash` with `persistent:true`                       |
| long background command launched                  | `job_wait`, then `read` the stdout/stderr path      |

## Anti-patterns

- Do not call `find_symbol` and `grep` for the same identifier in the same round unless `find_symbol` returned no declaration candidate.
- Do not serially `read` files one by one when the candidate list is already known.
- Do not serially `write` several whole files when one call with a `writes` array can do it.
- Do not `read` a whole large file when `find_symbol`, `code_graph`, or `grep` can narrow the line window first.
- Do not loop `grep`→`read` past two pairs (one locate + one confirm) on the same target — a third same-target pair is the violation. Switch tool family (`find_symbol`, `code_graph`, `explore`) or commit to the edit / answer with the evidence already gathered.
- Do not chain 10+ `grep` + `read` calls in one session without a `find_symbol` / `code_graph` call. Identifier-aware tools should appear within the first 2 rounds when the work involves an `edit`.
- Do not use `bash` with `ls` / `cat` / `find` / `head` / `tail` / `grep` for file or code lookup — that is a rule violation. `bash` is shell-only work (git, build, test, run).

## Heeding soft-warns

When a tool result begins with a `⚠ … soft-warn` marker, treat it as a self-enforced halt: the runtime won't stop you, you must stop yourself. Aborts only fire at the per-axis ceiling (100), which is far away — that is not a license to grind, it is the reason this rule exists.

### Per-marker response

- `⚠ Tool-loop soft-warn` — same call returned the same result/error 4× in a row.
  → **Stop the exact retry.** The signature (tool + args + error class) won't change by repeating. Change inputs *semantically* (different scope or different question, not just reworded) or switch tools.
- `⚠ Repeated-tool soft-warn` — the same tool has been called many times in this session.
  → **Batch or switch family.** Combine outstanding queries into one array-form call, or hand off to a *different family*. Three families: low-level file (`read` / `grep` / `glob` / `list`), structural (`find_symbol` / `code_graph` / `find_callers` / `find_references`), synthesized retrieval (`explore` / `recall` / `search`). Switching within one family does not count.
- `⚠ Mixed-tool soft-warn` — many consecutive low-level lookups across `read` / `grep` / `glob` / `list` without a productive call. ("Productive" = the call narrowed the scope — locked a file+line range, identified a symbol, or eliminated candidates. Mere hits without progress don't count.)
  → **Jump up.** `find_symbol` / `code_graph` / `explore` for one decisive pass; or commit to the edit if the target is already locked.
- `⚠ Tool-budget soft-warn` — total tool calls in this session are getting high.
  → **Truncate scope.** Synthesize what you have, report partial findings honestly, and stop *new investigation threads*. Wrap up the current edit / answer; do not expand into adjacent questions or open a new probe.

### General rules (apply to every marker)

- **Synthesize first if possible.** If the evidence already gathered is enough to answer or commit to the edit, do that next — the cleanest exit.
- **Do not paraphrase and retry.** A near-identical follow-up call after a soft-warn is itself a violation.
- **No evidence yet?** If the warn fires before anything actionable was found (rare — usually means session-history pressure, not this turn's probes), report what was attempted and ask the user for direction. Do not guess.
- **Warning fired on a high-level tool itself?** (`recall` / `search` / `explore` repeats triggering `Repeated-tool` or `Tool-budget`.) Switching down to `read` / `grep` is a valid switch — but only with a known path or literal pattern. Otherwise, surface the partial result and ask.

### Second warn

If the same marker fires a second time in this session — your first response did not work. Do not repeat the same recovery move. Stop the current line of work, report what you have plus what failed, and hand back to the user.
