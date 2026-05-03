Phase: {{PHASE}}

## Current active core

{{CORE_MEMORY}}

## Entries to Evaluate

{{ITEMS}}

Active count: {{ACTIVE_COUNT}} / cap: {{ACTIVE_CAP}}.

---
Merge candidates must share the same project_id. Do not merge entries with different project_id values.
Output format: one action per line, NO JSON, NO tool calls, NO prose, NO preamble. Format: `<entry_id>|<action>` (or `<entry_id>|update|<element>|<summary>` / `<entry_id>|merge|<target_id>|<source_ids_csv>|<element>|<summary>`). First character of your response must be a digit. Empty response (no lines) is valid when no action is needed.
