// trace-store.mjs — native-PG trace analytics store for mixdog 0.4.0.
// Uses pg-adapter (schema='trace') so trace_events live in the trace schema.
// Isolated from memory schema; shares the same PG instance.

import { ensurePgInstance } from './pg-adapter.mjs'
import { resolve } from 'path'

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
    const r = await db.query(`SELECT to_regclass('trace.trace_events') AS t`)
    return r.rows[0]?.t != null
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// openTraceDatabase
// ---------------------------------------------------------------------------

export async function openTraceDatabase(dataDir) {
  const key = resolve(dataDir)

  if (dbs.get(key)) return dbs.get(key)
  if (opening.has(key)) return opening.get(key)

  const promise = (async () => {
    // pg-adapter with schema='trace' sets search_path=trace,public per connection.
    const { db } = await ensurePgInstance(dataDir, { schema: 'trace' })
    if (!(await isBootstrapComplete(db))) {
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
// closeTraceDatabase
// ---------------------------------------------------------------------------

export async function closeTraceDatabase(dataDir) {
  const key = resolve(dataDir)
  const db = dbs.get(key)
  if (!db) return
  dbs.delete(key)
  const { closePgInstance } = await import('./pg-adapter.mjs')
  await closePgInstance(dataDir, { schema: 'trace' })
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
// insertTraceEvents — batch INSERT
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
