/**
 * mixdog PostToolUse hook
 *
 * After any tool execution, drop a `tool-exec-{ts}-{rand}.signal` file into
 * RUNTIME_ROOT containing { toolName, ts }. Consumers:
 *   - channels worker (main-session permission flow): fs.watch matches oldest
 *     pendingPermRequest by toolName → edits Discord message to
 *     "Allowed (terminal)".
 *   - pre-tool-subagent.cjs (sub-agent permission flow): polls for signal
 *     files with matching toolName created after the hook started →
 *     treats as terminal approval and exits.
 *
 * Consumers only unlink the signal file when they claim it; stale files are
 * cleaned up by the channels worker's periodic sweep.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const RUNTIME_ROOT = path.join(os.tmpdir(), 'mixdog');

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  let toolName = '';
  let filePath = '';
  let toolUseId = '';
  try {
    if (input) {
      const payload = JSON.parse(input);
      toolName = payload?.tool_name || payload?.toolName || '';
      filePath = payload?.tool_input?.file_path || payload?.toolInput?.file_path || '';
      toolUseId = payload?.tool_use_id || payload?.toolUseId || '';
    }
  } catch { /* ignore parse errors */ }

  if (!toolName) { process.exit(0); return; }

  try {
    if (!fs.existsSync(RUNTIME_ROOT)) fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
  } catch { /* best-effort */ }

  try {
    const rand = crypto.randomBytes(4).toString('hex');
    const signalFile = path.join(RUNTIME_ROOT, `tool-exec-${Date.now()}-${rand}.signal`);
    fs.writeFileSync(signalFile, JSON.stringify({ toolName, filePath, toolUseId, ts: Date.now() }));
  } catch (err) {
    process.stderr.write(`[post-tool-use] Failed to write signal file: ${err.message}\n`);
  }

  process.exit(0);
});
