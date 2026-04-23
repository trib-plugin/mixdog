import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, execSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
import { loadConfig, createBackend, loadBotConfig, loadProfileConfig, DATA_DIR } from "./lib/config.mjs";
import { loadConfig as loadAgentConfig } from "../agent/orchestrator/config.mjs";
import { initProviders } from "../agent/orchestrator/providers/registry.mjs";
import { makeBridgeLlm } from "../agent/orchestrator/smart-bridge/bridge-llm.mjs";
import { Scheduler } from "./lib/scheduler.mjs";
import { startSnapshotWriter, updateSnapshotScheduler, stopSnapshotWriter, recordFetchedMessages } from "./lib/status-snapshot.mjs";
import { hasPending as dispatchHasPending } from "../agent/orchestrator/dispatch-persist.mjs";
import { setListener as setActivityBusListener } from "../agent/orchestrator/activity-bus.mjs";
import { WebhookServer } from "./lib/webhook.mjs";
import { EventPipeline } from "./lib/event-pipeline.mjs";
import { startCliWorker, stopCliWorker } from "./lib/cli-worker-host.mjs";
import {
  OutputForwarder,
  discoverSessionBoundTranscript,
  findLatestTranscriptByMtime
} from "./lib/output-forwarder.mjs";
import { controlClaudeSession } from "./lib/session-control.mjs";
import { JsonStateFile, ensureDir, removeFileIfExists, writeTextFile } from "./lib/state-file.mjs";
import {
  buildModalRequestSpec,
  PendingInteractionStore
} from "./lib/interaction-workflows.mjs";
import {
  ensureRuntimeDirs,
  makeInstanceId,
  getTurnEndPath,
  getStatusPath,
  getPermissionResultPath,
  getChannelOwnerPath,
  readActiveInstance,
  refreshActiveInstance,
  cleanupStaleRuntimeFiles,
  cleanupInstanceRuntimeFiles,
  releaseOwnedChannelLocks,
  clearActiveInstance,
  killAllPreviousServers,
  writeServerPid,
  clearServerPid,
  RUNTIME_ROOT
} from "./lib/runtime-paths.mjs";
import { PLUGIN_ROOT } from "./lib/config.mjs";
const memoryClientModulePath = pathToFileURL(path.join(PLUGIN_ROOT, "src/channels/lib/memory-client.mjs")).href;
const {
  appendEntry: memoryAppendEntry,
  ingestTranscript: memoryIngestTranscript,
} = await import(memoryClientModulePath);
const DEFAULT_PLUGIN_VERSION = "0.0.1";
function localTimestamp() {
  return (/* @__PURE__ */ new Date()).toLocaleString("sv-SE", { hour12: false });
}
function readPluginVersion() {
  try {
    const manifestPath = path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest.version || DEFAULT_PLUGIN_VERSION;
  } catch {
    return DEFAULT_PLUGIN_VERSION;
  }
}
const PLUGIN_VERSION = readPluginVersion();
let crashLogging = false;
let _channelsDegraded = false;
function isChannelsDegraded() { return _channelsDegraded; }

function logCrash(label, err) {
  if (crashLogging) return;
  crashLogging = true;
  const msg = `[${localTimestamp()}] mixdog: ${label}: ${err}
${err instanceof Error ? err.stack : ""}
`;
  try { process.stderr.write(msg); } catch {}
  try {
    const crashLog = path.join(DATA_DIR, "crash.log");
    fs.appendFileSync(crashLog, msg);
  } catch {}
  if (err instanceof Error && err.message.includes("EPIPE")) {
    _channelsDegraded = true;
    try {
      const crashLog = path.join(DATA_DIR, "crash.log");
      fs.appendFileSync(crashLog, `[${localTimestamp()}] mixdog: EPIPE detected, channels degraded (not exiting)
`);
    } catch {}
  }
  crashLogging = false;
}
process.on("unhandledRejection", (err) => logCrash("unhandled rejection", err));
process.on("uncaughtException", (err) => logCrash("uncaught exception", err));
if (process.env.MIXDOG_CHANNELS_NO_CONNECT) {
  process.exit(0);
}
const _isWorkerMode = process.env.MIXDOG_WORKER_MODE === '1'
const _bootLogEarly = path.join(
  process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "mixdog"),
  "boot.log"
);
fs.appendFileSync(_bootLogEarly, `[${localTimestamp()}] bootstrap start pid=${process.pid}
`);
const _bootLog = path.join(DATA_DIR, "boot.log");
let config = loadConfig();
let botConfig = loadBotConfig();
const backend = createBackend(config);
const INSTANCE_ID = makeInstanceId();
ensureRuntimeDirs();
if (!_isWorkerMode) {
  killAllPreviousServers();
  writeServerPid();
  cleanupStaleRuntimeFiles();
  startCliWorker();
}
const INSTRUCTIONS = "";

