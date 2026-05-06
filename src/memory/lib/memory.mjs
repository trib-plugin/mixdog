// Native-PG-backed memory store. Schema, helpers, and lifecycle.

import { ensurePgInstance } from './pg-adapter.mjs'
import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync, statSync } from 'fs'
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

  // Extensions are created once by pg-adapter.bootstrapInstance; skip here.

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
// migrateFromPgliteSidecars — one-shot 0.3.x → 0.4.0 migration
//
// 0.3.x stored sidecars in a subdirectory:
//   ${dataDir}/sidecars/core_entries.json
//   ${dataDir}/sidecars/entries.json   (≈2.5 MB, 252 rows + halfvec embeddings)
//   ${dataDir}/sidecars/meta.json
//
// The marker file ${dataDir}/MIGRATED_FROM_PGLITE is written on completion and
// checked on every subsequent boot for an early return.
// ---------------------------------------------------------------------------

// Column allowlists used exclusively inside migrateFromPgliteSidecars.
// SQL injection guard: only known-safe column names are used in INSERT statements.
const _MIGRATE_COLS = {
  entries: {
    allowed:     new Set([
      'id', 'ts', 'role', 'content', 'source_ref', 'session_id', 'project_id',
      'source_turn', 'chunk_root', 'is_root', 'element', 'category', 'summary',
      'status', 'score', 'last_seen_at', 'reviewed_at', 'promoted_at',
      'error_count', 'embedding', 'summary_hash',
    ]),
    casts:       { embedding: '::halfvec(1024)' },
    conflictKey: 'id',
    idColumn:    'id',
  },
  core_entries: {
    allowed:     new Set(['id', 'element', 'summary', 'category', 'project_id', 'created_at', 'updated_at']),
    casts:       {},
    conflictKey: 'id',
    idColumn:    'id',
  },
  meta: {
    allowed:     new Set(['key', 'value']),
    casts:       { value: '::jsonb' },
    conflictKey: 'key',
    idColumn:    null,
  },
}

