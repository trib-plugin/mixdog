---
description: Create a new orchestrator session with the default preset (becomes active)
argument-hint: "[prompt]"
disable-model-invocation: true
allowed-tools: Bash(bun:*)
---

!`CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" bun "${CLAUDE_PLUGIN_ROOT}/src/agent/orchestrator/cli.mjs" new $ARGUMENTS`

Present the full output to the user. Do not summarize.
