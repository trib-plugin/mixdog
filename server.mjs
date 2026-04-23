#!/usr/bin/env node
/**
 * mixdog — MCP server entry point.
 *
 * Four modules (channels, memory, search, agent) exposed over a single
 * MCP server. Tool routing is driven by the static manifest in tools.json,
 * which records the owning module for every tool.
 *
 * Module lifecycle:
 *   • memory — eager init right after the MCP handshake completes,
 *     because channels depends on it for episode delivery.
 *   • channels — eager init (runs background workers: Discord gateway,
 *     scheduler, webhook, event pipeline). Started after memory is ready.
 *   • search / agent — eager init after MCP handshake.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { fork } from 'child_process'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, watch as fsWatch, existsSync, unlinkSync } from 'fs'
import { join, resolve as pathResolve } from 'path'
import { homedir } from 'os'
import { pathToFileURL } from 'url'
import { createRequire } from 'module'
import { resolvePluginData } from './src/shared/plugin-paths.mjs'
import { ensureDataSeeds } from './src/shared/seed.mjs'

// ── Environment ──────────────────────────────────────────────────────
// Claude Code normally injects CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA
// for relative-path plugin sources. For URL-based sources it may skip
// injection, so fall back to process.cwd() and the standard data path.
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || process.cwd()
const PLUGIN_DATA = resolvePluginData()
mkdirSync(PLUGIN_DATA, { recursive: true })
try { ensureDataSeeds(PLUGIN_DATA) } catch {}

// ── Singleton lock ──────────────────────────────────────────────────
// Prevents two server.mjs instances (e.g. marketplaces/ path vs cache/
// path) from running in parallel and firing schedules / workers twice.
// Strategy: pidfile in PLUGIN_DATA. On boot, if an existing pidfile's
// owner is still alive we exit 0 and let the incumbent keep serving.
// Stale files (process gone) are overwritten.
const LOCK_PATH = join(PLUGIN_DATA, 'server.lock')
function _isPidAlive(pid) {
  if (!pid || pid === process.pid) return false
  try { process.kill(pid, 0); return true } catch (err) {
    // EPERM means the pid exists but we can't signal it — still alive.
    return err?.code === 'EPERM'
  }
}
try {
  if (existsSync(LOCK_PATH)) {
    const raw = readFileSync(LOCK_PATH, 'utf-8').trim()
    const existingPid = Number.parseInt(raw, 10)
    if (Number.isFinite(existingPid) && _isPidAlive(existingPid)) {
      process.stderr.write(`[server] another mixdog instance already running (pid=${existingPid}); exiting.\n`)
      process.exit(0)
    }
  }
} catch { /* malformed lock — overwrite below */ }
writeFileSync(LOCK_PATH, String(process.pid))
const _releaseLock = () => {
  try {
    const raw = readFileSync(LOCK_PATH, 'utf-8').trim()
    if (Number.parseInt(raw, 10) === process.pid) unlinkSync(LOCK_PATH)
  } catch { /* ignore */ }
}
process.on('exit', _releaseLock)
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => { _releaseLock(); process.exit(0) }) } catch { /* unsupported on platform */ }
}

globalThis.__tribFastEntry = true

// ── Unified config sync ────────────────────────────────────────────
// mixdog-config.json is the single source. On boot, split into individual
// files so each module can read its own file without changes.
try {
  const mixdogCfgPath = join(PLUGIN_DATA, 'mixdog-config.json')
  const SECTION_FILES = { channels: 'config.json', agent: 'agent-config.json', memory: 'memory-config.json', search: 'search-config.json' }
  let tribCfg
  try { tribCfg = JSON.parse(readFileSync(mixdogCfgPath, 'utf8')) } catch { tribCfg = null }
  if (tribCfg) {
    for (const [section, file] of Object.entries(SECTION_FILES)) {
      if (tribCfg[section]) writeFileSync(join(PLUGIN_DATA, file), JSON.stringify(tribCfg[section], null, 2) + '\n')
    }
  } else {
    // First run: merge individual files into mixdog-config.json
    const merged = {}
    for (const [section, file] of Object.entries(SECTION_FILES)) {
      try { merged[section] = JSON.parse(readFileSync(join(PLUGIN_DATA, file), 'utf8')) } catch {}
    }
    if (Object.keys(merged).length > 0) writeFileSync(mixdogCfgPath, JSON.stringify(merged, null, 2) + '\n')
  }
} catch (e) { log(`config sync: ${e.message}`) }

// ── Module enable flags (B6 General toggles) ──────────────────────
// Snapshotted once at boot — toggling in the setup UI requires a full
// plugin restart to take effect. All four default to enabled:true when
// the `modules` section is absent (backcompat for pre-B6 configs).
const MODULE_NAMES = ['channels', 'memory', 'search', 'agent']
const MODULE_ENABLED = (() => {
  const out = { channels: true, memory: true, search: true, agent: true }
  try {
    const raw = JSON.parse(readFileSync(join(PLUGIN_DATA, 'mixdog-config.json'), 'utf8'))
    const mods = raw && typeof raw === 'object' ? raw.modules : null
    if (mods && typeof mods === 'object') {
      for (const name of MODULE_NAMES) {
        const entry = mods[name]
        if (entry && typeof entry === 'object' && entry.enabled === false) out[name] = false
      }
    }
  } catch { /* missing / malformed — keep all enabled */ }
  return out
})()
const isModuleEnabled = (name) => MODULE_ENABLED[name] !== false

