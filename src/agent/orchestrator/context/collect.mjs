import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
// --- Agent template loading ---
/**
 * Load an agent MD file (Worker.md, Reviewer.md, etc.) as session instructions.
 * Strips frontmatter, returns the body.
 */
// Agent template cache — walkForAgent() recurses the whole marketplaces
// tree, which is the single most expensive file-system call in
// createSession. Cache per (name, cwd) with a 60s TTL so repeated Pool C
// fan-out in the same window pays the walk cost once.
const _agentTemplateCache = new Map();
const AGENT_TEMPLATE_TTL = 60_000;
export function loadAgentTemplate(name, cwd) {
    // When cwd is null/missing (bridge maintenance callers like cycle1-agent
    // pass cwd:null on purpose so provider-cache shards don't fork per MCP
    // launch dir), skip the project-scoped template lookup entirely — DO NOT
    // fall back to process.cwd(), which would leak the launcher's working
    // directory into the cache key and fragment the shard per caller workspace.
    const projectDir = (typeof cwd === 'string' && cwd.length > 0) ? cwd : null;
    const key = `${name}|${projectDir ?? '__noproject__'}`;
    const cached = _agentTemplateCache.get(key);
    if (cached && Date.now() - cached.ts < AGENT_TEMPLATE_TTL) return cached.value;
    // Search paths for agent files. Drop the <projectDir>/.claude/agents
    // entry when cwd is missing; home-level + plugin walk still apply so the
    // function's "no template found → null" contract is preserved via the
    // normal readSafe loop below.
    const searchPaths = [];
    if (projectDir) {
        searchPaths.push(join(projectDir, '.claude', 'agents', `${name}.md`));
    }
    searchPaths.push(join(homedir(), '.claude', 'agents', `${name}.md`));
    // Also search plugin directories
    const pluginBase = join(homedir(), '.claude', 'plugins', 'marketplaces');
    if (existsSync(pluginBase)) {
        try {
            walkForAgent(pluginBase, name, searchPaths);
        }
        catch { /* ignore */ }
    }
    for (const p of searchPaths) {
        const content = readSafe(p);
        if (content) {
            // Strip YAML frontmatter
            const stripped = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
            const body = stripped.trim();
            _agentTemplateCache.set(key, { ts: Date.now(), value: body });
            return body;
        }
    }
    _agentTemplateCache.set(key, { ts: Date.now(), value: null });
    return null;
}
/**
 * Collect available skills (frontmatter only — token efficient).
 * Full content loaded on demand via loadSkillContent().
 */
export function collectSkills(cwd) {
    // When cwd is null/missing (e.g. bridge maintenance callers that pass
    // cwd:null on purpose so provider-cache shards don't fork per caller
    // workspace), skip project-scoped skills entirely — DO NOT fall back
    // to process.cwd(), which would leak the MCP launch dir into the
    // shard key and fragment the cache.
    const projectDir = (typeof cwd === 'string' && cwd.length > 0) ? cwd : null;
    const skills = [];
    const dirs = [
        join(homedir(), '.claude', 'skills'),
    ];
    if (projectDir) {
        dirs.push(join(projectDir, '.claude', 'skills'));
    }
    // Plugin skill directories
    const pluginBase = join(homedir(), '.claude', 'plugins', 'marketplaces');
    if (existsSync(pluginBase)) {
        try {
            walkForSkills(pluginBase, dirs);
        }
        catch { /* ignore */ }
    }
    const seen = new Set();
    for (const dir of dirs) {
        if (!existsSync(dir))
            continue;
        try {
            const files = readdirSync(dir, { recursive: true });
            for (const f of files) {
                if (!String(f).endsWith('.md'))
                    continue;
                const filePath = join(dir, String(f));
                const content = readSafe(filePath);
                if (!content)
                    continue;
                const fm = parseFrontmatter(content);
                if (!fm.name)
                    continue;
                if (seen.has(fm.name))
                    continue;
                seen.add(fm.name);
                skills.push({
                    name: fm.name,
                    description: fm.description || '',
                    filePath,
                });
            }
        }
        catch { /* ignore */ }
    }
    return skills;
}
// --- Skill cache (TTL-based) ---
// Skills folders rarely change within a session. A 5-minute TTL keeps the
// recursive readdirSync + frontmatter parse off the hot path for most
// bridge/Pool C invocations. Bench harness or tests can invalidate by
// boot; long-running plugin server picks up changes on next window.
let _skillsCache = null;
let _skillsCacheTime = 0;
let _skillsCacheCwd = null;
const SKILLS_CACHE_TTL = 5 * 60_000;
export function collectSkillsCached(cwd) {
    const now = Date.now();
    if (_skillsCache && _skillsCacheCwd === cwd && now - _skillsCacheTime < SKILLS_CACHE_TTL) {
        return _skillsCache;
    }
    _skillsCache = collectSkills(cwd);
    _skillsCacheTime = now;
    _skillsCacheCwd = cwd;
    return _skillsCache;
}
/**
 * Load full skill content by name.
 */
