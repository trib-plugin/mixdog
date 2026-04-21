---
description: Wipe all memory entries (requires explicit confirmation)
disable-model-invocation: true
allowed-tools: mcp__plugin_mixdog_mixdog__memory
---

This command permanently deletes every row in the memory `entries` table, including its FTS and vector index shadows.

Before calling the tool, ask the user to explicitly confirm deletion by replying with the exact phrase `DELETE ALL MEMORY` (or equivalent explicit consent in their language — but the phrase passed to the server must be exactly `DELETE ALL MEMORY`). Only after the user confirms, call the `mcp__plugin_mixdog_mixdog__memory` tool with `action="delete"` and `confirm="DELETE ALL MEMORY"`. Report the pre-delete row count from the tool result verbatim. If the user does not confirm, abort and tell them no data was deleted.
