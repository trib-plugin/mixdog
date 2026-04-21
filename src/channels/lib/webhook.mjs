import * as http from "http";
import * as crypto from "crypto";
import { join } from "path";
import { spawn, spawnSync } from "child_process";
import { DATA_DIR } from "./config.mjs";
import { appendFileSync, readFileSync, readdirSync, writeFileSync, unlinkSync, statSync, existsSync, watch as fsWatch } from "fs";
import { homedir } from "os";
const WEBHOOKS_DIR = join(DATA_DIR, "webhooks");
import { makeBridgeLlm } from '../../agent/orchestrator/smart-bridge/bridge-llm.mjs';

const webhookLlm = makeBridgeLlm({ taskType: 'webhook-handler', role: 'webhook-handler', sourceType: 'webhook' });
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
    return crypto.timingSafeEqual(Buffer.from(match[1], "hex"), Buffer.from(expected, "hex"));
  }
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureValue, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}

// ── Endpoint config loader ─────────────────────────────────────────────
// Reads DATA_DIR/webhooks/<name>/config.json (written by setup-server.mjs
// via POST /webhooks). Cached in-memory, invalidated by fs.watch on the
// webhooks directory. Returns { secret, parser, channel, exec, model, analyze }.
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
  boundPort = 0;
  noSecretWarned = false;
  ngrokProcess = null;
  ngrokStarting = false;
  constructor(config, _channelsConfig) {
    this.config = config;
  }
  setEventPipeline(pipeline) {
    this.eventPipeline = pipeline;
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
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
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
              if (!this.noSecretWarned) {
                this.noSecretWarned = true;
                logWebhook(`warning \u2014 no webhook secret configured, skipping signature verification`);
              }
            }
            const parsed = body ? JSON.parse(body) : {};
            this.handleWebhook(name, parsed, headers, res);
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
  reloadConfig(config, _channelsConfig, options = {}) {
    this.stop();
    this.config = config;
    if (options.autoStart !== false && config.enabled) this.start();
  }
  // ── Delegate analysis via unified LLM runner ────────────────────────
  async delegateAnalysis(name, prompt, model, channel, exec) {
    const presetId = model || 'sonnet-mid';
    try {
      const result = await webhookLlm({ prompt, preset: presetId, mode: 'active', timeout: 120000, sourceName: name });
      if (!result) {
        logWebhook(`${name}: delegate returned empty`);
        return;
      }
      logWebhook(`${name}: delegate done (${presetId}, ${result.length} chars)`);
      if (this.eventPipeline) {
        this.eventPipeline.enqueueDirect(name, result, channel, exec);
      }
    } catch (err) {
      logWebhook(`${name}: delegate error: ${err.message}`);
    }
  }
  // ── Webhook handler ───────────────────────────────────────────────
  handleWebhook(name, body, headers, res) {
    const folderPath = join(WEBHOOKS_DIR, name);
    const instructionsPath = join(folderPath, "instructions.md");
    if (existsSync(instructionsPath)) {
      try {
        const instructions = readFileSync(instructionsPath, "utf8").trim();
        let channel = "main";
        let exec = "interactive";
        let model = null;
        let analyze = false;
        const configPath = join(folderPath, "config.json");
        if (existsSync(configPath)) {
          try {
            const cfg = JSON.parse(readFileSync(configPath, "utf8"));
            if (cfg.channel) channel = cfg.channel;
            if (cfg.exec) exec = cfg.exec;
            if (cfg.model) model = cfg.model;
            if (cfg.analyze === true) analyze = true;
          } catch {
          }
        }
        const payload = JSON.stringify(body, null, 2);
        const headersSummary = Object.entries(headers).filter(([k]) => k.startsWith("x-") || k === "content-type").map(([k, v]) => `${k}: ${v}`).join("\n");
        const payloadContent = `--- Webhook Headers ---
${headersSummary}

--- Webhook Payload ---
${payload}`;
        const fullPrompt = `${instructions}

${payloadContent}`;
        if (analyze) {
          this.delegateAnalysis(name, fullPrompt, model, channel, exec);
          logWebhook(`${name}: folder-based \u2192 delegate (${model})`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "accepted", handler: "delegate" }));
          return;
        }
        if (this.eventPipeline) {
          this.eventPipeline.enqueueDirect(name, payloadContent, channel, exec, instructions);
          logWebhook(`${name}: folder-based \u2192 enqueued (${exec})`);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "accepted", handler: "folder" }));
        return;
      } catch (err) {
        logWebhook(`${name}: folder handler error: ${err}`);
      }
    }
    if (this.eventPipeline?.handleWebhook(name, body, headers)) {
      logWebhook(`${name}: routed to event pipeline`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "accepted" }));
      return;
    }
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
