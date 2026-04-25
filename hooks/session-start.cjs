'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
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

function requestCycle1(timeoutMs) {
  return new Promise((resolve) => {
    try {
      const activePath = path.join(os.tmpdir(), 'mixdog', 'active-instance.json');
      if (!fs.existsSync(activePath)) return resolve(null);
      const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
      const port = active?.httpPort;
      if (!port) return resolve(null);

      const payload = JSON.stringify({
        timeout_ms: timeoutMs,
        args: { min_batch: 1, session_cap: 50 },
      });
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/cycle1',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(res.statusCode === 200 && body?.ok ? body.result : null);
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end(payload);
    } catch {
      resolve(null);
    }
  });
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
  if (!skipMemoryInject) {
    await requestCycle1(60000);
  }

  emit(additionalContext);
}

// ---------------------------------------------------------------------------
// Part: core (slot 2) — DB read only; no one-shot work, no cycle1.
// ---------------------------------------------------------------------------
function runCorePart() {
  if (skipMemoryInject) return;
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
// Part: recap — DB read only; emit a single `## Recap` block sized to fit
// the SessionStart hook output cap.
// ---------------------------------------------------------------------------
function runRecapPart() {
  if (skipMemoryInject) return;
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
    runCorePart();
  } else if (PART === 'recap') {
    runRecapPart();
  }
})();
