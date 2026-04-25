'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { resolvePluginData } = require(path.join(__dirname, '..', 'lib', 'plugin-paths.cjs'));

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
      LIMIT 200
    `).all();
    if (rows.length === 0) return out;

    const rendered = rows.map(r => {
      const tsStr = formatTsShort(r.ts);
      const summary = String(r.summary || '').trim().slice(0, 1000);
      return summary ? `[${tsStr}] ${summary}` : '';
    }).filter(Boolean);
    if (rendered.length === 0) return out;

    // Newest → oldest; keep accumulating from the newest end until the
    // running total would exceed the cap, then reverse to chronological.
    const HEADER_LEN = '## Recap\n'.length;
    const CAP = 9900;
    let total = HEADER_LEN;
    const kept = [];
    for (const line of rendered) {
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
// the rules block. Must run cycle1 to completion BEFORE later parts read
// the DB so they see the freshest roots.
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

function readMemoryWorkerPort() {
  try {
    const portPath = path.join(os.tmpdir(), 'mixdog-memory', 'memory-port');
    if (!fs.existsSync(portPath)) return null;
    const raw = fs.readFileSync(portPath, 'utf8').trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
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
  // 100ms cadence — active-instance.json appears ~ms after channels owner HTTP ready.
  while (Date.now() <= deadline) {
    try {
      if (fs.existsSync(activePath)) {
        const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
        if (active && active.httpPort) {
          // Stale guard: previous session may have left active-instance.json
          // behind with a port whose owner is already dead. TCP-probe it
          // briefly; only return when something actually accepts a
          // connection. Otherwise keep polling so a freshly-booting owner
          // can register and be picked up.
          const alive = await probeTcpPort(active.httpPort, 200);
          if (alive) return active;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
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

async function requestCycle1(timeoutMs, opts = {}) {
  const slot = opts.slot || 'unknown';
  const graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : 5000;
  const start = Date.now();
  const deadline = start + Math.max(0, timeoutMs);
  process.stderr.write(`[session-start] cycle1 slot=${slot} start graceMs=${graceMs} timeoutMs=${timeoutMs}\n`);

  const finish = (route, payload) => {
    const elapsedMs = Date.now() - start;
    if (payload.ok) {
      process.stderr.write(`[session-start] cycle1 slot=${slot} route=${route} reason=ok elapsed=${elapsedMs}ms\n`);
      return { ok: true, result: payload.result, elapsedMs, route };
    }
    const sc = payload.statusCode != null ? ` statusCode=${payload.statusCode}` : '';
    process.stderr.write(`[session-start] cycle1 slot=${slot} route=${route} reason=${payload.reason}${sc} elapsed=${elapsedMs}ms\n`);
    return { ok: false, reason: payload.reason, statusCode: payload.statusCode, elapsedMs };
  };

  const classifyError = (e) => {
    const msg = (e && e.message) || '';
    if (/timeout/i.test(msg)) return 'timeout';
    if ((e && e.code === 'ECONNREFUSED') || /ECONNREFUSED/i.test(msg)) return 'connect-refused';
    return 'http-error';
  };

  try {
    // Route 1: memory worker direct — preferred because it skips channels owner relay.
    const memPort = readMemoryWorkerPort();
    if (memPort) {
      // Cold-start race: memory-port file lands on disk a few ms before the
      // worker actually listen()s. Retry ECONNREFUSED specifically (up to
      // 5 attempts × 200ms = ~1s) before giving up to channels fallback.
      // Other failures (timeout / http-error / non-200) fall back immediately.
      const MAX_ATTEMPTS = 5;
      const RETRY_DELAY_MS = 200;
      let memDirectSettled = false;
      let lastResult = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          lastResult = finish('memory-direct', { ok: false, reason: 'timeout' });
          memDirectSettled = true;
          break;
        }
        try {
          const res = await httpPostJson({
            hostname: '127.0.0.1',
            port: memPort,
            path: '/api/tool',
            timeoutMs: remaining,
            body: { name: 'memory', arguments: { action: 'cycle1', min_batch: 1, session_cap: 50 } },
          });
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(res.body);
              // memory worker returns MCP envelope: { content:[...], isError:bool }.
              // Success = isError !== true. Also accept legacy { ok:true } shape.
              if (parsed && (parsed.isError === false || parsed.ok === true)) {
                return finish('memory-direct', { ok: true, result: parsed.result ?? parsed });
              }
              return finish('memory-direct', { ok: false, reason: 'body-not-ok', statusCode: 200 });
            } catch {
              return finish('memory-direct', { ok: false, reason: 'parse-error', statusCode: 200 });
            }
          }
          // Non-200 → fall through to channels route immediately.
          process.stderr.write(`[session-start] cycle1 slot=${slot} route=memory-direct attempt=${attempt} reason=non-200 statusCode=${res.statusCode} elapsed=${Date.now() - start}ms (fallback)\n`);
          break;
        } catch (e) {
          const reason = classifyError(e);
          process.stderr.write(`[session-start] cycle1 slot=${slot} route=memory-direct attempt=${attempt} reason=${reason} elapsed=${Date.now() - start}ms\n`);
          if (reason !== 'connect-refused') break;
          // Retry only on ECONNREFUSED. Stop if the next sleep would cross deadline.
          if (attempt >= MAX_ATTEMPTS) break;
          const remainAfterErr = deadline - Date.now();
          if (remainAfterErr <= RETRY_DELAY_MS) break;
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
      if (memDirectSettled) return lastResult;
    } else {
      process.stderr.write(`[session-start] cycle1 slot=${slot} route=memory-direct reason=no-port (fallback)\n`);
    }

    // Route 2: channels owner HTTP — wait for active-instance.json then POST /cycle1.
    const remainingForGrace = deadline - Date.now();
    if (remainingForGrace <= 0) return finish('channels', { ok: false, reason: 'timeout' });
    const active = await pollActiveInstance(Math.min(graceMs, remainingForGrace));
    if (!active) {
      const reason = (Date.now() >= deadline) ? 'timeout' : 'no-active-instance';
      return finish('channels', { ok: false, reason });
    }
    const port = active.httpPort;
    if (!port) return finish('channels', { ok: false, reason: 'no-port' });

    const remaining = deadline - Date.now();
    if (remaining <= 0) return finish('channels', { ok: false, reason: 'timeout' });

    try {
      const res = await httpPostJson({
        hostname: '127.0.0.1',
        port,
        path: '/cycle1',
        timeoutMs: remaining,
        body: { timeout_ms: remaining, args: { min_batch: 1, session_cap: 50 } },
      });
      if (res.statusCode !== 200) {
        return finish('channels', { ok: false, reason: 'non-200', statusCode: res.statusCode });
      }
      try {
        const parsed = JSON.parse(res.body);
        if (parsed && parsed.ok) {
          return finish('channels', { ok: true, result: parsed.result });
        }
        return finish('channels', { ok: false, reason: 'body-not-ok', statusCode: 200 });
      } catch {
        return finish('channels', { ok: false, reason: 'parse-error', statusCode: 200 });
      }
    } catch (e) {
      return finish('channels', { ok: false, reason: classifyError(e) });
    }
  } catch {
    return finish('exception', { ok: false, reason: 'exception' });
  }
}

async function runRulesPart() {
  // First-boot one-shot work — only slot 1 (rules) runs this. Other slots
  // skip it entirely so they stay read-only and side-effect free.
  try {
    const flagPath = path.join(DATA_DIR, '.first-boot-seen');
    if (!fs.existsSync(flagPath)) {
      spawn('node', [path.join(PLUGIN_ROOT, 'setup', 'launch.mjs')], {
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
          spawn('npm', ['install', '-g', 'ngrok'], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            shell: true,
          }).unref();
          process.stderr.write('[session-start] ngrok not found — installing globally in background\n');
        }
      } catch (e) {
        process.stderr.write(`[session-start] ngrok auto-install check failed: ${e.message}\n`);
      }

      try {
        const gitDir = path.join(PLUGIN_ROOT, '.git');
        if (fs.existsSync(gitDir)) {
          spawn('node', [path.join(PLUGIN_ROOT, 'scripts', 'install-git-hooks.mjs')], {
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

  // Always run cycle1 to completion so later slots (core / recap) read the
  // freshest roots. Skip only when memory inject itself is skipped.
  // rules slot itself always emits regardless of cycle1 outcome — it just
  // primes the pipeline so the later slots have fresh DB to read.
  if (!skipMemoryInject) {
    await requestCycle1(60000, { graceMs: 10000, slot: 'rules' });
  }

  emit(additionalContext);
}

// ---------------------------------------------------------------------------
// Part: core (slot 2) — DB read. Awaits cycle1 in-flight so freshly
// classified roots from the rules slot are visible. The server-side
// `_awaitCycle1Run` guard de-duplicates concurrent calls, so this only
// piggybacks on the rules-slot run rather than triggering a second pass.
// ---------------------------------------------------------------------------
async function runCorePart() {
  if (skipMemoryInject) return;
  const r = await requestCycle1(25000, { graceMs: 5000, slot: 'core' });
  if (r.ok !== true) {
    process.stderr.write(`[session-start] core skipped: cycle1 await failed reason=${r.reason}\n`);
    return;
  }
  const db = openMemoryDb();
  if (!db) return;
  try {
    const ctx = buildContext(db);
    emit(ctx);
  } finally {
    try { db.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Part: recap — DB read. Same in-flight piggyback as core: wait for the
// rules-slot cycle1 to finish so the recap block reflects the freshest
// roots before the hook output cap is applied.
// ---------------------------------------------------------------------------
async function runRecapPart() {
  if (skipMemoryInject) return;
  const r = await requestCycle1(25000, { graceMs: 5000, slot: 'recap' });
  if (r.ok !== true) {
    process.stderr.write(`[session-start] recap skipped: cycle1 await failed reason=${r.reason}\n`);
    return;
  }
  const db = openMemoryDb();
  if (!db) return;
  try {
    const recapData = buildRecapData(db);
    const lines = recapData.lines || [];
    if (lines.length === 0) return;
    emit(`## Recap\n${lines.join('\n')}`);
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
