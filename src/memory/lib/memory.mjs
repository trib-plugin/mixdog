// PGlite-backed memory store. Schema, helpers, and lifecycle.

import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'
import { mkdirSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { cleanMemoryText } from './memory-extraction.mjs'

const SCHEMA_VERSION = 1
const dbs = new Map()

export { cleanMemoryText }

export const VALID_STATUS = new Set(['pending', 'active', 'archived'])
export const VALID_CATEGORY = new Set([
  'rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue',
])
export const VALID_ROLE = new Set(['user', 'assistant', 'system'])

export async function init(db, dims) {
  const dimCount = Number(dims)
  if (!Number.isInteger(dimCount) || dimCount <= 0) {
    throw new Error(`init: dims must be a positive integer, got ${dims}`)
  }

  await db.exec(`CREATE EXTENSION IF NOT EXISTS vector`)

  await db.exec(`
    CREATE TABLE entries (
      id            BIGSERIAL PRIMARY KEY,
      ts            BIGINT NOT NULL,
      role          TEXT NOT NULL,
      content       TEXT NOT NULL,
      source_ref    TEXT NOT NULL UNIQUE,
      session_id    TEXT,
      project_id    TEXT,
      source_turn   INTEGER,
      chunk_root    BIGINT REFERENCES entries(id) ON DELETE SET NULL,
      is_root       SMALLINT NOT NULL DEFAULT 0,
      element       TEXT,
      category      TEXT,
      summary       TEXT,
      status        TEXT,
      score         REAL,
      last_seen_at  BIGINT,
      reviewed_at   BIGINT,
      promoted_at   BIGINT,
      error_count   INTEGER NOT NULL DEFAULT 0,
      embedding     vector(${dimCount}),
      summary_hash  TEXT,
      search_tsv    tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(element, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(summary, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(content, '')), 'C')
      ) STORED
    )
  `)

  await db.exec(`CREATE INDEX idx_entries_chunk_root  ON entries(chunk_root) WHERE chunk_root IS NOT NULL`)
  await db.exec(`CREATE INDEX idx_entries_ts_desc     ON entries(ts DESC)`)
  await db.exec(`CREATE INDEX idx_entries_session_ts  ON entries(session_id, ts DESC) WHERE session_id IS NOT NULL`)
  await db.exec(`CREATE INDEX idx_entries_root_status_score ON entries(status, score DESC) WHERE is_root = 1`)
  await db.exec(`CREATE INDEX idx_entries_root_category     ON entries(category, status)   WHERE is_root = 1`)
  await db.exec(`CREATE INDEX idx_entries_pending     ON entries(ts DESC, id DESC) WHERE chunk_root IS NULL AND session_id IS NOT NULL`)
  await db.exec(`CREATE INDEX idx_roots_active        ON entries(status, last_seen_at ASC, score DESC) WHERE is_root = 1 AND status = 'active'`)
  await db.exec(`CREATE INDEX idx_entries_project     ON entries(project_id) WHERE project_id IS NOT NULL`)
  await db.exec(`CREATE INDEX idx_entries_reviewed_at ON entries(reviewed_at ASC) WHERE is_root = 1`)
  await db.exec(`CREATE INDEX idx_entries_phase_sweep ON entries(status, is_root, error_count, reviewed_at, id)`)
  await db.exec(`CREATE INDEX idx_entries_promoted_at ON entries(promoted_at) WHERE promoted_at IS NOT NULL`)
  await db.exec(`CREATE INDEX idx_entries_tsv         ON entries USING GIN (search_tsv)`)
  await db.exec(`CREATE INDEX idx_entries_embedding_hnsw ON entries USING hnsw (embedding vector_cosine_ops) WHERE is_root = 1 AND embedding IS NOT NULL`)

  await db.exec(`
    CREATE TABLE core_entries (
      id          BIGSERIAL PRIMARY KEY,
      element     TEXT NOT NULL,
      summary     TEXT NOT NULL,
      category    TEXT NOT NULL,
      project_id  TEXT,
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    )
  `)
  await db.exec(`CREATE INDEX core_entries_project_idx ON core_entries(project_id)`)

  await db.exec(`
    CREATE TABLE meta (
      key    TEXT PRIMARY KEY,
      value  JSONB NOT NULL
    )
  `)
  await db.query(`INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)`, ['embedding.current_dims', JSON.stringify(String(dimCount))])
  await db.query(`INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)`, ['boot.schema_version', JSON.stringify(String(SCHEMA_VERSION))])
  await db.query(`INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)`, ['boot.schema_bootstrap_complete', JSON.stringify('1')])

}

export async function openDatabase(dataDir, dims) {
  const key = resolve(dataDir)
  const existing = dbs.get(key)
  if (existing) return existing
  mkdirSync(key, { recursive: true })
  const dbPath = join(key, 'pgdata').replace(/\\/g, '/')
  const isNewFile = !existsSync(join(key, 'pgdata'))
  const db = new PGlite(`file://${dbPath}`, { extensions: { vector } })
  await db.waitReady
  if (isNewFile || !(await isBootstrapComplete(db))) {
    await init(db, dims)
  }
  dbs.set(key, db)
  return db
}

export function getDatabase(dataDir) {
  if (!dataDir) return null
  const key = resolve(dataDir)
  return dbs.get(key) ?? null
}

export async function closeDatabase(dataDir) {
  const key = resolve(dataDir)
  const db = dbs.get(key)
  if (!db) return
  try { await db.close() } catch {}
  dbs.delete(key)
}

export async function isBootstrapComplete(db) {
  try {
    const r = await db.query(`SELECT value FROM meta WHERE key = 'boot.schema_bootstrap_complete'`)
    return r.rows[0]?.value === '1'
  } catch {
    return false
  }
}

// Returns the raw JSON-encoded string stored in meta.value. Callers JSON.parse
// it themselves; this preserves API parity with the prior SQLite TEXT column.
export async function getMetaValue(db, key, fallback = null) {
  try {
    const r = await db.query(`SELECT value::text AS v FROM meta WHERE key = $1`, [key])
    if (r.rows.length === 0) return fallback
    return r.rows[0].v ?? fallback
  } catch {
    return fallback
  }
}

// Caller passes a JSON-encoded string (e.g. JSON.stringify(obj) or a quoted
// scalar like '"v1"'). Stored verbatim into the JSONB column.
export async function setMetaValue(db, key, value) {
  await db.query(
    `INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value == null ? 'null' : String(value)],
  )
}

export function embeddingToSql(arr) {
  if (!arr || !Array.isArray(arr)) return null
  return `[${arr.map((n) => Number(n).toFixed(6)).join(',')}]`
}

export function embeddingFromBuffer(buf) {
  if (!buf || buf.length === 0) return null
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer ?? buf)
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const n = u8.byteLength / 4
  const out = new Array(n)
  for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4, true)
  return out
}
