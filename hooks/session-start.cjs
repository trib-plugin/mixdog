'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { DatabaseSync } = require('../lib/sqlite-bridge.cjs');
const { resolvePluginData } = require(path.join(__dirname, '..', 'lib', 'plugin-paths.cjs'));

// Mirror selected stderr lines to a plugin-data log file so cycle1 traces
// remain inspectable after the host shell scrolls past. Best-effort: any
// fs error is swallowed so logging never breaks the hook.
let _SESSION_START_LOG_PATH = null;
function sessionStartLogPath() {
  if (_SESSION_START_LOG_PATH) return _SESSION_START_LOG_PATH;
  const base = (typeof DATA_DIR === 'string' && DATA_DIR)
    ? DATA_DIR
    : path.join(os.homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin');
  _SESSION_START_LOG_PATH = path.join(base, 'session-start.log');
  return _SESSION_START_LOG_PATH;
}
function teeStderr(line) {
  process.stderr.write(line);
  try {
    const p = sessionStartLogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, line);
  } catch {}
}

// ---------------------------------------------------------------------------
// argv parsing — supports `--part rules`, `--part=rules`.
// Invalid/unknown part falls back to `rules`.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { part: 'rules' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    let key = null;
    let val = null;
    if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else if (a.startsWith('--')) {
      key = a.slice(2);
      const next = argv[i + 1];
      if (typeof next === 'string' && !next.startsWith('--')) {
        val = next;
        i++;
      }
    }
    if (key === 'part' && typeof val === 'string') out.part = val;
  }
  if (!['rules', 'core', 'recap'].includes(out.part)) out.part = 'rules';
  return out;
}

const ARGS = parseArgs(process.argv);
const PART = ARGS.part;

let _event = {};
try {
  const _input = fs.readFileSync(0, 'utf8');
  if (_input) _event = JSON.parse(_input);
} catch {}

if (_event.isSidechain) process.exit(0);
if (_event.agentId) process.exit(0);
if (_event.kind && _event.kind !== 'interactive') process.exit(0);

const DATA_DIR = resolvePluginData();
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;
if (!DATA_DIR || !PLUGIN_ROOT) process.exit(0);

// ---------------------------------------------------------------------------
// Common helpers (used by all parts).
// ---------------------------------------------------------------------------
function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

function emit(additionalContext) {
  if (!additionalContext) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }));
}

function openMemoryDb() {
  try {
    const dbPath = path.join(DATA_DIR, 'memory.sqlite');
    if (!fs.existsSync(dbPath)) return null;
    // WAL is already pinned to the file by src/memory/lib/memory.mjs init.
    // Apply busy_timeout per-connection so concurrent SessionStart hooks
    // (5 recap slots fire within ~23ms) wait briefly instead of failing
    // immediately when a writer holds the lock during checkpoint.
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout = 2000'); } catch {}
    return db;
  } catch (e) {
    process.stderr.write(`[session-start] open memory.sqlite failed: ${e.message}\n`);
    return null;
  }
}

function formatTs(ts) {
  const n = Number(ts);
  if (Number.isFinite(n) && n > 1e12) {
    return new Date(n).toLocaleString('sv-SE').slice(0, 16);
  }
  return String(ts ?? '').slice(0, 16);
}

// MM-DD HH:MM in local time for compact recap rendering.
function formatTsShort(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 1e12) return String(ts ?? '').slice(0, 16);
  const full = new Date(n).toLocaleString('sv-SE');
  return full.slice(5, 16);
}

// Single source of truth: lib/text-utils.cjs (also imported by memory-extraction.mjs).
const { cleanMemoryText: cleanText } = require(path.join(PLUGIN_ROOT, 'lib', 'text-utils.cjs'));

function buildContext(db) {
  try {
    const rows = db.prepare(`
      SELECT element, category, summary
      FROM entries
      WHERE is_root = 1 AND status = 'active'
      ORDER BY score DESC, last_seen_at DESC
    `).all();
    if (rows.length === 0) return '';
    const lines = rows
      .map(r => String(r.summary || '').trim())
      .filter(Boolean);
    if (lines.length === 0) return '';
    return `## Core Memory\n${lines.join('\n')}`;
  } catch (e) {
    process.stderr.write(`[session-start] context build failed: ${e.message}\n`);
    return '';
  }
}

