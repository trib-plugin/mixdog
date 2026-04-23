'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { resolvePluginData } = require(path.join(__dirname, '..', 'lib', 'plugin-paths.cjs'));

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

// First-boot: auto-open the config UI once per install.
try {
  const flagPath = path.join(DATA_DIR, '.first-boot-seen');
  if (!fs.existsSync(flagPath)) {
    spawn('node', [path.join(PLUGIN_ROOT, 'setup', 'launch.mjs')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();

    // Auto-install ngrok globally if not present (non-blocking, non-fatal).
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

    // Auto-install git pre-commit version-sync hook if inside a git repo (non-blocking, non-fatal).
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

    // H6: write flag after spawns have been issued (not before), so we don't
    // suppress the first-boot UI on the next session if this one crashes early.
    fs.writeFileSync(flagPath, '');
  }
} catch {}

// Clear active orchestrator session pointer (merged from clear-active-session.mjs)
try {
  const asp = path.join(DATA_DIR, 'active-session.txt');
  if (fs.existsSync(asp)) fs.unlinkSync(asp);
} catch {}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

// statusLine launch strategy.
//
// Claude Code spawns statusLine commands through a shell — bash on macOS/Linux
// and Git Bash on Windows (per the official docs). A single `bash "<path>"`
// command works uniformly on both; no .bat wrapper or executable detection is
// needed. scriptPath is normalised to forward slashes so Git Bash accepts it
// as `C:/Users/...` on Windows.
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

injectStatusLine(PLUGIN_ROOT);

try {
  const activePath = path.join(os.tmpdir(), 'mixdog', 'active-instance.json');
  if (fs.existsSync(activePath)) {
    const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
    if (active.httpPort) {
      const http2 = require('http');
      const req2 = http2.request({
        hostname: '127.0.0.1',
        port: active.httpPort,
        path: '/rebind',
        method: 'POST',
        timeout: 3000,
      });
      req2.on('error', () => {});
      req2.on('timeout', () => req2.destroy());
      req2.end();
    }
  }
} catch {}

function openMemoryDb() {
  try {
    const dbPath = path.join(DATA_DIR, 'memory.sqlite');
    if (!fs.existsSync(dbPath)) return null;
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    process.stderr.write(`[session-start] open memory.sqlite failed: ${e.message}\n`);
    return null;
  }
}

function formatTs(ts) {
  const n = Number(ts);
  if (Number.isFinite(n) && n > 1e12) {
    return new Date(n).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16) + ' KST';
  }
  return String(ts ?? '').slice(0, 16);
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
    const lines = rows.map(r => {
      const cat = r.category ? `[${r.category}] ` : '';
      const element = r.element ?? '';
      const summary = r.summary ?? '';
      return `- ${cat}${element}${summary ? ' — ' + summary : ''}`;
    });
    return `## Core Memory\n${lines.join('\n')}`;
  } catch (e) {
    process.stderr.write(`[session-start] context build failed: ${e.message}\n`);
    return '';
  }
}

function buildRecap(db) {
  try {
    const rows = db.prepare(`
      SELECT id, ts, role, content, chunk_root, is_root,
             element, category, summary
      FROM entries
      WHERE (is_root = 1 AND (status IS NULL OR status != 'archived'))
         OR chunk_root IS NULL
      ORDER BY ts DESC, id DESC
      LIMIT 20
    `).all();
    if (rows.length === 0) return '';
    const lines = rows.map(r => {
      const tsStr = formatTs(r.ts);
      if (r.is_root === 1) {
        const cat = r.category ? `[${r.category}] ` : '';
        const element = r.element ?? '';
        const summary = r.summary ?? '';
        const combined = `${cat}${element}${summary ? ' — ' + summary : ''}`;
        return `[${tsStr}] ${combined.slice(0, 1000)}`;
      }
      const prefix = r.role === 'user' ? 'u' : r.role === 'assistant' ? 'a' : (r.role || '?');
      return `[${tsStr}] ${prefix}: ${cleanText(String(r.content || '')).slice(0, 1000)}`;
    });
    const text = lines.reverse().join('\n');
    return text.length > 20 ? '## Session Recap\n\n' + text : '';
  } catch (e) {
    process.stderr.write(`[session-start] recap build failed: ${e.message}\n`);
    return '';
  }
}

function buildMemoryBlocks() {
  let db = null;
  try {
    db = openMemoryDb();
    if (!db) return { context: '', recap: '' };
    return { context: buildContext(db), recap: buildRecap(db) };
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
}

const mainConfig = readJson(path.join(DATA_DIR, 'config.json'));
const claudeMdMode = mainConfig.promptInjection && mainConfig.promptInjection.mode === 'claude_md';

let additionalContext = '';

if (!claudeMdMode) {
  try {
    const { buildInjectionContent } = require(path.join(PLUGIN_ROOT, 'lib', 'rules-builder.cjs'));
    additionalContext = buildInjectionContent({ PLUGIN_ROOT, DATA_DIR }) || '';
  } catch {}
}

const memoryBlocks = buildMemoryBlocks();
const blocks = [additionalContext, memoryBlocks.context, memoryBlocks.recap].filter(Boolean);
additionalContext = blocks.join('\n\n');

if (additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }));
}
