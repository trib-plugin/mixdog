#!/usr/bin/env bun
// Thin entry. node: built-in 모듈만 쓰는 prelude로 active-instance.json을
// 가능한 가장 이른 시점에 등록한 뒤, server-main.mjs를 동적 import한다.
//
// ES module import hoisting 때문에, heavy module을 같은 파일에 정적으로
// import하면 prelude가 그 뒤로 밀린다. 동적 import로만 분리 가능.
import { createServer } from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

process.stderr.write(`[boot-time] tag=server-prelude-entry tMs=${Date.now()}\n`)

// ── PLUGIN_DATA 해석 (lib/plugin-paths.cjs와 동일 규칙: env 우선) ─────
const PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin')
fs.mkdirSync(PLUGIN_DATA, { recursive: true })

// ── Singleton lock (server.mjs:46~74에서 hoist) ─────────────────────
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
  // active-instance.json도 우리 소유면 정리 (graceful shutdown은 channels의
  // clearActiveInstance가 먼저 처리하지만, 충돌/early-exit 케이스 방어).
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
// startOwnerHttpServer가 이 서버를 그대로 입양해서 본 핸들러를 attach한다.
// 그 전까지는 503 stub만 응답. probeTcpPort는 TCP connect만 검사하므로 충분.
const __beacon = createServer((req, res) => {
  const real = globalThis.__mixdogBeaconRealHandler
  if (typeof real === 'function') return real(req, res)
  res.statusCode = 503
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ ok: false, reason: 'booting' }))
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
  // 모두 점유 시 OS 할당 fallback
  return await new Promise((resolve, reject) => {
    __beacon.once('error', reject)
    __beacon.listen(0, '127.0.0.1', () => resolve(__beacon.address().port))
  })
}
const __beaconPort = await bindBeacon()

// ── active-instance.json 즉시 기록 ───────────────────────────────────
// channels 모듈의 buildActiveInstanceState와 동일 schema. instanceId는
// makeInstanceId() = String(pid) 규약을 따름. (sanitize 정규식
// /[^a-zA-Z0-9._-]/g 기준 numeric PID는 no-op.)
const __activeDir = path.join(os.tmpdir(), 'mixdog')
fs.mkdirSync(__activeDir, { recursive: true })
const __activeFile = path.join(__activeDir, 'active-instance.json')
const __instanceId = String(process.pid)

// Fix B — split-brain 가드: 기존 파일이 살아있는 다른 PID를 가리키면 경고.
// (server.lock을 통과한 시점이므로 우리가 정당한 owner. 덮어쓰되 흔적 남김.)
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

// ── 본 서버 진입 ─────────────────────────────────────────────────────
await import('./server-main.mjs')
