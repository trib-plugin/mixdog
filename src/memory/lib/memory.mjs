import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { cleanMemoryText } from './memory-extraction.mjs'

let sqliteVec = null
try { sqliteVec = await import('sqlite-vec') }
catch (e) { process.stderr.write(`[memory] sqlite-vec not available: ${e.message}\n`) }

const dbs = new Map()

export { cleanMemoryText }

export function init(db, dims) {
  const dimCount = Number(dims)
  if (!Number.isInteger(dimCount) || dimCount <= 0) {
    throw new Error(`init: dims must be a positive integer, got ${dims}`)
  }

  db.exec('BEGIN')
  try {
    db.exec(`
      CREATE TABLE entries (
        id            INTEGER PRIMARY KEY,
        ts            INTEGER NOT NULL,
        role          TEXT    NOT NULL,
        content       TEXT    NOT NULL,
        source_ref    TEXT    NOT NULL,
        session_id    TEXT,
        -- Source jsonl turn index (1-based) so search_memories results can
        -- anchor to the originating Claude Code transcript turn. Roots have
        -- no direct turn (their range is derived from members); leaves carry
        -- the index embedded in source_ref as a structured column.
        source_turn   INTEGER,
        chunk_root    INTEGER,
        is_root       INTEGER NOT NULL DEFAULT 0,
        element       TEXT,
        category      TEXT,
        summary       TEXT,
        status        TEXT,
        score         REAL,
        last_seen_at  INTEGER,
        embedding     BLOB,
        summary_hash  TEXT,
        UNIQUE (source_ref),
        FOREIGN KEY (chunk_root) REFERENCES entries(id) ON DELETE SET NULL,
        CHECK (role IN ('user','assistant','system')),
        CHECK (
          (chunk_root IS NULL AND is_root = 0)
          OR (is_root = 1 AND chunk_root = id)
          OR (is_root = 0 AND chunk_root IS NOT NULL AND chunk_root != id)
        ),
        CHECK (
          is_root = 1
          OR (element IS NULL
              AND category IS NULL
              AND summary IS NULL
              AND status IS NULL
              AND score IS NULL
              AND last_seen_at IS NULL
              AND embedding IS NULL
              AND summary_hash IS NULL)
        ),
        CHECK (category IS NULL OR category IN
          ('rule','constraint','decision','fact','goal','preference','task','issue')),
        CHECK (status IS NULL OR status IN
          ('active','pending','demoted','processed','archived'))
      );

      CREATE TRIGGER trg_chunk_root_must_be_root
      BEFORE INSERT ON entries
      WHEN NEW.chunk_root IS NOT NULL AND NEW.chunk_root != NEW.id
      BEGIN
        SELECT CASE
          WHEN (SELECT is_root FROM entries WHERE id = NEW.chunk_root) IS NOT 1
          THEN RAISE(ABORT, 'chunk_root must reference a row with is_root=1')
        END;
      END;

      CREATE TRIGGER trg_chunk_root_must_be_root_upd
      BEFORE UPDATE OF chunk_root ON entries
      WHEN NEW.chunk_root IS NOT NULL AND NEW.chunk_root != NEW.id
      BEGIN
        SELECT CASE
          WHEN (SELECT is_root FROM entries WHERE id = NEW.chunk_root) IS NOT 1
          THEN RAISE(ABORT, 'chunk_root must reference a row with is_root=1')
        END;
      END;

      CREATE TRIGGER trg_root_demote_guard
      BEFORE UPDATE OF is_root ON entries
      WHEN OLD.is_root = 1 AND NEW.is_root = 0
        AND EXISTS (SELECT 1 FROM entries WHERE chunk_root = OLD.id AND id != OLD.id)
      BEGIN
        SELECT RAISE(ABORT, 'cannot demote root that still has members');
      END;

      CREATE INDEX idx_entries_chunk_root ON entries(chunk_root);
      CREATE INDEX idx_entries_ts_desc    ON entries(ts DESC);
      CREATE INDEX idx_entries_session_ts ON entries(session_id, ts DESC);
      CREATE INDEX idx_entries_root_status_score
        ON entries(status, score DESC) WHERE is_root = 1;
      CREATE INDEX idx_entries_root_category
        ON entries(category, status) WHERE is_root = 1;
      -- Cycle1 backlog scan: chunk_root IS NULL AND session_id IS NOT NULL
      -- ORDER BY ts DESC, id DESC. Without this partial index the query
      -- falls back to idx_entries_ts_desc and post-filters every row.
      CREATE INDEX idx_entries_pending
        ON entries(ts DESC, id DESC)
        WHERE chunk_root IS NULL AND session_id IS NOT NULL;
      -- Cycle2 phase3 candidate scan: is_root=1 AND status IN ('active','processed')
      -- ORDER BY last_seen_at ASC, score DESC.
      CREATE INDEX idx_roots_active_old
        ON entries(status, last_seen_at ASC, score DESC)
        WHERE is_root = 1 AND status IN ('active', 'processed');

      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE entries_fts USING fts5(
        content, element, summary,
        content='entries',
        content_rowid='id',
        tokenize='trigram'
      );

      CREATE TRIGGER trg_entries_fts_insert AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, content, element, summary)
        VALUES (NEW.id, NEW.content, NEW.element, NEW.summary);
      END;

      CREATE TRIGGER trg_entries_fts_delete AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, content, element, summary)
        VALUES ('delete', OLD.id, OLD.content, OLD.element, OLD.summary);
      END;

      CREATE TRIGGER trg_entries_fts_update AFTER UPDATE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, content, element, summary)
        VALUES ('delete', OLD.id, OLD.content, OLD.element, OLD.summary);
        INSERT INTO entries_fts(rowid, content, element, summary)
        VALUES (NEW.id, NEW.content, NEW.element, NEW.summary);
      END;

      -- vec_entries has no FK to entries (sqlite-vec vtable does not
      -- participate in FK). Keep it in sync via an explicit AFTER DELETE
      -- trigger so deleting an entries row purges its embedding too.
      -- Only root rows ever get a vec_entries row (rowid = entries.id), so
      -- the guard avoids a pointless DELETE for non-root entries.
      CREATE TRIGGER trg_entries_vec_delete
      AFTER DELETE ON entries
      WHEN OLD.is_root = 1
      BEGIN
        DELETE FROM vec_entries WHERE rowid = OLD.id;
      END;
    `)

    db.exec(`CREATE VIRTUAL TABLE vec_entries USING vec0(embedding float[${dimCount}])`)

    const metaInsert = db.prepare(`INSERT INTO meta(key, value) VALUES (?, ?)`)
    metaInsert.run('embedding.current_dims', String(dimCount))
    metaInsert.run('boot.schema_version', '4')
    metaInsert.run('boot.schema_bootstrap_complete', '1')

    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
}

export function openDatabase(dataDir, dims) {
  const key = resolve(dataDir)
  const existing = dbs.get(key)
  if (existing) return existing
  const dbPath = join(key, 'memory.sqlite')
  mkdirSync(dirname(dbPath), { recursive: true })
  const isNewFile = !existsSync(dbPath)
  const db = new DatabaseSync(dbPath, { allowExtension: true })
  if (sqliteVec) {
    try { sqliteVec.load(db) }
    catch (e) { process.stderr.write(`[memory] sqlite-vec load failed: ${e.message}\n`) }
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
  `)
  if (isNewFile || !isBootstrapComplete(db)) {
    init(db, dims)
  }
  migrateIfNeeded(db)
  dbs.set(key, db)
  return db
}

/**
 * Forward-only schema migrations. Runs on every openDatabase() after the
 * bootstrap step so already-initialised databases still get new columns.
 * Each step is idempotent — repeated runs after failure do not corrupt
 * state, and "duplicate column" errors on retry are swallowed so a
 * previously-half-applied migration still lands `schema_version`.
 */
function migrateIfNeeded(db) {
  const current = Number(getMetaValue(db, 'boot.schema_version', '1')) || 1
  if (current < 2) {
    try {
      db.exec(`ALTER TABLE entries ADD COLUMN source_turn INTEGER`)
    } catch (e) {
      if (!/duplicate column name/i.test(String(e?.message))) {
        process.stderr.write(`[memory] schema v2 migration failed: ${e.message}\n`)
        return
      }
    }
    setMetaValue(db, 'boot.schema_version', '2')
    process.stderr.write(`[memory] schema migrated to v2 (source_turn)\n`)
  }
  if (current < 3) {
    // v3: install trg_entries_vec_delete on pre-existing databases. Older
    // files (schema v1/v2) were bootstrapped without this trigger, so
    // vec_entries may drift out of sync when entries rows are deleted.
    // CREATE TRIGGER IF NOT EXISTS is idempotent; the migration just flips
    // the version tag once the trigger is guaranteed to exist.
    try {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_entries_vec_delete
        AFTER DELETE ON entries
        WHEN OLD.is_root = 1
        BEGIN
          DELETE FROM vec_entries WHERE rowid = OLD.id;
        END;
      `)
    } catch (e) {
      process.stderr.write(`[memory] schema v3 migration failed: ${e.message}\n`)
      return
    }
    setMetaValue(db, 'boot.schema_version', '3')
    process.stderr.write(`[memory] schema migrated to v3 (vec_entries delete trigger)\n`)
  }
  if (current < 4) {
    // v4: backfill cycle1/cycle2 hot-path partial indexes onto pre-existing
    // databases. CREATE INDEX IF NOT EXISTS is idempotent.
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_entries_pending
          ON entries(ts DESC, id DESC)
          WHERE chunk_root IS NULL AND session_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_roots_active_old
          ON entries(status, last_seen_at ASC, score DESC)
          WHERE is_root = 1 AND status IN ('active', 'processed');
      `)
    } catch (e) {
      process.stderr.write(`[memory] schema v4 migration failed: ${e.message}\n`)
      return
    }
    setMetaValue(db, 'boot.schema_version', '4')
    process.stderr.write(`[memory] schema migrated to v4 (cycle hot-path indexes)\n`)
  }
}

export function isBootstrapComplete(db) {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'boot.schema_bootstrap_complete'`).get()
    return row && row.value === '1'
  } catch {
    return false
  }
}

export function getMetaValue(db, key, fallback = null) {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key)
    return row?.value ?? fallback
  } catch {
    return fallback
  }
}

export function setMetaValue(db, key, value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  db.prepare(`
    INSERT INTO meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, serialized)
}

export function closeDatabase(dataDir) {
  const key = resolve(dataDir)
  const db = dbs.get(key)
  if (!db) return
  try { db.close() } catch {}
  dbs.delete(key)
}
