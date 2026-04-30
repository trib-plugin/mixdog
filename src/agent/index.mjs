import { initProviders, warmupCatalogs } from './orchestrator/providers/registry.mjs';
import { createSession, askSession, listSessions, closeSession, findSessionByScopeKey, updateSessionStatus, getSessionRuntime, SessionClosedError, setSmartBridge, forEachSessionRuntime } from './orchestrator/session/manager.mjs';
import { ToolLoopAbortError } from './orchestrator/tool-loop-guard.mjs';
import { StreamStalledAbortError, startWatchdog as startStreamWatchdog } from './orchestrator/session/stream-watchdog.mjs';
import { startBridgeStallWatchdog } from './bridge-stall-watchdog.mjs';
import { attachBridgeAbort } from './bridge-abort.mjs';
import { loadConfig, getPluginData, listPresets, getDefaultPreset, setDefaultPreset, resolveRuntimeSpec } from './orchestrator/config.mjs';
import { connectMcpServers, disconnectAll } from './orchestrator/mcp/client.mjs';
import { setInternalToolsProvider } from './orchestrator/internal-tools.mjs';
import { listWorkflows, getWorkflow, seedDefaults } from './orchestrator/workflow-store.mjs';
import { initTrajectoryStore, recordTrajectory } from './orchestrator/trajectory.mjs';
import { prepareBridgeSession } from './orchestrator/smart-bridge/session-builder.mjs';
import { normalizeInputPath } from './orchestrator/tools/builtin.mjs';
import { traceBridgePreset } from './orchestrator/bridge-trace.mjs';
import { ensureDataSeeds } from '../shared/seed.mjs';
import { startAgentMaintenance, stopAgentMaintenance } from './orchestrator/agent-maintenance.mjs';
import { writeFileSync, readFileSync, existsSync, watch } from 'fs';
import { join } from 'path';

// --- user-workflow.json loader ---
// The plugin already persists user role -> preset mapping in
//   <plugin-data>/user-workflow.json
// Smart Bridge consumes this directly instead of introducing a duplicate
// config key. fs.watch keeps Smart Bridge in sync when the user edits roles.

/**
 * @typedef {Object} RoleConfig
 * @property {string}      name        - unique role identifier
 * @property {string}      preset      - preset name from agent-config presets
 * @property {'read'|'read-write'|'mcp'|'full'} permission - tool permission category
 * @property {string|null} desc_path   - relative to CLAUDE_PLUGIN_ROOT
 */

const VALID_PERMISSIONS = new Set(['read', 'read-write', 'mcp', 'full']);

function applyRoleDefaults(raw) {
  const permission = VALID_PERMISSIONS.has(raw.permission) ? raw.permission : 'full';
  const desc_path = typeof raw.desc_path === 'string' ? raw.desc_path : null;

  return {
    name: raw.name,
    preset: raw.preset,
    permission,
    desc_path,
  };
}

function validateRoleConfig(role) {
  if (!role.name || typeof role.name !== 'string')
    throw new Error(`[user-workflow] role entry missing "name"`);
  if (!role.preset || typeof role.preset !== 'string')
    throw new Error(`[user-workflow] role "${role.name}" missing "preset"`);
  if (!VALID_PERMISSIONS.has(role.permission))
    throw new Error(`[user-workflow] role "${role.name}": invalid permission "${role.permission}" (expected: ${[...VALID_PERMISSIONS].join(", ")})`);
}

/** @type {Map<string, RoleConfig>} */
let _roleConfigCache = new Map();

function loadResolvedRoles() {
  const path = join(getPluginData(), 'user-workflow.json');
  const map = new Map();
  if (!existsSync(path)) return map;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (Array.isArray(data?.roles)) {
      for (const raw of data.roles) {
        if (!raw?.name || !raw?.preset) continue;
        const resolved = applyRoleDefaults(raw);
        validateRoleConfig(resolved);
        map.set(resolved.name, resolved);
      }
    }
  } catch (e) {
    process.stderr.write(`[user-workflow] load error: ${e.message}\n`);
  }
  return map;
}

function loadUserWorkflowRoles() {
  _roleConfigCache = loadResolvedRoles();
  const out = {};
  for (const [name, cfg] of _roleConfigCache) out[name] = cfg.preset;
  return out;
}

/**
 * Get the fully-resolved RoleConfig for a given role name.
 * @param {string} roleName
 * @returns {RoleConfig|null}
 */
export function getRoleConfig(roleName) {
  return _roleConfigCache.get(roleName) ?? null;
}

let _userWorkflowWatcher = null;
function watchUserWorkflow(onChange) {
  if (_userWorkflowWatcher) return;
  const dir = getPluginData();
  try {
    _userWorkflowWatcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (filename === 'user-workflow.json') {
        try { onChange(loadUserWorkflowRoles()); } catch {}
      }
    });
  } catch {
    // fs.watch can fail on some platforms — best effort only.
  }
}

