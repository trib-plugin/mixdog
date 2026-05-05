/**
 * Trajectory store — records execution metadata for every bridge call.
 * Backed by PGlite (shared pgdata) — same handle as the memory store.
 */
import { getDatabase } from '../../memory/lib/memory.mjs';

let db = null;
let initFailed = false;

export async function initTrajectoryStore(dataDir) {
  if (db || initFailed) return;
  db = getDatabase(dataDir);
  if (!db) {
    initFailed = true;
    try { process.stderr.write(`[trajectory] disabled: pgdata handle unavailable\n`); } catch {}
    return;
  }
  // Initial retention trim — keep at most RETENTION_MAX rows.
  try {
    await db.query(
      `DELETE FROM trajectories WHERE id NOT IN (SELECT id FROM trajectories ORDER BY id DESC LIMIT ${RETENTION_MAX})`
    );
  } catch (err) {
    try { process.stderr.write(`[trajectory] initial retention failed: ${err?.message || err}\n`); } catch {}
  }
}

const RETENTION_MAX = 10_000;
const RETENTION_CHECK_EVERY_N = 500;
let _insertsSinceRetention = 0;

const INSERT_SQL = `
  INSERT INTO trajectories (session_id, scope, preset, model, agent_type, phase,
    tool_calls_json, iterations, tokens_in, tokens_out, duration_ms, completed, error_message)
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13)
`;

export async function recordTrajectory(data) {
  if (!db) return;
  let toolCallsJson = data.tool_calls_json || '[]';
  try { JSON.parse(toolCallsJson); } catch { toolCallsJson = '[]'; }
  await db.query(INSERT_SQL, [
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
  ]);
  if (++_insertsSinceRetention >= RETENTION_CHECK_EVERY_N) {
    _insertsSinceRetention = 0;
    try {
      await db.query(
        `DELETE FROM trajectories WHERE id NOT IN (SELECT id FROM trajectories ORDER BY id DESC LIMIT ${RETENTION_MAX})`
      );
    } catch { /* best-effort */ }
  }
}

export async function getTrajectoryStats(scope, since) {
  if (!db) return null;
  const params = [];
  let where = 'WHERE 1=1';
  if (scope) { where += ` AND scope = $${params.length + 1}`; params.push(scope); }
  if (since) { where += ` AND ts >= $${params.length + 1}`; params.push(since); }

  const r = await db.query(`
    SELECT
      COUNT(*) as total,
      AVG(duration_ms) as avg_duration,
      ROUND(AVG(completed) * 100, 1) as success_rate,
      SUM(tokens_in) as total_tokens_in,
      SUM(tokens_out) as total_tokens_out
    FROM trajectories ${where}
  `, params);
  const row = r.rows[0] || {};

  const tc = await db.query(`
    SELECT tool_calls_json::text AS tool_calls_json, COUNT(*) AS cnt
    FROM trajectories ${where} AND tool_calls_json::text != '[]'
    GROUP BY tool_calls_json
    ORDER BY cnt DESC
    LIMIT 10
  `, params);

  return {
    total: Number(row.total ?? 0),
    avgDuration: Math.round(Number(row.avg_duration) || 0),
    successRate: Number(row.success_rate) || 0,
    totalTokensIn: Number(row.total_tokens_in) || 0,
    totalTokensOut: Number(row.total_tokens_out) || 0,
    topToolChains: tc.rows.map(c => {
      let chain = [];
      try { chain = JSON.parse(c.tool_calls_json); } catch { chain = []; }
      return { chain, count: Number(c.cnt) };
    }),
  };
}

export function getTrajectoryDb() {
  return db || null;
}

export async function findRepeatingPatterns(minOccurrences = 3) {
  if (!db) return [];
  const r = await db.query(`
    SELECT tool_calls_json::text AS tool_calls_json, COUNT(*) AS cnt,
      AVG(duration_ms) AS avg_dur, AVG(tokens_in + tokens_out) AS avg_tok
    FROM trajectories
    WHERE completed = 1 AND tool_calls_json::text != '[]'
    GROUP BY tool_calls_json
    HAVING COUNT(*) >= $1
    ORDER BY cnt DESC
  `, [minOccurrences]);
  return r.rows.map(row => ({
    pattern: (() => { try { return JSON.parse(row.tool_calls_json).map(c => c.name); } catch { return []; } })(),
    count: Number(row.cnt),
    avgDuration: Math.round(Number(row.avg_dur) || 0),
    avgTokens: Math.round(Number(row.avg_tok) || 0),
  }));
}
