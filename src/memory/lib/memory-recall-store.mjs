import {
  buildFtsQuery,
} from './memory-text-utils.mjs'
import { vecToHex } from './memory-vector-utils.mjs'
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
  // post-filter time window can wipe the result set; archived/demoted
  // entries also pollute candidates and lure the synthesizer into
  // confidently-wrong attribution.
  const tsFrom = Number.isFinite(Number(options.ts_from)) ? Number(options.ts_from) : null
  const tsTo = Number.isFinite(Number(options.ts_to)) ? Number(options.ts_to) : null
  const excludeStatuses = Array.isArray(options.excludeStatuses)
    ? options.excludeStatuses.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().toLowerCase())
    : ['archived', 'demoted']
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
  // slug     → project_id IS NULL OR project_id = ?
  // 'all'/null → no filter
  let projectScopeClause = ''
  let projectScopeParams = []
  if (projectScope === 'common') {
    projectScopeClause = 'AND project_id IS NULL'
    projectScopeParams = []
  } else if (projectScope && projectScope !== 'all') {
    projectScopeClause = 'AND (project_id IS NULL OR project_id = ?)'
    projectScopeParams = [projectScope]
  }

  if (Array.isArray(options.queryVector) && options.queryVector.length > 0) {
    try {
      const hex = vecToHex(options.queryVector)
      const knnRows = db.prepare(
        `SELECT v.rowid, v.distance
         FROM vec_entries v
         WHERE v.embedding MATCH X'${hex}'
           AND v.rowid IN (SELECT id FROM entries WHERE 1=1 ${projectScopeClause})
         ORDER BY v.distance LIMIT ?`,
      ).all(...projectScopeParams, candidateWindow)
      knnRows.forEach((row, rank) => {
        const id = Number(row.rowid)
        setCandidateRank(candidateIds, id, 'denseRank', rank + 1)
      })
      denseCount = knnRows.length
    } catch { /* vec_entries may be empty */ }
  }

  if (clean.length >= 3) {
    try {
      const ftsStmt = db.prepare(
        `SELECT f.rowid, bm25(entries_fts) AS bm25
         FROM entries_fts AS f
         WHERE entries_fts MATCH ?
           AND f.rowid IN (SELECT id FROM entries WHERE 1=1 ${projectScopeClause})
         ORDER BY bm25 LIMIT ?`,
      )
      const ftsQueries = [buildFtsQuery(clean)].filter(Boolean)
      for (const [variantIndex, ftsQuery] of ftsQueries.entries()) {
        const ftsRows = ftsStmt.all(ftsQuery, ...projectScopeParams, candidateWindow)
        ftsRows.forEach((row, rank) => {
          const id = Number(row.rowid)
          setCandidateRank(candidateIds, id, 'sparseRank', rank + 1 + variantIndex)
        })
        sparseCount += ftsRows.length
      }
    } catch { /* fts unavailable */ }
  } else {
    try {
      const likePattern = `%${clean}%`
      const likeRows = db.prepare(
        `SELECT id FROM entries
         WHERE (content LIKE ? OR summary LIKE ? OR element LIKE ?) ${projectScopeClause}
         ORDER BY ts DESC LIMIT ?`,
      ).all(likePattern, likePattern, likePattern, ...projectScopeParams, candidateWindow)
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
  const placeholders = topIds.map(() => '?').join(',')
  const filterClauses = []
  const filterParams = []
  if (tsFrom != null) { filterClauses.push('ts >= ?'); filterParams.push(tsFrom) }
  if (tsTo != null) { filterClauses.push('ts <= ?'); filterParams.push(tsTo) }
  if (excludeStatuses.length > 0) {
    filterClauses.push(`(status IS NULL OR status NOT IN (${excludeStatuses.map(() => '?').join(',')}))`)
    filterParams.push(...excludeStatuses)
  }
  if (projectScope === 'common') {
    filterClauses.push(`project_id IS NULL`)
  } else if (projectScope && projectScope !== 'all') {
    filterClauses.push(`(project_id IS NULL OR project_id = ?)`)
    filterParams.push(projectScope)
  }
  const filterSql = filterClauses.length > 0 ? ` AND ${filterClauses.join(' AND ')}` : ''
  const rawRows = db.prepare(
    `SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
            element, category, summary, project_id, status, score, last_seen_at
     FROM entries WHERE id IN (${placeholders})${filterSql}`,
  ).all(...topIds, ...filterParams)
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
      const rootScopeClauses = []
      const rootScopeParams = []
      if (projectScope === 'common') {
        rootScopeClauses.push('project_id IS NULL')
      } else if (projectScope && projectScope !== 'all') {
        rootScopeClauses.push('(project_id IS NULL OR project_id = ?)')
        rootScopeParams.push(projectScope)
      }
      const rootScopeExtra = rootScopeClauses.length > 0 ? ` AND ${rootScopeClauses.join(' AND ')}` : ''
      const r = db.prepare(
        `SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
                element, category, summary, project_id, status, score, last_seen_at
         FROM entries WHERE id = ? AND is_root = 1${rootScopeExtra}`,
      ).get(row.chunk_root, ...rootScopeParams)
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
    const updateRoot = db.prepare(
      `UPDATE entries SET last_seen_at = ?, score = ? WHERE id = ? AND is_root = 1`,
    )
    for (const rootId of memberHitRootIds) {
      const r = rootIdsForReturn.find(x => x.root.id === rootId)?.root ?? byId.get(rootId)
      if (!r) continue
      const newScore = computeEntryScore(r.category, nowMs, nowMs)
      try {
        updateRoot.run(nowMs, newScore, rootId)
        writeBackCount += 1
      } catch (err) {
        process.stderr.write(`[recall] writeback failed (root=${rootId}): ${err.message}\n`)
      }
    }
  }

  const results = rootIdsForReturn.map(({ root, rrf, retrievalScore, retrievalRank }) => {
    const out = { ...root, rrf, retrievalScore, retrievalRank }
    if (includeMembers && root.is_root === 1) {
      out.members = db.prepare(
        `SELECT id, ts, role, content, session_id, source_turn
         , project_id
         FROM entries WHERE chunk_root = ? AND is_root = 0
         ORDER BY ts ASC, id ASC`,
      ).all(root.id)
    }
    return out
  })

  process.stderr.write(
    `[recall] dense=${denseCount} sparse=${sparseCount} merged=${results.length} write_back=${writeBackCount}\n`,
  )

  return results
}
