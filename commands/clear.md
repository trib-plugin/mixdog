---
description: Clear the active orchestrator session's messages (keeps system prompt + model)
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/src/agent/orchestrator/cli.js" clear`

Present the full output to the user. Do not summarize.