// ── Parent notification helper ───────────────────────────────────────
// This worker has no MCP transport of its own. All notifications flow
// through IPC to the parent (server.mjs), which owns the single connected
// MCP `Server` instance. The parent's IPC message handler translates
// `{type:'notify', method, params}` into `server.notification({method, params})`.
//
// Before v0.6.7 the worker had its own orphan `Server` instance that was
// never `connect()`ed to any transport, so `.notification()` silently
// threw 'Not connected' inside the SDK and every call was dropped by an
// outer `.catch(() => {})`. That regression is what this path replaces.
function sendNotifyToParent(method, params) {
  if (!process.send) {
    try { process.stderr.write(`mixdog channels: notify dropped (no IPC): ${method}\n`); } catch {}
    return;
  }
  try {
    process.send({ type: 'notify', method, params });
  } catch (err) {
    try { process.stderr.write(`mixdog channels: notify IPC send failed: ${err && err.message || err}\n`); } catch {}
  }
}
function resolveChannelLabel(channelsConfig, label) {
  if (!label || !channelsConfig) return label;
  const entry = channelsConfig[label];
  if (entry?.channelId) return entry.channelId;
  return label;
}
let channelBridgeActive = false;
function writeBridgeState(active) {
  try {
    const stateFile = path.join(os.tmpdir(), "mixdog", "bridge-state.json");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ active, ts: Date.now() }));
  } catch {
  }
}
function isChannelBridgeActive() {
  return channelBridgeActive;
}
let typingChannelId = null;
const pendingSetup = new PendingInteractionStore();
function startServerTyping(channelId) {
  if (typingChannelId && typingChannelId !== channelId) {
    backend.stopTyping(typingChannelId);
  }
  typingChannelId = channelId;
  backend.startTyping(channelId);
}
function stopServerTyping() {
  if (typingChannelId) {
    backend.stopTyping(typingChannelId);
    typingChannelId = null;
  }
}
const TURN_END_FILE = getTurnEndPath(INSTANCE_ID);
const TURN_END_BASENAME = path.basename(TURN_END_FILE);
const TURN_END_DIR = path.dirname(TURN_END_FILE);
let turnEndWatcher = null;
if (!_isWorkerMode) {
  removeFileIfExists(TURN_END_FILE);
  turnEndWatcher = fs.watch(TURN_END_DIR, async (_event, filename) => {
    if (filename !== TURN_END_BASENAME) return;
    try {
      const stat = fs.statSync(TURN_END_FILE);
      if (stat.size > 0) {
        stopServerTyping();
        await forwarder.forwardFinalText();
        removeFileIfExists(TURN_END_FILE);
      }
    } catch {
    }
  });
}
const STATUS_FILE = getStatusPath(INSTANCE_ID);
const statusState = new JsonStateFile(STATUS_FILE, {});
statusState.ensure();
function sessionIdFromTranscriptPath(transcriptPath) {
  const base = path.basename(transcriptPath);
  return base.endsWith(".jsonl") ? base.slice(0, -6) : "";
}
function getPersistedTranscriptPath() {
  const state = statusState.read();
  if (typeof state.transcriptPath === "string" && state.transcriptPath) return state.transcriptPath;
  return readActiveInstance()?.transcriptPath ?? "";
}
function pickUsableTranscriptPath(bound, previousPath) {
  if (bound?.exists) return bound.transcriptPath;
  if (!previousPath) return "";
  if (!bound?.sessionId) return previousPath;
  return sessionIdFromTranscriptPath(previousPath) === bound.sessionId ? previousPath : "";
}
const forwarder = new OutputForwarder({
  send: async (ch, text) => {
    if (!channelBridgeActive) return;
    await backend.sendMessage(ch, text);
  },
  recordAssistantTurn: async () => {
  },
  react: (ch, mid, emoji) => {
    if (!channelBridgeActive) return Promise.resolve();
    return backend.react(ch, mid, emoji);
  },
  removeReaction: (ch, mid, emoji) => {
    if (!channelBridgeActive) return Promise.resolve();
    return backend.removeReaction(ch, mid, emoji);
  }
}, statusState);
forwarder.setOnIdle(() => {
  stopServerTyping();
  void forwarder.forwardFinalText();
});
function applyTranscriptBinding(channelId, transcriptPath, options = {}) {
  if (!transcriptPath) return;
  forwarder.setContext(channelId, transcriptPath, { replayFromStart: options.replayFromStart });
  forwarder.startWatch();
  void memoryIngestTranscript(transcriptPath);
  refreshActiveInstance(INSTANCE_ID, { channelId, transcriptPath });
  if (options.persistStatus !== false) {
    statusState.update((state) => {
      state.channelId = channelId;
      state.transcriptPath = transcriptPath;
    });
  }
}
async function rebindTranscriptContext(channelId, options = {}) {
  const previousPath = options.previousPath ?? "";
  const mode = options.mode ?? "same";
  let sawPendingTranscript = false;
  let pendingSessionId = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const bound = discoverSessionBoundTranscript();
    if (bound?.exists) {
      const acceptable = mode === "same" || !previousPath || bound.transcriptPath !== previousPath;
      if (acceptable) {
        const replayFromStart = Boolean(
          options.catchUp && !previousPath && sawPendingTranscript && pendingSessionId === bound.sessionId
        );
        applyTranscriptBinding(channelId, bound.transcriptPath, {
          replayFromStart,
          persistStatus: options.persistStatus
        });
        if (replayFromStart) {
          await forwarder.forwardNewText();
        }
        return bound.transcriptPath;
      }
    } else if (bound?.sessionId) {
      sawPendingTranscript = true;
      pendingSessionId = bound.sessionId;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return previousPath;
}
const scheduler = new Scheduler(
  config.nonInteractive ?? [],
  config.interactive ?? [],
  config.proactive,
  config.channelsConfig,
  botConfig
);
// Register the pending-dispatch probe so the scheduler treats an in-flight
// bridge dispatch as "active" regardless of user-inbound silence.
scheduler.setPendingCheck(() => {
  try {
    return dispatchHasPending(process.env.CLAUDE_PLUGIN_DATA);
  } catch {
    return false;
  }
});
// Bridge the orchestrator-side activity notifier into the scheduler so
// events like `addPending` can bump lastActivity without importing the
// scheduler instance directly (avoids module cycles).
setActivityBusListener(() => scheduler.noteActivity());
let webhookServer = null;
if (!_isWorkerMode && config.webhook?.enabled) {
  // Construct only — start is deferred to startOwnedRuntime() so standby
  // / proxy instances do not run a second webhook listener or consume
  // the shared events queue.
  webhookServer = new WebhookServer(config.webhook, config.channelsConfig ?? null);
}
// Construct only — start deferred to startOwnedRuntime() for ownership gating.
const eventPipeline = new EventPipeline(config.events, config.channelsConfig);
const _eventPipelineShouldStart = !_isWorkerMode && (config.webhook?.enabled || !!config.events?.rules?.length);
let bridgeRuntimeConnected = false;
let bridgeOwnershipRefreshRunning = false;
let bridgeOwnershipTimer = null;
let lastOwnershipNote = "";
const ACTIVE_OWNER_STALE_MS = 1e4;
let proxyMode = false;
let ownerHttpPort = 0;
let ownerHttpServer = null;
const PROXY_PORT_MIN = 3460;
const PROXY_PORT_MAX = 3467;
async function proxyRequest(endpoint, method, body) {
  return new Promise((resolve) => {
    const url = new URL(`http://127.0.0.1:${ownerHttpPort}${endpoint}`);
    const reqOpts = {
      hostname: "127.0.0.1",
      port: ownerHttpPort,
      path: url.pathname + url.search,
      method,
      headers: { "Content-Type": "application/json" },
      timeout: 3e4
    };
    const req = http.request(reqOpts, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ ok: res.statusCode === 200, data: parsed, error: parsed.error });
        } catch {
          resolve({ ok: false, error: `invalid response from owner: ${data.slice(0, 200)}` });
        }
      });
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: `proxy request failed: ${err.message}` });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "proxy request timed out" });
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
async function pingOwner(port) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/ping",
      method: "GET",
      timeout: 3e3
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}
function tryListenPort(server, port) {
  return new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
}
async function startOwnerHttpServer() {
  if (ownerHttpServer) return ownerHttpServer.address().port;
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    let body = {};
    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
    }
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      switch (url.pathname) {
        case "/ping": {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, instanceId: INSTANCE_ID, pid: process.pid }));
          return;
        }
        case "/send": {
          // Pre-send bump: blocks proactive chat from firing during a slow
          // network / attachment / rate-limited send. Post-send bump below
          // covers completion (double bump is harmless).
          scheduler.noteActivity();
          const sendResult = await backend.sendMessage(
            body.chatId,
            body.text,
            body.opts
          );
          // Lead-originated send — bump activity so proactive chat stays
          // suppressed while the assistant is actively replying.
          scheduler.noteActivity();
          res.writeHead(200);
          res.end(JSON.stringify({ sentIds: sendResult.sentIds }));
          return;
        }
        case "/react": {
          await backend.react(
            body.chatId,
            body.messageId,
            body.emoji
          );
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        case "/edit": {
          const editId = await backend.editMessage(
            body.chatId,
            body.messageId,
            body.text,
            body.opts
          );
          res.writeHead(200);
          res.end(JSON.stringify({ id: editId }));
          return;
        }
        case "/fetch": {
          const channelId = url.searchParams.get("channel") ?? "";
          const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
          const msgs = await backend.fetchMessages(channelId, limit);
          recordFetchedMessages(channelId, labelForChannelId(channelId), msgs);
          res.writeHead(200);
          res.end(JSON.stringify({ messages: msgs }));
          return;
        }
        case "/download": {
          const files = await backend.downloadAttachment(
            body.chatId,
            body.messageId
          );
          res.writeHead(200);
          res.end(JSON.stringify({ files }));
          return;
        }
        case "/typing/start": {
          backend.startTyping(body.channelId);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        case "/typing/stop": {
          backend.stopTyping(body.channelId);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        case "/inject": {
          const content = body.content;
          if (!content) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "content required" }));
            return;
          }
          const source = body.source || "mixdog-agent";
          const injMeta = { user: source, user_id: "system", ts: (/* @__PURE__ */ new Date()).toISOString() };
          if (body.instruction) injMeta.instruction = body.instruction;
          if (body.type) injMeta.type = body.type;
          sendNotifyToParent("notifications/claude/channel", { content, meta: injMeta });
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        case "/bridge": {
          if (req.method !== "POST") { res.writeHead(405); res.end(JSON.stringify({ error: "POST required" })); return; }
          const bridgeFile = body.file;
          const bridgePrompt = body.prompt;
          const bridgeRef = body.ref;
          const bridgeRole = body.role;
          const bridgeContext = body.context;
          let bridgePromptFinal = bridgePrompt;
          if (!bridgePromptFinal && bridgeFile) {
            try { bridgePromptFinal = fs.readFileSync(bridgeFile, "utf-8").trim(); } catch (e) {
              res.writeHead(400); res.end(JSON.stringify({ error: `Cannot read file: ${e.message}` })); return;
            }
          }
          if (!bridgePromptFinal && !bridgeRef) { res.writeHead(400); res.end(JSON.stringify({ error: "prompt, file, or ref required" })); return; }
          try {
            const agentMod = await import(pathToFileURL(path.join(path.dirname(import.meta.url.replace("file:///", "").replace(/\//g, path.sep)), "..", "agent", "index.mjs")).href);
            if (agentMod.init) await agentMod.init();
            const toolArgs = {};
            if (bridgePromptFinal) toolArgs.prompt = bridgePromptFinal;
            if (bridgeRef) toolArgs.ref = bridgeRef;
            if (bridgeRole) toolArgs.role = bridgeRole;
            if (bridgeContext) toolArgs.context = bridgeContext;
            const notifyFn = (text, extraMeta) => {
              sendNotifyToParent("notifications/claude/channel", {
                content: text,
                meta: {
                  user: "mixdog-agent",
                  user_id: "system",
                  ts: new Date().toISOString(),
                  ...(extraMeta || {})
                }
              });
            };
            const result = await agentMod.handleToolCall("bridge", toolArgs, { notifyFn });
            res.writeHead(200);
            res.end(JSON.stringify(result));
          } catch (e) {
            res.writeHead(500); res.end(JSON.stringify({ error: e.message })); return;
          }
          return;
        }
        case "/bridge/activate": {
          channelBridgeActive = Boolean(body.active);
          writeBridgeState(channelBridgeActive);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, active: channelBridgeActive }));
          return;
        }
        case "/mcp": {
          if (req.method === "POST") {
            const httpMcp = createHttpMcpServer();
            const httpTransport = new StreamableHTTPServerTransport({
              sessionIdGenerator: void 0,
              enableJsonResponse: true
            });
            res.on("close", () => {
              httpTransport.close();
              void httpMcp.close();
            });
            await httpMcp.connect(httpTransport);
            await httpTransport.handleRequest(req, res, body);
          } else {
            res.writeHead(405);
            res.end(JSON.stringify({ error: "Method not allowed" }));
          }
          return;
        }
        case "/recap": {
          if (req.method !== "POST") { res.writeHead(405); res.end(JSON.stringify({ error: "POST required" })); return; }
          const recapPrompt = String(body?.prompt || "");
          if (!recapPrompt) { res.writeHead(400); res.end(JSON.stringify({ error: "prompt required" })); return; }
          try {
            const recapLlm = makeBridgeLlm({ role: "recap-agent", taskType: "maintenance" });
            const userMessage = [
              `Run recap: write a handoff note for these entries per the recap-agent spec.`,
              ``,
              recapPrompt,
            ].join('\n');
            const summary = await recapLlm({ prompt: userMessage });
            res.writeHead(200);
            res.end(JSON.stringify({ summary: String(summary || "").trim() }));
          } catch (e) {
            res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
          }
          return;
        }
        case "/rebind": {
          const channelId = statusState.read().channelId;
          if (!channelId) {
            res.writeHead(200);
            res.end(JSON.stringify({ rebound: false, reason: "no channelId" }));
            return;
          }
          const previousPath = getPersistedTranscriptPath();
          const bound = await rebindTranscriptContext(channelId, {
            previousPath,
            persistStatus: true,
            catchUp: true
          });
          const reboundChanged = Boolean(bound) && bound !== previousPath;
          res.writeHead(200);
          res.end(JSON.stringify({ rebound: reboundChanged, path: bound || null }));
          return;
        }
        default: {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: msg }));
    }
  });
  for (let port = PROXY_PORT_MIN; port <= PROXY_PORT_MAX; port++) {
    if (await tryListenPort(server, port)) {
      ownerHttpServer = server;
      process.stderr.write(`mixdog: owner HTTP server listening on 127.0.0.1:${port}
`);
      return port;
    }
    server.removeAllListeners("error");
  }
  throw new Error(`no available port in range ${PROXY_PORT_MIN}-${PROXY_PORT_MAX}`);
}
function stopOwnerHttpServer() {
  if (!ownerHttpServer) return;
  ownerHttpServer.close();
  ownerHttpServer = null;
}
function logOwnership(note) {
  if (lastOwnershipNote === note) return;
  lastOwnershipNote = note;
  process.stderr.write(`[ownership] ${note}
`);
}
function currentOwnerState() {
  const active = readActiveInstance();
  return {
    active,
    owned: active?.instanceId === INSTANCE_ID
  };
}
function getBridgeOwnershipSnapshot() {
  return currentOwnerState();
}
function canStealOwnership(active) {
  if (!active) return true;
  if (active.instanceId === INSTANCE_ID) return true;
  if (Date.now() - active.updatedAt > ACTIVE_OWNER_STALE_MS) return true;
  try {
    process.kill(active.pid, 0);
    return false;
  } catch {
    return true;
  }
}
function claimBridgeOwnership(reason) {
  refreshActiveInstance(INSTANCE_ID);
  logOwnership(`claimed owner (${reason})`);
}
function noteStartupHandoff(previous) {
  if (!previous) return;
  if (previous.instanceId === INSTANCE_ID) return;
  if (previous.pid === process.pid) return;
  logOwnership(`startup handoff from ${previous.instanceId}`);
}
async function bindPersistedTranscriptIfAny() {
  // Resolve channelId first from persisted status; fall back to the most
  // recent status-*.json snapshot, then to the configured main channel when
  // the bridge is active. No exists-gate here — once we have a channelId,
  // hand off to rebindTranscriptContext(), which owns the 30-attempt retry
  // for transcripts that are not yet on disk at boot/activate time.
  let currentStatus = statusState.read();
  if (!currentStatus.channelId) {
    try {
      const files = fs.readdirSync(RUNTIME_ROOT).filter((f) => f.startsWith("status-") && f.endsWith(".json")).map((f) => {
        const full = path.join(RUNTIME_ROOT, f);
        return { path: full, mtime: fs.statSync(full).mtimeMs };
      }).sort((a, b) => b.mtime - a.mtime);
      for (const { path: fp } of files) {
        try {
          const data = JSON.parse(fs.readFileSync(fp, "utf8"));
          if (data.channelId) {
            statusState.update((state) => {
              Object.assign(state, data);
            });
            currentStatus = statusState.read();
            process.stderr.write(`mixdog: restored status from ${fp}
`);
            break;
          }
        } catch {
        }
      }
    } catch {
    }
  }
  if (!currentStatus.channelId && channelBridgeActive) {
    const chCfg = config.channelsConfig;
    const mainLabel = config.mainChannel ?? "main";
    const mainEntry = chCfg?.[mainLabel];
    const mainId = mainEntry?.channelId;
    if (mainId) {
      statusState.update((state) => {
        state.channelId = mainId;
      });
      currentStatus = statusState.read();
      process.stderr.write(`mixdog: auto-bound to main channel ${mainId}
`);
    }
  }
  if (!currentStatus.channelId) return;
  const bound = await rebindTranscriptContext(currentStatus.channelId, {
    previousPath: getPersistedTranscriptPath(),
    persistStatus: true
  });
  if (bound) {
    process.stderr.write(`mixdog: initial transcript bind: ${bound}
`);
  }
}
async function startOwnedRuntime(options = {}) {
  if (bridgeRuntimeConnected) return;
  if (!channelBridgeActive) return;
  try {
    await backend.connect();
  } catch (e) {
    process.stderr.write(`mixdog: backend connect failed (non-fatal): ${e instanceof Error ? e.message : String(e)}
`);
    return;
  }
  bridgeRuntimeConnected = true;
  proxyMode = false;
  try {
    const agentCfg = loadAgentConfig();
    await initProviders(agentCfg.providers || {});
  } catch (e) {
    process.stderr.write(`mixdog: initProviders failed (non-fatal): ${e instanceof Error ? e.message : String(e)}
`);
  }
  scheduler.start();
  startSnapshotWriter(scheduler);
  if (webhookServer) webhookServer.start();
  if (_eventPipelineShouldStart) eventPipeline.start();
  let httpPort;
  try {
    httpPort = await startOwnerHttpServer();
  } catch (e) {
    process.stderr.write(`mixdog: HTTP server start failed (non-fatal): ${e instanceof Error ? e.message : String(e)}
`);
  }
  refreshActiveInstance(INSTANCE_ID, httpPort ? { httpPort } : void 0);
  if (options.restoreBinding !== false) void bindPersistedTranscriptIfAny();
  process.stderr.write(`mixdog: running with ${backend.name} backend
`);
  logOwnership(`active owner pid=${process.pid}`);
}
async function stopOwnedRuntime(reason) {
  if (!bridgeRuntimeConnected) return;
  stopServerTyping();
  stopOwnerHttpServer();
  scheduler.stop();
  stopSnapshotWriter();
  if (webhookServer) webhookServer.stop();
  eventPipeline.stop();
  releaseOwnedChannelLocks(INSTANCE_ID);
  clearActiveInstance(INSTANCE_ID);
  await backend.disconnect();
  bridgeRuntimeConnected = false;
  logOwnership(`standby: ${reason}`);
}
async function refreshBridgeOwnership(options = {}) {
  if (bridgeOwnershipRefreshRunning) return;
  bridgeOwnershipRefreshRunning = true;
  try {
    if (!channelBridgeActive) {
      const { active: active2 } = currentOwnerState();
      if (active2?.httpPort && !proxyMode) {
        const alive = await pingOwner(active2.httpPort);
        if (alive) {
          proxyMode = true;
          ownerHttpPort = active2.httpPort;
          logOwnership(`non-channel session \u2014 proxy mode via ${active2.instanceId}`);
        }
      }
      return;
    }
    const { active, owned } = currentOwnerState();
    if (proxyMode && !owned && active?.httpPort) {
      const alive = await pingOwner(active.httpPort);
      if (!alive) {
        process.stderr.write(`[ownership] owner ping failed, attempting takeover
`);
        proxyMode = false;
        ownerHttpPort = 0;
        claimBridgeOwnership(`owner ${active.instanceId} unreachable`);
        const next2 = currentOwnerState();
        if (next2.owned) {
          refreshActiveInstance(INSTANCE_ID);
          await startOwnedRuntime(options);
        }
        return;
      }
      return;
    }
    if (!owned && canStealOwnership(active)) {
      if (active?.httpPort) {
        const alive = await pingOwner(active.httpPort);
        if (alive) {
          proxyMode = true;
          ownerHttpPort = active.httpPort;
          logOwnership(`proxy mode via owner ${active.instanceId} port ${active.httpPort}`);
          return;
        }
      }
      claimBridgeOwnership(active ? `takeover from ${active.instanceId}` : "startup");
    }
    const next = currentOwnerState();
    if (next.owned) {
      refreshActiveInstance(INSTANCE_ID);
      await startOwnedRuntime(options);
      return;
    }
    if (bridgeRuntimeConnected) {
      const reason = next.active?.instanceId ? `newer server ${next.active.instanceId}` : "no active owner";
      await stopOwnedRuntime(reason);
      return;
    }
    if (next.active?.httpPort && !proxyMode) {
      const alive = await pingOwner(next.active.httpPort);
      if (alive) {
        proxyMode = true;
        ownerHttpPort = next.active.httpPort;
        logOwnership(`proxy mode via owner ${next.active.instanceId} port ${next.active.httpPort}`);
        return;
      }
    }
    if (next.active?.instanceId) {
      logOwnership(`standby under owner ${next.active.instanceId}`);
    }
  } finally {
    bridgeOwnershipRefreshRunning = false;
  }
}
function reloadRuntimeConfig() {
  config = loadConfig();
  botConfig = loadBotConfig();
  scheduler.reloadConfig(
    config.nonInteractive ?? [],
    config.interactive ?? [],
    config.proactive,
    config.channelsConfig,
    botConfig,
    { restart: bridgeRuntimeConnected }
  );
  if (config.webhook?.enabled) {
    if (webhookServer) {
      webhookServer.reloadConfig(config.webhook, config.channelsConfig ?? null, {
        autoStart: bridgeRuntimeConnected
      });
    } else {
      webhookServer = new WebhookServer(config.webhook, config.channelsConfig ?? null);
      wireWebhookHandlers();
      if (bridgeRuntimeConnected) webhookServer.start();
    }
  } else if (webhookServer) {
    webhookServer.stop();
    webhookServer = null;
  }
  eventPipeline.reloadConfig(config.events, config.channelsConfig);
}
function injectAndRecord(channelId, name, content, options) {
  const ts = new Date().toISOString();
  const now = new Date();
  const timeLabel = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} `;
  const sourceLabel = options?.type ? `${timeLabel}: ${options.type}` : timeLabel;
  const meta = { chat_id: channelId, user: sourceLabel, user_id: "system", ts };
  if (options?.instruction) meta.instruction = options.instruction;
  if (options?.type) meta.type = options.type;
  // `silent_to_agent` — lifecycle status pings (worker/iter/started echoes)
  // surface on Discord but should NOT land in Lead's context window. When
  // set, skip the parent-notify hop but keep the Discord-forward + event-log
  // record. The meta flag is also propagated downstream so consumers that
  // still see the notification (e.g. Lead itself if emission changes later)
  // can recognise and drop it. Default is false → legacy behaviour preserved.
  if (options?.silent_to_agent) meta.silent_to_agent = true;
  const silent = options?.silent_to_agent === true;
  if (!silent) {
    sendNotifyToParent("notifications/claude/channel", { content, meta });
  } else {
    forwardLifecycleToDiscord(channelId, content);
  }
}

// Best-effort direct Discord emission for silent-to-agent lifecycle pings.
// Only used when the parent-notify hop is skipped, so the user still sees
// the status on Discord even though Lead will never echo it through the
// transcript-tail forwarder. Falls back to a no-op when no channel is
// resolvable — lifecycle pings are non-critical.
function forwardLifecycleToDiscord(channelId, content) {
  try {
    const target = channelId || statusState?.read?.().channelId || null;
    if (!target || !backend?.sendMessage) return;
    void backend.sendMessage(target, content).catch(() => {});
  } catch { /* best-effort */ }
}
scheduler.setInjectHandler((channelId, name, content, options) => {
  injectAndRecord(channelId, name, content, options);
});
scheduler.setSendHandler(async (channelId, text) => {
  await backend.sendMessage(channelId, text);
});
function wireWebhookHandlers() {
  if (!webhookServer) return;
  webhookServer.setEventPipeline(eventPipeline);
}
wireWebhookHandlers();
const eventQueue = eventPipeline.getQueue();
eventQueue.setInjectHandler((channelId, name, content, options) => {
  injectAndRecord(channelId, name, content, options);
});
eventQueue.setSendHandler(async (channelId, text) => {
  await backend.sendMessage(channelId, text);
});
eventQueue.setSessionStateGetter(() => scheduler.getSessionState());
// Defensive ownership probe: the queue tick should only run in the active
// owner process. Standby / proxy instances see bridgeRuntimeConnected=false
// or proxyMode=true and will skip the tick even if an errant start() slipped
// through.
eventQueue.setOwnerGetter(() => bridgeRuntimeConnected && !proxyMode);
function editDiscordMessage(channelId, messageId, label) {
  const token = config.discord?.token;
  if (!token) return;
  const body = JSON.stringify({
    content: `\u{1F510} **Permission Request** \u2014 ${label}`,
    components: []
  });
  const req = https.request({
    hostname: "discord.com",
    path: `/api/v10/channels/${channelId}/messages/${messageId}`,
    method: "PATCH",
    headers: {
      "Authorization": `Bot ${token}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    }
  }, (res) => {
    res.resume();
    res.on("end", () => {
    });
  });
  req.on("error", (err) => {
    process.stderr.write(`mixdog: editDiscordMessage failed: ${err}
`);
  });
  req.write(body);
  req.end();
}
backend.onModalRequest = async (rawInteraction) => {
  if (!bridgeRuntimeConnected || !getBridgeOwnershipSnapshot().owned) {
    void refreshBridgeOwnership();
    return;
  }
  const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = await import("discord.js");
  const customId = rawInteraction.customId;
  const channelId = rawInteraction.channelId ?? "";
  pendingSetup.rememberMessage(rawInteraction.user.id, channelId, rawInteraction.message?.id);
  const modalSpec = buildModalRequestSpec(
    customId,
    pendingSetup.get(rawInteraction.user.id, channelId),
    loadProfileConfig()
  );
  if (!modalSpec) return;
  const modal = new ModalBuilder().setCustomId(modalSpec.customId).setTitle(modalSpec.title);
  const rows = modalSpec.fields.map(
    (field) => new ActionRowBuilder().addComponents((() => {
      const input = new TextInputBuilder().setCustomId(field.id).setLabel(field.label).setStyle(TextInputStyle.Short).setRequired(field.required);
      if (field.value) input.setValue(field.value);
      return input;
    })())
  );
  modal.addComponents(...rows);
  await rawInteraction.showModal(modal);
};
const pendingPermRequests = new Map();
// Watch for terminal-approved tool executions. The PostToolUse hook writes a
// signal file per tool call; when we see one, find the oldest pending perm
// request with a matching tool name and mark its Discord message as
// "Allowed (terminal)" so users don't see stale active buttons.
try {
  try { if (!fs.existsSync(RUNTIME_ROOT)) fs.mkdirSync(RUNTIME_ROOT, { recursive: true }); } catch {}
  const SIGNAL_RE = /^tool-exec-\d+-[0-9a-f]+\.signal$/;
  fs.watch(RUNTIME_ROOT, { persistent: false }, (eventType, filename) => {
    if (!filename || !SIGNAL_RE.test(filename)) return;
    setTimeout(() => {
      try {
        const signalPath = path.join(RUNTIME_ROOT, filename);
        let raw;
        try { raw = fs.readFileSync(signalPath, 'utf8'); } catch { return; }
        let payload;
        try { payload = JSON.parse(raw); } catch { return; }
        const toolName = payload?.toolName;
        if (!toolName) return;
        const sigFilePath = payload?.filePath || '';
        let oldestKey = null;
        let oldestEntry = null;
        for (const [k, v] of pendingPermRequests) {
          if (v.toolName !== toolName) continue;
          // Bind on filePath too. If both sides are empty (non-file tools
          // like Bash), toolName alone is the match. Otherwise both must
          // equal — prevents two concurrent Edit/Write requests from
          // cross-approving each other.
          const vFilePath = v.filePath || '';
          if (vFilePath || sigFilePath) {
            if (vFilePath !== sigFilePath) continue;
          }
          if (!oldestEntry || v.createdAt < oldestEntry.createdAt) {
            oldestKey = k;
            oldestEntry = v;
          }
        }
        // No matching pending request — leave the signal on disk so a
        // sub-agent hook (or other consumer) gets a chance to claim it.
        if (!oldestKey || !oldestEntry) return;
        if (oldestEntry.channelId && oldestEntry.messageId) {
          try {
            editDiscordMessage(oldestEntry.channelId, oldestEntry.messageId, 'Allowed (terminal)');
          } catch (err) {
            try { process.stderr.write(`mixdog channels: tool-exec signal edit failed: ${err && err.message || err}\n`); } catch {}
          }
        }
        pendingPermRequests.delete(oldestKey);
        // Only unlink once we've confirmed the match and handled it.
        try { fs.unlinkSync(signalPath); } catch {}
      } catch (err) {
        try { process.stderr.write(`mixdog channels: tool-exec signal handler error: ${err && err.message || err}\n`); } catch {}
      }
    }, 50);
  });
  // Stale-signal sweeper: any signal file older than 60s is removed so
  // unclaimed files don't accumulate on disk. Runs every 30s.
  setInterval(() => {
    try {
      const now = Date.now();
      const entries = fs.readdirSync(RUNTIME_ROOT);
      for (const name of entries) {
        if (!SIGNAL_RE.test(name)) continue;
        const p = path.join(RUNTIME_ROOT, name);
        try {
          const st = fs.statSync(p);
          if (now - st.mtimeMs > 60_000) {
            try { fs.unlinkSync(p); } catch {}
          }
        } catch {}
      }
    } catch {}
  }, 30_000).unref?.();
} catch (err) {
  try { process.stderr.write(`mixdog channels: tool-exec signal watcher setup failed: ${err && err.message || err}\n`); } catch {}
}

