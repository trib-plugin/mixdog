import { readFileSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { loadGitHubToken } from './providers/copilot-auth.mjs';
import { resolvePluginData } from '../../shared/plugin-paths.mjs';
import { readSection, updateSection, stripGeneratedMarker } from '../../shared/config.mjs';

/**
 * Back-compat alias. Delegates to the shared `resolvePluginData()` helper
 * so every caller converges on the same resolution rules (env → ROOT-derived
 * → static fallback).
 */
export function getPluginData() {
    return resolvePluginData();
}
const ENV_KEY_MAP = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    gemini: 'GEMINI_API_KEY',
    groq: 'GROQ_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    xai: 'XAI_API_KEY',
};
// Canonical maintenance defaults. Single source of truth — imported by
// llm/index.mjs and setup-server.mjs so UI/runtime cannot drift from config.
export const DEFAULT_MAINTENANCE = Object.freeze({
    cycle1: 'HAIKU',
    cycle2: 'SONNET MID',
    search: 'HAIKU',
    recall: 'HAIKU',
    explore: 'HAIKU',
    recap: 'HAIKU',
});

// Map short Anthropic family labels to the full model ids used by the API.
// Honors ANTHROPIC_DEFAULT_{OPUS|SONNET|HAIKU}_MODEL env overrides. Used
// both for seed presets below and for legacy (`type: 'native'`) migration
// inside normalizePreset.
const ANTHROPIC_FAMILY_MODEL = Object.freeze({
    opus: 'claude-opus-4-7',
    sonnet: 'claude-sonnet-4-6',
    haiku: 'claude-haiku-4-5-20251001',
});
function resolveAnthropicFamilyModel(family) {
    const key = String(family || '').toLowerCase();
    if (!key) return null;
    const envVar = `ANTHROPIC_DEFAULT_${key.toUpperCase()}_MODEL`;
    if (process.env[envVar]) return process.env[envVar];
    return ANTHROPIC_FAMILY_MODEL[key] || null;
}

function isLegacyPresetShape(p) {
    if (!p || typeof p !== 'object') return false;
    if (p.type === 'native') return true;
    if (p.type === 'bridge' && !p.provider && ['opus', 'sonnet', 'haiku'].includes(String(p.model || '').toLowerCase())) return true;
    return false;
}

// Seed presets written when agent-config.json does not yet exist. Keyed by
// preset.name so workflow/maintenance references stay consistent with the
// resolve-by-name lookup in presetKey(). All presets are bridge-typed with
// an explicit provider — the legacy `type: 'native'` shortcut is gone.
export const DEFAULT_PRESETS = Object.freeze([
    Object.freeze({ id: 'haiku', name: 'HAIKU', type: 'bridge', provider: 'anthropic-oauth', model: resolveAnthropicFamilyModel('haiku'), tools: 'full' }),
    Object.freeze({ id: 'sonnet-mid', name: 'SONNET MID', type: 'bridge', provider: 'anthropic-oauth', model: resolveAnthropicFamilyModel('sonnet'), effort: 'medium', tools: 'full' }),
    Object.freeze({ id: 'sonnet-high', name: 'SONNET HIGH', type: 'bridge', provider: 'anthropic-oauth', model: resolveAnthropicFamilyModel('sonnet'), effort: 'high', tools: 'full' }),
    Object.freeze({ id: 'opus-mid', name: 'OPUS MID', type: 'bridge', provider: 'anthropic-oauth', model: resolveAnthropicFamilyModel('opus'), effort: 'medium', tools: 'full' }),
    Object.freeze({ id: 'opus-xhigh', name: 'OPUS XHIGH', type: 'bridge', provider: 'anthropic-oauth', model: resolveAnthropicFamilyModel('opus'), effort: 'xhigh', tools: 'full' }),
]);
function buildDefaultConfig() {
    const providers = {};
    // API providers — enabled if env key exists
    for (const [name, envKey] of Object.entries(ENV_KEY_MAP)) {
        const apiKey = process.env[envKey];
        providers[name] = {
            enabled: !!apiKey,
            apiKey: apiKey || undefined,
        };
    }
    // Copilot — enabled if GITHUB_TOKEN env var or hosts.json/apps.json exists
    providers.copilot = {
        enabled: !!loadGitHubToken(),
        baseURL: 'https://api.githubcopilot.com',
    };
    // OpenAI OAuth (ChatGPT subscription) — enabled if ~/.codex/auth.json or own tokens exist
    const hasCodexAuth = existsSync(join(homedir(), '.codex', 'auth.json'));
    const hasOwnAuth = existsSync(join(getPluginData(), 'openai-oauth.json'));
    // WebSocket transport is on by default — measured ~96% cross-session cache
    // hit with delta payloads, vs. the SSE path which misses the cross-session
    // cache entirely. Users who need to force SSE (e.g. a corporate proxy that
    // blocks WSS to chatgpt.com) can set `websocket: false` in agent-config.json.
    providers['openai-oauth'] = { enabled: hasCodexAuth || hasOwnAuth, websocket: true };

    // Anthropic OAuth (Claude Max subscription) — enabled if .credentials.json exists with inference scope
    const hasClaudeOAuth = (() => {
        try {
            const credPath = join(homedir(), '.claude', '.credentials.json');
            if (!existsSync(credPath)) return false;
            const creds = JSON.parse(readFileSync(credPath, 'utf8'));
            return creds?.claudeAiOauth?.accessToken &&
                   Array.isArray(creds?.claudeAiOauth?.scopes) &&
                   creds.claudeAiOauth.scopes.includes('user:inference');
        } catch { return false; }
    })();
    providers['anthropic-oauth'] = { enabled: hasClaudeOAuth };
    // Local providers — opt-in via setup UI after HTTP ping confirms server is running
    providers.ollama = { enabled: false, baseURL: 'http://localhost:11434/v1' };
    providers.lmstudio = { enabled: false, baseURL: 'http://localhost:1234/v1' };
    return { providers };
}

