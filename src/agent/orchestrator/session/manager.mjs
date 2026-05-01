import { createRequire } from 'module';
import { randomBytes } from 'crypto';
import { existsSync, statSync } from 'fs';
import { join, resolve as pathResolve } from 'path';
import { homedir } from 'os';
import { getProvider } from '../providers/registry.mjs';
import { agentLoop } from './loop.mjs';
import { getMcpTools } from '../mcp/client.mjs';
import { getInternalTools, executeInternalTool } from '../internal-tools.mjs';
import { BUILTIN_TOOLS, executeBuiltinTool } from '../tools/builtin.mjs';
import { PATCH_TOOL_DEFS } from '../tools/patch.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../tools/code-graph.mjs';
import { closeBashSession } from '../tools/bash-session.mjs';
import { collectSkillsCached, buildSkillToolDefs, loadAgentTemplate, loadRoleTemplate, composeSystemPrompt, collectProjectMd } from '../context/collect.mjs';
import { saveSession, loadSession, deleteSession, listStoredSessions, getStoredSessionsRaw, sweepStaleSessions, markSessionClosed } from './store.mjs';
import { createAbortController } from '../../../shared/abort-controller.mjs';
import { logLlmCall } from '../../../shared/llm/usage-log.mjs';
import { classifyPromptIntent } from '../intent-classifier.mjs';
import { resolvePluginData, DEFAULT_PLUGIN, DEFAULT_MARKETPLACE } from '../../../shared/plugin-paths.mjs';
import { traceBridgeTool } from '../bridge-trace.mjs';
import { isHiddenRole } from '../internal-roles.mjs';
// Mutable seam: harnesses (MIXDOG_TEST_EXPORTS=1) can override via _internals._setClassifyPromptIntentForTest.
let _classifyPromptIntentImpl = classifyPromptIntent;

// Phase B: Pool B Tier 2 content builder (common rules only).
// Loaded once per process via createRequire so the CJS module reaches us.
const _require = createRequire(import.meta.url);
const _rulesBuilder = (() => {
    const candidates = [
        process.env.CLAUDE_PLUGIN_ROOT && join(process.env.CLAUDE_PLUGIN_ROOT, 'lib', 'rules-builder.cjs'),
    ].filter(Boolean);
    for (const p of candidates) {
        try { return _require(p); } catch { /* fall through */ }
    }
    // Fallback: walk up from this file's location to find lib/rules-builder.cjs.
    try { return _require('../../../../lib/rules-builder.cjs'); } catch { return null; }
})();

// bridgeRules is the bridge shared prefix (shared rules + bridge common rules +
// user agent configs). It's rebuilt from disk
// by rules-builder.cjs on every call; since createSession fires on every
// Pool B/C bridge turn, that's a lot of redundant readFileSync + concat.
// 60s TTL is short enough that a user rule edit propagates quickly while
// the hot path reuses the cached string.
// BP1 cache — single shared entry. buildBridgeInjectionContent is
// role-agnostic (true cross-role common), so every bridge role reuses the
// same prefix bytes.
let _bridgeRulesCache = null;
let _bridgeRulesCacheTime = 0;
const BRIDGE_RULES_CACHE_TTL = 60_000;
function _buildBridgeRules() {
    if (!_rulesBuilder || typeof _rulesBuilder.buildBridgeInjectionContent !== 'function') return '';
    const now = Date.now();
    if (_bridgeRulesCache !== null && now - _bridgeRulesCacheTime < BRIDGE_RULES_CACHE_TTL) {
        return _bridgeRulesCache;
    }
    const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
        || join(homedir(), '.claude', 'plugins', 'marketplaces', DEFAULT_MARKETPLACE, 'external_plugins', DEFAULT_PLUGIN);
    const DATA_DIR = resolvePluginData();
    try {
        const built = _rulesBuilder.buildBridgeInjectionContent({ PLUGIN_ROOT, DATA_DIR });
        _bridgeRulesCache = built;
        _bridgeRulesCacheTime = now;
        return built;
    } catch (e) {
        process.stderr.write(`[session] bridge rules build failed: ${e.message}\n`);
        return '';
    }
}

// BP3 role-specific cache — keyed by role. webhook / schedule / hidden
// retrieval roles each have their own scoped instruction set; other roles
// return ''.
const _roleSpecificCache = new Map();
function _buildRoleSpecific(currentRole) {
    if (!_rulesBuilder || typeof _rulesBuilder.buildBridgeRoleSpecificContent !== 'function') return '';
    if (!currentRole) return '';
    const now = Date.now();
    const entry = _roleSpecificCache.get(currentRole);
    if (entry && now - entry.ts < BRIDGE_RULES_CACHE_TTL) {
        return entry.value;
    }
    const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
        || join(homedir(), '.claude', 'plugins', 'marketplaces', DEFAULT_MARKETPLACE, 'external_plugins', DEFAULT_PLUGIN);
    const DATA_DIR = resolvePluginData();
    try {
        const built = _rulesBuilder.buildBridgeRoleSpecificContent({ PLUGIN_ROOT, DATA_DIR, currentRole });
        _roleSpecificCache.set(currentRole, { ts: now, value: built });
        return built;
    } catch (e) {
        process.stderr.write(`[session] role-specific rules build failed: ${e.message}\n`);
        return '';
    }
}

// Smart Bridge is optional — injected via setSmartBridge() during plugin init
// so session creation never depends on a circular import. If never injected,
// createSession simply falls back to classic preset-only behavior.
let _smartBridgeApi = null;
let _smartBridgeWarned = false;

/**
 * Inject the Smart Bridge singleton. Called once by agent/index.mjs init()
 * after initSmartBridge(). Safe to call multiple times — later calls
 * replace the previous reference.
 */
export function setSmartBridge(api) {
    _smartBridgeApi = api || null;
}

function getSmartBridgeSync() {
    return _smartBridgeApi;
}

/**
 * Thrown when a session is closed while a call is in-flight. Callers (bridge
 * handler, CLI) should render this as "cancelled" rather than a hard error.
 */
export class SessionClosedError extends Error {
    constructor(sessionId, reason, closeReason) {
        super(reason ? `Session "${sessionId}" closed: ${reason}` : `Session "${sessionId}" closed`);
        this.name = 'SessionClosedError';
        this.sessionId = sessionId;
        this.cancelled = true;
        // closeReason is the diagnostic enum (request-abort / manual /
        // idle-sweep / runner-crash). Kept separate from `reason` (the free
        // -form message) so consumers can branch on it without regex parsing.
        this.reason = closeReason || null;
    }
}
let _mcpToolsCache = null;
let _mcpToolsCacheTime = 0;
const MCP_CACHE_TTL = 60000; // 1 minute
const HEARTBEAT_THROTTLE_MS = 60_000; // 60s

function _getMcpToolsCached() {
    const now = Date.now();
    if (!_mcpToolsCache || now - _mcpToolsCacheTime > MCP_CACHE_TTL) {
        // Merge externally-connected MCP tools with the plugin's in-process
        // tools (registered by agent's toolExecutor bridge). Internal tools
        // are exposed to LLMs under their bare names (search, search_memories,
        // reply, ...) — no mcp__ prefix, since the dispatcher in server.mjs
        // handles them directly without a transport.
        const mcp = getMcpTools() || [];
        const internalRaw = getInternalTools() || [];
        const internal = internalRaw.map(t => ({
            name: t.name,
            description: typeof t.description === 'string' ? t.description.slice(0, 2048) : '',
            inputSchema: t.inputSchema || { type: 'object', properties: {} },
            // Keep annotations so the permission filter / role invariants can
            // tell read-only from write-capable internal tools (reply, react,
            // edit_message, schedule_*, reload_config all declare
            // readOnlyHint:false in tools.json).
            annotations: t.annotations || {},
        }));
        // Sort deterministically by name — protects BP_1 hash stability from
        // listTools() ordering churn. Anthropic / OpenAI / Gemini all hash
        // the tools array verbatim, so any reorder rewrites the prefix.
        _mcpToolsCache = [...mcp, ...internal].sort((a, b) => {
            const an = a?.name || '';
            const bn = b?.name || '';
            return an < bn ? -1 : an > bn ? 1 : 0;
        });
        _mcpToolsCacheTime = now;
    }
    return _mcpToolsCache;
}

// Phase D-2 — profile.tools resolution.
//
// `toolSpec` may be:
//   • Array<string>  (profile.tools) — toolset ids like "tools:filesystem",
//                     "tools:git", "tools:mcp", "tools:search",
//                     "tools:readonly", or the literal "full"
//   • 'full' / 'readonly' / 'mcp'  — legacy preset.tools strings
//   • null / undefined             — same as 'full' (historical default)
//
// Array form is the Phase B/D target: each profile declares its tool surface
// explicitly, BP_1 hash differs across profiles with different tool subsets
// (by design — sub-task profile cannot see bash; worker-full can), and
// adding a new toolset id here is a localised change.
//
// Unified-shard policy — the session's tool array never narrows with
// permission or role. Every bridge session ships the same tool schema so
// BP_1 stays bit-identical and the provider-side cache shard is shared
// workspace-wide. Disallowed tools are still rejected at call time by
// loop.mjs's permission guards (read / mcp) and the bridge-deny list (for
// Lead-only admin surface); those operate AFTER the schema is built, so
// cache integrity is preserved.

const ALL_BUILTIN_SESSION_TOOLS = _dedupByName([
    ...BUILTIN_TOOLS,
    ...PATCH_TOOL_DEFS,
    ...CODE_GRAPH_TOOL_DEFS,
]);

function resolveSessionTools(toolSpec, skills, { ownerIsBridge = false } = {}) {
    const mcp = _getMcpToolsCached();
    // Bridge sessions freeze the 3 skill meta-tools into the schema
    // unconditionally — concrete skill resolution is cwd-scoped at tool-call
    // time (loop.mjs), so the schema bytes stay bit-identical across roles /
    // cwds and the provider cache shard does not fragment.
    const skillTools = buildSkillToolDefs(skills, { ownerIsBridge });
    return _computeBaseTools(toolSpec, mcp, skillTools);
}

// Dedup by name, first occurrence wins. BUILTIN_TOOLS is passed in ahead
// of the MCP-registered internal tools so plugin-side definitions take
// precedence when both surfaces declare the same name (e.g. read / grep /
// glob, which v0.6.173 also exposed via tools.json with module:'builtin').
// Without this merge, Anthropic rejected the request with
// "tools: Tool names must be unique" and the orchestrator burned up to
// 20 iterations retrying before the final answer landed.
function _dedupByName(tools) {
    const seen = new Map();
    for (const t of tools) {
        const n = t?.name;
        if (!n || seen.has(n)) continue;
        seen.set(n, t);
    }
    return [...seen.values()];
}