backend.onInteraction = (interaction) => {
  // Channel-route permission reply. Custom_id format: perm-ch-{request_id}-{allow|session|deny}.
  // request_id is the 5-letter short ID CC generates via shortRequestId().
  // Emit notifications/claude/channel/permission back to Claude Code; the race
  // logic in interactiveHandler.ts resolves the pending request and dismisses
  // every other racer (local dialog, bridge, hook, classifier).
  if (interaction.customId?.startsWith("perm-ch-")) {
    const match = interaction.customId.match(/^perm-ch-([a-km-z]{5})-(allow|session|deny)$/);
    if (!match) return;
    const [, requestId, action] = match;
    const access = config.access;
    if (access?.allowFrom?.length > 0 && !access.allowFrom.includes(interaction.userId)) {
      process.stderr.write(`mixdog: perm-ch button rejected — user ${interaction.userId} not in allowFrom\n`);
      return;
    }
    const pending = pendingPermRequests.get(requestId);
    pendingPermRequests.delete(requestId);
    const params = { request_id: requestId };
    if (action === 'deny') {
      params.behavior = 'deny';
    } else if (action === 'session') {
      params.behavior = 'allow';
      const toolName = pending?.toolName;
      if (toolName) {
        params.updatedPermissions = [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }];
      }
    } else {
      params.behavior = 'allow';
    }
    sendNotifyToParent('notifications/claude/channel/permission', params);
    const labels = { allow: 'Approved', session: 'Session Approved', deny: 'Denied' };
    if (interaction.message?.id && interaction.channelId) {
      editDiscordMessage(interaction.channelId, interaction.message.id, labels[action] || action);
    }
    return;
  }
  if (interaction.customId?.startsWith("perm-")) {
    const match = interaction.customId.match(/^perm-([0-9a-f]{32})-(allow|session|deny)$/);
    if (!match) return;
    const [, uuid, action] = match;
    const access = config.access;
    if (!access) {
      fs.appendFileSync(_bootLog, `[${localTimestamp()}] perm interaction dropped: no access config
`);
      return;
    }
    if (access.allowFrom?.length > 0 && !access.allowFrom.includes(interaction.userId)) {
      process.stderr.write(`mixdog: perm button rejected \u2014 user ${interaction.userId} not in allowFrom
`);
      return;
    }
    const resultPath = getPermissionResultPath(INSTANCE_ID, uuid);
    if (!fs.existsSync(resultPath)) {
      fs.writeFileSync(resultPath, action);
    }
    const labels = { allow: "Approved", session: "Session Approved", deny: "Denied" };
    if (interaction.message?.id && interaction.channelId) {
      editDiscordMessage(interaction.channelId, interaction.message.id, labels[action] || action);
    }
    return;
  }
  if (!bridgeRuntimeConnected || !getBridgeOwnershipSnapshot().owned) {
    void refreshBridgeOwnership();
    return;
  }
  scheduler.noteActivity();
  if (interaction.customId === "stop_task") {
    void controlClaudeSession(INSTANCE_ID, { type: "interrupt" });
    writeTextFile(TURN_END_FILE, String(Date.now()));
    return;
  }
  sendNotifyToParent("notifications/claude/channel", {
    content: `[interaction] ${interaction.type}: ${interaction.customId}${interaction.values ? " values=" + interaction.values.join(",") : ""}`,
    meta: {
      chat_id: interaction.channelId,
      user: `interaction:${interaction.type}`,
      user_id: interaction.userId,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      interaction_type: interaction.type,
      custom_id: interaction.customId,
      ...interaction.values ? { values: interaction.values.join(",") } : {},
      ...interaction.message ? { message_id: interaction.message.id } : {}
    }
  });
};
function isVoiceAttachment(contentType) {
  return contentType.startsWith("audio/") || contentType === "application/ogg";
}
function runCmd(cmd, args, capture = false) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore"
    });
    let out = "";
    if (capture && proc.stdout) proc.stdout.on("data", (d) => {
      out += d;
    });
    proc.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}`)));
    proc.on("error", reject);
  });
}
let resolvedWhisperCmd = null;
let resolvedWhisperModel = null;
let resolvedWhisperLanguage = null;
let resolvedWhisperType = null;
const whichCmd = process.platform === "win32" ? "where" : "which";
function firstNonEmptyLine(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}
function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}
function normalizeWhisperLanguage(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "auto") return null;
  if (raw.startsWith("ko")) return "ko";
  if (raw.startsWith("ja")) return "ja";
  if (raw.startsWith("en")) return "en";
  if (raw.startsWith("zh")) return "zh";
  if (raw.startsWith("de")) return "de";
  if (raw.startsWith("fr")) return "fr";
  if (raw.startsWith("es")) return "es";
  if (raw.startsWith("it")) return "it";
  if (raw.startsWith("pt")) return "pt";
  if (raw.startsWith("ru")) return "ru";
  return raw;
}
function detectDeviceLanguage() {
  if (resolvedWhisperLanguage) return resolvedWhisperLanguage;
  const candidates = [
    process.env.MIXDOG_CHANNELS_WHISPER_LANGUAGE,
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
    Intl.DateTimeFormat().resolvedOptions().locale
  ];
  for (const candidate of candidates) {
    const normalized = normalizeWhisperLanguage(candidate);
    if (normalized) {
      resolvedWhisperLanguage = normalized;
      return normalized;
    }
  }
  resolvedWhisperLanguage = "auto";
  return resolvedWhisperLanguage;
}
async function resolveCommandPath(command) {
  const out = await runCmd(whichCmd, [command], true);
  const resolved = firstNonEmptyLine(out);
  if (!resolved) {
    throw new Error(`command not found: ${command}`);
  }
  return resolved;
}
async function detectWhisperType(cmd) {
  if (resolvedWhisperType) return resolvedWhisperType;
  try {
    const out = await runCmd(cmd, ["--help"], true);
    resolvedWhisperType = out.includes("openai") || out.includes("output_format") || out.includes("output_dir") ? "python" : "cpp";
  } catch {
    const lower = cmd.toLowerCase();
    resolvedWhisperType = lower.includes("python") || lower.includes("scripts") ? "python" : "cpp";
  }
  return resolvedWhisperType;
}
async function findWhisper(override) {
  if (override) {
    if (override.includes(path.sep) || override.includes("/")) {
      if (!fileExists(override)) {
        throw new Error(`configured whisper command not found: ${override}`);
      }
      return override;
    }
    return resolveCommandPath(override);
  }
  if (resolvedWhisperCmd && fileExists(resolvedWhisperCmd)) return resolvedWhisperCmd;
  for (const candidate of ["whisper-cli", "whisper", "whisper.cpp"]) {
    try {
      resolvedWhisperCmd = await resolveCommandPath(candidate);
      return resolvedWhisperCmd;
    } catch {
    }
  }
  throw new Error("whisper not found in PATH \u2014 install whisper.cpp or openai-whisper, or set voice.command in config");
}
function candidateModelDirs(whisperCmd) {
  const home = os.homedir();
  const whisperDir = path.dirname(whisperCmd);
  const dirs = [
    process.env.MIXDOG_CHANNELS_WHISPER_MODEL_DIR,
    process.env.WHISPER_MODEL_DIR,
    process.env.WHISPER_CPP_MODEL_DIR,
    config.voice?.model && !config.voice.model.endsWith(".bin") ? config.voice.model : "",
    path.join(DATA_DIR, "voice", "models"),
    path.join(DATA_DIR, "models"),
    path.join(process.cwd(), "models"),
    path.join(path.dirname(process.cwd()), "models"),
    path.join(home, ".cache", "whisper"),
    path.join(home, ".local", "share", "whisper"),
    path.join(home, ".local", "share", "whisper.cpp", "models"),
    path.join(home, "whisper.cpp", "models"),
    path.join(whisperDir, "models"),
    path.join(whisperDir, "..", "models"),
    "/opt/homebrew/share/whisper",
    "/usr/local/share/whisper"
  ];
  if (process.platform === "win32") {
    dirs.push(
      path.join(home, "AppData", "Local", "whisper"),
      path.join(home, "AppData", "Local", "whisper.cpp", "models"),
      path.join(home, "scoop", "persist", "whisper.cpp", "models")
    );
  }
  return dirs.filter((value) => Boolean(value)).map((value) => path.resolve(value)).filter((value, index, arr) => arr.indexOf(value) === index);
}
async function findWhisperModel(override, whisperCmd) {
  if (override) {
    const resolvedOverride = path.resolve(override);
    if (!fileExists(resolvedOverride)) {
      throw new Error(`configured whisper model not found: ${resolvedOverride}`);
    }
    return resolvedOverride;
  }
  if (resolvedWhisperModel && fileExists(resolvedWhisperModel)) {
    return resolvedWhisperModel;
  }
  const directEnv = [
    process.env.MIXDOG_CHANNELS_WHISPER_MODEL,
    process.env.WHISPER_MODEL
  ].filter((value) => Boolean(value));
  for (const filePath of directEnv) {
    const resolved = path.resolve(filePath);
    if (fileExists(resolved)) {
      resolvedWhisperModel = resolved;
      return resolved;
    }
  }
  const candidateNames = [
    "ggml-large-v3-turbo.bin",
    "ggml-large-v3.bin",
    "ggml-medium.bin",
    "ggml-base.bin",
    "ggml-base.en.bin"
  ];
  for (const dir of candidateModelDirs(whisperCmd)) {
    for (const name of candidateNames) {
      const candidate = path.join(dir, name);
      if (fileExists(candidate)) {
        resolvedWhisperModel = candidate;
        return candidate;
      }
    }
  }
  throw new Error("whisper model not found \u2014 set voice.model in config or place a GGML model in a standard models directory");
}
async function transcribeVoice(audioPath) {
  try {
    const whisperCmd = await findWhisper(config.voice?.command);
    const type = await detectWhisperType(whisperCmd);
    const lang = normalizeWhisperLanguage(config.voice?.language) ?? detectDeviceLanguage();
    if (type === "python") {
      const tmpDir = path.join(os.tmpdir(), "mixdog-whisper");
      await fs.promises.mkdir(tmpDir, { recursive: true });
      const args2 = [audioPath, "--output_format", "txt", "--output_dir", tmpDir];
      if (lang && lang !== "auto") args2.push("--language", lang);
      const model = config.voice?.pythonModel ?? config.voice?.model ?? "turbo";
      if (model && !model.endsWith(".bin")) args2.push("--model", model);
      await runCmd(whisperCmd, args2);
      const baseName = path.basename(audioPath).replace(/\.[^.]+$/, "");
      const txtPath = path.join(tmpDir, `${baseName}.txt`);
      const text2 = await fs.promises.readFile(txtPath, "utf-8");
      return text2.trim() || null;
    }
    const wavPath = audioPath.replace(/\.[^.]+$/, ".wav");
    const ffmpegPath = (() => {
      try { return _require('ffmpeg-static'); } catch { return 'ffmpeg'; }
    })();
    await runCmd(ffmpegPath, ["-i", audioPath, "-ar", "16000", "-ac", "1", "-y", wavPath]);
    const modelPath = await findWhisperModel(config.voice?.model, whisperCmd);
    const args = ["-f", wavPath, "--no-timestamps"];
    if (lang && lang !== "auto") args.push("-l", lang);
    args.push("-m", modelPath);
    const text = await runCmd(whisperCmd, args, true);
    return text.trim() || null;
  } catch (err) {
    process.stderr.write(`mixdog: transcribeVoice failed: ${err}
