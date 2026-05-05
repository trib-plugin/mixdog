#!/usr/bin/env bun
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
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, watch as fsWatch, existsSync, unlinkSync, openSync, closeSync } from 'fs'
import { join, resolve as pathResolve } from 'path'
import { homedir } from 'os'
import { pathToFileURL } from 'url'
import { createRequire } from 'module'
import { resolvePluginData } from './src/shared/plugin-paths.mjs'
import { ensureDataSeeds } from './src/shared/seed.mjs'
import { readSection } from './src/shared/config.mjs'
import { resolveDefaultUserCwd as _resolveDefaultUserCwd, captureOriginalUserCwd, pwd } from './src/shared/user-cwd.mjs'

// ── Environment ──────────────────────────────────────────────────────
// Claude Code normally injects CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA
// for relative-path plugin sources. For URL-based sources it may skip
// injection, so fall back to process.cwd() and the standard data path.
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || process.cwd()
const PLUGIN_DATA = resolvePluginData()
mkdirSync(PLUGIN_DATA, { recursive: true })
captureOriginalUserCwd() // seed single-source-of-truth cwd before any tool dispatch
process.stderr.write(`[boot-time] tag=server-entry tMs=${Date.now()}\n`)
try { ensureDataSeeds(PLUGIN_DATA) } catch {}

// Singleton lock + lock-release exit handlers are owned by the prelude
// in server.mjs. server-main.mjs assumes the lock is already held.

