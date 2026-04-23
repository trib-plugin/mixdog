#!/usr/bin/env node
import { exec, execSync, spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, createWriteStream, mkdirSync, renameSync, readdirSync, rmSync } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir, arch, platform } from 'os';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';
import { DEFAULT_MAINTENANCE, getPluginData } from '../src/agent/orchestrator/config.mjs';
import { resolvePluginData } from '../src/shared/plugin-paths.mjs';
import { ensureDataSeeds } from '../src/shared/seed.mjs';
import { syncRootEmbedding, runCycle1, runCycle2 } from '../src/memory/lib/memory-cycle.mjs';
import { runFullBackfill } from '../src/memory/lib/memory-ops-policy.mjs';
import { cleanMemoryText } from '../src/memory/lib/memory.mjs';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';
const home = homedir();

// -- Channels paths --
const DATA_DIR = resolvePluginData();
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const BOT_PATH = join(DATA_DIR, 'bot.json');

// -- Agent paths (same data dir after unification) --
const AGENT_DATA_DIR = DATA_DIR;
const AGENT_CONFIG_PATH = join(AGENT_DATA_DIR, 'agent-config.json');

// -- Workflow paths --
const USER_WORKFLOW_PATH = join(DATA_DIR, 'user-workflow.json');
const USER_WORKFLOW_MD_PATH = join(DATA_DIR, 'user-workflow.md');

const DEFAULT_USER_WORKFLOW = {
  roles: [
    { name: 'worker', preset: 'SONNET HIGH' },
    { name: 'reviewer', preset: 'OPUS XHIGH' },
    { name: 'debugger', preset: 'OPUS XHIGH' },
    { name: 'tester', preset: 'SONNET HIGH' },
  ],
};

const DEFAULT_USER_WORKFLOW_MD = `Default role assignment:
- Implementation → worker
- Verification → reviewer
- Debugging → debugger
- Testing → tester
`;

// -- Memory paths --
const MEMORY_DATA_DIR = DATA_DIR;
const MEMORY_CONFIG_PATH = join(MEMORY_DATA_DIR, 'memory-config.json');
const MEMORY_FILES_DIR = join(MEMORY_DATA_DIR, 'history');
const MEMORY_DB_PATH = join(MEMORY_DATA_DIR, 'memory.sqlite');

// -- Search paths --
const SEARCH_DATA_DIR = DATA_DIR;
const SEARCH_CONFIG_PATH = join(SEARCH_DATA_DIR, 'search-config.json');

// -- Unified config sync --
const MIXDOG_CONFIG_PATH = join(DATA_DIR, 'mixdog-config.json');
const SECTION_FILES = { channels: CONFIG_PATH, agent: AGENT_CONFIG_PATH, memory: MEMORY_CONFIG_PATH, search: SEARCH_CONFIG_PATH };

function syncToTribConfig() {
  try {
    const merged = {};
    const SECTION_NAMES = { channels: 'config.json', agent: 'agent-config.json', memory: 'memory-config.json', search: 'search-config.json' };
    for (const [section, filePath] of Object.entries(SECTION_FILES)) {
      try { merged[section] = JSON.parse(readFileSync(filePath, 'utf8')); } catch {}
    }
    writeJsonFile(MIXDOG_CONFIG_PATH, merged);
  } catch {}
}

const PORT = 3458;
const APP_WIDTH = 950;
const APP_HEIGHT = 900;
const HTML_PATH = join(__dirname, 'setup.html');

// Drop any runtime-provider model caches on boot so the Config UI always
// re-fetches fresh catalogs. Caches can get stuck on partial/stale responses
// (e.g. Codex /backend-api/codex/models returning just one model).
try { rmSync(join(getPluginData(), 'openai-oauth-models.json'), { force: true }); } catch {}

// Seed user-workflow.json and user-workflow.md on first launch so Smart
// Bridge has sensible role→preset mappings and the Lead has a baseline
// workflow description out of the box. Leaves existing files untouched.
try {
  if (!existsSync(USER_WORKFLOW_PATH)) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(USER_WORKFLOW_PATH, JSON.stringify(DEFAULT_USER_WORKFLOW, null, 2));
  }
  if (!existsSync(USER_WORKFLOW_MD_PATH)) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(USER_WORKFLOW_MD_PATH, DEFAULT_USER_WORKFLOW_MD);
  }
} catch {}

// Seed plugin-owned scaffolding files (memory-config.json, etc.).
// Idempotent — ensureDataSeeds skips
// anything that already exists, so the agent/index.mjs call and this one
// can both run without colliding.
try { ensureDataSeeds(DATA_DIR); } catch {}

// -- Helpers --

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return {}; }
}

function writeJsonFile(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

function readConfig() { return readJsonFile(CONFIG_PATH); }
function writeConfig(data) { writeJsonFile(CONFIG_PATH, data); syncToTribConfig(); }

function readAgentConfig() { return readJsonFile(AGENT_CONFIG_PATH); }
function writeAgentConfig(data) { writeJsonFile(AGENT_CONFIG_PATH, data); syncToTribConfig(); }

function readMemoryConfig() { return readJsonFile(MEMORY_CONFIG_PATH); }
function writeMemoryConfig(data) { writeJsonFile(MEMORY_CONFIG_PATH, data); syncToTribConfig(); }

function readSearchConfig() { return readJsonFile(SEARCH_CONFIG_PATH); }
function writeSearchConfig(data) { writeJsonFile(SEARCH_CONFIG_PATH, data); syncToTribConfig(); }

function readUserWorkflow() {
  if (!existsSync(USER_WORKFLOW_PATH)) return DEFAULT_USER_WORKFLOW;
  try { return JSON.parse(readFileSync(USER_WORKFLOW_PATH, 'utf8')); }
  catch { return DEFAULT_USER_WORKFLOW; }
}
// Phase C Ship 3 — the `worker` role is reserved and non-deletable. Smart
// Bridge's router dispatches any request with `role: "worker"` to the
// `worker-full` profile; if the role goes missing the router has nowhere to
// send Worker calls. Every persist path funnels through here, so reinstating
// the role on save keeps the contract intact regardless of how the caller
// mutated the roster (UI drag-delete, raw MD edit, direct JSON PUT).
function writeUserWorkflow(data) {
  const roles = Array.isArray(data?.roles) ? data.roles.slice() : [];
  if (!roles.some(r => r?.name === 'worker')) {
    const existing = readUserWorkflow();
    const preservedWorker = existing?.roles?.find(r => r?.name === 'worker');
    const seedWorker = DEFAULT_USER_WORKFLOW.roles.find(r => r?.name === 'worker');
    roles.unshift(preservedWorker || seedWorker);
  }
  writeJsonFile(USER_WORKFLOW_PATH, { ...data, roles });
}

function readUserWorkflowMd() {
  if (!existsSync(USER_WORKFLOW_MD_PATH)) return DEFAULT_USER_WORKFLOW_MD;
  try { return readFileSync(USER_WORKFLOW_MD_PATH, 'utf8'); }
  catch { return DEFAULT_USER_WORKFLOW_MD; }
}
function writeUserWorkflowMd(content) {
  mkdirSync(dirname(USER_WORKFLOW_MD_PATH), { recursive: true });
  const tmp = USER_WORKFLOW_MD_PATH + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, USER_WORKFLOW_MD_PATH);
}

// -- HTTPS helpers --

function httpGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'GET', headers, timeout: 10000,
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => { res.statusCode < 400 ? resolve(JSON.parse(body)) : reject(); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(); });
    req.end();
  });
}

function httpPostJson(url, data, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(data);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => { res.statusCode < 400 ? resolve(JSON.parse(buf)) : reject(); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(); });
    req.write(body);
    req.end();
  });
}

function pingLocalHttp(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = http.request({
        hostname: u.hostname, port: u.port,
        path: u.pathname + u.search,
        method: 'GET', timeout: timeoutMs,
      }, res => { res.resume(); resolve(res.statusCode > 0 && res.statusCode < 500); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });
}

// -- Agent key validation --

