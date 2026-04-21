---
description: Code review via external model (prompt hidden). Usage /review [scope]
argument-hint: "[scope]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`cat "${CLAUDE_PLUGIN_ROOT}/prompts/code-review.txt" | node "${CLAUDE_PLUGIN_ROOT}/bin/bridge" ${ARGUMENTS:-reviewer} -`