// ── Static manifest ─────────────────────────────────────────────────
const RAW_TOOL_DEFS = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'tools.json'), 'utf8'))
// Hide tools belonging to disabled modules from BOTH the ListTools
// response AND the bridge's internal-tools registry. `builtin` / `lsp` /
// `bash_session` / `patch` are not module-gated — they ride along with
// the plugin regardless.
const TOOL_DEFS = RAW_TOOL_DEFS.filter(t => {
  if (!t.module) return true
  if (MODULE_NAMES.includes(t.module)) return isModuleEnabled(t.module)
  return true
})
const TOOL_MODULE = Object.fromEntries(TOOL_DEFS.map(t => [t.name, t.module]))
const TOOL_BY_NAME = Object.fromEntries(TOOL_DEFS.map(t => [t.name, t]))
const PLUGIN_VERSION = JSON.parse(
  readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
).version

// ── Logging ──────────────────────────────────────────────────────────
const LOG_FILE = join(PLUGIN_DATA, 'mcp-debug.log')
const log = msg => appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`)

// ── Crash handlers ──────────────────────────────────────────────────
// Leave a trace on silent hangs. Previously only child workers
// (channels/memory) installed these; the main MCP entry had none, so
// unhandled errors died without writing a stack.
const CRASH_FILE = join(PLUGIN_DATA, 'crash.log')
const logCrash = (kind, err) => {
  const stack = err?.stack || String(err)
  try { appendFileSync(CRASH_FILE, `[${new Date().toISOString()}] ${kind}\n${stack}\n\n`) } catch {}
  try { log(`${kind}: ${err?.message || err}`) } catch {}
}
process.on('uncaughtException', (err) => { logCrash('uncaughtException', err); process.exit(1) })
process.on('unhandledRejection', (reason) => { logCrash('unhandledRejection', reason) })

// ── Bridge orphan cleanup ───────────────────────────────────────────
try {
  const { cleanupOrphanedPids } = await import(pathToFileURL(join(PLUGIN_ROOT, 'src/shared/llm/pid-cleanup.mjs')).href)
  const killed = cleanupOrphanedPids()
  if (killed > 0) log(`[bridge-cleanup] cleaned ${killed} orphaned processes`)
} catch (e) {
  log(`[bridge-cleanup] failed: ${e && (e.stack || e.message) || e}`)
}

// ── Session cleanup: bridge sessions from previous MCP process ─────
try {
  const { listSessions, closeSession, startIdleCleanup } = await import(pathToFileURL(join(PLUGIN_ROOT, 'src/agent/orchestrator/session/manager.mjs')).href)
  const sessions = listSessions()
  let closed = 0
  for (const s of sessions) {
    if (s.owner === 'bridge' && (!s.mcpPid || s.mcpPid !== process.pid)) { closeSession(s.id); closed++ }
  }
  log(`[session-cleanup] closed ${closed} stale bridge sessions (pid≠${process.pid}), ${sessions.length - closed} remaining`)
  // Start periodic idle session cleanup (check every 5 min; TTL lives in session/store.mjs)
  startIdleCleanup()
  log(`[session-cleanup] idle sweep timer started (interval=5m)`)
} catch (e) {
  log(`[session-cleanup] failed: ${e && (e.stack || e.message) || e}`)
}

// ── Bridge worktree sweeper (v0.6.243) ──────────────────────────────
// Previous MCP process may have died mid-dispatch, leaving orphaned
// worktrees under .mixdog-worktrees/<sessionId>/. Any directory whose
// sessionId isn't in the live session set (after the stale-bridge
// closeSession sweep above) is an orphan and safe to reclaim.
try {
  const { listSessions } = await import(pathToFileURL(join(PLUGIN_ROOT, 'src/agent/orchestrator/session/manager.mjs')).href)
  const { sweepOrphanedWorktrees } = await import(pathToFileURL(join(PLUGIN_ROOT, 'src/agent/bridge-worktree.mjs')).href)
  const live = new Set()
  for (const s of listSessions()) {
    if (s.owner === 'bridge' && (s.status === 'running' || s.status === 'tool_running')) live.add(s.id)
  }
  const result = sweepOrphanedWorktrees(PLUGIN_ROOT, live, { log: (m) => log(m) })
  if (result.scanned > 0) {
    log(`[worktree-cleanup] scanned=${result.scanned} cleaned=${result.cleaned.length} failed=${result.failures.length}`)
  }
} catch (e) {
  log(`[worktree-cleanup] failed: ${e && (e.stack || e.message) || e}`)
}

// ── MCP server ──────────────────────────────────────────────────────
const SERVER_INSTRUCTIONS = [
  `mixdog MCP server v${PLUGIN_VERSION}.`,
  '',
  'Agent delegation:',
  '- Hand off implementation / review / research / debug / test work to external agents via `bridge` with a `role` argument.',
  '- Role names are user-defined in `user-workflow.json`; the currently-active role set is injected into the Lead session as the `# Roles` rule — consult that rather than hard-coding role names.',
  '- Built-in `Agent` / `TaskCreate` / `TeamCreate` are NOT used for agent spawning in this ecosystem; `bridge` is the single entry point.',
  '',
  'Information retrieval (HIGHEST PRIORITY — always prefer these; never reach for `bash` to list / read / find files):',
  '- `recall` — past context from the memory store.',
  '- `search` — external web / URL scrape / GitHub code / issues / repos.',
  '- `explore` — internal codebase search. `cwd` is authoritative.',
  '- Order when unsure: recall → search → explore → grep+read. This order is mandatory, not a suggestion.',
  '- `bash` is for shell-only work (git, build, test, run). Using `bash` with `ls` / `cat` / `find` / `head` / `tail` / `grep` for file or code lookup is a violation — use `read` / `glob` / `list` / `grep` / `explore` instead.',
  '',
  'Channels:',
  '- Schedule / webhook / queue / proactive events are delivered into the Lead session through the built-in channel mechanism; each carries its own event-class marker.',
].join('\n')

