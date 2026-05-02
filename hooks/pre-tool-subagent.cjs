'use strict';
/**
 * PreToolUse hook — Discord permission flow for sub-agents.
 *
 * PermissionRequest hooks don't fire for sub-agents (Claude Code bug #23983).
 * This hook intercepts sub-agent Edit/Write calls to protected paths
 * (anywhere inside $HOME but outside the session's cwd — see
 * isProtectedPath below) and runs the Discord approval flow directly.
 *
 * Unified signal-based flow (matches main session):
 *   1. POST Discord prompt with perm-{uuid}-{action} buttons.
 *   2. Poll runtime for:
 *      a. `perm-{instance}-{uuid}.result` — button click path (channels
 *         backend.onInteraction writes it on Discord interaction).
 *      b. `tool-exec-{ts}-{rand}.signal` with matching toolName created
 *         after this hook started — terminal approval path (post-tool-use
 *         writes it when the user approves in terminal).
 *   3. Any `.signal` match/claim UNLINKs the signal (so the main channels
 *      watcher doesn't also process it). Unmatched signals are left for the
 *      main watcher; stale ones are swept by the channels worker.
 *   4. On resolve/timeout, PATCH Discord to remove buttons.
 *
 * Main session / non-protected sub-agent: exit 0 (other paths handle it).
 */
if (process.env.MIXDOG_CHANNELS_NO_CONNECT) process.exit(0);

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { shouldRoutePermissionToDiscord } = require('./lib/permission-route.cjs');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);

const RUNTIME_ROOT = path.join(os.tmpdir(), 'mixdog');
try { fs.mkdirSync(RUNTIME_ROOT, { recursive: true }); } catch {}
const ACTIVE_INSTANCE_FILE = path.join(RUNTIME_ROOT, 'active-instance.json');
const SIGNAL_RE = /^tool-exec-(\d+)-[0-9a-f]+\.signal$/;

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function readActiveInstance() {
  try { return JSON.parse(fs.readFileSync(ACTIVE_INSTANCE_FILE, 'utf8')); } catch { return null; }
}

// Fast bailout: no Discord config → skip
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
  const hasToken = !!(cfg && cfg.discord && cfg.discord.token);
  const mainCh = cfg && cfg.channelsConfig && cfg.channelsConfig.main;
  const channelId = mainCh && (typeof mainCh === 'string' ? null : mainCh.channelId);
  if (!hasToken || !channelId) process.exit(0);
} catch { process.exit(0); }

const POLL_INTERVAL = 2000;
const TIMEOUT = 900000; // 15 minutes

function discordApi(method, apiPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: 'discord.com', path: apiPath, method, headers },
      res => { let out = ''; res.on('data', d => { out += d; }); res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({}); } }); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// B2: protected-path expansion. Previously only `/.claude/` triggered
// Discord approval; now any Edit/Write landing inside HOME but OUTSIDE
// the session's cwd is treated as protected. Matches the central path
// This hook applies the same HOME-outside-cwd policy to sub-agents by routing
// any such target through Discord (whose Session Allow button is the
// escape valve for workflows that actually need HOME writes).
function isProtectedPath(filePath, cwd) {
  if (!filePath) return false;
  const norm = path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
  const homeNorm = (process.env.HOME || process.env.USERPROFILE || '').replace(/\\/g, '/').toLowerCase();
  const cwdNorm = (cwd || process.cwd()).replace(/\\/g, '/').toLowerCase();
  if (!homeNorm) return false;
  // Inside HOME but outside cwd → protected (requires Discord approval).
  const insideHome = norm === homeNorm || norm.startsWith(homeNorm.endsWith('/') ? homeNorm : homeNorm + '/');
  const insideCwd = cwdNorm && (norm === cwdNorm || norm.startsWith(cwdNorm.endsWith('/') ? cwdNorm : cwdNorm + '/'));
  return insideHome && !insideCwd;
}