export function loadSkillContent(name, cwd) {
    const skills = collectSkillsCached(cwd);
    const skill = skills.find(s => s.name === name);
    if (!skill)
        return null;
    return readSafe(skill.filePath);
}
/**
 * Build slim skill tool definitions (Hermes-style 3-tool split).
 * The skill catalogue is served at runtime via `skills_list` rather than
 * inlined into tool descriptions, keeping per-session schema bytes small.
 *
 * The structure is constant regardless of how many skills are in scope —
 * the 3-tool shape only shows up when `skills.length > 0`, and the slot
 * contents never change. Memoise so every createSession doesn't rebuild
 * identical objects (trivial work, but the allocation noise shows up in
 * repeated Pool C fan-out).
 */
let _skillToolDefsCache = null;
/**
 * @param {Array} skills       — discovered skill frontmatter list (may be empty)
 * @param {object} [opts]
 * @param {boolean} [opts.ownerIsBridge=false]
 *   Bridge sessions ALWAYS include the 3 meta-tools regardless of the current
 *   cwd's skill inventory — the concrete skill list is resolved at tool-call
 *   time (cwd-scoped) so the tool schema stays bit-identical across roles /
 *   cwds and the provider cache shard does not fragment.
 *   Non-bridge sessions keep the historical "empty when skills.length===0"
 *   behaviour.
 */
export function buildSkillToolDefs(skills, { ownerIsBridge = false } = {}) {
    if (!ownerIsBridge && !skills.length) return [];
    if (_skillToolDefsCache) return _skillToolDefsCache;
    _skillToolDefsCache = [
        {
            name: 'skills_list',
            description: 'List available skills with short descriptions. Call this first to discover what skills are available before using skill_view or skill_execute.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
        {
            name: 'skill_view',
            description: 'Return the full body of a skill by name (without executing it). Use this to inspect skill contents.',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Skill name' },
                },
                required: ['name'],
            },
        },
        {
            name: 'skill_execute',
            description: 'Load and execute a skill by name. The skill body is injected into the conversation context.',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Skill name' },
                    args: { type: 'object', description: 'Optional arguments passed to the skill', additionalProperties: true },
                },
                required: ['name'],
            },
        },
    ];
    return _skillToolDefsCache;
}
// --- Collect project MD (Phase B §5) ---
/**
 * Read <cwd>/PROJECT.md if present. Used to inject project-scoped guidance
 * into Tier 3 `# project-context` without polluting Tier 2 (Pool B prefix).
 */
// PROJECT.md lookup per cwd — single readFileSync but still happens on
// every createSession. Memoise for consistency with the other template
// caches; the 60s TTL means a manually edited PROJECT.md shows up on the
// next window.
const _projectMdCache = new Map();
const PROJECT_MD_TTL = 60_000;
export function collectProjectMd(cwd) {
    // When cwd is null/missing (bridge maintenance calls deliberately pass
    // cwd:null so provider-cache shards don't fork per caller workspace),
    // return empty — DO NOT fall back to process.cwd(). This path feeds
    // manager.mjs BP3 / sessionMarker, so leaking process.cwd() project
    // context into bridge maintenance sessions would fragment shards per
    // MCP launch dir.
    const projectDir = (typeof cwd === 'string' && cwd.length > 0) ? cwd : null;
    if (!projectDir) return '';
    const cached = _projectMdCache.get(projectDir);
    if (cached && Date.now() - cached.ts < PROJECT_MD_TTL) return cached.value;
    const content = readSafe(join(projectDir, 'PROJECT.md')) || '';
    _projectMdCache.set(projectDir, { ts: Date.now(), value: content });
    return content;
}

