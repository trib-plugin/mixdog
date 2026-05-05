// User-curated core memory store — sqlite-backed via core_entries table (schema v9).
// Per-project entries distinguished by project_id column (NULL = COMMON).
// Independent of the entries table (cycle1/cycle2/prune/rebuild do not touch core_entries).
// Surfaced into the SessionStart Core Memory section by the session-start hook.

import { getDatabase, openDatabase } from './memory.mjs'

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

export function listCore(dataDir, projectId = null) {
  const db = _getDb(dataDir)
  if (projectId === null) {
    return db.prepare(
      `SELECT id, element, summary, category, project_id, created_at, updated_at
       FROM core_entries WHERE project_id IS NULL ORDER BY id ASC`
    ).all()
  }
  return db.prepare(
    `SELECT id, element, summary, category, project_id, created_at, updated_at
     FROM core_entries WHERE project_id = ? ORDER BY id ASC`
  ).all(projectId)
}

export function addCore(dataDir, { element, summary, category }, projectId = null) {
  const el = trimOrNull(element)
  const sm = trimOrNull(summary) ?? el
  if (!el || !sm) throw new Error('add requires element and summary')
  const cat = (trimOrNull(category) ?? 'fact').toLowerCase()
  if (!VALID_CAT.has(cat)) {
    throw new Error(`invalid category "${cat}". Valid: ${[...VALID_CAT].join(', ')}`)
  }
  const db = _getDb(dataDir)
  const now = Date.now()
  const result = db.prepare(
    `INSERT INTO core_entries(element, summary, category, project_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(el, sm, cat, projectId, now, now)
  const id = Number(result.lastInsertRowid)
  return { id, element: el, summary: sm, category: cat, project_id: projectId, created_at: now, updated_at: now }
}

export function editCore(dataDir, id, patch, projectId = null) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required')
  const db = _getDb(dataDir)
  const cur = projectId === null
    ? db.prepare(`SELECT * FROM core_entries WHERE id = ? AND project_id IS NULL`).get(numId)
    : db.prepare(`SELECT * FROM core_entries WHERE id = ? AND project_id = ?`).get(numId, projectId)
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
  db.prepare(
    `UPDATE core_entries SET element = ?, summary = ?, category = ?, updated_at = ? WHERE id = ?`
  ).run(newElement, newSummary, newCategory, now, numId)
  return { ...cur, element: newElement, summary: newSummary, category: newCategory, updated_at: now }
}

export function deleteCore(dataDir, id, projectId = null) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required')
  const db = _getDb(dataDir)
  const cur = projectId === null
    ? db.prepare(`SELECT * FROM core_entries WHERE id = ? AND project_id IS NULL`).get(numId)
    : db.prepare(`SELECT * FROM core_entries WHERE id = ? AND project_id = ?`).get(numId, projectId)
  if (!cur) throw new Error(`no entry with id=${numId}`)
  db.prepare(`DELETE FROM core_entries WHERE id = ?`).run(numId)
  return cur
}
// Per-project entries are read via listCore(dataDir, projectId).
