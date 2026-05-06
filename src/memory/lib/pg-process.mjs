// pg-process.mjs — lower-level PG lifecycle helpers for mixdog 0.4.0
// Track B can wire these into the supervisor; pg-adapter calls them directly.
//
// Public API:
//   startPg({ runtimeDir, pgdataDir, port?, logPath? }) → { pid, port }
//   stopPg({ runtimeDir, pgdataDir })                   → void
//   healthcheckPg({ port, host? })                      → boolean

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { createConnection } from 'net'
import { createServer } from 'net'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pgBin(runtimeDir, name) {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return join(runtimeDir, 'bin', `${name}${ext}`)
}

function libEnv(runtimeDir) {
  // Bundled shared libraries must be visible to the PG binaries at runtime.
  const libDir = join(runtimeDir, 'lib')
  if (process.platform === 'linux') {
    return { ...process.env, LD_LIBRARY_PATH: libDir }
  }
  if (process.platform === 'darwin') {
    return { ...process.env, DYLD_LIBRARY_PATH: libDir }
  }
  // win32: DLLs live in bin/ — add to PATH.
  return { ...process.env, PATH: `${join(runtimeDir, 'bin')};${process.env.PATH}` }
}

// ---------------------------------------------------------------------------
// Free port detection
// ---------------------------------------------------------------------------

function isTcpPortFree(port) {
  return new Promise(resolve => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => { srv.close(); resolve(true) })
    srv.listen(port, '127.0.0.1')
  })
}

const PG_PORT_MIN = 55432
const PG_PORT_MAX = 55632

async function findFreePort(preferred) {
  // I2: clamp out-of-range callers to the valid window.
  if (preferred < PG_PORT_MIN || preferred > PG_PORT_MAX) preferred = PG_PORT_MIN
  if (await isTcpPortFree(preferred)) return preferred
  for (let p = preferred + 1; p <= PG_PORT_MAX; p++) {
    if (await isTcpPortFree(p)) return p
  }
  throw new Error(`[pg-process] no free port found in range ${preferred}–${PG_PORT_MAX}`)
}

// ---------------------------------------------------------------------------
// startPg
// ---------------------------------------------------------------------------

export async function startPg({ runtimeDir, pgdataDir, port: preferredPort = 55432, logPath }) {
  mkdirSync(pgdataDir, { recursive: true })

  const env    = libEnv(runtimeDir)
  const initdb = pgBin(runtimeDir, 'initdb')
  const pgctl  = pgBin(runtimeDir, 'pg_ctl')

  // initdb if pgdata is not yet initialised (no PG_VERSION file).
  const pgVersionFile = join(pgdataDir, 'PG_VERSION')
  if (!existsSync(pgVersionFile)) {
    process.stderr.write(`[pg-process] initdb → ${pgdataDir}\n`)
    const r = spawnSync(initdb, [
      '-D', pgdataDir,
      '--auth-local=trust',
      '--no-locale',
      '-E', 'UTF8',
      '-U', 'postgres',
    ], { env, stdio: 'pipe' })

    if (r.status !== 0) {
      throw new Error(`[pg-process] initdb failed: ${r.stderr?.toString() || r.stdout?.toString()}`)
    }

    // Append mixdog-specific postgresql.conf overrides.
    // default_transaction_isolation: native PG default is read committed.
    // PGlite used serializable; callers must not rely on that — set explicitly
    // so behaviour is unambiguous across PG major versions.
    const confPath   = join(pgdataDir, 'postgresql.conf')
    const confAppend = [
      '',
      '# mixdog overrides — appended by pg-process.mjs',
      "default_transaction_isolation = 'read committed'",
      "listen_addresses = '127.0.0.1'",
      'log_min_messages = warning',
      'log_line_prefix = \'%t [%p]: \'',
    ].join('\n') + '\n'

    try {
      const existing = readFileSync(confPath, 'utf8')
      writeFileSync(confPath, existing + confAppend)
    } catch (e) {
      process.stderr.write(`[pg-process] postgresql.conf append failed: ${e?.message}\n`)
    }
  }

  // Choose a free port (guards against stale postmaster from prior crash).
  const port    = await findFreePort(preferredPort)
  const logFile = logPath ?? join(pgdataDir, 'pg.log')

  process.stderr.write(`[pg-process] pg_ctl start -D ${pgdataDir} -p ${port}\n`)

  const r = spawnSync(pgctl, [
    'start', '-w',
    '-D', pgdataDir,
    '-l', logFile,
    '-o', `-p ${port} -h 127.0.0.1`,
  ], { env, stdio: 'pipe', timeout: 30_000 })

  if (r.status !== 0) {
    throw new Error(`[pg-process] pg_ctl start failed: ${r.stderr?.toString() || r.stdout?.toString()}`)
  }

  // Read PID from postmaster.pid (first line).
  let pid = null
  try {
    const pidFile = join(pgdataDir, 'postmaster.pid')
    if (existsSync(pidFile)) {
      pid = parseInt(readFileSync(pidFile, 'utf8').split('\n')[0], 10) || null
    }
  } catch {}

  return { pid, port }
}

// ---------------------------------------------------------------------------
// stopPg
// ---------------------------------------------------------------------------

export async function stopPg({ runtimeDir, pgdataDir }) {
  const pgctl = pgBin(runtimeDir, 'pg_ctl')
  const env   = libEnv(runtimeDir)

  const r = spawnSync(pgctl, ['stop', '-m', 'fast', '-w', '-D', pgdataDir], {
    env,
    stdio: 'pipe',
    timeout: 15_000,
  })

  if (r.status !== 0) {
    const msg = r.stderr?.toString() || r.stdout?.toString() || ''
    // Stale postmaster.pid — PG is already down; clean up and continue.
    if (
      msg.includes('no server running') ||
      msg.includes('PID file') ||
      msg.includes('not running')
    ) {
      process.stderr.write(`[pg-process] stopPg: already stopped (${msg.slice(0, 80)})\n`)
      try { rmSync(join(pgdataDir, 'postmaster.pid'), { force: true }) } catch {}
    } else {
      process.stderr.write(`[pg-process] pg_ctl stop warning: ${msg}\n`)
    }
  }
}

// ---------------------------------------------------------------------------
// healthcheckPg
// ---------------------------------------------------------------------------

export async function healthcheckPg({ port, host = '127.0.0.1' }) {
  // Phase 1: TCP listen check (fast, no PG client dependency).
  const tcpOk = await new Promise(resolve => {
    const sock = createConnection({ host, port })
    sock.setTimeout(1000)
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error',   () => { sock.destroy(); resolve(false) })
    sock.once('timeout', () => { sock.destroy(); resolve(false) })
  })
  if (!tcpOk) return false

  // Phase 2: SELECT 1 via a transient pg client.
  try {
    const { default: pg } = await import('pg')
    const client = new pg.Client({
      host, port, user: 'postgres', database: 'postgres', password: '',
      connectionTimeoutMillis: 2000,
    })
    await client.connect()
    await client.query('SELECT 1')
    await client.end()
    return true
  } catch {
    return false
  }
}