`);
    return null;
  }
}
const TOOL_DEFS = [
  {
    name: "reply",
    title: "Discord Reply",
    annotations: { title: "Discord Reply", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: "Reply on the messaging channel. Pass chat_id from the inbound message. Optionally pass reply_to, files, embeds, and components (buttons, selects, etc).",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Channel ID where the message will be sent" },
        text: { type: "string", description: "Message text content (markdown supported)" },
        reply_to: {
          type: "string",
          description: "Message ID to thread under. Use message_id from the inbound <channel> block, or an id from fetch."
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Absolute file paths to attach (images, logs, etc). Max 10 files, 25MB each."
        },
        embeds: {
          type: "array",
          items: { type: "object" },
          description: "Discord embed objects. Fields: title, description, color (int), fields [{name, value, inline}], footer {text}, timestamp."
        },
        components: {
          type: "array",
          items: { type: "object" },
          description: "Discord message components. Use Action Rows containing Buttons, Select Menus, etc. See Discord Components V2 docs."
        }
      },
      required: ["chat_id", "text"]
    }
  },
  {
    name: "react",
    title: "Reaction",
    annotations: { title: "Reaction", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Add an emoji reaction to a message. Unicode emoji work directly; custom emoji need the <:name:id> form.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Channel ID containing the message" },
        message_id: { type: "string", description: "ID of the message to react to" },
        emoji: { type: "string", description: 'Unicode emoji (e.g. "\u{1F44D}") or custom emoji in <:name:id> format' }
      },
      required: ["chat_id", "message_id", "emoji"]
    }
  },
  {
    name: "edit_message",
    title: "Edit Message",
    annotations: { title: "Edit Message", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    description: "Edit a message the bot previously sent. Supports text, embeds, and components.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Channel ID containing the message" },
        message_id: { type: "string", description: "ID of the bot message to edit" },
        text: { type: "string", description: "New message text content" },
        embeds: {
          type: "array",
          items: { type: "object" },
          description: "Discord embed objects."
        },
        components: {
          type: "array",
          items: { type: "object" },
          description: "Discord message components."
        }
      },
      required: ["chat_id", "message_id", "text"]
    }
  },
  {
    name: "download_attachment",
    title: "Download Attachment",
    annotations: { title: "Download Attachment", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Download attachments from a message to the local inbox. Use after fetch shows a message has attachments (marked with +Natt). Returns file paths ready to Read.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Channel ID containing the message" },
        message_id: { type: "string", description: "ID of the message with attachments" }
      },
      required: ["chat_id", "message_id"]
    }
  },
  {
    name: "fetch",
    title: "Fetch",
    annotations: { title: "Fetch", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Fetch recent messages from a channel. Returns oldest-first with message IDs. The platform's search API isn't exposed to bots, so this is the only way to look back.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: 'Channel name label (e.g. "main", "general") as configured in channelsConfig' },
        limit: {
          type: "number",
          description: "Max messages (default 20, capped at 100)."
        }
      },
      required: ["channel"]
    }
  },
  {
    name: "fetch_many",
    title: "Fetch Many",
    annotations: { title: "Fetch Many", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Fetch recent messages from multiple channels in one call. Use this when you need to look back across 2+ channels without serial fetches.",
    inputSchema: {
      type: "object",
      properties: {
        channels: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Channel name labels as configured in channelsConfig"
        },
        limit: {
          type: "number",
          description: "Max messages per channel (default 20, capped at 100)."
        }
      },
      required: ["channels"]
    }
  },
  {
    name: "schedule_status",
    title: "Schedule Status",
    annotations: { title: "Schedule Status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Show all configured schedules, their next fire time, and whether they are currently running.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "trigger_schedule",
    title: "Trigger Schedule",
    annotations: { title: "Trigger Schedule", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Manually trigger a named schedule immediately, ignoring time/day constraints.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Schedule name to trigger" }
      },
      required: ["name"]
    }
  },
  {
    name: "schedule_control",
    title: "Schedule Control",
    annotations: { title: "Schedule Control", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Defer or skip a schedule. Use "defer" to suppress for N minutes (default 30), or "skip_today" to suppress for the rest of the day.',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'Schedule name (e.g. "mail-briefing" or "proactive:chat")' },
        action: { type: "string", enum: ["defer", "skip_today"], description: "Action to take" },
        minutes: { type: "number", description: "Defer duration in minutes (default 30, only for defer action)" }
      },
      required: ["name", "action"]
    }
  },
  {
    name: "activate_channel_bridge",
    title: "Activate Channel Bridge",
    annotations: { title: "Activate Channel Bridge", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Activate or deactivate the channel bridge. When active, inbound messages trigger typing indicators, emoji reactions, and auto-forwarding of transcript output to Discord. When inactive, only direct MCP tool calls (reply, fetch) work.",
    inputSchema: {
      type: "object",
      properties: {
        active: { type: "boolean", description: "true to activate, false to deactivate" }
      },
      required: ["active"]
    }
  },
  // memory and recall_memory tools are now provided by memory-service.mjs via MCP
  {
    name: "reload_config",
    title: "Reload Config",
    annotations: { title: "Reload Config", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Reload config from disk and re-register all schedules, webhooks, and event rules without restarting.",
    inputSchema: { type: "object", properties: {} }
  }
];
function createHttpMcpServer() {
  const s = new Server(
    { name: "mixdog", version: PLUGIN_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolName = req.params.name;
    const args = req.params.arguments ?? {};
    try {
      switch (toolName) {
        case "reply": {
          // Pre-send bump blocks proactive chat during the await.
          scheduler.noteActivity();
          const sendResult = await backend.sendMessage(
            args.chat_id,
            args.text,
            { replyTo: args.reply_to, files: args.files ?? [], embeds: args.embeds ?? [], components: args.components ?? [] }
          );
          // Lead-originated reply via MCP — bump activity.
          scheduler.noteActivity();
          return { content: [{ type: "text", text: JSON.stringify({ sentIds: sendResult.sentIds }) }] };
        }
        case "react": {
          await backend.react(args.chat_id, args.message_id, args.emoji);
          return { content: [{ type: "text", text: "ok" }] };
        }
        case "edit_message": {
          const editId = await backend.editMessage(args.chat_id, args.message_id, args.text, { embeds: args.embeds ?? [], components: args.components ?? [] });
          return { content: [{ type: "text", text: JSON.stringify({ id: editId }) }] };
        }
        case "fetch": {
          const _fetchChannelId = resolveChannelLabel(config.channelsConfig, args.channel);
          const msgs = await backend.fetchMessages(_fetchChannelId, args.limit ?? 20);
          recordFetchedMessages(_fetchChannelId, args.channel !== _fetchChannelId ? args.channel : labelForChannelId(_fetchChannelId), msgs);
          return { content: [{ type: "text", text: JSON.stringify({ messages: msgs }) }] };
        }
        case "fetch_many": {
          const channels = Array.isArray(args.channels) ? args.channels : [];
          const limit = args.limit ?? 20;
          const rows = await Promise.all(channels.map(async (channel) => ({
            channel,
            messages: await backend.fetchMessages(channel, limit),
          })));
          return { content: [{ type: "text", text: JSON.stringify({ channels: rows }) }] };
        }
        case "download_attachment": {
          const files = await backend.downloadAttachment(args.chat_id, args.message_id);
          return { content: [{ type: "text", text: JSON.stringify({ files }) }] };
        }
        case "schedule_status": {
          const statuses = scheduler.getStatus();
          return { content: [{ type: "text", text: statuses.length ? statuses.map((st) => `${st.name} ${st.time} ${st.days} (${st.type})${st.running ? " [RUNNING]" : ""}`).join("\n") : "no schedules configured" }] };
        }
        case "trigger_schedule": {
          const triggerResult = await scheduler.triggerManual(args.name);
          return { content: [{ type: "text", text: triggerResult }] };
        }
        case "schedule_control": {
          const action = args.action;
          if (action === "defer") {
            scheduler.defer(args.name, args.minutes ?? 30);
            return { content: [{ type: "text", text: `deferred "${args.name}" for ${args.minutes ?? 30} minutes` }] };
          } else if (action === "skip_today") {
            scheduler.skipToday(args.name);
            return { content: [{ type: "text", text: `skipped "${args.name}" for today` }] };
          }
          return { content: [{ type: "text", text: `unknown action: ${action}` }], isError: true };
        }
        case "activate_channel_bridge": {
          const active = args.active === true;
          channelBridgeActive = active;
          writeBridgeState(active);
          if (active) void refreshBridgeOwnership({ restoreBinding: true });
          return { content: [{ type: "text", text: `channel bridge ${active ? "activated" : "deactivated"}` }] };
        }
        case "reload_config": {
          reloadRuntimeConfig();
          return { content: [{ type: "text", text: "config reloaded \u2014 schedules, webhooks, and events re-registered" }] };
        }
        default:
          return { content: [{ type: "text", text: `unknown tool: ${toolName}` }], isError: true };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `${toolName} failed: ${msg}` }], isError: true };
    }
  });
  return s;
}
// Tool dispatch in worker mode goes through the IPC `call` handler at the
// bottom of this file (parent's `callWorker` → `handleToolCall`). The HTTP
// MCP path uses its own short-lived `Server` instance built by
// `createHttpMcpServer()` above. There is no orphan worker-level Server.
const BACKEND_TOOLS = /* @__PURE__ */ new Set(["reply", "fetch", "react", "edit_message", "download_attachment"]);
async function handleToolCall(name, args) {
  if (_channelsDegraded) {
    return { content: [{ type: 'text', text: `[channels degraded] ${name} unavailable — restart MCP to recover` }], isError: true }
  }
  let result;
  try {
    if (proxyMode && BACKEND_TOOLS.has(name)) {
      let proxyResult;
      switch (name) {
        case "reply": {
          proxyResult = await proxyRequest("/send", "POST", {
            chatId: args.chat_id,
            text: args.text,
            opts: {
              replyTo: args.reply_to,
              files: args.files ?? [],
              embeds: args.embeds ?? [],
              components: args.components ?? []
            }
          });
          if (!proxyResult.ok) {
            result = { content: [{ type: "text", text: `proxy reply failed: ${proxyResult.error}` }], isError: true };
          } else {
            const ids = proxyResult.data?.sentIds ?? [];
            const text = ids.length === 1 ? `sent (id: ${ids[0]})` : `sent ${ids.length} parts (ids: ${ids.join(", ")})`;
            result = { content: [{ type: "text", text }] };
          }
          break;
        }
        case "fetch": {
          const channelId = resolveChannelLabel(config.channelsConfig, args.channel);
          const limit = args.limit ?? 20;
          proxyResult = await proxyRequest(`/fetch?channel=${encodeURIComponent(channelId)}&limit=${limit}`, "GET");
          if (!proxyResult.ok) {
            result = { content: [{ type: "text", text: `proxy fetch failed: ${proxyResult.error}` }], isError: true };
          } else {
            const msgs = proxyResult.data?.messages ?? [];
            const text = msgs.length === 0 ? "(no messages)" : msgs.map((m) => {
              const atts = m.attachmentCount > 0 ? ` +${m.attachmentCount}att` : "";
              return `[${m.ts}] ${m.user}: ${m.text}  (id: ${m.id}${atts})`;
            }).join("\n");
            result = { content: [{ type: "text", text }] };
          }
          break;
        }
        case "react": {
          proxyResult = await proxyRequest("/react", "POST", {
            chatId: args.chat_id,
            messageId: args.message_id,
            emoji: args.emoji
          });
          if (!proxyResult.ok) {
            result = { content: [{ type: "text", text: `proxy react failed: ${proxyResult.error}` }], isError: true };
          } else {
            result = { content: [{ type: "text", text: "reacted" }] };
          }
          break;
        }
        case "edit_message": {
          proxyResult = await proxyRequest("/edit", "POST", {
            chatId: args.chat_id,
            messageId: args.message_id,
            text: args.text,
            opts: {
              embeds: args.embeds ?? [],
              components: args.components ?? []
            }
          });
          if (!proxyResult.ok) {
            result = { content: [{ type: "text", text: `proxy edit failed: ${proxyResult.error}` }], isError: true };
          } else {
            result = { content: [{ type: "text", text: `edited (id: ${proxyResult.data?.id})` }] };
          }
          break;
        }
        case "download_attachment": {
          proxyResult = await proxyRequest("/download", "POST", {
            chatId: args.chat_id,
            messageId: args.message_id
          });
          if (!proxyResult.ok) {
            result = { content: [{ type: "text", text: `proxy download failed: ${proxyResult.error}` }], isError: true };
          } else {
            const files = proxyResult.data?.files ?? [];
            if (files.length === 0) {
              result = { content: [{ type: "text", text: "message has no attachments" }] };
            } else {
              const lines = files.map(
                (f) => `  ${f.path}  (${f.name}, ${f.contentType}, ${(f.size / 1024).toFixed(0)}KB)`
              );
              result = { content: [{ type: "text", text: `downloaded ${files.length} attachment(s):