globalThis.__tribFastEntry = true

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
// Gate host_input on MIXDOG_ALLOW_HOST_INPUT env-var or
// modules.host_input.enabled config flag. Default: off.
const _hostInputAllowed = (() => {
  if (process.env.MIXDOG_ALLOW_HOST_INPUT === '1') return true
  try {
    const raw = JSON.parse(readFileSync(join(PLUGIN_DATA, 'mixdog-config.json'), 'utf8'))
    return !!(raw?.modules?.host_input?.enabled)
  } catch { return false }
})()
const TOOL_DEFS = RAW_TOOL_DEFS.filter(t => {
  if (t.module === 'host_input') return _hostInputAllowed
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
const log = msg => {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    appendFileSync(LOG_FILE, line)
  } catch (e) {
    process.stderr.write(`[log-fallback] ${line}`)
  }
}

// ── Crash handlers ──────────────────────────────────────────────────
// Leave a trace on silent hangs. Previously only child workers
// (channels/memory) installed these; the main MCP entry had none, so
// unhandled errors died without writing a stack.
//
// Soft net policy (0.1.73): we deliberately do NOT call process.exit()
// from uncaughtException / unhandledRejection. A misbehaving tool path
// (e.g. explore concatenating results past V8 max-string-length on a
// very broad cwd) used to take the whole MCP server down; now it logs
// a stack and the process keeps serving. Real fatal conditions still
// bubble out via SIGTERM/SIGINT or the explicit shutdown() path.
const CRASH_FILE = join(PLUGIN_DATA, 'crash.log')
const logCrash = (kind, err) => {
  const stack = err?.stack || String(err)
  try { appendFileSync(CRASH_FILE, `[${new Date().toISOString()}] ${kind}\n${stack}\n\n`) } catch {}
  try { log(`${kind}: ${err?.message || err}`) } catch {}
}

// Fatal classification for uncaughtException. Soft-net (log-only) is the
// 0.1.73 default for recoverable conditions like "Invalid string length"
// from a runaway explore concat. But genuinely fatal conditions (port
// already bound, OOM, node assert violations, internal-assertion
// failures) leave the process in an unrecoverable state — staying alive
// just delays the inevitable while serving broken responses. For those,
// log the stack and exit(1) so the supervisor restarts cleanly.
const FATAL_CODES = new Set([
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'ENOMEM',
  'ERR_INTERNAL_ASSERTION',
])
const FATAL_NAME_PATTERNS = [
  /AssertionError/i,   // node assert violations
]
function isFatalUncaught(err) {
  if (!err) return false
  if (err.code && FATAL_CODES.has(err.code)) return true
  const name = err.name || (err.constructor && err.constructor.name) || ''
  if (FATAL_NAME_PATTERNS.some(rx => rx.test(name))) return true
  return false
}
process.on('uncaughtException', (err) => {
  logCrash('uncaughtException', err)
  if (isFatalUncaught(err)) {
    try { log(`uncaughtException classified fatal (code=${err?.code} name=${err?.name}); exiting`) } catch {}
    process.exit(1)
  }
})
process.on('unhandledRejection', (reason) => { logCrash('unhandledRejection', reason) })

// ── Bridge orphan cleanup ───────────────────────────────────────────
// Non-blocking: cleanup of stale state from a previous server PID.
// Awaiting these used to gate the boot path (memory worker spawn, agent
// eager init) behind disk + module-load work that has no semantic
// dependency on the rest of boot. Fire-and-forget so the critical path
// proceeds; failures stay logged.
import(pathToFileURL(join(PLUGIN_ROOT, 'src/shared/llm/pid-cleanup.mjs')).href)
  .then(({ cleanupOrphanedPids }) => {
    const killed = cleanupOrphanedPids()
    if (killed > 0) log(`[bridge-cleanup] cleaned ${killed} orphaned processes`)
  })
  .catch(e => log(`[bridge-cleanup] failed: ${e && (e.stack || e.message) || e}`))

// ── Session cleanup: bridge sessions from previous MCP process ─────
// Non-blocking, same rationale as bridge-cleanup above.
import(pathToFileURL(join(PLUGIN_ROOT, 'src/agent/orchestrator/session/manager.mjs')).href)
  .then(({ listSessions, closeSession, startIdleCleanup }) => {
    const sessions = listSessions()
    let closed = 0
    for (const s of sessions) {
      if (s.owner === 'bridge' && (!s.mcpPid || s.mcpPid !== process.pid)) { closeSession(s.id); closed++ }
    }
    log(`[session-cleanup] closed ${closed} stale bridge sessions (pid≠${process.pid}), ${sessions.length - closed} remaining`)
    startIdleCleanup()
    log(`[session-cleanup] idle sweep timer started (interval=5m)`)
  })
  .catch(e => log(`[session-cleanup] failed: ${e && (e.stack || e.message) || e}`))

// ── MCP server ──────────────────────────────────────────────────────
const SERVER_INSTRUCTIONS = [
  `mixdog MCP server v${PLUGIN_VERSION}.`,
  '',
  'Agents: delegate via `bridge` with a `role` argument (roles defined in `user-workflow.json`; active set injected as the `# Roles` rule). `Agent` / `TaskCreate` / `TeamCreate` are NOT used — `bridge` is the single entry point.',
  '',
  'Retrieval (HIGHEST PRIORITY): `recall` (past) → `search` (web) → `find_symbol` / `grep` / `read` when path/symbol/regex is known → `explore` (codebase, `cwd` authoritative) only for unknown coordinates. Order is mandatory. `bash` is shell-only (git, build, test, run); using it for file/code lookup is a violation — use `read` / `glob` / `list` / `grep` / `find_symbol`.',
  '',
  'Channels: schedule / webhook / queue / proactive events arrive in the Lead session via the built-in channel mechanism, each with its own event-class marker.',
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
const workerIntentionalStop = new Set() // names where parent initiated shutdown; suppress respawn

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
  process.stderr.write(`[boot-time] tag=worker-spawn name=${name} tMs=${Date.now()}\n`)
  const modulePath = join(PLUGIN_ROOT, 'src', name, 'index.mjs')
  // Per-worker stderr file so cycle1/cycle2/embed/recap diagnostics are
  // captured even when the worker hangs before answering an IPC call.
  // mcp-debug.log only carries parent log() output; without this the worker
  // is invisible during a hang.
  const stderrPath = join(PLUGIN_DATA, `${name}-worker.log`)
  let stderrFd = null
  try { stderrFd = openSync(stderrPath, 'a') } catch {}
  const proc = fork(modulePath, [], {
    stdio: ['ignore', 'inherit', stderrFd ?? 'inherit', 'ipc'],
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_PLUGIN_DATA: PLUGIN_DATA,
      MIXDOG_WORKER_MODE: '1',
    },
    windowsHide: true,
  })
  if (stderrFd != null) {
    proc.once('exit', () => { try { closeSync(stderrFd) } catch {} })
  }

  const entry = { proc, ready: false, pending: [] }
  // readyPromise lets callWorker await the worker's first 'ready' IPC instead
  // of rejecting immediately on entry.ready===false. Pre-ready callers (e.g.
  // SessionStart /cycle1) used to bounce off a 503 and rely on the hook's
  // 200ms retry loop; now they hold a single in-flight call until the worker
  // signals ready or the proc exits before that.
  entry.readyPromise = new Promise((resolve, reject) => {
    entry._resolveReady = resolve
    entry._rejectReady = reject
  })
  workers.set(name, entry)

  proc.on('message', msg => {
    if (msg.type === 'ready') {
      process.stderr.write(`[boot-time] tag=worker-ready name=${name} tMs=${Date.now()}\n`)
      if (msg.degraded) {
        log(`worker ${name} signalled degraded on boot: ${msg.error || 'unknown'}`)
        // Treat init failures as permanent (no retries): init errors indicate
        // unrecoverable state (e.g. pgdata corruption, missing schema) that
        // will not heal across restarts. Mark restart count at cap immediately
        // so the 'exit' handler skips respawn. This avoids 3 pointless retries
        // that each take several seconds and leave pgdata in a worse state.
        // Transient network / port-bind errors are expected to NOT send
        // degraded:true — they crash the worker without a 'ready' signal, so
        // the normal restart counter handles them.
        workerRestarts.set(name, WORKER_MAX_RESTARTS + 1)  // permanent — no retry
        try { entry._rejectReady(new Error(`worker ${name} degraded: ${msg.error || 'init failed'}`)) } catch {}
        return
      }
      entry.ready = true
      workerIntentionalStop.delete(name)
      try { entry._resolveReady() } catch {}
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
    if (msg.type === 'recap_status' && msg.recap) {
      recapStatusState = sanitizeRecapStatusState(msg.recap)
      forwardRecapStatusToStatusServer()
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
    if (msg.type === 'memory_call_request' && msg.callId) {
      // Worker → parent → memory worker bridge. Lets non-memory workers
      // (e.g. channels) trigger memory tool actions like cycle1 without
      // owning the memory worker handle directly.
      // Worker handleToolCall only knows mcp tool names ('memory',
      // 'search_memories'); the action ('cycle1', 'flush', ...) lives in
      // args.action. Forwarding msg.action as the tool name made every
      // /cycle1 hit return "unknown tool: cycle1" instantly.
      void callWorker('memory', 'memory', { action: msg.action, ...(msg.args || {}) })
        .then(result => {
          try { proc.send({ type: 'memory_call_response', callId: msg.callId, ok: true, result }) } catch {}
        })
        .catch(err => {
          try { proc.send({ type: 'memory_call_response', callId: msg.callId, ok: false, error: err?.message || String(err) }) } catch {}
        })
      return
    }
  })

  // Attach 'exit' before 'error' so a synchronous spawn-fail sees 'exit'
  // before 'error' — prevents dangling exit handler on early-fail path.
  proc.on('exit', (code) => {
    log(`worker ${name} exited (code=${code})`)
    workers.delete(name)
    // Intentional stop: parent sent shutdown IPC/SIGTERM — do not respawn.
    if (workerIntentionalStop.has(name)) {
      log(`worker ${name} stopped intentionally — skipping respawn`)
      return
    }
    if (!entry.ready) {
      try { entry._rejectReady(new Error(`worker ${name} exited before ready (code=${code})`)) } catch {}
    }
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
// Window for awaiting a missing worker entry. Covers the 1s exit→spawn
// timer plus typical memory boot (~2-3s). Long enough that the entry
// reappears under normal restart flow, short enough that a permanently
// dead worker still surfaces within bounds.
const WORKER_NO_ENTRY_GRACE_MS = 8000

async function callWorker(name, toolName, args) {
  let entry = workers.get(name)
  // worker-unavailable: only restart-cap-exceeded and ipc-gone cases reject
  // synchronously. The pre-ready and mid-restart cases hold under bounded
  // waits so callers (e.g. SessionStart /cycle1) stop bouncing 503 across
  // the exit→spawn gap. exit-before-ready rejects readyPromise, which
  // surfaces here as a normal throw with the original 'exited before ready'
  // message preserved.
  if (!entry) {
    if ((workerRestarts.get(name) || 0) > WORKER_MAX_RESTARTS) {
      throw new Error(`worker ${name} not available (restart cap exceeded)`)
    }
    const deadline = Date.now() + WORKER_NO_ENTRY_GRACE_MS
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100))
      entry = workers.get(name)
      if (entry) break
      if ((workerRestarts.get(name) || 0) > WORKER_MAX_RESTARTS) {
        throw new Error(`worker ${name} not available (restart cap exceeded)`)
      }
    }
    if (!entry) {
      throw new Error(`worker ${name} not available (no entry after ${WORKER_NO_ENTRY_GRACE_MS}ms)`)
    }
  }
  if (!entry.proc.connected) {
    throw new Error(`worker ${name} not available (ipc disconnected)`)
  }
  if (!entry.ready) {
    await entry.readyPromise
    if (!entry.proc.connected) {
      throw new Error(`worker ${name} not available (ipc disconnected)`)
    }
  }
  return new Promise((resolve, reject) => {
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

// Tilde expansion for caller-supplied `cwd`. Mirrors the `~` branch of
// normalizeInputPath() in builtin.mjs but kept inline so the dispatcher
// does not have to pre-load the whole builtin module at boot.
function _expandCwdTilde(p) {
  if (typeof p !== 'string') return p
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return homedir() + p.slice(1)
  return p
}

// Shared dispatcher — used by the MCP call handler AND the agent's
// toolExecutor passed through agentContext(). Single source of tool routing.
async function dispatchTool(name, args, callerCtx = {}) {
  // Normalise caller-supplied `cwd` once at the entry so every downstream
  // module (builtin / lsp / code_graph / patch / bash_session /
  // host_input / agent) receives the expanded path. Previously only the
  // agent ingresses (create_session / bridge / bridge_spawn) ran tilde
  // expansion, so explore / list / grep / glob with a `~` cwd silently
  // fell back to process.cwd().
  if (args && typeof args.cwd === 'string') args.cwd = _expandCwdTilde(args.cwd)
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
      callerCwd: callerCtx.callerCwd,
      // Push merged answer into the Lead session when a dispatch
      // (wait:false) completes, so Lead integrates the result on its next
      // turn via a channel notification (no polling tool exposed).
      notifyFn: pushChannelNotification,
    })
  }

  if (def.module === 'builtin') {
    // Plugin builtin file tools exposed to external MCP clients (e.g. the
    // Lead / Claude Code harness). Write semantics live inside executeBuiltinTool.
    const { executeBuiltinTool } = await import(
      pathToFileURL(join(PLUGIN_ROOT, 'src/agent/orchestrator/tools/builtin.mjs')).href,
    )
    const effectiveCwd = (typeof args?.cwd === 'string' && args.cwd) ? args.cwd : (callerCtx.callerCwd || pwd())
    const text = await executeBuiltinTool(name, args ?? {}, effectiveCwd)
    return { content: [{ type: 'text', text: String(text) }] }
  }

  if (def.module === 'lsp') {
    // LSP-backed symbol tools. One shared typescript-language-server
    // child is spawned on first call and torn down after 90s idle; see
    // src/agent/orchestrator/tools/lsp.mjs for the state machine.
    const { executeLspTool } = await import(
      pathToFileURL(join(PLUGIN_ROOT, 'src/agent/orchestrator/tools/lsp.mjs')).href,
    )
    const text = await executeLspTool(name, args ?? {}, callerCtx.callerCwd || pwd())
    return { content: [{ type: 'text', text: String(text) }] }
  }

  if (def.module === 'code_graph') {
    const { executeCodeGraphTool } = await import(
      pathToFileURL(join(PLUGIN_ROOT, 'src/agent/orchestrator/tools/code-graph.mjs')).href,
    )
    let resolvedName = name
    const resolvedArgs = args ?? {}
    if (name === 'find_symbol' && resolvedArgs.mode && resolvedArgs.mode !== 'symbol') {
      const m = resolvedArgs.mode
      if (m === 'callers') resolvedName = 'find_callers'
      else if (m === 'references') resolvedName = 'find_references'
      else if (m === 'imports') resolvedName = 'find_imports'
      else if (m === 'dependents') resolvedName = 'find_dependents'
      else resolvedName = 'code_graph'
    }
    const text = await executeCodeGraphTool(resolvedName, resolvedArgs, callerCtx.callerCwd || pwd())
    return { content: [{ type: 'text', text: String(text) }] }
  }

  if (def.module === 'patch') {
    // Unified-diff apply tool. One-turn multi-file
    // edits without Read-before-Edit (the patch's context lines are the
    // read-proof). Mtime-guarded
    // against concurrent writes. See src/agent/orchestrator/tools/patch.mjs.
    const { executePatchTool } = await import(
      pathToFileURL(join(PLUGIN_ROOT, 'src/agent/orchestrator/tools/patch.mjs')).href,
    )
    const text = await executePatchTool(name, args ?? {}, callerCtx.callerCwd || pwd())
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
    const text = await executeBashSessionTool(name, args ?? {}, callerCtx.callerCwd || pwd())
    return { content: [{ type: 'text', text: String(text) }] }
  }

  if (def.module === 'host_input') {
    // Host-terminal input injection. Walks the parent chain from this Node
    // process, finds the first ancestor matching a supported terminal host
    // (currently powershell.exe / pwsh.exe), and replays the supplied text
    // into its console via AttachConsole + WriteConsoleInputW. Reuses the
    // proven scripts/inject-input.ps1 helper.
    // See src/agent/orchestrator/tools/host-input.mjs.
    const { executeHostInputTool } = await import(
      pathToFileURL(join(PLUGIN_ROOT, 'src/agent/orchestrator/tools/host-input.mjs')).href,
    )
    const text = await executeHostInputTool(name, args ?? {}, callerCtx.callerCwd || pwd())
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
const ALWAYS_LOAD_TOOLS = new Set([
  'read', 'bash', 'grep', 'bridge', 'edit', 'list',
  'glob', 'recall', 'find_symbol', 'explore', 'write', 'search',
])

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFS.map((t) =>
    ALWAYS_LOAD_TOOLS.has(t.name)
      ? { ...t, _meta: { ...(t._meta || {}), 'anthropic/alwaysLoad': true } }
      : t,
  ),
}))

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args } = req.params
  // `extra.signal` is an AbortSignal that fires when the MCP client cancels
  // this request (e.g. user rejects / interrupts a tool call in Claude Code).
  // Thread it down so long-running tools — specifically the async IIFE the
  // `bridge` tool spawns to run askSession — can close their session and
  // stop hitting the provider after the user bails out.
  //
  // `callerCwd` defaults to the mixdog server's own working directory so
  // tools that take a cwd fallback (notably `bridge` / `bridge_spawn`) can
  // resolve to a valid plugin path when the caller did not explicitly pass
  // one. Callers can still override with an explicit `cwd` argument.
  return dispatchTool(name, args, {
    requestSignal: extra?.signal,
    callerCwd: pwd(),
  })
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
//
// Memory worker spawn is hoisted up to here so the worker bootstrap
// (~290ms) runs in parallel with `await loadModule('agent')` (~500ms)
// instead of waiting for it to complete. The channels-spawn block
// further down handles the case where memory `ready` arrives before
// its setImmediate listener attaches.
const memoryOn = isModuleEnabled('memory')
const channelsOn = isModuleEnabled('channels')
if (memoryOn) spawnWorker('memory')
else log(`module 'memory' disabled — skipping worker spawn`)

