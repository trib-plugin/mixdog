import {
  buildFtsQuery,
} from './memory-text-utils.mjs'
import { embeddingToSql } from './memory.mjs'
import { computeEntryScore, freshnessFactor } from './memory-score.mjs'

function setCandidateRank(candidateIds, id, key, rank) {
  if (!Number.isFinite(id) || !Number.isFinite(rank) || rank <= 0) return
  if (!candidateIds.has(id)) candidateIds.set(id, { denseRank: null, sparseRank: null })
  const prev = candidateIds.get(id)[key]
  candidateIds.get(id)[key] = prev == null ? rank : Math.min(prev, rank)
}

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

  const candidateIds = new Map()
  let denseCount = 0
  let sparseCount = 0

  // Build project scope SQL fragment and bind params for candidate SELECTs.
  // Used in subquery forms (dense/FTS) and direct WHERE forms (LIKE).
  // 'common' → project_id IS NULL
  // slug     → project_id IS NULL OR project_id = $N
  // 'all'/null → no filter
  // scopeParamOffset is the 1-based index of the first scope param in the query.
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

  if (Array.isArray(options.queryVector) && options.queryVector.length > 0) {
    try {
      const vecSql = embeddingToSql(options.queryVector)
      // $1 = vector, filter params start at $2, LIMIT = last param
      const { clause: filterClause, params: filterParams } = buildFilterClause(2)
      const limitIdx = 2 + filterParams.length
      const { rows: knnRows } = await db.query(
        `SELECT id, 1 - (embedding <=> $1::vector) AS sim
         FROM entries
         WHERE is_root = 1 AND embedding IS NOT NULL ${filterClause}
         ORDER BY embedding <=> $1::vector LIMIT $${limitIdx}`,
        [vecSql, ...filterParams, candidateWindow],
      )
      knnRows.forEach((row, rank) => {
        const id = Number(row.id)
        setCandidateRank(candidateIds, id, 'denseRank', rank + 1)
      })
      denseCount = knnRows.length
    } catch { /* embedding column may be empty */ }
  }

  if (clean.length >= 3) {
    try {
      const ftsQueries = [buildFtsQuery(clean)].filter(Boolean)
      for (const [variantIndex, ftsQuery] of ftsQueries.entries()) {
        // $1 = tsquery text, filter params start at $2, LIMIT = last param
        const { clause: filterClause, params: filterParams } = buildFilterClause(2)
        const limitIdx = 2 + filterParams.length
        const { rows: ftsRows } = await db.query(
          `SELECT id, ts_rank_cd(search_tsv, to_tsquery('simple', $1)) AS lex
           FROM entries
           WHERE is_root = 1
             AND search_tsv @@ to_tsquery('simple', $1)
             ${filterClause}
           ORDER BY lex DESC LIMIT $${limitIdx}`,
          [ftsQuery, ...filterParams, candidateWindow],
        )
        ftsRows.forEach((row, rank) => {
          const id = Number(row.id)
          setCandidateRank(candidateIds, id, 'sparseRank', rank + 1 + variantIndex)
        })
        sparseCount += ftsRows.length
      }
    } catch { /* fts unavailable */ }
  } else {
    try {
      const likePattern = `%${clean}%`
      // $1,$2,$3 = likePattern x3, filter params start at $4, LIMIT = last param
      const { clause: filterClause, params: filterParams } = buildFilterClause(4)
      const limitIdx = 4 + filterParams.length
      const { rows: likeRows } = await db.query(
        `SELECT id FROM entries
         WHERE (content LIKE $1 OR summary LIKE $2 OR element LIKE $3) ${filterClause}
         ORDER BY ts DESC LIMIT $${limitIdx}`,
        [likePattern, likePattern, likePattern, ...filterParams, candidateWindow],
      )
      likeRows.forEach((row, rank) => {
        const id = Number(row.id)
        setCandidateRank(candidateIds, id, 'sparseRank', rank + 1)
      })
      sparseCount = likeRows.length
    } catch { /* ignore */ }
  }

  if (candidateIds.size === 0) return []

  // K=60 is the standard RRF constant from Cormack et al. (SIGIR 2009).
  const K = 60
  const scored = []
  for (const [id, ranks] of candidateIds) {
    const rrf = (ranks.denseRank ? 1 / (K + ranks.denseRank) : 0)
              + (ranks.sparseRank ? 1 / (K + ranks.sparseRank) : 0)
    scored.push({ id, rrf })
  }
  scored.sort((a, b) => b.rrf - a.rrf)

  const topIds = scored.map(s => s.id)
  const filterClauses = []
  const filterParams = []
  if (tsFrom != null) { filterClauses.push(`ts >= $${topIds.length + filterParams.length + 1}`); filterParams.push(tsFrom) }
  if (tsTo != null) { filterClauses.push(`ts <= $${topIds.length + filterParams.length + 1}`); filterParams.push(tsTo) }
  if (excludeStatuses.length > 0) {
    const statusPlaceholders = excludeStatuses.map((_, i) => `$${topIds.length + filterParams.length + i + 1}`).join(',')
    filterClauses.push(`(status IS NULL OR status NOT IN (${statusPlaceholders}))`)
    filterParams.push(...excludeStatuses)
  }
  if (projectScope === 'common') {
    filterClauses.push(`project_id IS NULL`)
  } else if (projectScope && projectScope !== 'all') {
    filterClauses.push(`(project_id IS NULL OR project_id = $${topIds.length + filterParams.length + 1})`)
    filterParams.push(projectScope)
  }
  const filterSql = filterClauses.length > 0 ? ` AND ${filterClauses.join(' AND ')}` : ''
  const idPlaceholders = topIds.map((_, i) => `$${i + 1}`).join(',')
  const { rows: rawRows } = await db.query(
    `SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
            element, category, summary, project_id, status, score, last_seen_at
     FROM entries WHERE id IN (${idPlaceholders})${filterSql}`,
    [...topIds, ...filterParams],
  )
  const byId = new Map(rawRows.map(r => [Number(r.id), r]))
  const nowMs = Date.now()
  // Age decay multiplier applied to retrievalScore. R5: shared with
  // handleSearch augment path via memory-score.mjs export.
  const ranked = scored
    .map((entry) => {
      const row = byId.get(entry.id)
      const freshness = applyFreshness ? freshnessFactor(row?.ts, nowMs) : 1.0
      return {
        ...entry,
        freshness,
        retrievalScore: entry.rrf * freshness,
      }
    })
    .filter(entry => entry.retrievalScore >= minRetrievalScore)
    .sort((a, b) => b.retrievalScore - a.retrievalScore || b.rrf - a.rrf)

  const memberHitRootIds = new Set()
  const rootIdsForReturn = []
  const seen = new Set()

  for (const { id, rrf, retrievalScore } of ranked) {
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
      const newScore = computeEntryScore(r.category, nowMs, nowMs)
      try {
        await db.query(
          `UPDATE entries SET last_seen_at = $1, score = $2 WHERE id = $3 AND is_root = 1`,
          [nowMs, newScore, rootId],
        )
        writeBackCount += 1
      } catch (err) {
        process.stderr.write(`[recall] writeback failed (root=${rootId}): ${err.message}\n`)
      }
    }
  }

  const results = await Promise.all(rootIdsForReturn.map(async ({ root, rrf, retrievalScore, retrievalRank }) => {
    const out = { ...root, rrf, retrievalScore, retrievalRank }
    if (includeMembers && root.is_root === 1) {
      const { rows: memberRows } = await db.query(
        `SELECT id, ts, role, content, session_id, source_turn
         , project_id
         FROM entries WHERE chunk_root = $1 AND is_root = 0
         ORDER BY ts ASC, id ASC`,
        [root.id],
      )
      out.members = memberRows
    }
    return out
  }))

  process.stderr.write(
    `[recall] dense=${denseCount} sparse=${sparseCount} merged=${results.length} write_back=${writeBackCount}\n`,
  )

  return results
}
