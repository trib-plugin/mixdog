import { DatabaseSync } from '../../../lib/sqlite-bridge.mjs'
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'fs'
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
        project_id    TEXT,
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
        reviewed_at   INTEGER,
        error_count   INTEGER NOT NULL DEFAULT 0,
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
          ('pending','active','fixed','archived'))
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
        WHERE is_root = 1 AND status = 'active';
      CREATE INDEX idx_entries_project
        ON entries(project_id) WHERE project_id IS NOT NULL;
      CREATE INDEX idx_entries_reviewed_at
        ON entries(reviewed_at ASC)
        WHERE is_root = 1;
      -- v8: composite index for phase2/phase3 sweep (status, is_root, error_count,
      -- reviewed_at, id). Allows the planner to skip poison rows (error_count >= 3)
      -- without a full table scan.
      CREATE INDEX idx_entries_phase_sweep
        ON entries(status, is_root, error_count, reviewed_at, id);

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
    db.exec(`
      CREATE TABLE core_entries (
        id          INTEGER PRIMARY KEY,
        element     TEXT NOT NULL,
        summary     TEXT NOT NULL,
        category    TEXT NOT NULL,
        project_id  TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX core_entries_project_idx ON core_entries(project_id);
    `)

    const metaInsert = db.prepare(`INSERT INTO meta(key, value) VALUES (?, ?)`)
    metaInsert.run('embedding.current_dims', String(dimCount))
    metaInsert.run('boot.schema_version', '12')
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
  migrateIfNeeded(db, key)
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
function migrateIfNeeded(db, dataDir = null) {
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
  if (current < 5) {
    try {
      db.exec(`ALTER TABLE entries ADD COLUMN project_id TEXT`)
    } catch (e) {
      if (!/duplicate column name/i.test(String(e?.message))) {
        process.stderr.write(`[memory] schema v5 migration failed: ${e.message}\n`)
        return
      }
    }
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project_id) WHERE project_id IS NOT NULL`)
    } catch (e) {
      process.stderr.write(`[memory] schema v5 migration failed: ${e.message}\n`)
      return
    }
    setMetaValue(db, 'boot.schema_version', '5')
    process.stderr.write(`[memory] schema migrated to v5 (project_id)\n`)
  }
  if (current < 6) {
    // v6: reviewed_at tracks when a root was last presented to cycle2 phase2/3,
    // enabling sweep rotation so the same 50 rows are not repeated every cycle.
    // ALTER TABLE … ADD COLUMN with DEFAULT NULL is safe on existing rows.
    // SQLite does not support IF NOT EXISTS on ADD COLUMN; catch "duplicate
    // column name" and treat it as a no-op so the migration is idempotent.
    try {
      db.exec(`ALTER TABLE entries ADD COLUMN reviewed_at INTEGER`)
    } catch (e) {
      if (!/duplicate column name/i.test(String(e?.message))) {
        process.stderr.write(`[memory] schema v6 migration failed: ${e.message}\n`)
        return
      }
    }
    // Backfill NULL → 0 so ORDER BY reviewed_at ASC uses the raw column index
    // (COALESCE wrapping prevents index use; 0 sorts before any real timestamp).
    try {
      db.exec(`UPDATE entries SET reviewed_at = 0 WHERE reviewed_at IS NULL AND is_root = 1`)
    } catch (e) {
      process.stderr.write(`[memory] schema v6 backfill failed: ${e.message}\n`)
    }
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_reviewed_at
        ON entries(reviewed_at ASC)
        WHERE is_root = 1`)
    } catch (e) {
      process.stderr.write(`[memory] schema v6 index failed: ${e.message}\n`)
      return
    }
    setMetaValue(db, 'boot.schema_version', '6')
    process.stderr.write(`[memory] schema migrated to v6 (reviewed_at)\n`)
  }
  if (current < 7) {
    // v7: error_count tracks parse/LLM failures per root so poison rows back
    // off from cycle2 sweep naturally (reviewed_at not advanced on failure).
    try {
      db.exec(`ALTER TABLE entries ADD COLUMN error_count INTEGER NOT NULL DEFAULT 0`)
    } catch (e) {
      if (!/duplicate column name/i.test(String(e?.message))) {
        process.stderr.write(`[memory] schema v7 migration failed: ${e.message}\n`)
        return
      }
    }
    setMetaValue(db, 'boot.schema_version', '7')
    process.stderr.write(`[memory] schema migrated to v7 (error_count)\n`)
  }
  if (current < 8) {
    // v8: composite index for phase2/phase3 sweep queries that filter on
    // (status, is_root, error_count, reviewed_at, id). Without this index
    // the sweep falls back to idx_entries_reviewed_at (single-column) and
    // post-filters error_count on every scanned row.
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_entries_phase_sweep
          ON entries(status, is_root, error_count, reviewed_at, id)
      `)
    } catch (e) {
      if (!/already exists/i.test(String(e?.message))) {
        process.stderr.write(`[memory] schema v8 migration failed: ${e.message}\n`)
        return
      }
    }
    setMetaValue(db, 'boot.schema_version', '8')
    process.stderr.write(`[memory] schema migrated to v8 (idx_entries_phase_sweep)\n`)
  }
  if (current < 9) {
    // v9: migrate user-curated core memory from JSON files to core_entries table.
    // Table is also created in bootstrap for fresh databases.
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS core_entries (
          id          INTEGER PRIMARY KEY,
          element     TEXT NOT NULL,
          summary     TEXT NOT NULL,
          category    TEXT NOT NULL,
          project_id  TEXT,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS core_entries_project_idx ON core_entries(project_id);
      `)
    } catch (e) {
      process.stderr.write(`[memory] schema v9 table creation failed: ${e.message}\n`)
      return
    }

    // Idempotent data migration: skip if already migrated or no dataDir.
    const alreadyMigrated = getMetaValue(db, 'core_migrated_v9') === '1'
    if (!alreadyMigrated && dataDir) {
      const backupTs = Date.now()
      const backupDir = join(dataDir, `.legacy-core-backup-${backupTs}`)
      const log = []
      let migrationOk = false

      const insertStmt = db.prepare(
        `INSERT INTO core_entries(element, summary, category, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      )

      function migrateFileEntries(filePath, entries, projectId) {
        for (const e of entries) {
          const el = String(e.element || '').trim()
          const sm = String(e.summary || e.element || '').trim()
          const cat = String(e.category || 'fact').toLowerCase()
          if (!el) continue
          const res = insertStmt.run(el, sm, cat, projectId, Number(e.created_at) || backupTs, Number(e.updated_at) || backupTs)
          log.push({ legacyPath: filePath, legacyId: e.id, newId: Number(res.lastInsertRowid), project_id: projectId, ts: backupTs })
        }
      }

      db.exec('BEGIN')
      try {
        // Migrate core-memory.json (COMMON, project_id=NULL)
        const skippedFiles = []
        const commonPath = join(dataDir, 'core-memory.json')
        if (existsSync(commonPath)) {
          try {
            const raw = readFileSync(commonPath, 'utf8')
            if (raw.trim()) {
              const parsed = JSON.parse(raw)
              if (parsed && Array.isArray(parsed.entries)) {
                migrateFileEntries(commonPath, parsed.entries, null)
              }
            }
          } catch (e) { skippedFiles.push(`core-memory.json (${e.message})`) }
        }

        // Migrate project-memory/*.json
        const projDir = join(dataDir, 'project-memory')
        if (existsSync(projDir)) {
          let files = []
          try { files = readdirSync(projDir).filter(f => f.endsWith('.json')) } catch {}
          for (const f of files) {
            const filePath = join(projDir, f)
            try {
              const raw = readFileSync(filePath, 'utf8')
              if (raw.trim()) {
                const parsed = JSON.parse(raw)
                if (parsed && Array.isArray(parsed.entries)) {
                  const projectId = (parsed && 'project_id' in parsed && parsed.project_id != null)
                    ? parsed.project_id
                    : f.slice(0, -5).replace(/__/g, '/')
                  migrateFileEntries(filePath, parsed.entries, projectId)
                }
              }
            } catch (e) { skippedFiles.push(`${f} (${e.message})`) }
          }
        }

        // Set migration flag inside the same transaction.
        db.prepare(`INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run('core_migrated_v9', '1')
        db.exec('COMMIT')
        migrationOk = true
        process.stderr.write(`[memory] schema v9: migrated ${log.length} core entries to sqlite\n`)
        if (skippedFiles.length > 0) {
          process.stderr.write(`[memory] v9 migration skipped ${skippedFiles.length} files: ${skippedFiles.map(f => f.split(' (')[0]).join(', ')}\n`)
        }
      } catch (e) {
        try { db.exec('ROLLBACK') } catch {}
        process.stderr.write(`[memory] schema v9 data migration failed: ${e.message}\n`)
        return
      }

      // Write backup log + move JSON files (after successful DB commit).
      if (migrationOk) {
        try {
          mkdirSync(backupDir, { recursive: true })
          const migrationLogPath = join(backupDir, 'migration.log')
          writeFileSync(migrationLogPath, JSON.stringify(log, null, 2), 'utf8')
          if (skippedFiles.length > 0) {
            const skipNote = `\n\n// skipped files:\n${skippedFiles.map(f => `// ${f}`).join('\n')}\n`
            writeFileSync(migrationLogPath, skipNote, { flag: 'a', encoding: 'utf8' })
          }
          const commonPath2 = join(dataDir, 'core-memory.json')
          if (existsSync(commonPath2)) {
            try { renameSync(commonPath2, join(backupDir, 'core-memory.json')) } catch {}
          }
          const projDir2 = join(dataDir, 'project-memory')
          if (existsSync(projDir2)) {
            mkdirSync(join(backupDir, 'project-memory'), { recursive: true })
            let files2 = []
            try { files2 = readdirSync(projDir2).filter(f => f.endsWith('.json')) } catch {}
            for (const f of files2) {
              try { renameSync(join(projDir2, f), join(backupDir, 'project-memory', f)) } catch {}
            }
          }
        } catch (e) {
          process.stderr.write(`[memory] schema v9 backup/move failed (non-fatal): ${e.message}\n`)
        }
      }
    }

    setMetaValue(db, 'boot.schema_version', '9')
    process.stderr.write(`[memory] schema migrated to v9 (core_entries)\n`)
  }
  if (current < 10) {
    // v10: promoted_at captures the timestamp when a root first became 'active'.
    // Unlike last_seen_at (refreshed on every recall hit) and reviewed_at (updated
    // by phase3 keep cycles), promoted_at is set once on first promotion and never
    // overwritten — enabling true staleness detection independent of write-backs.
    try {
      db.exec(`ALTER TABLE entries ADD COLUMN promoted_at INTEGER`)
    } catch (e) {
      if (!/duplicate column name/i.test(String(e?.message))) {
        process.stderr.write(`[memory] schema v10 migration failed: ${e.message}\n`)
        return
      }
    }
    // Backfill existing actives: use the EARLIEST known timestamp (`ts` is the
    // entry's original creation moment). Using last_seen_at would inherit the
    // refresh inflation we are trying to escape; ts is immutable and reflects
    // true age so age-decay correctly catches long-stuck entries.
    try {
      db.exec(`
        UPDATE entries
        SET promoted_at = COALESCE(ts, reviewed_at, last_seen_at)
        WHERE is_root = 1 AND status = 'active' AND promoted_at IS NULL
      `)
    } catch (e) {
      process.stderr.write(`[memory] schema v10 backfill failed: ${e.message}\n`)
    }
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_entries_promoted_at
          ON entries(promoted_at ASC)
          WHERE is_root = 1 AND status = 'active'
      `)
    } catch (e) {
      process.stderr.write(`[memory] schema v10 index failed: ${e.message}\n`)
    }
    setMetaValue(db, 'boot.schema_version', '10')
    process.stderr.write(`[memory] schema migrated to v10 (promoted_at)\n`)
  }
  if (current < 11) {
    // v11: re-backfill promoted_at using `ts` instead of last_seen_at. v10
    // initially used last_seen_at which is refresh-inflated by recall hits;
    // ts is immutable so it reflects true entry age and age-decay correctly
    // archives long-stuck issues/decisions even if recently touched.
    try {
      db.exec(`
        UPDATE entries
        SET promoted_at = COALESCE(ts, reviewed_at, last_seen_at)
        WHERE is_root = 1 AND status = 'active'
      `)
    } catch (e) {
      process.stderr.write(`[memory] schema v11 re-backfill failed: ${e.message}\n`)
    }
    setMetaValue(db, 'boot.schema_version', '11')
    process.stderr.write(`[memory] schema migrated to v11 (promoted_at re-backfill from ts)\n`)
  }
  if (current < 12) {
    // v12: collapse status enum to {pending, active, fixed, archived}.
    // - NULL / 'demoted' / 'processed' rows fold into 'pending' (re-evaluable).
    // - 'fixed' is a new status reserved for user-injected entries that the
    //   LLM cannot archive (only update/merge by user explicit action).
    // The CHECK constraint sits in the table DDL and SQLite cannot ALTER it
    // in place; rewrite via writable_schema temp toggle.
    try {
      db.exec(`
        UPDATE entries
        SET status = 'pending'
        WHERE is_root = 1 AND (status IS NULL OR status IN ('demoted','processed'))
      `)
    } catch (e) {
      process.stderr.write(`[memory] schema v12 status backfill failed: ${e.message}\n`)
      return
    }
    try {
      const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='entries'`).get()
      const oldSql = String(row?.sql ?? '')
      // Target only the enum tuple so we sidestep nested-paren regex bugs.
      const oldEnumTuple = `'active','pending','demoted','processed','archived'`
      const newEnumTuple = `'pending','active','fixed','archived'`
      if (oldSql.includes(oldEnumTuple)) {
        const newSql = oldSql.replace(oldEnumTuple, newEnumTuple)
        const verRow = db.prepare(`PRAGMA schema_version`).get()
        const oldVer = Number(verRow?.schema_version ?? 0)
        db.exec(`PRAGMA writable_schema = 1`)
        db.prepare(`UPDATE sqlite_master SET sql = ? WHERE type='table' AND name='entries'`).run(newSql)
        db.exec(`PRAGMA writable_schema = 0`)
        // Force schema reload so the new CHECK takes effect for live prepares.
        db.exec(`PRAGMA schema_version = ${oldVer + 1}`)
        const ic = db.prepare(`PRAGMA integrity_check`).get()
        const icVal = ic && (ic.integrity_check ?? Object.values(ic)[0])
        if (icVal && icVal !== 'ok') {
          process.stderr.write(`[memory] schema v12 integrity_check warning: ${icVal}\n`)
        }
      } else {
        process.stderr.write(`[memory] schema v12: legacy CHECK enum tuple not found — skipping rewrite (already at v12 shape?)\n`)
      }
    } catch (e) {
      process.stderr.write(`[memory] schema v12 CHECK rewrite failed: ${e.message}\n`)
    }
    try {
      db.exec(`DROP INDEX IF EXISTS idx_roots_active_old`)
      db.exec(`
        CREATE INDEX idx_roots_active_old
          ON entries(status, last_seen_at ASC, score DESC)
          WHERE is_root = 1 AND status = 'active'
      `)
    } catch (e) {
      process.stderr.write(`[memory] schema v12 index rebuild failed: ${e.message}\n`)
    }
    setMetaValue(db, 'boot.schema_version', '12')
    process.stderr.write(`[memory] schema migrated to v12 (status enum collapse + fixed)\n`)
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

export function getDatabase(dataDir) {
  if (!dataDir) return null
  const key = resolve(dataDir)
  return dbs.get(key) ?? null
}
