import * as http from "http";
import * as crypto from "crypto";
import { join } from "path";
import { spawn, spawnSync } from "child_process";
import { DATA_DIR, isInQuietWindow } from "./config.mjs";
import { appendFileSync, readFileSync, readdirSync, mkdirSync, writeFileSync, unlinkSync, statSync, existsSync, watch as fsWatch } from "fs";
import { randomUUID } from "crypto";
import { homedir } from "os";
const WEBHOOKS_DIR = join(DATA_DIR, "webhooks");
const WEBHOOK_LOG = join(DATA_DIR, "webhook.log");
function logWebhook(msg) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`;
  try {
    process.stderr.write(`mixdog webhook: ${msg}
`);
  } catch {
  }
  try {
    appendFileSync(WEBHOOK_LOG, line);
  } catch {
  }
}
function isActionableEvent(event, action) {
  if (!event) return true;
  if (event === "push") return true;
  if (event === "issues") return ["opened", "edited", "reopened"].includes(action);
  if (event === "issue_comment") return action === "created";
  if (event === "pull_request") return ["opened", "edited", "reopened", "synchronize"].includes(action);
  if (event === "ping") return false;
  return false;
}
const SIGNATURE_HEADERS = {
  github: { header: "x-hub-signature-256", prefix: "sha256=" },
  sentry: { header: "sentry-hook-signature", prefix: "" },
  stripe: { header: "stripe-signature", prefix: "" },
  generic: { header: "x-signature-256", prefix: "sha256=" }
};
function extractSignature(headers, parser) {
  if (parser) {
    const mapping = SIGNATURE_HEADERS[parser];
    if (mapping) {
      const raw = headers[mapping.header];
      if (raw) return mapping.prefix ? raw.replace(mapping.prefix, "") : raw;
    }
  }
  for (const mapping of Object.values(SIGNATURE_HEADERS)) {
    const raw = headers[mapping.header];
    if (raw) return mapping.prefix ? raw.replace(mapping.prefix, "") : raw;
  }
  return null;
}
function verifySignature(secret, rawBody, signatureValue, parser) {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  if (parser === "stripe") {
    const match = signatureValue.match(/v1=([a-f0-9]+)/);
    if (!match) return false;
    // timingSafeEqual throws on length mismatch / malformed hex; wrap so a
    // crafted signature header can't crash the request handler.
    try {
      const a = Buffer.from(match[1], "hex");
      const b = Buffer.from(expected, "hex");
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
  try {
    const a = Buffer.from(signatureValue, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── Endpoint config loader ─────────────────────────────────────────────
// Reads DATA_DIR/webhooks/<name>/config.json (written by setup-server.mjs
// via POST /webhooks). Cached in-memory, invalidated by fs.watch on the
// webhooks directory. Returns { secret, parser, channel, mode, role }
// where mode ∈ {"delegate","interactive"} and role names a user-workflow
// entry (e.g. "reviewer") when mode=delegate.
const _endpointCache = new Map();
let _endpointWatcher = null;
function _endpointConfigPath(name) {
  return join(WEBHOOKS_DIR, name, "config.json");
}
function _ensureEndpointWatcher() {
  if (_endpointWatcher) return;
  try {
    if (!existsSync(WEBHOOKS_DIR)) return;
    _endpointWatcher = fsWatch(WEBHOOKS_DIR, { recursive: true }, (_event, filename) => {
      if (!filename) { _endpointCache.clear(); return; }
      // filename is like "<endpoint>/config.json" or "<endpoint>"
      const parts = String(filename).split(/[\\/]/);
      const endpointName = parts[0];
      if (endpointName) _endpointCache.delete(endpointName);
      else _endpointCache.clear();
    });
    _endpointWatcher.on("error", () => { _endpointWatcher = null; _endpointCache.clear(); });
  } catch {
    // Watch failures are non-fatal; cache simply stays until process restart.
  }
}
function loadEndpointConfig(name) {
  if (!name) return null;
  if (_endpointCache.has(name)) return _endpointCache.get(name);
  _ensureEndpointWatcher();
  const p = _endpointConfigPath(name);
  if (!existsSync(p)) { _endpointCache.set(name, null); return null; }
  try {
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    _endpointCache.set(name, cfg);
    return cfg;
  } catch {
    _endpointCache.set(name, null);
    return null;
  }
}

// ── Delivery tracking ─────────────────────────────────────────────────
// Per-endpoint append-only log at WEBHOOKS_DIR/<name>/deliveries.jsonl.
// Each POST writes at least two lines: {status:"pending"|"processing"}
// then {status:"done"|"failed"|"dedup"}. Earlier fields (payloadPreview,
// headersSummary) are kept on the first line only; later status updates
// reference the same `id` and are merged latest-wins at read time.
function _deliveriesPath(name) {
  return join(WEBHOOKS_DIR, name, "deliveries.jsonl");
}
function appendDelivery(name, entry) {
  try {
    const dir = join(WEBHOOKS_DIR, name);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    appendFileSync(_deliveriesPath(name), line);
  } catch (err) {
    logWebhook(`${name}: deliveries append failed: ${err?.message ?? err}`);
  }
}
function readDeliveries(name) {
  const p = _deliveriesPath(name);
  if (!existsSync(p)) return [];
  const byId = new Map();
  try {
    const raw = readFileSync(p, "utf8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (!entry || !entry.id) continue;
        const prior = byId.get(entry.id);
        const merged = prior ? { ...prior, ...entry } : entry;
        byId.set(entry.id, merged);
      } catch {}
    }
  } catch {}
  return [...byId.values()];
}
function deliveryDone(name, id) {
  const list = readDeliveries(name);
  const match = list.find((e) => e.id === id);
  return match?.status === "done";
}
// Any prior delivery row for this id (regardless of terminal status) — used
// to atomically reject duplicate POSTs that arrive while a prior delivery
// is still pending/processing. Without this guard a webhook sender that
// retries fast (GitHub does ~5s) could spawn two concurrent delegate
// dispatches for one event.
function deliveryExists(name, id) {
  const list = readDeliveries(name);
  return list.some((e) => e.id === id);
}
function extractDeliveryId(headers) {
  return headers["x-github-delivery"]
    || headers["x-delivery-id"]
    || headers["x-request-id"]
    || null;
}
function buildHeadersSummary(headers) {
  const summary = {};
  if (headers["x-github-event"]) summary.event_type = headers["x-github-event"];
  if (headers["x-github-delivery"]) summary.delivery_id = headers["x-github-delivery"];
  summary.signature_present = Boolean(
    headers["x-hub-signature-256"] || headers["x-signature-256"]
      || headers["stripe-signature"] || headers["sentry-hook-signature"]
  );
  if (headers["content-type"]) summary.content_type = headers["content-type"];
  return summary;
}
// Public read helper — used by setup-server API to list deliveries across endpoints.
function listAllDeliveries({ endpoint = null, status = null, limit = 100 } = {}) {
  const out = [];
  if (!existsSync(WEBHOOKS_DIR)) return out;
  const names = endpoint
    ? [endpoint]
    : readdirSync(WEBHOOKS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
  for (const name of names) {
    for (const entry of readDeliveries(name)) {
      if (status && entry.status !== status) continue;
      out.push({ endpoint: name, ...entry });
    }
  }
  out.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  return out.slice(0, limit);
}
export { listAllDeliveries };
function resolveNgrokBin() {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "where" : "which";
  const target = isWin ? "ngrok.exe" : "ngrok";
  try {
    const r = spawnSync(cmd, [target], { encoding: "utf8", windowsHide: true, timeout: 5e3 });
    const resolved = (r.stdout || "").trim().split(/\r?\n/)[0];
    if (r.status === 0 && resolved) return resolved;
  } catch {
  }
  // Fallback: check common install locations
  if (isWin) {
    const wingetBase = join(homedir(), "AppData", "Local", "Microsoft", "WinGet", "Packages");
    try {
      const dirs = readdirSync(wingetBase).filter(d => d.startsWith("Ngrok.Ngrok"));
      for (const d of dirs) {
        const p = join(wingetBase, d, "ngrok.exe");
        if (existsSync(p)) return p;
      }
    } catch {}
  }
  return null;
}
const NGROK_META_FILE = join(DATA_DIR, "ngrok-meta.json");
const NGROK_OLD_PID_FILE = join(DATA_DIR, "ngrok.pid");
const NGROK_MAX_AGE_MS = 24 * 60 * 60 * 1e3; // 24 hours

function normalizeDomain(d) {
  if (!d) return '';
  try { return new URL(d.includes('://') ? d : 'https://' + d).hostname.toLowerCase() } catch { return d.toLowerCase().replace(/^https?:\/\//, '').split('/')[0] }
}

function readNgrokMeta() {
  try { return JSON.parse(readFileSync(NGROK_META_FILE, 'utf8')) } catch {}
  // Migration: read old pid file if meta doesn't exist
  try {
    const pid = parseInt(readFileSync(NGROK_OLD_PID_FILE, 'utf8').trim());
    if (pid > 0) {
      logWebhook(`migrating ngrok.pid (PID ${pid}) to ngrok-meta.json`);
      const meta = { pid, domain: '', port: 0, startedAt: new Date().toISOString() };
      writeNgrokMeta(meta);
      try { unlinkSync(NGROK_OLD_PID_FILE) } catch {}
      return meta;
    }
  } catch {}
  return null;
}
function writeNgrokMeta(meta) {
  try { writeFileSync(NGROK_META_FILE, JSON.stringify(meta, null, 2)) } catch {}
}
function clearNgrokMeta() {
  try { unlinkSync(NGROK_META_FILE) } catch {}
  try { unlinkSync(NGROK_OLD_PID_FILE) } catch {} // clean up legacy
}

function checkNgrokHealth(expectedDomain) {
  try {
    return new Promise((resolve) => {
      const req = http.get("http://localhost:4040/api/tunnels", { timeout: 2000 }, (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try {
            const tunnels = JSON.parse(data).tunnels || [];
            const expected = normalizeDomain(expectedDomain);
            const match = tunnels.some(t => normalizeDomain(t.public_url) === expected);
            resolve(match);
          } catch { resolve(false); }
        });
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
    });
  } catch { return Promise.resolve(false); }
}

class WebhookServer {
  config;
  server = null;
  eventPipeline = null;
  bridgeDispatch = null;
  boundPort = 0;
  noSecretWarned = false;
  ngrokProcess = null;
  ngrokStarting = false;
  quiet = null;
  // ctor accepts the TOP-LEVEL normalized config slice as the second arg:
  //   new WebhookServer(config.webhook, { quiet: config.quiet })
  constructor(config, topLevel) {
    this.config = config;
    this._applyTopLevel(topLevel);
  }
  _applyTopLevel(src) {
    this.quiet = null;
    if (!src || typeof src !== "object") return;
    if (src.quiet && typeof src.quiet === "object") {
      this.quiet = src.quiet;
    }
  }
  setEventPipeline(pipeline) {
    this.eventPipeline = pipeline;
  }
  // fn({ role, prompt, cwd, context }) — invoked for delegate-mode webhooks.
  // Wired from src/channels/index.mjs to call agent.handleToolCall('bridge')
  // with a notifyFn that forwards bridge output as a channel notification.
  setBridgeDispatch(fn) {
    this.bridgeDispatch = typeof fn === "function" ? fn : null;
  }
  // ── HTTP server ───────────────────────────────────────────────────
  start() {
    if (this.server) return;
    this.server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/webhook/")) {
        const name = req.url.slice("/webhook/".length).split("?")[0];
        let body = "";
        let bodyBytes = 0;
        // 5 MB body cap. GitHub webhook payload limit is 25 MB but we never
        // need that — install/push events fit well under 1 MB. A larger body
        // is either a misconfigured sender or a memory-exhaustion probe.
        const MAX_BODY_BYTES = 5 * 1024 * 1024;
        let bodyTooLarge = false;
        req.on("data", (chunk) => {
          if (bodyTooLarge) return;
          bodyBytes += chunk.length;
          if (bodyBytes > MAX_BODY_BYTES) {
            bodyTooLarge = true;
            try {
              res.writeHead(413, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "payload too large", limit: MAX_BODY_BYTES }));
            } catch {}
            try { req.destroy(); } catch {}
            return;
          }
          body += chunk;
        });
        req.on("end", () => {
          if (bodyTooLarge) return;
          try {
            const headers = {};
            for (const [k, v] of Object.entries(req.headers)) {
              if (typeof v === "string") headers[k.toLowerCase()] = v;
            }
            // Secret lookup: per-endpoint (folder config.json) → global (webhook config) → warn+accept.
            // Parser likewise prefers per-endpoint, falls back to global endpoints map.
            const endpoint = loadEndpointConfig(name) || this.config.endpoints?.[name] || null;
            const secret = endpoint?.secret || this.config.secret;
            const parser = endpoint?.parser || this.config.endpoints?.[name]?.parser;
            if (secret) {
              const signature = extractSignature(headers, parser);
              if (!signature) {
                logWebhook(`${name}: rejected \u2014 no signature header found`);
                res.writeHead(403, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "missing signature" }));
                return;
              }
              if (!verifySignature(secret, body, signature, parser)) {
                logWebhook(`${name}: rejected \u2014 signature mismatch`);
                res.writeHead(403, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "invalid signature" }));
                return;
              }
            } else {
              // Fail closed: if a parser is explicitly configured (implying a
              // signed integration), reject unsigned requests with 401.
              if (parser) {
                logWebhook(`${name}: rejected \u2014 parser "${parser}" configured but no secret set`);
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "webhook secret required for signed parser" }));
                return;
              }
              if (!this.noSecretWarned) {
                this.noSecretWarned = true;
                logWebhook(`warning \u2014 no webhook secret configured, skipping signature verification`);
              }
            }
            // Delivery ID + dedup. If a prior delivery with status=done
            // exists for this ID, skip with 200 {status:"dedup"} so the
            // sender (GitHub etc.) stops retrying the same event.
            const deliveryId = extractDeliveryId(headers) || `gen-${randomUUID()}`;
            // Any existing delivery row (pending / processing / done /
            // failed) means we have already accepted this event id at least
            // once. Reject the replay flat so a fast-retrying sender cannot
            // double-dispatch while the first run is still in flight.
            if (deliveryExists(name, deliveryId)) {
              logWebhook(`${name}: dedup ${deliveryId}`);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "dedup", id: deliveryId }));
              return;
            }
            // Atomic claim: write a `received` row before any further work so
            // a concurrent duplicate POST that arrives after this point hits
            // deliveryExists() above and is rejected.
            appendDelivery(name, { id: deliveryId, endpoint: name, status: "received" });
            // JSON content-type gate. Webhook handlers below assume parsed is
            // a plain object; an x-www-form-urlencoded body would parse to a
            // string and let downstream `parsed?.action` lookups silently miss
            // the actionable-event filter.
            const ctype = String(headers["content-type"] || "").toLowerCase();
            const looksJson = ctype.includes("application/json") || ctype.includes("+json");
            if (body && !looksJson) {
              logWebhook(`${name}: rejected — non-JSON content-type "${ctype || "<none>"}"`);
              res.writeHead(415, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "unsupported content-type", expected: "application/json" }));
              return;
            }
            const parsed = body ? JSON.parse(body) : {};
            const eventType = headers["x-github-event"] || null;
            const eventAction = parsed?.action || null;
            if (!isActionableEvent(eventType, eventAction)) {
              logWebhook(`${name}: skip event=${eventType || "<none>"} action=${eventAction || "<none>"} (id=${deliveryId})`);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "skip", event: eventType, action: eventAction, id: deliveryId }));
              return;
            }
            // Quiet-hours skip: drop (do not queue) when webhook opt-in is on
            // and current time falls inside the shared quiet window.
            const webhookRespect = this.config?.respectQuiet === true;
            const quietCfg = this.quiet
              ? { schedule: this.quiet.schedule ?? null, holidays: this.quiet.holidays === true }
              : null;
            if (webhookRespect && quietCfg && isInQuietWindow(quietCfg, new Date())) {
              logWebhook(`${name}: quiet-skip event=${eventType || "<none>"} action=${eventAction || "<none>"} (id=${deliveryId})`);
              res.writeHead(202, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "quiet-skip", event: eventType, action: eventAction, id: deliveryId }));
              return;
            }
            appendDelivery(name, {
              id: deliveryId,
              status: "pending",
              event: eventType,
              headersSummary: buildHeadersSummary(headers),
              payloadPreview: String(body || "").slice(0, 512),
            });
            this.handleWebhook(name, parsed, headers, res, deliveryId);
          } catch (err) {
            logWebhook(`JSON parse error for ${name}: ${err}`);
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid JSON" }));
          }
        });
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });
    const basePort = this.config.port || 3333;
    const maxPort = basePort + 7;
    let currentPort = basePort;
    const tryListen = () => {
      this.server.listen(currentPort, () => {
        this.boundPort = currentPort;
        logWebhook(`listening on port ${currentPort}`);
      });
    };
    this.server.on("error", (err) => {
      if (err.code === "EADDRINUSE" && currentPort < maxPort) {
        logWebhook(`port ${currentPort} already in use, trying ${currentPort + 1}`);
        currentPort++;
        tryListen();
      } else if (err.code === "EADDRINUSE") {
        logWebhook(`all ports ${basePort}-${maxPort} in use \u2014 webhook server disabled`);
        this.server = null;
      }
    });
    tryListen();
    this.startNgrok();
  }
  /**
   * Check if a previous ngrok process can be reused.
   * Returns true if the existing ngrok is alive, healthy, and serving the right domain.
   * Returns false (and kills the old process if needed) otherwise.
   */
  async reclaimOrKillNgrok(domain) {
    const meta = readNgrokMeta();
    if (!meta || !(meta.pid > 0)) {
      clearNgrokMeta();
      return false;
    }

    const { pid } = meta;

    // Metadata domain mismatch — different config, kill
    if (meta.domain && normalizeDomain(meta.domain) !== normalizeDomain(domain)) {
      logWebhook(`ngrok meta domain mismatch (${meta.domain} vs ${domain}), killing PID ${pid}`);
      try { process.kill(pid); } catch {}
      clearNgrokMeta();
      return false;
    }

    // Stale check — older than 24 hours
    if (meta.startedAt && (Date.now() - new Date(meta.startedAt).getTime()) > NGROK_MAX_AGE_MS) {
      logWebhook(`ngrok meta stale (started ${meta.startedAt}), killing PID ${pid}`);
      try { process.kill(pid); } catch {}
      clearNgrokMeta();
      return false;
    }

    // Check if process is alive
    let alive = false;
    try { process.kill(pid, 0); alive = true } catch {}

    if (!alive) {
      logWebhook(`ngrok PID ${pid} is dead, cleaning up`);
      clearNgrokMeta();
      return false;
    }

    // Process alive + domain matches — verify tunnel via 4040 API
    const healthy = await checkNgrokHealth(domain);
    if (healthy) {
      logWebhook(`reusing ngrok (PID ${pid}, domain ${domain}, port ${meta.port})`);
      return true;
    }

    // Alive but tunnel unhealthy — kill
    logWebhook(`ngrok PID ${pid} alive but tunnel unhealthy, killing`);
    try { process.kill(pid); } catch {}
    clearNgrokMeta();
    return false;
  }
  async startNgrok() {
    if (this.ngrokProcess || this.ngrokStarting) return;
    const authtoken = this.config.authtoken;
    const domain = this.config.ngrokDomain || this.config.domain;
    if (!authtoken || !domain) return;
    this.ngrokStarting = true;

    // Try to reuse an existing ngrok process
    const reused = await this.reclaimOrKillNgrok(domain);
    if (reused) {
      this.ngrokStarting = false;
      return;
    }

    const ngrokBin = resolveNgrokBin();
    if (!ngrokBin) {
      logWebhook("ngrok binary not found \u2014 webhook tunnel disabled");
      this.ngrokStarting = false;
      return;
    }
    spawnSync(ngrokBin, ["config", "add-authtoken", authtoken], { stdio: "ignore", timeout: 1e4, windowsHide: true });
    let attempts = 0;
    const waitAndStart = () => {
      if (!this.boundPort) {
        if (++attempts > 30) {
          logWebhook("ngrok: gave up waiting for port");
          this.ngrokStarting = false;
          return;
        }
        setTimeout(waitAndStart, 500);
        return;
      }
      try {
        this.ngrokProcess = spawn(ngrokBin, ["http", String(this.boundPort), "--url=" + domain], {
          stdio: "ignore",
          windowsHide: true,
          detached: true
        });
        this.ngrokProcess.unref();
        if (this.ngrokProcess.pid) {
          writeNgrokMeta({
            pid: this.ngrokProcess.pid,
            domain,
            port: this.boundPort,
            startedAt: new Date().toISOString(),
            binaryPath: ngrokBin,
          });
        }
        this.ngrokProcess.on("exit", () => {
          this.ngrokProcess = null;
          this.ngrokStarting = false;
          clearNgrokMeta();
        });
        this.ngrokProcess.on("error", () => {
          this.ngrokProcess = null;
          this.ngrokStarting = false;
          clearNgrokMeta();
        });
        logWebhook(`ngrok tunnel started: ${domain} \u2192 localhost:${this.boundPort} (PID ${this.ngrokProcess.pid})`);
      } catch (e) {
        logWebhook(`ngrok start failed: ${e}`);
      }
      this.ngrokStarting = false;
    };
    setTimeout(waitAndStart, 1e3);
  }
  stop() {
    // Intentionally do NOT kill ngrok — let it survive across MCP restarts.
    // The next start() will reuse it via reclaimOrKillNgrok().
    if (this.ngrokProcess) {
      this.ngrokProcess = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    logWebhook("stopped (ngrok left running for reuse)");
  }
  // reloadConfig(webhookCfg, topLevel, options?)
  // `topLevel` mirrors the constructor: a top-level normalized config
  // slice (typically `{ quiet }`).
  reloadConfig(config, topLevel, options = {}) {
    this.stop();
    this.config = config;
    this._applyTopLevel(topLevel);
    if (options.autoStart !== false && config.enabled) this.start();
  }
  // ── Delegate analysis via unified LLM runner ────────────────────────
  // delegateAnalysis removed — delegate mode now invokes bridge directly
  // via setBridgeDispatch(). See handleWebhook below.
  // ── Webhook handler ───────────────────────────────────────────────
  handleWebhook(name, body, headers, res, deliveryId) {
    const folderPath = join(WEBHOOKS_DIR, name);
    const instructionsPath = join(folderPath, "instructions.md");
    if (existsSync(instructionsPath)) {
      try {
        const instructions = readFileSync(instructionsPath, "utf8").trim();
        let channel = "main";
        let mode = "interactive";
        let role = null;
        const configPath = join(folderPath, "config.json");
        if (existsSync(configPath)) {
          try {
            const cfg = JSON.parse(readFileSync(configPath, "utf8"));
            if (cfg.channel) channel = cfg.channel;
            if (cfg.mode === "delegate" || cfg.mode === "interactive") mode = cfg.mode;
            if (typeof cfg.role === "string" && cfg.role) role = cfg.role;
          } catch {
          }
        }
        const payload = JSON.stringify(body, null, 2);
        const headersSummary = Object.entries(headers).filter(([k]) => k.startsWith("x-") || k === "content-type").map(([k, v]) => `${k}: ${v}`).join("\n");
        const payloadContent = `--- Webhook Headers ---
