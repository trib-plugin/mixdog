---
description: Security audit via external model (prompt hidden). Usage /security [scope]
argument-hint: "[scope]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`cat "${CLAUDE_PLUGIN_ROOT}/prompts/security-audit.txt" | node "${CLAUDE_PLUGIN_ROOT}/bin/bridge" ${ARGUMENTS:-reviewer} -`