function buildInstructions() {
  const lines = [];

  try {
    const workflows = listWorkflows();
    lines.push('');
    if (workflows.length > 0) {
      lines.push('Available workflows:');
      for (const w of workflows) {
        lines.push(`- ${w.name}: ${w.description}`);
      }
    } else {
      lines.push('No custom workflows configured.');
    }
  } catch {
    lines.push('');
    lines.push('No custom workflows configured.');
  }

  return lines.join('\n');
}

// Seed default workflows into user data dir if none exist yet.
seedDefaults();

// Seed plugin-owned scaffolding files (memory-config.json, etc.) so
// first-time installs land with the Pool B surface populated and the Config
// UI has real paths to edit.
ensureDataSeeds(getPluginData());

const INSTRUCTIONS = buildInstructions();

// --- Prompt store (file-backed, shared with bin/bridge CLI) ---
const _promptStorePath = join(getPluginData(), 'prompt-store.json');
let _promptSeq = 0;

function _psLoad() {
  try {
    return JSON.parse(readFileSync(_promptStorePath, 'utf-8'));
  } catch {
    return {};
  }
}

function _psSave(store) {
  writeFileSync(_promptStorePath, JSON.stringify(store) + '\n', 'utf-8');
}

const _promptStore = {
  get(key) {
    return _psLoad()[key] ?? null;
  },
  set(key, val) {
    const store = _psLoad();
    store[key] = val;
    _psSave(store);
  },
  delete(key) {
    const store = _psLoad();
    delete store[key];
    _psSave(store);
  },
  has(key) {
    return key in _psLoad();
  },
};

// --- Helpers ---

function ok(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function fail(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

// Format token counts in Claude Code style: <1000 as-is, >=1000 as "9.9k".
function fmtTokens(n) {
  if (typeof n !== 'number') return String(n ?? '?');
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

// --- Tool definitions ---

// Public entries (advertised in tools.json) come first, then `public:
// false` entries (reachable through handleToolCall / in-process dispatch
// only — excluded from build-tools-manifest output so the Lead never
// sees them).
const TOOLS = [
  {
    name: 'create_session',
    title: 'Create Session',
    annotations: { title: 'Create Session', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: 'Create external AI session with tool access. preset: full/readonly/mcp. agent: Worker/Reviewer.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'openai, anthropic, gemini, groq, openrouter, xai, copilot, ollama, lmstudio, local' },
        model: { type: 'string', description: 'Provider-specific model id (e.g. "gpt-5", "claude-opus-4", "gemini-2.5-pro"). Must be valid for the chosen provider.' },
        systemPrompt: { type: 'string', description: 'Optional system prompt prepended to the session. When omitted, the plugin injects the default Pool B/C prefix based on role/preset.' },
        agent: { type: 'string', description: 'Agent template: Worker, Reviewer' },
        preset: { type: 'string', enum: ['full', 'readonly', 'mcp'], description: 'Tool permission preset: `full` grants read+write+shell, `readonly` restricts to read-only tools, `mcp` exposes only MCP-bridged tools.' },
        files: { type: 'array', description: 'Optional virtual files seeded into the session\'s working context (path+content pairs). The agent can read these immediately without fs access.', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
        cwd: { type: 'string', description: 'Working directory for tool execution' },
      },
      required: ['provider', 'model'],
    },
  },
  {
    name: 'list_sessions',
    title: 'List Sessions',
    annotations: { title: 'List Sessions', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'List active orchestrator sessions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'close_session',
    title: 'Close Session',
    annotations: { title: 'Close Session', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Close an orchestrator session.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'Session id to close (from create_session / list_sessions). Plants a tombstone, aborts in-flight work; re-closing is a no-op.' } },
      required: ['sessionId'],
    },
  },
  {
    name: 'list_models',
    title: 'List Models',
    annotations: { title: 'List Models', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'List available models from all providers.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_workflows',
    public: false,
    description: 'List workflow plans (name + description).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_workflow',
    public: false,
    description: 'Get a workflow plan by name. Returns full JSON with steps.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name (e.g., "code-review")' },
      },
      required: ['name'],
    },
  },
  {
    name: 'set_prompt',
    title: 'Store Prompt',
    public: false,
    description: 'Store a long prompt and return a reference key for bridge.ref.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The prompt content to store' },
        file: { type: 'string', description: 'Read content from this file path instead of content param' },
        key: { type: 'string', description: 'Optional custom key. Auto-generated if omitted.' },
      },
    },
  },
  {
    name: 'skill_suggest',
    public: false,
    description: 'Analyze trajectory data and suggest skills from repeating patterns.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bridge_spawn',
    title: 'Spawn Bridge Agent',
    public: false,
    description: 'Create a Smart Bridge agent session with a role/taskType. Replacement for native Agent/TeamCreate. wait=true returns first response sync; wait=false returns sessionId for later bridge_send. Prefer `explore` for filesystem lookup; use bridge_spawn only for standalone role sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Role name (mapped to profile via user-workflow.json).' },
        taskType: { type: 'string', description: 'Explicit task type override (maintenance, one-shot, etc).' },
        profileId: { type: 'string', description: 'Explicit profile id (overrides role/taskType).' },
        prompt: { type: 'string', description: 'Initial prompt for the agent. Required when wait=true.' },
        wait: { type: 'boolean', description: 'true: send prompt and return response sync. false: return sessionId for later. Default true if prompt given.' },
        provider: { type: 'string', description: 'Override provider (defaults to profile.preferredProviders[0]).' },
        model: { type: 'string', description: 'Override model.' },
        cwd: { type: 'string', description: 'Working directory for agent tool execution.' },
      },
    },
  },
  {
    name: 'bridge_send',
    title: 'Send to Bridge Agent',
    public: false,
    description: 'Send a message to an existing bridge agent session. Returns response synchronously.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id returned by bridge_spawn or create_session.' },
        message: { type: 'string', description: 'Message content to send.' },
      },
      required: ['sessionId', 'message'],
    },
  },
  {
    name: 'bridge',
    title: 'Bridge to External Model',
    annotations: { title: 'Bridge to External Model', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: 'Delegate one turn to an external agent by role (mapped via user-workflow.json). Detached: returns jobId + sessionId; agent runs in background. Pass exactly one of prompt / ref / file. Use close_session to stop early. Bench escape hatch: pass provider+model directly (with optional effort/fast/tools/systemPrompt) to bypass agent-config.json — role still drives BP2 catalog scoping.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task instruction for the agent.' },
        role: { type: 'string', description: 'Agent role from user-workflow.json (or any string for ad-hoc bench dispatch).' },
        preset: { type: 'string', description: 'Advanced: explicit preset name (bypass role mapping).' },
        provider: { type: 'string', description: 'Bench: provider id (e.g. anthropic-oauth, openai-oauth, gemini, deepseek, xai). Used together with model for ad-hoc dispatch — skips agent-config.json lookup.' },
        model: { type: 'string', description: 'Bench: model id matching the provider (e.g. claude-opus-4-7, gpt-5.5, gemini-3-flash-preview). Required when provider is set.' },
        effort: { type: 'string', description: 'Bench: reasoning effort (low / medium / high / xhigh). Used when provider+model are set.' },
        fast: { type: 'boolean', description: 'Bench: priority service tier flag (provider-specific). Used when provider+model are set.' },
        tools: { type: 'string', description: 'Bench: tool surface (full / readonly). Used when provider+model are set; default full.' },
        systemPrompt: { type: 'string', description: 'Bench: extra system text injected at the head of the prompt for ad-hoc dispatch.' },
        context: { type: 'string', description: 'Extra context appended to the prompt.' },
        ref: { type: 'string', description: 'Prompt store key (populated by prompt_store).' },
        file: { type: 'string', description: 'Read prompt from a file path.' },
        cwd: { type: 'string', description: 'Working directory for bridge agent tool execution.' },
      },
      required: ['prompt', 'role'],
    },
  },
];

