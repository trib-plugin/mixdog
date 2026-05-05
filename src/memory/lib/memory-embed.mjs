import { embedText } from './embedding-provider.mjs'
import { embeddingToSql, getMetaValue, setMetaValue } from './memory.mjs'

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

async function _readDirtyIds(conn) {
  try {
    const val = await getMetaValue(conn, EMBED_DIRTY_KEY, null)
    if (!val) return new Set()
    const parsed = JSON.parse(val)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.map(n => Number(n)).filter(n => Number.isFinite(n)))
  } catch { return new Set() }
}

async function _writeDirtyIds(conn, ids) {
  const arr = Array.from(ids).filter(n => Number.isFinite(n))
  try {
    await setMetaValue(conn, EMBED_DIRTY_KEY, JSON.stringify(arr))
  } catch (err) {
    process.stderr.write(`[embed-sync] dirty queue persist failed: ${err.message}\n`)
  }
}

// Serialize dirty-queue mutations so concurrent markers don't lose ids.
export async function markEmbeddingDirty(db, rootId) {
  const id = Number(rootId)
  if (!Number.isFinite(id)) return
  try {
    await db.transaction(async (tx) => {
      const cur = await _readDirtyIds(tx)
      if (cur.has(id)) return
      cur.add(id)
      await _writeDirtyIds(tx, cur)
    })
  } catch (err) {
    process.stderr.write(`[embed-sync] markEmbeddingDirty txn failed: ${err.message}\n`)
  }
}

async function _removeDirty(db, rootId) {
  try {
    await db.transaction(async (tx) => {
      const cur = await _readDirtyIds(tx)
      if (!cur.delete(Number(rootId))) return
      await _writeDirtyIds(tx, cur)
    })
  } catch (err) {
    process.stderr.write(`[embed-sync] _removeDirty txn failed: ${err.message}\n`)
  }
}

const _flushInFlight = new WeakMap()

export async function flushEmbeddingDirty(db) {
  // Coalesce concurrent flush calls per db handle.
  const inFlight = _flushInFlight.get(db)
  if (inFlight) return inFlight
  const p = (async () => {
    const ids = Array.from(await _readDirtyIds(db))
    if (ids.length === 0) return { attempted: 0, succeeded: 0, failed: [] }
    const failed = []
    let succeeded = 0
    for (const id of ids) {
      const ok = await syncRootEmbedding(db, id)
      if (ok) succeeded += 1
      else failed.push(id)
    }
    await _writeDirtyIds(db, new Set(failed))
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
  const row = (await db.query(`SELECT element, summary FROM entries WHERE id = $1 AND is_root = 1`, [rootId])).rows[0]
  if (!row) {
    await _removeDirty(db, rootId)
    return false
  }
  const text = [row.element, row.summary].filter(Boolean).join(' — ').trim()
  if (!text) {
    await _removeDirty(db, rootId)
    return false
  }
  let vector
  try { vector = await embedText(text) }
  catch (err) {
    process.stderr.write(`[embed-sync] embedText failed (id=${rootId}): ${err.message}\n`)
    await markEmbeddingDirty(db, rootId)
    return false
  }
  if (!Array.isArray(vector) || vector.length === 0) {
    await markEmbeddingDirty(db, rootId)
    return false
  }
  // Wrap dim-check + entries write in one transaction.
  try {
    await db.transaction(async (tx) => {
      const dimsRow = (await tx.query(`SELECT value FROM meta WHERE key = 'embedding.current_dims'`, [])).rows[0]
      const expected = Number(dimsRow?.value ?? 0)
      if (Number.isFinite(expected) && expected > 0 && vector.length !== expected) {
        throw new Error(`dim mismatch (id=${rootId} got=${vector.length} expected=${expected})`)
      }
      await tx.query(
        `UPDATE entries SET embedding = $1::vector WHERE id = $2 AND is_root = 1`,
        [embeddingToSql(vector), rootId],
      )
    })
    await _removeDirty(db, rootId)
    return true
  } catch (err) {
    process.stderr.write(`[embed-sync] db write failed (id=${rootId}): ${err.message}\n`)
    await markEmbeddingDirty(db, rootId)
    return false
  }
}

export async function deleteRootEmbedding(db, rootId) {
  try {
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE entries SET embedding = NULL WHERE id = $1 AND is_root = 1`, [rootId])
    })
    return true
  } catch (err) {
    process.stderr.write(`[embed-sync] delete failed (id=${rootId}): ${err.message}\n`)
    return false
  }
}
