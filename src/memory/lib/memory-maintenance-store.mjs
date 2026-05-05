export async function resetEmbeddingIndex(db) {
  try {
    const res = await db.query(
      `UPDATE entries SET embedding = NULL, summary_hash = NULL WHERE is_root = 1`,
      [],
    )
    return { clearedRoots: Number(res.affectedRows ?? 0) }
  } catch (err) {
    throw err
  }
}

export async function pruneOldEntries(db, maxAgeDays) {
  const days = Number(maxAgeDays)
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`pruneOldEntries: maxAgeDays must be positive, got ${maxAgeDays}`)
  }
  const cutoffMs = Date.now() - days * 86_400_000
  const result = await db.query(
    `DELETE FROM entries WHERE chunk_root IS NULL AND ts < $1`,
    [cutoffMs],
  )
  return { deleted: Number(result.affectedRows ?? 0), cutoffMs }
}
