---
description: Bridge to external model. Usage /bridge <role> <prompt>
argument-hint: "<role> <prompt>"
disable-model-invocation: true
allowed-tools: Bash(bun:*)
---

!`bun "${CLAUDE_PLUGIN_ROOT}/bin/bridge" $ARGUMENTS`
