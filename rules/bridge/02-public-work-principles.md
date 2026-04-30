# Public Work Principles

Common behavior for user-workflow bridge roles (the role set defined in `user-workflow.json`). Hidden retrieval roles follow `01-retrieval-role-principles.md` instead.

## Parallelism

Tool descriptions carry array / multi-form rules. The single discipline that spans turns: **two-turn read-then-edit pattern.** Turn 1 — all `read` calls in parallel. Turn 2 — all `edit` / `apply_patch` / `write` calls in parallel. Do not interleave reads and writes across turns.

## Reporting

- Final report shape: `file_path:line_number` references, one-line per finding, no tables / snippets / duplication. Concise and direct.
- State the verification result in one line (e.g. "syntax OK, 0 dead refs").
- If the work is partial or blocked, report what landed + the specific blocker. Don't paper over.

## Scope discipline

- Don't add features, abstractions, or error handling beyond what the task requires.
- A bug fix doesn't justify surrounding cleanup. A one-shot operation doesn't need a helper.
- Don't design for hypothetical future requirements. Three similar lines is better than a premature abstraction.

## Edit precision

- Don't add comments unless the WHY is non-obvious. Self-explanatory identifiers don't need restating.
- Don't add backwards-compatibility shims for code paths within your own change scope.
- Don't rewrite working code that is unrelated to the task.

## Result handling

- If a tool returns the answer or evidence enough to commit, do that next. Don't probe further.
- If the work is blocked or ambiguous, report partial findings + the specific blocker. Don't guess.
- Match the scope of the task — a one-line fix doesn't justify a refactor.

## Edit Ordering

Applies when the next move is `edit` or `apply_patch` AND the target span is not yet locked. **Locked = exact file path AND one or more uniquely-identified line ranges you can edit without re-reading.** (`write` for whole-file create/replace is exempt.)

- Identifier / function / class name known → `find_symbol` immediately. Do not start with `grep`→`read` when an identifier is in hand. For structural questions, pass `mode:"callers"` / `"references"` / `"imports"` / `"dependents"`.
- Cross-file refactor or mixed structural impact → `find_symbol` with `mode:"overview"` / `"impact"` / `"related"`.
- After two `grep`→`read` pairs on the same target without locking the span, the next move must be `find_symbol` / `explore` / `edit`, not a third `grep`→`read`.
- Once the span is locked, edit. Do not re-read the same file again.
- For 2+ files or 2+ hunks in one file, prefer `apply_patch` in one combined turn.

## bash specifics

- Shell work across turns: pass `persistent:true` to reuse state — don't replay setup in repeated one-shot calls.
- Long background command launched: `job_wait`, then `read` the stdout/stderr path for logs.
- Large tool outputs may be saved to a path with a preview; only `read` that path if the preview is insufficient.
