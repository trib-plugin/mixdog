import { embedText } from './embedding-provider.mjs'

// Failed root ids re-embed on next cycle1/cycle2 tick.
const EMBED_DIRTY_KEY = 'embedding.dirty_ids'

export function inferChunkProjectId(members) {
  const storedIds = new Set()
  for (const m of members) {
    if (m.project_id != null) storedIds.add(m.project_id)
  }
  if (storedIds.size === 1) return [...storedIds][0]
  return null
}

function _readDirtyIds(db) {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(EMBED_DIRTY_KEY)
    if (!row) return new Set()
    const parsed = JSON.parse(row.value)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.map(n => Number(n)).filter(n => Number.isFinite(n)))
  } catch { return new Set() }
}

function _writeDirtyIds(db, ids) {
  const arr = Array.from(ids).filter(n => Number.isFinite(n))
  try {
    db.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(EMBED_DIRTY_KEY, JSON.stringify(arr))
  } catch (err) {
    process.stderr.write(`[embed-sync] dirty queue persist failed: ${err.message}\n`)
  }
}

// Serialize dirty-queue mutations so concurrent markers don't lose ids.
export function markEmbeddingDirty(db, rootId) {
  const id = Number(rootId)
  if (!Number.isFinite(id)) return
  try {
    db.exec('BEGIN IMMEDIATE')
    const cur = _readDirtyIds(db)
    if (cur.has(id)) { db.exec('COMMIT'); return }
    cur.add(id)
    _writeDirtyIds(db, cur)
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    process.stderr.write(`[embed-sync] markEmbeddingDirty txn failed: ${err.message}\n`)
  }
}

function _removeDirty(db, rootId) {
  try {
    db.exec('BEGIN IMMEDIATE')
    const cur = _readDirtyIds(db)
    if (!cur.delete(Number(rootId))) { db.exec('COMMIT'); return }
    _writeDirtyIds(db, cur)
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    process.stderr.write(`[embed-sync] _removeDirty txn failed: ${err.message}\n`)
  }
}

const _flushInFlight = new WeakMap()

export async function flushEmbeddingDirty(db) {
  // Coalesce concurrent flush calls per db handle.
  const inFlight = _flushInFlight.get(db)
  if (inFlight) return inFlight
  const p = (async () => {
    const ids = Array.from(_readDirtyIds(db))
    if (ids.length === 0) return { attempted: 0, succeeded: 0, failed: [] }
    const failed = []
    let succeeded = 0
    for (const id of ids) {
      const ok = await syncRootEmbedding(db, id)
      if (ok) succeeded += 1
      else failed.push(id)
    }
    _writeDirtyIds(db, new Set(failed))
    return { attempted: ids.length, succeeded, failed }
  })()
  _flushInFlight.set(db, p)
  try {
    return await p
  } finally {
    _flushInFlight.delete(db)
  }
}

export async function syncRootEmbedding(db, rootId) {
  const row = db.prepare(`SELECT element, summary FROM entries WHERE id = ? AND is_root = 1`).get(rootId)
  if (!row) {
    _removeDirty(db, rootId)
    return false
  }
  const text = [row.element, row.summary].filter(Boolean).join(' — ').trim()
  if (!text) {
    _removeDirty(db, rootId)
    return false
  }
  let vector
  try { vector = await embedText(text) }
  catch (err) {
    process.stderr.write(`[embed-sync] embedText failed (id=${rootId}): ${err.message}\n`)
    markEmbeddingDirty(db, rootId)
    return false
  }
  if (!Array.isArray(vector) || vector.length === 0) {
    markEmbeddingDirty(db, rootId)
    return false
  }
  const blob = Buffer.alloc(vector.length * 4)
  for (let i = 0; i < vector.length; i++) blob.writeFloatLE(vector[i], i * 4)
  // Wrap dim-check + entries + vec_entries write in one transaction so a
  // concurrent dim-config switch can't corrupt vec_entries on mismatch.
  try {
    db.exec('BEGIN')
    const dimsRow = db.prepare(`SELECT value FROM meta WHERE key = 'embedding.current_dims'`).get()
    const expected = Number(dimsRow?.value ?? 0)
    if (Number.isFinite(expected) && expected > 0 && vector.length !== expected) {
      db.exec('ROLLBACK')
      process.stderr.write(
        `[embed-sync] dim mismatch (id=${rootId} got=${vector.length} expected=${expected})\n`,
      )
      markEmbeddingDirty(db, rootId)
      return false
    }
    db.prepare(`UPDATE entries SET embedding = ? WHERE id = ? AND is_root = 1`).run(blob, rootId)
    const upd = db.prepare(`UPDATE vec_entries SET embedding = ? WHERE rowid = ?`).run(blob, BigInt(rootId))
    if (Number(upd.changes ?? 0) === 0) {
      db.prepare(`INSERT INTO vec_entries(rowid, embedding) VALUES (?, ?)`).run(BigInt(rootId), blob)
    }
    db.exec('COMMIT')
    _removeDirty(db, rootId)
    return true
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    process.stderr.write(`[embed-sync] db write failed (id=${rootId}): ${err.message}\n`)
    markEmbeddingDirty(db, rootId)
    return false
  }
}

export function deleteRootEmbedding(db, rootId) {
  // Wrap entries + vec_entries delete in one transaction so a crash between
  // the two writes can't leave a vec0 row pointing at a now-detached entry.
  try {
    db.exec('BEGIN')
    db.prepare(`UPDATE entries SET embedding = NULL WHERE id = ? AND is_root = 1`).run(rootId)
    db.prepare(`DELETE FROM vec_entries WHERE rowid = ?`).run(BigInt(rootId))
    db.exec('COMMIT')
    return true
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    process.stderr.write(`[embed-sync] delete failed (id=${rootId}): ${err.message}\n`)
    return false
  }
}