// ── Module exports (for unified server) ──────────────────────────────

export { TOOLS as TOOL_DEFS };
export { INSTRUCTIONS as instructions };

export async function init() {
  const config = loadConfig();
  // External MCP servers only. Self-MCP loopback (mcpServers.mixdog /
  // mcpServers["trib-plugin"])
  // is rejected — agent exposes the plugin's own tools (search,
  // search_memories, ...) in-process via the context injected by server.mjs;
  // no network round-trip, no self-spawn. search/search_memories are
  // guaranteed by the static tools.json manifest, so the prior FATAL check
  // is obsolete.
  const rawServers = (config.mcpServers && typeof config.mcpServers === 'object') ? config.mcpServers : {};
  const externalServers = {};
  for (const [name, cfg] of Object.entries(rawServers)) {
    if (name === 'mixdog' || name === 'trib-plugin') {
      process.stderr.write(`[mcp] dropping legacy self-ref mcpServers.mixdog / mcpServers["trib-plugin"] entry (in-process tool bridge is used instead)\n`);
      continue;
    }
    externalServers[name] = cfg;
  }
  // Run independent init steps in parallel: provider registry + external
  // MCP server connections. Both are network-bound and have no shared
  // dependency, so serialising them was wasted boot latency.
  await Promise.all([
    initProviders(config.providers),
    Object.keys(externalServers).length > 0 ? connectMcpServers(externalServers) : Promise.resolve(),
  ]);
  // Trigger model-catalog refresh in the background so the first bridge LLM
  // call (cycle1 on session start) does not have to wait for catalog fetch
  // serialised in front of it.
  setImmediate(() => warmupCatalogs());
  seedDefaults();
  initTrajectoryStore(getPluginData());
  startAgentMaintenance();
  startStreamWatchdog(forEachSessionRuntime);
  // Smart Bridge — unified router + cache strategy + profile system.
  // User-role preset mapping comes from user-workflow.json (existing source
  // of truth). Preset catalog (provider/model/effort) comes from config.presets.
  try {
    const { initSmartBridge, getSmartBridge, setRoleResolver } = await import('./orchestrator/smart-bridge/index.mjs');
    const userRoles = loadUserWorkflowRoles();
    const presets = config.presets || [];
    // Inject the role resolver so SmartBridge.resolveSync() can read role
    // configs without lazy-importing this module (avoids the circular
    // require that the old router.mjs had).
    setRoleResolver(getRoleConfig);
    const sb = initSmartBridge({ userRoles, presets });
    // Inject into session manager so createSession() can resolve profiles
    // synchronously (no lazy-import race).
    setSmartBridge(sb);
    // Keep Smart Bridge in sync with user-workflow.json edits.
    watchUserWorkflow((nextRoles) => {
      try { getSmartBridge().updateUserRoles(nextRoles); } catch {}
    });
  } catch (e) {
    process.stderr.write(`[smart-bridge] init skipped: ${e.message}\n`);
  }
}