// --- Role template loading (Phase B §4 — UI-managed) ---
/**
 * Read <dataDir>/roles/<role>.md, parse frontmatter (name, description,
 * permission) and body. Returns { description, permission, body } or null.
 *
 * The role md is created/edited from the Config UI; runtime parses it on
 * each spawn and injects the result into the Tier 3 system-reminder via
 * composeSystemPrompt's `roleTemplate` slot.
 */
// Role template cache — file read + frontmatter parse on every
// createSession under the unified-shard policy becomes measurable when a
// long session fan-outs N Pool C sub-sessions. 60s TTL keeps UI edits
// visible without hammering the disk on every bridge turn.
const _roleTemplateCache = new Map();
const ROLE_TEMPLATE_TTL = 60_000;
export function loadRoleTemplate(role, dataDir) {
    if (!role || !dataDir) return null;
    const key = `${role}|${dataDir}`;
    const cached = _roleTemplateCache.get(key);
    if (cached && Date.now() - cached.ts < ROLE_TEMPLATE_TTL) return cached.value;
    const path = join(dataDir, 'roles', `${role}.md`);
    const content = readSafe(path);
    if (!content) {
        _roleTemplateCache.set(key, { ts: Date.now(), value: null });
        return null;
    }
    const fm = parseFrontmatter(content);
    const body = content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
    const description = (fm.description || '').trim();
    const permission = (fm.permission || '').trim().toLowerCase();
    const template = {
        description: description || null,
        permission: permission || null,
        body: body || null,
    };
    _roleTemplateCache.set(key, { ts: Date.now(), value: template });
    return template;
}

// --- Role-scoped agent catalog loader ---
// Emits a BP2 block scoped to the calling role:
//   - Public roles (worker/reviewer/tester/debugger/maintenance/researcher/
//     scheduler-task/webhook-handler): Agent Role Catalog only; Hidden Role
//     Catalog is dropped entirely — public roles never dispatch into hidden
//     retrieval/standalone backends.
//   - Retrieval hidden (explorer/recall-agent/search-agent): Agent Role
//     Catalog + Hidden block containing `retrieval-role-principles` (shared
//     common rules) and the self section only.
//   - Standalone hidden (cycle1-agent/cycle2-agent/proactive-decision/
//     recap-agent): Agent Role Catalog + Hidden block with self section only.
//   - Unknown/null role: falls back to the legacy all-in-one block so
//     callers that don't supply role stay backward-compatible.
//
// BP2 is no longer bit-identical cross-role — the provider cache shards by
// role group (public / each retrieval hidden / each standalone hidden),
// trading a small number of additional shards for ~68% fewer prefix bytes
// on the public-role hot path. Role identity still rides the sessionMarker
// user message separately (see composeSystemPrompt).
const PUBLIC_ROLES = new Set([
    'worker', 'reviewer', 'tester', 'debugger',
    'maintenance', 'researcher', 'scheduler-task', 'webhook-handler',
]);
const RETRIEVAL_HIDDEN_ROLES = new Set([
    'explorer', 'recall-agent', 'search-agent',
]);
const STANDALONE_HIDDEN_ROLES = new Set([
    'cycle1-agent', 'cycle2-agent', 'proactive-decision', 'recap-agent',
]);
const RETRIEVAL_PRINCIPLES_NAME = 'retrieval-role-principles';

const _scopedRoleCatalogCache = new Map();
const SCOPED_ROLE_CATALOG_TTL = 60_000;

function loadHiddenRoleSnippets(pluginRoot) {
    try {
        const bridgeDir = join(pluginRoot, 'rules', 'bridge');
        if (!existsSync(bridgeDir)) return [];
        const files = readdirSync(bridgeDir)
            .filter(f => f.endsWith('.md') && f !== '00-common.md')
            .sort();
        const pairs = [];
        for (const f of files) {
            const raw = readSafe(join(bridgeDir, f));
            if (!raw) continue;
            const body = raw.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
            if (!body) continue;
            const name = f.replace(/^\d+-/, '').replace(/\.md$/, '');
            pairs.push({ name, body });
        }
        return pairs;
    } catch {
        return [];
    }
}