// Search eager-load is deferred until after the channels-spawn setImmediate
// is registered so the channels worker fork lands at the head of the
// microtask FIFO. The first search call still pays cold-start cost; this
// just keeps that cost off the boot critical path.
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
      const { setInternalToolsProvider, addInternalTools, markBootReady } = internalToolsMod
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
      markBootReady()
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

// ── Spawn workers: channels (gated on memory) ───────────────────────
// Hoisted to register at the head of the setImmediate FIFO so the
// channels fork lands ahead of the rules-watcher and status-fork
// setImmediates registered later in this file. `reconcileClaudeMd`
// is a function declaration, so it's hoisted and safe to reference
// here even though its source location is below.
setImmediate(() => {
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
  const channelsWaitStart = Date.now()
  if (memEntry) {
    // Fast-path: with the memory spawn hoisted ahead of the agent-init
    // await, the worker may already be ready by the time this
    // setImmediate runs. Without this branch the message listener
    // attaches too late and the 10s safety timeout becomes the
    // channels-spawn floor.
    //
    // Race guard: between `ready` and this setImmediate firing, the
    // memory worker could die (proc exit handler at L437 deletes from
    // `workers`). Confirm the entry is still the live owner of the
    // memory slot AND the IPC channel is still connected before
    // skipping the listener attach.
    if (
      memEntry.ready &&
      memEntry.proc?.connected &&
      workers.get('memory') === memEntry
    ) {
      reconcileClaudeMd()
      if (!workers.has('channels')) {
        log(`[server] channels spawn reason=memory-already-ready wait=${Date.now()-channelsWaitStart}ms`)
        spawnWorker('channels')
      }
      return
    }
    const onReady = (msg) => {
      if (msg.type === 'ready') {
        reconcileClaudeMd()
        if (!workers.has('channels')) {
          log(`[server] channels spawn reason=memory-ready wait=${Date.now()-channelsWaitStart}ms`)
          spawnWorker('channels')
        }
        memEntry.proc.removeListener('message', onReady)
      }
    }
    memEntry.proc.on('message', onReady)
    // Safety: proceed anyway after 10s if ready never arrives
    setTimeout(() => {
      if (!workers.has('channels')) {
        reconcileClaudeMd()
        log(`[server] channels spawn reason=memory-ready-timeout wait=${Date.now()-channelsWaitStart}ms`)
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

// ── Deferred: search eager-load + dispatch recovery ────────────────
// Both are fire-and-forget after channels-spawn is enqueued so they
// don't sit on the boot critical path. Search eager-load only avoids
// the first-call JIT cost; dispatch recovery emits Aborted
// notifications for orphaned handles from a prior process death.
if (isModuleEnabled('search')) {
  setImmediate(() => {
    loadModule('search').catch(e => log(`eager search init failed: ${e.message}`))
  })
} else {
  log(`module 'search' disabled — skipping eager init`)
}

setImmediate(() => {
  import('./src/agent/orchestrator/dispatch-persist.mjs')
    .then(({ recoverPending }) => {
      const recovered = recoverPending(PLUGIN_DATA, pushChannelNotification)
      if (recovered > 0) log(`dispatch-recovery: emitted ${recovered} Aborted notifications`)
    })
    .catch((err) => {
      log(`dispatch-recovery failed: ${err instanceof Error ? err.message : String(err)}`)
    })
})

// ── CLAUDE.md managed block reconciliation ─────────────────────────
// Writes static rules into the managed block. Session recap is NOT
// written here — the SessionStart hook injects it live from PGlite.
// Fail-soft: any error is logged and swallowed.
//
//   mode === 'claude_md'  → upsert the managed block (strong enforcement)
//   mode === 'hook' (default or missing) → remove any stale managed block
function reconcileClaudeMd() {
  try {
    const mainConfig = readSection('channels')
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
    const mainConfig = readSection('channels')
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
      'mixdog-config.json', 'user-workflow.json', 'user-workflow.md',
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
let statusServerRestartTimer = null
let recapStatusState = { state: 'idle', running: false, startedAt: null, lastCompletedAt: null, updatedAt: null, errorMessage: null }

// Single-flight guard for spawnStatusServer. The child can fire both
// `error` and `exit` for one death; without this guard each handler would
// queue its own 1s restart timer, producing duplicate/zombie children.
// A live child or a pending restart timer blocks any second spawn.
function scheduleStatusServerRestart() {
  if (statusServerChild) return
  if (statusServerRestartTimer) return
  statusServerRestartTimer = setTimeout(() => {
    statusServerRestartTimer = null
    spawnStatusServer()
  }, 1000)
  statusServerRestartTimer.unref?.()
}

function normalizeRecapTimestamp(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function sanitizeRecapStatusState(recap = {}) {
  const validStates = new Set(['idle', 'running', 'injected', 'empty', 'error']);
  const rawState = typeof recap.state === 'string' && validStates.has(recap.state) ? recap.state : 'idle';
  return {
    state: rawState,
    running: recap.running === true,
    startedAt: normalizeRecapTimestamp(recap.startedAt),
    lastCompletedAt: normalizeRecapTimestamp(recap.lastCompletedAt),
    updatedAt: normalizeRecapTimestamp(recap.updatedAt),
    errorMessage: typeof recap.errorMessage === 'string' ? recap.errorMessage.slice(0, 200) : null,
  }
}

function forwardRecapStatusToStatusServer() {
  if (!statusServerChild || !statusServerChild.connected) return
  try {
    statusServerChild.send({ type: 'recap_status', recap: recapStatusState })
  } catch (e) {
    log(`[status-server] recap status forward failed: ${e && (e.message || e) || e}`)
  }
}

function spawnStatusServer() {
  // In-flight guard: if a child is already alive (cold caller racing the
  // restart scheduler) or a restart timer is pending, do nothing. The
  // existing child / pending timer will own the slot.
  if (statusServerChild) return
  if (statusServerRestartTimer) {
    clearTimeout(statusServerRestartTimer)
    statusServerRestartTimer = null
  }
  try {
    // Stale advert from a prior crashed child can keep the new child from
    // claiming the slot; best-effort unlink before fork.
    try { unlinkSync(STATUS_ADVERTISE_PATH) } catch {}
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
    statusServerChild.on('error', (e) => {
      log(`[status-server] child error: ${(e && (e.stack || e.message)) || e}`)
      statusServerChild = null
      try { unlinkSync(STATUS_ADVERTISE_PATH) } catch {}
      scheduleStatusServerRestart()
    })
    statusServerChild.on('exit', (code, signal) => {
      log(`[status-server] child exited code=${code} signal=${signal}`)
      statusServerChild = null
      try { unlinkSync(STATUS_ADVERTISE_PATH) } catch {}
      scheduleStatusServerRestart()
    })
    forwardRecapStatusToStatusServer()
  } catch (e) {
    log(`[status-server] failed to fork: ${(e && (e.stack || e.message)) || e}`)
    scheduleStatusServerRestart()
  }
}
setImmediate(spawnStatusServer)

// Channels worker spawn + reconcileClaudeMd + deferred search/dispatch
// recovery were hoisted above the rules-watcher / status-fork
// setImmediates so they sit at the head of the FIFO. See the block right
// after `await server.connect(...)`.

// ── Shutdown ────────────────────────────────────────────────────────
const isWin = process.platform === 'win32'
let shuttingDown = false
const WORKER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 8000  // child must be < parent (10s) to avoid race

async function gracefulKillWorker(name, entry) {
  const pid = entry.proc.pid
  workerIntentionalStop.add(name)
  // Step 1: request clean shutdown via IPC (preferred) or SIGTERM simulation.
  // On Windows, Node child_process.kill('SIGTERM') sends a real SIGTERM only
  // on newer Node; for reliability we prefer IPC message on win32.
  let shutdownRequested = false
  if (entry.proc.connected) {
    try {
      entry.proc.send({ type: 'shutdown' })
      shutdownRequested = true
      log(`shutdown: sent IPC {type:"shutdown"} to worker ${name} (pid=${pid})`)
    } catch {}
  }
  if (!shutdownRequested) {
    try {
      entry.proc.kill('SIGTERM')
      log(`shutdown: sent SIGTERM to worker ${name} (pid=${pid})`)
    } catch {}
  }
  // Step 2: wait for clean exit (process.exit fires 'exit' which deletes from workers).
  const exitP = new Promise(resolve => entry.proc.once('exit', resolve))
  const timedOut = await Promise.race([
    exitP.then(() => false),
    new Promise(resolve => setTimeout(() => resolve(true), WORKER_GRACEFUL_SHUTDOWN_TIMEOUT_MS)),
  ])
  if (!timedOut) {
    log(`shutdown: worker ${name} exited cleanly (pid=${pid}) — path=graceful`)
    return
  }
  // Step 3: timeout expired — force kill as last resort.
  log(`shutdown: worker ${name} did not exit within ${WORKER_GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms — forcing kill (pid=${pid}) path=force`)
  try {
    if (isWin && pid) {
      const { execSync: _ek } = await import('node:child_process')
      _ek(`taskkill /F /PID ${pid}`, { stdio: 'ignore', windowsHide: true, timeout: 5000 })
    } else {
      entry.proc.kill('SIGKILL')
    }
  } catch {}
}

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
        const { execSync: _execSync } = await import('node:child_process')
        _execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', windowsHide: true, timeout: 3000 })
      } else {
        statusServerChild.kill('SIGTERM')
      }
    } catch {}
    // Belt-and-braces: unlink the advertisement file if child didn't.
    try { unlinkSync(STATUS_ADVERTISE_PATH) } catch {}
  }
  // Graceful worker shutdown: IPC/SIGTERM → wait → force kill only as last resort.
  // Avoids taskkill /F /T which bypasses PGlite close and corrupts pgdata.
  for (const [name, entry] of workers) {
    await gracefulKillWorker(name, entry)
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

// Wire prelude's stdin-ended flag (set before server-main loaded).
globalThis.__mixdogShutdownFromStdin = () => shutdown('stdin end (prelude)')
if (globalThis.__mixdogStdinEnded) {
  shutdown('stdin end (prelude-early)')
}
