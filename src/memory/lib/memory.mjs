// PGlite-backed memory store. Schema, helpers, and lifecycle.

import { PGlite } from '../../../lib/vendored/pglite/dist/index.js'
import { vector } from '../../../lib/vendored/pglite/dist/vector/index.js'
import { pg_trgm } from '../../../lib/vendored/pglite/dist/contrib/pg_trgm.js'
import { mkdirSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { cleanMemoryText } from './memory-extraction.mjs'

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
  await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm`)

  // Status as a real ENUM type — DB-level enforcement, B-tree friendly.
  await db.exec(`CREATE TYPE entry_status AS ENUM ('pending', 'active', 'archived')`)

  // Per-category score parameters (lookup table for the score function).
  await db.exec(`
    CREATE TABLE category_score_params (
      category TEXT PRIMARY KEY,
      grade    REAL NOT NULL,
      decay    REAL NOT NULL
    )
  `)
  await db.query(`
    INSERT INTO category_score_params(category, grade, decay) VALUES
      ('rule', 2.0, 0.0),
      ('constraint', 1.9, 0.06),
      ('decision', 1.8, 0.15),
      ('fact', 1.6, 0.25),
      ('goal', 1.5, 0.30),
      ('preference', 1.4, 0.35),
      ('task', 1.1, 0.45),
      ('issue', 1.0, 0.50)
  `)

  // SQL function mirrors src/memory/lib/memory-score.mjs computeEntryScore.
  // STABLE (not IMMUTABLE) because the function reads category_score_params.
  // IMMUTABLE would let the planner cache results across rows where params
  // could legitimately differ if the table is updated.
  await db.exec(`
    CREATE OR REPLACE FUNCTION compute_entry_score(
      category_p TEXT,
      last_seen_at_p BIGINT,
      now_ms_p BIGINT
    ) RETURNS REAL LANGUAGE sql STABLE AS $$
      SELECT CASE
        WHEN p.grade IS NULL OR last_seen_at_p IS NULL OR now_ms_p IS NULL THEN NULL::REAL
        WHEN p.decay = 0 THEN p.grade
        ELSE LEAST(
          p.grade,
          p.grade / POWER(
            1 + (GREATEST(0, (now_ms_p - last_seen_at_p)) / 86400000.0) * p.decay / 30,
            0.3
          )
        )::REAL
      END
      FROM category_score_params p
      WHERE p.category = category_p
    $$
  `)

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
      status        entry_status,
      score         REAL,
      last_seen_at  BIGINT,
      reviewed_at   BIGINT,
      promoted_at   BIGINT,
      error_count   INTEGER NOT NULL DEFAULT 0,
      embedding     halfvec(${dimCount}),
      summary_hash  TEXT,
      search_tsv    tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple',  coalesce(element, '')), 'A') ||
        setweight(to_tsvector('simple',  coalesce(summary, '')), 'B') ||
        setweight(to_tsvector('simple',  coalesce(content, '')), 'C') ||
        setweight(to_tsvector('english', coalesce(element, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(content, '')), 'C')
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
  await db.exec(`CREATE INDEX idx_entries_content_trgm ON entries USING GIN (content gin_trgm_ops) WHERE is_root = 1`)
  await db.exec(`CREATE INDEX idx_entries_element_trgm ON entries USING GIN (element gin_trgm_ops) WHERE is_root = 1 AND element IS NOT NULL`)
  await db.exec(`CREATE INDEX idx_entries_embedding_hnsw ON entries USING hnsw (embedding halfvec_cosine_ops) WHERE is_root = 1 AND embedding IS NOT NULL`)

  // BEFORE INSERT/UPDATE trigger keeps score in sync with category + last_seen_at
  // automatically; cycle code no longer needs to UPDATE entries SET score = ...
  await db.exec(`
    CREATE OR REPLACE FUNCTION trg_entry_score_recalc() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.is_root = 1 AND NEW.category IS NOT NULL THEN
        -- NOW()-to-ms conversion is intentional schema-level work; the
        -- "no EXTRACT(EPOCH …)" rule applies to ms-stored BIGINT timestamp
        -- COLUMNS, not to the trigger reading the current wall clock.
        NEW.score := compute_entry_score(
          NEW.category,
          COALESCE(NEW.last_seen_at, NEW.ts),
          (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
        );
      END IF;
      RETURN NEW;
    END;
    $$
  `)
  await db.exec(`
    CREATE TRIGGER trg_entries_score
    BEFORE INSERT OR UPDATE OF category, last_seen_at, promoted_at, is_root ON entries
    FOR EACH ROW
    EXECUTE FUNCTION trg_entry_score_recalc()
  `)

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

  // Operational view — used by /health and dashboards. One round-trip,
  // covers the metrics that previously needed 6+ COUNT queries.
  await db.exec(`
    CREATE VIEW v_cycle_state AS
    SELECT
      COUNT(*) FILTER (WHERE is_root = 1) AS roots,
      COUNT(*) FILTER (WHERE is_root = 1 AND status = 'pending')  AS pending,
      COUNT(*) FILTER (WHERE is_root = 1 AND status = 'active')   AS active,
      COUNT(*) FILTER (WHERE is_root = 1 AND status = 'archived') AS archived,
      COUNT(*) FILTER (WHERE chunk_root IS NULL)                  AS unclassified,
      COUNT(*) AS total
    FROM entries
  `)

  // Hot active set — recall hot path uses the materialized copy. Refresh hook
  // is owned by cycle2 (after promotion/archival). Created WITH NO DATA so
  // bootstrap is fast; first refresh happens on the first cycle2 run.
  await db.exec(`
    CREATE MATERIALIZED VIEW mv_hot_active AS
    SELECT id, element, summary, category, status, score, last_seen_at, promoted_at,
           project_id, embedding, search_tsv
    FROM entries
    WHERE is_root = 1 AND status = 'active' AND embedding IS NOT NULL
    WITH NO DATA
  `)
  await db.exec(`CREATE UNIQUE INDEX mv_hot_active_id ON mv_hot_active(id)`)
  await db.exec(`CREATE INDEX mv_hot_active_hnsw ON mv_hot_active USING hnsw (embedding halfvec_cosine_ops)`)
  await db.exec(`CREATE INDEX mv_hot_active_tsv  ON mv_hot_active USING GIN (search_tsv)`)
  await db.exec(`CREATE INDEX mv_hot_active_score ON mv_hot_active(score DESC)`)

  await db.query(`INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)`, ['embedding.current_dims', JSON.stringify(String(dimCount))])
  await db.query(`INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)`, ['boot.schema_bootstrap_complete', JSON.stringify('1')])
}

// Idempotent. trajectories is auxiliary (agent orchestrator log).
// All DDL uses CREATE TABLE/INDEX IF NOT EXISTS — safe to call on every open();
// subsequent runs are O(1) catalog checks with no additional fsync overhead.
export async function ensureTrajectoryTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS trajectories (
      id              BIGSERIAL PRIMARY KEY,
      ts              TIMESTAMP NOT NULL DEFAULT NOW(),
      session_id      TEXT,
      scope           TEXT,
      preset          TEXT,
      model           TEXT,
      agent_type      TEXT,
      phase           TEXT,
      tool_calls_json JSONB,
      iterations      INTEGER DEFAULT 1,
      tokens_in       INTEGER DEFAULT 0,
      tokens_out      INTEGER DEFAULT 0,
      duration_ms     INTEGER DEFAULT 0,
      completed       SMALLINT DEFAULT 1,
      error_message   TEXT,
      created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    )
  `)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_traj_scope ON trajectories(scope, ts)`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_traj_ts ON trajectories(ts)`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_traj_tool_calls_gin ON trajectories USING GIN (tool_calls_json)`)
}

export async function openDatabase(dataDir, dims) {
  const key = resolve(dataDir)
  const existing = dbs.get(key)
  if (existing) return existing
  mkdirSync(key, { recursive: true })
  const dbPath = join(key, 'pgdata').replace(/\\/g, '/')
  const isNewFile = !existsSync(join(key, 'pgdata'))
  const db = new PGlite(`file://${dbPath}`, { extensions: { vector, pg_trgm } })
  await db.waitReady
  if (isNewFile || !(await isBootstrapComplete(db))) {
    await init(db, dims)
  }
  // Pin pg_trgm similarity threshold for the connection so the `%` operator
  // matches recall-store's documented TRGM_THRESHOLD (0.10) instead of the
  // pg_trgm default (0.3). PGlite uses a single backend, so this affects all
  // subsequent queries on this handle.
  try { await db.query(`SELECT set_limit(0.10)`) } catch {}
  await ensureTrajectoryTable(db)
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
// it themselves; preserves API parity with the prior TEXT column.
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

// Refresh the hot-active materialized view. Cycle2 calls this after status
// transitions to keep recall hot-path fresh.
export async function refreshHotActive(db) {
  try {
    await db.exec(`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_hot_active`)
  } catch (e) {
    // First-ever refresh on a never-populated MV requires non-CONCURRENTLY.
    try { await db.exec(`REFRESH MATERIALIZED VIEW mv_hot_active`) }
    catch (err) { process.stderr.write(`[memory] mv_hot_active refresh failed: ${err.message}\n`) }
  }
}

export function embeddingToSql(arr) {
  if (!arr || !Array.isArray(arr)) return null
  return `[${arr.map((n) => Number(n).toFixed(6)).join(',')}]`
}

