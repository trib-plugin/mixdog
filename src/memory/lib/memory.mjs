// PGlite-backed memory store. Schema, helpers, and lifecycle.

import { PGlite } from '../../../lib/vendored/pglite/dist/index.js'
import { vector } from '../../../lib/vendored/pglite/dist/vector/index.js'
import { pg_trgm } from '../../../lib/vendored/pglite/dist/contrib/pg_trgm.js'
import { mkdirSync, existsSync, renameSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { cleanMemoryText } from './memory-extraction.mjs'

const dbs = new Map()
const opening = new Map()

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

  await db.query(`INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)`, ['embedding.current_dims', JSON.stringify(dimCount)])
  await db.query(`INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)`, ['boot.schema_bootstrap_complete', JSON.stringify('1')])
}

// ---------------------------------------------------------------------------
// Table sidecars — best-effort JSON snapshots alongside pgdata.
// Survive quarantine/rmSync because they live in dataDir, not inside pgdata.
//
// Generic helpers: persistTableSidecar / restoreTableSidecar
// Thin wrappers kept for existing call sites: persistCoreEntriesSidecar /
// restoreCoreEntriesFromSidecar (internal; not exported).
// ---------------------------------------------------------------------------

// Tables whose column sets need special handling.
// excludeColumns: generated/computed cols that cannot be inserted back.
// allowedColumns: allowlist of safe column names for restore (SQL injection guard).
//   Omit search_tsv (generated) and any col not in the CREATE TABLE schema.
// castColumns: map of colName → SQL cast suffix applied on restore params.
// conflictKey: primary-key column for ON CONFLICT (default 'id').
const TABLE_OPTIONS = {
  entries: {
    excludeColumns: new Set(['search_tsv']),
    allowedColumns: new Set([
      'id', 'ts', 'role', 'content', 'source_ref', 'session_id', 'project_id',
      'source_turn', 'chunk_root', 'is_root', 'element', 'category', 'summary',
      'status', 'score', 'last_seen_at', 'reviewed_at', 'promoted_at',
      'error_count', 'embedding', 'summary_hash',
    ]),
    castColumns: { embedding: '::halfvec(1024)' },
    conflictKey: 'id',
    idColumn: 'id',
  },
  core_entries: {
    excludeColumns: new Set(),
    allowedColumns: new Set([
      'id', 'element', 'summary', 'category', 'project_id', 'created_at', 'updated_at',
    ]),
    castColumns: {},
    conflictKey: 'id',
    idColumn: 'id',
  },
  meta: {
    excludeColumns: new Set(),
    allowedColumns: new Set(['key', 'value']),
    castColumns: { value: '::jsonb' },
    conflictKey: 'key',
    idColumn: null,   // TEXT primary key — no sequence to reset
  },
}

// Module-level per-table mutex. Key: `${dataDir}|${tableName}`.
// Serialises concurrent persists on the same table so a slow first persist
// cannot overwrite a fast second persist with stale data.
const _persistLocks = new Map()

function _sidecarPath(dataDir, tableName) {
  return join(resolve(dataDir), 'sidecars', `${tableName}.json`)
}

// Migrate legacy core-entries.json → sidecars/core_entries.json on first boot.
function _migrateLegacyCoreEntries(dataDir) {
  const legacyPath = join(resolve(dataDir), 'core-entries.json')
  const newPath = _sidecarPath(dataDir, 'core_entries')
  if (existsSync(legacyPath) && !existsSync(newPath)) {
    try {
      mkdirSync(dirname(newPath), { recursive: true })
      renameSync(legacyPath, newPath)
      process.stderr.write(`[memory] migrated core-entries.json → sidecars/core_entries.json\n`)
    } catch (err) {
      process.stderr.write(`[memory] legacy sidecar migration failed (${err?.message}); old path left in place\n`)
    }
  }
}

