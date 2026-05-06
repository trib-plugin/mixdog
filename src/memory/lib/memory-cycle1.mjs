import { cleanMemoryText } from './memory.mjs'
import { resolveMaintenancePreset } from '../../shared/llm/index.mjs'
import { callBridgeLlm } from './agent-ipc.mjs'
import {
  markEmbeddingDirty, flushEmbeddingDirty, inferChunkProjectId,
} from './memory-embed.mjs'

const VALID_CATEGORIES = new Set([
  'rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue',
])

// Pre-filter: reject obvious noise chunks before they enter the pending queue.
// Kept minimal on purpose — the LLM does the conceptual judgment via the
// promote prompt. This pre-filter only catches structural junk (empty,
// pure number, JSON dump, bare TODO marker) that wastes LLM cycles.
function _isObviousNoise(text) {
  if (!text || typeof text !== 'string') return true
  const t = text.trim()
  if (t.length < 20) return true
  // Pure numeric/measurement: "12,798 tokens", "3,117 pending" — short strings only; prose after number should pass.
  if (/^\d[\d,.\s\w]{0,20}$/.test(t)) return true
  // Tool output snapshots: starts with "[" (JSON array dumps, bracket-prefixed logs)
  if (t.startsWith('[') && /[{"\[\]:]/.test(t.slice(0, 80))) return true
  // In-progress markers — only if entry IS a TODO/WIP marker (anchored), not prose about them.
  if (/^(TODO|WIP|FIXME)[:\s]/i.test(t)) return true
  if (/다음\s*작업|next\s+step/i.test(t)) return true
  return false
}

function selectRootId(members) {
  let rootId = null
  let rootTs = null
  for (const m of members) {
    const ts = Number(m.ts)
    const id = Number(m.id)
    if (!Number.isFinite(ts) || !Number.isFinite(id)) continue
    if (rootId === null || ts < rootTs || (ts === rootTs && id < rootId)) {
      rootId = id
      rootTs = ts
    }
  }
  return rootId
}

function buildEntriesText(entries) {
  // @N is a 1-based prompt-local index; cycle1-agent answers with @N indexes.
  return entries.map((e, i) => {
    const content = cleanMemoryText(String(e.content ?? '')).slice(0, 400)
    const sess = e.session_id ? String(e.session_id).slice(0, 8) : 'null----'
    return `@${i + 1} ts:${e.ts} role:${e.role} [sess:${sess}] content:${content}`
  }).join('\n')
}

function parseCycle1LineFormat(raw) {
  if (raw == null) return null
  const text = String(raw).trim()
  if (!text) return null
  const lines = text.split('\n')
  const chunks = []
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('//') || line.startsWith('#')) continue
    if (line.startsWith('```')) continue
    const parts = line.split('|')
    if (parts.length < 4) continue
    const idxField = parts[0].trim()
    const idxList = idxField.split(',')
      .map(s => Number(String(s).replace(/^@/, '').trim()))
      .filter(n => Number.isFinite(n) && n > 0)
    if (idxList.length === 0) continue
    chunks.push({
      _idxList: idxList,
      element: parts[1].trim(),
      category: parts[2].trim(),
      summary: parts.slice(3).join('|').trim(),
    })
  }
  return chunks.length > 0 ? { chunks } : null
}

// Partition by session_id; MIN_BATCH also gates per-session windows, SESSION_CAP bounds per-tick fan-out.
const CYCLE1_MIN_BATCH = 3
const CYCLE1_SESSION_CAP = 10

// Per-db SKIP gate — concurrent calls drop, scheduler retries.
const _runCycle1InFlight = new WeakMap()

// Tiny inline semaphore — bounds cycle1 window fan-out.
function createSemaphore(limit) {
  const cap = Math.max(1, Number(limit) || 1)
  let active = 0
  const queue = []
  const release = () => {
    active -= 1
    const next = queue.shift()
    if (next) next()
  }
  return async (fn) => {
    if (active >= cap) await new Promise(res => queue.push(res))
    active += 1
    try { return await fn() }
    finally { release() }
  }
}

async function countPendingRows(db) {
  try {
    const result = await db.query(
      `SELECT COUNT(*) AS c FROM entries WHERE chunk_root IS NULL AND session_id IS NOT NULL`,
    )
    return Number(result.rows[0]?.c ?? 0)
  } catch {
    return null
  }
}

export async function runCycle1(db, config = {}, options = {}) {
  if (_runCycle1InFlight.has(db)) {
    process.stderr.write('[cycle1] skipped: already in flight for this db\n')
    return {
      processed: 0, chunks: 0, skipped: 0, sessions: 0,
      skippedInFlight: true,
      pendingRows: await countPendingRows(db),
    }
  }
  const p = (async () => _runCycle1Impl(db, config, options))()
  _runCycle1InFlight.set(db, p)
  try {
    return await p
  } finally {
    _runCycle1InFlight.delete(db)
  }
}

async function _runCycle1Impl(db, config = {}, options = {}) {
  const pendingRowsAtStart = await countPendingRows(db)
  const batchSize = Math.max(1, Number(config.batch_size ?? 100))
  // Fallback chain handles flat config + nested cycle1 wrap shapes.
  const minBatch = Math.max(1, Number(config?.min_batch ?? config?.cycle1?.min_batch ?? CYCLE1_MIN_BATCH))
  const sessionCap = Math.max(1, Number(config?.session_cap ?? config?.cycle1?.session_cap ?? CYCLE1_SESSION_CAP))
  const preset = options.preset || resolveMaintenancePreset('cycle1')
  // Inner LLM timeout aligns to caller deadline -1s so the channel side can ack gracefully.
  const callerDeadlineMs = Number(options.callerDeadlineMs ?? 0)
  const baseTimeout = Number(config?.cycle1?.timeout ?? 60000)
  const timeout = callerDeadlineMs > 0
    ? Math.min(baseTimeout, Math.max(5000, callerDeadlineMs - 1000))
    : baseTimeout
  const concurrency = Math.max(1, Number(config?.cycle1?.concurrency ?? 5))

  // Time-ordered fetch split into per-session sub-windows; [sess:] markers reinforce the SQL grouping.
  const fetchLimit = sessionCap * batchSize
  const fetchResult = await db.query(
    `SELECT id, ts, role, content, session_id, source_ref, project_id
     FROM entries
     WHERE chunk_root IS NULL AND session_id IS NOT NULL
     ORDER BY ts DESC, id DESC
     LIMIT $1`,
    [fetchLimit],
  )
  const rowsDesc = fetchResult.rows

  if (rowsDesc.length < minBatch) {
    void flushEmbeddingDirty(db).catch(err => {
      process.stderr.write(`[cycle1] embedding flush (quick-exit) failed: ${err.message}\n`)
    })
    return {
      processed: 0, chunks: 0, skipped: 0, sessions: 0,
      skippedInFlight: false,
      pendingRows: pendingRowsAtStart,
      failed_row_ids: [], omitted_row_ids: [], invalid_chunks: [],
      embedding_dirty: { attempted: 0, succeeded: 0, failed: 0, deferred: true },
    }
  }

  // Group fetched rows by session_id first, so every prompt window is single-session.
  const sessionMap = new Map()
  for (const row of rowsDesc.slice().reverse()) {
    const sid = row.session_id
    if (!sessionMap.has(sid)) sessionMap.set(sid, [])
    sessionMap.get(sid).push(row)
  }

  const windows = []
  for (const [sid, sessionRows] of sessionMap) {
    if (sessionRows.length < minBatch) {
      process.stderr.write(
        `[cycle1] session deferred: session_id=${sid} rows=${sessionRows.length} (below threshold)\n`,
      )
      continue
    }
    const windowCount = Math.max(1, Math.ceil(sessionRows.length / batchSize))
    const baseSize = Math.floor(sessionRows.length / windowCount)
    const remainder = sessionRows.length % windowCount
    let _offset = 0
    for (let i = 0; i < windowCount; i++) {
      const size = baseSize + (i < remainder ? 1 : 0)
      windows.push(sessionRows.slice(_offset, _offset + size))
      _offset += size
    }
  }

  async function processWindow(rows, windowIdx) {
    if (rows.length === 0) {
      return { committedChunks: 0, committedMembers: 0, skippedChunks: 0, rowsConsidered: 0 }
    }

    const userMessage = [
      `Chunk these entries. Emit one chunk per line, NO JSON, NO tool calls, NO prose.`,
      `Format: idx_csv|element|category|summary  (example: 1,2,3|cycle1 v20 applied|decision|Switched chunk emission to declarative tone.)`,
      `First character of your response must be a digit. Use the @N indexes from below (bare numbers, no @ in output). Never merge across [sess:] markers.`,
      '',
      buildEntriesText(rows),
    ].join('\n')

    let raw
    const _tLlm = Date.now()
    try {
      raw = await callBridgeLlm({
        role: 'cycle1-agent',
        taskType: 'maintenance',
        mode: 'cycle1',
        preset,
        timeout,
        // Pin cwd to null so every memory cycle call hits the same bridge cache shard.
        cwd: null,
      }, userMessage)
    } catch (err) {
      process.stderr.write(`[cycle1] LLM error (window=${windowIdx}): ${err.message}\n`)
      return { committedChunks: 0, committedMembers: 0, skippedChunks: rows.length, rowsConsidered: rows.length }
    }
    process.stderr.write(`[cycle1-time] window=${windowIdx} llmMs=${Date.now() - _tLlm}\n`)

    const parsed = parseCycle1LineFormat(raw)
    const chunkList = Array.isArray(parsed?.chunks) ? parsed.chunks : null
    if (!chunkList) {
      process.stderr.write(`[cycle1] unparseable response (window=${windowIdx}) (${String(raw).slice(0, 200)})\n`)
      return { committedChunks: 0, committedMembers: 0, skippedChunks: rows.length, rowsConsidered: rows.length }
    }

    const entryByIdx = new Map(rows.map((r, i) => [i + 1, r]))
    const entryById = new Map(rows.map(r => [Number(r.id), r]))
    const usedIds = new Set()
    const committedRowIds = new Set()
    let committedChunks = 0
    let committedMembers = 0
    let skippedChunks = 0
    const invalidChunks = []
    const failedRowIds = []

    for (const chunk of chunkList) {
      const rawIds = chunk._idxList.map(n => entryByIdx.get(Number(n))).filter(r => r != null).map(r => Number(r.id))
      const dupeWithin = rawIds.length !== new Set(rawIds).size
      const externalIds = rawIds.filter(n => !Number.isFinite(n) || !entryById.has(n))
      const reusedIds = rawIds.filter(n => usedIds.has(n))
      const memberIds = rawIds.filter(n => Number.isFinite(n) && entryById.has(n) && !usedIds.has(n))
      const element = String(chunk?.element ?? '').trim()
      const category = String(chunk?.category ?? '').trim().toLowerCase()
      const summary = String(chunk?.summary ?? '').trim()

      if (dupeWithin || externalIds.length > 0 || reusedIds.length > 0) {
        const reason = dupeWithin ? 'duplicate_member_ids'
          : externalIds.length > 0 ? 'external_member_ids'
          : 'reused_member_ids'
        invalidChunks.push({ reason, member_ids: rawIds })
        skippedChunks += 1
        process.stderr.write(
          `[cycle1] chunk rejected: ${reason} member_ids=${JSON.stringify(rawIds)}\n`,
        )
        continue
      }

      if (memberIds.length === 0 || !element || !summary || !VALID_CATEGORIES.has(category)) {
        invalidChunks.push({ reason: 'incomplete_fields', member_ids: rawIds })
        skippedChunks += 1
        continue
      }

      if (_isObviousNoise(summary)) {
        process.stderr.write(`[cycle1] noise filtered: ${summary.slice(0, 60)}\n`)
        invalidChunks.push({ reason: 'noise_filtered', member_ids: rawIds })
        skippedChunks += 1
        continue
      }

      const members = memberIds.map(id => entryById.get(id))
      const rootId = selectRootId(members)
      if (rootId === null) {
        invalidChunks.push({ reason: 'no_root_id', member_ids: memberIds })
        skippedChunks += 1
        continue
      }

      const projectId = inferChunkProjectId(members)

      try {
        await db.transaction(async (tx) => {
          await tx.query(
            `UPDATE entries
             SET chunk_root = $1, is_root = 1, element = $2, category = $3, summary = $4,
                 status = 'pending', project_id = $5,
                 last_seen_at = $7
             WHERE id = $6`,
            [rootId, element, category, summary, projectId, rootId, Date.now()],
          )
          const nonRootIds = memberIds.filter(mid => mid !== rootId)
          if (nonRootIds.length > 0) {
            await tx.query(
              `UPDATE entries SET chunk_root = $1, project_id = $2 WHERE id = ANY($3::bigint[])`,
              [rootId, projectId, nonRootIds],
            )
          }
        })
        committedChunks += 1
        committedMembers += memberIds.length
        for (const mid of memberIds) {
          usedIds.add(mid)
          committedRowIds.add(mid)
        }
        // markEmbeddingDirty is async (db transaction); await to ensure commit before flush
        await markEmbeddingDirty(db, rootId)
      } catch (err) {
        process.stderr.write(`[cycle1] chunk commit failed (root=${rootId}): ${err.message}\n`)
        skippedChunks += 1
        for (const mid of memberIds) failedRowIds.push(mid)
      }
    }

    process.stderr.write(
      `[cycle1] window=${windowIdx} entries=${rows.length} chunks=${committedChunks} members=${committedMembers} skipped=${skippedChunks}\n`,
    )

    const omittedRowIds = rows
      .map(r => Number(r.id))
      .filter(id => !committedRowIds.has(id) && !failedRowIds.includes(id))

    return {
      committedChunks, committedMembers, skippedChunks,
      rowsConsidered: rows.length,
      invalidChunks, failedRowIds, omittedRowIds,
    }
  }

  // Bounded concurrency fan-out; at most `concurrency` windows inflight at once.
  const sem = createSemaphore(concurrency)
  const results = await Promise.all(
    windows.map((rows, idx) => sem(() => processWindow(rows, idx))),
  )

  let totalChunks = 0
  let totalMembers = 0
  let totalSkipped = 0
  let totalRowsConsidered = 0
  const allInvalidChunks = []
  const allFailedRowIds = []
  const allOmittedRowIds = []
  for (const r of results) {
    totalChunks += r.committedChunks
    totalMembers += r.committedMembers
    totalSkipped += r.skippedChunks
    totalRowsConsidered += r.rowsConsidered
    if (Array.isArray(r.invalidChunks)) allInvalidChunks.push(...r.invalidChunks)
    if (Array.isArray(r.failedRowIds)) allFailedRowIds.push(...r.failedRowIds)
    if (Array.isArray(r.omittedRowIds)) allOmittedRowIds.push(...r.omittedRowIds)
  }

  process.stderr.write(
    `[cycle1] windows=${windows.length} rows=${totalRowsConsidered} chunks=${totalChunks} members=${totalMembers} skipped=${totalSkipped}\n`,
  )

  // Fire-and-forget embedding flush — re-entrancy guarded, failures re-queued.
  void flushEmbeddingDirty(db).then(d => {
    if (d.attempted > 0) {
      process.stderr.write(
        `[cycle1] embedding flush (async) attempted=${d.attempted} ok=${d.succeeded} failed=${d.failed.length}\n`,
      )
    }
  }).catch(err => {
    process.stderr.write(`[cycle1] embedding flush (async) failed: ${err.message}\n`)
  })

  return {
    processed: totalMembers,
    chunks: totalChunks,
    skipped: totalSkipped,
    sessions: windows.length,
    skippedInFlight: false,
    pendingRows: pendingRowsAtStart,
    failed_row_ids: allFailedRowIds,
    omitted_row_ids: allOmittedRowIds,
    invalid_chunks: allInvalidChunks,
    embedding_dirty: { attempted: 0, succeeded: 0, failed: 0, failed_ids: [], deferred: true },
  }
}