${headersSummary}

--- Webhook Payload ---
${payload}`;
        if (mode === "delegate") {
          if (!role) {
            logWebhook(`${name}: delegate mode requires role \u2014 falling back to interactive`);
            mode = "interactive";
          } else if (!this.bridgeDispatch) {
            logWebhook(`${name}: delegate mode but no bridge dispatch wired \u2014 falling back to interactive`);
            mode = "interactive";
          } else {
            appendDelivery(name, { id: deliveryId, status: "processing" });
            const fullPrompt = `${instructions}\n\n${payloadContent}`;
            // Bridge dispatch must not be allowed to hang forever — without a
            // ceiling a stuck LLM call leaves the delivery in `processing`
            // for the lifetime of the process and dedup keeps re-running
            // forever. 10 minutes covers the slowest delegate task we ship.
            const DISPATCH_TIMEOUT_MS = 10 * 60 * 1000;
            let timeoutHandle = null;
            const dispatchP = Promise.resolve(this.bridgeDispatch({
              role,
              prompt: fullPrompt,
              cwd: this.config?.cwd,
              context: {
                source: "webhook",
                endpoint: name,
                deliveryId,
                event: headers["x-github-event"] || null,
              },
            }));
            const timeoutP = new Promise((_, reject) => {
              timeoutHandle = setTimeout(
                () => reject(new Error(`bridge dispatch timed out after ${DISPATCH_TIMEOUT_MS}ms`)),
                DISPATCH_TIMEOUT_MS,
              );
            });
            Promise.race([dispatchP, timeoutP]).then(() => {
              if (timeoutHandle) clearTimeout(timeoutHandle);
              appendDelivery(name, { id: deliveryId, status: "done" });
              logWebhook(`${name}: delegate dispatched to bridge (role=${role}, id=${deliveryId})`);
            }).catch((err) => {
              if (timeoutHandle) clearTimeout(timeoutHandle);
              appendDelivery(name, { id: deliveryId, status: "failed", error: String(err?.message || err) });
              logWebhook(`${name}: delegate dispatch failed: ${err?.message || err}`);
            });
            res.writeHead(202, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "accepted", handler: "delegate", id: deliveryId }));
            return;
          }
        }
        if (this.eventPipeline) {
          appendDelivery(name, { id: deliveryId, status: "processing" });
          this.eventPipeline.enqueueDirect(name, payloadContent, channel, "interactive", instructions);
          appendDelivery(name, { id: deliveryId, status: "done" });
          logWebhook(`${name}: interactive enqueued (id=${deliveryId})`);
        }
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "accepted", handler: "interactive", id: deliveryId }));
        return;
      } catch (err) {
        appendDelivery(name, { id: deliveryId, status: "failed", error: String(err?.message || err) });
        logWebhook(`${name}: folder handler error: ${err}`);
      }
    }
    if (this.eventPipeline?.handleWebhook(name, body, headers)) {
      appendDelivery(name, { id: deliveryId, status: "done" });
      logWebhook(`${name}: routed to event pipeline (id=${deliveryId})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "accepted", id: deliveryId }));
      return;
    }
    appendDelivery(name, { id: deliveryId, status: "failed", error: "unknown endpoint" });
    logWebhook(`unknown endpoint: ${name}`);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unknown endpoint" }));
  }
  /** Get the webhook URL for an endpoint name */
  getUrl(name) {
    if (this.config.ngrokDomain) {
      return `https://${this.config.ngrokDomain}/webhook/${name}`;
    }
    return `http://localhost:${this.boundPort || this.config.port}/webhook/${name}`;
  }
}
export {
  WebhookServer
};
