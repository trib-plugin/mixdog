// User-curated core memory store. JSON file at <DATA_DIR>/core-memory.json.
// Per-project stores at <DATA_DIR>/project-memory/<safe>.json.
// Independent of the entries SQLite table — never touched by cycle1/cycle2/
// prune/rebuild. Surfaced into the SessionStart Core Memory section by the
// session-start hook reading the same file.

import fs from 'node:fs'
import path from 'node:path'

const FILENAME = 'core-memory.json'
const VALID_CAT = new Set([
  'rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue',
])

function safeFilename(projectId) {
  if (projectId.includes('..')) {
    throw new Error(`invalid projectId "${projectId}": must not contain ".."`)
  }
  if (projectId.includes('\\')) {  // single backslash: '\\' in JS string = one \ char
    throw new Error(`invalid projectId "${projectId}": must not contain backslash`)
  }
  return projectId.replace(/\//g, '__')
}

function storePath(dataDir, projectId = null) {
  if (!dataDir) throw new Error('core-memory: dataDir required')
  if (!projectId) return path.join(dataDir, FILENAME)
  return path.join(dataDir, 'project-memory', safeFilename(projectId) + '.json')
}

function readStore(dataDir, projectId = null) {
  const filePath = storePath(dataDir, projectId)
  if (!fs.existsSync(filePath)) return { version: 1, next_id: 1, entries: [] }
  const raw = fs.readFileSync(filePath, 'utf8')
  if (!raw.trim()) return { version: 1, next_id: 1, entries: [] }
  const parsed = JSON.parse(raw)
  if (!parsed || !Array.isArray(parsed.entries)) {
    return { version: 1, next_id: 1, entries: [] }
  }
  const maxId = parsed.entries.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0)
  const persistedNext = Number(parsed.next_id) || 0
  return {
    version: parsed.version || 1,
    next_id: Math.max(persistedNext, maxId + 1),
    entries: parsed.entries,
  }
}

function writeStore(dataDir, store, projectId = null) {
  const filePath = storePath(dataDir, projectId)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  // Embed projectId so listAllProjectFiles can round-trip without filename decode.
  store.project_id = projectId !== undefined ? projectId : null
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  fs.renameSync(tmp, filePath)
}

function trimOrNull(v) {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

export function listCore(dataDir, projectId = null) {
  return readStore(dataDir, projectId).entries
}

export function addCore(dataDir, { element, summary, category }, projectId = null) {
  const el = trimOrNull(element)
  const sm = trimOrNull(summary) ?? el
  if (!el || !sm) throw new Error('add requires element and summary')
  const cat = (trimOrNull(category) ?? 'fact').toLowerCase()
  if (!VALID_CAT.has(cat)) {
    throw new Error(`invalid category "${cat}". Valid: ${[...VALID_CAT].join(', ')}`)
  }
  const store = readStore(dataDir, projectId)
  const now = Date.now()
  const id = store.next_id
  store.next_id = id + 1
  const entry = { id, element: el, summary: sm, category: cat, created_at: now, updated_at: now }
  store.entries.push(entry)
  writeStore(dataDir, store, projectId)
  return entry
}

export function editCore(dataDir, id, patch, projectId = null) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required')
  const store = readStore(dataDir, projectId)
  const idx = store.entries.findIndex(e => Number(e.id) === numId)
  if (idx < 0) throw new Error(`no entry with id=${numId}`)
  const cur = store.entries[idx]
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
  const updated = { ...cur, element: newElement, summary: newSummary, category: newCategory, updated_at: Date.now() }
  store.entries[idx] = updated
  writeStore(dataDir, store, projectId)
  return updated
}

export function deleteCore(dataDir, id, projectId = null) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required')
  const store = readStore(dataDir, projectId)
  const idx = store.entries.findIndex(e => Number(e.id) === numId)
  if (idx < 0) throw new Error(`no entry with id=${numId}`)
  const removed = store.entries[idx]
  store.entries.splice(idx, 1)
  writeStore(dataDir, store, projectId)
  return removed
}

export function listAllProjectFiles(dataDir) {
  const dir = path.join(dataDir, 'project-memory')
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const filePath = path.join(dir, f)
      let entries = []
      let projectId = null
      try {
        const raw = fs.readFileSync(filePath, 'utf8')
        if (raw.trim()) {
          const parsed = JSON.parse(raw)
          if (parsed && Array.isArray(parsed.entries)) entries = parsed.entries
          // Prefer embedded project_id; fall back to filename decode for old files.
          if (parsed && 'project_id' in parsed) {
            projectId = parsed.project_id
          } else {
            projectId = f.slice(0, -5).replace(/__/g, '/')
          }
        }
      } catch {}
      return { projectId, entries }
    })
}