const server = new Server(
  { name: 'mixdog', version: PLUGIN_VERSION },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
    },
    instructions: SERVER_INSTRUCTIONS,
  },
)

// ── Channel permission request forwarding ──────────────────────────
// Claude Code's interactiveHandler races the terminal dialog against every
// MCP channel server that declares `experimental['claude/channel/permission']`.
// When CC fires this notification, forward it into the channels worker so it
// can post the Discord prompt. The worker reports the outcome back through
// the generic {type:'notify'} IPC path above, which becomes a
// `notifications/claude/channel/permission` notification on the MCP server.
const ChannelPermissionRequestNotificationSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string().optional(),
    input_preview: z.string().optional(),
  }).passthrough(),
})

server.setNotificationHandler(ChannelPermissionRequestNotificationSchema, async (notification) => {
  const entry = workers.get('channels')
  const reqId = notification?.params?.request_id
  if (!entry?.proc?.connected || !entry.ready) {
    log(`permission_request dropped: channels worker not available (request_id=${reqId})`)
    return
  }
  try {
    entry.proc.send({ type: 'permission_request_inbound', params: notification.params })
  } catch (err) {
    log(`permission_request IPC send failed: ${err instanceof Error ? err.message : String(err)}`)
  }
})

// ── Worker process management ──────────────────────────────────────
const workers = new Map() // name → { proc, ready, pending }
const WORKER_MAX_RESTARTS = 3
const workerRestarts = new Map() // name → count

// Cached bridge-llm factory import — loaded on first agent_ipc_request and
// reused thereafter. The agent module must be loaded before the first call
// (loadModule('agent') runs at boot, well before any memory cycle fires).
let _bridgeLlmFactory = null
async function _getBridgeLlmFactory() {
  if (_bridgeLlmFactory) return _bridgeLlmFactory
  const mod = await import(
    pathToFileURL(join(PLUGIN_ROOT, 'src', 'agent', 'orchestrator', 'smart-bridge', 'bridge-llm.mjs')).href
  )
  _bridgeLlmFactory = mod.makeBridgeLlm
  return _bridgeLlmFactory
}