async function validateAgentKey(provider, key) {
  if (!key) return 'empty';
  try {
    switch (provider) {
      case 'openai':
        await httpGetJson('https://api.openai.com/v1/models', { 'Authorization': `Bearer ${key}` });
        return 'valid';
      case 'anthropic':
        await httpPostJson('https://api.anthropic.com/v1/messages',
          { model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
          { 'x-api-key': key, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' });
        return 'valid';
      case 'gemini':
        await httpGetJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, {});
        return 'valid';
      case 'groq':
        await httpGetJson('https://api.groq.com/openai/v1/models', { 'Authorization': `Bearer ${key}` });
        return 'valid';
      case 'openrouter':
        await httpGetJson('https://openrouter.ai/api/v1/models', { 'Authorization': `Bearer ${key}` });
        return 'valid';
      case 'xai':
        await httpPostJson('https://api.x.ai/v1/chat/completions',
          { model: 'grok-3-mini-fast', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
          { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' });
        return 'valid';
      default: return 'valid';
    }
  } catch { return 'invalid'; }
}

// -- Search key validation --

async function validateSearchKey(provider, key) {
  if (!key) return 'empty';
  try {
    switch (provider) {
      case 'serper':
        await httpPostJson('https://google.serper.dev/search', { q: 'test' },
          { 'X-API-KEY': key, 'Content-Type': 'application/json' });
        return 'valid';
      case 'brave':
        await httpGetJson('https://api.search.brave.com/res/v1/web/search?q=test&count=1',
          { 'X-Subscription-Token': key });
        return 'valid';
      case 'xai':
        await httpPostJson('https://api.x.ai/v1/chat/completions',
          { model: 'grok-3-mini-fast', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
          { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' });
        return 'valid';
      case 'perplexity':
        await httpPostJson('https://api.perplexity.ai/chat/completions',
          { model: 'sonar', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
          { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' });
        return 'valid';
      case 'firecrawl':
        await httpGetJson('https://api.firecrawl.dev/v1/crawl', { 'Authorization': `Bearer ${key}` });
        return 'valid';
      case 'tavily':
        await httpPostJson('https://api.tavily.com/search',
          { api_key: key, query: 'test', max_results: 1 },
          { 'Content-Type': 'application/json' });
        return 'valid';
      case 'github':
        await httpGetJson('https://api.github.com/user',
          { 'Authorization': `token ${key}`, 'User-Agent': 'mixdog-setup' });
        return 'valid';
      default: return 'valid';
    }
  } catch { return 'invalid'; }
}

// -- Auth detection (shared by agent & memory) --

async function detectAuth(config = {}) {
  const result = {};
  const codexAuth = join(home, '.codex', 'auth.json');
  result.codexOAuth = existsSync(codexAuth);
  const claudeCreds = join(home, '.claude', '.credentials.json');
  result.anthropicOAuth = (() => {
    try {
      if (!existsSync(claudeCreds)) return false;
      const creds = JSON.parse(readFileSync(claudeCreds, 'utf8'));
      const scopes = String(creds?.claudeAiOauth?.scopes || creds?.scopes || '');
      return scopes.includes('inference') || !!creds?.claudeAiOauth?.accessToken;
    } catch { return false; }
  })();
  const configDir = isWin
    ? (process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'))
    : join(home, '.config');
  result.copilot = existsSync(join(configDir, 'github-copilot', 'hosts.json'))
    || existsSync(join(configDir, 'github-copilot', 'apps.json'))
    || !!process.env.GITHUB_TOKEN;
  result.envKeys = {};
  for (const [name, envKey] of [
    ['openai', 'OPENAI_API_KEY'], ['anthropic', 'ANTHROPIC_API_KEY'],
    ['gemini', 'GEMINI_API_KEY'], ['groq', 'GROQ_API_KEY'],
    ['openrouter', 'OPENROUTER_API_KEY'], ['xai', 'XAI_API_KEY'],
  ]) { result.envKeys[name] = !!process.env[envKey]; }
  const ollamaUrl = config?.providers?.ollama?.baseURL || 'http://localhost:11434/v1';
  const lmstudioUrl = config?.providers?.lmstudio?.baseURL || 'http://localhost:1234/v1';
  const [ollamaUp, lmstudioUp] = await Promise.all([
    pingLocalHttp(ollamaUrl + '/models'),
    pingLocalHttp(lmstudioUrl + '/models'),
  ]);
  result.ollama = ollamaUp;
  result.lmstudio = lmstudioUp;
  return result;
}

// -- Provider model listing --

// Minimal static fallbacks — only used when the real provider can't be
// queried (no keys, no cache, offline). Prefer getRuntimeProviderModels()
// which calls the live provider.listModels() for accurate, auto-updating
// catalogs. New model releases propagate within the 24h cache TTL without
// any code change here.
const STATIC_MODELS = {
  anthropic: ['claude-opus-4-6','claude-sonnet-4-6','claude-haiku-4-5-20251001'],
  gemini: ['gemini-3.1-pro-preview','gemini-3-flash-preview','gemini-2.5-pro','gemini-2.5-flash'],
  openai: ['gpt-5.4','gpt-5.4-mini','gpt-5.4-nano'],
  'openai-oauth': ['gpt-5.4','gpt-5.4-mini','gpt-5.3-codex'],
};

// Try the live provider registry first (dynamic catalog via /v1/models,
// Codex /backend-api/codex/models, Gemini /v1beta/models). Returns null on
// any failure so the caller falls back to STATIC_MODELS or the direct HTTP
// endpoint handlers below. Preserves full metadata (tier, family, latest,
// contextWindow, reasoningLevels, pricing) so the UI can build tier-grouped
// dropdowns and adapt effort options per model.
//
// registry.mjs populates its provider Map only after initProviders(cfg) is
// called, so setup-server (which never runs the agent's normal boot path)
// must force-init before querying — otherwise getProvider() returns
// undefined and listModels() never runs, leaving callers stuck on
// STATIC_MODELS fallback with no metadata.
const _RUNTIME_PROVIDER_NAMES = [
  'anthropic', 'anthropic-oauth', 'openai', 'openai-oauth',
  'gemini', 'groq', 'openrouter', 'xai',
  'ollama', 'lmstudio', 'local', 'copilot',
];

async function getRuntimeProviderModels(providerId, cfg) {
  try {
    const { initProviders, getProvider } = await import('../src/agent/orchestrator/providers/registry.mjs');
    const initCfg = {};
    for (const name of _RUNTIME_PROVIDER_NAMES) {
      initCfg[name] = { ...(cfg?.providers?.[name] || {}), enabled: true };
    }
    await initProviders(initCfg);
    const provider = getProvider(providerId);
    if (!provider) return null;
    const models = await provider.listModels();
    if (!Array.isArray(models) || models.length === 0) return null;
    return models
      .map(m => {
        if (typeof m === 'string') return { id: m };
        const id = m?.id || m?.name;
        if (!id) return null;
        return { ...m, id: String(id) };
      })
      .filter(Boolean);
  } catch { return null; }
}

function _idOnly(id) { return id ? { id: String(id) } : null; }

async function listProviderModels(providerId, cfg) {
  const pcfg = cfg?.providers?.[providerId] || {};
  // 1. Runtime provider (dynamic catalog, cached 24h).
  const runtime = await getRuntimeProviderModels(providerId, cfg);
  if (runtime && runtime.length > 0) return runtime;
  // 2. Direct HTTP model list for key-based providers.
  const KNOWN_ENDPOINTS = {
    openai: { url: 'https://api.openai.com/v1/models', auth: k => ({ 'Authorization': `Bearer ${k}` }) },
    groq: { url: 'https://api.groq.com/openai/v1/models', auth: k => ({ 'Authorization': `Bearer ${k}` }) },
    openrouter: { url: 'https://openrouter.ai/api/v1/models', auth: k => ({ 'Authorization': `Bearer ${k}` }) },
    xai: { url: 'https://api.x.ai/v1/models', auth: k => ({ 'Authorization': `Bearer ${k}` }) },
  };
  const ep = KNOWN_ENDPOINTS[providerId];
  if (ep && pcfg.apiKey) {
    try {
      const json = await httpGetJson(ep.url, ep.auth(pcfg.apiKey));
      const data = Array.isArray(json?.data) ? json.data : [];
      return data
        .map(m => _idOnly(m.id || m.name))
        .filter(Boolean)
        .sort((a, b) => a.id.localeCompare(b.id));
    } catch { /* fall through to static */ }
  }
  // 3. Static fallback.
  if (STATIC_MODELS[providerId]) return STATIC_MODELS[providerId].map(id => ({ id }));

  const LOCAL_DEFAULTS = { ollama: 'http://localhost:11434/v1/models', lmstudio: 'http://localhost:1234/v1/models' };
  if (LOCAL_DEFAULTS[providerId]) {
    const baseURL = pcfg.baseURL || LOCAL_DEFAULTS[providerId].replace(/\/models$/, '');
    const url = `${baseURL.replace(/\/$/, '')}/models`;
    try {
      const json = await httpGetJson(url, {});
      const data = Array.isArray(json?.data) ? json.data : [];
      return data
        .map(m => _idOnly(m.id || m.name))
        .filter(Boolean)
        .sort((a, b) => a.id.localeCompare(b.id));
    } catch { return []; }
  }
  return [];
}

// -- Presets (shared logic for agent & memory) --

const VALID_TOOLS = new Set(['full', 'readonly', 'mcp']);
const VALID_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

function normalizePreset(input) {
  if (!input || typeof input !== 'object') throw new Error('preset must be an object');
  const id = String(input.id || '').trim();
  if (!id) throw new Error('preset.id is required');
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error('preset.id must be alphanumeric (._- allowed)');
  const model = String(input.model || '').trim();
  if (!model) throw new Error('preset.model is required');
  const provider = String(input.provider || '').trim();
  if (!provider) throw new Error('preset.provider is required');
  const tools = String(input.tools || 'full');
  if (!VALID_TOOLS.has(tools)) throw new Error(`preset.tools must be one of ${[...VALID_TOOLS].join(', ')}`);
  const out = { id, type: 'bridge', model, provider, tools };
  if (typeof input.name === 'string' && input.name.trim()) out.name = input.name.trim();
  if (input.effort != null && input.effort !== '') {
    const effort = String(input.effort);
    if (!VALID_EFFORTS.has(effort)) throw new Error(`preset.effort must be one of ${[...VALID_EFFORTS].join(', ')}`);
    out.effort = effort;
  }
  if (input.fast === true) out.fast = true;
  return out;
}

function readAgentPresets() {
  const cfg = readAgentConfig();
  return Array.isArray(cfg.presets) ? cfg.presets : [];
}

function writeAgentPresets(list) {
  const cfg = readAgentConfig();
  cfg.presets = list;
  if ('defaultPreset' in cfg) delete cfg.defaultPreset;
  const validKeys = list.map(p => p.id || p.name).filter(Boolean);
  if (!cfg.default || !validKeys.includes(cfg.default)) cfg.default = validKeys[0] || null;
  writeAgentConfig(cfg);
}

function readMemoryPresets() {
  const cfg = readMemoryConfig();
  return Array.isArray(cfg.presets) ? cfg.presets : [];
}

function writeMemoryPresets(list) {
  const cfg = readMemoryConfig();
  cfg.presets = list;
  writeMemoryConfig(cfg);
}

// -- Agent merge --

function mergeAgentConfig(existing, data) {
  const config = { ...existing };
  if (!config.providers) config.providers = {};
  if (data.providers) {
    for (const [name, val] of Object.entries(data.providers)) {
      if (!val || typeof val !== 'object') continue;
      if (!config.providers[name]) config.providers[name] = {};
      // Preserve any per-provider subkey from the setup payload so future
      // schema additions round-trip through the UI without being dropped.
      for (const [k, v] of Object.entries(val)) {
        if (v === undefined) continue;
        config.providers[name][k] = v;
      }
    }
  }
  if (data.bridge && typeof data.bridge === 'object') {
    config.bridge = { ...(config.bridge || {}), ...data.bridge };
  }
  return config;
}

// -- Memory merge --

function mergeMemoryConfig(existing, incoming) {
  const config = { ...existing };
  if (incoming.enabled !== undefined) config.enabled = incoming.enabled;
  if (incoming.cycle1) {
    if (!config.cycle1) config.cycle1 = {};
    if (incoming.cycle1.interval !== undefined) config.cycle1.interval = incoming.cycle1.interval;
    if (incoming.cycle1.timeout !== undefined) config.cycle1.timeout = incoming.cycle1.timeout;
    if (incoming.cycle1.batchSize !== undefined) config.cycle1.batchSize = incoming.cycle1.batchSize;
  }
  if (incoming.cycle2) {
    if (!config.cycle2) config.cycle2 = {};
    if (incoming.cycle2.interval !== undefined) config.cycle2.interval = incoming.cycle2.interval;
  }
  if (incoming.user) {
    if (!config.user) config.user = { name: '', title: '' };
    if (incoming.user.name !== undefined) config.user.name = incoming.user.name;
    if (incoming.user.title !== undefined) config.user.title = incoming.user.title;
  }
  if (incoming.providers) {
    if (!config.providers) config.providers = {};
    for (const [name, val] of Object.entries(incoming.providers)) {
      if (!config.providers[name]) config.providers[name] = {};
      if (val.apiKey !== undefined) config.providers[name].apiKey = val.apiKey;
      if (val.baseURL !== undefined) config.providers[name].baseURL = val.baseURL;
    }
  }
  return config;
}

// -- Search merge --

function mergeSearchConfig(existing, data) {
  const config = { ...existing };
  if (!config.rawSearch) config.rawSearch = {};
  if (!config.rawSearch.credentials) config.rawSearch.credentials = {};
  if (data.searchPriority?.length) config.rawSearch.priority = data.searchPriority;
  for (const [id, key] of Object.entries(data.searchProviders || {})) {
    if (!config.rawSearch.credentials[id]) config.rawSearch.credentials[id] = {};
    config.rawSearch.credentials[id].apiKey = key;
  }
  if (data.github !== undefined) {
    if (!config.rawSearch.credentials.github) config.rawSearch.credentials.github = {};
    config.rawSearch.credentials.github.token = data.github;
  }
  if (data.mode) config.defaultMode = data.mode;
  if (data.maxResults) config.rawSearch.maxResults = data.maxResults;
  if (data.requestTimeoutMs) config.requestTimeoutMs = data.requestTimeoutMs;
  if (data.crawl) config.crawl = { ...config.crawl, ...data.crawl };
  if (data.siteRules) config.siteRules = data.siteRules;
  return config;
}

// -- Memory SQLite --

function openMemoryDb(readonly = false) {
  if (!DatabaseSync) throw new Error('node:sqlite not available');
  return new DatabaseSync(MEMORY_DB_PATH, { open: true, readOnly: readonly });
}

// -- Memory backfill (UI trigger) --

let _backfillInProgress = false;

function ingestTranscriptForBackfill(db, transcriptPath) {
  if (!existsSync(transcriptPath)) return 0;
  let content;
  try { content = readFileSync(transcriptPath, 'utf8'); } catch { return 0; }
  const parts = transcriptPath.split(/[\\/]/);
  const sessionUuid = (parts[parts.length - 1] || '').replace(/\.jsonl$/, '');
  const lines = content.split('\n').filter(Boolean);
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO entries(ts, role, content, source_ref, session_id) VALUES (?, ?, ?, ?, ?)`
  );
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    let parsed;
    try { parsed = JSON.parse(lines[i]); } catch { continue; }
    const role = parsed?.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const rawContent = parsed?.message?.content;
    let text = '';
    if (typeof rawContent === 'string') text = rawContent;
    else if (Array.isArray(rawContent)) {
      for (const item of rawContent) {
        if (typeof item === 'string') { text = item; break; }
        if (item?.type === 'text' && typeof item.text === 'string') { text = item.text; break; }
      }
    }
    if (!text || !text.trim()) continue;
    const cleaned = cleanMemoryText(text);
    if (!cleaned) continue;
    const tsRaw = parsed.timestamp ?? parsed.ts ?? Date.now();
    let tsMs;
    if (typeof tsRaw === 'number' && Number.isFinite(tsRaw)) {
      tsMs = tsRaw < 1e12 ? tsRaw * 1000 : tsRaw;
    } else {
      const parsedTs = Date.parse(String(tsRaw));
      tsMs = Number.isFinite(parsedTs) ? parsedTs : Date.now();
    }
    const sourceRef = `transcript:${sessionUuid}#${i + 1}`;
    try {
      const result = insertStmt.run(tsMs, role, cleaned, sourceRef, sessionUuid);
      if (result.changes > 0) count += 1;
    } catch {}
  }
  return count;
}

function getBrowserPath() {
  const paths = [
    process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return paths.find(p => existsSync(p)) || null;
}

function getCenteredWindowPosition() {
  if (!isWin) return null;
  const script = [
    "[void][Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')",
    "$a=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea",
    'Write-Output "$($a.X),$($a.Y),$($a.Width),$($a.Height)"',
  ].join(';');
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) return null;
    const [x, y, width, height] = (result.stdout || '').trim().split(',').map(Number);
    if ([x, y, width, height].some(Number.isNaN)) return null;
    return {
      x: Math.max(0, Math.round(x + ((width - APP_WIDTH) / 2))),
      y: Math.max(0, Math.round(y + ((height - APP_HEIGHT) / 2))),
    };
  } catch {
    return null;
  }
}

function openAppWindow() {
  const appUrl = `http://localhost:${PORT}`;

  if (isWin) {
    const browser = getBrowserPath();
    if (browser) {
      const args = [
        `--app=${appUrl}`,
        `--window-size=${APP_WIDTH},${APP_HEIGHT}`,
      ];
      const position = getCenteredWindowPosition();
      if (position) args.push(`--window-position=${position.x},${position.y}`);
      try {
        const child = spawn(browser, args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
        return true;
      } catch {}
    }
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `Start-Process "${appUrl}"`], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
    return true;
  }

  if (process.platform === 'darwin') {
    exec(`open "${appUrl}"`);
    return true;
  }

  exec(`xdg-open "${appUrl}"`);
  return true;
}

// -- Merge logic --

function mergeConfig(existing, data) {
  const config = { ...existing };

  config.backend = 'discord';

  if (data.discord) {
    config.discord = { ...config.discord };
    if (data.discord.token) config.discord.token = data.discord.token;
    if (data.discord.applicationId) config.discord.applicationId = data.discord.applicationId;
  }

  if (data.channelsConfig) config.channelsConfig = data.channelsConfig;
  if (data.mainChannel) config.mainChannel = data.mainChannel;
  if (data.access) config.access = data.access;
  if (data.voice) config.voice = data.voice;
  if (data.schedules) config.schedules = data.schedules;
  if (data.proactive) config.proactive = data.proactive;
  if (data.webhook) config.webhook = data.webhook;

  return config;
}

// -- CLI check --

function checkCli(name) {
  return new Promise(resolve => {
    const cmd = isWin ? `where ${name}` : `which ${name}`;
    exec(cmd, { windowsHide: true }, (err, stdout) => {
      if (err || !stdout.trim()) resolve({ installed: false });
      else resolve({ installed: true, path: stdout.trim().split(/\r?\n/)[0] });
    });
  });
}

// -- HTTP body reader --
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// -- Server --
let openGeneration = 0;
let windowOpen = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Proactive feedback CRUD
  const FEEDBACK_PATH = join(DATA_DIR, 'proactive-feedback.json');
  if (req.method === 'GET' && path === '/proactive-feedback') {
    try {
      const data = readJsonFile(FEEDBACK_PATH);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries: data.entries || [] }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries: [] }));
    }
    return;
  }
  if (req.method === 'DELETE' && path === '/proactive-feedback') {
    const body = await readBody(req);
    const data = readJsonFile(FEEDBACK_PATH);
    const entries = data.entries || [];
    if (typeof body.index === 'number' && body.index >= 0 && body.index < entries.length) {
      entries.splice(body.index, 1);
      writeJsonFile(FEEDBACK_PATH, { entries });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === 'PUT' && path === '/proactive-feedback') {
    const body = await readBody(req);
    const data = readJsonFile(FEEDBACK_PATH);
    const entries = data.entries || [];
    if (typeof body.index === 'number' && typeof body.text === 'string') {
      entries[body.index] = body.text;
      writeJsonFile(FEEDBACK_PATH, { entries });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(HTML_PATH, 'utf8'));
    return;
  }

  // Phase D-2 — Smart Bridge cache dashboard (provider × profile matrix).
  // Each profile exposes one `shards` map keyed by provider so the UI can
  // show, for example, that `sub-task` is warm on anthropic-oauth but cold
  // on openai-oauth without either row overwriting the other.
  if (req.method === 'GET' && path === '/bridge/stats') {
    try {
      const { CacheRegistry } = await import('../src/agent/orchestrator/smart-bridge/registry.mjs');
      const { BUILTIN_PROFILES } = await import('../src/agent/orchestrator/smart-bridge/profiles.mjs');
      const registry = CacheRegistry.shared();
      const stats = registry.getStats();
      const now = Date.now();
      const profiles = {};
      let warmShards = 0;
      const packShards = (profileId) => {
        const providers = registry.data.profiles[profileId] || {};
        const shards = {};
        for (const [provider, entry] of Object.entries(providers)) {
          const hit = entry.hitCount || 0;
          const miss = entry.missCount || 0;
          const total = hit + miss;
          const warm = (entry.expiresAt || 0) > now;
          if (warm) warmShards += 1;
          shards[provider] = {
            prefixHash: entry.prefixHash || null,
            hitCount: hit,
            missCount: miss,
            hitRate: total > 0 ? hit / total : 0,
            warm,
            expiresInMs: Math.max(0, (entry.expiresAt || 0) - now),
            createdAt: entry.createdAt ? new Date(entry.createdAt).toISOString() : null,
          };
        }
        return shards;
      };
      const seen = new Set();
      for (const [id, profile] of Object.entries(BUILTIN_PROFILES)) {
        seen.add(id);
        profiles[id] = {
          id,
          taskType: profile.taskType,
          behavior: profile.behavior || null,
          fallbackPreset: profile.fallbackPreset,
          description: profile.description,
          shards: packShards(id),
        };
      }
      for (const id of Object.keys(registry.data.profiles || {})) {
        if (seen.has(id)) continue;
        profiles[id] = {
          id,
          taskType: null,
          behavior: null,
          fallbackPreset: null,
          description: '(user profile)',
          shards: packShards(id),
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        profileCount: Object.keys(profiles).length,
        shardCount: stats.shardCount || 0,
        warmShardCount: warmShards,
        openaiKeyCount: stats.openaiKeyCount || 0,
        updatedAt: registry.data.updatedAt,
        profiles,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
    return;
  }

  if (req.method === 'GET' && path === '/config') {
    const config = readConfig();
    const bot = readJsonFile(BOT_PATH);
    config._bot = bot;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  if (req.method === 'POST' && path === '/config') {
    const data = await readBody(req);

    const botData = data._bot;
    delete data._bot;

    const existing = readConfig();
    const merged = mergeConfig(existing, data);
    writeConfig(merged);
    console.log('  Config saved: channels');

    if (botData) {
      const existingBot = readJsonFile(BOT_PATH);
      writeJsonFile(BOT_PATH, { ...existingBot, ...botData });
      console.log('  Config saved: bot.json');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

// -- B6 General module toggles (channels / memory / search / agent) --
  // Stored as a top-level `modules` section inside mixdog-config.json.
  // Missing keys default to enabled:true so pre-B6 configs keep all
  // modules on. Changes require a plugin restart to take effect.
  if (req.method === 'GET' && path === '/modules') {
    const tribCfg = readJsonFile(MIXDOG_CONFIG_PATH);
    const raw = tribCfg && typeof tribCfg === 'object' ? tribCfg.modules : null;
    const out = {};
    for (const name of ['channels', 'memory', 'search', 'agent']) {
      const entry = raw && typeof raw === 'object' ? raw[name] : null;
      const enabled = entry && typeof entry === 'object' && entry.enabled === false ? false : true;
      out[name] = { enabled };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }

  if (req.method === 'POST' && path === '/modules') {
    const data = await readBody(req);
    const tribCfg = readJsonFile(MIXDOG_CONFIG_PATH) || {};
    const sanitized = {};
    for (const name of ['channels', 'memory', 'search', 'agent']) {
      const entry = data && typeof data === 'object' ? data[name] : null;
      const enabled = entry && typeof entry === 'object' && entry.enabled === false ? false : true;
      sanitized[name] = { enabled };
    }
    tribCfg.modules = sanitized;
    writeJsonFile(MIXDOG_CONFIG_PATH, tribCfg);
    console.log('  Config saved: modules');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, modules: sanitized }));
    return;
  }

  // -- B2 Security capabilities (homeAccess) ---------------------------
  // Stored as a top-level `capabilities` section inside mixdog-config.json.
  // Missing keys default to `false` so out-of-the-box installs stay
  // cwd-only; flipping a toggle takes effect on the next tool call
  // (capability is re-read per invocation in builtin.mjs/patch.mjs).
  if (req.method === 'GET' && path === '/capabilities') {
    const tribCfg = readJsonFile(MIXDOG_CONFIG_PATH);
    const raw = tribCfg && typeof tribCfg === 'object' ? tribCfg.capabilities : null;
    const out = { homeAccess: !!(raw && typeof raw === 'object' && raw.homeAccess === true) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }

  if (req.method === 'POST' && path === '/capabilities') {
    const data = await readBody(req);
    const tribCfg = readJsonFile(MIXDOG_CONFIG_PATH) || {};
    const sanitized = { homeAccess: !!(data && typeof data === 'object' && data.homeAccess === true) };
    tribCfg.capabilities = sanitized;
    writeJsonFile(MIXDOG_CONFIG_PATH, tribCfg);
    console.log('  Config saved: capabilities');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, capabilities: sanitized }));
    return;
  }

  // -- Schedules CRUD --
  const SCHEDULES_DIR = join(DATA_DIR, 'schedules');

  if (req.method === 'GET' && path === '/schedules') {
    const result = [];
    if (existsSync(SCHEDULES_DIR)) {
      for (const name of readdirSync(SCHEDULES_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
        const cfg = readJsonFile(join(SCHEDULES_DIR, name, 'config.json')) || {};
        let prompt = '';
        try { prompt = readFileSync(join(SCHEDULES_DIR, name, 'prompt.md'), 'utf8'); } catch {}
        result.push({ name, ...cfg, prompt });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === 'POST' && path === '/schedules') {
    const sc = await readBody(req);
    if (!sc.name) { res.writeHead(400); res.end('name required'); return; }
    const dir = join(SCHEDULES_DIR, sc.name);
    mkdirSync(dir, { recursive: true });
    const prompt = sc.prompt || '';
    delete sc.prompt;
    const name = sc.name;
    delete sc.name;
    writeFileSync(join(dir, 'config.json'), JSON.stringify(sc, null, 2));
    writeFileSync(join(dir, 'prompt.md'), prompt);
    console.log('  Schedule saved:', name);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'DELETE' && path === '/schedules') {
    const name = url.searchParams.get('name');
    if (!name) { res.writeHead(400); res.end('name required'); return; }
    const dir = join(SCHEDULES_DIR, name);
    if (existsSync(dir)) { rmSync(dir, { recursive: true }); console.log('  Schedule deleted:', name); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path.startsWith('/schedules/file/')) {
    const name = decodeURIComponent(path.slice('/schedules/file/'.length));
    const filePath = join(SCHEDULES_DIR, name, 'prompt.md');
    if (!existsSync(filePath)) { mkdirSync(join(SCHEDULES_DIR, name), { recursive: true }); writeFileSync(filePath, '', 'utf8'); }
    if (isWin) { spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
    else { spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // -- Webhooks CRUD --
  const WEBHOOKS_DIR = join(DATA_DIR, 'webhooks');

  if (req.method === 'GET' && path === '/webhooks') {
    const result = [];
    if (existsSync(WEBHOOKS_DIR)) {
      for (const name of readdirSync(WEBHOOKS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
        const cfg = readJsonFile(join(WEBHOOKS_DIR, name, 'config.json')) || {};
        let instructions = '';
        try { instructions = readFileSync(join(WEBHOOKS_DIR, name, 'instructions.md'), 'utf8'); } catch {}
        result.push({ name, ...cfg, instructions });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === 'POST' && path === '/webhooks') {
    const wh = await readBody(req);
    if (!wh.name) { res.writeHead(400); res.end('name required'); return; }
    const dir = join(WEBHOOKS_DIR, wh.name);
    mkdirSync(dir, { recursive: true });
    const instructions = wh.instructions || '';
    delete wh.instructions;
    const name = wh.name;
    delete wh.name;
    writeFileSync(join(dir, 'config.json'), JSON.stringify(wh, null, 2));
    writeFileSync(join(dir, 'instructions.md'), instructions);
    console.log('  Webhook saved:', name);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'DELETE' && path === '/webhooks') {
    const name = url.searchParams.get('name');
    if (!name) { res.writeHead(400); res.end('name required'); return; }
    const dir = join(WEBHOOKS_DIR, name);
    if (existsSync(dir)) { rmSync(dir, { recursive: true }); console.log('  Webhook deleted:', name); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path.startsWith('/webhooks/file/')) {
    const name = decodeURIComponent(path.slice('/webhooks/file/'.length));
    const filePath = join(WEBHOOKS_DIR, name, 'instructions.md');
    if (!existsSync(filePath)) { mkdirSync(join(WEBHOOKS_DIR, name), { recursive: true }); writeFileSync(filePath, '', 'utf8'); }
    if (isWin) { spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
    else { spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/cli-check') {
    // whisper: consider installed if mixdog-config.json has a valid voice.command
    // that points to an existing file (replaces the old pip-whisper PATH check).
    const voiceCfg = (() => {
      try { return readJsonFile(MIXDOG_CONFIG_PATH)?.voice || {}; } catch { return {}; }
    })();
    const whisperInstalled = typeof voiceCfg.command === 'string' && voiceCfg.command.length > 0 && existsSync(voiceCfg.command);
    const ngrok = await checkCli('ngrok');
    const cliPayload = { whisper: { installed: whisperInstalled }, ngrok };
    if (whisperInstalled) cliPayload._voiceCfg = { command: voiceCfg.command, model: voiceCfg.model || '' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cliPayload));
    return;
  }

  // ============================================================
  // AGENT MODULE ROUTES
  // ============================================================

  if (req.method === 'GET' && path === '/agent/config') {
    const config = readAgentConfig();
    const auth = await detectAuth(config);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ config, auth }));
    return;
  }

  if (req.method === 'POST' && path === '/agent/config') {
    const data = await readBody(req);
    const existing = readAgentConfig();
    const merged = mergeAgentConfig(existing, data);
    writeAgentConfig(merged);
    console.log('  Config saved: agent');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/agent/presets') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ presets: readAgentPresets() }));
    return;
  }

  if (req.method === 'POST' && path === '/agent/presets') {
    const data = await readBody(req);
    let preset;
    try { preset = normalizePreset(data); }
    catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return;
    }
    const list = readAgentPresets();
    const idx = list.findIndex(p => p.id === preset.id);
    if (idx >= 0) list[idx] = preset; else list.push(preset);
    writeAgentPresets(list);
    console.log(`  Agent preset saved: ${preset.id}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, preset }));
    return;
  }

  if (req.method === 'DELETE' && path === '/agent/presets') {
    const id = url.searchParams.get('id');
    if (!id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'id required' })); return; }
    const list = readAgentPresets().filter(p => p.id !== id);
    writeAgentPresets(list);
    console.log(`  Agent preset deleted: ${id}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // -- Agent maintenance presets --
  if (req.method === 'GET' && path === '/agent/maintenance') {
    const cfg = readAgentConfig();
    const merged = { ...DEFAULT_MAINTENANCE, ...(cfg.maintenance || {}) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ maintenance: merged, defaults: { ...DEFAULT_MAINTENANCE } }));
    return;
  }

  if (req.method === 'POST' && path === '/agent/maintenance') {
    const data = await readBody(req);
    const cfg = readAgentConfig();
    const validIds = new Set((cfg.presets || []).map(p => p.id));
    const invalid = Object.entries(data)
      .filter(([k, v]) => k !== 'defaultPreset' && v && !validIds.has(v))
      .map(([k, v]) => `${k}: ${v}`);
    if (invalid.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `Unknown preset(s): ${invalid.join(', ')}` }));
      return;
    }
    if (data.defaultPreset && !validIds.has(data.defaultPreset)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `Unknown default preset: ${data.defaultPreset}` }));
      return;
    }
    cfg.maintenance = { ...(cfg.maintenance || {}), ...data };
    writeAgentConfig(cfg);
    console.log('  Maintenance presets saved');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/agent/models') {
    const provider = url.searchParams.get('provider');
    if (!provider) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'provider required' })); return; }
    const cfg = readAgentConfig();
    const models = await listProviderModels(provider, cfg);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, provider, models }));
    return;
  }

  if (req.method === 'POST' && path === '/agent/validate') {
    const data = await readBody(req);
    const validation = {};
    const checks = [];
    for (const [id, key] of Object.entries(data.keys || {})) {
      if (key) checks.push(validateAgentKey(id, key).then(r => { validation[id] = r; }));
    }
    await Promise.all(checks);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, validation }));
    return;
  }

  // -- Agent learning config --

  if (req.method === 'GET' && path === '/agent/learning') {
    const cfg = readAgentConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      trajectory: { enabled: true, ...cfg.trajectory },
      skillSuggest: { autoDetect: true, ...cfg.skillSuggest },
      agentMaintenance: { enabled: true, interval: '1h', ...cfg.agentMaintenance },
    }));
    return;
  }

  if (req.method === 'POST' && path === '/agent/learning') {
    const data = await readBody(req);
    const existing = readAgentConfig();
    if (data.trajectory) existing.trajectory = { ...(existing.trajectory || {}), ...data.trajectory };
    if (data.skillSuggest) existing.skillSuggest = { ...(existing.skillSuggest || {}), ...data.skillSuggest };
    if (data.agentMaintenance) existing.agentMaintenance = { ...(existing.agentMaintenance || {}), ...data.agentMaintenance };
    writeAgentConfig(existing);
    console.log('  Config saved: agent learning');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ============================================================
  // MEMORY MODULE ROUTES
  // ============================================================

  if (req.method === 'GET' && path === '/memory/config') {
    const config = readMemoryConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  if (req.method === 'POST' && path === '/memory/config') {
    const data = await readBody(req);
    const existing = readMemoryConfig();
    const merged = mergeMemoryConfig(existing, data);
    writeMemoryConfig(merged);
    console.log('  Config saved: memory');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/memory/auth') {
    const cfg = readMemoryConfig();
    const result = await detectAuth(cfg);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === 'GET' && path === '/memory/presets') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ presets: readMemoryPresets() }));
    return;
  }

  if (req.method === 'POST' && path === '/memory/presets') {
    const data = await readBody(req);
    let preset;
    try { preset = normalizePreset(data); }
    catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return;
    }
    const list = readMemoryPresets();
    const idx = list.findIndex(p => p.id === preset.id);
    if (idx >= 0) list[idx] = preset; else list.push(preset);
    writeMemoryPresets(list);
    console.log(`  Memory preset saved: ${preset.id}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, preset }));
    return;
  }

  if (req.method === 'PUT' && path === '/memory/presets') {
    const data = await readBody(req);
    if (!Array.isArray(data.presets)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'presets array required' }));
      return;
    }
    const normalized = data.presets.map(p => normalizePreset(p));
    writeMemoryPresets(normalized);
    console.log(`  Memory presets reordered: ${normalized.length} items`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'DELETE' && path === '/memory/presets') {
    const id = url.searchParams.get('id');
    if (!id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'id required' })); return; }
    const list = readMemoryPresets().filter(p => p.id !== id);
    writeMemoryPresets(list);
    console.log(`  Memory preset deleted: ${id}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/memory/models') {
    const provider = url.searchParams.get('provider');
    if (!provider) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'provider required' })); return; }
    const cfg = readMemoryConfig();
    const models = await listProviderModels(provider, cfg);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, provider, models }));
    return;
  }
  // /memory/files endpoints removed in v0.6.72 — bot.md / user.md surfaces
  // are no longer part of the data dir. The Config UI edits memory-config.json
  // directly; past-fact surfaces live in memory.sqlite.

  if (req.method === 'GET' && path === '/api/memory/entries/active') {
    try {
      const db = openMemoryDb(true);
      const rows = db.prepare(`
        SELECT id, element, category, summary, score, last_seen_at
        FROM entries
        WHERE is_root = 1 AND status = 'active'
        ORDER BY score DESC
      `).all();
      db.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, items: rows }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  {
    const statusMatch = req.method === 'POST' && path.match(/^\/api\/memory\/entries\/(\d+)\/status$/);
    if (statusMatch) {
      const id = Number(statusMatch[1]);
      const data = await readBody(req);
      const VALID = ['active', 'pending', 'demoted', 'processed', 'archived'];
      const status = String(data.status ?? '').trim().toLowerCase();
      if (!Number.isInteger(id) || id <= 0 || !VALID.includes(status)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'valid id and status required' }));
        return;
      }
      try {
        const db = openMemoryDb();
        const result = db.prepare(
          'UPDATE entries SET status = ? WHERE id = ? AND is_root = 1'
        ).run(status, id);
        db.close();
        console.log(`  Entry #${id} → ${status} (changes=${result.changes})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, changes: Number(result.changes ?? 0) }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
  }

  if (req.method === 'POST' && path === '/api/memory/entries') {
    const data = await readBody(req);
    const element = String(data.element ?? '').trim();
    const summary = String(data.summary ?? '').trim();
    const category = String(data.category ?? 'fact').trim().toLowerCase();
    const VALID_CATS = ['rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue'];
    if (!element || !summary || !VALID_CATS.includes(category)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'element, summary, and valid category required' }));
      return;
    }
    const GRADE = { rule: 2.0, constraint: 1.9, decision: 1.8, fact: 1.6, goal: 1.5, preference: 1.4, task: 1.1, issue: 1.0 };
    const nowMs = Date.now();
    const sourceRef = `manual:${nowMs}-${process.pid}`;
    try {
      const db = openMemoryDb();
      db.exec('BEGIN');
      try {
        const result = db.prepare(`
          INSERT INTO entries(ts, role, content, source_ref, session_id)
          VALUES (?, 'system', ?, ?, NULL)
        `).run(nowMs, element + ' — ' + summary, sourceRef);
        const newId = Number(result.lastInsertRowid);
        db.prepare(`
          UPDATE entries
          SET chunk_root = ?, is_root = 1, element = ?, category = ?, summary = ?,
              status = 'active', score = ?, last_seen_at = ?
          WHERE id = ?
        `).run(newId, element, category, summary, GRADE[category], nowMs, newId);
        db.exec('COMMIT');
        await syncRootEmbedding(db, newId);
        console.log(`  Remembered entry #${newId}: [${category}] ${element}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: newId }));
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        throw e;
      } finally {
        db.close();
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (req.method === 'POST' && path === '/memory/backfill') {
    if (_backfillInProgress) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'backfill already in progress' }));
      return;
    }
    const data = await readBody(req);
    const requestedWindow = data.window || '7d';
    _backfillInProgress = true;
    let db;
    try {
      db = openMemoryDb();
      try { db.exec('PRAGMA busy_timeout = 30000'); } catch {}
      const memoryConfig = readMemoryConfig() || {};
      console.log(`[backfill] start window=${requestedWindow}`);
      const result = await runFullBackfill(db, {
        window: requestedWindow,
        scope: 'all',
        config: memoryConfig,
        ingestTranscriptFile: (fp) => ingestTranscriptForBackfill(db, fp),
        runCycle1,
        runCycle2,
      });
      console.log(`[backfill] done files=${result.files} ingested=${result.ingested} cycle1_iters=${result.cycle1_iters} promoted=${result.promoted} unclassified=${result.unclassified}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      console.error(`[backfill] failed: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    } finally {
      try { db?.close?.(); } catch {}
      _backfillInProgress = false;
    }
    return;
  }

  if (req.method === 'POST' && path === '/memory/delete') {
    const data = await readBody(req);
    if (data?.confirm !== 'DELETE ALL MEMORY') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'confirm must be exactly "DELETE ALL MEMORY"' }));
      return;
    }
    let db;
    try {
      db = openMemoryDb();
      db.exec('PRAGMA busy_timeout = 30000');
      const preCount = db.prepare('SELECT COUNT(*) c FROM entries').get().c;
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM entries').run();
        try { db.prepare('DELETE FROM entries_fts').run(); } catch {}
        try { db.prepare('DELETE FROM vec_entries').run(); } catch {}
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        throw e;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deleted: preCount }));
    } catch (err) {
      console.error(`[memory delete] failed: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    } finally {
      try { db?.close?.(); } catch {}
    }
    return;
  }

  if (req.method === 'POST' && path === '/memory/validate') {
    const data = await readBody(req);
    const validation = {};
    const checks = [];
    for (const [id, key] of Object.entries(data.keys || {})) {
      if (key) checks.push(validateAgentKey(id, key).then(r => { validation[id] = r; }));
    }
    await Promise.all(checks);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, validation }));
    return;
  }

  // ============================================================
  // SEARCH MODULE ROUTES
  // ============================================================

  if (req.method === 'GET' && path === '/search/config') {
    const config = readSearchConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  if (req.method === 'POST' && path === '/search/config') {
    const data = await readBody(req);
    const existing = readSearchConfig();
    const merged = mergeSearchConfig(existing, data);
    writeSearchConfig(merged);
    console.log('  Config saved: search');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && path === '/search/validate') {
    const data = await readBody(req);
    const validation = {};
    const checks = [];
    for (const [id, val] of Object.entries(data.searchProviders || {})) {
      const key = typeof val === 'object' ? val.key : val;
      if (key) checks.push(validateSearchKey(id, key).then(r => { validation[id] = r; }));
    }
    for (const [id, val] of Object.entries(data.aiProviders || {})) {
      if (val && val !== 'cli') checks.push(validateSearchKey(id, val).then(r => { validation[id] = r; }));
    }
    if (data.github) checks.push(validateSearchKey('github', data.github).then(r => { validation.github = r; }));
    await Promise.all(checks);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, validation }));
    return;
  }

  if (req.method === 'GET' && path === '/search/cli-check') {
    const check = (cmd) => {
      try { execSync(`${cmd} --version`, { stdio: 'pipe', timeout: 5000, windowsHide: true }); return true; }
      catch { return false; }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ codex: check('codex'), claude: check('claude'), gemini: check('gemini') }));
    return;
  }

  // ============================================================
  // CHANNELS MODULE ROUTES (continued)
  // ============================================================

  if (req.method === 'POST' && path === '/install') {
    const data = await readBody(req);
    const tool = data.tool;
    if (!tool || !['ngrok'].includes(tool)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid tool' }));
      return;
    }
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        exec('npm install -g ngrok', { timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        });
      });
      console.log(`  Installed ${tool}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tool, output: stdout.trim() }));
    } catch (e) {
      console.log(`  Install ${tool} failed: ${e.message}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, tool, error: e.message }));
    }
    return;
  }

  // Accept both POST (legacy) and GET?stream=1 (SSE) for /install/voice
  const _voiceUrl = new URL(req.url, 'http://localhost');
  const isVoiceSSE  = (req.method === 'GET'  && _voiceUrl.pathname === '/install/voice' && _voiceUrl.searchParams.get('stream') === '1');
  const isVoicePOST = (req.method === 'POST' && path === '/install/voice');

  if (isVoicePOST || isVoiceSSE) {
    // One-click whisper.cpp + turbo model installer.
    // Detects platform (win32 / darwin / linux), installs binary + model, writes config.
    // Supports SSE streaming (GET ?stream=1) and legacy JSON POST.

    const _sseActive = isVoiceSSE;

    // SSE: flush headers immediately so the browser EventSource connects
    if (_sseActive) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.flushHeaders();
    }

    /** Emit an SSE event (noop in legacy POST mode). */
    const emitSSE = (eventName, data) => {
      if (!_sseActive) return;
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    /** Emit a stage transition event. */
    const emitStage = (stage, message) => emitSSE('stage', { stage, message });

    const send = (payload) => {
      if (_sseActive) {
        if (payload.ok === false) {
          emitSSE('error', payload);
        } else {
          emitSSE('done', payload);
        }
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      }
    };

    const os_platform = platform(); // 'win32' | 'darwin' | 'linux'
    const os_arch = arch();         // 'x64' | 'arm64' | ...

    // ── Resolve shared paths ─────────────────────────────────────────────────
    const voiceDir = join(DATA_DIR, 'voice');
    const modelDir = join(voiceDir, 'models');
    mkdirSync(modelDir, { recursive: true });

    const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin';

    // ── Shared helpers ───────────────────────────────────────────────────────

    /** Spawn binary with --help; exit 0 or 1 both count (whisper-cli exits 1 on --help). */
    const smokeTestWhisper = (binPath) => new Promise((resolve) => {
      const child = spawn(binPath, ['--help'], { stdio: 'pipe', windowsHide: true });
      child.on('close', (code) => resolve(code === 0 || code === 1));
      child.on('error', () => resolve(false));
      setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, 10000);
    });

    /** Download a URL to destPath, following redirects.
     *  Optional onProgress({bytes, total, speed}) called at most every 200ms.
     */
    const downloadFile = (url, destPath, onProgress) => new Promise((resolve, reject) => {
      const doGet = (u) => {
        https.get(u, { headers: { 'User-Agent': 'mixdog/0.1.13' } }, (resp) => {
          if (resp.statusCode === 301 || resp.statusCode === 302 || resp.statusCode === 303 || resp.statusCode === 307 || resp.statusCode === 308) {
            return doGet(resp.headers.location);
          }
          if (resp.statusCode !== 200) return reject(new Error(`HTTP ${resp.statusCode} from ${u}`));
          const total = parseInt(resp.headers['content-length'] || '0', 10) || 0;
          let bytes = 0;
          let lastProgressTime = Date.now();
          let lastProgressBytes = 0;
          const ws = createWriteStream(destPath);
          resp.on('data', (chunk) => {
            bytes += chunk.length;
            if (onProgress) {
              const now = Date.now();
              const elapsed = now - lastProgressTime;
              if (elapsed >= 200) {
                const speed = elapsed > 0 ? Math.round((bytes - lastProgressBytes) / (elapsed / 1000)) : 0;
                onProgress({ bytes, total, speed });
                lastProgressTime = now;
                lastProgressBytes = bytes;
              }
            }
          });
          resp.pipe(ws);
          ws.on('finish', () => {
            if (onProgress) onProgress({ bytes, total, speed: 0 });
            resolve();
          });
          ws.on('error', reject);
          resp.on('error', reject);
        }).on('error', reject);
      };
      doGet(url);
    });

    /**
     * Download ggml-large-v3-turbo.bin into <dataDir>/voice/models/.
     * Idempotent: skips if file already exists and is > 100 MB.
     * Optional onProgress({bytes,total,speed}) callback throttled to 200ms.
     * Returns absolute model path.
     */
    const downloadModelToDataDir = async (onProgress) => {
      const modelPath = join(modelDir, 'ggml-large-v3-turbo.bin');
      const MIN_MODEL_BYTES = 100 * 1024 * 1024; // 100 MB sanity threshold
      if (existsSync(modelPath)) {
        const { statSync } = await import('fs');
        if (statSync(modelPath).size > MIN_MODEL_BYTES) {
          console.log('  [voice-install] model already present, skipping download.');
          return modelPath;
        }
      }
      console.log('  [voice-install] downloading ggml-large-v3-turbo.bin (~1.5 GB)...');
      await downloadFile(MODEL_URL, modelPath, onProgress);
      return modelPath;
    };

    /** Merge whisperPath + modelPath into mixdog-config.json voice section. */
    const writeVoiceConfig = (whisperPath, modelPath) => {
      const tribCfg = readJsonFile(MIXDOG_CONFIG_PATH) || {};
      tribCfg.voice = { ...(tribCfg.voice || {}), command: whisperPath, model: modelPath };
      writeJsonFile(MIXDOG_CONFIG_PATH, tribCfg);
    };

    // ── Windows branch ───────────────────────────────────────────────────────
    if (os_platform === 'win32') {
      if (os_arch !== 'x64') {
        return send({
          ok: false,
          stage: 'platform-check',
          error: `Windows ${os_arch} is not supported. Only x64 is available via Purfview portable builds.`,
        });
      }

      const binDir = join(voiceDir, 'whisper.cpp');
      mkdirSync(binDir, { recursive: true });

      // ── Purfview tag: try GitHub releases API, fall back to known-good tag ──
      const FALLBACK_PURFVIEW_TAG = 'r245.5';
      const WHISPER_WIN_ASSET = 'Whisper-faster-v3-portable.zip';
      const whisperBinName = 'whisper-faster.exe';
      const whisperBinPath = join(binDir, whisperBinName);

      // Idempotency
      const existingModelPath = join(modelDir, 'ggml-large-v3-turbo.bin');
      if (existsSync(whisperBinPath) && existsSync(existingModelPath)) {
        const ok = await smokeTestWhisper(whisperBinPath);
        if (ok) {
          writeVoiceConfig(whisperBinPath, existingModelPath);
          return send({ ok: true, whisperPath: whisperBinPath, modelPath: existingModelPath, skipped: true });
        }
      }

      // Resolve Purfview release tag dynamically
      emitStage('purfview-lookup', 'Looking up latest Purfview release tag…');
      let WHISPER_WIN_TAG = FALLBACK_PURFVIEW_TAG;
      try {
        const tagJson = await new Promise((resolve, reject) => {
          const apiReq = https.get(
            'https://api.github.com/repos/Purfview/whisper-standalone-win/releases/latest',
            {
              headers: {
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'mixdog/0.1.13',
              },
            },
            (resp) => {
              if (resp.statusCode !== 200) {
                resp.resume();
                return reject(new Error(`GitHub API returned HTTP ${resp.statusCode}`));
              }
              let body = '';
              resp.on('data', (c) => { body += c; });
              resp.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
              });
              resp.on('error', reject);
            }
          );
          apiReq.on('error', reject);
          apiReq.setTimeout(5000, () => {
            apiReq.destroy();
            reject(new Error('GitHub API request timed out after 5s'));
          });
        });
        if (tagJson && typeof tagJson.tag_name === 'string' && tagJson.tag_name) {
          WHISPER_WIN_TAG = tagJson.tag_name;
          console.log(`  [voice-install] resolved Purfview tag: ${WHISPER_WIN_TAG}`);
        } else {
          throw new Error('tag_name missing from GitHub API response');
        }
      } catch (tagErr) {
        process.stderr.write(`[voice-install] Purfview tag lookup failed (${tagErr.message}); using fallback tag ${FALLBACK_PURFVIEW_TAG}\n`);
        WHISPER_WIN_TAG = FALLBACK_PURFVIEW_TAG;
      }

      const binaryUrl = `https://github.com/Purfview/whisper-standalone-win/releases/download/${WHISPER_WIN_TAG}/${WHISPER_WIN_ASSET}`;

      // Download binary archive
      const archivePath = join(binDir, 'whisper-download.zip');
      emitStage('purfview-download', `Downloading Purfview ${WHISPER_WIN_TAG}…`);
      try {
        console.log(`  [voice-install] downloading whisper binary from ${binaryUrl}`);
        await downloadFile(binaryUrl, archivePath);
      } catch (e) {
        return send({ ok: false, stage: 'download-binary', error: e.message });
      }

      // Extract
      emitStage('purfview-extract', 'Extracting Purfview archive…');
      try {
        execSync(
          `powershell -NoProfile -Command "Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${binDir}'"`,
          { stdio: 'pipe', windowsHide: true, timeout: 60000 }
        );
        try { rmSync(archivePath); } catch {}
      } catch (e) {
        return send({ ok: false, stage: 'extract-binary', error: e.message });
      }

      if (!existsSync(whisperBinPath)) {
        try {
          const entries = readdirSync(binDir);
          const exeEntry = entries.find(f => f.endsWith('.exe') || f === 'whisper-cli' || f === 'whisper');
          if (exeEntry && exeEntry !== whisperBinName) renameSync(join(binDir, exeEntry), whisperBinPath);
        } catch {}
        if (!existsSync(whisperBinPath)) {
          return send({ ok: false, stage: 'extract-binary', error: `Binary not found after extraction. Expected: ${whisperBinName}` });
        }
      }

      // Download model
      emitStage('download-model', 'Downloading turbo model (~1.5 GB)…');
      let resolvedModelPath;
      try {
        resolvedModelPath = await downloadModelToDataDir((p) => emitSSE('progress', { stage: 'download-model', ...p }));
      } catch (e) {
        return send({ ok: false, stage: 'download-model', error: e.message });
      }

      // Smoke test
      emitStage('smoke-test', 'Running smoke test…');
      const smokeOk = await smokeTestWhisper(whisperBinPath);
      if (!smokeOk) {
        return send({ ok: false, stage: 'smoke-test', error: 'Binary failed smoke test (--help returned non-zero or timed out).' });
      }

      emitStage('write-config', 'Writing voice config…');
      writeVoiceConfig(whisperBinPath, resolvedModelPath);
      console.log(`  [voice-install] done. binary=${whisperBinPath} model=${resolvedModelPath}`);
      return send({ ok: true, whisperPath: whisperBinPath, modelPath: resolvedModelPath });
    }

    // ── macOS branch ─────────────────────────────────────────────────────────
    if (os_platform === 'darwin') {
      // 1. Probe for Homebrew
      emitStage('brew-check', 'Checking for Homebrew…');
      let brewPath;
      try {
        brewPath = execSync('which brew', { stdio: 'pipe', timeout: 5000 }).toString().trim();
      } catch {
        brewPath = null;
      }
      if (!brewPath) {
        return send({
          ok: false,
          stage: 'brew-check',
          error: 'Homebrew not found. Install from https://brew.sh first, then click Install again.',
        });
      }

      // Idempotency: check if whisper-cli already installed and model present
      let existingBrewPrefix = null;
      try {
        existingBrewPrefix = execSync('brew --prefix whisper-cpp', { stdio: 'pipe', timeout: 10000 }).toString().trim();
      } catch { /* not installed yet */ }

      const existingBin = existingBrewPrefix ? join(existingBrewPrefix, 'bin', 'whisper-cli') : null;
      const existingModelPath = join(modelDir, 'ggml-large-v3-turbo.bin');
      if (existingBin && existsSync(existingBin) && existsSync(existingModelPath)) {
        const ok = await smokeTestWhisper(existingBin);
        if (ok) {
          writeVoiceConfig(existingBin, existingModelPath);
          return send({ ok: true, whisperPath: existingBin, modelPath: existingModelPath, skipped: true });
        }
      }

      // 2. brew install whisper-cpp (already-installed is fine)
      emitStage('brew-install', 'Running brew install whisper-cpp…');
      try {
        console.log('  [voice-install] running: brew install whisper-cpp');
        execSync('brew install whisper-cpp', { stdio: 'pipe', timeout: 600000 }); // 10 min
      } catch (e) {
        const msg = (e.stderr || e.stdout || e.message || '').toString().slice(0, 500);
        return send({ ok: false, stage: 'brew-install', error: `brew install whisper-cpp failed: ${msg}` });
      }

      // 3. Resolve binary path via brew --prefix
      emitStage('brew-prefix', 'Resolving brew --prefix for whisper-cpp…');
      let brewPrefix;
      try {
        brewPrefix = execSync('brew --prefix whisper-cpp', { stdio: 'pipe', timeout: 10000 }).toString().trim();
      } catch (e) {
        return send({ ok: false, stage: 'brew-prefix', error: `Could not resolve brew prefix for whisper-cpp: ${e.message}` });
      }

      // The formula installs 'whisper-cli' as of Apr 2026.
      emitStage('brew-binary', 'Locating whisper-cli binary…');
      const whisperBinPath = join(brewPrefix, 'bin', 'whisper-cli');
      if (!existsSync(whisperBinPath)) {
        return send({ ok: false, stage: 'brew-binary', error: `whisper-cli not found at expected path: ${whisperBinPath}` });
      }

      // 4. Download model
      emitStage('download-model', 'Downloading turbo model (~1.5 GB)…');
      let resolvedModelPath;
      try {
        resolvedModelPath = await downloadModelToDataDir((p) => emitSSE('progress', { stage: 'download-model', ...p }));
      } catch (e) {
        return send({ ok: false, stage: 'download-model', error: e.message });
      }

      // 5. Smoke test
      emitStage('smoke-test', 'Running smoke test…');
      const smokeOk = await smokeTestWhisper(whisperBinPath);
      if (!smokeOk) {
        return send({ ok: false, stage: 'smoke-test', error: 'whisper-cli failed smoke test (--help returned non-zero or timed out).' });
      }

      emitStage('write-config', 'Writing voice config…');
      writeVoiceConfig(whisperBinPath, resolvedModelPath);
      console.log(`  [voice-install] done. binary=${whisperBinPath} model=${resolvedModelPath}`);
      return send({ ok: true, whisperPath: whisperBinPath, modelPath: resolvedModelPath });
    }

    // ── Linux branch ─────────────────────────────────────────────────────────
    if (os_platform === 'linux') {
      // 1. Probe for required build tools
      emitStage('build-tools-check', 'Checking for required build tools…');
      const requiredTools = ['git', 'cmake', 'make'];
      const cxxCandidates = ['g++', 'clang++'];
      const missing = [];
      for (const tool of requiredTools) {
        try { execSync(`which ${tool}`, { stdio: 'pipe', timeout: 5000 }); }
        catch { missing.push(tool); }
      }
      let cxxFound = null;
      for (const cxx of cxxCandidates) {
        try { execSync(`which ${cxx}`, { stdio: 'pipe', timeout: 5000 }); cxxFound = cxx; break; }
        catch { /* try next */ }
      }
      if (!cxxFound) missing.push('g++ (or clang++)');

      if (missing.length > 0) {
        // Detect distro from /etc/os-release for a helpful install hint
        let distroId = '';
        let distroIdLike = '';
        try {
          const osRelease = readFileSync('/etc/os-release', 'utf8');
          const idLine     = osRelease.split('\n').find(l => /^ID=/i.test(l));
          const idLikeLine = osRelease.split('\n').find(l => /^ID_LIKE=/i.test(l));
          distroId     = (idLine     || '').replace(/^ID=/i,      '').replace(/["']/g, '').trim().toLowerCase();
          distroIdLike = (idLikeLine || '').replace(/^ID_LIKE=/i, '').replace(/["']/g, '').trim().toLowerCase();
        } catch { /* ignore */ }

        const pkgNames = missing.map(t => {
          if (t === 'g++ (or clang++)') return 'g++';
          return t;
        });
        let installHint;
        if (['ubuntu', 'debian', 'linuxmint', 'pop'].includes(distroId)) {
          installHint = `sudo apt install -y ${pkgNames.join(' ')}`;
        } else if (['fedora', 'rhel', 'centos', 'rocky', 'alma'].includes(distroId)) {
          installHint = `sudo dnf install -y ${pkgNames.map(t => t === 'g++' ? 'gcc-c++' : t).join(' ')}`;
        } else if (['arch', 'manjaro', 'endeavouros'].includes(distroId)) {
          installHint = `sudo pacman -S ${pkgNames.map(t => t === 'g++' ? 'gcc' : t).join(' ')}`;
        } else if (['opensuse-leap', 'opensuse-tumbleweed', 'opensuse'].includes(distroId) || distroIdLike.includes('suse')) {
          // zypper package name may vary; whisper-cpp may not be in official repos — provide a generic hint
          installHint = `sudo zypper install ${pkgNames.map(t => t === 'g++' ? 'gcc-c++' : t).join(' ')} (then check your package manager for whisper-cpp)`;
        } else if (distroId === 'void') {
          installHint = `sudo xbps-install -S ${pkgNames.map(t => t === 'g++' ? 'gcc' : t).join(' ')}`;
        } else if (distroId === 'nixos') {
          installHint = `nix-env -iA nixpkgs.${pkgNames.map(t => t === 'g++' ? 'gcc' : t === 'cmake' ? 'cmake' : t === 'make' ? 'gnumake' : t).join(' nixpkgs.')} (declarative config preferred: add to environment.systemPackages)`;
        } else if (distroId === 'gentoo') {
          installHint = `sudo emerge ${pkgNames.map(t => t === 'g++' ? 'sys-devel/gcc' : t === 'cmake' ? 'dev-build/cmake' : t === 'make' ? 'sys-devel/make' : t === 'git' ? 'dev-vcs/git' : t).join(' ')}`;
        } else {
          installHint = `Install using your package manager: ${missing.join(', ')}`;
        }

        return send({
          ok: false,
          stage: 'build-tools-check',
          error: `Missing build tools: ${missing.join(', ')}. ${installHint}`,
        });
      }

      const srcDir = join(voiceDir, 'whisper.cpp-src');
      const whisperBinPath = join(srcDir, 'build', 'bin', 'whisper-cli');
      const existingModelPath = join(modelDir, 'ggml-large-v3-turbo.bin');

      // Idempotency
      if (existsSync(whisperBinPath) && existsSync(existingModelPath)) {
        const ok = await smokeTestWhisper(whisperBinPath);
        if (ok) {
          writeVoiceConfig(whisperBinPath, existingModelPath);
          return send({ ok: true, whisperPath: whisperBinPath, modelPath: existingModelPath, skipped: true });
        }
      }

      // 2. Clone whisper.cpp (shallow, skip if already cloned)
      if (!existsSync(join(srcDir, '.git'))) {
        emitStage('git-clone', 'Cloning whisper.cpp (shallow)…');
        try {
          console.log('  [voice-install] cloning whisper.cpp...');
          mkdirSync(voiceDir, { recursive: true });
          execSync(
            `git clone --depth 1 https://github.com/ggerganov/whisper.cpp "${srcDir}"`,
            { stdio: 'pipe', timeout: 120000 }
          );
        } catch (e) {
          const msg = (e.stderr || e.stdout || e.message || '').toString().slice(0, 500);
          return send({ ok: false, stage: 'git-clone', error: `git clone failed: ${msg}` });
        }
      } else {
        console.log('  [voice-install] whisper.cpp source already present, skipping clone.');
      }

      // 3. CMake configure + build
      emitStage('build', 'Building whisper.cpp from source (may take several minutes)…');
      try {
        console.log('  [voice-install] cmake configure...');
        execSync(
          `cmake -B build -DCMAKE_BUILD_TYPE=Release`,
          { stdio: 'pipe', cwd: srcDir, timeout: 120000 }
        );
        console.log('  [voice-install] cmake build (this may take several minutes)...');
        execSync(
          `cmake --build build -j --config Release`,
          { stdio: 'pipe', cwd: srcDir, timeout: 900000 } // 15 min
        );
      } catch (e) {
        const msg = (e.stderr || e.stdout || e.message || '').toString().slice(0, 800);
        return send({ ok: false, stage: 'build', error: `Build failed: ${msg}` });
      }

      // 4. Verify binary
      if (!existsSync(whisperBinPath)) {
        return send({ ok: false, stage: 'build', error: `whisper-cli binary not found after build. Expected: ${whisperBinPath}` });
      }

      // 5. Download model
      emitStage('download-model', 'Downloading turbo model (~1.5 GB)…');
      let resolvedModelPath;
      try {
        resolvedModelPath = await downloadModelToDataDir((p) => emitSSE('progress', { stage: 'download-model', ...p }));
      } catch (e) {
        return send({ ok: false, stage: 'download-model', error: e.message });
      }

      // 6. Smoke test
      emitStage('smoke-test', 'Running smoke test…');
      const smokeOk = await smokeTestWhisper(whisperBinPath);
      if (!smokeOk) {
        return send({ ok: false, stage: 'smoke-test', error: 'whisper-cli failed smoke test (--help returned non-zero or timed out).' });
      }

      emitStage('write-config', 'Writing voice config…');
      writeVoiceConfig(whisperBinPath, resolvedModelPath);
      console.log(`  [voice-install] done. binary=${whisperBinPath} model=${resolvedModelPath}`);
      return send({ ok: true, whisperPath: whisperBinPath, modelPath: resolvedModelPath });
    }

    // ── Unsupported platform ─────────────────────────────────────────────────
    return send({
      ok: false,
      stage: 'platform-check',
      error: `Unsupported platform: ${os_platform}/${os_arch}. Please install whisper.cpp manually and set voice.command in mixdog-config.json.`,
    });
  }

  // ============================================================
  // GENERAL MODULE ROUTES
  // ============================================================

  if (req.method === 'GET' && path === '/general/config') {
    const config = readConfig();
    const pi = (config && typeof config.promptInjection === 'object' && config.promptInjection) || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      promptInjection: {
        mode: pi.mode === 'hook' ? 'hook' : 'claude_md',
        targetPath: typeof pi.targetPath === 'string' && pi.targetPath ? pi.targetPath : '~/.claude/CLAUDE.md',
      },
    }));
    return;
  }

  if (req.method === 'POST' && path === '/general/save') {
    const data = await readBody(req);
    const existing = readConfig();
    const next = { ...existing };
    const prev = (existing && typeof existing.promptInjection === 'object' && existing.promptInjection) || {};
    const merged = { ...prev };
    if (data && (data.mode === 'hook' || data.mode === 'claude_md')) {
      merged.mode = data.mode;
    }
    if (data && typeof data.targetPath === 'string' && data.targetPath.trim()) {
      merged.targetPath = data.targetPath.trim();
    }
    if (!merged.mode) merged.mode = 'claude_md';
    if (!merged.targetPath) merged.targetPath = '~/.claude/CLAUDE.md';
    next.promptInjection = merged;
    writeConfig(next);
    console.log('  Config saved: general/promptInjection');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, promptInjection: merged }));
    return;
  }

  // ============================================================
  // MD LIBRARY ROUTES — Project MD + per-role MD (Common MD moved to
  // plugin rules/agent.md and is no longer user-editable).
  // ============================================================

  if (req.method === 'GET' && path === '/md/project') {
    const indexPath = join(getPluginData(), 'project-md-index.json');
    let registry = { paths: [] };
    try { registry = JSON.parse(readFileSync(indexPath, 'utf8')); } catch {}
    const items = [];
    for (const cwd of registry.paths || []) {
      let content = '';
      try { content = readFileSync(join(cwd, 'PROJECT.md'), 'utf8'); } catch {}
      items.push({ path: cwd, content });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items }));
    return;
  }

  if (req.method === 'POST' && path === '/md/project') {
    const body = await readBody(req);
    const cwd = String(body?.path || '').trim();
    const content = String(body?.content ?? '');
    if (!cwd) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path required' }));
      return;
    }
    try {
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, 'PROJECT.md'), content, 'utf8');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Cannot write PROJECT.md: ${err.message}` }));
      return;
    }
    // Update registry
    const indexPath = join(getPluginData(), 'project-md-index.json');
    let registry = { paths: [] };
    try { registry = JSON.parse(readFileSync(indexPath, 'utf8')); } catch {}
    if (!registry.paths.includes(cwd)) registry.paths.push(cwd);
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, JSON.stringify(registry, null, 2), 'utf8');
    console.log(`  Config saved: project MD (${cwd})`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'DELETE' && path === '/md/project') {
    const qs = new URL(req.url, 'http://x').searchParams;
    const cwd = String(qs.get('path') || '').trim();
    if (!cwd) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path required' }));
      return;
    }
    const indexPath = join(getPluginData(), 'project-md-index.json');
    let registry = { paths: [] };
    try { registry = JSON.parse(readFileSync(indexPath, 'utf8')); } catch {}
    registry.paths = (registry.paths || []).filter(p => p !== cwd);
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, JSON.stringify(registry, null, 2), 'utf8');
    console.log(`  Config removed from registry: ${cwd} (PROJECT.md file kept)`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ROLE MD ROUTES (Phase B §4) — UI-managed agent role files.
  // Each role lives at <data>/roles/<name>.md with frontmatter
  // (name, description, permission) + optional body. Permission is one of
  // "read" | "read-write".

  if (req.method === 'GET' && path === '/md/role') {
    const rolesDir = join(getPluginData(), 'roles');
    const items = [];
    try {
      mkdirSync(rolesDir, { recursive: true });
      const files = (await import('fs')).readdirSync(rolesDir).filter(f => f.endsWith('.md'));
      for (const f of files) {
        const name = f.replace(/\.md$/, '');
        let raw = '';
        try { raw = readFileSync(join(rolesDir, f), 'utf8'); } catch {}
        const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n*/);
        const fm = fmMatch ? fmMatch[1] : '';
        const body = fmMatch ? raw.slice(fmMatch[0].length).trim() : raw.trim();
        const description = (fm.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1] || '').trim();
        const permission = (fm.match(/^permission:\s*["']?(.+?)["']?\s*$/m)?.[1] || '').trim().toLowerCase();
        items.push({ name, description, permission, body });
      }
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items }));
    return;
  }

  if (req.method === 'POST' && path === '/md/role') {
    const body = await readBody(req);
    const name = String(body?.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const description = String(body?.description ?? '').trim();
    const permission = String(body?.permission ?? '').trim().toLowerCase();
    const note = String(body?.body ?? '').trim();
    if (!name) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'name required' }));
      return;
    }
    if (permission && permission !== 'read' && permission !== 'read-write') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'permission must be "read" or "read-write"' }));
      return;
    }
    const fmLines = [`name: ${name}`];
    if (description) fmLines.push(`description: ${description.replace(/\n/g, ' ')}`);
    if (permission) fmLines.push(`permission: ${permission}`);
    const content = `---\n${fmLines.join('\n')}\n---\n${note ? `\n${note}\n` : ''}`;
    const p = join(getPluginData(), 'roles', `${name}.md`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
    console.log(`  Config saved: role MD (${name})`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'DELETE' && path === '/md/role') {
    const qs = new URL(req.url, 'http://x').searchParams;
    const name = String(qs.get('name') || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!name) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'name required' }));
      return;
    }
    const p = join(getPluginData(), 'roles', `${name}.md`);
    try { (await import('fs')).unlinkSync(p); } catch {}
    console.log(`  Config removed: role MD (${name})`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ============================================================
  // WORKFLOW MODULE ROUTES
  // ============================================================

  if (req.method === 'GET' && path === '/workflow/load') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readUserWorkflow()));
    return;
  }

  if (req.method === 'POST' && path === '/workflow/save') {
    const data = await readBody(req);
    writeUserWorkflow(data);
    console.log('  Config saved: user-workflow');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/workflow/md') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(readUserWorkflowMd());
    return;
  }

  if (req.method === 'POST' && path === '/workflow/md') {
    let body = '';
    await new Promise((resolve, reject) => {
      req.on('data', c => { body += c; });
      req.on('end', resolve);
      req.on('error', reject);
    });
    writeUserWorkflowMd(body);
    console.log('  Config saved: user-workflow.md');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/workflow/file') {
    if (!existsSync(USER_WORKFLOW_MD_PATH)) {
      mkdirSync(dirname(USER_WORKFLOW_MD_PATH), { recursive: true });
      writeFileSync(USER_WORKFLOW_MD_PATH, DEFAULT_USER_WORKFLOW_MD, 'utf8');
    }
    if (isWin) { spawn('cmd', ['/c', 'start', '', USER_WORKFLOW_MD_PATH], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
    else { spawn('open', [USER_WORKFLOW_MD_PATH], { detached: true, stdio: 'ignore' }).unref(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (path === '/close') {
    windowOpen = false;
    res.writeHead(200);
    res.end();
    console.log('  Window closed');
    return;
  }

  if (path === '/open') {
    openAppWindow();
    windowOpen = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/generation') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ generation: openGeneration }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  MIXDOG CONFIG`);
  console.log(`  http://localhost:${PORT}\n`);
  if (process.env.MIXDOG_SETUP_OPEN_ON_START === '1') {
    openGeneration++;
    windowOpen = true;
    setTimeout(() => { openAppWindow(); }, 0);
  }
});

// Parent-PID watchdog: setup-server is launched detached/unref'd (see
// setup/launch.mjs), so losing Claude Code does not reap it. Poll the
// launcher's parent PID (the Claude Code CLI) and exit when it dies. This is
// the detached-process equivalent of the run-mcp.mjs stdin-close pattern
// applied to memory/channels workers in v0.6.0.
(() => {
  const parentPid = parseInt(process.env.MIXDOG_SETUP_PARENT_PID || '', 10);
  if (!Number.isFinite(parentPid) || parentPid <= 0) return;
  const tick = () => {
    try {
      process.kill(parentPid, 0);
    } catch {
      process.exit(0);
    }
  };
  const timer = setInterval(tick, 5000);
  if (typeof timer.unref === 'function') timer.unref();
})();