// Canonical bridge deny list — the SINGLE source of truth for which tools a
// bridge-owned session strips from its tool schema. Exported so benchmarks
// (scripts/measure-bp1.mjs) and tests can import the same list instead of
// maintaining a parallel copy that silently drifts.
//
// KEEP (bridge agents can call):
//   - core file / shell: read, edit, write, bash (persistent:true), grep, glob
//   - IO helpers: read (mode:head|tail|count), list (mode:tree|find)
//   - Code graph / refactors: code_graph
//   - memory read: recall (hidden recall-agent gets memory_search directly)
//   - information retrieval: search, explore
//     (hidden search-agent gets web_search directly)
export const BRIDGE_DENY_TOOLS = Object.freeze([
    // Discord / channel (Lead-only)
    'reply', 'react', 'edit_message', 'download_attachment', 'fetch',
    'activate_channel_bridge',
    // Session lifecycle (Lead-only)
    'create_session', 'close_session', 'list_sessions', 'list_models',
    // Schedule / config admin (Lead-only)
    'schedule_status', 'trigger_schedule', 'schedule_control', 'reload_config',
    // Inject input is Lead-only — used to push messages into other roles.
    'inject_input',
    // Bridge dispatch — Pool B/C agents do the work; Lead does the dispatch.
    // Recall/search/explore stay (info retrieval, not role delegation).
    'bridge', 'bridge_send', 'bridge_spawn',
    // Lead-side workflow / prompt admin and skill-mining surfaces. These are
    // public:false helper tools for the main session, not bridge-agent work
    // tools; stripping them from Pool B/C keeps the shared BP_1 shard lean and
    // avoids exposing chain-spawn adjacent control planes.
    'get_workflow', 'get_workflows', 'set_prompt',
    // Main-session convenience aliases. Bridge roles already know to use
    // `code_graph` / `find_symbol` directly, so carrying alias-only tools
    // here just bloats the shared BP_1 shard without adding capability.
    'find_imports', 'find_dependents', 'find_references', 'find_callers',
    // External `mixdog-memory` MCP server duplicates internal memory_search /
    // recall / explore surfaces (those are the canonical paths). Keeping the
    // mcp__-prefixed twins live just lets the model wander between two
    // schemas for the same call. Strip them from bridge to keep the shard
    // clean; Lead can still reach them through the mcp surface if needed.
    'mcp__mixdog-memory__memory', 'mcp__mixdog-memory__recall', 'mcp__mixdog-memory__explore',
]);

function _computeBaseTools(toolSpec, mcp, skillTools) {
    if (Array.isArray(toolSpec)) {
        if (toolSpec.length === 0) {
            // Explicit "no tools" — skill meta tools still travel so the model
            // can at least discover and invoke skills if that is the one
            // dynamic surface the profile retains.
            return _dedupByName([...skillTools]);
        }
        if (toolSpec.includes('full')) {
            return _dedupByName([...ALL_BUILTIN_SESSION_TOOLS, ...mcp, ...skillTools]);
        }
        const byName = new Map();
        const add = (tool) => { if (tool?.name && !byName.has(tool.name)) byName.set(tool.name, tool); };
        const addMany = (arr) => { for (const t of arr) add(t); };
        for (const tagRaw of toolSpec) {
            const tag = String(tagRaw || '').trim();
            switch (tag) {
                case 'tools:filesystem':
                    addMany(ALL_BUILTIN_SESSION_TOOLS.filter(t => ['read', 'write', 'edit', 'apply_patch', 'grep', 'glob'].includes(t.name)));
                    break;
                case 'tools:readonly':
                    addMany(ALL_BUILTIN_SESSION_TOOLS.filter(t => ['read', 'grep', 'glob'].includes(t.name)));
                    break;
                case 'tools:bash':
                case 'tools:git':
                case 'tools:analysis':
                    addMany(ALL_BUILTIN_SESSION_TOOLS.filter(t => t.name === 'bash'));
                    break;
                case 'tools:mcp':
                    addMany(mcp);
                    break;
                case 'tools:search':
                    addMany(mcp.filter(t => /search/i.test(t?.name || '')));
                    break;
                default:
                    process.stderr.write(`[session] unknown toolset id "${tag}" (profile.tools); skipping\n`);
            }
        }
        return _dedupByName([...byName.values(), ...skillTools]);
    }

    switch (toolSpec) {
        case 'mcp':
            return _dedupByName([...mcp, ...skillTools]);
        case 'readonly': {
            const readTools = ALL_BUILTIN_SESSION_TOOLS.filter(t => ['read', 'grep', 'glob'].includes(t.name));
            return _dedupByName([...readTools, ...mcp, ...skillTools]);
        }
        case 'full':
        default:
            return _dedupByName([...ALL_BUILTIN_SESSION_TOOLS, ...mcp, ...skillTools]);
    }
}

function permissionFromToolSpec(toolSpec) {
    if (toolSpec === 'readonly') return 'read';
    if (toolSpec === 'mcp') return 'mcp';
    if (Array.isArray(toolSpec)) {
        const tags = new Set(toolSpec.map(t => String(t || '').trim()));
        const hasWriteOrShell = tags.has('full')
            || tags.has('tools:filesystem')
            || tags.has('tools:bash')
            || tags.has('tools:git')
            || tags.has('tools:analysis');
        if (tags.has('tools:readonly') && !hasWriteOrShell) return 'read';
    }
    return null;
}

let nextId = Date.now();
// Known context windows for the current-generation models this plugin
// routes to. Anything not listed falls through to guessContextWindow() —
// local llama/mistral/phi default to 8192, everything else 128000. Keep
// this map trimmed to live models; older generations slow down reads
// without buying anything.
const CONTEXT_WINDOWS = {
    // OpenAI GPT-5.x family
    'gpt-5.5': 1000000,
    'gpt-5.4-mini': 1000000,
    'gpt-5.4-nano': 1000000,
    // Anthropic Claude 4.x
    'claude-opus-4-7': 1000000,
    'claude-sonnet-4-6': 1000000,
    'claude-haiku-4-5-20251001': 200000,
    // Google Gemini 3.x
    'gemini-3.1-pro': 1000000,
    'gemini-3-pro': 1000000,
    'gemini-3-flash': 1000000,
};
function guessContextWindow(model) {
    if (CONTEXT_WINDOWS[model])
        return CONTEXT_WINDOWS[model];
    if (model.includes('llama') || model.includes('mistral') || model.includes('phi'))
        return 8192;
    return 128000;
}
// Provider-scoped unified cache key. Goal: all orchestrator-internal
// dispatches (bridge/maintenance/mcp/scheduler/webhook) targeting the
// same provider land in a single server-side cache shard, so the
// shared prefix (tools + system + pool system prompt) is reused
// regardless of role. Per-role / per-session differentiation lives in
// the message tail, which is naturally separated by content hashing.
const PROVIDER_ALIAS = {
    'openai-oauth': 'codex',      // ChatGPT subscription (Codex backend)
    'anthropic-oauth': 'claude',  // Claude Max subscription
    'openai': 'openai',
    'anthropic': 'anthropic',
    'gemini': 'gemini',
    'deepseek': 'deepseek',
    'xai': 'xai',
};
function providerCacheKey(provider, override) {
    if (override) return String(override);
    if (!provider) return 'mixdog-default';
    return `mixdog-${PROVIDER_ALIAS[provider] || provider}`;
}

// Fast-path eligibility gate. The bridge fast paths (find_symbol / env-grep /
// code_graph direct) skip the LLM and return a synthesized one-liner. That's
// great for "where is X defined?" but catastrophic when the prompt is a long
// multi-step instruction that merely mentions an identifier — the agent then
// answers with a random symbol match and 0 LLM output. Require short,
// non-imperative prompts before any fast path may fire.
function _isSimpleIdentifierLookup(prompt) {
    const text = String(prompt || '').trim();
    if (!text) return false;
    // Char cap defends the words>12 gate against languages without inter-word
    // spaces. A 200-char Korean / Japanese / Chinese instruction can tokenise
    // as 1-3 whitespace "words" and slip through, then return a one-line
    // symbol match instead of routing to the LLM.
    if (text.length > 200) return false;
    // Strict: short imperative prompts ("Read X and update Y") must not qualify.
    if (text.length > 80) return false;
    if ((text.match(/\b(?:Read|Write|Edit|Update|Show|List|Find)\b/gi) || []).length > 2) return false;
    if (/\b(?:and|then|step\s*\d)\b/i.test(text)) return false;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > 12) return false;
    if (/\b(list|propose|evaluate|identify|trace|review|audit|summarize|design|implement|refactor|analyze|compare|suggest|recommend|walkthrough|walk\s+through)\b/i.test(text)) return false;
    // CJK imperative / verb denylist — same intent in Korean / Japanese /
    // Chinese. Mirrors the English denylist above so long instructions in
    // any of those languages also fall through to the LLM path.
    if (/(분석|검토|구현|수정|정리|리팩토|리뷰|감사|요약|설계|비교|추천|평가|조사|확인|작성|개선|보고)/.test(text)) return false;
    if (/(分析|検討|実装|修正|整理|レビュー|要約|設計|比較|推薦|評価|調査|確認)/.test(text)) return false;
    if (/(分析|检查|实现|修改|整理|审查|总结|设计|比较|推荐|评价|调查|确认)/.test(text)) return false;
    return true;
}

function _extractBridgeIdentifier(prompt) {
    const text = String(prompt || '');
    const backticked = text.match(/`([^`]{2,120})`/);
    if (backticked?.[1] && /^[A-Za-z_][A-Za-z0-9_]{1,}$/.test(backticked[1].trim())) return backticked[1].trim();
    const candidates = text.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) || [];
    const STOPWORDS = new Set([
        'Where', 'What', 'Which', 'Find', 'Return', 'Summarize', 'Read',
        'Use', 'Your', 'This', 'That', 'These', 'Those', 'The', 'A', 'An',
        'How', 'Why', 'When', 'Who',
        'GitHub', 'Github', 'GitLab', 'Gitlab',
    ]);
    const strongCandidates = candidates.filter((token) => {
        if (STOPWORDS.has(token)) return false;
        if (/^[A-Z][A-Z0-9_]+$/.test(token)) return true;
        if (/^[a-z]+(?:[A-Z][A-Za-z0-9]*)+$/.test(token)) return true;
        if (/^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/.test(token)) return true;
        if (/^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/.test(token)) return true;
        if (/\d/.test(token)) return true;
        return false;
    });
    let best = null;
    let bestScore = -Infinity;
    for (const token of strongCandidates) {
        let score = 0;
        if (/^[A-Z][A-Z0-9_]+$/.test(token)) score += 10;
        if (/^[a-z]+(?:[A-Z][A-Za-z0-9]*)+$/.test(token)) score += 7;
        if (/^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/.test(token)) score += 6;
        if (/^[A-Z][A-Za-z0-9]*_[A-Za-z0-9_]+$/.test(token)) score += 8;
        if (/^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/.test(token)) score += 6;
        score += Math.min(token.length, 24) / 10;
        if (score > bestScore) {
            best = token;
            bestScore = score;
        }
    }
    // Fail-closed: long prose with a weakly-attested token is ambiguous — return null.
    const imperativeInPrompt = /\b(?:Read|Write|Edit|Update|Show|List|Find|Refactor|Implement|Delete|Remove|Add|Create)\b/i.test(text);
    if (imperativeInPrompt && best !== null) {
        const occurrences = (text.match(new RegExp(`\\b${best.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')) || []).length;
        if (occurrences < 2) {
            // Exception: short prompt + single strong-pattern candidate + retrieval verb → accept.
            const isRetrievalVerb = /\b(?:Find|Show|Locate|List)\b/.test(text);
            const isSingleCandidate = strongCandidates.length === 1;
            const isShort = text.length <= 80;
            if (isShort && isSingleCandidate && isRetrievalVerb) return best;
            return null;
        }
    }
    return best;
}

