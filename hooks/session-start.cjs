'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
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

// Resolve this session's transcript jsonl path so /rebind can use the
// 0.1.72 explicit-path escape hatch (bypasses the 30s mtime heuristic).
// Claude Code's SessionStart hook payload provides transcript_path /
// session_id / cwd; we accept both snake_case and camelCase defensively
// and fall back to deriving <projectsDir>/<slug>/<sessionId>.jsonl.
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

try {
  const activePath = path.join(os.tmpdir(), 'mixdog', 'active-instance.json');
  if (fs.existsSync(activePath)) {
    const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
    if (active.httpPort) {
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

function buildRecapEntriesText(db, chunkCount) {
  try {
    const limit = Math.max(1, Number(chunkCount) || 100);
    const rows = db.prepare(`
      SELECT id, ts, role, content, chunk_root, is_root,
             element, category, summary
      FROM entries
      WHERE (is_root = 1 AND (status IS NULL OR status != 'archived'))
         OR chunk_root IS NULL
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `).all(limit);
    if (rows.length === 0) return '';
    const lines = rows.map(r => {
      const tsStr = formatTs(r.ts);
      if (r.is_root === 1) {
        const category = String(r.category || '').trim();
        const element = String(r.element || '').trim();
        const summary = String(r.summary || '').trim().slice(0, 1000);
        return [
          '[[entry]]',
          'type: root_summary',
          `id: ${r.id}`,
          `ts: ${tsStr}`,
          `category: ${category || '-'}`,
          `element: ${element || '-'}`,
          `summary: ${summary || '-'}`,
        ].join('\n');
      }
      const role = String(r.role || '?').trim() || '?';
      const content = cleanText(String(r.content || '')).slice(0, 1000);
      return [
        '[[entry]]',
        'type: raw_turn',
        `id: ${r.id}`,
        `ts: ${tsStr}`,
        `role: ${role}`,
        `content: ${content || '-'}`,
      ].join('\n');
    });
    const text = lines.reverse().join('\n\n');
    return text.length > 20 ? text : '';
  } catch (e) {
    process.stderr.write(`[session-start] recap build failed: ${e.message}\n`);
    return '';
  }
}

function buildMemoryBlocks(chunkCount) {
  let db = null;
  try {
    db = openMemoryDb();
    if (!db) return { context: '', recapEntries: '' };
    return { context: buildContext(db), recapEntries: buildRecapEntriesText(db, chunkCount) };
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
}

function requestCycle1(timeoutMs) {
  return new Promise((resolve) => {
    try {
      const activePath = path.join(os.tmpdir(), 'mixdog', 'active-instance.json');
      if (!fs.existsSync(activePath)) return resolve(null);
      const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
      const port = active?.httpPort;
      if (!port) return resolve(null);

      const payload = JSON.stringify({ timeout_ms: timeoutMs });
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

(async () => {
  ensurePromptInjectionConfig();

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

  // Force one cycle1 pass before reading recap entries so the freshest
  // raw turns get chunked into roots and surface in the inject. Best-effort
  // — failure (timeout, mcp down, parse error) silently degrades to whatever
  // the DB already holds. The 60s cap matches the channels endpoint's own
  // safety bound and keeps SessionStart hook latency bounded.
  await requestCycle1(60000);

  const memoryConfigPath = path.join(DATA_DIR, 'memory-config.json');
  const memoryConfig = readJson(memoryConfigPath);
  const chunkCount = Number(memoryConfig?.recap?.chunk_count) > 0
    ? Number(memoryConfig.recap.chunk_count)
    : 100;

  const memoryBlocks = buildMemoryBlocks(chunkCount);
  let recapBlock = '';
  if (memoryBlocks.recapEntries) {
    recapBlock = '## Session Recap\n\n' + memoryBlocks.recapEntries;
  }

  const blocks = [additionalContext, memoryBlocks.context, recapBlock].filter(Boolean);
  additionalContext = blocks.join('\n\n');

  if (additionalContext) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    }));
  }
})();
