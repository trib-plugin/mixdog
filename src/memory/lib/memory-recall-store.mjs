import {
  buildFtsQuery,
} from './memory-text-utils.mjs'
import { embeddingToSql } from './memory.mjs'
import { freshnessFactor } from './memory-score.mjs'

// Trigram similarity threshold for the pg_trgm % operator.
// 0.10 is intentionally permissive — short phrases (3–5 chars) rarely
// exceed 0.3 similarity against longer content strings. Filtering is
// left to the RRF re-rank that follows.
const TRGM_THRESHOLD = 0.10

export async function searchRelevantHybrid(db, query, options = {}) {
  const clean = String(query ?? '').trim()
  if (!clean) return []

  const limit = Math.max(1, Math.floor(Number(options?.limit ?? 8)))
  const candidateWindow = limit * 5
  const includeMembers = Boolean(options.includeMembers)
  const writeBackMemberHits = options.writeBackMemberHits !== false
  // Pre-filter knobs. Without them, FTS/vec rank the whole tree and a
  // post-filter time window can wipe the result set; archived
  // entries pollute candidates and lure the synthesizer into
  // confidently-wrong attribution.
  const tsFrom = Number.isFinite(Number(options.ts_from)) ? Number(options.ts_from) : null
  const tsTo = Number.isFinite(Number(options.ts_to)) ? Number(options.ts_to) : null
  const excludeStatuses = Array.isArray(options.excludeStatuses)
    ? options.excludeStatuses.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().toLowerCase())
    : ['archived']
  const minRetrievalScore = Number.isFinite(Number(options.minRetrievalScore))
    ? Number(options.minRetrievalScore)
    : 0
  // R11 reviewer M4: caller can disable freshness decay when the period
  // is calendar-bounded (yesterday / today / this_week / last_week / a
  // specific date). Inside a fixed window, applying absolute-age decay
  // makes Mon score 0.7 and Sun 1.4 within the same calendar week, which
  // misranks early-week decisions vs late-week chatter.
  const applyFreshness = options.applyFreshness !== false
  // Project scope pre-filter applied to the candidate fetch SQL.
  // 'common' → project_id IS NULL; specific slug → project_id IS NULL OR = slug;
  // 'all' or undefined → no filter.
  const projectScope = typeof options.projectScope === 'string' ? options.projectScope : null

  // buildFilterClause: pushes ts/status/scope filters INTO candidate SELECTs.
  // offset = 1-based index of the first bind param it may consume.
  // Returns { clause: string, params: any[] }; clause begins with AND or is ''.
  function buildFilterClause(offset) {
    const clauses = []
    const params = []
    let next = offset
    if (tsFrom != null) {
      clauses.push(`ts >= $${next++}`)
      params.push(tsFrom)
    }
    if (tsTo != null) {
      clauses.push(`ts <= $${next++}`)
      params.push(tsTo)
    }
    if (excludeStatuses.length > 0) {
      const placeholders = excludeStatuses.map(() => `$${next++}`).join(', ')
      clauses.push(`(status IS NULL OR status NOT IN (${placeholders}))`)
      params.push(...excludeStatuses)
    }
    if (projectScope === 'common') {
      clauses.push('project_id IS NULL')
    } else if (projectScope && projectScope !== 'all') {
      clauses.push(`(project_id IS NULL OR project_id = $${next++})`)
      params.push(projectScope)
    }
    const clause = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : ''
    return { clause, params }
  }

  // Kept for the non-candidate root-lookup inside the member-hit resolution path.
  function buildScopeClause(offset) {
    if (projectScope === 'common') {
      return { clause: 'AND project_id IS NULL', params: [] }
    } else if (projectScope && projectScope !== 'all') {
      return { clause: `AND (project_id IS NULL OR project_id = $${offset})`, params: [projectScope] }
    }
    return { clause: '', params: [] }
  }

  // ── Single-round-trip hybrid CTE ─────────────────────────────────────────
  // Param layout (fixed prefix):
  //   $1  = halfvec literal  (NULL when no queryVector)
  //   $2  = tsQuery text     (NULL when short query)
  //   $3  = cleanText        (trigram term)
  //   $4  = candidateWindow  (LIMIT for each CTE leg)
  //   $5+ = filter params (ts_from, ts_to, excludeStatuses..., projectScope slug)
  //
  // When a leg is inapplicable its CTE returns no rows; the UNION + LEFT JOINs
  // handle that cleanly. dense/sparse/trgm legs each re-use the same filter
  // params starting at $5 since they live in independent CTE scopes.

  const vecSql = (Array.isArray(options.queryVector) && options.queryVector.length > 0)
    ? embeddingToSql(options.queryVector)
    : null

  const ftsQuery = clean.length >= 3 ? (buildFtsQuery(clean) ?? null) : null

  // For very short queries (< 3 chars) the trigram operator still works but
  // we relax the server-side threshold via set_limit() — however that requires
  // a separate round-trip. Instead we fall back to a plain ILIKE scan for
  // short text (rare edge case; sequential scan is acceptable for < 3 chars).
  const isShortQuery = clean.length < 3

  // $5 onward are the shared filter params; each CTE leg duplicates the same
  // positional params because they live in independent SELECT scopes.
  const { clause: filterClause, params: filterParams } = buildFilterClause(5)
  const bindParams = [vecSql, ftsQuery, clean, candidateWindow, ...filterParams]

  // dense CTE: active only when a query vector is supplied.
  const denseCte = vecSql ? `
dense AS (
  SELECT id,
         1 - (embedding <=> $1::halfvec) AS sim,
         ROW_NUMBER() OVER (ORDER BY embedding <=> $1::halfvec) AS dense_rank
  FROM entries
  WHERE is_root = 1 AND embedding IS NOT NULL
    ${filterClause}
  ORDER BY embedding <=> $1::halfvec
  LIMIT $4
),` : `
dense AS (SELECT NULL::bigint AS id, NULL::float8 AS sim, NULL::bigint AS dense_rank WHERE false),`

  // sparse CTE: active only when ftsQuery is non-null.
  const sparseCte = ftsQuery ? `
sparse AS (
  SELECT id,
         ts_rank_cd(search_tsv, to_tsquery('simple', $2)) AS lex,
         ROW_NUMBER() OVER (ORDER BY ts_rank_cd(search_tsv, to_tsquery('simple', $2)) DESC) AS sparse_rank
  FROM entries
  WHERE is_root = 1 AND search_tsv @@ to_tsquery('simple', $2)
    ${filterClause}
  ORDER BY lex DESC
  LIMIT $4
),` : `
sparse AS (SELECT NULL::bigint AS id, NULL::float8 AS lex, NULL::bigint AS sparse_rank WHERE false),`

  // trgm CTE: pg_trgm similarity path. For short queries (< 3 chars) the %
  // operator is unreliable (trigrams need at least 3 chars); use ILIKE instead.
  const trgmCte = isShortQuery ? `
trgm AS (
  SELECT id,
         0.5::float8 AS trg_sim,
         ROW_NUMBER() OVER (ORDER BY ts DESC) AS trgm_rank
  FROM entries
  WHERE is_root = 1
    AND (content ILIKE '%' || $3 || '%' OR summary ILIKE '%' || $3 || '%' OR element ILIKE '%' || $3 || '%')
    ${filterClause}
  ORDER BY ts DESC
  LIMIT $4
),` : `
trgm AS (
  SELECT id,
         GREATEST(
           similarity(content,               $3),
           similarity(coalesce(element, ''),  $3),
           similarity(coalesce(summary, ''),  $3)
         ) AS trg_sim,
         ROW_NUMBER() OVER (ORDER BY GREATEST(
           similarity(content,               $3),
           similarity(coalesce(element, ''),  $3),
           similarity(coalesce(summary, ''),  $3)
         ) DESC) AS trgm_rank
  FROM entries
  WHERE is_root = 1
    AND (content % $3 OR element % $3 OR summary % $3)
    AND GREATEST(similarity(content, $3), similarity(coalesce(element, ''), $3), similarity(coalesce(summary, ''), $3)) >= ${TRGM_THRESHOLD}
    ${filterClause}
  ORDER BY trg_sim DESC
  LIMIT $4
),`

  const hybridSql = `
WITH
${denseCte}
${sparseCte}
${trgmCte}
combined AS (
  SELECT id FROM dense  WHERE id IS NOT NULL UNION
  SELECT id FROM sparse WHERE id IS NOT NULL UNION
  SELECT id FROM trgm   WHERE id IS NOT NULL
)
SELECT
  e.id, e.element, e.summary, e.category, e.status, e.score,
  e.last_seen_at, e.ts, e.project_id, e.session_id, e.source_ref,
  e.source_turn, e.content, e.chunk_root, e.is_root,
  e.role,
  d.sim        AS dense_sim,
  d.dense_rank,
  s.lex        AS sparse_lex,
  s.sparse_rank,
  t.trg_sim,
  t.trgm_rank
FROM combined c
JOIN   entries e ON e.id = c.id
LEFT JOIN dense  d ON d.id = c.id
LEFT JOIN sparse s ON s.id = c.id
LEFT JOIN trgm   t ON t.id = c.id`

  let rawRows = []
  let denseCount = 0
  let sparseCount = 0
  let trgmCount = 0

  try {
    const { rows } = await db.query(hybridSql, bindParams)
    rawRows = rows
    // Count how many rows each leg contributed (a row may appear in multiple legs).
    for (const r of rawRows) {
      if (r.dense_rank != null) denseCount++
      if (r.sparse_rank != null) sparseCount++
      if (r.trgm_rank != null) trgmCount++
    }
  } catch (err) {
    process.stderr.write(`[recall] hybrid CTE failed: ${err.message}\n`)
    return []
  }

  if (rawRows.length === 0) return []

  // ── JS-side RRF merge (unchanged logic) ──────────────────────────────────
  // K=60 is the standard RRF constant from Cormack et al. (SIGIR 2009).
  const K = 60
  const nowMs = Date.now()

  const scored = rawRows.map(row => {
    const id = Number(row.id)
    const denseRank = row.dense_rank != null ? Number(row.dense_rank) : null
    const sparseRank = row.sparse_rank != null ? Number(row.sparse_rank) : null
    const trgmRank = row.trgm_rank != null ? Number(row.trgm_rank) : null
    const rrf = (denseRank ? 1 / (K + denseRank) : 0)
              + (sparseRank ? 1 / (K + sparseRank) : 0)
              + (trgmRank ? 1 / (K + trgmRank) : 0)
    const freshness = applyFreshness ? freshnessFactor(row.ts, nowMs) : 1.0
    return { id, row, rrf, freshness, retrievalScore: rrf * freshness }
  })
  scored.sort((a, b) => b.retrievalScore - a.retrievalScore || b.rrf - a.rrf)

  const filtered = scored.filter(e => e.retrievalScore >= minRetrievalScore)

  // ── Root resolution + member-hit write-back ───────────────────────────────
  const byId = new Map(rawRows.map(r => [Number(r.id), r]))
  const memberHitRootIds = new Set()
  const rootIdsForReturn = []
  const seen = new Set()

  for (const { id, rrf, retrievalScore } of filtered) {
    const row = byId.get(id)
    if (!row) continue
    let targetRow = null
    if (row.is_root === 1) {
      targetRow = row
    } else if (row.chunk_root != null && row.chunk_root !== row.id) {
      // $1 = chunk_root id, scope param (if any) = $2
      const { clause: rootScopeClause, params: rootScopeParams } = buildScopeClause(2)
      const { rows: rootRows } = await db.query(
        `SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
                element, category, summary, project_id, status, score, last_seen_at
         FROM entries WHERE id = $1 AND is_root = 1 ${rootScopeClause}`,
        [row.chunk_root, ...rootScopeParams],
      )
      const r = rootRows[0]
      if (!r) continue
      memberHitRootIds.add(r.id)
      targetRow = r
    } else {
      targetRow = row
    }
    if (seen.has(targetRow.id)) continue
    seen.add(targetRow.id)
    rootIdsForReturn.push({
      root: targetRow,
      rrf,
      retrievalScore,
      retrievalRank: rootIdsForReturn.length + 1,
    })
    if (rootIdsForReturn.length >= limit) break
  }

  let writeBackCount = 0
  if (writeBackMemberHits && memberHitRootIds.size > 0) {
    for (const rootId of memberHitRootIds) {
      const r = rootIdsForReturn.find(x => x.root.id === rootId)?.root ?? byId.get(rootId)
      if (!r) continue
      try {
        await db.query(
          `UPDATE entries SET last_seen_at = $1 WHERE id = $2 AND is_root = 1`,
          [nowMs, rootId],
        )
        writeBackCount += 1
      } catch (err) {
        process.stderr.write(`[recall] writeback failed (root=${rootId}): ${err.message}\n`)
      }
    }
  }

  // ── Final fetch: full row for each root by id = ANY(bigint[]) ────────────
  const topIds = rootIdsForReturn.map(x => Number(x.root.id))
  const { clause: finalFilter, params: finalFilterParams } = buildFilterClause(2)
  const { rows: finalRows } = await db.query(
    `SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
            element, category, summary, project_id, status, score, last_seen_at
     FROM entries
     WHERE id = ANY($1::bigint[])
       ${finalFilter}`,
    [topIds, ...finalFilterParams],
  )
  const finalById = new Map(finalRows.map(r => [Number(r.id), r]))

  const results = await Promise.all(rootIdsForReturn.map(async ({ root, rrf, retrievalScore, retrievalRank }) => {
    const finalRoot = finalById.get(Number(root.id)) ?? root
    const out = { ...finalRoot, rrf, retrievalScore, retrievalRank }
    if (includeMembers && finalRoot.is_root === 1) {
      const { rows: memberRows } = await db.query(
        `SELECT id, ts, role, content, session_id, source_turn, project_id
         FROM entries WHERE chunk_root = $1 AND is_root = 0
         ORDER BY ts ASC, id ASC`,
        [finalRoot.id],
      )
      out.members = memberRows
    }
    return out
  }))

  process.stderr.write(
    `[recall] dense=${denseCount} sparse=${sparseCount} trgm=${trgmCount} merged=${results.length} write_back=${writeBackCount}\n`,
  )

  return results
}