function loadAgentSections(pluginRoot) {
    const agentsDir = join(pluginRoot, 'agents');
    const agentSections = [];
    if (!existsSync(agentsDir)) return agentSections;
    const files = readdirSync(agentsDir)
        .filter(f => f.endsWith('.md'))
        .sort();
    for (const f of files) {
        const raw = readSafe(join(agentsDir, f));
        if (!raw) continue;
        const body = raw.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
        if (!body) continue;
        const name = f.replace(/\.md$/, '');
        agentSections.push(`## ${name}\n\n${body}`);
    }
    return agentSections;
}

export function loadScopedRoleCatalog(role) {
    const cacheKey = role || '__all__';
    const cached = _scopedRoleCatalogCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SCOPED_ROLE_CATALOG_TTL) {
        return cached.value;
    }
    try {
        const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
        if (!pluginRoot) return '';
        const agentSections = loadAgentSections(pluginRoot);
        const hiddenPairs = loadHiddenRoleSnippets(pluginRoot);

        // Pick which hidden sections to emit based on role classification.
        let hiddenSectionsToEmit = null; // null → drop the Hidden block entirely
        if (role && RETRIEVAL_HIDDEN_ROLES.has(role)) {
            const principles = hiddenPairs.find(p => p.name === RETRIEVAL_PRINCIPLES_NAME);
            const self = hiddenPairs.find(p => p.name === role);
            hiddenSectionsToEmit = [];
            if (principles) hiddenSectionsToEmit.push(`## ${principles.name}\n\n${principles.body}`);
            if (self) hiddenSectionsToEmit.push(`## ${self.name}\n\n${self.body}`);
        } else if (role && STANDALONE_HIDDEN_ROLES.has(role)) {
            const self = hiddenPairs.find(p => p.name === role);
            hiddenSectionsToEmit = [];
            if (self) hiddenSectionsToEmit.push(`## ${self.name}\n\n${self.body}`);
        } else if (role && PUBLIC_ROLES.has(role)) {
            hiddenSectionsToEmit = null;
        } else {
            // Unknown / null role — legacy all-in-one fallback for
            // backward-compat (e.g. callers that don't yet thread role).
            hiddenSectionsToEmit = hiddenPairs.map(p => `## ${p.name}\n\n${p.body}`);
        }

        const blocks = [];
        if (agentSections.length) {
            blocks.push(`# Agent Role Catalog\n\n${agentSections.join('\n\n---\n\n')}`);
        }
        if (hiddenSectionsToEmit && hiddenSectionsToEmit.length) {
            blocks.push(`# Hidden Role Catalog\n\n${hiddenSectionsToEmit.join('\n\n---\n\n')}`);
        }
        const value = blocks.join('\n\n---\n\n');
        _scopedRoleCatalogCache.set(cacheKey, { ts: Date.now(), value });
        return value;
    } catch {
        return '';
    }
}

// Backward-compat wrapper for any external caller that still imports the
// old symbol. Returns the unknown-role fallback (full catalog).
export function loadAllAgentBodies() {
    return loadScopedRoleCatalog(null);
}

