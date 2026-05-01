/**
 * Trajectory store — records execution metadata for every bridge call.
 * Uses node:sqlite DatabaseSync for atomic, zero-dependency persistence.
 */
import { DatabaseSync } from '../../../lib/sqlite-bridge.mjs';
import { join } from 'path';
import { mkdirSync } from 'fs';

let db = null;
let initFailed = false;

export function initTrajectoryStore(dataDir) {
  if (db || initFailed) return;
  try {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, 'trajectory.sqlite');
    db = new DatabaseSync(dbPath);
    try { db.exec('PRAGMA journal_mode=WAL'); }
    catch { /* WAL can fail on mounted filesystems; rollback journal is fine. */ }
    db.exec(`
      CREATE TABLE IF NOT EXISTS trajectories (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        session_id TEXT,
        scope TEXT,
        preset TEXT,
        model TEXT,
        agent_type TEXT,
        phase TEXT,
        tool_calls_json TEXT,
        iterations INTEGER DEFAULT 1,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        completed INTEGER DEFAULT 1,
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_traj_scope ON trajectories(scope, ts)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_traj_ts ON trajectories(ts)');
    // Retention: keep at most 10 000 rows; delete oldest on init.
    db.exec(`DELETE FROM trajectories WHERE id IN (SELECT id FROM trajectories ORDER BY id DESC LIMIT -1 OFFSET 10000)`);
  } catch (err) {
    initFailed = true;
    db = null;
    try { process.stderr.write(`[trajectory] disabled: ${err?.message || err}\n`); } catch {}
  }
}

const INSERT_SQL = `
  INSERT INTO trajectories (session_id, scope, preset, model, agent_type, phase,
    tool_calls_json, iterations, tokens_in, tokens_out, duration_ms, completed, error_message)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const RETENTION_MAX = 10_000;
const RETENTION_CHECK_EVERY_N = 500;
let _insertsSinceRetention = 0;

export function recordTrajectory(data) {
  if (!db) return;
  // Validate tool_calls_json before inserting.
  let toolCallsJson = data.tool_calls_json || '[]';
  try { JSON.parse(toolCallsJson); } catch { toolCallsJson = '[]'; }
  const stmt = db.prepare(INSERT_SQL);
  stmt.run(
    data.session_id || null,
    data.scope || null,
    data.preset || null,
    data.model || null,
    data.agent_type || null,
    data.phase || null,
    toolCallsJson,
    data.iterations ?? 1,
    data.tokens_in ?? 0,
    data.tokens_out ?? 0,
    data.duration_ms ?? 0,
    data.completed ?? 1,
    data.error_message || null,
  );
  // Periodic retention trim: delete rows beyond the cap.
  if (++_insertsSinceRetention >= RETENTION_CHECK_EVERY_N) {
    _insertsSinceRetention = 0;
    try {
      db.exec(`DELETE FROM trajectories WHERE id IN (SELECT id FROM trajectories ORDER BY id DESC LIMIT -1 OFFSET ${RETENTION_MAX})`);
    } catch { /* best-effort */ }
  }
}

export function getTrajectoryStats(scope, since) {
  if (!db) return null;
  let where = 'WHERE 1=1';
  const params = [];
  if (scope) { where += ' AND scope = ?'; params.push(scope); }
  if (since) { where += ' AND ts >= ?'; params.push(since); }

  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      AVG(duration_ms) as avg_duration,
      ROUND(AVG(completed) * 100, 1) as success_rate,
      SUM(tokens_in) as total_tokens_in,
      SUM(tokens_out) as total_tokens_out
    FROM trajectories ${where}
  `).get(...params);

  const topChains = db.prepare(`
    SELECT tool_calls_json, COUNT(*) as cnt
    FROM trajectories ${where} AND tool_calls_json != '[]'
    GROUP BY tool_calls_json
    ORDER BY cnt DESC
    LIMIT 10
  `).all(...params);

  return {
    total: row.total,
    avgDuration: Math.round(row.avg_duration || 0),
    successRate: row.success_rate || 0,
    totalTokensIn: row.total_tokens_in || 0,
    totalTokensOut: row.total_tokens_out || 0,
    topToolChains: topChains.map(c => {
      let chain = [];
      try { chain = JSON.parse(c.tool_calls_json); } catch { chain = []; }
      return { chain, count: c.cnt };
    }),
  };
}

export function getTrajectoryDb() {
  return db || null;
}

export function findRepeatingPatterns(minOccurrences = 3) {
  if (!db) return [];
  const rows = db.prepare(`
    SELECT tool_calls_json, COUNT(*) as cnt,
      AVG(duration_ms) as avg_dur, AVG(tokens_in + tokens_out) as avg_tok
    FROM trajectories
    WHERE completed = 1 AND tool_calls_json != '[]'
    GROUP BY tool_calls_json
    HAVING cnt >= ?
    ORDER BY cnt DESC
  `).all(minOccurrences);

  return rows.map(r => ({
    pattern: JSON.parse(r.tool_calls_json).map(c => c.name),
    count: r.cnt,
    avgDuration: Math.round(r.avg_dur || 0),
    avgTokens: Math.round(r.avg_tok || 0),
  }));
}
