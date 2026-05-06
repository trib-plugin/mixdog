import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolvePluginData } from '../../shared/plugin-paths.mjs';
import { readSection, updateSection } from '../../shared/config.mjs';

// Thin wrapper around resolvePluginData so callers in this orchestrator tree
// can import a single helper without reaching into shared/.
export function getPluginData() {
    return resolvePluginData();
}
const ENV_KEY_MAP = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    gemini: 'GEMINI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    xai: 'XAI_API_KEY',
    nvidia: 'NVIDIA_API_KEY',
};
// Canonical maintenance defaults. Single source of truth — imported by
// llm/index.mjs and setup-server.mjs so UI/runtime cannot drift from config.
export const DEFAULT_MAINTENANCE = Object.freeze({
    cycle1: 'HAIKU',
    cycle2: 'SONNET MID',
    search: 'HAIKU',
    recall: 'HAIKU',
    explore: 'HAIKU',
    // Slots backing the maintenance hidden roles registered in
    // BUILTIN_HIDDEN_ROLES (scheduler-task / proactive-decision /
    // webhook-handler). Without these, a fresh install fails
    // resolvePresetName() and throws "preset unresolved" the first
    // time the scheduler tick / webhook ingress dispatches its hidden role.
    scheduler: 'HAIKU',
    proactive: 'HAIKU',
    webhook: 'HAIKU',
    classification: 'HAIKU',
});

// Map short Anthropic family labels to the full model ids used by the API.
// Honors ANTHROPIC_DEFAULT_{OPUS|SONNET|HAIKU}_MODEL env overrides.
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

// Seed presets keyed by preset.name so workflow/maintenance references stay
// consistent with the resolve-by-name lookup in presetKey().
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

function persistAgentConfig(config) {
    updateSection('agent', () => config);
}

export function loadConfig() {
    const sectionRaw = readSection('agent');
    if (hasKeys(sectionRaw)) {
        try {
            let raw = sectionRaw;
            if (raw.agent && raw.agent.providers) {
                raw = raw.agent;
            }
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
            // Self-ref guard: mcpServers.mixdog / mcpServers["trib-plugin"]
            // would self-spawn through the in-process tool bridge. Strip on
            // ingress so user-edited configs cannot brick the agent boot.
            const mcpServers = (raw.mcpServers && typeof raw.mcpServers === 'object') ? { ...raw.mcpServers } : {};
            if (mcpServers['mixdog'] || mcpServers['trib-plugin']) {
                delete mcpServers['mixdog'];
                delete mcpServers['trib-plugin'];
                raw.mcpServers = mcpServers;
                try { persistAgentConfig(raw); } catch {}
            }
            const rawPresets = Array.isArray(raw.presets) ? raw.presets : [];
            const normalizedPresets = rawPresets.map(p => normalizePreset(p)).filter(Boolean);
            return {
                providers: mergedProviders,
                mcpServers,
                presets: normalizedPresets,
                default: raw.default || null,
                maintenance: { ...DEFAULT_MAINTENANCE, ...rawMaint },
                agentMaintenance: { enabled: true, interval: '1h', ...raw.agentMaintenance },
                trajectory: { enabled: true, ...raw.trajectory },
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
    let existingRaw = readSection('agent');
    if (!hasKeys(existingRaw)) existingRaw = {};
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
        bridge: config.bridge || {},
    };
    persistAgentConfig(payload);
}
// --- Preset helpers ---
// preset shape: { id, name, type: 'bridge', provider, model, effort?, fast?, tools? }
function presetKey(p) { return p?.id || p?.name || ''; }
function normalizePreset(preset) {
    if (!preset || typeof preset !== 'object')
        return null;
    const id = String(preset.id || preset.name || '').trim();
    const name = String(preset.name || preset.id || '').trim();
    const model = String(preset.model || '').trim();
    const provider = String(preset.provider || '').trim();
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
