'use strict';

// Per-turn latency logger. Opt-in via MIXDOG_PERF=1.
// Usage: `node turn-timer.cjs start` on UserPromptSubmit,
//        `node turn-timer.cjs stop`  on Stop.
// Writes one JSON line per completed turn to ${CLAUDE_PLUGIN_DATA}/perf.log.

if (!process.env.MIXDOG_PERF) process.exit(0);

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK_ENTERED_AT = Date.now();

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch {}
let ev = {};
try { ev = raw ? JSON.parse(raw) : {}; } catch {}

if (ev.isSidechain) process.exit(0);

const mode = process.argv[2] || '';
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);

const RUNTIME = path.join(os.tmpdir(), 'mixdog');
try { fs.mkdirSync(RUNTIME, { recursive: true }); } catch {}
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const sessionId = ev.session_id || ev.sessionId || 'unknown';
const markFile = path.join(RUNTIME, `turn-${sessionId}.mark`);
const logFile = path.join(DATA_DIR, 'perf.log');
const now = Date.now();

function appendLine(obj) {
  try {
    fs.appendFileSync(logFile, JSON.stringify(obj) + '\n');
  } catch (e) {
    process.stderr.write(`[turn-timer] append failed: ${e.message}\n`);
  }
}

if (mode === 'start') {
  try {
    fs.writeFileSync(markFile, JSON.stringify({ t: now, session: sessionId }));
  } catch (e) {
    process.stderr.write(`[turn-timer] mark failed: ${e.message}\n`);
  }
  appendLine({
    kind: 'start',
    ts: new Date(now).toISOString(),
    session: sessionId,
    hook_ms: Date.now() - HOOK_ENTERED_AT,
  });
} else if (mode === 'stop') {
  let startTs = null;
  try {
    const m = JSON.parse(fs.readFileSync(markFile, 'utf8'));
    startTs = m.t;
    fs.unlinkSync(markFile);
  } catch {}
  appendLine({
    kind: 'stop',
    ts: new Date(now).toISOString(),
    session: sessionId,
    duration_ms: startTs ? now - startTs : null,
    stop_reason: ev.stop_reason || null,
    hook_ms: Date.now() - HOOK_ENTERED_AT,
  });
}

process.exit(0);