export async function migrateFromPgliteSidecars(db, dataDir) {
  const dir        = resolve(dataDir)
  const markerPath = join(dir, 'MIGRATED_FROM_PGLITE')

  // Marker present → skip immediately.
  if (existsSync(markerPath)) return

  // Sidecar subdir written by 0.3.x PGlite builds.
  const sidecarsDir = join(dir, 'sidecars')

  // No sidecars directory → fresh install; write marker and return.
  if (!existsSync(sidecarsDir)) {
    writeFileSync(markerPath, JSON.stringify({
      migrated_at:     new Date().toISOString(),
      source_sizes:    {},
      ingested_counts: {},
      note:            'fresh install (no sidecars dir)',
    }, null, 2), 'utf8')
    return
  }

  const sidecarPath = (tbl) => join(sidecarsDir, `${tbl}.json`)

  const sourceSizes   = {}
  const ingestedCounts = {}
  const existingTables = []

  for (const tbl of ['core_entries', 'entries', 'meta']) {
    const p = sidecarPath(tbl)
    if (existsSync(p)) {
      try { sourceSizes[tbl] = statSync(p).size } catch { sourceSizes[tbl] = null }
      existingTables.push(tbl)
    }
  }

  // Fresh install — no legacy sidecars: write marker and return.
  if (existingTables.length === 0) {
    writeFileSync(markerPath, JSON.stringify({
      migrated_at:     new Date().toISOString(),
      source_sizes:    {},
      ingested_counts: {},
      note:            'no legacy sidecars found (sidecars dir exists but empty)',
    }, null, 2), 'utf8')
    return
  }

  process.stderr.write(`[memory] 0.3.x→0.4.0 migration: found ${existingTables.join(', ')} sidecars\n`)

  for (const tbl of existingTables) {
    const opts = _MIGRATE_COLS[tbl] ?? { allowed: null, casts: {}, conflictKey: 'id', idColumn: 'id' }
    try {
      // Parse sidecar JSON file.
      const raw    = readFileSync(sidecarPath(tbl), 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        throw new Error(`unexpected shape (expected { version:1, entries:[...] })`)
      }
      const rows = parsed.entries
      if (rows.length === 0) {
        ingestedCounts[tbl] = 0
        continue
      }

      // Insert all rows in a single transaction so a partial failure rolls back
      // this table's migration (other tables continue independently).
      await db.transaction(async (tx) => {
        let inserted = 0
        for (const e of rows) {
          const rawCols = Object.keys(e)
          const cols = opts.allowed ? rawCols.filter(c => opts.allowed.has(c)) : rawCols
          if (cols.length === 0) continue
          const params = cols.map((col, i) => `$${i + 1}${opts.casts[col] || ''}`)
          const setClauses = cols
            .filter(col => col !== opts.conflictKey)
            .map(col => `${col} = EXCLUDED.${col}`)
          const sql =
            `INSERT INTO ${tbl}(${cols.join(', ')}) VALUES (${params.join(', ')})` +
            ` ON CONFLICT (${opts.conflictKey}) DO UPDATE SET ${setClauses.join(', ')}`
          await tx.query(sql, cols.map(col => e[col] ?? null))
          inserted += 1
        }
        // Bump sequence so subsequent natural INSERTs don't collide with restored ids.
        if (opts.idColumn) {
          await tx.query(
            `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${opts.idColumn}) FROM ${tbl}), 0))`,
            [tbl, opts.idColumn],
          )
        }
        process.stderr.write(`[memory] migration: ${tbl} inserted ${inserted} rows\n`)
      })

      // Count committed rows.
      const r = await db.query(`SELECT COUNT(*) AS n FROM ${tbl}`)
      ingestedCounts[tbl] = Number(r.rows[0]?.n ?? 0)
      process.stderr.write(`[memory] migration: ${tbl} ingested ${ingestedCounts[tbl]} rows\n`)
    } catch (err) {
      process.stderr.write(`[memory] migration: ${tbl} failed — ${err?.message || err} (continuing)\n`)
      ingestedCounts[tbl] = null
    }
  }

  // Partial-failure guard: if any table threw, do NOT write marker — throw so
  // openDatabase boot surfaces the issue and the next boot re-attempts migration.
  const failedTables = existingTables.filter(tbl => ingestedCounts[tbl] === null)
  if (failedTables.length > 0) {
    throw new Error(
      `[memory] migration failed for table(s): ${failedTables.join(', ')} — ` +
      `marker NOT written; inspect sidecars at ${sidecarsDir} and retry`,
    )
  }

  // All tables succeeded — write permanent tombstone.
  writeFileSync(markerPath, JSON.stringify({
    migrated_at:     new Date().toISOString(),
    source_sizes:    sourceSizes,
    ingested_counts: ingestedCounts,
  }, null, 2), 'utf8')
  process.stderr.write(`[memory] migration complete → ${markerPath}\n`)
}

export async function openDatabase(dataDir, dims) {
  const key = resolve(dataDir)

  // Fast path — already resolved.
  if (dbs.get(key)) return dbs.get(key)

  // Dedupe concurrent callers — return the in-flight Promise if one exists.
  if (opening.has(key)) return opening.get(key)

  const promise = (async () => {
    mkdirSync(key, { recursive: true })

    // 0.3.x → 0.4.0 archive. PGlite produces native-format pgdata, so heuristics
    // on internals are unreliable. Sentinel: MIGRATED_FROM_PGLITE absent +
    // sidecars/ present + archive target absent + pgdata present. Fixed archive
    // name is self-sentinel; retries and concurrent boots no-op naturally.
    const sidecarsDir   = join(key, 'sidecars')
    const pgdataDir     = join(key, 'pgdata')
    const markerPath    = join(key, 'MIGRATED_FROM_PGLITE')
    const archiveTarget = join(key, 'pgdata-pglite-archived')
    if (!existsSync(markerPath) && existsSync(sidecarsDir) && !existsSync(archiveTarget) && existsSync(pgdataDir)) {
      renameSync(pgdataDir, archiveTarget)
      process.stderr.write(`[memory] 0.3.x→0.4.0 archive: ${pgdataDir} → ${archiveTarget}\n`)
    }

    const { db } = await ensurePgInstance(dataDir, { schema: 'memory' })

    const bootstrapNeeded = !(await isBootstrapComplete(db))
    if (bootstrapNeeded) {
      await init(db, dims)
    }
    // One-shot 0.3.x → 0.4.0 migration; self-skips via MIGRATED_FROM_PGLITE marker.
    // Runs on every boot so a partial failure on boot N is retried on boot N+1.
    // (init() is safe to skip on retry — schema/extensions/indexes already exist.)
    await migrateFromPgliteSidecars(db, dataDir)

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