async function handleAgentIpcRequest(msg) {
  const params = msg?.params || {}
  try {
    if (msg.tool !== 'bridge_llm') {
      return { ok: false, error: `unsupported agent_ipc tool "${msg.tool}"` }
    }
    if (!params.prompt) {
      return { ok: false, error: 'bridge_llm: prompt required' }
    }
    const makeBridgeLlm = await _getBridgeLlmFactory()
    const llm = makeBridgeLlm({
      role: params.role || undefined,
      taskType: params.taskType || undefined,
      mode: params.mode || undefined,
      cwd: params.cwd || undefined,
    })
    const raw = await llm({
      prompt: params.prompt,
      mode: params.mode || undefined,
      preset: params.preset || undefined,
      timeout: params.timeout || undefined,
    })
    return { ok: true, result: raw }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

function spawnWorker(name) {
  const modulePath = join(PLUGIN_ROOT, 'src', name, 'index.mjs')
  const proc = fork(modulePath, [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_PLUGIN_DATA: PLUGIN_DATA,
      MIXDOG_WORKER_MODE: '1',
    },
    windowsHide: true,
  })

  const entry = { proc, ready: false, pending: [] }
  workers.set(name, entry)

  proc.on('message', msg => {
    if (msg.type === 'ready') {
      entry.ready = true
      log(`worker ${name} ready (pid=${proc.pid})`)
      return
    }
    if (msg.type === 'result' && msg.callId) {
      const pending = entry.pending.find(p => p.callId === msg.callId)
      if (pending) {
        entry.pending = entry.pending.filter(p => p.callId !== msg.callId)
        if (msg.error) pending.reject(new Error(msg.error))
        else pending.resolve(msg.result)
      }
      return
    }
    if (msg.type === 'notify' && msg.method) {
      // Worker → parent notification forwarding. The worker has no MCP
      // transport of its own; this is the single path that delivers Discord
      // inbound, schedule injects, webhook events, proactive, and
      // interaction events to the host (Claude Code) over the parent's
      // connected Server.
      server.notification({ method: msg.method, params: msg.params || {} })
        .catch(err => {
          log(`worker ${name} notify forward failed (${msg.method}): ${err instanceof Error ? err.message : String(err)}`)
        })
      return
    }
    if (msg.type === 'agent_ipc_request' && msg.callId) {
      // Worker → parent bridge LLM request. Memory worker cannot own the
      // provider registry / session manager (those live in the parent
      // process via loadModule('agent')), so cycle1 / cycle2 route every
      // LLM call here. We run the bridge call in-process, then ship the
      // raw assistant content back to the caller.
      void handleAgentIpcRequest(msg).then(res => {
        try { proc.send({ type: 'agent_ipc_response', callId: msg.callId, ...res }) } catch {}
      })
      return
    }
  })

  proc.on('exit', (code) => {
    log(`worker ${name} exited (code=${code})`)
    workers.delete(name)
    for (const p of entry.pending) {
      p.reject(new Error(`worker ${name} exited unexpectedly`))
    }
    const count = (workerRestarts.get(name) || 0) + 1
    workerRestarts.set(name, count)
    if (count <= WORKER_MAX_RESTARTS) {
      log(`restarting worker ${name} (attempt ${count}/${WORKER_MAX_RESTARTS})`)
      setTimeout(() => spawnWorker(name), 1000)
    } else {
      log(`worker ${name} exceeded max restarts, marking degraded`)
    }
  })

  proc.on('error', (err) => {
    log(`worker ${name} error: ${err.message}`)
  })

  return entry
}

let _callIdSeq = 0
const WORKER_CALL_TIMEOUT = 600000 // 10m per tool call

function callWorker(name, toolName, args) {
  return new Promise((resolve, reject) => {
    const entry = workers.get(name)
    if (!entry || !entry.proc.connected || !entry.ready) {
      return reject(new Error(`worker ${name} not available`))
    }
    const callId = String(++_callIdSeq)
    const timer = setTimeout(() => {
      entry.pending = entry.pending.filter(p => p.callId !== callId)
      reject(new Error(`worker ${name} call ${toolName} timed out after ${WORKER_CALL_TIMEOUT}ms`))
    }, WORKER_CALL_TIMEOUT)
    entry.pending.push({ callId, resolve: v => { clearTimeout(timer); resolve(v) }, reject: e => { clearTimeout(timer); reject(e) } })
    try {
      const sent = entry.proc.send({ type: 'call', callId, name: toolName, args })
      if (sent === false) {
        clearTimeout(timer)
        entry.pending = entry.pending.filter(p => p.callId !== callId)
        reject(new Error(`worker ${name} IPC channel full or closed`))
      }
    } catch (sendErr) {
      clearTimeout(timer)
      entry.pending = entry.pending.filter(p => p.callId !== callId)
      reject(new Error(`worker ${name} send failed: ${sendErr.message}`))
    }
  })
}

// ── Module loader (cached, init+start runs once per module) ─────────
const modules = new Map()

function pushChannelNotification(content, extraMeta) {
  // Single exit path for BOTH channel notifications (proactive / schedule /
  // webhook / queue / bridge lifecycle) AND dispatch results (recall / search
  // / explore merged answers tagged `meta.type: 'dispatch_result'`). Despite
  // the name, this function is bidirectional — the `extraMeta.type` field
  // distinguishes the two flavours for downstream routing, not this function.
  //
  // `silent_to_agent: true` — bridge lifecycle status pings (worker started,
  // iter N, role-start echoes) that should surface on Discord but NOT land
  // in the Lead agent's context window. When set we skip the Lead-notify
  // hop entirely and ask the channels worker to post the content directly
  // to the currently-active bridge channel. The meta flag is otherwise
  // forwarded downstream so any future consumer that sees it can recognise
  // and drop it. Default (flag absent/false) → legacy behaviour preserved.
  const meta = { user: 'mixdog-agent', user_id: 'system', ts: new Date().toISOString(), ...(extraMeta || {}) }
  const silent = meta.silent_to_agent === true
  if (silent) {
    const entry = workers.get('channels')
    if (entry?.proc?.connected) {
      try { entry.proc.send({ type: 'forward_to_discord', content, channelId: meta.chat_id || null }) } catch (err) {
        log(`[agent-notify] silent forward IPC failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return Promise.resolve()
  }
  return server.notification({
    method: 'notifications/claude/channel',
    params: { content, meta },
  }).catch(err => {
    log(`[agent-notify] channel failed: ${err instanceof Error ? err.message : String(err)}`)
  })
}

function agentContext() {
  return {
    notifyFn: (text, extraMeta) => pushChannelNotification(text, extraMeta),
    elicitFn: opts => server.elicitInput(opts),
    // In-process tool bridge. External LLMs see the plugin's non-agent tools
    // (search, search_memories, channels actions, etc.) and their tool_calls
    // land back in dispatchTool, which routes to the same worker IPC /
    // in-process module the MCP call handler uses. Replaces the MCP HTTP
    // loopback path. agent-module tools are refused to prevent recursion.
    toolExecutor: async (name, args, callerCtx = {}) => {
      if (TOOL_MODULE[name] === 'agent') {
        throw new Error(`tool "${name}" is agent-internal and cannot be invoked via bridge`)
      }
      return dispatchTool(name, args, callerCtx)
    },
    internalTools: TOOL_DEFS.filter(t => t.module && t.module !== 'agent'),
  }
}

async function loadModule(name) {
  let entry = modules.get(name)
  if (entry) return entry
  const url = pathToFileURL(join(PLUGIN_ROOT, 'src', name, 'index.mjs')).href
  const mod = await import(url)
  if (mod.init) await mod.init(server)
  if (mod.start) await mod.start()
  entry = mod
  modules.set(name, entry)
  log(`module ${name} ready`)
  return entry
}

// Shared dispatcher — used by the MCP call handler AND the agent's
// toolExecutor passed through agentContext(). Single source of tool routing.
async function dispatchTool(name, args, callerCtx = {}) {
  const def = TOOL_BY_NAME[name]
  if (!def) {
    // Distinguish "disabled module" from "unknown tool" so callers (and
    // the Lead) get an actionable message instead of a generic miss.
    const rawDef = RAW_TOOL_DEFS.find(t => t.name === name)
    if (rawDef && rawDef.module && MODULE_NAMES.includes(rawDef.module) && !isModuleEnabled(rawDef.module)) {
      throw new Error(`module '${rawDef.module}' is disabled — enable it in the setup UI (General → Modules) and restart the plugin`)
    }
    throw new Error(`Unknown tool: ${name}`)
  }

  if (def.aiWrapped) {
    const { dispatchAiWrapped } = await import(
      pathToFileURL(join(PLUGIN_ROOT, 'src/agent/orchestrator/ai-wrapped-dispatch.mjs')).href,
    )
    return dispatchAiWrapped(name, args ?? {}, {
      PLUGIN_ROOT,
      callMemoryWorker: (n, a) => callWorker('memory', n, a),
      // Caller session id propagates from loop.mjs → executeInternalTool →
      // toolExecutor → dispatchTool → dispatchAiWrapped. Used there to reject
      // recursion when a hidden-role session (recall-agent / search-agent /
      // explorer / cycle1/2) tries to re-enter an aiWrapped dispatcher.
      callerSessionId: callerCtx.callerSessionId,
      // Push merged answer into the Lead session when a dispatch
      // (wait:false) completes, so Lead integrates the result on its next
      // turn via a channel notification (no polling tool exposed).
      notifyFn: pushChannelNotification,
    })
  }

  if (def.module === 'builtin') {
    // Plugin builtin file tools exposed to external MCP clients (e.g. the
    // Lead / Claude Code harness). Only tools that add capability Claude
    // Code doesn't already offer are surfaced here — multi_read,
    // batch_edit — so the native Read/Edit/MultiEdit remain the default
    // and these are used opportunistically when the caller wants a
    // cross-file batch or a single-turn multi-file read. Path validation
    // (isSafePath) and write semantics live inside executeBuiltinTool.
    const { executeBuiltinTool } = await import(
      pathToFileURL(join(PLUGIN_ROOT, 'src/agent/orchestrator/tools/builtin.mjs')).href,
    )
    const text = await executeBuiltinTool(name, args ?? {}, process.cwd())
    return { content: [{ type: 'text', text: String(text) }] }
  }

  if (def.module === 'lsp') {
    // LSP-backed symbol tools. One shared typescript-language-server
    // child is spawned on first call and torn down after 90s idle; see
    // src/agent/orchestrator/tools/lsp.mjs for the state machine.
    const { executeLspTool } = await import(
      pathToFileURL(join(PLUGIN_ROOT, 'src/agent/orchestrator/tools/lsp.mjs')).href,
    )
    const text = await executeLspTool(name, args ?? {}, process.cwd())
    return { content: [{ type: 'text', text: String(text) }] }
  }

  if (def.module === 'astgrep') {
    // Structural search / rewrite via the `sg` CLI. Stateless wrapper —
    // each call spawns `sg run ...` with the bundled sgconfig.yml so
    // `.mjs` / `.cjs` are recognised as JavaScript regardless of cwd.
    const { executeAstGrepTool } = await import(
      pathToFileURL(join(PLUGIN_ROOT, 'src/agent/orchestrator/tools/astgrep.mjs')).href,
    )
    const text = await executeAstGrepTool(name, args ?? {}, process.cwd())
    return { content: [{ type: 'text', text: String(text) }] }
  }

  if (def.module === 'code_graph') {
    const { executeCodeGraphTool } = await import(
      pathToFileURL(join(PLUGIN_ROOT, 'src/agent/orchestrator/tools/code-graph.mjs')).href,
    )
    const text = await executeCodeGraphTool(name, args ?? {}, process.cwd())
    return { content: [{ type: 'text', text: String(text) }] }
  }

  if (def.module === 'patch') {
    // Unified-diff apply tool — inverse of `diff`. One-turn multi-file
    // edits without Read-before-Edit (the patch's context lines are the
    // read-proof). Scope-checked per file via isSafePath, mtime-guarded
    // against concurrent writes. See src/agent/orchestrator/tools/patch.mjs.
    const { executePatchTool } = await import(
      pathToFileURL(join(PLUGIN_ROOT, 'src/agent/orchestrator/tools/patch.mjs')).href,
    )
    const text = await executePatchTool(name, args ?? {}, process.cwd())
    return { content: [{ type: 'text', text: String(text) }] }
  }

  if (def.module === 'bash_session') {
    // Persistent-shell tool. A pool of long-lived bash children keyed by
    // session_id preserves cwd / env / `source`d state across calls, so the
    // model can run `cd proj → activate venv → pytest` as three ordinary
    // calls instead of rebuilding shell context each turn. Same blocked-
    // pattern guard and output framing as the stateless `bash` tool.
    // See src/agent/orchestrator/tools/bash-session.mjs.
    const { executeBashSessionTool } = await import(
      pathToFileURL(join(PLUGIN_ROOT, 'src/agent/orchestrator/tools/bash-session.mjs')).href,
    )
    const text = await executeBashSessionTool(name, args ?? {}, process.cwd())
    return { content: [{ type: 'text', text: String(text) }] }
  }

  const moduleName = TOOL_MODULE[name]
  if (!moduleName) throw new Error(`Unknown tool: ${name}`)

  if (moduleName === 'memory' || moduleName === 'channels') {
    return callWorker(moduleName, name, args ?? {})
  }

  const mod = await loadModule(moduleName)
  if (moduleName === 'agent') {
    // Merge shared agent context with the per-request abort signal so the
    // bridge handler can tear down its async IIFE on client-side cancel.
    const ctx = agentContext()
    if (callerCtx?.requestSignal) ctx.requestSignal = callerCtx.requestSignal
    return mod.handleToolCall(name, args ?? {}, ctx)
  }
  return mod.handleToolCall(name, args ?? {})
}

// ── Handlers ────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args } = req.params
  // `extra.signal` is an AbortSignal that fires when the MCP client cancels
  // this request (e.g. user rejects / interrupts a tool call in Claude Code).
  // Thread it down so long-running tools — specifically the async IIFE the
  // `bridge` tool spawns to run askSession — can close their session and
  // stop hitting the provider after the user bails out.
  return dispatchTool(name, args, { requestSignal: extra?.signal })
})

// ── Eager init BEFORE transport connect ─────────────────────────────
// Pool C sessions (recall-agent / search-agent / explorer) snapshot the
// internal-tools registry at createSession time via _getMcpToolsCached.
// If `loadModule('agent').then(...addInternalTools)` was still pending
// when the first bridge call landed, the registry was empty, so
// memory_search / web_search never made it into the session's tool
// schema and the agent truthfully answered "I don't have access to
// memory_search". Awaiting the agent module init here closes the race.
//
// Search eager-load stays fire-and-forget: it doesn't seed any registry,
// just avoids the first-call compile-JIT cost.
if (isModuleEnabled('search')) {
  loadModule('search').catch(e => log(`eager search init failed: ${e.message}`))
} else {
  log(`module 'search' disabled — skipping eager init`)
}
try {
  if (!isModuleEnabled('agent')) {
    log(`module 'agent' disabled — skipping eager init, bridge and synthetic tools will not register`)
  } else {
  await loadModule('agent').then(async () => {
    // Populate the in-process tool registry at boot so ALL session entry
    // points (direct createSession / resumeSession, not just handleToolCall)
    // see the bridge from the first call. handleToolCall still calls
    // setInternalToolsProvider as an idempotent fallback, but we no longer
    // rely on a tool call arriving first.
    try {
      const internalToolsMod = await import(
        pathToFileURL(join(PLUGIN_ROOT, 'src', 'agent', 'orchestrator', 'internal-tools.mjs')).href
      )
      const { setInternalToolsProvider, addInternalTools } = internalToolsMod
      const ctx = agentContext()
      setInternalToolsProvider({ executor: ctx.toolExecutor, tools: ctx.internalTools })

      // Pool C synthetic tools — memory_search / web_search bypass the
      // aiWrapped recall/search tools (those re-enter the agent fan-out and
      // would loop) and route straight to the native memory worker and
      // search module handlers. Registered here so every tools=full session
      // sees them; only recall-agent / search-agent are prompted to call.
      //
      // Defs live in src/agent/orchestrator/synthetic-tools.mjs so the bench
      // script (scripts/measure-bp1.mjs) can read from the same source of
      // truth without duplicating schemas.
      const { SYNTHETIC_TOOL_DEFS } = await import(
        pathToFileURL(join(PLUGIN_ROOT, 'src', 'agent', 'orchestrator', 'synthetic-tools.mjs')).href
      )
      const SYNTHETIC_EXECUTORS = {}
      // memory_search is only useful when the memory worker is running;
      // web_search routes through the search module. Gate each on its
      // owning module's enable flag so disabling memory / search cleanly
      // removes the synthetic bridge tool too.
      if (isModuleEnabled('memory')) {
        SYNTHETIC_EXECUTORS.memory_search = async (args) => callWorker('memory', 'search_memories', args || {})
      }
      if (isModuleEnabled('search')) {
        SYNTHETIC_EXECUTORS.web_search = async (args) => {
          const searchMod = await loadModule('search')
          return searchMod.handleToolCall('search', args || {})
        }
      }
      const syntheticEntries = SYNTHETIC_TOOL_DEFS.map(def => ({
        def,
        executor: SYNTHETIC_EXECUTORS[def.name],
      })).filter(entry => typeof entry.executor === 'function')
      addInternalTools(syntheticEntries)
      log(`internal-tools registry populated tools=${ctx.internalTools.length}+${syntheticEntries.length} (synthetic defs=${SYNTHETIC_TOOL_DEFS.length})`)
    } catch (e) {
      log(`internal-tools registry populate failed: ${e.message}`)
    }
  })
  }
} catch (e) { log(`eager agent init failed: ${e.message}`) }

// ── Transport ───────────────────────────────────────────────────────
await server.connect(new StdioServerTransport())
log(`connected pid=${process.pid} v${PLUGIN_VERSION} tools=${TOOL_DEFS.length}`)

// ── Dispatch restart recovery ──────────────────────────────────────
// If this bootstrap follows a process death that interrupted any async
// dispatch (recall / search / explore), emit one Aborted notification per
// orphaned handle so the Lead can close the loop instead of waiting forever.
try {
  const { recoverPending } = await import('./src/agent/orchestrator/dispatch-persist.mjs')
  const recovered = recoverPending(PLUGIN_DATA, pushChannelNotification)
  if (recovered > 0) log(`dispatch-recovery: emitted ${recovered} Aborted notifications`)
} catch (err) {
  log(`dispatch-recovery failed: ${err instanceof Error ? err.message : String(err)}`)
}

// ── CLAUDE.md managed block reconciliation ─────────────────────────
// Writes static rules into the managed block. Session recap is NOT
// written here — the SessionStart hook injects it live from sqlite.
// Fail-soft: any error is logged and swallowed.
//
//   mode === 'claude_md'  → upsert the managed block (strong enforcement)
//   mode === 'hook' (default or missing) → remove any stale managed block
function reconcileClaudeMd() {
  try {
    const cfgPath = join(PLUGIN_DATA, 'config.json')
    let mainConfig = {}
    try { mainConfig = JSON.parse(readFileSync(cfgPath, 'utf8')) } catch {}
    const injection = (mainConfig && mainConfig.promptInjection) || {}
    const targetPath = injection.targetPath || '~/.claude/CLAUDE.md'
    const req = createRequire(import.meta.url)
    const { buildInjectionContent } = req(join(PLUGIN_ROOT, 'lib', 'rules-builder.cjs'))
    const { upsertManagedBlock, removeManagedBlock, expandHome } = req(join(PLUGIN_ROOT, 'lib', 'claude-md-writer.cjs'))

    if (injection.mode === 'claude_md') {
      const content = buildInjectionContent({ PLUGIN_ROOT, DATA_DIR: PLUGIN_DATA })
      upsertManagedBlock(targetPath, content)
      log(`claude_md: wrote managed block to ${expandHome(targetPath)} (${content.length} chars)`)
    } else {
      const removed = removeManagedBlock(targetPath)
      if (removed) log(`hook mode: removed stale managed block from ${expandHome(targetPath)}`)
    }
  } catch (e) {
    log(`claude_md reconcile failed: ${e && (e.stack || e.message) || e}`)
  }
}

// ── CLAUDE.md managed block live watcher ───────────────────────────
// After boot-time reconcile, watch the rules/config sources and rebuild
// the managed block in-place whenever they change. Keeps the disk copy
// of CLAUDE.md in sync so the next session start always sees the latest
// rules, even if the user edited mid-session.
//
// Only active when injection.mode === 'claude_md'. In hook mode this is
// a no-op (hook mode regenerates on every prompt anyway).
//
// All errors are contained: per-watcher try/catch plus an outer try/catch
// so watcher setup failure never crashes the MCP server.
setImmediate(() => {
  try {
    const cfgPath = join(PLUGIN_DATA, 'config.json')
    let mainConfig = {}
    try { mainConfig = JSON.parse(readFileSync(cfgPath, 'utf8')) } catch {}
    const injection = (mainConfig && mainConfig.promptInjection) || {}
    if (injection.mode !== 'claude_md') return

    const targetPath = injection.targetPath || '~/.claude/CLAUDE.md'
    const req = createRequire(import.meta.url)
    const { buildInjectionContent } = req(join(PLUGIN_ROOT, 'lib', 'rules-builder.cjs'))
    const { upsertManagedBlock, expandHome } = req(join(PLUGIN_ROOT, 'lib', 'claude-md-writer.cjs'))
    const resolvedTarget = pathResolve(expandHome(targetPath))

    let debounceTimer = null
    const rebuild = triggerFilename => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        try {
          const content = buildInjectionContent({ PLUGIN_ROOT, DATA_DIR: PLUGIN_DATA })
          upsertManagedBlock(targetPath, content)
          log(`[rules-watcher] rebuilt managed block (${content.length} chars) after ${triggerFilename}`)
        } catch (e) {
          log(`[rules-watcher] rebuild failed: ${e && (e.stack || e.message) || e}`)
        }
      }, 300)
    }

    const DATA_ALLOWLIST = new Set([
      'mixdog-config.json', 'config.json', 'memory-config.json', 'search-config.json',
      'agent-config.json', 'user-workflow.json', 'user-workflow.md',
    ])

    const makeHandler = root => {
      const isDataDir = pathResolve(root) === pathResolve(PLUGIN_DATA)
      return (_eventType, filename) => {
        if (!filename) return
        if (!/\.(md|json)$/i.test(filename)) return
        const norm = filename.replace(/\\/g, '/')
        if (isDataDir && !DATA_ALLOWLIST.has(norm)) return
        const abs = pathResolve(root, filename)
        if (abs === resolvedTarget) return
        rebuild(filename)
      }
    }

    const roots = [
      join(PLUGIN_ROOT, 'rules'),
      PLUGIN_DATA,
    ]
    for (const root of roots) {
      try {
        fsWatch(root, { recursive: true, persistent: true }, makeHandler(root))
        log(`[rules-watcher] watching ${root}`)
      } catch (e) {
        log(`[rules-watcher] failed to watch ${root}: ${e && (e.stack || e.message) || e}`)
      }
    }
  } catch (e) {
    log(`[rules-watcher] setup failed: ${e && (e.stack || e.message) || e}`)
  }
})

// ── Status HTTP server (forked child) ──────────────────────────────
// Exposes /bridge/status on an ephemeral loopback port so the terminal
// statusline has a reliable data source independent of the on-demand
// setup-server (port 3458). Runs in its OWN forked process — bursty
// tool activity in this MCP process can otherwise starve the
// statusline's short 1-second curl timeout. Advertises the port via
// ~/.claude/mixdog-status.json; bin/statusline.sh reads that file.
const STATUS_ADVERTISE_PATH = join(homedir(), '.claude', 'mixdog-status.json')
let statusServerChild = null
setImmediate(() => {
  try {
    statusServerChild = fork(
      join(PLUGIN_ROOT, 'src/status/server.mjs'),
      [],
      {
        env: {
          ...process.env,
          MIXDOG_STATUS_DATA_DIR: PLUGIN_DATA,
          MIXDOG_STATUS_ADVERTISE_PATH: STATUS_ADVERTISE_PATH,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      }
    )
    statusServerChild.stdout?.on('data', (d) => log(String(d).trimEnd()))
    statusServerChild.stderr?.on('data', (d) => log(`[status-server] stderr: ${String(d).trimEnd()}`))
    statusServerChild.on('exit', (code, signal) => {
      log(`[status-server] child exited code=${code} signal=${signal}`)
      statusServerChild = null
    })
  } catch (e) {
    log(`[status-server] failed to fork: ${e && (e.stack || e.message) || e}`)
  }
})

// ── Spawn workers: memory + channels ──────────────────────────────
// Workers own all heavy work. Session recap, buffer flush, cycle
// scheduling all run inside the worker process. No in-process fallback.
//
// B6 gating:
// - memory disabled → worker not spawned; channels boots immediately
//   (episode delivery integration degrades to no-op).
// - channels disabled → worker never spawned regardless of memory state.
setImmediate(() => {
  const memoryOn = isModuleEnabled('memory')
  const channelsOn = isModuleEnabled('channels')

  if (memoryOn) spawnWorker('memory')
  else log(`module 'memory' disabled — skipping worker spawn`)

  if (!channelsOn) {
    log(`module 'channels' disabled — skipping worker spawn`)
    // CLAUDE.md reconcile is driven by channels/injection config; when
    // channels is off we still reconcile once so managed blocks stay in
    // sync with the current mode.
    try { reconcileClaudeMd() } catch {}
    return
  }

  // channels + CLAUDE.md depend on memory — wait for memory ready when enabled
  const memEntry = memoryOn ? workers.get('memory') : null
  if (memEntry) {
    const onReady = (msg) => {
      if (msg.type === 'ready') {
        reconcileClaudeMd()
        if (!workers.has('channels')) spawnWorker('channels')
        memEntry.proc.removeListener('message', onReady)
      }
    }
    memEntry.proc.on('message', onReady)
    // Safety: proceed anyway after 10s if ready never arrives
    setTimeout(() => {
      if (!workers.has('channels')) {
        reconcileClaudeMd()
        spawnWorker('channels')
      }
    }, 10000)
  } else {
    // memory disabled (or spawn failed) — boot channels immediately.
    // Previously this branch only covered the spawn-failed case; with B6
    // the memory-disabled path also lands here.
    setTimeout(() => {
      reconcileClaudeMd()
      if (!workers.has('channels')) spawnWorker('channels')
    }, memoryOn ? 2000 : 0)
  }
})

// ── Shutdown ────────────────────────────────────────────────────────
const isWin = process.platform === 'win32'
let shuttingDown = false
async function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutdown: ${reason}`)
  // Stop idle session sweep timer
  try {
    const { stopIdleCleanup } = await import(pathToFileURL(join(PLUGIN_ROOT, 'src/agent/orchestrator/session/manager.mjs')).href)
    stopIdleCleanup()
  } catch {}
  // Stop status HTTP server child — parent-disconnect triggers graceful
  // shutdown (advertisement file cleanup + server.close) in the child.
  // On Windows, taskkill /F is the reliable fallback.
  if (statusServerChild) {
    const pid = statusServerChild.pid
    try {
      if (isWin && pid) {
        require('child_process').execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', windowsHide: true, timeout: 3000 })
      } else {
        statusServerChild.kill('SIGTERM')
      }
    } catch {}
    // Belt-and-braces: unlink the advertisement file if child didn't.
    try { unlinkSync(STATUS_ADVERTISE_PATH) } catch {}
  }
  // Kill workers — Windows needs taskkill for reliable cleanup
  for (const [name, entry] of workers) {
    const pid = entry.proc.pid
    try {
      if (isWin && pid) {
        require('child_process').execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', windowsHide: true, timeout: 5000 })
      } else {
        entry.proc.kill('SIGTERM')
      }
      log(`shutdown: killed worker ${name} (pid=${pid})`)
    } catch {}
  }
  // Kill tracked bridge CLI processes
  try {
    const { cleanupOrphanedPids } = await import(pathToFileURL(join(PLUGIN_ROOT, 'src/shared/llm/pid-cleanup.mjs')).href)
    const killed = cleanupOrphanedPids()
    if (killed > 0) log(`shutdown: cleaned ${killed} bridge CLI processes`)
  } catch {}
  for (const mod of modules.values()) {
    if (mod.stop) await mod.stop()
  }
  process.exit(0)
}

process.stdin.on('end', () => shutdown('stdin end'))
process.stdin.on('close', () => shutdown('stdin close'))
server.onclose = () => shutdown('transport closed')
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
