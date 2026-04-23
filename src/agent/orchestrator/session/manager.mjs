import { createRequire } from 'module';
import { randomBytes } from 'crypto';
import { existsSync, statSync } from 'fs';
import { join, resolve as pathResolve } from 'path';
import { homedir } from 'os';
import { getProvider } from '../providers/registry.mjs';
import { agentLoop } from './loop.mjs';
import { getMcpTools } from '../mcp/client.mjs';
import { getInternalTools, executeInternalTool } from '../internal-tools.mjs';
import { BUILTIN_TOOLS } from '../tools/builtin.mjs';
import { BASH_SESSION_TOOL_DEFS } from '../tools/bash-session.mjs';
import { PATCH_TOOL_DEFS } from '../tools/patch.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../tools/code-graph.mjs';
import { closeBashSession } from '../tools/bash-session.mjs';
import { collectSkillsCached, buildSkillToolDefs, loadAgentTemplate, loadRoleTemplate, composeSystemPrompt, collectProjectMd } from '../context/collect.mjs';
import { saveSession, loadSession, deleteSession, listStoredSessions, getStoredSessionsRaw, sweepStaleSessions, markSessionClosed } from './store.mjs';
import { createAbortController } from '../../../shared/abort-controller.mjs';
import { logLlmCall } from '../../../shared/llm/usage-log.mjs';
import { classifyPromptIntent } from '../intent-classifier.mjs';
import { resolvePluginData, DEFAULT_PLUGIN, DEFAULT_MARKETPLACE } from '../../../shared/plugin-paths.mjs';

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
// workspace-wide. Write-class tools are still rejected at call time by
// loop.mjs's READ_BLOCKED_TOOLS guard (for permission=read) and the
// bridge-deny list (for Lead-only admin surface); those operate AFTER the
// schema is built, so cache integrity is preserved.

const ALL_BUILTIN_SESSION_TOOLS = _dedupByName([
    ...BUILTIN_TOOLS,
    ...BASH_SESSION_TOOL_DEFS,
    ...PATCH_TOOL_DEFS,
    ...CODE_GRAPH_TOOL_DEFS,
]);