/**
 * Handle a tool call from the unified server.
 * @param {string} name - tool name
 * @param {object} args - tool arguments
 * @param {{ notifyFn?: (text: string) => void, elicitFn?: (opts: object) => Promise<object> }} [opts]
 */
export async function handleToolCall(name, args, opts = {}) {
  const notifyFn = typeof opts.notifyFn === 'function' ? opts.notifyFn : null;
  const elicit = typeof opts.elicitFn === 'function' ? opts.elicitFn : null;
  const requestSignal = opts.requestSignal instanceof AbortSignal ? opts.requestSignal : null;
  const callerSessionId = typeof opts.callerSessionId === 'string' && opts.callerSessionId ? opts.callerSessionId : null;
  const callerCwd = typeof opts.callerCwd === 'string' && opts.callerCwd ? opts.callerCwd : null;
  // Idempotent fallback — server.mjs populates the registry at boot via
  // loadModule('agent').then(...), but if eager init failed (missing deps,
  // file error), the first tool call still restores it here. Re-registration
  // is safe: setInternalToolsProvider replaces the executor/tools refs.
  if (typeof opts.toolExecutor === 'function' && Array.isArray(opts.internalTools)) {
    setInternalToolsProvider({
      executor: opts.toolExecutor,
      tools: opts.internalTools,
    });
  }

  try {
    switch (name) {
      case 'create_session': {
        const sessionArgs = args.cwd
          ? { ...args, cwd: normalizeInputPath(args.cwd) }
          : args;
        const session = createSession(sessionArgs);
        return ok({
          sessionId: session.id,
          provider: session.provider,
          model: session.model,
          contextWindow: session.contextWindow,
          toolsAvailable: session.tools.length,
          toolNames: session.tools.map((t) => t.name),
        });
      }

      case 'bridge_spawn': {
        // Smart Bridge agent spawn — replacement for native Agent tool flow.
        // Resolves profile → creates session → optionally sends initial prompt.
        const smartArgs = {
          role: args.role,
          taskType: args.taskType,
          profileId: args.profileId,
          cwd: args.cwd ? normalizeInputPath(args.cwd) : (callerCwd || null),
          owner: 'bridge',
          lane: 'bridge',
          systemPrompt: args.systemPrompt,
        };
        if (args.provider) smartArgs.provider = args.provider;
        if (args.model) smartArgs.model = args.model;
        // Need either role/taskType/profileId OR explicit provider+model.
        if (!smartArgs.role && !smartArgs.taskType && !smartArgs.profileId
            && !(smartArgs.provider && smartArgs.model)) {
          return fail('bridge_spawn: role, taskType, profileId, or provider+model required');
        }
        // Let Smart Bridge derive provider/model from profile.fallbackPreset →
        // config.presets catalog. No hardcoded preset-to-model mapping here.
        if ((!smartArgs.provider || !smartArgs.model)
            && (smartArgs.role || smartArgs.taskType || smartArgs.profileId)) {
          try {
            const { getSmartBridge } = await import('./orchestrator/smart-bridge/index.mjs');
            const resolved = getSmartBridge().resolveSync({
              role: smartArgs.role,
              taskType: smartArgs.taskType,
              profileId: smartArgs.profileId,
            });
            if (resolved) {
              smartArgs.provider = smartArgs.provider || resolved.provider;
              smartArgs.model = smartArgs.model || resolved.model;
            }
          } catch { /* fall through — createSession will throw if incomplete */ }
        }
        const session = createSession(smartArgs);
        try {
          traceBridgePreset({
            sessionId: session.id,
            role: smartArgs.role || smartArgs.taskType || smartArgs.profileId || null,
            presetName: session.preset?.id || session.preset?.name || session.profileId || null,
            model: session.model || smartArgs.model || null,
            provider: session.provider || smartArgs.provider || null,
            parentSessionId: callerSessionId,
          });
        } catch { /* telemetry best-effort */ }
        const shouldWait = args.wait === false ? false : !!args.prompt;
        if (shouldWait) {
          try {
            const result = await askSession(session.id, args.prompt);
            return ok({
              sessionId: session.id,
              profileId: session.profileId,
              provider: session.provider,
              model: session.model,
              response: result.content,
              usage: result.usage,
            });
          } catch (err) {
            return fail(`bridge_spawn ask failed: ${err.message}`);
          }
        }
        return ok({
          sessionId: session.id,
          profileId: session.profileId,
          provider: session.provider,
          model: session.model,
          hint: 'Use bridge_send(sessionId, message) to converse with this agent.',
        });
      }

      case 'bridge_send': {
        const sessionId = args.sessionId;
        const message = args.message;
        if (!sessionId || !message) return fail('bridge_send: sessionId and message are required');
        try {
          const result = await askSession(sessionId, message);
          return ok({
            sessionId,
            response: result.content,
            usage: result.usage,
          });
        } catch (err) {
          if (err instanceof SessionClosedError) {
            return fail(`Session ${sessionId} is closed`);
          }
          return fail(`bridge_send failed: ${err.message}`);
        }
      }

      case 'list_sessions': {
        const sessions = listSessions();
        if (sessions.length === 0) return ok('No active sessions.');
        const now = Date.now();
        const brief = args.brief === true;
        return ok(sessions.map((s) => {
          const runtime = getSessionRuntime(s.id);
          // No runtime entry → session has no in-flight work; stage derives from
          // persisted status ('running' is only set by long-running callers; idle
          // otherwise). Single derivation, no legacy fallback path.
          const persistedStatus = s.status || 'idle';
          // Phase J: tombstones override status/stage. The persisted `status`
          // field may still be 'running' because close_session aborts rather
          // than touches it; `closed: true` is the authoritative signal.
          const isClosed = s.closed === true;
          const status = isClosed ? 'closed' : persistedStatus;
          const stage = isClosed
            ? 'closed'
            : (runtime?.stage || (persistedStatus === 'running' ? 'connecting' : 'idle'));
          const lastStreamDeltaAt = runtime?.lastStreamDeltaAt
            ? new Date(runtime.lastStreamDeltaAt).toISOString()
            : null;
          const staleSeconds = runtime?.lastStreamDeltaAt
            ? Math.floor((now - runtime.lastStreamDeltaAt) / 1000)
            : null;
          const base = {
            id: s.id,
            provider: s.provider,
            model: s.model,
            messages: s.messages.length,
            tools: s.tools.length,
            sentTokens: s.totalInputTokens,
            receivedTokens: s.totalOutputTokens,
            scope: s.scopeKey || null,
            status,
            lastStatus: persistedStatus,
            createdAt: new Date(s.createdAt).toISOString(),
            updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
            stage,
            lastStreamDeltaAt,
            staleSeconds,
            lastToolCall: runtime?.lastToolCall || null,
          };
          if (!brief) {
            base.toolNames = Array.isArray(s.tools) ? s.tools.map((t) => t?.name).filter(Boolean) : [];
          }
          return base;
        }));
      }

      case 'close_session': {
        // Fire-and-forget: plant tombstone, abort in-flight controller, defer
        // cleanup. We don't wait for the abort to unwind — callers get an
        // immediate ack and unknown IDs return the same shape for simplicity
        // (Q1: unified {ok: true}).
        closeSession(args.sessionId, 'manual');
        return ok({ ok: true, sessionId: args.sessionId });
      }

      case 'list_models': {
        const cfg = loadConfig();
        const presets = listPresets(cfg);
        const current = getDefaultPreset(cfg);
        if (presets.length === 0) return ok('No presets configured.');
        const currentLabel = current ? `${current.model}${current.effort ? ' · ' + current.effort : ''}${current.fast ? ' · fast' : ''}` : 'none';
        const choices = presets.map((p, i) => {
          const parts = [p.model];
          if (p.effort) parts.push(p.effort);
          if (p.fast) parts.push('fast');
          return { const: String(i), title: parts.join(' · ') };
        });
        const currentIdx = current ? presets.findIndex((p) => p.name === current.name) : 0;
        if (elicit) {
          try {
            const result = await elicit({
              message: `Current: ${currentLabel}\nSelect a model preset:`,
              requestedSchema: {
                type: 'object',
                properties: {
                  preset: { type: 'string', title: 'Model Preset', oneOf: choices, default: String(currentIdx >= 0 ? currentIdx : 0) },
                },
                required: ['preset'],
              },
            });
            if (result.action === 'accept') {
              const idx = parseInt(result.content.preset, 10);
              if (!isNaN(idx) && idx >= 0 && idx < presets.length) {
                const selected = presets[idx];
                if (selected) {
                  setDefaultPreset(cfg, selected.name);
                  return ok(`Default preset changed to: ${selected.model}${selected.effort ? ' · ' + selected.effort : ''}${selected.fast ? ' · fast' : ''}`);
                }
              }
            }
            return ok('');
          } catch {
            // Fall through to plain listing.
          }
        }
        const lines = presets.map((p, i) => {
          const parts = [p.name, p.model];
          if (p.effort) parts.push(p.effort);
          if (p.fast) parts.push('fast');
          const mark = current && p.name === current.name ? '  ← active' : '';
          return `[${i}] ${parts.join(' · ')}${mark}`;
        });
        return ok({ current: currentLabel, presets: lines });
      }

      case 'get_workflows': {
        const workflows = listWorkflows();
        return ok({ workflows });
      }

      case 'get_workflow': {
        if (!args.name) return fail('name is required');
        const workflow = getWorkflow(args.name);
        if (!workflow) return fail('workflow not found');
        return ok(workflow);
      }

      case 'set_prompt': {
        let content = args.content;
        if (!content && args.file) {
          try {
            content = readFileSync(args.file, 'utf-8');
          } catch (e) {
            return fail(`Cannot read file: ${e.message}`);
          }
        }
        if (!content) return fail('content or file is required');
        const key = args.key || `p${++_promptSeq}`;
        _promptStore.set(key, content);
        return ok(`Stored as '${key}' (${content.length} chars)`);
      }

      case 'skill_suggest': {
        let db = null;
        try {
          const { getTrajectoryDb } = await import('./orchestrator/trajectory.mjs');
          db = getTrajectoryDb();
        } catch { /* trajectory module not available yet */ }
        const { getSkillSuggestionReport } = await import('./orchestrator/skill-suggest.mjs');
        const report = db ? getSkillSuggestionReport(db) : 'Trajectory store not initialized.';
        return ok(report);
      }

      case 'bridge': {
        let prompt = args.prompt;
        if (!prompt && args.file) {
          try {
            prompt = readFileSync(args.file, 'utf-8');
          } catch (e) {
            return fail(`Cannot read file: ${e.message}`);
          }
        }
        if (!prompt && args.ref) {
          prompt = _promptStore.get(args.ref);
          if (!prompt) return fail(`ref "${args.ref}" not found in prompt store`);
          _promptStore.delete(args.ref);
        }
        if (!prompt) return fail('prompt, file, or ref is required');
        if (!args.role) return fail('role is required');

        // Bench escape hatch — when both provider and model are supplied,
        // build an ad-hoc preset on the fly and bypass agent-config.json.
        // Role still drives BP2 catalog scoping (unknown role names fall back
        // to the legacy all-in-one catalog inside loadScopedRoleCatalog).
        // systemPrompt is appended as a prefix to prompt so the same dispatch
        // path can carry caller-injected guidance without changing the
        // session-builder schema.
        const config = loadConfig();
        let preset;
        let presetName;
        if (args.provider && args.model) {
          preset = {
            id: '__bench__',
            name: '__BENCH__',
            type: 'bridge',
            provider: String(args.provider),
            model: String(args.model),
            effort: args.effort ? String(args.effort) : undefined,
            fast: args.fast === true,
            tools: args.tools ? String(args.tools) : 'full',
          };
          presetName = preset.name;
          if (args.systemPrompt) {
            prompt = String(args.systemPrompt) + '\n\n' + prompt;
          }
        } else {
          // Load role→preset mapping from user-workflow.json. Role primitives only —
          // no suffix variants, exact match required.
          const wfPath = join(getPluginData(), 'user-workflow.json');
          let rolePresets = {};
          try { const wf = JSON.parse(readFileSync(wfPath, 'utf-8')); if (Array.isArray(wf.roles)) for (const r of wf.roles) rolePresets[r.name] = r.preset; } catch {}
          presetName = args.preset || rolePresets[args.role];
          if (!presetName) return fail(`role "${args.role}" not found in user-workflow.json (and no preset override given)`);

          preset = config.presets?.find((x) => x.id === presetName || x.name === presetName);
          if (!preset) return fail(`preset "${presetName}" (mapped from role "${args.role}") not found in agent-config.json`);
        }

        const role = args.role;
        const effectiveLane = 'bridge';
        const runtimeSpec = resolveRuntimeSpec(preset, {
          lane: effectiveLane,
          agentId: role,
        });

        // Stateless ephemeral session — created fresh per call (v0.6.97+).
        // No pool, no resume, no reset. Provider-level prefix cache still
        // hits because cache is content-keyed, not session-keyed. Shared
        // with the Smart Bridge path via session-builder so role/preset
        // telemetry stays bit-identical in bridge-trace.jsonl.
        const { session, effectiveCwd } = prepareBridgeSession({
          role,
          presetName,
          preset,
          runtimeSpec,
          cwd: args.cwd ? normalizeInputPath(args.cwd) : (callerCwd || null),
          sourceType: 'lead',
          sourceName: role,
          parentSessionId: callerSessionId,
          cacheKeyOverride: args.cacheKey || undefined,
        });

        const workerCwd = effectiveCwd;

        const jobId = `bridge_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const modelLabel = preset.model || preset.name;
        const emit = notifyFn || (() => {});
        // Public `bridge` is intentionally detached: we return immediately and
        // keep the session alive until it completes (or is explicitly closed).
        // Tying requestSignal to session lifetime caused long reviewer runs to
        // flip to `role cancelled` when the MCP request lifecycle ended before
        // the detached worker finished. Detached mode therefore does NOT wire
        // request abort into closeSession(); operators can still stop the work
        // explicitly through close_session(sessionId).
        const bridgeDetached = true;
        if (bridgeDetached && requestSignal) {
          const onRequestAbortIgnored = () => {
            try {
              process.stderr.write(
                `[bridge] request aborted after detach; session continues: session=${session.id} role=${role} job=${jobId}\n`,
              );
            } catch { /* best-effort */ }
          };
          if (requestSignal.aborted) {
            queueMicrotask(onRequestAbortIgnored);
          } else {
            try { requestSignal.addEventListener('abort', onRequestAbortIgnored, { once: true }); } catch { /* ignore */ }
          }
        }
        // Short model tag for bridge worker lifecycle notifications.
        // Strip the redundant `claude-` vendor prefix; other providers
        // (gpt-*, etc.) pass through unchanged. Falls back to empty on
        // missing model so callers never throw.
        const modelTag = (() => {
          try {
            const raw = preset.model;
            if (!raw || typeof raw !== 'string') return '';
            const stripped = raw.startsWith('claude-') ? raw.slice('claude-'.length) : raw;
            return stripped ? `[${stripped}] ` : '';
          } catch { return ''; }
        })();

        // ── Request-lifecycle cancellation (v0.6.242) ─────────────────
        // When the MCP client cancels this CallTool — typically via a user
        // reject/interrupt in Claude Code — `requestSignal` aborts. The
        // async IIFE below has no tie to the MCP request otherwise, so
        // without this hook askSession keeps running against the provider
        // after the user bails out (the "zombie session" symptom).
        //
        // closeSession() tombstones on disk, flips runtime.closed, and
        // aborts the in-flight controller — providers unwind, the finally
        // block runs trajectory-record + notifyFn, and listSessions() no
        // longer returns the id (tombstoned rows are filtered).
        //
        // See src/agent/bridge-abort.mjs for the extracted, unit-testable
        // attach helper.
        const abortHandle = attachBridgeAbort({
          signal: bridgeDetached ? null : requestSignal,
          sessionId: session.id,
          role,
          jobId,
          modelTag,
          closeSession: (id) => {
            closeSession(id, 'request-abort');
          },
          emit,
        });

        (async () => {
          const t0 = Date.now();
          let completed = true;
          let errorMessage = null;
          let result = null;
          const toolCallLog = [];
          let lastIteration = 0;
          let stallWatch = { stop() {}, fired() { return false; } };
          try {
            updateSessionStatus(session.id, 'running');
            // Bridge Start — silent_to_agent so the "started" lifecycle ping
            // surfaces on Discord / user terminal but does NOT land in the Lead
            // agent's context (redundant since Lead already knows it just
            // dispatched). Done / Error emissions below stay non-silent so the
            // Lead receives the result / failure.
            emit(`${modelTag}${role} started`, { silent_to_agent: true });
            // Per-session stall watchdog — complements the orchestrator's
            // stream-watchdog (which fires at 300s/600s on raw stream silence).
            // This one catches the bridge-specific case where the lead is
            // waiting on a `worker finished` notification that never arrives:
            // if the SSE stream is quiet beyond STALL_TIMEOUT_S (default 600s)
            // and the session isn't in `tool_running`, emit via notifyFn and
            // abort so the outer catch renders a normal error footer.
            stallWatch = startBridgeStallWatchdog({
              sessionId: session.id,
              getRuntime: () => getSessionRuntime(session.id),
              getIteration: () => lastIteration,
              abort: (reason) => {
                const rt = getSessionRuntime(session.id);
                rt?.controller?.abort?.(reason);
              },
              notify: emit,
              modelTag,
              role,
            });
            result = await askSession(session.id, prompt, args.context || null, (iteration, calls) => {
              if (typeof iteration === 'number' && iteration > lastIteration) lastIteration = iteration;
              for (const c of calls) toolCallLog.push({ name: c.name, iteration });
            }, workerCwd);
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            // Usage display — `ctx` is the LAST turn's promptTokens (how big
            // the context was at the end, actionable for compaction decisions).
            // `cache %` is cumulative cache / cumulative prompt — the cost
            // signal (100% ≈ almost free). `out` stays cumulative because
            // total response length is the natural aggregate for output.
            // Fallback math handles providers that didn't ship promptTokens.
            const u = result.usage || {};               // cumulative
            const lastU = result.lastTurnUsage || u;    // last turn (fallback to cumulative)
            const firstU = result.firstTurnUsage || lastU; // first turn (fallback)

            // cache % per turn — cache_read only (cache_write is paid input,
            // not a hit). Without this, anthropic's cache_write inflates the
            // ratio to 100% even on cold writes; cache_read alone gives a
            // provider-comparable signal for both anthropic and openai.
            function turnCachePct(turnUsage) {
                const p = typeof turnUsage.promptTokens === 'number'
                    ? turnUsage.promptTokens
                    : (turnUsage.inputTokens || 0) + (turnUsage.cachedTokens || 0) + (turnUsage.cacheWriteTokens || 0);
                const c = turnUsage.cachedTokens || 0;
                return p > 0 ? Math.round(c / p * 100) : 0;
            }
            const firstPct = turnCachePct(firstU);
            const lastPct = turnCachePct(lastU);

            const lastInput = lastU.inputTokens || 0;
            const lastCacheRead = lastU.cachedTokens || 0;
            const lastCacheWrite = lastU.cacheWriteTokens || 0;
            const ctxTokens = typeof lastU.promptTokens === 'number'
                ? lastU.promptTokens
                : (lastInput + lastCacheRead + lastCacheWrite);

            const ctxTok = fmtTokens(ctxTokens);
            const outTok = fmtTokens(u.outputTokens || 0);
            const loops = result.iterations || 1;
            const loopNote = `${loops} loop${loops === 1 ? '' : 's'}`;
            let content;
            if (result && typeof result.content === 'string' && result.content.length > 0) {
              content = result.content;
            } else {
              // Telemetry: why did the bridge result lack content?
              const shape = {
                resultType: typeof result,
                contentType: typeof result?.content,
                contentLen: typeof result?.content === 'string' ? result.content.length : null,
                hasToolCalls: Array.isArray(result?.toolCalls) ? result.toolCalls.length : null,
                stopReason: result?.stopReason ?? result?.stop_reason ?? null,
                midstreamRetries: result?.__midstreamRetries ?? null,
                keys: result && typeof result === 'object' ? Object.keys(result) : null,
              };
              try { process.stderr.write(`[bridge] empty-content fallback for sessionId=${session?.id ?? 'unknown'} shape=${JSON.stringify(shape)}\n`); } catch {}
              content = '(empty response)';
            }
            const footer = `${modelLabel} · ${ctxTok} ctx · cache ${lastPct}% · ${outTok} out · ${loopNote} · ${elapsed}s`;
            emit(`${modelTag}[${role}] ${content}\n\n${footer}`);
            updateSessionStatus(session.id, 'idle');
          } catch (err) {
            completed = false;
            errorMessage = err instanceof Error ? err.message : String(err);
            if (stallWatch.fired()) {
              // The stall watchdog already emitted a user-facing message
              // before aborting; whatever error bubbled up here (likely a
              // SessionClosedError or provider-side abort surface) is just
              // the unwind. Mark the session as errored and fall through.
              updateSessionStatus(session.id, 'error');
            } else if (err instanceof SessionClosedError) {
              // Prefer the structured enum on the error; fall back to
              // regex-parsing the message for older call paths that might
              // have constructed the error without the third arg.
              let reason = err.reason || null;
              if (!reason && typeof err.message === 'string') {
                const m = err.message.match(/reason=([\w-]+)/);
                if (m) reason = m[1];
              }
              emit(`${role} cancelled (reason=${reason || 'unknown'})`);
              // Cancellation isn't an error; flip to idle so the next sweep
              // pass can reclaim the file instead of leaving a 'running'
              // zombie until the 24h tombstone window expires.
              updateSessionStatus(session.id, 'idle');
            } else if (err instanceof StreamStalledAbortError) {
              const info = err.info || {};
              const header = `⚠ stream stalled — ${info.staleSeconds}s no delta (stage: ${info.stage || 'unknown'})`;
              emit(`${role} error: ${header}`);
              updateSessionStatus(session.id, 'error');
            } else if (err instanceof ToolLoopAbortError) {
              const info = err.info || {};
              const header = `⚠ tool loop aborted — ${info.attemptCount}× ${info.toolName}:${info.errorCategory}`;
              emit(`${role} error: ${header}`);
              updateSessionStatus(session.id, 'error');
            } else {
              emit(`${role} error: ${errorMessage}`);
              updateSessionStatus(session.id, 'error');
            }
          } finally {
            try { stallWatch.stop(); } catch { /* idempotent */ }
            // Detach request-abort listener — IIFE has settled, further
            // aborts on the MCP request have nothing to tear down. Harmless
            // if already removed via { once: true } on fire.
            try { abortHandle.detach(); } catch { /* ignore */ }
            try {
              const cfg = loadConfig();
              if (cfg.trajectory?.enabled !== false) {
                recordTrajectory({
                  session_id: session.id,
                  scope: role,
                  preset: presetName,
                  model: modelLabel,
                  agent_type: 'bridge',
                  tool_calls_json: JSON.stringify(toolCallLog),
                  iterations: result?.iterations || 1,
                  tokens_in: result?.usage?.inputTokens || 0,
                  tokens_out: result?.usage?.outputTokens || 0,
                  duration_ms: Date.now() - t0,
                  completed: completed ? 1 : 0,
                  error_message: errorMessage,
                });
              }
            } catch {}
          }
        })().catch((err) => {
          const msg = err instanceof Error ? (err.stack || err.message) : String(err);
          try {
            process.stderr.write(`[bridge] detached runner unhandled: session=${session.id} role=${role} job=${jobId} ${msg}\n`);
          } catch {}
          try { updateSessionStatus(session.id, 'error'); } catch {}
          try { closeSession(session.id, 'runner-crash'); } catch {}
        });

        return ok({
          jobId,
          sessionId: session.id,
          role,
          model: modelLabel,
          detached: true,
          hint: 'Use close_session(sessionId) to stop this detached bridge worker early.',
        });
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(err);
  }
}

export async function start() { /* noop — standalone mode uses main() */ }
export async function stop() { stopAgentMaintenance(); await disconnectAll(); }