// Scan RUNTIME_ROOT for a signal file whose payload (toolName, filePath,
// toolUseId) matches and whose name timestamp is >= hookStartedAt. Returns
// the claimed file path (after unlink) or null. Only the first matching
// signal is consumed. toolUseId is optional: when falsy, matching falls
// back to (toolName, filePath).
function findAndClaimSignal(toolName, filePath, toolUseId, hookStartedAt) {
  let entries;
  try { entries = fs.readdirSync(RUNTIME_ROOT); } catch { return null; }
  for (const name of entries) {
    const m = SIGNAL_RE.exec(name);
    if (!m) continue;
    const ts = Number(m[1]);
    if (!Number.isFinite(ts) || ts < hookStartedAt) continue;
    const p = path.join(RUNTIME_ROOT, name);
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); } catch { continue; }
    let payload;
    try { payload = JSON.parse(raw); } catch { continue; }
    if (payload?.toolName !== toolName) continue;
    if (payload?.filePath !== filePath) continue;
    if (toolUseId && payload?.toolUseId !== toolUseId) continue;
    try { fs.unlinkSync(p); } catch {}
    return p;
  }
  return null;
}

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(input);

    const mode = data.permissionMode || data.permission_mode || data.mode;
    if (mode === 'bypassPermissions' || mode === 'auto') process.exit(0);

    const isSidechain = data.isSidechain ?? data.is_sidechain;
    const agentIdRaw = data.agentId ?? data.agent_id;
    const toolInput = data.tool_input ?? data.toolInput ?? {};

    const isSubagent = isSidechain === true || Boolean(agentIdRaw);
    if (!isSubagent) process.exit(0);
    const agentId = agentIdRaw || 'unknown';

    const toolName = data.tool_name || '';
    if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') process.exit(0);

    const filePath = toolInput.file_path || '';
    // Resolve the session cwd: hook payload carries it on newer Claude Code
    // builds (`data.cwd` or `data.tool_input.cwd`); older builds omit it, in
    // which case process.cwd() is the correct fallback (the hook runs inside
    // the same working directory as the session).
    const hookCwd = data.cwd || toolInput.cwd || process.cwd();
    if (!isProtectedPath(filePath, hookCwd)) process.exit(0);

    const toolUseId = data.tool_use_id ?? data.toolUseId ?? '';

    const route = shouldRoutePermissionToDiscord();
    if (route.route !== 'discord') process.exit(0);

    const configPath = path.join(DATA_DIR, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const token = config.discord && config.discord.token;
    if (!token) process.exit(0);
    const mainCh = config.channelsConfig && config.channelsConfig.main;
    const channelId = mainCh && (typeof mainCh === 'string' ? null : mainCh.channelId);
    if (!channelId) process.exit(0);

    const uuid = crypto.randomBytes(16).toString('hex');
    const active = readActiveInstance();
    if (!active || !active.instanceId) process.exit(0);
    const instanceId = sanitize(active.instanceId);
    const resultFile = path.join(RUNTIME_ROOT, `perm-${instanceId}-${uuid}.result`);

    let detail = '';
    if (toolName === 'Edit') {
      detail = filePath + '\n' + (toolInput.old_string || '').substring(0, 200);
    } else {
      detail = filePath;
    }
    const content = `🔐 **Sub-agent Permission**\nAgent: \`${agentId}\`\nTool: \`${toolName}\`\n\`\`\`\n${detail}\n\`\`\``;

    const body = {
      content,
      components: [{
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Allow', custom_id: 'perm-' + uuid + '-allow' },
          { type: 2, style: 1, label: 'Session Allow', custom_id: 'perm-' + uuid + '-session' },
          { type: 2, style: 4, label: 'Deny', custom_id: 'perm-' + uuid + '-deny' },
        ]
      }]
    };

    const msgResult = await discordApi('POST', '/api/v10/channels/' + channelId + '/messages', token, body);
    const messageId = msgResult.id;
    if (!messageId) process.exit(0);

    const hookStartedAt = Date.now();

    const patchAndExit = async (suffix, decisionJson) => {
      if (messageId) {
        await discordApi('PATCH', '/api/v10/channels/' + channelId + '/messages/' + messageId, token, {
          content: content + suffix,
          components: []
        }).catch(() => {});
      }
      try { fs.unlinkSync(resultFile); } catch {}
      if (decisionJson) process.stdout.write(JSON.stringify(decisionJson));
      process.exit(0);
    };

    process.on('SIGTERM', () => {
      // Best-effort PATCH; don't await since the process may be killed hard.
      discordApi('PATCH', '/api/v10/channels/' + channelId + '/messages/' + messageId, token, {
        content: content + '\n\n↩️ Resolved from terminal.',
        components: []
      }).catch(() => {});
      try { fs.unlinkSync(resultFile); } catch {}
      process.exit(0);
    });

    const startTime = Date.now();
    while (Date.now() - startTime < TIMEOUT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));

      // Button-click path
      if (fs.existsSync(resultFile)) {
        let decision;
        try {
          const result = fs.readFileSync(resultFile, 'utf8').trim();
          if (result === 'allow' || result === 'session') {
            decision = { hookSpecificOutput: { hookEventName: 'PreToolUse', decision: 'allow' } };
          } else {
            decision = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Denied from Discord' } };
          }
        } catch {
          decision = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Failed to read result' } };
        }
        await patchAndExit('', decision);
        return;
      }

      // Terminal-approval path: signal file from post-tool-use with matching
      // (toolName, filePath, toolUseId) — toolUseId optional.
      const claimed = findAndClaimSignal(toolName, filePath, toolUseId, hookStartedAt);
      if (claimed) {
        await patchAndExit('\n\n↩️ Resolved from terminal.', null);
        return;
      }
    }

    // Timeout → deny
    await patchAndExit(
      '\n\n⚠️ Auto-denied due to timeout.',
      { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Timeout' } }
    );
  } catch {
    process.exit(0);
  }
});
