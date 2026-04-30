---
description: Security audit via external model (prompt hidden). Usage /security [scope]
argument-hint: "[scope]"
disable-model-invocation: true
allowed-tools: Bash(bun:*)
---

!`cat "${CLAUDE_PLUGIN_ROOT}/prompts/security-audit.txt" | bun "${CLAUDE_PLUGIN_ROOT}/bin/bridge" ${ARGUMENTS:-reviewer} -`
