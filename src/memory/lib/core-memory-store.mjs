// User-curated core memory store — PGlite-backed via core_entries table.
// Per-project entries distinguished by project_id column (NULL = COMMON).
// Independent of the entries table (cycle1/cycle2/prune/rebuild do not touch core_entries).
// Surfaced into the SessionStart Core Memory section by the session-start hook.

import { getDatabase } from './memory.mjs'

const VALID_CAT = new Set([
  'rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue',
])

function trimOrNull(v) {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

function _getDb(dataDir) {
  if (!dataDir) throw new Error('core-memory: dataDir required')
  const db = getDatabase(dataDir)
  if (!db) throw new Error('core-memory: database not open — call openDatabase first')
  return db
}

export async function listCore(dataDir, projectId = null) {
  const db = _getDb(dataDir)
  const cols = `id, element, summary, category, project_id, created_at, updated_at`
  if (projectId === null) {
    const r = await db.query(`SELECT ${cols} FROM core_entries WHERE project_id IS NULL ORDER BY id ASC`)
    return r.rows
  }
  const r = await db.query(`SELECT ${cols} FROM core_entries WHERE project_id = $1 ORDER BY id ASC`, [projectId])
  return r.rows
}

export async function addCore(dataDir, { element, summary, category }, projectId) {
  if (projectId === undefined) throw new Error('addCore: projectId required — pass null for COMMON pool, or slug string for scoped pool')
  const el = trimOrNull(element)
  const sm = trimOrNull(summary) ?? el
  if (!el || !sm) throw new Error('add requires element and summary')
  const cat = (trimOrNull(category) ?? 'fact').toLowerCase()
  if (!VALID_CAT.has(cat)) {
    throw new Error(`invalid category "${cat}". Valid: ${[...VALID_CAT].join(', ')}`)
  }
  const db = _getDb(dataDir)
  const now = Date.now()
  const r = await db.query(
    `INSERT INTO core_entries(element, summary, category, project_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, element, summary, category, project_id, created_at, updated_at`,
    [el, sm, cat, projectId, now, now],
  )
  return r.rows[0]
}

export async function editCore(dataDir, id, patch) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required')
  const db = _getDb(dataDir)
  const cur = (await db.query(`SELECT * FROM core_entries WHERE id = $1`, [numId])).rows[0]
  if (!cur) throw new Error(`no entry with id=${numId}`)
  const newElement = trimOrNull(patch.element) ?? cur.element
  const newSummary = trimOrNull(patch.summary) ?? cur.summary
  const newCategoryRaw = trimOrNull(patch.category)
  const newCategory = newCategoryRaw ? newCategoryRaw.toLowerCase() : cur.category
  if (!VALID_CAT.has(newCategory)) {
    throw new Error(`invalid category "${newCategory}". Valid: ${[...VALID_CAT].join(', ')}`)
  }
  if (newElement === cur.element && newSummary === cur.summary && newCategory === cur.category) {
    throw new Error('no change')
  }
  const now = Date.now()
  await db.query(
    `UPDATE core_entries SET element = $1, summary = $2, category = $3, updated_at = $4 WHERE id = $5`,
    [newElement, newSummary, newCategory, now, numId],
  )
  return { ...cur, element: newElement, summary: newSummary, category: newCategory, updated_at: now }
}

export async function deleteCore(dataDir, id) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required')
  const db = _getDb(dataDir)
  const cur = (await db.query(`SELECT * FROM core_entries WHERE id = $1`, [numId])).rows[0]
  if (!cur) throw new Error(`no entry with id=${numId}`)
  await db.query(`DELETE FROM core_entries WHERE id = $1`, [numId])
  return cur
}