${lines.join("\n")}` }] };
            }
          }
          break;
        }
        default:
          result = { content: [{ type: "text", text: `unknown proxy tool: ${name}` }], isError: true };
      }
    } else {
      switch (name) {
        case "reply": {
          // Pre-send bump blocks proactive chat during the await.
          scheduler.noteActivity();
          const sendResult = await backend.sendMessage(
            args.chat_id,
            args.text,
            {
              replyTo: args.reply_to,
              files: args.files ?? [],
              embeds: args.embeds ?? [],
              components: args.components ?? []
            }
          );
          // Lead-originated reply via proxy-mode MCP — bump activity.
          scheduler.noteActivity();
          const text = sendResult.sentIds.length === 1 ? `sent (id: ${sendResult.sentIds[0]})` : `sent ${sendResult.sentIds.length} parts (ids: ${sendResult.sentIds.join(", ")})`;
          result = { content: [{ type: "text", text }] };
          break;
        }
        case "fetch": {
          const channelId = resolveChannelLabel(config.channelsConfig, args.channel);
          const msgs = await backend.fetchMessages(
            channelId,
            args.limit ?? 20
          );
          recordFetchedMessages(channelId, args.channel !== channelId ? args.channel : labelForChannelId(channelId), msgs);
          const text = msgs.length === 0 ? "(no messages)" : msgs.map((m) => {
            const atts = m.attachmentCount > 0 ? ` +${m.attachmentCount}att` : "";
            return `[${m.ts}] ${m.user}: ${m.text}  (id: ${m.id}${atts})`;
          }).join("\n");
          result = { content: [{ type: "text", text }] };
          break;
        }
        case "fetch_many": {
          const labels = Array.isArray(args.channels) ? args.channels : [];
          const rows = await Promise.all(labels.map(async (label) => {
            const channelId = resolveChannelLabel(config.channelsConfig, label);
            const msgs = await backend.fetchMessages(channelId, args.limit ?? 20);
            const text = msgs.length === 0 ? "(no messages)" : msgs.map((m) => {
              const atts = m.attachmentCount > 0 ? ` +${m.attachmentCount}att` : "";
              return `[${m.ts}] ${m.user}: ${m.text}  (id: ${m.id}${atts})`;
            }).join("\\n");
            return `## ${label}\\n${text}`;
          }));
          result = { content: [{ type: "text", text: rows.join("\\n\\n") }] };
          break;
        }
        case "react": {
          await backend.react(
            args.chat_id,
            args.message_id,
            args.emoji
          );
          result = { content: [{ type: "text", text: "reacted" }] };
          break;
        }
        case "edit_message": {
          const id = await backend.editMessage(
            args.chat_id,
            args.message_id,
            args.text,
            {
              embeds: args.embeds ?? [],
              components: args.components ?? []
            }
          );
          result = { content: [{ type: "text", text: `edited (id: ${id})` }] };
          break;
        }
        case "download_attachment": {
          const files = await backend.downloadAttachment(
            args.chat_id,
            args.message_id
          );
          if (files.length === 0) {
            result = { content: [{ type: "text", text: "message has no attachments" }] };
          } else {
            const lines = files.map(
              (f) => `  ${f.path}  (${f.name}, ${f.contentType}, ${(f.size / 1024).toFixed(0)}KB)`
            );
            result = {
              content: [{ type: "text", text: `downloaded ${files.length} attachment(s):
${lines.join("\n")}` }]
            };
          }
          break;
        }
        case "schedule_status": {
          const statuses = scheduler.getStatus();
          if (statuses.length === 0) {
            result = { content: [{ type: "text", text: "no schedules configured" }] };
          } else {
            const lines = statuses.map((s) => {
              const state = s.running ? " [RUNNING]" : "";
              const last = s.lastFired ? ` (last: ${s.lastFired})` : "";
              return `  ${s.name}  ${s.time} ${s.days} (${s.type})${state}${last}`;
            });
            result = { content: [{ type: "text", text: lines.join("\n") }] };
          }
          break;
        }
        case "trigger_schedule": {
          const triggerResult = await scheduler.triggerManual(args.name);
          result = { content: [{ type: "text", text: triggerResult }] };
          break;
        }
        case "schedule_control": {
          const scName = args.name;
          const action = args.action;
          if (action === "defer") {
            const minutes = args.minutes ?? 30;
            scheduler.defer(scName, minutes);
            result = { content: [{ type: "text", text: `deferred "${scName}" for ${minutes} minutes` }] };
          } else if (action === "skip_today") {
            scheduler.skipToday(scName);
            result = { content: [{ type: "text", text: `skipped "${scName}" for today` }] };
          } else {
            result = { content: [{ type: "text", text: `unknown action: ${action}` }], isError: true };
          }
          break;
        }
        case "activate_channel_bridge": {
          if (proxyMode) {
            const proxyRes = await proxyRequest("/bridge/activate", "POST", { active: args.active === true });
            if (!proxyRes.ok) {
              result = { content: [{ type: "text", text: `proxy bridge activate failed: ${proxyRes.error}` }], isError: true };
            } else {
              channelBridgeActive = Boolean(args.active);
              writeBridgeState(channelBridgeActive);
              result = { content: [{ type: "text", text: `channel bridge ${args.active ? "activated" : "deactivated"}` }] };
            }
          } else {
            const active = args.active === true;
            const wasActive = channelBridgeActive;
            channelBridgeActive = active;
            writeBridgeState(active);
            if (active && !wasActive) {
              void refreshBridgeOwnership({ restoreBinding: true });
            }
            if (!active && wasActive) {
              stopServerTyping();
            }
            result = { content: [{ type: "text", text: `channel bridge ${active ? "activated" : "deactivated"}` }] };
          }
          break;
        }
        case "reload_config": {
          reloadRuntimeConfig();
          result = { content: [{ type: "text", text: "config reloaded \u2014 schedules, webhooks, and events re-registered" }] };
          break;
        }
        // memory — handled by memory-service.mjs MCP
        default:
          result = {
            content: [{ type: "text", text: `unknown tool: ${name}` }],
            isError: true
          };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
      content: [{ type: "text", text: `${name} failed: ${msg}` }],
      isError: true
    };
  }
  return result;
}
// Bridge auto-connect retry + forwarder-aware tool dispatch wrapper. Used by
// both the HTTP MCP path (createHttpMcpServer's CallTool handler can call this)
// and the worker IPC handler at the bottom of this file. The pre-v0.6.7 code
// registered this on the orphan worker-level `Server`, which never had a
// transport, so the wrapper never actually fired. Centralised here for reuse.
async function handleToolCallWithBridgeRetry(toolName, args) {
  await forwarder.forwardNewText();
  if (BACKEND_TOOLS.has(toolName) && !bridgeRuntimeConnected && !proxyMode) {
    if (!currentOwnerState().owned) claimBridgeOwnership("tool call");
    for (let i = 0; i < 2 && !bridgeRuntimeConnected && !proxyMode; i++) {
      try {
        await refreshBridgeOwnership();
      } catch {
      }
      if (!bridgeRuntimeConnected && !proxyMode) await new Promise((r) => setTimeout(r, 300));
    }
    if (!bridgeRuntimeConnected && !proxyMode) {
      return {
        content: [{ type: "text", text: `Discord auto-connect failed after retries. Check token and network.` }],
        isError: true
      };
    }
  }
  const result = await handleToolCall(toolName, args);
  const toolLine = OutputForwarder.buildToolLine(toolName, args);
  if (toolLine) {
    void forwarder.forwardToolLog(toolLine, toolName, args);
  }
  return result;
}
const INBOUND_DEDUP_TTL = 5 * 6e4;
const inboundSeen = /* @__PURE__ */ new Map();
const INBOUND_DEDUP_DIR = path.join(os.tmpdir(), "mixdog-inbound");
ensureDir(INBOUND_DEDUP_DIR);
function claimChannelOwner(channelId) {
  const ownerPath = getChannelOwnerPath(channelId);
  try {
    fs.writeFileSync(ownerPath, JSON.stringify({ instanceId: INSTANCE_ID, pid: process.pid, updatedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}
function shouldDropDuplicateInbound(msg) {
  const key = `${msg.chatId}:${msg.messageId}`;
  const now = Date.now();
  if (inboundSeen.has(key) && now - inboundSeen.get(key) < INBOUND_DEDUP_TTL) return true;
  inboundSeen.set(key, now);
  const marker = path.join(INBOUND_DEDUP_DIR, key.replace(/:/g, "_"));
  try {
    const stat = fs.statSync(marker);
    if (now - stat.mtimeMs < INBOUND_DEDUP_TTL) return true;
  } catch {
  }
  writeTextFile(marker, String(now));
  if (Math.random() < 0.1) {
    try {
      for (const f of fs.readdirSync(INBOUND_DEDUP_DIR)) {
        const fp = path.join(INBOUND_DEDUP_DIR, f);
        try {
          if (now - fs.statSync(fp).mtimeMs > INBOUND_DEDUP_TTL) removeFileIfExists(fp);
        } catch {
        }
      }
    } catch {
    }
  }
  for (const [k, t] of inboundSeen) {
    if (now - t > INBOUND_DEDUP_TTL) inboundSeen.delete(k);
  }
  return false;
}
function resolveInboundRoute(chatId) {
  const main = config.channelsConfig?.main;
  const isMain = typeof main === "object" && main !== null && main.channelId === chatId;
  return {
    targetChatId: chatId,
    sourceChatId: chatId,
    sourceLabel: isMain ? "main" : undefined,
    sourceMode: (isMain && main.mode) || "interactive"
  };
}
const inboundQueue = (() => {
  let tail = Promise.resolve();
  return (fn) => {
    tail = tail.then(fn, fn);
  };
})();
// ── Reverse-lookup channelId → human label from channelsConfig ──────────────
function labelForChannelId(channelId) {
  if (!channelId || !config.channelsConfig) return channelId;
  for (const [label, entry] of Object.entries(config.channelsConfig)) {
    if (entry?.channelId === channelId) return label;
  }
  return channelId;
}

backend.onMessage = (msg) => {
  if (!bridgeRuntimeConnected || !getBridgeOwnershipSnapshot().owned) {
    void refreshBridgeOwnership();
    return;
  }
  if (!channelBridgeActive) return;
  if (shouldDropDuplicateInbound(msg)) return;
  recordFetchedMessages(msg.chatId, labelForChannelId(msg.chatId), [{ id: msg.messageId }]);
  if (!claimChannelOwner(msg.chatId)) return;
  const route = resolveInboundRoute(msg.chatId);
  scheduler.noteActivity();
  startServerTyping(route.targetChatId);
  backend.resetSendCount();
  void forwarder.forwardFinalText();
  forwarder.reset();
  const previousPath = getPersistedTranscriptPath();
  const boundTranscript = discoverSessionBoundTranscript();
  let transcriptPath = pickUsableTranscriptPath(boundTranscript, previousPath);
  const latestByMtime = findLatestTranscriptByMtime(boundTranscript?.sessionCwd);
  if (latestByMtime && latestByMtime !== transcriptPath) {
    transcriptPath = latestByMtime;
  }
  if (transcriptPath) {
    applyTranscriptBinding(route.targetChatId, transcriptPath);
  } else {
    refreshActiveInstance(INSTANCE_ID, { channelId: route.targetChatId });
  }
  void (async () => {
    try {
      await backend.react(msg.chatId, msg.messageId, "\u{1F914}");
    } catch {
    }
    statusState.update((state) => {
      state.channelId = route.targetChatId;
      state.userMessageId = msg.messageId;
      state.emoji = "\u{1F914}";
      state.sentCount = 0;
      state.sessionIdle = false;
      if (transcriptPath) state.transcriptPath = transcriptPath;
      else delete state.transcriptPath;
    });
    if (!boundTranscript?.exists) {
      await rebindTranscriptContext(route.targetChatId, {
        previousPath: transcriptPath,
        catchUp: true,
        persistStatus: true
      });
    }
  })();
  inboundQueue(() => handleInbound(msg, route, {
    sessionId: boundTranscript?.sessionId ?? sessionIdFromTranscriptPath(transcriptPath)
  }).catch((err) => {
    process.stderr.write(`mixdog: handleInbound error: ${err}
`);
  }).finally(() => {
    stopServerTyping();
  }));
};
async function handleInbound(msg, route, options = {}) {
  let text = msg.text;
  const voiceAtts = msg.attachments.filter((a) => isVoiceAttachment(a.contentType));
  if (voiceAtts.length > 0) {
    try {
      const files = await backend.downloadAttachment(msg.chatId, msg.messageId);
      for (const f of files) {
        if (isVoiceAttachment(f.contentType)) {
          const transcript = await transcribeVoice(f.path);
          if (transcript) {
            text = transcript;
            process.stderr.write(`mixdog: transcribed voice (${f.name}): ${transcript.slice(0, 50)}
`);
          } else {
            process.stderr.write(`mixdog: voice transcription returned empty (${f.name})
`);
            text = text || "[voice message \u2014 transcription failed]";
          }
        }
      }
    } catch (err) {
      process.stderr.write(`mixdog: voice transcription failed: ${err}
`);
      text = text || "[voice message \u2014 transcription error]";
    }
  }
  const hasVoiceAtt = voiceAtts.length > 0;
  const attMeta = msg.attachments.length > 0 && !hasVoiceAtt ? {
    attachment_count: String(msg.attachments.length),
    attachments: msg.attachments.map((a) => `${a.name} (${a.contentType}, ${(a.size / 1024).toFixed(0)}KB)`).join("; ")
  } : {};
  const messageBody = route.sourceMode === "monitor" && route.sourceLabel ? `[monitor:${route.sourceLabel}] ${text}` : text;
  const now = (/* @__PURE__ */ new Date()).toLocaleString();
  const notificationMeta = {
    chat_id: route.targetChatId,
    message_id: msg.messageId,
    user: msg.user,
    user_id: msg.userId,
    ts: msg.ts,
    ...route.sourceMode === "monitor" ? {
      source_chat_id: route.sourceChatId,
      source_mode: route.sourceMode,
      ...route.sourceLabel ? { source_label: route.sourceLabel } : {}
    } : {},
    ...attMeta,
    ...msg.imagePath ? { image_path: msg.imagePath } : {}
  };
  const notificationContent = `[${now}]
${messageBody}`;
  sendNotifyToParent("notifications/claude/channel", {
    content: notificationContent,
    meta: notificationMeta
  });
  void memoryAppendEntry({
    ts: msg.ts,
    role: "user",
    content: messageBody,
    sourceRef: `discord:${route.targetChatId}#${msg.messageId}`,
    sessionId: `discord:${route.targetChatId}`,
  });
}
async function init(_sharedMcp) {
  // _sharedMcp is no longer used. Notifications now flow via IPC to the parent
  // (sendNotifyToParent above). The parameter is retained for backward
  // compatibility with any caller that still passes a Server reference.
  scheduler.setInjectHandler((channelId, name, content, options) => {
    injectAndRecord(channelId, name, content, options);
  });
  eventQueue.setInjectHandler((channelId, name, content, options) => {
    injectAndRecord(channelId, name, content, options);
  });
}
async function start() {
  channelBridgeActive = true;
  writeBridgeState(true);
  await refreshBridgeOwnership({ restoreBinding: true });
}
async function stop() {
  await stopOwnedRuntime("unified server stop");
  cleanupInstanceRuntimeFiles(INSTANCE_ID);
}
{
  let detectChannelFlag = function() {
    const isWin = process.platform === "win32";
    const flagRe = /--channels\b|--dangerously-load-development-channels\b/;
    if (isWin) {
      let pid2 = process.ppid;
      for (let depth = 0; pid2 && pid2 > 1 && depth < 6; depth++) {
        try {
          let cmdLine = "";
          try {
            cmdLine = execSync(
              `wmic process where "ProcessId=${pid2}" get CommandLine /format:list`,
              { encoding: "utf8", timeout: 5e3 }
            );
          } catch {
            cmdLine = execSync(
              `powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid2}').CommandLine"`,
              { encoding: "utf8", timeout: 5e3 }
            );
          }
          if (flagRe.test(cmdLine)) return true;
          let ppidStr = "";
          try {
            ppidStr = execSync(
              `wmic process where "ProcessId=${pid2}" get ParentProcessId /format:list`,
              { encoding: "utf8", timeout: 5e3 }
            );
          } catch {
            ppidStr = execSync(
              `powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid2}').ParentProcessId"`,
              { encoding: "utf8", timeout: 5e3 }
            );
          }
          const match = ppidStr.match(/\d+/);
          if (!match) break;
          const nextPid = parseInt(match[0], 10);
          if (nextPid === pid2 || nextPid <= 1) break;
          pid2 = nextPid;
        } catch {
          break;
        }
      }
      return false;
    }
    let pid = process.ppid;
    for (let depth = 0; pid && pid > 1 && depth < 6; depth++) {
      try {
        const cmdLine = execSync(`ps -p ${pid} -o args=`, { encoding: "utf8", timeout: 3e3 });
        if (flagRe.test(cmdLine)) return true;
        pid = parseInt(execSync(`ps -p ${pid} -o ppid=`, { encoding: "utf8", timeout: 3e3 }).trim(), 10);
      } catch {
        break;
      }
    }
    return false;
  };
  const _channelFlagDetected = detectChannelFlag();
  fs.appendFileSync(_bootLog, `[${localTimestamp()}] channelFlag: ${_channelFlagDetected}
`);
  if (_channelFlagDetected) {
    channelBridgeActive = true;
    fs.appendFileSync(_bootLog, `[${localTimestamp()}] channel mode detected \u2014 bridge auto-activated
`);
  }
  writeBridgeState(channelBridgeActive);
  const previousOwner = readActiveInstance();
  noteStartupHandoff(previousOwner);
  if (channelBridgeActive) {
    claimBridgeOwnership("server start");
  }
  void refreshBridgeOwnership({ restoreBinding: true });
  bridgeOwnershipTimer = setInterval(() => {
    void refreshBridgeOwnership();
  }, 3e4);
  // Boot-time session greeting removed — proactive covers the same role
  // (conversational session kickoff) with real topic selection + source
  // scoring instead of a canned template. See
  // rules/bridge/50-proactive-decision.md.
  const configPath = path.join(DATA_DIR, "config.json");
  let reloadDebounce = null;
  try {
    fs.watch(configPath, () => {
      if (reloadDebounce) clearTimeout(reloadDebounce);
      reloadDebounce = setTimeout(() => {
        try {
          reloadRuntimeConfig();
        } catch {
        }
      }, 500);
    });
  } catch {
  }
}
// ── IPC worker mode ──────────────────────────────────────────────
if (_isWorkerMode && process.send) {
  process.on('message', async (msg) => {
    // Silent-to-agent lifecycle forward — parent (server.mjs) asks the
    // channels worker to post status pings to the active bridge Discord
    // channel without the Lead-notify hop. Best-effort: unknown channel or
    // backend failure is swallowed; lifecycle pings are non-critical.
    if (msg && msg.type === 'forward_to_discord') {
      try {
        const target = msg.channelId
          || (statusState?.read?.().channelId)
          || null;
        if (target && backend?.sendMessage && typeof msg.content === 'string' && msg.content) {
          await backend.sendMessage(target, msg.content).catch(() => {});
        }
      } catch { /* best-effort */ }
      return;
    }
    // Claude Code permission request → Discord Allow/Deny prompt.
    // Parent (server.mjs) receives notifications/claude/channel/permission_request
    // from Claude Code and forwards the params here. We post a buttoned message;
    // button clicks are handled in backend.onInteraction and sent back to CC as
    // notifications/claude/channel/permission via sendNotifyToParent.
    if (msg && msg.type === 'permission_request_inbound') {
      try {
        const { request_id, tool_name, description, input_preview } = msg.params || {};
        // tool_input arrives via the passthrough() schema in server.mjs when
        // Claude Code includes it in the permission_request notification.
        // Used to bind the pendingPermRequest to a specific file so two
        // concurrent Edit/Write requests cannot cross-approve via the
        // terminal signal.
        const toolInputParam = (msg.params && (msg.params.tool_input || msg.params.toolInput)) || {};
        const filePathParam = toolInputParam.file_path || '';
        if (!request_id || !tool_name) return;
        if (pendingPermRequests.size > 100) {
          const cutoff = Date.now() - 30 * 60 * 1000;
          for (const [k, v] of pendingPermRequests) {
            if (v.createdAt < cutoff) pendingPermRequests.delete(k);
          }
        }
        const mainLabel = config?.mainChannel || 'main';
        const target = (statusState?.read?.().channelId)
          || resolveChannelLabel(config?.channelsConfig, mainLabel)
          || null;
        if (!target || !backend?.sendMessage) {
          process.stderr.write(`mixdog channels: permission_request dropped, no target channel (request_id=${request_id})\n`);
          return;
        }
        const lines = [`🔐 **Permission Request**`, `Tool: \`${tool_name}\``];
        if (description) lines.push(description);
        if (input_preview) lines.push('```\n' + String(input_preview).slice(0, 800) + '\n```');
        const content = lines.join('\n');
        const components = [{
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Allow', custom_id: `perm-ch-${request_id}-allow` },
            { type: 2, style: 1, label: 'Session Allow', custom_id: `perm-ch-${request_id}-session` },
            { type: 2, style: 4, label: 'Deny', custom_id: `perm-ch-${request_id}-deny` },
          ],
        }];
        let sentIds = null;
        try {
          const sendResult = await backend.sendMessage(target, content, { components });
          sentIds = sendResult?.sentIds;
        } catch (err) {
          process.stderr.write(`mixdog channels: permission_request Discord send failed: ${err && err.message || err}\n`);
          return;
        }
        const messageId = Array.isArray(sentIds) && sentIds.length > 0 ? sentIds[0] : null;
        pendingPermRequests.set(request_id, {
          toolName: tool_name,
          filePath: filePathParam,
          createdAt: Date.now(),
          channelId: target,
          messageId,
        });
      } catch (err) {
        try { process.stderr.write(`mixdog channels: permission_request handler error: ${err && err.message || err}\n`); } catch {}
      }
      return;
    }
    if (msg.type !== 'call' || !msg.callId) return
    try {
      const result = await handleToolCallWithBridgeRetry(msg.name, msg.args || {})
      process.send({ type: 'result', callId: msg.callId, result })
    } catch (e) {
      process.send({ type: 'result', callId: msg.callId, error: e.message })
    }
  })
  process.send({ type: 'ready' })
}

export {
  TOOL_DEFS,
  handleToolCall,
  init,
  INSTRUCTIONS as instructions,
  isChannelBridgeActive,
  isChannelsDegraded,
  start,
  stop
};
