---
description: Create a new orchestrator session with the default preset (becomes active)
argument-hint: "[prompt]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/src/agent/orchestrator/cli.js" new $ARGUMENTS`

Present the full output to the user. Do not summarize.
