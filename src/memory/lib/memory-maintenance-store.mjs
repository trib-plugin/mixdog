export function resetEmbeddingIndex(db) {
  db.exec('BEGIN')
  try {
    const res = db.prepare(
      `UPDATE entries SET embedding = NULL, summary_hash = NULL WHERE is_root = 1`,
    ).run()
    db.exec(`DROP TABLE IF EXISTS vec_entries`)
    db.exec('COMMIT')
    return { clearedRoots: Number(res.changes ?? 0) }
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    throw err
  }
}

export function pruneOldEntries(db, maxAgeDays) {
  const days = Number(maxAgeDays)
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`pruneOldEntries: maxAgeDays must be positive, got ${maxAgeDays}`)
  }
  const cutoffMs = Date.now() - days * 86_400_000
  const result = db.prepare(
    `DELETE FROM entries WHERE chunk_root IS NULL AND ts < ?`,
  ).run(cutoffMs)
  return { deleted: Number(result.changes ?? 0), cutoffMs }
}