function hasKeys(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function readLegacyAgentConfig(configPath) {
    try {
        return stripGeneratedMarker(JSON.parse(readFileSync(configPath, 'utf-8')));
    }
    catch {
        return null;
    }
}

function persistAgentConfig(config) {
    updateSection('agent', () => config);
}

/**
 * One-time migration: if a legacy mcp-tools.json sits next to config.json,
 * merge its `mcpServers` into config.json and rename the legacy file to .bak.
 * Skipped silently if config.json already has `mcpServers`.
 */
function migrateMcpToolsFile(configPath) {
    const dir = dirname(configPath);
    const legacyPath = join(dir, 'mcp-tools.json');
    if (!existsSync(legacyPath))
        return;
    let configRaw = readSection('agent');
    if (!hasKeys(configRaw)) {
        configRaw = readLegacyAgentConfig(configPath);
        // config.json malformed; bail without touching legacy file
        if (!configRaw) return;
    }
    if (configRaw.mcpServers && Object.keys(configRaw.mcpServers).length > 0) {
        // Already migrated — leave the legacy file alone for the user to clean up
        return;
    }
    let legacyRaw = {};
    try {
        legacyRaw = JSON.parse(readFileSync(legacyPath, 'utf-8'));
    }
    catch {
        return;
    }
    const legacyServers = legacyRaw.mcpServers || legacyRaw;
    if (!legacyServers || typeof legacyServers !== 'object' || Object.keys(legacyServers).length === 0) {
        return;
    }
    configRaw.mcpServers = legacyServers;
    try {
        updateSection('agent', (current) => ({ ...current, ...configRaw }));
        renameSync(legacyPath, legacyPath + '.bak');
        process.stderr.write(`[mixdog-agent] Migrated mcp-tools.json -> config.json (backup at ${legacyPath}.bak)\n`);
    }
    catch (err) {
        process.stderr.write(`[mixdog-agent] mcp-tools.json migration failed: ${err}\n`);
    }
}
function getConfigPath() {
    return join(getPluginData(), 'agent-config.json');
}
export function loadConfig() {
    const configPath = getConfigPath();
    migrateMcpToolsFile(configPath);
    const sectionRaw = readSection('agent');
    if (hasKeys(sectionRaw) || existsSync(configPath)) {
        try {
            let raw = hasKeys(sectionRaw) ? sectionRaw : readLegacyAgentConfig(configPath);
            // If config has an 'agent' section, use it (unified config format)
            if (raw.agent && raw.agent.providers) {
                raw = raw.agent;
            }
            // user-workflow.json is managed by setup UI; no auto-seeding here
            const defaults = buildDefaultConfig();
            // Deep-merge provider subkeys: unknown per-provider values are
            // preserved through save/load so future fields round-trip
            // without schema updates here.
            const mergedProviders = { ...defaults.providers };
            if (raw.providers && typeof raw.providers === 'object') {
                for (const [name, val] of Object.entries(raw.providers)) {
                    if (val && typeof val === 'object') {
                        mergedProviders[name] = { ...(mergedProviders[name] || {}), ...val };
                    } else {
                        mergedProviders[name] = val;
                    }
                }
            }
            const rawMaint = { ...(raw.maintenance || {}) };
            // One-time migration: drop legacy self-ref mcpServers.mixdog /
            // mcpServers["trib-plugin"].
            // Plugin tools are injected in-process via agent's toolExecutor
            // (see orchestrator/internal-tools); a self-ref entry causes
            // self-spawn recursion or partial HTTP loopback, both broken.
            const mcpServers = (raw.mcpServers && typeof raw.mcpServers === 'object') ? { ...raw.mcpServers } : {};
            if (mcpServers['mixdog'] || mcpServers['trib-plugin']) {
                delete mcpServers['mixdog'];
                delete mcpServers['trib-plugin'];
                raw.mcpServers = mcpServers;
                try {
                    persistAgentConfig(raw);
                    process.stderr.write(`[config] migrated: removed legacy self-ref mcpServers.mixdog / mcpServers["trib-plugin"]\n`);
                } catch (e) {
                    process.stderr.write(`[config] self-ref migration persist failed: ${e.message}\n`);
                }
            }
            // One-time migration: legacy `type: 'native'` presets → bridge
            // with explicit anthropic-oauth provider + full model id.
            const rawPresets = Array.isArray(raw.presets) ? raw.presets : [];
            const normalizedPresets = rawPresets.map(p => normalizePreset(p)).filter(Boolean);
            const hadLegacy = rawPresets.some(p => isLegacyPresetShape(p));
            if (hadLegacy) {
                try {
                    const migrated = { ...raw, presets: normalizedPresets };
                    persistAgentConfig(migrated);
                    raw = migrated;
                    process.stderr.write(`[config] migrated: ${rawPresets.filter(p => isLegacyPresetShape(p)).length} legacy preset(s) → bridge\n`);
                } catch (e) {
                    process.stderr.write(`[config] native→bridge migration persist failed: ${e.message}\n`);
                }
            }
            return {
                providers: mergedProviders,
                mcpServers,
                presets: normalizedPresets,
                default: raw.default || null,
                maintenance: { ...DEFAULT_MAINTENANCE, ...rawMaint },
                agentMaintenance: { enabled: true, interval: '1h', ...raw.agentMaintenance },
                trajectory: { enabled: true, ...raw.trajectory },
                skillSuggest: { autoDetect: true, ...raw.skillSuggest },
                // Top-level extension blocks preserved through save/load so
                // future keys round-trip without schema updates here.
                bridge: raw.bridge && typeof raw.bridge === 'object' ? raw.bridge : {},
            };
        }
        catch { /* fall through */ }
    }
    const defaults = buildDefaultConfig();
    return {
        ...defaults,
        mcpServers: {},
        presets: DEFAULT_PRESETS.map(p => ({ ...p })),
        default: null,
        maintenance: { ...DEFAULT_MAINTENANCE },
        agentMaintenance: { enabled: true, interval: '1h' },
        trajectory: { enabled: true },
        skillSuggest: { autoDetect: true },
        bridge: {},
    };
}
/**
 * Atomically save the agent section in mixdog-config.json. Caller passes the
 * full config object. Only persists mcpServers, presets, default, and user-set
 * provider entries (apiKey, enabled, baseURL) — defaults are recomputed on
 * next load.
 */
export function saveConfig(config) {
    const path = getConfigPath();
    let existingRaw = readSection('agent');
    if (!hasKeys(existingRaw)) existingRaw = readLegacyAgentConfig(path) || {};
    // Strip ephemeral defaults from providers but preserve any unknown
    // per-provider subkey so future schema additions round-trip through
    // the setup UI without changes here.
    const KNOWN_PROVIDER_KEYS = new Set(['apiKey', 'enabled', 'baseURL']);
    const persistedProviders = {};
    if (config.providers) {
        for (const [name, val] of Object.entries(config.providers)) {
            if (!val || typeof val !== 'object') continue;
            const slim = {};
            if (val.apiKey) slim.apiKey = val.apiKey;
            if (typeof val.enabled === 'boolean') slim.enabled = val.enabled;
            if (val.baseURL) slim.baseURL = val.baseURL;
            for (const [k, v] of Object.entries(val)) {
                if (KNOWN_PROVIDER_KEYS.has(k)) continue;
                if (v === undefined) continue;
                slim[k] = v;
            }
            if (Object.keys(slim).length)
                persistedProviders[name] = slim;
        }
    }
    const payload = {
        ...existingRaw,
        guide: config.guide || existingRaw.guide || undefined,
        providers: persistedProviders,
        mcpServers: config.mcpServers || {},
        presets: Array.isArray(config.presets) ? config.presets : [],
        default: config.default || null,
        maintenance: config.maintenance || {},
        agentMaintenance: config.agentMaintenance || {},
        trajectory: config.trajectory || {},
        skillSuggest: config.skillSuggest || {},
        bridge: config.bridge || {},
    };
    persistAgentConfig(payload);
}
// --- Preset helpers ---
// preset shape: { id, name, type: 'bridge', provider, model, effort?, fast?, tools? }
// Legacy inputs with `type: 'native'` + short family model (haiku/sonnet/opus)
// are auto-migrated to { type: 'bridge', provider: 'anthropic-oauth', model: <full id> }.
function presetKey(p) { return p?.id || p?.name || ''; }
function normalizePreset(preset) {
    if (!preset || typeof preset !== 'object')
        return null;
    const id = String(preset.id || preset.name || '').trim();
    const name = String(preset.name || preset.id || '').trim();
    let model = String(preset.model || '').trim();
    let provider = String(preset.provider || '').trim();

    // Legacy migration: flip to bridge, fill anthropic-oauth provider,
    // expand short family model (haiku/sonnet/opus) to the full API id.
    if (isLegacyPresetShape(preset)) {
        if (!provider) provider = 'anthropic-oauth';
        const resolved = resolveAnthropicFamilyModel(model);
        if (resolved) model = resolved;
    }

    if (!name || !model || !provider) return null;
    const out = { id, name, type: 'bridge', provider, model };
    if (preset.effort)
        out.effort = String(preset.effort).trim();
    if (preset.fast === true)
        out.fast = true;
    out.tools = ['full', 'readonly', 'mcp'].includes(preset.tools) ? preset.tools : 'full';
    return out;
}
export function getPreset(config, key) {
    const presets = Array.isArray(config?.presets) ? config.presets : [];
    if (key == null || key === '')
        return null;
    // Numeric → index
    if (typeof key === 'number' || /^\d+$/.test(String(key))) {
        const idx = Number(key);
        return presets[idx] || null;
    }
    // String → name or id match
    return presets.find(p => p && presetKey(p) === key) || null;
}
export function getDefaultPreset(config) {
    if (!config?.default)
        return null;
    return getPreset(config, config.default);
}
export function listPresets(config) {
    return Array.isArray(config?.presets) ? config.presets : [];
}
// --- Lane-scoped runtime spec ---
// Phase D-2: scopeKey is (role, provider, model), not (role, preset). Spec
// §4.5 calls for "at most one live session per Sub role × provider"; we
// widen provider to (provider, model) because two presets on the same
// provider that differ only in effort/fast should keep sharing a session
// (both cache shards are identical there), while swapping the model itself
// legitimately needs a fresh session (cache shard is model-specific). Two
// presets mapping to the same (provider, model) therefore collapse into
// one Bridge session, so opus-mid / opus-max no longer fragment the pool.
//
//   bridge lane: "bridge:<agentId>:<provider>:<model>"  — per Sub role
//   other lane:  "bridge:<provider>:<model>"            — shared utility
export function resolveRuntimeSpec(preset, ctx) {
    const lane = ctx.lane || 'bridge';
    const provider = String(preset?.provider || '').trim() || 'unknown';
    const model = String(preset?.model || '').trim() || '_';
    let scopeKey;
    if (lane === 'bridge') {
        if (!ctx.agentId) throw new Error('bridge lane requires agentId');
        scopeKey = `bridge:${ctx.agentId}:${provider}:${model}`;
    } else {
        scopeKey = `bridge:${provider}:${model}`;
    }
    return { lane, scopeKey, reuse: true, preset };
}

export function setDefaultPreset(config, key) {
    const preset = getPreset(config, key);
    if (!preset)
        throw new Error(`preset "${key}" not found`);
    config.default = presetKey(preset);
    saveConfig(config);
    return preset;
}
