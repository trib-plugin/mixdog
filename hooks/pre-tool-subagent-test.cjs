// PreToolUse subagent test - v0.0.81 verified
'use strict';
/**
 * Quick test: does PreToolUse fire for sub-agents?
 * Logs to a file and exits (no decision = no interference).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG = path.join(os.tmpdir(), 'mixdog', 'pre-tool-subagent-test.log');

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const line = [
      new Date().toISOString(),
      data.agent_id ? `agent=${data.agent_id}` : 'main',
      `sidechain=${!!data.is_sidechain}`,
      `tool=${data.tool_name}`,
      (data.tool_input && data.tool_input.file_path) || '',
    ].join(' | ');
    fs.appendFileSync(LOG, line + '\n');
  } catch {}
  // Exit without output = no decision, normal flow continues
  process.exit(0);
});