// Returns { lines } — chronological "[MM-DD HH:MM] <summary>" entries
// (oldest → newest), trimmed from the front so the rendered block fits the
// SessionStart hook output cap (10,000 chars total — leaves margin for the
// JSON wrapper around additionalContext; header "## Recap\n" reserved).
function buildRecapData(db) {
  const out = { lines: [] };
  try {
    const rows = db.prepare(`
      SELECT id, ts, summary
      FROM entries
      WHERE is_root = 1
      ORDER BY ts DESC, id DESC
      LIMIT 20
    `).all();
    if (rows.length === 0) return out;

    const rendered = rows.map(r => {
      const tsStr = formatTsShort(r.ts);
      const summary = String(r.summary || '').trim().slice(0, 1000);
      return summary ? `[${tsStr}] ${summary}` : '';
    }).filter(Boolean);
    if (rendered.length === 0) return out;

    // Dedup by normalized summary — newest-first, so older repeats drop.
    const seen = new Set();
    const uniq = [];
    for (const line of rendered) {
      const key = line.replace(/^\[[^\]]+\]\s*/, '').toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(line);
    }

    // Newest → oldest; keep accumulating from the newest end until the
    // running total would exceed the cap, then reverse to chronological.
    const HEADER_LEN = '## Recap\n'.length;
    const CAP = 5000;
    let total = HEADER_LEN;
    const kept = [];
    for (const line of uniq) {
      const add = line.length + 1;
      if (total + add > CAP) break;
      kept.push(line);
      total += add;
    }
    out.lines = kept.reverse();
    return out;
  } catch (e) {
    process.stderr.write(`[session-start] recap build failed: ${e.message}\n`);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Skip flag — resume / compact reuses the existing context, so re-injecting
// memory just bloats tokens. Rules still flow through so any rule changes
// since the last turn take effect.
// ---------------------------------------------------------------------------
const skipMemoryInject = _event.source === 'resume' || _event.source === 'compact';

// ---------------------------------------------------------------------------
// Part: rules (slot 1) — owns ALL one-shot session bootstrap work and emits
// the rules block. Static .md content only; cycle1 is triggered by
// core/recap slots (dedupe coalesces concurrent calls into one run).
// ---------------------------------------------------------------------------
function ensurePromptInjectionConfig() {
  const cfgPath = path.join(DATA_DIR, 'config.json');
  if (fs.existsSync(cfgPath)) return;
  try {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({
      promptInjection: {
        mode: 'claude_md',
        targetPath: '~/.claude/CLAUDE.md',
      },
    }, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(`[session-start] config seed failed: ${e.message}\n`);
  }
}

function hasManagedClaudeMdBlock(targetPath) {
  if (!targetPath) return false;
  try {
    const { expandHome, MARKER_START, MARKER_END } = require(path.join(PLUGIN_ROOT, 'lib', 'claude-md-writer.cjs'));
    const resolved = expandHome(targetPath);
    if (!resolved || !fs.existsSync(resolved)) return false;
    const content = fs.readFileSync(resolved, 'utf8');
    return content.includes(MARKER_START) && content.includes(MARKER_END);
  } catch {
    return false;
  }
}

function resolveStatusLineCommand(_pluginRoot, scriptPath) {
  return `bash "${scriptPath}"`;
}

function injectStatusLine(pluginRoot) {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let raw;
    try { raw = fs.readFileSync(settingsPath, 'utf8'); } catch { return; }
    let settings;
    try { settings = JSON.parse(raw); } catch { return; }
    if (!settings || typeof settings !== 'object') return;

    const scriptPath = path.join(pluginRoot, 'bin', 'statusline.sh').replace(/\\/g, '/');
    const desiredCommand = resolveStatusLineCommand(pluginRoot, scriptPath);
    const desiredRefreshInterval = 2;
    const existing = settings.statusLine;
    const isOurs = existing && typeof existing === 'object' && existing.source === 'mixdog-auto';

    if (existing && !isOurs) return;
    if (
      isOurs
      && existing.command === desiredCommand
      && existing.type === 'command'
      && existing.refreshInterval === desiredRefreshInterval
    ) return;

    settings.statusLine = {
      type: 'command',
      command: desiredCommand,
      refreshInterval: desiredRefreshInterval,
      source: 'mixdog-auto',
    };

    const tmpPath = settingsPath + '.mixdog-tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmpPath, settingsPath);
  } catch (e) {
    process.stderr.write(`[session-start] statusLine inject failed: ${e.message}\n`);
  }
}

function cwdToProjectSlug(cwd) {
  return path.resolve(cwd).replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1-').replace(/\//g, '-');
}
function resolveTranscriptPath() {
  const direct = _event.transcript_path || _event.transcriptPath;
  if (typeof direct === 'string' && direct && fs.existsSync(direct)) return direct;
  const sessionId = _event.session_id || _event.sessionId;
  const cwd = _event.cwd || process.cwd();
  if (typeof sessionId === 'string' && sessionId) {
    const candidate = path.join(os.homedir(), '.claude', 'projects', cwdToProjectSlug(cwd), `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function rebindActiveInstance() {
  try {
    const activePath = path.join(os.tmpdir(), 'mixdog', 'active-instance.json');
    if (!fs.existsSync(activePath)) return;
    const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
    if (!active.httpPort) return;
    const transcriptPath = resolveTranscriptPath();
    const payload = transcriptPath ? JSON.stringify({ transcriptPath }) : '';
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req2 = http.request({
      hostname: '127.0.0.1',
      port: active.httpPort,
      path: '/rebind',
      method: 'POST',
      timeout: 3000,
      headers,
    });
    req2.on('error', () => {});
    req2.on('timeout', () => req2.destroy());
    if (payload) req2.write(payload);
    req2.end();
  } catch {}
}

// TCP probe — resolves true if the port accepts a connection within probeMs,
// false on ECONNREFUSED / EHOSTUNREACH / timeout / any other socket error.
// Used by pollActiveInstance to skip stale active-instance.json entries left
// over from a previous session whose channels owner is already dead.
function probeTcpPort(port, probeMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (alive) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(alive);
    };
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.setTimeout(Math.max(1, probeMs));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

async function pollActiveInstance(graceMs) {
  const activePath = path.join(os.tmpdir(), 'mixdog', 'active-instance.json');
  const deadline = Date.now() + Math.max(0, graceMs);
  // 25ms cadence with immediate first probe — closes the gap between
  // active-instance.json appearing and hook detecting it. Each
  // sleep / probe duration is clamped to the remaining deadline so
  // the loop honors graceMs precisely (without clamping a fresh
  // 25ms sleep + 200ms probe near deadline can overrun by ~225ms).
  let first = true;
  while (Date.now() <= deadline) {
    if (!first) {
      const sleepMs = Math.min(25, deadline - Date.now());
      if (sleepMs <= 0) break;
      await new Promise((r) => setTimeout(r, sleepMs));
      if (Date.now() > deadline) break;
    }
    first = false;
    try {
      if (fs.existsSync(activePath)) {
        const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
        if (active && active.httpPort) {
          // Stale guard: previous session may have left active-instance.json
          // behind with a port whose owner is already dead. TCP-probe it
          // briefly; only return when something actually accepts a
          // connection. Otherwise keep polling so a freshly-booting owner
          // can register and be picked up.
          const probeMs = Math.min(200, deadline - Date.now());
          if (probeMs <= 0) break;
          const alive = await probeTcpPort(active.httpPort, probeMs);
          if (alive) return active;
        }
      }
    } catch {}
  }
  return null;
}

function httpPostJson({ hostname, port, path: urlPath, timeoutMs, body }) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      hostname,
      port,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: Math.max(1, timeoutMs),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end(payload);
  });
}

// Pull cycle1 signals from a cycle1 response. Memory worker returns an MCP
// envelope { content:[{type:'text', text:'cycle1: chunks=N processed=M
// skipped=K pending=P inFlight=B'}], isError }; channels owner returns
// { ok, result } where result may carry the same text shape. Each field is
// null when not parseable (treated downstream as "unknown / cannot verify").
function extractCycleSignals(parsed) {
  const empty = { processed: null, pendingRows: null, skippedInFlight: null };
  if (!parsed) return empty;
  let text = '';
  if (Array.isArray(parsed.content) && parsed.content[0] && typeof parsed.content[0].text === 'string') {
    text = parsed.content[0].text;
  } else if (parsed.result && typeof parsed.result === 'object'
             && Array.isArray(parsed.result.content)
             && parsed.result.content[0]
             && typeof parsed.result.content[0].text === 'string') {
    // Channels owner wraps the memory worker's MCP envelope as
    // { ok, result: { content:[{type:'text',text:'cycle1: ...'}], isError } },
    // so the signal text lives at parsed.result.content[0].text.
    text = parsed.result.content[0].text;
  } else if (parsed.result && typeof parsed.result === 'object' && typeof parsed.result.text === 'string') {
    text = parsed.result.text;
  } else if (typeof parsed.result === 'string') {
    text = parsed.result;
  }
  if (typeof text !== 'string') return empty;
  const proc = text.match(/processed=(\d+)/);
  const pend = text.match(/pending=(\d+)/);
  const inflight = text.match(/inFlight=(true|false)/);
  return {
    processed: proc ? parseInt(proc[1], 10) : null,
    pendingRows: pend ? parseInt(pend[1], 10) : null,
    skippedInFlight: inflight ? inflight[1] === 'true' : null,
  };
}

// One full cycle1 attempt via the channels owner. Waits for
// active-instance.json (TCP-probed for a live owner via pollActiveInstance)
// up to graceMs, then POSTs /cycle1. The active-instance polling is the
// single readiness signal; no separate memory-direct port file path.
async function requestCycle1Once(deadline, opts) {
  const slot = opts.slot || 'unknown';
  const graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : 5000;
  const start = Date.now();

  const finish = (payload) => {
    const elapsedMs = Date.now() - start;
    if (payload.ok) {
      const procStr = payload.processed != null ? payload.processed : '?';
      const pendStr = payload.pendingRows != null ? payload.pendingRows : '?';
      const inFlightStr = payload.skippedInFlight === true ? 'true'
        : payload.skippedInFlight === false ? 'false' : '?';
      teeStderr(`[session-start] cycle1 slot=${slot} route=channels reason=ok processed=${procStr} pending=${pendStr} inFlight=${inFlightStr} elapsed=${elapsedMs}ms\n`);
      return {
        ok: true,
        processed: payload.processed,
        pendingRows: payload.pendingRows,
        skippedInFlight: payload.skippedInFlight,
        route: 'channels',
        elapsedMs,
      };
    }
    const sc = payload.statusCode != null ? ` statusCode=${payload.statusCode}` : '';
    teeStderr(`[session-start] cycle1 slot=${slot} route=channels reason=${payload.reason}${sc} elapsed=${elapsedMs}ms\n`);
    return { ok: false, reason: payload.reason, statusCode: payload.statusCode, bodyReason: payload.bodyReason || null, elapsedMs, route: 'channels' };
  };

  const classifyError = (e) => {
    const msg = (e && e.message) || '';
    if (/timeout/i.test(msg)) return 'timeout';
    if ((e && e.code === 'ECONNREFUSED') || /ECONNREFUSED/i.test(msg)) return 'connect-refused';
    return 'http-error';
  };

  const remainingForGrace = deadline - Date.now();
  if (remainingForGrace <= 0) return finish({ ok: false, reason: 'timeout' });
  const active = await pollActiveInstance(Math.min(graceMs, remainingForGrace));
  const tPollEnd = Date.now();
  if (!active) {
    const reason = (Date.now() >= deadline) ? 'timeout' : 'no-active-instance';
    return finish({ ok: false, reason });
  }
  const port = active.httpPort;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return finish({ ok: false, reason: 'timeout' });

  try {
    const tPostStart = Date.now();
    const res = await httpPostJson({
      hostname: '127.0.0.1',
      port,
      path: '/cycle1',
      timeoutMs: remaining,
      // On-demand path: 1 row is enough to enter; cap fan-out at 5 windows
      // of 20 rows each (≤100 rows total). Smaller windows than the periodic
      // path (50/window) shorten max(window_t) since output token volume is
      // the dominant latency component for cycle1.
      body: { timeout_ms: remaining, args: { min_batch: 1, session_cap: 5, batch_size: 20 } },
    });
    teeStderr(`[session-start] cycle1 slot=${slot} timing pollMs=${tPollEnd - start} postMs=${Date.now() - tPostStart}\n`);
    if (res.statusCode !== 200) {
      // Surface the channels endpoint's body `reason` (memory-not-ready,
      // worker-unavailable, ipc-error, memory-timeout, ...) so downstream
      // retry logic and operators can see the precise transient class.
      let bodyReason = null;
      try {
        const parsed = JSON.parse(res.body);
        if (parsed && typeof parsed.reason === 'string') bodyReason = parsed.reason;
      } catch {}
      const reason = bodyReason ? `non-200/${bodyReason}` : 'non-200';
      return finish({ ok: false, reason, statusCode: res.statusCode, bodyReason });
    }
    try {
      const parsed = JSON.parse(res.body);
      if (parsed && parsed.ok) {
        const sig = extractCycleSignals(parsed);
        return finish({
          ok: true,
          processed: sig.processed,
          pendingRows: sig.pendingRows,
          skippedInFlight: sig.skippedInFlight,
        });
      }
      return finish({ ok: false, reason: 'body-not-ok', statusCode: 200 });
    } catch {
      return finish({ ok: false, reason: 'parse-error', statusCode: 200 });
    }
  } catch (e) {
    return finish({ ok: false, reason: classifyError(e) });
  }
}

// Public entry point. Single in-flight call — server-main.callWorker now
// awaits the worker's first 'ready' IPC, so a pre-ready /cycle1 holds until
// memory is up instead of bouncing 503. Keep one follow-up retry for the
// processed=0 case: that means either an in-flight dedup hit (server
// returned the prior run's empty result) or a pre-ingest race
// (transcript-watch had not yet ingested pending raw entries). A short sleep
// + second call covers both. If the second pass also returns 0, genuinely
// empty.
async function requestCycle1(timeoutMs, opts = {}) {
  const slot = opts.slot || 'unknown';
  const graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : 5000;
  const start = Date.now();
  const deadline = start + Math.max(0, timeoutMs);
  teeStderr(`[session-start] cycle1 slot=${slot} start graceMs=${graceMs} timeoutMs=${timeoutMs}\n`);
  teeStderr(`[boot-time] tag=cycle1-entry slot=${slot} tMs=${start}\n`);

  // Boot-race transient classifier: a fresh session can fire cycle1 while the
  // new owner's channels worker is still binding 3462 (connect-refused), the
  // active-instance.json is briefly empty (no-active-instance), or channels is
  // up but the parent's memory worker hasn't sent its first 'ready' IPC yet
  // (503 with bodyReason in {memory-not-ready, worker-unavailable, ipc-error,
  // memory-timeout}). All of these resolve within 1–3s of boot, so retry with
  // a short backoff up to a small budget rather than skipping recap entirely.
  const TRANSIENT_BOOT_BODY_REASONS = new Set([
    'memory-not-ready',
    'worker-unavailable',
    'ipc-error',
    'memory-timeout',
    'backend-not-ready',
    'beacon-booting',
  ]);
  const TRANSIENT_TOP_REASONS = new Set([
    'connect-refused',
    'no-active-instance',
  ]);
  const isTransientBootFailure = (r) => {
    if (!r || r.ok) return false;
    if (r.bodyReason && TRANSIENT_BOOT_BODY_REASONS.has(r.bodyReason)) return true;
    if (TRANSIENT_TOP_REASONS.has(r.reason)) return true;
    // 503 + missing body — boot-race before stub JSON; treat as transient.
    if (r.statusCode === 503 && !r.bodyReason) return true;
    return false;
  };
  const TRANSIENT_RETRY_DELAY_MS = 250;
  const TRANSIENT_RETRY_BUDGET_MS = 8000;
  const transientDeadline = start + TRANSIENT_RETRY_BUDGET_MS;

  try {
    let r1 = await requestCycle1Once(deadline, opts);
    let transientAttempt = 0;
    while (
      isTransientBootFailure(r1)
      && Date.now() < transientDeadline
      && (deadline - Date.now()) > TRANSIENT_RETRY_DELAY_MS + 500
    ) {
      transientAttempt++;
      teeStderr(`[session-start] cycle1 slot=${slot} transient-retry attempt=${transientAttempt} reason=${r1.reason}\n`);
      await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_DELAY_MS));
      r1 = await requestCycle1Once(deadline, { ...opts, slot: `${slot}:t${transientAttempt}` });
    }
    if (!r1.ok) return r1;
    if (r1.processed != null && r1.processed > 0) return r1;
    // Genuine empty (no pending raw rows AND no in-flight dedup hit) — retry
    // would do nothing useful, skip the second pass.
    if (r1.pendingRows === 0 && r1.skippedInFlight === false) return r1;
    const RETRY_DELAY_MS = 800;
    const remaining = deadline - Date.now();
    if (remaining <= RETRY_DELAY_MS + 200) return r1;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    const r2 = await requestCycle1Once(deadline, { ...opts, slot: `${slot}:r` });
    return r2.ok ? r2 : r1;
  } catch (e) {
    teeStderr(`[session-start] cycle1 slot=${slot} exception=${(e && e.message) || e}\n`);
    return { ok: false, reason: 'exception', elapsedMs: Date.now() - start };
  }
}

// Best-effort POST /recap/reset to the channels owner. Used on `/clear` so
// the forked status server's recapState (which lives in a child process the
// hook can't reach via IPC) drops the prior session's badge. Bounded by
// graceMs and silent on failure — recap reset is cosmetic, never block
// SessionStart on it.
async function requestRecapReset(graceMs) {
  try {
    const active = await pollActiveInstance(Math.max(0, graceMs));
    if (!active || !active.httpPort) {
      teeStderr('[session-start] recap-reset skipped: no active instance\n');
      return;
    }
    const res = await httpPostJson({
      hostname: '127.0.0.1',
      port: active.httpPort,
      path: '/recap/reset',
      timeoutMs: 2000,
      body: {},
    });
    if (res.statusCode !== 200) {
      teeStderr(`[session-start] recap-reset non-200 status=${res.statusCode}\n`);
    }
  } catch (e) {
    teeStderr(`[session-start] recap-reset failed: ${(e && e.message) || e}\n`);
  }
}

async function runRulesPart() {
  // First-boot one-shot work — only slot 1 (rules) runs this. Other slots
  // skip it entirely so they stay read-only and side-effect free.
  try {
    const flagPath = path.join(DATA_DIR, '.first-boot-seen');
    if (!fs.existsSync(flagPath)) {
      spawn('bun', [path.join(PLUGIN_ROOT, 'setup', 'launch.mjs')], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();

      try {
        const ngrokCheck = require('child_process').spawnSync(
          os.platform() === 'win32' ? 'where' : 'which',
          ['ngrok'],
          { stdio: 'pipe', windowsHide: true }
        );
        if (ngrokCheck.status !== 0) {
          // SessionStart must not make global package changes without
          // explicit user consent. The previous version spawned
          // `npm install -g ngrok` in the background on every fresh
          // session that had no ngrok in PATH — a supply-chain risk
          // and an opaque global side effect. Surface a hint instead
          // so the user can install manually if and when they need
          // the bridge tunnel feature.
          process.stderr.write('[session-start] ngrok not found in PATH — install manually with `npm install -g ngrok` if you need the bridge tunnel feature\n');
        }
      } catch (e) {
        process.stderr.write(`[session-start] ngrok auto-install check failed: ${e.message}\n`);
      }

      try {
        const gitDir = path.join(PLUGIN_ROOT, '.git');
        if (fs.existsSync(gitDir)) {
          spawn('bun', [path.join(PLUGIN_ROOT, 'scripts', 'install-git-hooks.mjs')], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          }).unref();
          process.stderr.write('[session-start] installing version-sync git hook in background\n');
        }
      } catch (e) {
        process.stderr.write(`[session-start] git hook install failed: ${e.message}\n`);
      }

      fs.writeFileSync(flagPath, '');
    }
  } catch {}

  try {
    const asp = path.join(DATA_DIR, 'active-session.txt');
    if (fs.existsSync(asp)) fs.unlinkSync(asp);
  } catch {}

  try {
    const stalePending = path.join(DATA_DIR, 'recap-pending.json');
    if (fs.existsSync(stalePending)) fs.unlinkSync(stalePending);
  } catch {}

  ensurePromptInjectionConfig();
  injectStatusLine(PLUGIN_ROOT);
  rebindActiveInstance();

  const mainConfig = readJson(path.join(DATA_DIR, 'config.json'));
  const injection = mainConfig && typeof mainConfig.promptInjection === 'object' ? mainConfig.promptInjection : {};
  const claudeMdMode = injection.mode === 'claude_md';
  const claudeMdTargetPath = typeof injection.targetPath === 'string' && injection.targetPath
    ? injection.targetPath
    : '~/.claude/CLAUDE.md';
  const needsBootstrapInjection = claudeMdMode && !hasManagedClaudeMdBlock(claudeMdTargetPath);

  let additionalContext = '';
  if (!claudeMdMode || needsBootstrapInjection) {
    try {
      const { buildInjectionContent } = require(path.join(PLUGIN_ROOT, 'lib', 'rules-builder.cjs'));
      additionalContext = buildInjectionContent({ PLUGIN_ROOT, DATA_DIR }) || '';
    } catch {}
  }

  // On `/clear`, drop the prior session's recap badge from the forked status
  // server. Hook runs in a separate cjs process with no IPC handle to that
  // child, so we POST /recap/reset to the channels owner instead. Best
  // effort, short grace — channels owner is usually already up on /clear.
  if (_event.source === 'clear') {
    await requestRecapReset(3000);
  }

  emit(additionalContext);
}

// ---------------------------------------------------------------------------
// Part: core (slot 2) — Core Memory only. Runs in its own process so each
// SessionStart additionalContext is sized independently against the host
// preview cap. Pairs with recap (slot 3); both are spawned in parallel by
// the host and share the cycle1 await on the server side.
// ---------------------------------------------------------------------------
async function runCorePart() {
  if (skipMemoryInject) return;
  const r = await requestCycle1(60000, { graceMs: 3000, slot: 'core' });
  if (r.ok !== true) {
    teeStderr(`[session-start] core skipped: cycle1 await failed reason=${r.reason}\n`);
    return;
  }
  const db = openMemoryDb();
  if (!db) return;
  try {
    const ctx = buildContext(db);
    if (ctx) emit(ctx);
  } finally {
    try { db.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Part: recap (slot 3) — Recap entries only. Spawned in parallel with core.
// ---------------------------------------------------------------------------
async function runRecapPart() {
  if (skipMemoryInject) return;
  const r = await requestCycle1(60000, { graceMs: 3000, slot: 'recap' });
  if (r.ok !== true) {
    teeStderr(`[session-start] recap skipped: cycle1 await failed reason=${r.reason}\n`);
    return;
  }
  const db = openMemoryDb();
  if (!db) return;
  try {
    const recapData = buildRecapData(db);
    const lines = (recapData && recapData.lines) || [];
    if (lines.length > 0) emit(`## Recap\n${lines.join('\n')}`);
  } finally {
    try { db.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Main IIFE — dispatch on PART.
// ---------------------------------------------------------------------------
(async () => {
  if (PART === 'rules') {
    await runRulesPart();
  } else if (PART === 'core') {
    await runCorePart();
  } else if (PART === 'recap') {
    await runRecapPart();
  }
})();