// Generic table sidecar persist. Writes sidecars/<tableName>.json atomically.
async function _doPersist(db, dataDir, tableName, opts) {
  const excluded = opts.excludeColumns ?? new Set()
  const sidecarPath = _sidecarPath(dataDir, tableName)
  try {
    mkdirSync(dirname(sidecarPath), { recursive: true })
    const r = await db.query(`SELECT * FROM ${tableName} ORDER BY 1`)
    const rows = excluded.size === 0 ? r.rows : r.rows.map(row => {
      const out = {}
      for (const [k, v] of Object.entries(row)) {
        if (!excluded.has(k)) out[k] = v
      }
      return out
    })
    const tmp = `${sidecarPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    writeFileSync(tmp, JSON.stringify({ version: 1, table: tableName, entries: rows }, null, 2), 'utf8')
    renameSync(tmp, sidecarPath)
  } catch (err) {
    process.stderr.write(`[memory] sidecar persist failed (${tableName}: ${err?.message || err}) — continuing\n`)
  }
}

export async function persistTableSidecar(db, dataDir, tableName, options = {}) {
  const opts = { ...TABLE_OPTIONS[tableName], ...options }
  const lockKey = `${dataDir}|${tableName}`
  const prev = _persistLocks.get(lockKey)
  const next = (prev || Promise.resolve())
    .catch(() => {})        // swallow prior rejection so queued persist always runs
    .then(() => _doPersist(db, dataDir, tableName, opts))
  _persistLocks.set(lockKey, next)
  try {
    await next
  } finally {
    if (_persistLocks.get(lockKey) === next) _persistLocks.delete(lockKey)
  }
}

// Generic table sidecar restore. Reads sidecars/<tableName>.json and upserts.
export async function restoreTableSidecar(db, dataDir, tableName, options = {}) {
  const opts = { ...TABLE_OPTIONS[tableName], ...options }
  const castCols = opts.castColumns ?? {}
  const conflictKey = opts.conflictKey ?? 'id'
  const allowed = opts.allowedColumns ?? null   // null = no allowlist (legacy callers)
  const sidecarPath = _sidecarPath(dataDir, tableName)
  if (!existsSync(sidecarPath)) return

  // --- parse phase ---
  let entries
  try {
    const raw = readFileSync(sidecarPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error('unexpected shape (expected { version:1, entries:[...] })')
    }
    entries = parsed.entries
  } catch (err) {
    const corruptPath = `${sidecarPath}.corrupt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    try { renameSync(sidecarPath, corruptPath) } catch {}
    process.stderr.write(
      `[memory] ${tableName} sidecar malformed (${err.message}); renamed to .corrupt-*\n`,
    )
    return
  }

  if (entries.length === 0) return

  // --- insert phase ---
  const failures = []
  let restored = 0
  for (const e of entries) {
    try {
      // R2-1: intersect row keys with allowedColumns to block injected identifiers.
      const rawCols = Object.keys(e)
      const cols = allowed ? rawCols.filter(c => allowed.has(c)) : rawCols
      if (cols.length === 0) continue
      const params = cols.map((col, i) => `$${i + 1}${castCols[col] || ''}`)
      const setClauses = cols
        .filter(col => col !== conflictKey)
        .map(col => `${col} = EXCLUDED.${col}`)
      const sql =
        `INSERT INTO ${tableName}(${cols.join(', ')}) VALUES (${params.join(', ')})` +
        ` ON CONFLICT (${conflictKey}) DO UPDATE SET ${setClauses.join(', ')}`
      await db.query(sql, cols.map(col => e[col] ?? null))
      restored += 1
    } catch (rowErr) {
      failures.push({ id: e[conflictKey], error: rowErr?.message || String(rowErr) })
    }
  }

  if (restored > 0) {
    process.stderr.write(`[memory] restored ${restored} ${tableName} rows from sidecar\n`)
  }

  if (failures.length > 0) {
    const shown = failures.slice(0, 10).map(f => f.id).join(', ')
    const tail = failures.length > 10 ? ` ...and ${failures.length - 10} more` : ''
    process.stderr.write(
      `[memory] sidecar restore (${tableName}): ${failures.length} row(s) failed — ids: ${shown}${tail}\n`,
    )
    if (restored === 0) {
      const corruptPath = `${sidecarPath}.corrupt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
      try { renameSync(sidecarPath, corruptPath) } catch {}
      process.stderr.write(
        `[memory] ${tableName} sidecar parseable but all rows failed; renamed to .corrupt-*\n`,
      )
    }
  }

  // R2-2: After restoring explicit-id rows, bump the sequence so next natural
  // INSERT doesn't collide. pg_get_serial_sequence avoids hardcoded names.
  const idCol = opts.idColumn
  if (idCol && restored > 0) {
    try {
      await db.query(
        `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${idCol}) FROM ${tableName}), 0))`,
        [tableName, idCol],
      )
    } catch (seqErr) {
      process.stderr.write(`[memory] sequence reset failed (${tableName}.${idCol}): ${seqErr?.message}\n`)
    }
  }
}

// Thin wrappers — kept for existing call sites in core-memory-store.mjs.
export async function persistCoreEntriesSidecar(db, dataDir) {
  _migrateLegacyCoreEntries(dataDir)
  return persistTableSidecar(db, dataDir, 'core_entries')
}

async function restoreCoreEntriesFromSidecar(db, dataDir) {
  _migrateLegacyCoreEntries(dataDir)
  return restoreTableSidecar(db, dataDir, 'core_entries')
}

export async function openDatabase(dataDir, dims) {
  const key = resolve(dataDir)

  // Fast path — already resolved.
  if (dbs.get(key)) return dbs.get(key)

  // Dedupe concurrent callers — return the in-flight Promise if one exists.
  if (opening.has(key)) return opening.get(key)

  // PGlite WAL replay aborts when an ungraceful kill leaves cycle1/cycle2
  // ingestion writes (halfvec embeddings, HNSW maintenance, GIN tsvector)
  // unflushed past the last checkpoint. Recovery is non-deterministic on
  // Windows + Bun; pgdata is treated as expendable cache. Catch the abort,
  // quarantine the broken directory, and re-bootstrap fresh — entries are
  // regenerable via backfill; core_entries is protected by the JSON sidecar.
  const promise = (async () => {
    mkdirSync(key, { recursive: true })
    const dbPath = join(key, 'pgdata').replace(/\\/g, '/')
    const pgdataPath = join(key, 'pgdata')

    let db
    let bootstrapNeeded = !existsSync(pgdataPath)
    const tryOpen = async () => {
      const handle = new PGlite(`file://${dbPath}`, { extensions: { vector, pg_trgm } })
      await handle.waitReady
      return handle
    }
    try {
      db = await tryOpen()
    } catch (err) {
      process.stderr.write(`[memory] PGlite open failed (${err?.message || err}) — quarantining pgdata and rebootstrapping\n`)
      if (existsSync(pgdataPath)) {
        // Include pid + random suffix to avoid same-ms collisions when multiple
        // processes quarantine concurrently.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const quarantine = `${pgdataPath}-aborted-${stamp}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
        try {
          renameSync(pgdataPath, quarantine)
          process.stderr.write(`[memory] quarantined broken pgdata → ${quarantine}\n`)
        } catch (renameErr) {
          process.stderr.write(`[memory] rename failed (${renameErr?.message}); falling back to rmSync\n`)
          try {
            rmSync(pgdataPath, { recursive: true, force: true })
          } catch (rmErr) {
            process.stderr.write(`[memory] rmSync also failed (${rmErr.message}); next open may still abort — manual cleanup of pgdata required\n`)
          }
        }
      }
      bootstrapNeeded = true
      db = await tryOpen()
    }
    if (bootstrapNeeded || !(await isBootstrapComplete(db))) {
      await init(db, dims)
      // Restore core_entries from sidecar if quarantine wiped pgdata.
      await restoreCoreEntriesFromSidecar(db, dataDir)
      // Restore entries and meta from sidecars (best-effort; per-table errors skip).
      try { await restoreTableSidecar(db, dataDir, 'entries') } catch (e) {
        process.stderr.write(`[memory] entries sidecar restore failed: ${e?.message}\n`)
      }
      try { await restoreTableSidecar(db, dataDir, 'meta') } catch (e) {
        process.stderr.write(`[memory] meta sidecar restore failed: ${e?.message}\n`)
      }
    }
    // Pin pg_trgm similarity threshold for the connection so the `%` operator
    // matches recall-store's documented TRGM_THRESHOLD (0.10) instead of the
    // pg_trgm default (0.3). PGlite uses a single backend, so this affects all
    // subsequent queries on this handle.
    try { await db.query(`SELECT set_limit(0.10)`) } catch {}
    // Bootstrap dump: for each protected table, if sidecar missing and table
    // has rows, create initial sidecar (covers existing users upgrading).
    const _protectedTables = ['core_entries', 'entries', 'meta']
    for (const tbl of _protectedTables) {
      const sp = _sidecarPath(dataDir, tbl)
      if (!existsSync(sp)) {
        try {
          const cnt = await db.query(`SELECT COUNT(*) AS n FROM ${tbl}`)
          if (Number(cnt.rows[0]?.n) > 0) {
            await persistTableSidecar(db, dataDir, tbl)
          }
        } catch {}
      }
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

