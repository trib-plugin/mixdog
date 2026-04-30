#!/usr/bin/env bun
// Thin entry. A node:-builtin-only prelude registers active-instance.json
// as early as possible, then dynamically imports server-main.mjs.
//
// ES module import hoisting causes statically-imported heavy modules to
// push the prelude back. Dynamic import is the only way to isolate it.
import { createServer } from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

process.stderr.write(`[boot-time] tag=server-prelude-entry tMs=${Date.now()}\n`)

// ── Resolve PLUGIN_DATA (same rule as lib/plugin-paths.cjs: env wins) ─
const PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin')
fs.mkdirSync(PLUGIN_DATA, { recursive: true })

// ── Singleton lock (hoisted from server.mjs:46~74) ──────────────────
const LOCK_PATH = path.join(PLUGIN_DATA, 'server.lock')
function _isPidAlive(pid) {
  if (!pid || pid === process.pid) return false
  try { process.kill(pid, 0); return true }
  catch (err) { return err?.code === 'EPERM' }
}
try {
  if (fs.existsSync(LOCK_PATH)) {
    const raw = fs.readFileSync(LOCK_PATH, 'utf-8').trim()
    const existingPid = Number.parseInt(raw, 10)
    if (Number.isFinite(existingPid) && _isPidAlive(existingPid)) {
      process.stderr.write(`[server] another mixdog instance already running (pid=${existingPid}); exiting.\n`)
      process.exit(0)
    }
  }
} catch { /* malformed lock — overwrite below */ }
fs.writeFileSync(LOCK_PATH, String(process.pid))
const _releaseLock = () => {
  try {
    const raw = fs.readFileSync(LOCK_PATH, 'utf-8').trim()
    if (Number.parseInt(raw, 10) === process.pid) fs.unlinkSync(LOCK_PATH)
  } catch {}
  // Clean up active-instance.json if we own it (graceful shutdown is
  // normally handled by channels' clearActiveInstance; this guards crash / early-exit cases).
  try {
    const __af = path.join(os.tmpdir(), 'mixdog', 'active-instance.json')
    const cur = JSON.parse(fs.readFileSync(__af, 'utf-8'))
    if (cur && cur.pid === process.pid) fs.unlinkSync(__af)
  } catch {}
}
process.on('exit', _releaseLock)
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => { _releaseLock(); process.exit(0) }) } catch {}
}

// ── Beacon HTTP server ───────────────────────────────────────────────
// startOwnerHttpServer adopts this server as-is and attaches the real handler.
// Until then we respond with a 503 stub. probeTcpPort only checks TCP connect, so that suffices.
const __beacon = createServer((req, res) => {
  const real = globalThis.__mixdogBeaconRealHandler
  if (typeof real === 'function') return real(req, res)
  res.statusCode = 503
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ ok: false, reason: 'beacon-booting' }))
})

const PROXY_PORT_MIN = 3460
const PROXY_PORT_MAX = 3467
async function bindBeacon() {
  for (let port = PROXY_PORT_MIN; port <= PROXY_PORT_MAX; port++) {
    const ok = await new Promise((resolve) => {
      const onErr = () => { __beacon.removeListener('error', onErr); resolve(false) }
      __beacon.once('error', onErr)
      __beacon.listen(port, '127.0.0.1', () => {
        __beacon.removeListener('error', onErr)
        resolve(true)
      })
    })
    if (ok) return port
  }
  // All ports busy — fall back to OS allocation
  return await new Promise((resolve, reject) => {
    __beacon.once('error', reject)
    __beacon.listen(0, '127.0.0.1', () => resolve(__beacon.address().port))
  })
}
const __beaconPort = await bindBeacon()

// ── Write active-instance.json immediately ──────────────────────────
// Same schema as channels' buildActiveInstanceState. instanceId follows
// makeInstanceId() = String(pid). (Sanitize regex /[^a-zA-Z0-9._-]/g
// is a no-op for numeric PIDs.)
const __activeDir = path.join(os.tmpdir(), 'mixdog')
fs.mkdirSync(__activeDir, { recursive: true })
const __activeFile = path.join(__activeDir, 'active-instance.json')
const __instanceId = String(process.pid)

// Fix B — split-brain guard: warn if the existing file points to a different live PID.
// (Having passed server.lock means we are the legitimate owner. Overwrite but log a trace.)
try {
  if (fs.existsSync(__activeFile)) {
    const prev = JSON.parse(fs.readFileSync(__activeFile, 'utf-8'))
    if (prev && prev.pid && prev.pid !== process.pid) {
      try {
        process.kill(prev.pid, 0)
        process.stderr.write(
          `[server] split-brain warning: active-instance.json points to live PID ${prev.pid} ` +
          `but server.lock is ours — overwriting\n`
        )
      } catch { /* dead PID — fine */ }
    }
  }
} catch { /* malformed — overwrite */ }

const __nowMs = Date.now()
fs.writeFileSync(__activeFile, JSON.stringify({
  instanceId: __instanceId,
  pid: process.pid,
  startedAt: __nowMs,
  updatedAt: __nowMs,
  turnEndFile: path.join(__activeDir, `turn-end-${__instanceId}`),
  statusFile: path.join(__activeDir, `status-${__instanceId}.json`),
  httpPort: __beaconPort,
  backendReady: false,
  bootPhase: 'beacon',
}))

globalThis.__mixdogBeacon = { server: __beacon, httpPort: __beaconPort }
process.stderr.write(`[boot-time] tag=beacon-up port=${__beaconPort} tMs=${Date.now()}\n`)

// ── Enter the main server ───────────────────────────────────────────
await import('./server-main.mjs')
