// trace-store.mjs — separate PGlite instance for bridge-trace analytics.
// Keyed at <dataDir>/pgdata-trace/; isolated from the main memory PG instance.
// Phase 2: schema simplified (no watermark), insertTraceEvents added.

import { PGlite } from '../../../lib/vendored/pglite/dist/index.js'
import { mkdirSync, existsSync, renameSync, rmSync } from 'fs'
import { join, resolve } from 'path'

const dbs = new Map()
const opening = new Map()

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

async function init(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS trace_events (
      id                 BIGSERIAL PRIMARY KEY,
      ts                 BIGINT NOT NULL,
      session_id         TEXT,
      iteration          INTEGER,
      kind               TEXT NOT NULL,
      role               TEXT,
      model              TEXT,
      tool_name          TEXT,
      tool_ms            INTEGER,
      input_tokens       INTEGER,
      output_tokens      INTEGER,
      cached_tokens      INTEGER,
      cache_write_tokens INTEGER,
      duration_ms        INTEGER,
      error_message      TEXT,
      payload            JSONB NOT NULL
    )
  `)

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_ts          ON trace_events(ts DESC)`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_kind_ts     ON trace_events(kind, ts DESC)`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_session     ON trace_events(session_id, ts)`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_role_ts     ON trace_events(role, ts DESC)`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_model_ts    ON trace_events(model, ts DESC)`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_tool        ON trace_events(tool_name) WHERE kind = 'tool'`)
}

async function isBootstrapComplete(db) {
  try {
    const r = await db.query(
      `SELECT to_regclass('trace_events') AS t`,
    )
    return r.rows[0]?.t != null
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// openTraceDatabase — mirrors openDatabase pattern from memory.mjs exactly.
// ---------------------------------------------------------------------------

export async function openTraceDatabase(dataDir) {
  const key = resolve(dataDir)

  // Fast path — already resolved.
  if (dbs.get(key)) return dbs.get(key)

  // Dedupe concurrent callers — return the in-flight Promise if one exists.
  if (opening.has(key)) return opening.get(key)

  // PGlite WAL replay aborts on ungraceful kill; treat pgdata-trace as
  // expendable cache. Quarantine broken dir and re-bootstrap fresh.
  const promise = (async () => {
    mkdirSync(key, { recursive: true })
    const pgdataPath = join(key, 'pgdata-trace')
    const dbPath = pgdataPath.replace(/\\/g, '/')

    let db
    let bootstrapNeeded = !existsSync(pgdataPath)
    const tryOpen = async () => {
      const handle = new PGlite(`file://${dbPath}`)
      await handle.waitReady
      return handle
    }
    try {
      db = await tryOpen()
    } catch (err) {
      process.stderr.write(`[trace-store] PGlite open failed (${err?.message || err}) — quarantining pgdata-trace and rebootstrapping\n`)
      if (existsSync(pgdataPath)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const quarantine = `${pgdataPath}-aborted-${stamp}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
        try {
          renameSync(pgdataPath, quarantine)
          process.stderr.write(`[trace-store] quarantined broken pgdata-trace → ${quarantine}\n`)
        } catch (renameErr) {
          process.stderr.write(`[trace-store] rename failed (${renameErr?.message}); falling back to rmSync\n`)
          try {
            rmSync(pgdataPath, { recursive: true, force: true })
          } catch (rmErr) {
            process.stderr.write(`[trace-store] rmSync also failed (${rmErr.message}); next open may still abort — manual cleanup of pgdata-trace required\n`)
          }
        }
      }
      bootstrapNeeded = true
      db = await tryOpen()
    }
    if (bootstrapNeeded || !(await isBootstrapComplete(db))) {
      await init(db)
    }
    dbs.set(key, db)
    return db
  })()

  opening.set(key, promise)
  try {
    return await promise
  } finally {
    opening.delete(key)
  }
}

// ---------------------------------------------------------------------------
// closeTraceDatabase — mirrors closeDatabase from memory.mjs
// ---------------------------------------------------------------------------

export async function closeTraceDatabase(dataDir) {
  const key = resolve(dataDir)
  const db = dbs.get(key)
  if (!db) return
  try { await db.close() } catch {}
  dbs.delete(key)
}

// ---------------------------------------------------------------------------
// getTraceDatabase — synchronous handle accessor
// ---------------------------------------------------------------------------

export function getTraceDatabase(dataDir) {
  if (!dataDir) return null
  const key = resolve(dataDir)
  return dbs.get(key) ?? null
}

// ---------------------------------------------------------------------------
// insertTraceEvents — batch INSERT for Phase 2 HTTP ingest path.
// ---------------------------------------------------------------------------

const TRACE_COLS = [
  'ts', 'session_id', 'iteration', 'kind', 'role', 'model',
  'tool_name', 'tool_ms', 'input_tokens', 'output_tokens',
  'cached_tokens', 'cache_write_tokens', 'duration_ms',
  'error_message', 'payload',
]

export async function insertTraceEvents(db, events) {
  if (!Array.isArray(events) || events.length === 0) return { inserted: 0 }

  const valuePlaceholders = []
  const params = []
  let p = 1

  for (const ev of events) {
    // Coerce ts to epoch ms integer
    let ts = ev.ts
    if (typeof ts === 'string') ts = Date.parse(ts)
    ts = Number(ts)
    if (!Number.isFinite(ts)) ts = Date.now()

    const payload = ev.payload != null ? ev.payload : {}

    const cols = [
      ts,
      ev.session_id ?? null,
      ev.iteration != null ? Number(ev.iteration) : null,
      String(ev.kind ?? 'unknown'),
      ev.role ?? null,
      ev.model ?? null,
      ev.tool_name ?? null,
      ev.tool_ms != null ? Number(ev.tool_ms) : null,
      ev.input_tokens != null ? Number(ev.input_tokens) : null,
      ev.output_tokens != null ? Number(ev.output_tokens) : null,
      ev.cached_tokens != null ? Number(ev.cached_tokens) : null,
      ev.cache_write_tokens != null ? Number(ev.cache_write_tokens) : null,
      ev.duration_ms != null ? Number(ev.duration_ms) : null,
      ev.error_message ?? null,
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    ]
    valuePlaceholders.push(`(${cols.map(() => `$${p++}`).join(', ')})`)
    params.push(...cols)
  }

  const sql = `INSERT INTO trace_events (${TRACE_COLS.join(', ')}) VALUES ${valuePlaceholders.join(', ')}`
  await db.query(sql, params)
  return { inserted: events.length }
}