// --- Compose system prompt — 4-BP cache layout ---
// Returns { baseRules, roleCatalog, sessionMarker, volatileTail } mapping
// directly to the breakpoint plan:
//   BP1 (1h, system block #1) = baseRules      — bridge common rules, filtered
//   BP2 (1h, system block #2) = roleCatalog    — ALL role bodies + static tool-routing (cross-role identical)
//   BP3 (1h, first <system-reminder> user)     = sessionMarker (project-context only)
//   BP4 (5m, messages tail)                    = volatileTail (role + permission + task-brief + memory recap)
//
// Design note — why role/permission sit in BP4, not BP3:
//   BP3 is meant to be stable within a session and consistent across roles
//   reused on the same project. Keeping it as pure project context means a
//   cross-role burst within the same project shares BP1+BP2+BP3 entirely,
//   and only BP4 (per-call) picks up the role / permission / task variance.
//   Tool-routing hints are static cross-role, so they live in the shared
//   BP1 tool guidance (rules/shared/01-tool.md) rather than being regenerated
//   per call.
//
// Tier 2 (BP_2 cache): plugin-lifetime invariant content only.
//   - opts.bridgeRules    : rules-builder buildBridgeInjectionContent output
//                           (Pool B roles share bit-identical prefix)
//   - opts.userPrompt     : explicit systemPrompt override from callsite
//
// Tier 3 (messages, no cache_control): role / session / project variance.
//   - opts.role           : worker / reviewer / tester / debugger / researcher / ...
//   - opts.agentTemplate  : agents/<role>.md body when authored
//   - opts.taskBrief      : Lead-issued task description (Sub only)
//   - opts.hasSkills      : true → skills_list hint
//   - opts.projectContext : cwd's PROJECT.md content (Phase B §5)
//   - opts.memoryContext  : recap / history context
//
// `profile.skip` still filters specific buckets (claudemd, skills, memory)
// for backward compatibility with existing profiles.
export function composeSystemPrompt(opts) {
    const profile = opts.profile || null;
    const skip = profile?.skip || {};

    // ── BP1: baseRules (system block #1, 1h cache) ─────────────────────
    // Bridge common rules + explicit systemPrompt override. Contains
    // bridgeRules (MCP instructions, Pool B shared rules, _shared/tool
    // efficiency). Identical across ALL roles — BP1 shared pool-wide.
    const baseParts = [];
    if (opts.bridgeRules) baseParts.push(opts.bridgeRules);
    if (opts.userPrompt) baseParts.push(opts.userPrompt);
    const baseRules = baseParts.join('\n\n---\n\n');

    // ── BP2: roleCatalog (system block #2, 1h cache) ────────────────────
    // Every agents/*.md body + rules/bridge/*.md snippet (including static
    // tool-routing guidance) concatenated. Bit-identical cross-role so the
    // provider-side cache shard is one shared entry workspace-wide.
    const roleCatalog = loadAllAgentBodies();

    // ── BP3: sessionMarker (first <system-reminder> user msg, 1h cache) ─
    // Project context only. role/permission moved to volatileTail because
    // they vary per-call even within a session (different dispatch shapes),
    // so keeping them in BP3 would churn the 1h shard. Project context is
    // the only truly session-stable Tier 3 content.
    const sessionMarker = opts.projectContext
        ? '# project-context\n' + opts.projectContext
        : '';

    // ── BP4-adjacent: volatileTail (second user <system-reminder>, 5m) ──
    // Per-call variance: role identity, permission envelope, task brief,
    // memory recap. Lives at the messages-tail boundary so the BP4 5m
    // breakpoint picks it up without fragmenting the 1h shared prefix.
    const volatileParts = [];
    if (opts.role && !opts.skipRoleReminder) {
        volatileParts.push('# role\n' + opts.role);
    }
    const permission = opts.permission || opts.roleTemplate?.permission || null;
    if (permission) {
        const allow =
            permission === 'read'
                ? 'read-only; write/edit/bash rejected'
                : permission === 'read-write'
                    ? 'read + write/edit/bash'
                    : permission === 'mcp'
                        ? 'MCP/internal retrieval tools only; file/shell/edit tools rejected'
                    : permission === 'full'
                        ? 'full — all tools'
                        : 'unknown — treat as read-only';
        volatileParts.push(`# permission\n${permission} — ${allow}.`);
    }
    if (opts.taskBrief) volatileParts.push('# task-brief\n' + opts.taskBrief);
    if (opts.memoryContext && !skip.memory) {
        volatileParts.push('# memory-context\n' + opts.memoryContext);
    }
    const volatileTail = volatileParts.length > 0
        ? volatileParts.join('\n\n')
        : '';

    return { baseRules, roleCatalog, sessionMarker, volatileTail };
}
// --- Helpers ---
function readSafe(path) {
    try {
        if (!existsSync(path))
            return null;
        const content = readFileSync(path, 'utf-8').trim();
        return content || null;
    }
    catch {
        return null;
    }
}
function parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match)
        return {};
    const fm = match[1];
    const name = fm.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
    const description = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
    const permission = fm.match(/^permission:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
    return { name, description, permission };
}
function walkForAgent(dir, agentName, result) {
    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === 'node_modules')
                continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'agents') {
                    result.push(join(full, `${agentName}.md`));
                }
                else {
                    walkForAgent(full, agentName, result);
                }
            }
        }
    }
    catch { /* ignore */ }
}
function walkForSkills(dir, result) {
    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === 'node_modules')
                continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'skills') {
                    result.push(full);
                }
                else {
                    walkForSkills(full, result);
                }
            }
        }
    }
    catch { /* ignore */ }
}