function _isEnvLikeIdentifier(identifier) {
    return /^[A-Z][A-Z0-9_]+$/.test(String(identifier || ''));
}

function _extractKnownFilePaths(prompt, cwd, maxFiles = 4) {
    // Fix 3: no launcher-cwd fallback. When caller has no project cwd
    // (cycle1/memory-cycle etc.), we cannot validate path existence against
    // an arbitrary host workspace — return empty and let downstream branches
    // handle the no-project-cwd case.
    if (!cwd) return [];
    const text = String(prompt || '');
    const matches = text.match(/\b(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g) || [];
    const out = [];
    const seen = new Set();
    for (const raw of matches) {
        if (seen.has(raw)) continue;
        seen.add(raw);
        const abs = pathResolve(cwd, raw);
        try {
            const st = statSync(abs);
            if (!st.isFile()) continue;
            out.push(raw);
            if (out.length >= maxFiles) break;
        } catch {
            continue;
        }
    }
    return out;
}

function _parseFindSymbolBestCandidate(rawText) {
    const lines = String(rawText || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const marker = lines.indexOf('# best declaration candidate');
    if (marker === -1 || marker + 2 >= lines.length) return null;
    const loc = lines[marker + 1];
    const decl = lines[marker + 2];
    const match = loc.match(/^(.+?):(\d+):(\d+)/);
    if (!match) return null;
    const [, filePath, lineStr] = match;
    const contextLine = lines.find((line, idx) => idx > marker + 2 && line.startsWith('context:'));
    return {
        filePath,
        line: Number(lineStr),
        declaration: decl,
        context: contextLine ? contextLine.replace(/^context:\s*/, '') : '',
    };
}

function _parseGrepBestCandidate(rawText) {
    const lines = String(rawText || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const topHeader = lines.indexOf('# top candidates');
    if (topHeader !== -1) {
        const candidate = lines[topHeader + 1];
        const m = candidate?.match(/^\d+\.\s+(.+?):(\d+)\s+\[(decl|hit)\]\s+(.+)$/);
        if (m) {
            return { filePath: m[1], line: Number(m[2]), kind: m[3], content: m[4] };
        }
    }
    for (const line of lines) {
        const m = line.match(/^(.+?):(\d+):(.+)$/);
        if (!m) continue;
        return { filePath: m[1], line: Number(m[2]), kind: 'hit', content: m[3].trim() };
    }
    return null;
}

function _summarizeFastPath(identifier, candidate, readOut) {
    const nearby = String(readOut || '').split('\n').slice(0, 8).join('\n').trim();
    const parts = [
        `Best code match for \`${identifier}\`: \`${candidate.filePath}:${candidate.line}\`.`,
    ];
    if (candidate.declaration) parts.push(`Declaration: ${candidate.declaration}`);
    if (candidate.context) parts.push(`Context: ${candidate.context}`);
    if (candidate.content) parts.push(`Match: ${candidate.content}`);
    if (nearby) parts.push(`Nearby lines:\n${nearby}`);
    return parts.join('\n\n');
}

function _summarizeDeclarationShape(identifier, declaration) {
    const line = String(declaration || '');
    if (/\bObject\.freeze\(\[/.test(line)) return `${identifier} starts a frozen array definition.`;
    if (/\bObject\.freeze\(\{/.test(line)) return `${identifier} starts a frozen object definition.`;
    if (/\bexport\s+const\b/.test(line)) return `${identifier} is exported as a constant.`;
    if (/\bconst\b/.test(line)) return `${identifier} is defined as a constant.`;
    if (/\bfunction\b/.test(line)) return `${identifier} is defined as a function.`;
    if (/\bclass\b/.test(line)) return `${identifier} is defined as a class.`;
    if (/\binterface\b/.test(line)) return `${identifier} is defined as an interface.`;
    if (/\btype\b/.test(line)) return `${identifier} is defined as a type alias.`;
    return `${identifier} is defined here.`;
}

function _summarizeDefinitionFastPath(identifier, candidate) {
    const parts = [
        `Best code match for \`${identifier}\`: \`${candidate.filePath}:${candidate.line}\`.`,
        _summarizeDeclarationShape(identifier, candidate.declaration),
    ];
    if (candidate.declaration) parts.push(`Declaration: ${candidate.declaration}`);
    if (candidate.context) parts.push(`Context: ${candidate.context}`);
    return parts.join('\n\n');
}

function _summarizeEnvFlagFastPath(identifier, candidate) {
    const line = String(candidate?.content || '').trim();
    const parts = [
        `Best code match for \`${identifier}\`: \`${candidate.filePath}:${candidate.line}\`.`,
    ];
    if (/process\.env\.[A-Za-z_][A-Za-z0-9_]*\s*===?\s*['"]?1['"]?/.test(line) && /\breturn\b/.test(line)) {
        parts.push(`${identifier} acts as an on/off guard here; when it is set to \`'1'\`, the surrounding code returns early.`);
    } else if (/process\.env\./.test(line)) {
        parts.push(`${identifier} is used here as an environment guard.`);
    }
    if (line) parts.push(`Match: ${line}`);
    return parts.join('\n\n');
}

const EXPLICIT_PROMPT_TOOL_VERBS = String.raw`(?:use|call|run|invoke|prefer)`;
const EXPLICIT_PROMPT_TOOL_NEGATION = String.raw`(?:do\s+not|don't|never)\s+${EXPLICIT_PROMPT_TOOL_VERBS}`;
function _escapeToolRegex(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function _explicitPromptToolChoiceName(prompt, tools) {
    const text = String(prompt || '');
    if (!text || !Array.isArray(tools) || tools.length === 0) return null;
    const names = tools.map(tool => tool?.name).filter(Boolean).sort((a, b) => b.length - a.length);
    for (const name of names) {
        const escaped = _escapeToolRegex(name);
        const quotedName = '`?' + escaped + '`?';
        const positive = new RegExp(`\\b${EXPLICIT_PROMPT_TOOL_VERBS}\\s+(?:exactly\\s+one\\s+|one\\s+)?${quotedName}\\b`, 'i');
        const negative = new RegExp(`\\b${EXPLICIT_PROMPT_TOOL_NEGATION}\\s+${quotedName}\\b`, 'i');
        if (positive.test(text) && !negative.test(text)) return name;
    }
    if (names.includes('list') && /\buse\s+(?:exactly\s+)?one\s+directory\s+(?:find|metadata|list)\s+query\b/i.test(text)) {
        return 'list';
    }
    return null;
}

function _extractDirectoryMetadataRequest(prompt) {
    const text = String(prompt || '');
    if (!/\bsize\b|\bbytes?\b|\bmtime\b|\bmodified\b|\bnewest\b|\boldest\b/i.test(text)) return null;
    const pathMatch = text.match(/\b(?:under|in|within)\s+`([^`]+)`/i)
        || text.match(/\b(?:under|in|within)\s+([./~A-Za-z0-9_-]+)/i);
    const path = pathMatch?.[1]?.trim();
    if (!path) return null;
    // Strict: reject numeric-only paths; require path separator, known prefix, or known top-level dir name.
    const KNOWN_TOP_DIRS = new Set(['src', 'dev', 'rules', 'scripts']);
    const validPath = /^(?:\.\/|\/|~)/.test(path) || path.includes('/') || KNOWN_TOP_DIRS.has(path);
    if (!validPath) return null;
    const minSizeMatch = text.match(/\b(?:larger|greater|more)\s+than\s+(\d+)\s*bytes?\b/i)
        || text.match(/\b(?:over|above)\s+(\d+)\s*bytes?\b/i);
    const maxSizeMatch = text.match(/\b(?:smaller|less)\s+than\s+(\d+)\s*bytes?\b/i)
        || text.match(/\b(?:under|below)\s+(\d+)\s*bytes?\b/i);
    const name = /\bjson\b/i.test(text) ? '*.json' : '*';
    const newest = /\bnewest\b|\blatest\b|\bmost\s+recent\b/i.test(text);
    const oldest = /\boldest\b/i.test(text);
    return {
        path,
        name,
        mode: newest || oldest ? 'list' : 'find',
        sort: newest || oldest ? 'mtime' : 'name',
        min_size: minSizeMatch ? Number(minSizeMatch[1]) : 0,
        max_size: maxSizeMatch ? Number(maxSizeMatch[1]) : 0,
    };
}

function _metadataRequestNeedsSelectedFileRead(prompt) {
    const text = String(prompt || '');
    return /\bread\b/i.test(text)
        || /\b(?:codename|marker|payload|content|value|field)\b/i.test(text)
        || /\bextract\b/i.test(text);
}

function _firstListedPath(listText) {
    for (const line of String(listText || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('Error:') || trimmed.startsWith('path\t')) continue;
        const first = trimmed.split(/\t/)[0]?.trim();
        if (first && !first.startsWith('(')) return first;
    }
    return null;
}

async function _tryBridgeFastPath(session, prompt, effectiveCwd, onToolCall) {
    if (session?.owner !== 'bridge') return null;
    // Hidden roles (recall-agent / search-agent / explorer / cycle1-agent /
    // cycle2-agent) own their retrieval tools — memory_search,
    // web_search, glob/grep/read fan-out — and must not be intercepted by the
    // generic bridge classifier. Without this guard, an identifier in the
    // recall prompt routes to code_graph(references) and returns the graph's
    // "file not found" string in place of an actual memory hit.
    if (isHiddenRole(session?.role)) return null;
    // Fix 3: pass null cwd through — `_extractKnownFilePaths` returns [] when
    // there is no project cwd, so filesystem-existence checks never leak the
    // launcher's working directory into bridge fast-path intent classification.
    const fastPathCwd = effectiveCwd || session.cwd || null;
    const knownFiles = _extractKnownFilePaths(prompt, fastPathCwd, 1);
    const identifier = _extractBridgeIdentifier(prompt);
    const intentCandidates = [];
    if (identifier) intentCandidates.push('definition_lookup', 'usage_lookup', 'callers', 'references');
    if (knownFiles.length >= 1) intentCandidates.push('dependents', 'imports');
    const intent = await _classifyPromptIntentImpl(prompt, [...new Set(intentCandidates)]).catch(() => null);

    const resolveIdentifierCandidate = async () => {
        if (!identifier) return null;
        const symbolText = await executeInternalTool('find_symbol', { symbol: identifier }).catch(() => null);
        const candidate = symbolText ? _parseFindSymbolBestCandidate(symbolText) : null;
        if (!candidate?.filePath || !Number.isFinite(candidate.line)) return null;
        onToolCall?.(1, [{ name: 'find_symbol', arguments: { symbol: identifier } }]);
        return candidate;
    };

    if (identifier && ['callers', 'references'].includes(intent || '') && _isSimpleIdentifierLookup(prompt)) {
        const graphArgs = {
            mode: intent === 'callers' ? 'callers' : 'references',
            symbol: identifier,
        };
        const graphOut = await executeInternalTool('code_graph', graphArgs).catch(() => null);
        const _gs658 = String(graphOut ?? '');
        if (graphOut && !_gs658.startsWith('Error:') && !/file not found in graph/i.test(_gs658) && !/^\(no [^)]+\)$/m.test(_gs658)) {
            onToolCall?.(1, [{ name: 'code_graph', arguments: graphArgs }]);
            return {
                content: _gs658,
                iterations: 2,
                toolCallsTotal: 1,
                usage: null,
            };
        }
    }

    if (identifier && intent === 'usage_lookup' && !_isEnvLikeIdentifier(identifier) && _isSimpleIdentifierLookup(prompt)) {
        const candidate = await resolveIdentifierCandidate();
        if (candidate) {
            const graphArgs = {
                mode: 'references',
                file: candidate.filePath,
                symbol: identifier,
            };
            const graphOut = await executeInternalTool('code_graph', graphArgs).catch(() => null);
            const _gs678 = String(graphOut ?? '');
            if (graphOut && !_gs678.startsWith('Error:') && !/file not found in graph/i.test(_gs678) && !/^\(no [^)]+\)$/m.test(_gs678)) {
                onToolCall?.(2, [{ name: 'code_graph', arguments: graphArgs }]);
                return {
                    content: _gs678,
                    iterations: 3,
                    toolCallsTotal: 2,
                    usage: null,
                };
            }
        }
    }

    // Strong structural signals first — require explicit definition_lookup
    // classification AND a simple-lookup-shaped prompt. The previous `|| intent
    // === null` fallthrough misfired on any long instruction that happened to
    // contain an identifier.
    if (identifier && intent === 'definition_lookup' && _isSimpleIdentifierLookup(prompt)) {
        const symbolText = await executeInternalTool('find_symbol', { symbol: identifier }).catch(() => null);
        const candidateFromSymbol = symbolText ? _parseFindSymbolBestCandidate(symbolText) : null;
        if (candidateFromSymbol?.filePath && Number.isFinite(candidateFromSymbol.line)) {
            onToolCall?.(1, [{ name: 'find_symbol', arguments: { symbol: identifier } }]);
            return {
                content: _summarizeDefinitionFastPath(identifier, candidateFromSymbol),
                iterations: 2,
                toolCallsTotal: 1,
                usage: null,
            };
        }
    }

    // Env-flag shape (ALL_CAPS_WITH_UNDERSCORES) has no intent gate because it
    // is a strong structural signal on its own. Still require a simple-lookup
    // prompt so "list all FOO_BAR usages in ..." long instructions don't hijack.
    if (identifier && _isEnvLikeIdentifier(identifier) && _isSimpleIdentifierLookup(prompt) && fastPathCwd) {
        // Fix 3: env-flag grep prefetch needs a concrete project cwd. When the
        // caller is cwd-less (cycle1/memory-cycle), skip the prefetch entirely
        // rather than grepping the launcher workspace and fragmenting cache
        // shards per caller.
        const grepArgs = {
            pattern: identifier,
            path: fastPathCwd,
            glob: ['**/*.*'],
            output_mode: 'content',
            head_limit: 20,
            '-n': true,
            '-C': 1,
        };
        const grepOut = await executeInternalTool('grep', grepArgs).catch(() => null);
        const candidate = grepOut ? _parseGrepBestCandidate(grepOut) : null;
        if (candidate?.filePath && Number.isFinite(candidate.line)) {
            onToolCall?.(1, [{ name: 'grep', arguments: grepArgs }]);
            return {
                content: _summarizeEnvFlagFastPath(identifier, candidate),
                iterations: 2,
                toolCallsTotal: 1,
                usage: null,
            };
        }
    }

    if (knownFiles.length >= 1 && ['dependents', 'imports'].includes(intent || '') && _isSimpleIdentifierLookup(prompt)) {
        const mode = intent === 'imports' ? 'imports' : 'dependents';
        const graphArgs = { mode, file: knownFiles[0] };
        const graphOut = await executeInternalTool('code_graph', graphArgs).catch(() => null);
        const _gid = String(graphOut ?? '');
        if (graphOut && !_gid.startsWith('Error:') && !/file not found in graph/i.test(_gid) && !/^\(no [^)]+\)$/m.test(_gid)) {
            onToolCall?.(1, [{ name: 'code_graph', arguments: graphArgs }]);
            return {
                content: _gid,
                iterations: 2,
                toolCallsTotal: 1,
                usage: null,
            };
        }
    }

    return null;
}

async function _tryBridgeExplicitPrefetch(session, explicitPrefetch) {
    if (!explicitPrefetch || typeof explicitPrefetch !== 'object') return null;
    if (session?.owner !== 'bridge') return null;
    const parts = [];
    const failed = [];
    const totalEntries = [];
    // files[]
    const files = Array.isArray(explicitPrefetch.files) ? explicitPrefetch.files.filter(f => typeof f === 'string' && f) : [];
    if (files.length > 0) {
        const readOut = await executeInternalTool('read', { path: files, mode: 'head', n: 120 }).catch((e) => {
            process.stderr.write(`[bridge-prefetch] files read failed: ${e && e.message || e}\n`);
            failed.push(...files);
            return null;
        });
        if (readOut && !String(readOut).startsWith('Error:')) {
            parts.push(`### prefetch files\n${readOut}`);
        } else if (readOut !== null) {
            failed.push(...files);
        }
        totalEntries.push(...files);
    }
    // callers[]
    const callers = Array.isArray(explicitPrefetch.callers) ? explicitPrefetch.callers.filter(c => c && typeof c.symbol === 'string') : [];
    for (const { symbol, file } of callers) {
        const cgArgs = { mode: 'callers', symbol };
        if (file) cgArgs.file = file;
        totalEntries.push(symbol);
        const out = await executeInternalTool('code_graph', cgArgs).catch((e) => {
            process.stderr.write(`[bridge-prefetch] callers(${symbol}) failed: ${e && e.message || e}\n`);
            failed.push(symbol);
            return null;
        });
        if (out && !String(out).startsWith('Error:')) {
            parts.push(`### prefetch callers ${symbol}\n${out}`);
        } else if (out !== null) {
            failed.push(symbol);
        }
    }
    // references[]
    const references = Array.isArray(explicitPrefetch.references) ? explicitPrefetch.references.filter(r => r && typeof r.symbol === 'string') : [];
    for (const { symbol, file } of references) {
        const cgArgs = { mode: 'references', symbol };
        if (file) cgArgs.file = file;
        totalEntries.push(symbol);
        const out = await executeInternalTool('code_graph', cgArgs).catch((e) => {
            process.stderr.write(`[bridge-prefetch] references(${symbol}) failed: ${e && e.message || e}\n`);
            failed.push(symbol);
            return null;
        });
        if (out && !String(out).startsWith('Error:')) {
            parts.push(`### prefetch references ${symbol}\n${out}`);
        } else if (out !== null) {
            failed.push(symbol);
        }
    }
    if (parts.length === 0) {
        // All entries failed but Lead presence must still be signalled — emit
        // warn-only so the gate logic can distinguish "prefetch was requested"
        // from "no prefetch at all".
        if (totalEntries.length > 0 && failed.length > 0) {
            return `<prefetch-warn>${failed.length} of ${totalEntries.length} prefetch entries failed: ${[...new Set(failed)].join(', ')}</prefetch-warn>`;
        }
        return null;
    }
    const warnLine = failed.length > 0
        ? `<prefetch-warn>${failed.length} of ${totalEntries.length} prefetch entries failed: ${[...new Set(failed)].join(', ')}</prefetch-warn>\n`
        : '';
    return `${warnLine}<prefetch>\n${parts.join('\n\n')}\n</prefetch>`;
}

async function _tryBridgePrefetchContext(session, prompt, effectiveCwd, onToolCall) {
    if (session?.owner !== 'bridge') return null;
    if (isHiddenRole(session?.role)) return null;
    // Fix 3: pass null cwd through — `_extractKnownFilePaths` returns [] for
    // cwd-less callers, so the read-array prefetch further down naturally
    // becomes a no-op instead of resolving against the launcher's cwd.
    const prefetchCwd = effectiveCwd || session.cwd || null;
    const knownFiles = _extractKnownFilePaths(prompt, prefetchCwd);
    const identifier = _extractBridgeIdentifier(prompt);

    const metadataRequest = _extractDirectoryMetadataRequest(prompt);
    if (metadataRequest && prefetchCwd) {
        // Fix 3: directory-metadata prefetch drives builtin list/read with an
        // explicit cwd. When the caller is cwd-less, skip the prefetch so we
        // do not invoke builtin tools against the launcher's working directory
        // (executeBuiltinTool has its own `cwd || process.cwd()` fallback that
        // we cannot touch from this file).
        // If the user explicitly asked the worker to call a concrete tool, let
        // the normal loop satisfy that instruction. Prefetching in front of an
        // explicit list/read benchmark can otherwise produce duplicate calls.
        if (_explicitPromptToolChoiceName(prompt, session.tools)) return null;
        const listArgs = {
            path: metadataRequest.path,
            mode: metadataRequest.mode,
            depth: metadataRequest.mode === 'find' ? 10 : 1,
            type: 'file',
            name: metadataRequest.name,
            min_size: metadataRequest.min_size,
            max_size: metadataRequest.max_size,
            head_limit: 20,
            sort: metadataRequest.sort,
        };
        const callerCwd = prefetchCwd;
        const listStartedAt = Date.now();
        const listOut = await executeBuiltinTool('list', listArgs, callerCwd, { sessionId: session.id }).catch(() => null);
        if (listOut && !String(listOut).startsWith('Error:')) {
            onToolCall?.(1, [{ name: 'list', arguments: listArgs }]);
            traceBridgeTool({
                sessionId: session.id,
                iteration: 1,
                toolName: 'list',
                toolKind: 'builtin',
                toolMs: Date.now() - listStartedAt,
                toolArgs: listArgs,
            });
            const firstPath = _firstListedPath(listOut);
            if (firstPath && _metadataRequestNeedsSelectedFileRead(prompt)) {
                const readArgs = { path: firstPath, mode: 'full', n: 20, offset: 0, limit: 2000, full: false };
                const readStartedAt = Date.now();
                const readOut = await executeBuiltinTool('read', readArgs, callerCwd, { sessionId: session.id }).catch(() => null);
                if (readOut && !String(readOut).startsWith('Error:')) {
                    onToolCall?.(2, [{ name: 'read', arguments: readArgs }]);
                    traceBridgeTool({
                        sessionId: session.id,
                        iteration: 2,
                        toolName: 'read',
                        toolKind: 'builtin',
                        toolMs: Date.now() - readStartedAt,
                        toolArgs: readArgs,
                    });
                    return `Prefetched directory metadata and the selected file. The requested list/read work is complete. Answer from this evidence and do NOT call any tool again for this request.\n\n### list\n${listOut}\n\n### read ${firstPath}\n${readOut}`;
                }
            }
            return `Prefetched directory metadata. Answer from this listing and do NOT call any tool again for this request.\n\n${listOut}`;
        }
    }

    if (knownFiles.length < 2) return null;
    const readArgs = { path: knownFiles, mode: 'head', n: 120 };
    const readOut = await executeInternalTool('read', readArgs).catch(() => null);
    if (!readOut || String(readOut).startsWith('Error:')) return null;
    onToolCall?.(1, [{ name: 'read', arguments: readArgs }]);
    return `Prefetched files for this request. Answer directly from these excerpts unless they are clearly insufficient. Do NOT re-read the same files unless the excerpts are missing the specific detail you need.\n\n${readOut}`;
}
// --- create_session ---
// opts can pass either a `preset` object (from config.presets) or raw provider/model.
// Preset shape: { name, provider, model, effort?, fast?, tools? }
//
// Smart Bridge integration:
//   opts.taskType / opts.role / opts.profileId — enables profile-aware routing.
//     Rule-based SmartRouter resolves these synchronously; the resolved
//     profile controls context filtering (skip.skills/memory/etc) and cache
//     strategy. If no rule matches, falls back to classic preset behavior.
//   opts.profile — pre-resolved profile (bypasses router; used by async
//     callers who already ran SmartBridge.resolve()).
//   opts.providerCacheOpts — pre-resolved cache options merged into ask() sendOpts.
export function createSession(opts) {
    const presetObj = opts.preset && typeof opts.preset === 'object' ? opts.preset : null;

    // --- Smart Bridge profile resolution (best-effort, sync) ---
    let profile = opts.profile || null;
    let providerCacheOpts = opts.providerCacheOpts || null;
    if (!profile && (opts.taskType || opts.role || opts.profileId)) {
        const smartBridge = getSmartBridgeSync();
        if (smartBridge) {
            try {
                const resolved = smartBridge.resolveSync({
                    taskType: opts.taskType,
                    role: opts.role,
                    profileId: opts.profileId,
                    preset: presetObj?.name || (typeof opts.preset === 'string' ? opts.preset : null),
                    provider: opts.provider || presetObj?.provider,
                });
                if (resolved) {
                    profile = resolved.profile;
                    providerCacheOpts = resolved.providerCacheOpts;
                }
            } catch (e) {
                // Smart Bridge error — log once, fall back to classic behavior.
                if (!_smartBridgeWarned) {
                    _smartBridgeWarned = true;
                    process.stderr.write(`[session] smart bridge resolve failed: ${e.message}\n`);
                }
            }
        }
    }

    const providerName = opts.provider || presetObj?.provider
        || (profile?.preferredProviders?.[0]);
    const modelName = opts.model || presetObj?.model;
    // opts.tools (caller-supplied) wins over presetObj.tools — caller
    // intent ('tools:readonly' from Pool C, etc.) must override the
    // preset's default 'full'. Previous priority let HAIKU's tools='full'
    // shadow Pool C's explicit readonly request, leaking write tools and
    // bash into a read-only agent.
    const toolPreset = opts.tools || presetObj?.tools || (typeof opts.preset === 'string' ? opts.preset : null) || 'full';
    const effort = presetObj?.effort || opts.effort || null;
    const fast = presetObj?.fast === true || opts.fast === true;
    if (!providerName)
        throw new Error('createSession: provider is required');
    if (!modelName)
        throw new Error('createSession: model is required');
    const provider = getProvider(providerName);
    if (!provider)
        throw new Error(`Provider "${providerName}" not found or not enabled`);
    const id = `sess_${process.pid}_${nextId++}_${Date.now()}_${randomBytes(3).toString('hex')}`;
    const messages = [];
    const agentTemplate = opts.agent ? loadAgentTemplate(opts.agent, opts.cwd) : null;
    const skills = collectSkillsCached(opts.cwd);

    // Bridge shared prefix (bit-identical across roles). Hidden roles reuse the
    // same shared bridge rules so the cache shard stays stable across bridge
    // callers. User-defined data (DATA_DIR roles/schedules/webhooks) is baked
    // into BP1 as a single fixed-value monolithic block so every role shares
    // one cache shard. A user edit invalidates BP1 once and the new prefix
    // re-warms across all roles together.
    const bridgeRulesRole = opts.role || profile?.taskType || null;
    const bridgeRules = opts.skipBridgeRules ? '' : _buildBridgeRules();
    const roleSpecific = opts.skipBridgeRules ? '' : _buildRoleSpecific(bridgeRulesRole);
    // Project MD (cwd-based, Tier 3 slot).
    const projectContext = collectProjectMd(opts.cwd);

    // Role template (Phase B §4 — UI-managed). Reads <DATA_DIR>/roles/<role>.md
    // and parses frontmatter (description, permission). The template is
    // injected into the Tier 3 system-reminder so role differences never
    // touch the BP_2 cache prefix.
    const resolvedRole = opts.role || profile?.taskType || null;
    const dataDir = process.env.CLAUDE_PLUGIN_DATA;
    const roleTemplate = resolvedRole && dataDir
        ? loadRoleTemplate(resolvedRole, dataDir)
        : null;

    // Bridge sessions must not inherit role/profile/preset tool narrowing: Pool
    // B and Pool C share one bit-identical tool schema for BP_1/BP_2 cache
    // reuse, and permission differences are enforced only at call time. Raw
    // non-bridge callers keep the historical profile.tools / preset.tools
    // behaviour.
    const toolSpec = opts.owner === 'bridge'
        ? 'full'
        : (Array.isArray(profile?.tools) ? profile.tools : toolPreset);

    // Prompt permission is metadata only. Preset tool restrictions must NOT
    // enter the prompt, or they split the shared bridge cache tail; they map
    // to toolPermission below and are enforced only at call time.
    const permission = opts.permission
        || roleTemplate?.permission
        || null;
    const toolPermission = opts.permission
        || profile?.permission
        || roleTemplate?.permission
        || permissionFromToolSpec(toolPreset)
        || null;
    const toolsForRouting = resolveSessionTools(toolSpec, skills, { ownerIsBridge: opts.owner === 'bridge' });

    const { baseRules, roleCatalog, sessionMarker, volatileTail } = composeSystemPrompt({
        userPrompt: opts.systemPrompt,
        bridgeRules: bridgeRules || undefined,
        roleSpecific: roleSpecific || undefined,
        agentTemplate: agentTemplate || undefined,
        roleTemplate: roleTemplate || undefined,
        hasSkills: skills.length > 0,
        profile: profile || undefined,
        role: resolvedRole,
        skipRoleReminder: opts.skipRoleReminder || false,
        permission,
        taskBrief: opts.taskBrief || null,
        projectContext: projectContext || null,
        tools: toolsForRouting,
        bashIsPersistent: opts.owner === 'bridge' && toolsForRouting.some(t => t?.name === 'bash'),
        // Effective cwd rides in tier3Reminder so explore-like tools know
        // their search root without needing to shove "Override cwd:" into
        // the user message body (that used to fragment the shard prefix).
        cwd: opts.cwd || null,
        // BP2 catalog policy — explicit-cache providers see the unified
        // all-roles catalog; implicit-prefix-hash providers keep self-only.
        provider: providerName || null,
    });
    // 4-BP layout (see composeSystemPrompt docs):
    //   system block #1 = baseRules    — BP1 (1h) shared across ALL roles
    //   system block #2 = roleCatalog  — BP2 (1h) shared across ALL roles
    //   first <system-reminder> user   = sessionMarker — BP3 (1h) per-role+project
    //   second <system-reminder> user  = volatileTail  — rides near BP4 (5m)
    // Anthropic multi-block system pins each block with its own cache_control;
    // OpenAI/Gemini concatenate server-side but the prefix-bytes still match
    // so prompt caching still saturates.
    if (baseRules) {
        messages.push({ role: 'system', content: baseRules });
    }
    if (roleCatalog) {
        messages.push({ role: 'system', content: roleCatalog });
    }
    if (sessionMarker) {
        messages.push({ role: 'user', content: `<system-reminder>\n${sessionMarker}\n</system-reminder>` });
        messages.push({ role: 'assistant', content: 'Session context noted.' });
    }
    if (volatileTail) {
        messages.push({ role: 'user', content: `<system-reminder>\n${volatileTail}\n</system-reminder>` });
        messages.push({ role: 'assistant', content: 'Understood.' });
    }
    if (opts.files?.length) {
        const fileContext = opts.files
            .map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
            .join('\n\n');
        messages.push({ role: 'user', content: `Reference files:\n\n${fileContext}` });
        messages.push({ role: 'assistant', content: 'Understood. I have the files in context.' });
    }
    let tools = toolsForRouting;

    // Deny-list layers, merged into one set and applied after schema build:
    //   - opts.disallowedTools : per-call caller override (Anthropic
    //     BuiltInAgentDefinition pattern)
    //   - BRIDGE_DENY_TOOLS    : Lead-only admin surface (channel, session
    //     lifecycle, schedule/config, bridge dispatch, memory admin, AST
    //     editors). See BRIDGE_DENY_TOOLS declaration for the full keep/strip
    //     rationale. Pool A (Lead) still sees the full tools.json.
    //
    // Pool C direct tools (memory_search / web_search) intentionally remain
    // in Pool B schemas too. Runtime guards in loop.mjs reject them outside
    // hidden roles, preserving behavior while keeping the B/C cache prefix
    // bit-identical.
    const callerDeny = Array.isArray(opts.disallowedTools) ? opts.disallowedTools.map(n => String(n)) : [];
    const bridgeDeny = opts.owner === 'bridge' ? BRIDGE_DENY_TOOLS : [];
    const mergedDeny = [...new Set([...callerDeny, ...bridgeDeny])];
    if (mergedDeny.length) {
        const denySet = new Set(mergedDeny);
        const before = tools.length;
        tools = tools.filter(t => !denySet.has(String(t?.name || '').toLowerCase()));
        if (tools.length !== before) {
            process.stderr.write(`[session] disallowedTools=${mergedDeny.join(',')} stripped ${before - tools.length} tools\n`);
        }
    }

    // Bridge tool canonicalization: alphabetize by name so MCP/internal
    // registration order does not fragment the BP1 tools shard.
    if (opts.owner === 'bridge') {
        tools = [...tools].sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')));
    }

    // Unified-shard policy — no role-specific schema filter.
    // Every bridge session (Pool B + Pool C) gets the same tool array so the
    // provider-side cache shard is bit-identical across roles. Role-specific
    // behaviour is steered at two other layers:
    //   1. prompt (rules/bridge/*.md concatenated into BP2 roleCatalog)
    //   2. call-time guards (loop.mjs READ_BLOCKED_TOOLS + ai-wrapped-dispatch
    //      recursion break)
    // Do NOT re-introduce an `opts.allowedTools` whitelist here — it would
    // fragment the shard and force every role onto its own cache prefix.
    if (resolvedRole) {
        process.stderr.write(`[session] role=${resolvedRole} permission=${permission || 'full'} toolPermission=${toolPermission || 'full'} tools=${tools.length}\n`);
    }
    const session = {
        id,
        provider: providerName,
        model: modelName,
        messages,
        contextWindow: guessContextWindow(modelName),
        tools,
        preset: toolPreset,
        presetName: presetObj?.name || null,
        effort,
        fast,
        agent: opts.agent,
        owner: opts.owner || 'user',
        mcpPid: process.pid,
        scopeKey: opts.scopeKey || null,
        lane: opts.lane || 'bridge',
        cwd: opts.cwd,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastHeartbeatAt: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        // Refreshed on each completed ask() — surfaced by list_sessions for
        // debugging + consumed by store.mjs's idle-sweep to reclaim stalled
        // bridge sessions past RUNNING_STALL_MS.
        lastUsedAt: Date.now(),
        tokensCumulative: 0,
        role: opts.role || null,
        // Prompt permission is separate from runtime toolPermission so preset
        // restrictions do not fragment the bridge cache prefix.
        permission: permission || null,
        toolPermission: toolPermission || null,
        // Origin tag written into every bridge-trace usage row so analytics
        // can slice by (sourceType, sourceName) — e.g. maintenance/cycle1,
        // scheduler/daily-standup, webhook/github-push, lead/worker.
        sourceType: opts.sourceType || null,
        sourceName: opts.sourceName || null,
        // Provider-scoped unified cache key — one shard per provider,
        // shared across all roles / sources (bridge/maintenance/mcp/
        // scheduler/webhook). Role or source-specific context must be
        // injected into the message tail, not the shared prefix.
        promptCacheKey: providerCacheKey(presetObj?.provider || opts.provider, opts.cacheKeyOverride),
        // Bridge shell continuity: when a bridge session explicitly opts into
        // persistent shell state (`bash` with `persistent:true`, or direct
        // `bash_session`), the minted bash_session id is stored here so later
        // opted-in `bash` calls can reuse the same shell state.
        implicitBashSessionId: null,
        // Smart Bridge metadata — optional. Applied on every ask() to merge
        // profile-driven cache settings into provider sendOpts.
        profileId: profile?.id || null,
        providerCacheOpts: providerCacheOpts || null,
    };
    saveSession(session);
    return session;
}

// ── Runtime liveness map ──────────────────────────────────────────────
// In-memory only. Tracks per-session stage + stream heartbeat so list_sessions
// can surface whether a session is actually alive vs stuck. Never persisted —
// heartbeats would otherwise churn the session JSON on every SSE delta.
// Entry shape: {
//   stage, lastStreamDeltaAt, lastToolCall, lastError, updatedAt,
//   controller?: AbortController,  // set while an ask is in flight
//   generation?: number,            // snapshot taken at ask start
//   closed?: boolean,               // flipped by closeSession()
// }
const _runtimeState = new Map();
const VALID_STAGES = new Set([
    'connecting', 'requesting', 'streaming', 'tool_running', 'idle', 'error', 'done', 'cancelling',
]);
function _touchRuntime(id) {
    let entry = _runtimeState.get(id);
    if (!entry) {
        entry = { stage: 'idle', lastStreamDeltaAt: null, lastToolCall: null, lastError: null, updatedAt: Date.now() };
        _runtimeState.set(id, entry);
    }
    return entry;
}
export function updateSessionStage(id, stage) {
    if (!id || !VALID_STAGES.has(stage)) return;
    const entry = _touchRuntime(id);
    entry.stage = stage;
    entry.updatedAt = Date.now();
}
/**
 * Reset heartbeat-visible fields for a new ask. Preserves controller/generation/
 * closed (lifecycle) but clears the previous run's streaming state so stale
 * lastToolCall / lastStreamDeltaAt from the previous ask don't leak into the
 * new one.
 */
export function markSessionAskStart(id) {
    if (!id) return;
    const entry = _touchRuntime(id);
    entry.stage = 'connecting';
    entry.lastStreamDeltaAt = null;
    entry.lastToolCall = null;
    entry.lastError = null;
    // askStartedAt is the watchdog's fallback reference when a session
    // hangs before any stream delta arrives. Without it, a provider that
    // never returns a first token would stall forever because the watchdog
    // keys solely on lastStreamDeltaAt.
    entry.askStartedAt = Date.now();
    entry.updatedAt = Date.now();
}
export function markSessionStreamDelta(id) {
    if (!id) return;
    const entry = _touchRuntime(id);
    const now = Date.now();
    entry.lastStreamDeltaAt = now;
    // Only promote to 'streaming' if we were in a pre-stream stage; never downgrade
    // mid-tool (tool_running has its own delta source if the tool streams back).
    if (entry.stage === 'connecting' || entry.stage === 'requesting') {
        entry.stage = 'streaming';
    }
    const session = loadSession(id);
    if (session && now - (session.lastHeartbeatAt || 0) > HEARTBEAT_THROTTLE_MS) {
        session.lastHeartbeatAt = now;
        saveSession(session);
    }
    entry.updatedAt = now;
}
export function markSessionToolCall(id, toolName) {
    if (!id) return;
    const entry = _touchRuntime(id);
    entry.stage = 'tool_running';
    entry.lastToolCall = toolName || null;
    entry.toolStartedAt = Date.now();
    entry.updatedAt = entry.toolStartedAt;
}
export function markSessionDone(id) {
    if (!id) return;
    const entry = _touchRuntime(id);
    entry.stage = 'done';
    entry.lastError = null;
    entry.askStartedAt = null;
    entry.toolStartedAt = null;
    entry.updatedAt = Date.now();
}
export function markSessionError(id, msg) {
    if (!id) return;
    const entry = _touchRuntime(id);
    entry.stage = 'error';
    entry.lastError = msg ? String(msg).slice(0, 200) : null;
    entry.askStartedAt = null;
    entry.toolStartedAt = null;
    entry.updatedAt = Date.now();
}
export function getSessionRuntime(id) {
    return id ? (_runtimeState.get(id) || null) : null;
}
/**
 * Iterate all active session runtimes. Used by the stream watchdog.
 * Returns an iterable of [sessionId, entry] pairs; consumers should
 * treat entries as read-only snapshots and avoid mutating them.
 */
export function forEachSessionRuntime() {
    return _runtimeState.entries();
}
export function getSessionAbortSignal(sessionId) {
    return _runtimeState.get(sessionId)?.controller?.signal ?? null;
}

/**
 * Link a parent AbortSignal to a sub-session's controller so that aborting
 * the parent (fan-out deadline or caller ESC) tears down the sub-agent's
 * provider call promptly. Safe to call after prepareBridgeSession but before
 * askSession completes. No-op if the session runtime isn't found.
 *
 * @param {string} sessionId — the sub-session to abort
 * @param {AbortSignal} parentSignal — upstream signal (from fan-out coordinator)
 */
export function linkParentSignalToSession(sessionId, parentSignal) {
    if (!(parentSignal instanceof AbortSignal)) return;
    const entry = _touchRuntime(sessionId);
    if (!entry.controller) entry.controller = createAbortController();
    if (parentSignal.aborted) {
        try { entry.controller.abort(new Error('parent signal aborted')); } catch { /* ignore */ }
        return;
    }
    parentSignal.addEventListener('abort', () => {
        try { entry.controller?.abort(new Error('parent signal aborted')); } catch { /* ignore */ }
    }, { once: true });
}
function _clearSessionRuntime(id) {
    if (id) _runtimeState.delete(id);
}

/**
 * Wrap an async call so that if the session's controller aborts mid-flight,
 * the wrapper settles with a SessionClosedError even if the underlying promise
 * hasn't returned yet. The original promise is kept alive with a detached
 * `.catch()` to prevent unhandled-rejection warnings once it eventually
 * settles. Callers still must check generation/closed after await returns
 * to handle providers that ignore the AbortSignal entirely.
 */
export async function _api_call_with_interrupt(sessionId, fn) {
    const entry = _touchRuntime(sessionId);
    if (!entry.controller) entry.controller = createAbortController();
    const signal = entry.controller.signal;
    if (signal.aborted) throw new SessionClosedError(sessionId, 'aborted before call');
    const underlying = fn(signal);
    underlying.catch(() => {}); // prevent unhandled rejection if we race ahead
    let onAbort = null;
    const aborted = new Promise((_, reject) => {
        onAbort = () => reject(new SessionClosedError(sessionId, 'aborted during call'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([underlying, aborted]);
    } finally {
        // If the underlying promise settled first, the abort listener is
        // still attached. Remove it to avoid accumulating listeners across
        // many asks on the same session.
        if (onAbort && !signal.aborted) {
            try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
        }
    }
}

// Per-session mutex: queues concurrent askSession calls to prevent message loss
const _sessionLocks = new Map();
function acquireSessionLock(sessionId) {
    let entry = _sessionLocks.get(sessionId);
    if (!entry) {
        entry = { promise: Promise.resolve(), count: 0 };
        _sessionLocks.set(sessionId, entry);
    }
    entry.count++;
    const prev = entry.promise;
    let release;
    entry.promise = new Promise(r => { release = r; });
    return prev.then(() => () => {
        entry.count--;
        if (entry.count === 0) _sessionLocks.delete(sessionId);
        release();
    });
}

export async function askSession(sessionId, prompt, context, onToolCall, cwdOverride, explicitPrefetch) {
    const _askStartedAt = Date.now();
    const unlock = await acquireSessionLock(sessionId);
    // ── Synchronous pre-await setup (must happen before any await so
    //    closeSession() can't interleave between load and registration) ──
    const preSession = loadSession(sessionId);
    if (!preSession) {
        unlock();
        throw new Error(`Session "${sessionId}" not found`);
    }
    if (preSession.closed === true) {
        unlock();
        throw new SessionClosedError(sessionId, 'session already closed');
    }
    const askGeneration = typeof preSession.generation === 'number' ? preSession.generation : 0;
    const runtime = _touchRuntime(sessionId);
    // Fresh controller per ask — the previous ask's controller may have aborted.
    runtime.controller = createAbortController();
    runtime.generation = askGeneration;
    runtime.closed = false;
    markSessionAskStart(sessionId);
    try {
        // Preprocessing is inside try so provider-not-available / trim failures
        // fall into the catch and mark the session as errored rather than
        // leaving stage='connecting' forever.
        try {
            const session = preSession;
            const provider = getProvider(session.provider);
            if (!provider)
                throw new Error(`Provider "${session.provider}" not available`);
            // Cap caller-supplied / prefetched context so an oversized
            // payload can't blow the session token budget before the
            // first model call. 32 KB ~ 8k tokens at the 4 B/tok
            // working average; longer is silently truncated with a
            // visible marker so the model still sees the prefix and
            // a hint about the cut.
            const _CTX_CHAR_CAP = 32 * 1024;
            const _capCtx = (text) => {
                if (typeof text !== 'string') return '';
                if (text.length <= _CTX_CHAR_CAP) return text;
                return `${text.slice(0, _CTX_CHAR_CAP)}\n\n... [context truncated; original ${text.length} chars]`;
            };
            if (context) {
                session.messages.push({ role: 'user', content: `Additional context:\n\n${_capCtx(context)}` });
                session.messages.push({ role: 'assistant', content: 'Noted.' });
            }
            const explicitPrefetchResult = await _tryBridgeExplicitPrefetch(session, explicitPrefetch);
            if (explicitPrefetchResult) {
                session.messages.push({ role: 'user', content: `Additional context:\n\n${_capCtx(explicitPrefetchResult)}` });
                session.messages.push({ role: 'assistant', content: 'Noted.' });
            }
            // Gate: if Lead supplied any prefetch entries (files/callers/references),
            // skip both heuristic prefetch and fast-path regardless of whether the
            // explicit prefetch succeeded. Lead presence is the gate, not success.
            const _hasExplicitPrefetchEntries = (ep) => {
                if (!ep || typeof ep !== 'object') return false;
                return (Array.isArray(ep.files) && ep.files.length > 0)
                    || (Array.isArray(ep.callers) && ep.callers.length > 0)
                    || (Array.isArray(ep.references) && ep.references.length > 0);
            };
            const _explicitPresent = _hasExplicitPrefetchEntries(explicitPrefetch);
            const prefetchedContext = _explicitPresent ? null : await _tryBridgePrefetchContext(session, prompt, cwdOverride || session.cwd, onToolCall);
            if (prefetchedContext) {
                session.messages.push({ role: 'user', content: `Additional context:\n\n${_capCtx(prefetchedContext)}` });
                session.messages.push({ role: 'assistant', content: 'Noted.' });
            }
            const beforeCount = session.messages.length + 1;
            // Soft warning only; real size management (compaction primary,
            // byte-budget trim as safety net) lives in agentLoop. Selecting a
            // 25% pre-trim here would starve compaction's 50% threshold.
            const softBudget = Math.floor(session.contextWindow * 0.25);
            const promptTokenEstimate = prompt.length * 0.5; // conservative for CJK
            if (promptTokenEstimate > softBudget * 0.7) {
                process.stderr.write(`[session] Warning: prompt is very large (est. ${Math.round(promptTokenEstimate)} tokens vs ${softBudget} soft budget)\n`);
            }
            const effectiveCwd = cwdOverride || session.cwd;
            const fastPath = prefetchedContext
                ? null
                : (_explicitPresent ? null : await _tryBridgeFastPath(session, prompt, effectiveCwd, onToolCall));
            if (fastPath) {
                session.messages = [...session.messages, { role: 'user', content: prompt }];
                if (fastPath.content) {
                    session.messages.push({ role: 'assistant', content: fastPath.content });
                }
                session.updatedAt = Date.now();
                session.lastUsedAt = Date.now();
                saveSession(session);
                markSessionDone(sessionId);
                return fastPath;
            }
            const outgoing = [...session.messages, { role: 'user', content: prompt }];
            const forcedFirstTool = prefetchedContext ? null : _explicitPromptToolChoiceName(prompt, session.tools);
            const result = await _api_call_with_interrupt(sessionId, (signal) =>
                agentLoop(provider, outgoing, session.model, session.tools, onToolCall, effectiveCwd, {
                    effort: session.effort || null,
                    fast: session.fast === true,
                    sessionId,
                    promptCacheKey: session.promptCacheKey || sessionId,
                    // Provider-scoped cache key (mixdog-codex, mixdog-claude…).
                    // Distinct from sessionId — providers that pool sockets
                    // per-session (openai-oauth WS) use sessionId as the
                    // pool bucket and providerCacheKey as the server-side
                    // prompt-cache shard so parallel callers don't collide
                    // on a mid-turn socket while still sharing prefix cache.
                    providerCacheKey: session.promptCacheKey || null,
                    signal,
                    providerState: session.providerState ?? undefined,
                    session,
                    // Smart Bridge cache settings — merged last so session overrides
                    // don't get overridden by defaults. When session has no profile,
                    // providerCacheOpts is null and this spread is a no-op.
                    ...(session.providerCacheOpts || {}),
                    forcedFirstTool,
                    onStageChange: (stage) => updateSessionStage(sessionId, stage),
                    onStreamDelta: () => markSessionStreamDelta(sessionId),
                }),
            );
            // Post-loop validation: if closeSession() landed while we were awaiting,
            // drop the save so the tombstone on disk isn't overwritten.
            const currentRuntime = _runtimeState.get(sessionId);
            if (currentRuntime?.closed || currentRuntime?.generation !== askGeneration) {
                const reason = currentRuntime?.closedReason;
                throw new SessionClosedError(sessionId, `closed during call (reason=${reason || 'unknown'})`, reason || null);
            }
            // Update and save. outgoing is mutated in place by agentLoop
            // (compaction + safety trim), so its length reflects post-loop state.
            const messagesDropped = Math.max(0, beforeCount - outgoing.length);
            session.messages = outgoing;
            if (result.content) {
                session.messages.push({ role: 'assistant', content: result.content });
            }
            session.updatedAt = Date.now();
            session.lastUsedAt = Date.now();
            if (result.usage) {
                session.totalInputTokens += result.usage.inputTokens;
                session.totalOutputTokens += result.usage.outputTokens;
                session.tokensCumulative = (session.tokensCumulative || 0)
                    + (result.usage.inputTokens || 0)
                    + (result.usage.outputTokens || 0);
            }
            // Smart Bridge cache stats — record hit/miss after every successful
            // ask so the registry reflects all bridge traffic, not just
            // maintenance cycles. Guarded against any smart-bridge error so
            // metric recording never breaks the ask itself.
            let prefixHashForLog = null;
            if (session.profileId && result.usage && _smartBridgeApi) {
                try {
                    const profile = _smartBridgeApi.getProfile(session.profileId);
                    if (profile) {
                        // Collect every leading system-role message (BP1, BP2, ...)
                        // until the first non-system message so the registry hash
                        // captures the full ordered provider prefix, not just BP1.
                        const systemMsgs = [];
                        for (const m of session.messages) {
                            if (m?.role !== 'system') break;
                            systemMsgs.push(typeof m.content === 'string' ? m.content : '');
                        }
                        _smartBridgeApi.recordCall(profile, session.provider, {
                            systemPrompt: systemMsgs,
                            tools: session.tools || [],
                            usage: result.usage,
                        });
                        const entry = _smartBridgeApi.registry?.data?.profiles?.[session.profileId]?.[session.provider];
                        prefixHashForLog = entry?.prefixHash || null;
                    }
                } catch {}
            }
            // Append to bridge-trace.jsonl with the rich bridge usage fields.
            if (result.usage) {
                const inputTokens = result.usage.inputTokens || 0;
                const outputTokens = result.usage.outputTokens || 0;
                const cacheReadTokens = result.usage.cachedTokens || 0;
                const cacheWriteTokens = result.usage.cacheWriteTokens || 0;
                // Unified total-prompt field. Anthropic = input+cache_read+cache_write
                // (additive); OpenAI/Codex/Gemini = input_tokens already includes the
                // cached portion (inclusive), so the fallback must not double-count.
                const { isInclusiveProvider, computeCostUsd } = await import('../../../shared/llm/cost.mjs');
                const inclusive = isInclusiveProvider(session.provider);
                const promptTokens = typeof result.usage.promptTokens === 'number'
                    ? result.usage.promptTokens
                    : (inclusive
                        ? Math.max(inputTokens, cacheReadTokens + cacheWriteTokens)
                        : inputTokens + cacheReadTokens + cacheWriteTokens);
                let costUsd = result.usage.costUsd || 0;
                if (!costUsd) {
                    try {
                        costUsd = computeCostUsd({
                            model: session.model,
                            provider: session.provider,
                            inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
                        });
                    } catch { /* best-effort */ }
                }
                logLlmCall({
                    ts: new Date().toISOString(),
                    sourceType: session.sourceType || 'lead',
                    sourceName: session.sourceName || session.role || null,
                    preset: session.presetName || null,
                    model: session.model,
                    provider: session.provider,
                    duration: Date.now() - _askStartedAt,
                    profileId: session.profileId || null,
                    sessionId: session.id,
                    inputTokens,
                    outputTokens,
                    cacheReadTokens,
                    cacheWriteTokens,
                    promptTokens,
                    prefixHash: prefixHashForLog,
                    costUsd,
                });
            }
            // Persist opaque providerState for future stateful providers.
            // No provider currently emits it (Codex OAuth is stateless per
            // contract), so this branch is dormant — kept so a future
            // Responses-API provider with stable continuation can plug in
            // without reworking the session shape.
            if (result.providerState !== undefined) {
                session.providerState = result.providerState;
            }
            saveSession(session, { expectedGeneration: askGeneration });
            markSessionDone(sessionId);
            return {
                ...result,
                trimmed: messagesDropped > 0,
                messagesDropped,
            };
        } catch (err) {
            if (err instanceof SessionClosedError) {
                // Cancellation is not an error; propagate silently so callers
                // can render it as "cancelled" rather than a red failure.
                throw err;
            }
            markSessionError(sessionId, err && err.message ? err.message : String(err));
            throw err;
        }
    } finally {
        // Clear the controller only if it's still ours (closeSession may have
        // swapped it). Leave the rest of the runtime entry intact so list_sessions
        // can still surface the final stage (done/error/cancelling).
        const entry = _runtimeState.get(sessionId);
        if (entry && entry.generation === askGeneration) {
            entry.controller = null;
        }
        unlock();
    }
}
// Session lookup by scopeKey — used by CLI bridge to resume a pinned
// scope session when the caller passes --scope (agent/<name>).
export function findSessionByScopeKey(scopeKey) {
    if (!scopeKey) return null;
    const sessions = listStoredSessions();
    // Exclude tombstoned sessions (`closed === true`) so callers never receive
    // a session whose controller was aborted by closeSession(). The `closed`
    // bit is the authoritative tombstone flag; `status === 'error'` is not,
    // since transient-error sessions remain resumable.
    return sessions.find(s => s.scopeKey === scopeKey && s.closed !== true) || null;
}
// --- resume (reload tools for a stored session) ---
export function resumeSession(sessionId, preset) {
    const session = loadSession(sessionId);
    if (!session)
        return null;
    // Resuming a closed session is a resurrection attempt — refuse. The guarded
    // save below would also block the write, but failing fast here is cleaner
    // than silently dropping the tool-refresh side effects.
    if (session.closed === true) return null;
    if (!session.owner) session.owner = 'user';
    // Refresh tools (MCP connections may have changed).
    // Re-resolve from profile.tools when the session stored a profileId —
    // otherwise fall back to preset.tools. Same resolution order as
    // createSession so resume and spawn produce identical BP_1 shapes.
    const oldTools = session.tools || [];
    const skills = collectSkillsCached(session.cwd);
    let toolSpec = preset || session.preset || 'full';
    if (session.profileId && _smartBridgeApi?.getProfile) {
        try {
            const profile = _smartBridgeApi.getProfile(session.profileId);
            if (Array.isArray(profile?.tools)) toolSpec = profile.tools;
        } catch { /* ignore lookup failures, keep preset fallback */ }
    }
    session.tools = resolveSessionTools(toolSpec, skills, { ownerIsBridge: session.owner === 'bridge' });
    const newTools = session.tools;
    const missing = oldTools.filter(t => !newTools.find(n => n.name === t.name));
    if (missing.length) {
        process.stderr.write(`[session] Warning: ${missing.length} tools no longer available: ${missing.map(t => t.name).join(', ')}\n`);
    }
    saveSession(session, { expectedGeneration: session.generation });
    return session;
}
// --- CRUD ---
export function getSession(id) {
    return loadSession(id);
}
export function listSessions() {
    return listStoredSessions();
}
// --- Clear messages (keep system prompt + provider/model/cwd) ---
export function clearSessionMessages(sessionId) {
    const session = loadSession(sessionId);
    if (!session)
        return false;
    // Don't resurrect a closed session just to clear its messages.
    if (session.closed === true) return false;
    session.messages = (session.messages || []).filter(m => m && m.role === 'system');
    session.totalInputTokens = 0;
    session.totalOutputTokens = 0;
    session.updatedAt = Date.now();
    saveSession(session, { expectedGeneration: session.generation });
    return true;
}
export function updateSessionStatus(id, status) {
    const session = loadSession(id);
    if (!session) return false;
    // Respect tombstones — don't resurrect a closed session just to update a
    // status label (bridge handler emits running→idle/error around askSession).
    if (session.closed === true) return false;
    session.status = status;
    session.updatedAt = Date.now();
    saveSession(session, { expectedGeneration: session.generation });
    return true;
}
/**
 * Close a session. Plants a `closed=true` tombstone on disk with a bumped
 * generation (so any racing saveSession() drops its write), aborts the
 * in-flight controller if one exists, and clears the in-memory runtime entry.
 *
 * IMPORTANT: we deliberately do NOT unlink the session file here. The tombstone
 * on disk is the authoritative signal that blocks resurrection — a late
 * saveSession() re-reads disk via _shouldDrop() and will find the tombstone.
 * If we delete the file, a late save sees no file, decides nothing to drop,
 * and recreates the session in its pre-close state.
 *
 * Long-term cleanup: `sweepTombstones()` below unlinks tombstones older than
 * TOMBSTONE_MAX_AGE_MS (24h — vastly longer than any realistic in-flight race).
 */
export function closeSession(id, reason = 'manual') {
    if (!id) return false;
    const persisted = loadSession(id);
    const bashSessionId = persisted?.implicitBashSessionId || null;
    // 1. Tombstone first — this wins the race against saveSession().
    const newGen = markSessionClosed(id, reason);
    // 2. Mark runtime as closed so post-await validation in askSession fires.
    const entry = _runtimeState.get(id);
    if (entry) {
        entry.closed = true;
        entry.closedReason = reason;
        if (typeof newGen === 'number') entry.generation = newGen;
        entry.stage = 'cancelling';
        entry.updatedAt = Date.now();
        // 3. Abort the in-flight controller. Providers that honour the signal
        //    unwind immediately; providers that don't will still be caught by
        //    the generation check after their await eventually returns.
        try { entry.controller?.abort(new SessionClosedError(id, `closeSession (reason=${reason})`, reason)); } catch { /* ignore */ }
    }
    // Diagnostic: one-line stderr so operators can distinguish the four close
    // pathways (request-abort / manual / idle-sweep / runner-crash). iterCount
    // is not currently tracked on runtime state; askStartedAt is — derive
    // duration from it when present.
    try {
        const askStartedAt = entry?.askStartedAt;
        const durationMs = (typeof askStartedAt === 'number') ? (Date.now() - askStartedAt) : null;
        const parts = [`session=${id}`, `reason=${reason}`];
        if (durationMs != null) parts.push(`duration=${durationMs}ms`);
        process.stderr.write(`[bridge-close] ${parts.join(' ')}\n`);
    } catch { /* best-effort */ }
    if (bashSessionId) {
        try { closeBashSession(bashSessionId, `bridge-close:${id}`); } catch { /* ignore */ }
    }
    // 4. Defer runtime map clear to next tick so any settling askSession can
    //    observe `closed=true` / bumped generation before we yank the entry.
    //    Disk tombstone remains — that's what blocks resurrection.
    setImmediate(() => {
        _clearSessionRuntime(id);
    });
    return true;
}

// --- Periodic idle session cleanup ---
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
const TOMBSTONE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — far longer than any realistic ask race window
let _cleanupTimer = null;

function sweepIdleSessions() {
    try {
        const { cleaned, remaining, details } = sweepStaleSessions();
        if (cleaned > 0) {
            for (const d of details) {
                _clearSessionRuntime(d.id);
                if (d.bashSessionId) {
                    try { closeBashSession(d.bashSessionId, `idle-sweep:${d.id}`); } catch { /* ignore */ }
                }
                process.stderr.write(`[bridge-session] idle cleanup: closed ${d.id} (idle ${d.idleMinutes}m, owner=${d.owner})\n`);
            }
            process.stderr.write(`[bridge-session] idle sweep: cleaned ${cleaned} session(s), ${remaining} remaining\n`);
        }
    } catch (e) {
        process.stderr.write(`[bridge-session] idle sweep error: ${e && e.message || e}\n`);
    }
}

/**
 * Unlink tombstone session files (closed=true) older than TOMBSTONE_MAX_AGE_MS.
 *
 * Rationale: closeSession() leaves the tombstone on disk as the authoritative
 * resurrection-blocker for racing saveSession() calls. That race resolves in
 * microseconds (the window inside _doSave between temp write and rename), so
 * 24h is vastly safe. After the TTL expires we reclaim the disk slot.
 *
 * Uses `getStoredSessionsRaw()` rather than `listStoredSessions()` because the
 * latter's inline 30-min idle cleanup would race-unlink tombstones before we
 * get to log them — we want to own the unlink decision and stderr line here.
 */
export function sweepTombstones() {
    try {
        const now = Date.now();
        const sessions = getStoredSessionsRaw();
        let cleaned = 0;
        for (const s of sessions) {
            if (!s.closed) continue;
            const updated = Number(s.updatedAt);
            if (!Number.isFinite(updated)) continue;
            const age = now - updated;
            if (age < TOMBSTONE_MAX_AGE_MS) continue;
            try {
                deleteSession(s.id);
                _clearSessionRuntime(s.id);
                cleaned++;
                process.stderr.write(`[session-sweep] unlinked tombstone ${s.id} (age=${Math.floor(age / 1000)}s)\n`);
            } catch (e) {
                process.stderr.write(`[session-sweep] unlink failed ${s.id}: ${e && e.message || e}\n`);
            }
        }
        return cleaned;
    } catch (e) {
        process.stderr.write(`[session-sweep] tombstone sweep error: ${e && e.message || e}\n`);
        return 0;
    }
}

function _runCleanupCycle() {
    sweepIdleSessions();
    sweepTombstones();
}

export function startIdleCleanup() {
    if (_cleanupTimer) return;
    _cleanupTimer = setInterval(_runCleanupCycle, CLEANUP_INTERVAL_MS);
    if (_cleanupTimer.unref) _cleanupTimer.unref(); // don't block process exit
}

export function stopIdleCleanup() {
    if (_cleanupTimer) {
        clearInterval(_cleanupTimer);
        _cleanupTimer = null;
    }
}

// Test-only exports for local smoke harnesses.
export const _internals = {
    _extractBridgeIdentifier,
    _isSimpleIdentifierLookup,
    _extractDirectoryMetadataRequest,
    _tryBridgeFastPath,
    _tryBridgePrefetchContext,
    // Allows harnesses to inject a deterministic classifyPromptIntent mock
    // so fast-path branch tests don't depend on live embedding calls.
    // Only active when MIXDOG_TEST_EXPORTS=1.
    ...(process.env.MIXDOG_TEST_EXPORTS === '1' ? {
        _setClassifyPromptIntentForTest(fn) { _classifyPromptIntentImpl = fn; },
        _resetClassifyPromptIntentForTest() { _classifyPromptIntentImpl = classifyPromptIntent; },
    } : {}),
};
