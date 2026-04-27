# Public Work Principles

Common behavior for user-workflow bridge roles (the role set defined in `user-workflow.json`). Hidden retrieval roles follow `01-retrieval-role-principles.md` instead.

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
