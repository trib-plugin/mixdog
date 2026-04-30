---
description: Code review via external model (prompt hidden). Usage /review [scope]
argument-hint: "[scope]"
disable-model-invocation: true
allowed-tools: Bash(bun:*)
---

!`cat "${CLAUDE_PLUGIN_ROOT}/prompts/code-review.txt" | bun "${CLAUDE_PLUGIN_ROOT}/bin/bridge" ${ARGUMENTS:-reviewer} -`
