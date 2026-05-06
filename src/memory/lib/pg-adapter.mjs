// pg-adapter.mjs — PG connection manager for mixdog 0.4.0
// Single owner: supervisor-pg.ensurePgInstance(dataDir) starts PG.
// pg-adapter calls supervisor-pg — never pg-process directly.
//
// Public API:
//   ensurePgInstance(dataDir, { schema? }) → { db, pool, host, port, runtimeDir, pgdataDir }
//   closePgInstance(dataDir)               → void
//
// The returned `db` exposes the PGlite-compatible surface:
//   db.query(sql, params?)          → { rows, rowCount }
//   db.exec(sql)                    → multi-statement; resolves on completion
//   db.transaction(async tx => …)  → auto BEGIN/COMMIT, ROLLBACK on throw
//   db.waitReady                    → resolved Promise (compat shim)

import { resolve } from 'path'
import { ensurePgInstance as supervisorEnsure } from './supervisor-pg.mjs'

// ---------------------------------------------------------------------------
// One-shot bootstrap guard — keyed by resolved dataDir (cluster-level, not schema)
// ---------------------------------------------------------------------------

const _bootstrapped = new Set()

// ---------------------------------------------------------------------------
// In-process cache
// ---------------------------------------------------------------------------

const instances = new Map() // `${dataDir}|${schema}` → instance handle
const opening   = new Map() // same key → Promise (dedupe concurrent calls)

// ---------------------------------------------------------------------------
// Per-connection init — WeakSet-guarded so settings run exactly once per client
// ---------------------------------------------------------------------------

const _clientInited = new WeakSet()

async function _initClient(client, schema) {
  if (_clientInited.has(client)) return
  // Set search_path so unqualified table names resolve to the correct schema.
  const sp = schema === 'trace' ? 'trace, public' : 'memory, public'
  await client.query(`SET search_path = ${sp}`)
  // pg_trgm similarity threshold: session-local, must be set per connection.
  await client.query(`SELECT set_limit(0.10)`)
  await client.query(`SET default_transaction_isolation TO 'read committed'`)
  // Mark seen only after all init statements succeed; failure leaves client
  // unmarked so the next checkout retries init.
  _clientInited.add(client)
}

// Wrapper around pool.connect() that runs per-client init before returning.
async function _checkedConnect(pgPool, schema) {
  const client = await pgPool.connect()
  try {
    await _initClient(client, schema)
  } catch (e) {
    client.release()
    throw e
  }
  return client
}

// ---------------------------------------------------------------------------
// PGlite-compatible db shim
// ---------------------------------------------------------------------------

function makeCompatDb(pgPool, schema) {
  const db = {
    // waitReady: resolved immediately (PGlite compat — pool is already up)
    waitReady: Promise.resolve(),

    // query: use pool directly for single-statement queries
    query: async (sql, params) => {
      const client = await _checkedConnect(pgPool, schema)
      try {
        return await client.query(sql, params)
      } finally {
        client.release()
      }
    },

    // exec: multi-statement SQL (semicolon-separated); single client for session state
    exec: async (sql) => {
      const client = await _checkedConnect(pgPool, schema)
      try {
        await client.query(sql)
      } finally {
        client.release()
      }
    },

    // transaction: check out one client, BEGIN, run callback(tx), COMMIT or ROLLBACK
    transaction: async (fn) => {
      const client = await _checkedConnect(pgPool, schema)
      try {
        await client.query('BEGIN')
        const tx = {
          query: (sql, params) => client.query(sql, params),
          exec:  (sql)         => client.query(sql),
        }
        const result = await fn(tx)
        await client.query('COMMIT')
        return result
      } catch (err) {
        try { await client.query('ROLLBACK') } catch {}
        throw err
      } finally {
        client.release()
      }
    },

    // close: drain pool
    close: () => pgPool.end(),

    // Internal access for callers that need raw pool
    _pool: pgPool,
  }
  return db
}

// ---------------------------------------------------------------------------
// Instance bootstrap — extensions + schemas (idempotent)
// ---------------------------------------------------------------------------

async function bootstrapInstance(pgPool, dataDirKey) {
  if (_bootstrapped.has(dataDirKey)) return
  // Use a raw client bypassing per-client schema settings (bootstrap targets
  // the cluster level, not a specific schema).
  const client = await pgPool.connect()
  try {
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public`)
    await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public`)
    await client.query(`CREATE SCHEMA IF NOT EXISTS memory`)
    await client.query(`CREATE SCHEMA IF NOT EXISTS trace`)
  } finally {
    client.release()
  }
  _bootstrapped.add(dataDirKey)
}

// ---------------------------------------------------------------------------
// ensurePgInstance — public API
// ---------------------------------------------------------------------------

/**
 * Ensure a live PG instance and return a PGlite-compatible db handle.
 *
 * @param {string} dataDir      Plugin data directory.
 * @param {{ schema?: 'memory' | 'trace' }} [opts]
 * @returns {Promise<{ db, pool, host, port, runtimeDir, pgdataDir }>}
 */
export async function ensurePgInstance(dataDir, opts = {}) {
  const schema = opts.schema ?? 'memory'
  const key    = `${resolve(dataDir)}|${schema}`

  if (instances.has(key)) return instances.get(key)
  if (opening.has(key))   return opening.get(key)

  const promise = (async () => {
    // 1. Let supervisor-pg own PG startup and health-checking.
    //    Returns { host, port, runtimeDir, pgdataDir }.
    const { host, port, runtimeDir, pgdataDir } = await supervisorEnsure(dataDir)

    // 2. Connect via node-postgres; auto-create the mixdog database if absent.
    const { default: pg } = await import('pg')

    const PG_USER = 'postgres'
    const PG_DB   = 'mixdog'

    const adminPool = new pg.Pool({
      host, port, user: PG_USER, database: 'postgres',
      password: '', max: 1, idleTimeoutMillis: 5_000,
    })
    try {
      const r = await adminPool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [PG_DB])
      if (r.rows.length === 0) {
        await adminPool.query(`CREATE DATABASE ${PG_DB}`)
        process.stderr.write(`[pg-adapter] created database ${PG_DB}\n`)
      }
    } finally {
      await adminPool.end()
    }

    // 3. Production pool.
    const pgPool = new pg.Pool({
      host, port, user: PG_USER, database: PG_DB,
      password: '', max: 5, idleTimeoutMillis: 30_000,
    })

    // 4. Bootstrap extensions + schemas once (idempotent).
    await bootstrapInstance(pgPool, resolve(dataDir))

    // 5. Build the compat db shim.
    const db = makeCompatDb(pgPool, schema)

    const result = { db, pool: pgPool, host, port, runtimeDir, pgdataDir }
    instances.set(key, result)
    return result
  })()

  opening.set(key, promise)
  try {
    return await promise
  } finally {
    opening.delete(key)
  }
}

// ---------------------------------------------------------------------------
// closePgInstance — drain pool
// ---------------------------------------------------------------------------

export async function closePgInstance(dataDir, opts = {}) {
  const schema = opts.schema ?? 'memory'
  const key    = `${resolve(dataDir)}|${schema}`
  const inst   = instances.get(key)
  if (!inst) return
  try { await inst.pool.end() } catch {}
  instances.delete(key)
}