function resolveSessionTools(toolSpec, skills) {
    const mcp = _getMcpToolsCached();
    const skillTools = buildSkillToolDefs(skills);
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

// NOTE: a prior BRIDGE_EXCLUDED_MCP_TOOLS / _filterMcpForBridge pair lived here
// (v0.6.301) as a secondary MCP filter applied inside _computeBaseTools. It was
// removed in v0.6.302 after verifying every one of its 14 entries was already
// present in `BRIDGE_DENY_TOOLS` below — the authoritative bridge deny list
// applied later in createSession — making the function a 100% no-op. Single
// source of truth for "what bridge cannot call" is BRIDGE_DENY_TOOLS.
//
// Canonical bridge deny list — the SINGLE source of truth for which tools a
// bridge-owned session strips from its tool schema. Exported so benchmarks
// (scripts/measure-bp1.mjs) and tests can import the same list instead of
// maintaining a parallel copy that silently drifts.
//
// KEEP (bridge agents can call):
//   - core file / shell: read, edit, write, bash, bash_session, grep, glob
//   - IO helpers: head, tail, wc, list, tree, find_files,
//                 multi_read, multi_edit, batch_edit
//   - Code graph / refactors: code_graph, rename_symbol_refs, rename_file_refs
//   - memory read: recall (memory admin tool itself is Lead-only)
//   - information retrieval: search, explore
export const BRIDGE_DENY_TOOLS = Object.freeze([
    // Discord / channel (Lead-only)
    'reply', 'react', 'edit_message', 'download_attachment', 'fetch',
    'activate_channel_bridge',
    // Session lifecycle (Lead-only)
    'create_session', 'close_session', 'list_sessions', 'list_models',
    // Schedule / config admin (Lead-only)
    'schedule_status', 'trigger_schedule', 'schedule_control', 'reload_config',
    // Bridge dispatch — Pool B/C agents do the work; Lead does the dispatch.
    // Recall/search/explore stay (info retrieval, not role delegation).
    'bridge',
    // Memory admin — cycle1/cycle2/flush/rebuild/prune/remember are
    // maintenance ops Lead drives. Bridge agents read memory via `recall`.
    'memory',
    // AST / specialised editors kept off the bridge schema for now —
    // apply_patch stays because it cuts edit/read round-trips on multi-file work.
    'sg_search', 'sg_rewrite', 'edit_lines', 'diff',
    // Main-session convenience aliases. Bridge roles already know to use
    // `code_graph` / `find_symbol` directly, so carrying alias-only tools
    // here just bloats the shared BP_1 shard without adding capability.
    'find_imports', 'find_dependents', 'find_references', 'find_callers',
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
                    addMany(ALL_BUILTIN_SESSION_TOOLS.filter(t => t.name === 'bash' || t.name === 'bash_session'));
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

let nextId = Date.now();
// Known context windows for the current-generation models this plugin
// routes to. Anything not listed falls through to guessContextWindow() —
// local llama/mistral/phi default to 8192, everything else 128000. Keep
// this map trimmed to live models; older generations slow down reads
// without buying anything.
const CONTEXT_WINDOWS = {
    // OpenAI GPT-5.4 family
    'gpt-5.4': 1000000,
    'gpt-5.4-mini': 1000000,
    'gpt-5.4-nano': 1000000,
    'gpt-5.4-pro': 1000000,
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
};
function providerCacheKey(provider) {
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
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > 12) return false;
    if (/\b(list|propose|evaluate|identify|trace|review|audit|summarize|design|implement|refactor|analyze|compare|suggest|recommend|walkthrough|walk\s+through)\b/i.test(text)) return false;
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
    return best;
}

function _isEnvLikeIdentifier(identifier) {
    return /^[A-Z][A-Z0-9_]+$/.test(String(identifier || ''));
}

const GITHUB_OWNER_PATTERN = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})`;
const GITHUB_REPO_PATTERN = String.raw`[A-Za-z0-9._-]{1,100}`;

function _extractGithubRepoSlug(prompt) {
    const text = String(prompt || '');
    const urlRe = new RegExp(String.raw`(?:https?:\/\/)?(?:www\.)?github\.com\/(${GITHUB_OWNER_PATTERN})\/(${GITHUB_REPO_PATTERN})(?=$|[\/?#\s"'` + "`" + String.raw`.,:;!])`, 'i');
    const urlMatch = text.match(urlRe);
    if (urlMatch?.[1] && urlMatch?.[2]) {
        return { owner: urlMatch[1], repo: urlMatch[2], source: 'github_url' };
    }

    const quotedRe = new RegExp(String.raw`["'` + "`" + String.raw`](${GITHUB_OWNER_PATTERN})\/(${GITHUB_REPO_PATTERN})["'` + "`" + String.raw`]`, 'g');
    for (const m of text.matchAll(quotedRe)) {
        const owner = m[1];
        const repo = m[2];
        if (owner && repo) return { owner, repo, source: 'quoted_slug' };
    }

    const standaloneRe = new RegExp(String.raw`(^|[\s(])(${GITHUB_OWNER_PATTERN})\/(${GITHUB_REPO_PATTERN})(?=$|[\s).,:;!?])`, 'g');
    for (const m of text.matchAll(standaloneRe)) {
        const owner = m[2];
        const repo = m[3];
        if (!owner || !repo) continue;
        // Avoid treating file names / local paths as repo names.
        if (/\.[A-Za-z0-9]{1,6}$/.test(repo)) continue;
        return { owner, repo, source: 'bare_slug' };
    }
    return null;
}

function _isGithubRepoQuery(prompt, repoSlug) {
    if (!repoSlug?.owner || !repoSlug?.repo) return false;
    if (repoSlug.source === 'github_url' || repoSlug.source === 'quoted_slug') return true;
    const text = String(prompt || '').toLowerCase();
    return /\bgithub(?:\.com)?\b|\brepo(?:sitory)?\b/.test(text);
}

function _extractKnownFilePaths(prompt, cwd, maxFiles = 4) {
    const text = String(prompt || '');
    const matches = text.match(/\b(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g) || [];
    const out = [];
    const seen = new Set();
    for (const raw of matches) {
        if (seen.has(raw)) continue;
        seen.add(raw);
        const abs = pathResolve(cwd || process.cwd(), raw);
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

function _extractRepoSearchEvidence(owner, repo, searchText) {
    const lines = String(searchText || '').split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return null;
    const slug = `${owner}/${repo}`.toLowerCase();
    const joined = lines.join('\n').toLowerCase();
    if (!joined.includes(slug) && !joined.includes(`github.com/${slug}`)) return null;
    const title = lines[0]?.replace(/^\d+\.\s*/, '') || `${owner}/${repo}`;
    const summaryLine = lines.find((line, idx) => idx > 0 && !/^https?:\/\//.test(line) && !/^(stars|language|license|default|forks)\b/i.test(line));
    const metaLine = lines.find((line) => /(stars|language|license|default|forks)\b/i.test(line));
    if (!summaryLine && !metaLine) return null;
    return { title, summaryLine, metaLine };
}

function _summarizeRepoSearchText(owner, repo, searchText) {
    const evidence = _extractRepoSearchEvidence(owner, repo, searchText);
    if (!evidence) return null;
    const parts = [`${evidence.title} is ${evidence.summaryLine || 'a GitHub repository.'}`];
    if (evidence.metaLine) parts.push(evidence.metaLine);
    return parts.join('\n\n');
}

async function _searchGithubRepoText(repoSlug) {
    if (!repoSlug?.owner || !repoSlug?.repo) return { searchOut: null, evidence: null, summary: null };
    const searchArgs = {
        github_type: 'repo',
        owner: repoSlug.owner,
        repo: repoSlug.repo,
        site: 'github.com',
        maxResults: 5,
        keywords: `${repoSlug.owner}/${repoSlug.repo}`,
    };
    let searchOut = null;
    try {
        const searchMod = await import('../../../search/index.mjs');
        const raw = await searchMod.handleToolCall('search', searchArgs);
        searchOut = Array.isArray(raw?.content)
            ? raw.content.map((c) => c?.type === 'text' ? c.text || '' : JSON.stringify(c)).join('\n')
            : null;
    } catch {
        searchOut = await executeInternalTool('search', searchArgs).catch(() => null);
    }
    if (!searchOut || String(searchOut).startsWith('Error:')) {
        return { searchOut: null, evidence: null, summary: null };
    }
    const evidence = _extractRepoSearchEvidence(repoSlug.owner, repoSlug.repo, searchOut);
    const summary = evidence ? _summarizeRepoSearchText(repoSlug.owner, repoSlug.repo, searchOut) : null;
    return { searchOut, evidence, summary };
}

async function _tryBridgeFastPath(session, prompt, effectiveCwd, onToolCall) {
    if (session?.owner !== 'bridge') return null;
    const repoSlug = _extractGithubRepoSlug(prompt);
    const knownFiles = _extractKnownFilePaths(prompt, effectiveCwd || session.cwd || process.cwd(), 1);
    const identifier = _extractBridgeIdentifier(prompt);
    const intentCandidates = [];
    if (_isGithubRepoQuery(prompt, repoSlug)) intentCandidates.push('github_repo');
    if (identifier) intentCandidates.push('definition_lookup', 'usage_lookup', 'callers', 'references');
    if (knownFiles.length >= 1) intentCandidates.push('dependents', 'imports');
    const intent = await classifyPromptIntent(prompt, [...new Set(intentCandidates)]).catch(() => null);

    const resolveIdentifierCandidate = async () => {
        if (!identifier) return null;
        const symbolText = await executeInternalTool('find_symbol', { symbol: identifier }).catch(() => null);
        const candidate = symbolText ? _parseFindSymbolBestCandidate(symbolText) : null;
        if (!candidate?.filePath || !Number.isFinite(candidate.line)) return null;
        onToolCall?.(1, [{ name: 'find_symbol', arguments: { symbol: identifier } }]);
        return candidate;
    };

    if (identifier && ['callers', 'references'].includes(intent || '')) {
        const graphArgs = {
            mode: intent === 'callers' ? 'callers' : 'references',
            symbol: identifier,
        };
        const graphOut = await executeInternalTool('code_graph', graphArgs).catch(() => null);
        if (graphOut && !String(graphOut).startsWith('Error:')) {
            onToolCall?.(1, [{ name: 'code_graph', arguments: graphArgs }]);
            return {
                content: String(graphOut),
                iterations: 2,
                toolCallsTotal: 1,
                usage: null,
            };
        }
    }

    if (identifier && intent === 'usage_lookup' && !_isEnvLikeIdentifier(identifier)) {
        const candidate = await resolveIdentifierCandidate();
        if (candidate) {
            const graphArgs = {
                mode: 'references',
                file: candidate.filePath,
                symbol: identifier,
            };
            const graphOut = await executeInternalTool('code_graph', graphArgs).catch(() => null);
            if (graphOut && !String(graphOut).startsWith('Error:')) {
                onToolCall?.(2, [{ name: 'code_graph', arguments: graphArgs }]);
                return {
                    content: String(graphOut),
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
    if (identifier && _isEnvLikeIdentifier(identifier) && _isSimpleIdentifierLookup(prompt)) {
        const grepArgs = {
            pattern: identifier,
            path: effectiveCwd || session.cwd || process.cwd(),
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

    if (intent === 'github_repo' && _isGithubRepoQuery(prompt, repoSlug) && repoSlug && !identifier && knownFiles.length === 0) {
        const searchArgs = {
            github_type: 'repo',
            owner: repoSlug.owner,
            repo: repoSlug.repo,
            site: 'github.com',
            maxResults: 5,
            keywords: `${repoSlug.owner}/${repoSlug.repo}`,
        };
        const { summary } = await _searchGithubRepoText(repoSlug);
        if (summary) {
            onToolCall?.(1, [{ name: 'search', arguments: searchArgs }]);
            return {
                content: summary,
                iterations: 2,
                toolCallsTotal: 1,
                usage: null,
            };
        }
    }

    if (knownFiles.length >= 1 && ['dependents', 'imports'].includes(intent || '')) {
        const mode = intent === 'imports' ? 'imports' : 'dependents';
        const graphArgs = { mode, file: knownFiles[0] };
        const graphOut = await executeInternalTool('code_graph', graphArgs).catch(() => null);
        if (graphOut && !String(graphOut).startsWith('Error:')) {
            onToolCall?.(1, [{ name: 'code_graph', arguments: graphArgs }]);
            return {
                content: String(graphOut),
                iterations: 2,
                toolCallsTotal: 1,
                usage: null,
            };
        }
    }

    return null;
}

async function _tryBridgePrefetchContext(session, prompt, effectiveCwd, onToolCall) {
    if (session?.owner !== 'bridge') return null;
    const repoSlug = _extractGithubRepoSlug(prompt);
    const knownFiles = _extractKnownFilePaths(prompt, effectiveCwd || session.cwd || process.cwd());
    const identifier = _extractBridgeIdentifier(prompt);
    const repoIntent = _isGithubRepoQuery(prompt, repoSlug)
        ? await classifyPromptIntent(prompt, ['github_repo']).catch(() => null)
        : null;
    if (repoSlug && repoIntent === 'github_repo' && !identifier && knownFiles.length === 0) {
        const searchArgs = {
            github_type: 'repo',
            owner: repoSlug.owner,
            repo: repoSlug.repo,
            site: 'github.com',
            maxResults: 5,
            keywords: `${repoSlug.owner}/${repoSlug.repo}`,
        };
        const { searchOut, evidence } = await _searchGithubRepoText(repoSlug);
        if (evidence && searchOut) {
            onToolCall?.(1, [{ name: 'search', arguments: searchArgs }]);
            return `Prefetched repository context for this request. Answer directly from this unless it is clearly insufficient. Do NOT call \`search\` again for the same repository unless the provided result is missing the requested information.\n\n${searchOut}`;
        }
    }

    if (knownFiles.length < 2) return null;
    const reads = knownFiles.map((filePath) => ({
        path: filePath,
        mode: 'head',
        n: 120,
    }));
    const readOut = await executeInternalTool('multi_read', { reads }).catch(() => null);
    if (!readOut || String(readOut).startsWith('Error:')) return null;
    onToolCall?.(1, [{ name: 'multi_read', arguments: { reads } }]);
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
    // callers.
    const bridgeRules = opts.skipBridgeRules ? '' : _buildBridgeRules();
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

    // Profile wins over preset.tools — profile.tools carries toolset ids
    // (['tools:filesystem','tools:search']) that expand to an explicit tool
    // subset, which is how BP_1 actually gets shaped per Phase B spec. When
    // no profile resolves, fall back to the preset.tools string ('full' /
    // 'readonly' / 'mcp') so raw createSession callers still work.
    const toolSpec = Array.isArray(profile?.tools) ? profile.tools : toolPreset;

    // Permission is metadata only — tool schema stays bit-identical regardless
    // of role or permission (unified-shard policy). Write-blocking for
    // `permission=read` happens at call time in loop.mjs's READ_BLOCKED_TOOLS
    // guard, not at schema build time.
    const permission = opts.permission || profile?.permission || roleTemplate?.permission || null;
    const toolsForRouting = resolveSessionTools(toolSpec, skills);

    const { baseRules, roleCatalog, sessionMarker, volatileTail } = composeSystemPrompt({
        userPrompt: opts.systemPrompt,
        bridgeRules: bridgeRules || undefined,
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
        process.stderr.write(`[session] role=${resolvedRole} permission=${permission || 'full'} tools=${tools.length}\n`);
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
        totalInputTokens: 0,
        totalOutputTokens: 0,
        // Refreshed on each completed ask() — surfaced by list_sessions for
        // debugging + consumed by store.mjs's idle-sweep to reclaim stalled
        // bridge sessions past RUNNING_STALL_MS.
        lastUsedAt: Date.now(),
        tokensCumulative: 0,
        role: opts.role || null,
        // Permission persisted on the session so loop.mjs can apply the
        // runtime call-time guard (READ_BLOCKED_TOOLS) without having to
        // re-derive it from the profile / role each turn.
        permission: permission || null,
        // Origin tag written into every bridge-trace usage row so analytics
        // can slice by (sourceType, sourceName) — e.g. maintenance/cycle1,
        // scheduler/daily-standup, webhook/github-push, lead/worker.
        sourceType: opts.sourceType || null,
        sourceName: opts.sourceName || null,
        // Provider-scoped unified cache key — one shard per provider,
        // shared across all roles / sources (bridge/maintenance/mcp/
        // scheduler/webhook). Role or source-specific context must be
        // injected into the message tail, not the shared prefix.
        promptCacheKey: providerCacheKey(presetObj?.provider || opts.provider),
        // Bridge shell continuity: when a bridge session explicitly opts into
        // persistent shell state (`bash` with `persistent:true`, or direct
        // `bash_session`), the minted bash_session id is stored here so later
        // opted-in `bash` calls can reuse the same shell state.
        implicitBashSessionId: null,
        // Hermes-style in-flight compressor state
        compressionCount: 0,
        previousSummary: null,
        // Smart Bridge metadata — optional. Applied on every ask() to merge
        // profile-driven cache settings into provider sendOpts.
        profileId: profile?.id || null,
        providerCacheOpts: providerCacheOpts || null,
        // Profile lifecycle behavior, copied at spawn. Kept for bridge-trace
        // joinability — scheduler/webhook callers filter by behavior even
        // though the orchestrator no longer branches on the value.
        behavior: profile?.behavior || null,
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
    entry.lastStreamDeltaAt = Date.now();
    // Only promote to 'streaming' if we were in a pre-stream stage; never downgrade
    // mid-tool (tool_running has its own delta source if the tool streams back).
    if (entry.stage === 'connecting' || entry.stage === 'requesting') {
        entry.stage = 'streaming';
    }
    entry.updatedAt = Date.now();
}
export function markSessionToolCall(id, toolName) {
    if (!id) return;
    const entry = _touchRuntime(id);
    entry.stage = 'tool_running';
    entry.lastToolCall = toolName || null;
    entry.updatedAt = Date.now();
}
export function markSessionDone(id) {
    if (!id) return;
    const entry = _touchRuntime(id);
    entry.stage = 'done';
    entry.lastError = null;
    entry.askStartedAt = null;
    entry.updatedAt = Date.now();
}
export function markSessionError(id, msg) {
    if (!id) return;
    const entry = _touchRuntime(id);
    entry.stage = 'error';
    entry.lastError = msg ? String(msg).slice(0, 200) : null;
    entry.askStartedAt = null;
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

export async function askSession(sessionId, prompt, context, onToolCall, cwdOverride) {
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
            if (context) {
                session.messages.push({ role: 'user', content: `Additional context:\n\n${context}` });
                session.messages.push({ role: 'assistant', content: 'Noted.' });
            }
            const prefetchedContext = await _tryBridgePrefetchContext(session, prompt, cwdOverride || session.cwd, onToolCall);
            if (prefetchedContext) {
                session.messages.push({ role: 'user', content: `Additional context:\n\n${prefetchedContext}` });
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
                : await _tryBridgeFastPath(session, prompt, effectiveCwd, onToolCall);
            if (fastPath) {
                session.messages = [...session.messages, { role: 'user', content: prompt }];
                if (fastPath.content) {
                    session.messages.push({ role: 'assistant', content: fastPath.content });
                }
                session.updatedAt = Date.now();
                session.lastUsedAt = Date.now();
                saveSession(session);
                unlock();
                return fastPath;
            }
            const outgoing = [...session.messages, { role: 'user', content: prompt }];
            const result = await _api_call_with_interrupt(sessionId, (signal) =>
                agentLoop(provider, outgoing, session.model, session.tools, onToolCall, effectiveCwd, {
                    effort: session.effort || null,
                    fast: session.fast === true,
                    sessionId,
                    promptCacheKey: session.promptCacheKey || sessionId,
                    signal,
                    providerState: session.providerState ?? undefined,
                    session,
                    // Smart Bridge cache settings — merged last so session overrides
                    // don't get overridden by defaults. When session has no profile,
                    // providerCacheOpts is null and this spread is a no-op.
                    ...(session.providerCacheOpts || {}),
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
                        const systemMsg = session.messages[0]?.role === 'system' ? session.messages[0].content : '';
                        _smartBridgeApi.recordCall(profile, session.provider, {
                            systemPrompt: systemMsg,
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
                // Unified total-prompt field. Providers set it explicitly;
                // fallback sums the billable slots when missing (Anthropic-shape).
                const promptTokens = typeof result.usage.promptTokens === 'number'
                    ? result.usage.promptTokens
                    : (inputTokens + cacheReadTokens + cacheWriteTokens);
                let costUsd = result.usage.costUsd || 0;
                if (!costUsd) {
                    try {
                        const { computeCostUsd } = await import('../../../shared/llm/cost.mjs');
                        costUsd = computeCostUsd({
                            model: session.model,
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
    // Backfill compressor state for sessions created before the feature landed.
    if (typeof session.compressionCount !== 'number') session.compressionCount = 0;
    if (session.previousSummary === undefined) session.previousSummary = null;
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
    session.tools = resolveSessionTools(toolSpec, skills);
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
    _extractGithubRepoSlug,
    _isGithubRepoQuery,
    _tryBridgeFastPath,
    _tryBridgePrefetchContext,
};
