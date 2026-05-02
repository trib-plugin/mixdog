const VALID_CATEGORIES_SET = new Set([
  'rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue',
])
const VALID_STATUS_SET = new Set(['active', 'pending', 'demoted', 'processed', 'archived'])

export function retrieveEntries(db, filters = {}) {
  const where = []
  const params = []

  const isRoot = filters.is_root === undefined ? true : Boolean(filters.is_root)
  where.push(`is_root = ?`)
  params.push(isRoot ? 1 : 0)

  if (filters.session_id != null) {
    const sid = String(filters.session_id).trim()
    if (sid) { where.push(`session_id = ?`); params.push(sid) }
  }

  const tsFrom = Number(filters.ts_from)
  if (Number.isFinite(tsFrom)) { where.push(`ts >= ?`); params.push(tsFrom) }
  const tsTo = Number(filters.ts_to)
  if (Number.isFinite(tsTo)) { where.push(`ts <= ?`); params.push(tsTo) }

  if (filters.category != null) {
    const cats = (Array.isArray(filters.category) ? filters.category : [filters.category])
      .map(c => String(c).trim().toLowerCase())
      .filter(c => VALID_CATEGORIES_SET.has(c))
    if (cats.length > 0) {
      where.push(`category IN (${cats.map(() => '?').join(',')})`)
      params.push(...cats)
    }
  }

  if (filters.status != null) {
    const statusVal = String(filters.status).trim().toLowerCase()
    if (VALID_STATUS_SET.has(statusVal)) {
      where.push(`status = ?`)
      params.push(statusVal)
    }
  }

  // R11 reviewer H2: exclude archived/demoted leakage in temporal augment paths.
  if (Array.isArray(filters.excludeStatuses) && filters.excludeStatuses.length > 0) {
    const exc = filters.excludeStatuses
      .map(s => String(s).trim().toLowerCase())
      .filter(s => VALID_STATUS_SET.has(s))
    if (exc.length > 0) {
      where.push(`(status IS NULL OR status NOT IN (${exc.map(() => '?').join(',')}))`)
      params.push(...exc)
    }
  }

  // R11 reviewer M3: orphan raw chunks (chunk_root IS NULL) for narrow-window
  // raw merging — prevents classified-member chunks from duplicating their root.
  if (filters.chunkRootNull === true) {
    where.push(`chunk_root IS NULL`)
  }

  const limit = Math.max(1, Math.min(500, Number(filters.limit ?? 50)))
  const offset = Math.max(0, Number(filters.offset ?? 0))
  const orderBy = 'score DESC NULLS LAST, ts DESC, id DESC'

  const sql = `SELECT id, ts, role, content, source_ref, session_id, source_turn,
                      chunk_root, is_root, element, category, summary,
                      status, score, last_seen_at
               FROM entries
               WHERE ${where.join(' AND ')}
               ORDER BY ${orderBy}
               LIMIT ? OFFSET ?`
  params.push(limit, offset)

  const rows = db.prepare(sql).all(...params)

  if (filters.includeMembers && rows.length > 0) {
    const memberStmt = db.prepare(
      `SELECT id, ts, role, content, session_id, source_turn
       FROM entries WHERE chunk_root = ? AND is_root = 0
       ORDER BY ts ASC, id ASC`,
    )
    for (const r of rows) r.members = memberStmt.all(r.id)
  }

  return rows
}
