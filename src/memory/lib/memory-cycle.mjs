import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { cleanMemoryText } from './memory.mjs'
import { resolveMaintenancePreset } from '../../shared/llm/index.mjs'
import { callBridgeLlm } from './agent-ipc.mjs'
import { computeEntryScore } from './memory-score.mjs'
import { embedText } from './embedding-provider.mjs'
import { DATA_DIR } from '../../shared/config.mjs'

// Embedding dirty queue (#3/#4): cycle1 commits no longer await syncRootEmbedding
// inline because a single LLM-side embedding hiccup must not block the rest of
// the window's Promise.all. Failed root ids land in this meta-backed queue and
// the next cycle1/cycle2 tick drains it. The queue is bounded by however many
// roots actually exist, so it cannot grow unbounded; duplicates are coalesced.
const EMBED_DIRTY_KEY = 'embedding.dirty_ids'

/**
 * Resolve a project_id for a chunk from stored DB state only.
 *
 * Collects all NOT NULL project_id values across member rows into a unique set.
 * If exactly one distinct id is found, return it. If two or more distinct ids
 * are found, return null (mixed-project chunk → COMMON pool). If no stored ids
 * exist, return null.
 *
 * Removed: path-scan fallback that extracted absolute paths from content/
 * source_ref and ran them through resolveProjectId + whitelistRepoMatch.
 * That was a multi-step heuristic with no objective signal. project_id on
 * member rows is the only reliable source; if it is absent the chunk belongs
 * to COMMON.
 */
export function inferChunkProjectId(members) {
  const storedIds = new Set()
  for (const m of members) {
    if (m.project_id != null) storedIds.add(m.project_id)
  }
  if (storedIds.size === 1) return [...storedIds][0]
  // storedIds.size === 0 (all NULL) or >= 2 (mixed) → COMMON
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

// #41: Concurrent markEmbeddingDirty/_removeDirty calls would race the
// read-modify-write on the meta JSON blob (call A reads {1,2}, call B
// reads {1,2}, A writes {1,2,3}, B writes {1,2,4} — id 3 lost). Wrap
// every dirty-queue mutation in a single SQLite transaction so the
// meta row's read+update is serialized by the database lock.
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
  // Re-entrancy guard: cycle1/cycle2 now fire-and-forget this flush, so two
  // overlapping calls on the same db handle would otherwise both iterate the
  // dirty queue and double-embed every id. Coalesce to one in-flight flush
  // per db; concurrent callers await the same promise.
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
    // Row no longer a root (deleted/merged) — drop from dirty queue silently.
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
  // #9: wrap dim-check + entries + vec_entries write in one transaction so
  // a concurrent dim-config switch cannot land between the check and the
  // vec0 write (which would silently corrupt vec_entries on mismatch),
  // and a partial failure cannot leave the two tables out of sync.
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

const VALID_CATEGORIES = new Set([
  'rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue',
])

const CYCLE2_ACTIVE_CAP = 300

function resourceDir() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT
  throw new Error('CLAUDE_PLUGIN_ROOT env var required for prompt loading')
}

function extractJsonObject(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(candidate.slice(start, end + 1)) } catch { return null }
}

// cycle2 routes through the dedicated `cycle2-agent` Pool C hidden role so
// the snippet + bridgeRules prefix match every other Pool C call and share
// the same cache shard. The per-phase `mode` label is preserved for
// bridge-trace bookkeeping; options.preset/timeout still win when set.
async function invokeLlm(prompt, options, mode, preset, timeout) {
  return await callBridgeLlm({
    role: 'cycle2-agent',
    taskType: 'maintenance',
    mode,
    preset,
    timeout,
    // See cycle1 dispatch below — pin cwd=null so every memory cycle
    // call hits the same bridge cache shard regardless of MCP launch dir.
    cwd: null,
  }, prompt)
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
  // @N is a 1-based prompt-local index; cycle1-agent answers with @N indexes
  // and we map them back to row ids via the entries array order. Keeps the
  // content/ts/role/sess fields untouched so the LLM still sees full context
  // for chunking decisions.
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

// D10: cycle1 must never group entries across session/channel boundaries.
// A Discord channel and a Claude Code transcript are distinct sessions;
// mixing them in one LLM prompt causes the chunker to fuse unrelated content.
// Partition pending entries by `session_id` and dispatch one LLM call per
// session. The two caps below bound single-cycle work so the per-session
// fan-out does not blow up latency/cost on a heavy backlog.
//
// MIN_BATCH: threshold below which chunking is premature — a session with
//   <3 pending entries is usually an acknowledgement or a single message;
//   leave it for the next cycle when more context has accumulated.
// SESSION_CAP: how many sessions to process in a single runCycle1() pass.
//   Protects scheduler latency; remaining sessions roll to the next tick.
const CYCLE1_MIN_BATCH = 3
const CYCLE1_SESSION_CAP = 10

// Per-db cycle1 in-flight guard. Different db instances run in parallel;
// concurrent calls against the same db SKIP (not coalesce) — each pass is
// idempotent and the scheduler re-fires on the next tick.
const _runCycle1InFlight = new WeakMap()
// Mirror gate for cycle2 (#1). Same SKIP-not-coalesce policy.
const _runCycle2InFlight = new WeakMap()

// #2: tiny inline semaphore (no external dep). Used to bound the cycle1
// window fan-out so a heavy backlog cannot fire N concurrent LLM calls.
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

function countPendingRows(db) {
  try {
    const r = db.prepare(
      `SELECT COUNT(*) AS c FROM entries WHERE chunk_root IS NULL AND session_id IS NOT NULL`,
    ).get()
    return Number(r?.c ?? 0)
  } catch {
    return null
  }
}

export async function runCycle1(db, config = {}, options = {}) {
  if (_runCycle1InFlight.has(db)) {
    process.stderr.write('[cycle1] skipped: already in flight for this db\n')
    return {
      processed: 0,
      chunks: 0,
      skipped: 0,
      sessions: 0,
      skippedInFlight: true,
      pendingRows: countPendingRows(db),
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
  const pendingRowsAtStart = countPendingRows(db)
  const batchSize = Math.max(1, Number(config.batch_size ?? 50))
  // Fallback chain handles BOTH call shapes:
  //   - periodic tick passes flat config: { interval, min_batch: 20 }
  //   - callMemoryAction wraps with cycle1: { cycle1: { min_batch } } for override
  // Without the flat lookup the periodic tick silently fell back to default 3
  // (verified: 21:06 tick fired 10 dispatches at min_batch=3 instead of 20).
  const minBatch = Math.max(1, Number(config?.min_batch ?? config?.cycle1?.min_batch ?? CYCLE1_MIN_BATCH))
  const sessionCap = Math.max(1, Number(config?.session_cap ?? config?.cycle1?.session_cap ?? CYCLE1_SESSION_CAP))
  const preset = options.preset || resolveMaintenancePreset('cycle1')
  // Inner LLM timeout. Default 60s (down from 600s); the previous 6× margin
  // outlived the channel-side caller deadline and let a stalled callBridgeLlm
  // pin the inner _runCycle1InFlight WeakMap entry long after the route had
  // already returned a graceful skippedInFlight envelope, accreting zombies
  // and forcing every later POST through the same lock. caller-deadline
  // (when supplied) shrinks this further so the inner reject lines up just
  // before the caller's 50s graceful-return so background work cannot
  // outlive the channel ack by more than ~1s.
  const callerDeadlineMs = Number(options.callerDeadlineMs ?? 0)
  const baseTimeout = Number(config?.cycle1?.timeout ?? 60000)
  // Inner must finish ~1s before the caller so the channel side has time
  // to ack with a graceful {timedOutWaiting:true} envelope. The previous
  // 15000 floor turned the formula into a no-op for the default 15s
  // caller (max(15000, 14000) = 15000), forcing inner == caller and
  // re-introducing the deadline race. 5000 floor keeps the inner above
  // a useful working minimum without overriding the -1000 alignment.
  const timeout = callerDeadlineMs > 0
    ? Math.min(baseTimeout, Math.max(5000, callerDeadlineMs - 1000))
    : baseTimeout
  // #2: bounded fan-out across windows. Default 5 to match the on-demand
  // hook fan-out (5×20 rows); periodic path runs 2×50 so concurrency cap
  // never bites. caller-deadline-aware timeout is already propagated to
  // callBridgeLlm above.
  const concurrency = Math.max(1, Number(config?.cycle1?.concurrency ?? 5))

  // Time-ordered fetch — no GROUP BY session_id. Pull up to
  // sessionCap × batchSize rows ordered DESC (most recent first, so we
  // keep the freshest backlog when the cap clips), then reverse to ASC
  // for the prompt so the LLM sees chronological order.
  //
  // Session boundaries are enforced two ways:
  //   1. Each row in the prompt is tagged with [sess:XXXXXXXX] so the
  //      cycle1-agent rule can refuse to merge across them.
  //   2. Commit-time guard below double-checks every chunk's member_ids
  //      resolve to one session_id; mixed chunks are skipped + logged.
  //
  // Parallelism choice: split the time-ordered fetch into sub-windows of
  // batchSize rows each and Promise.all over them. This preserves the
  // concurrency characteristic the per-session fan-out had, while still
  // letting the LLM partition within each window. Sub-windows are NOT
  // session-aligned, but the [sess:] markers + commit guard make that safe.
  const fetchLimit = sessionCap * batchSize
  const rowsDesc = db.prepare(`
    SELECT id, ts, role, content, session_id, source_ref, project_id
    FROM entries
    WHERE chunk_root IS NULL AND session_id IS NOT NULL
    ORDER BY ts DESC, id DESC
    LIMIT ?
  `).all(fetchLimit)

  if (rowsDesc.length < minBatch) {
    // Drain the dirty embedding queue out-of-band so the recap path returns
    // as soon as chunking is decided. flushEmbeddingDirty is re-entrancy
    // guarded; failures are re-queued for the next tick.
    void flushEmbeddingDirty(db).catch(err => {
      process.stderr.write(`[cycle1] embedding flush (quick-exit) failed: ${err.message}\n`)
    })
    return {
      processed: 0,
      chunks: 0,
      skipped: 0,
      sessions: 0,
      skippedInFlight: false,
      pendingRows: pendingRowsAtStart,
      failed_row_ids: [],
      omitted_row_ids: [],
      invalid_chunks: [],
      embedding_dirty: { attempted: 0, succeeded: 0, failed: 0, deferred: true },
    }
  }

  const allRows = rowsDesc.slice().reverse() // chronological ASC

  // Split into sub-windows for Promise.all parallelism. batchSize is the
  // upper cap that decides how many windows we need; the actual rows are
  // distributed evenly across those windows so wallclock = max(window_t)
  // does not get pinned by a tail window of 1-2 rows. e.g. 26 rows with
  // batchSize=25 → 2 windows of 13 each, not [25, 1].
  const windowCount = Math.max(1, Math.ceil(allRows.length / batchSize))
  const baseSize = Math.floor(allRows.length / windowCount)
  const remainder = allRows.length % windowCount
  const windows = []
  let _offset = 0
  for (let i = 0; i < windowCount; i++) {
    const size = baseSize + (i < remainder ? 1 : 0)
    windows.push(allRows.slice(_offset, _offset + size))
    _offset += size
  }

  const updateRoot = db.prepare(`
    UPDATE entries
    SET chunk_root = ?, is_root = 1, element = ?, category = ?, summary = ?,
        status = NULL, project_id = ?,
        last_seen_at = CAST(strftime('%s','now') AS INTEGER) * 1000
    WHERE id = ?
  `)
  const updateMember = db.prepare(`
    UPDATE entries SET chunk_root = ?, project_id = ? WHERE id = ? AND id != ?
  `)

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
        // Pin cwd to null so the bridge session does not inherit the
        // memory subsystem's process.cwd() (which varies with how the
        // MCP server was launched). Combined with the frozen skill
        // meta-tools policy (see collect.mjs buildSkillToolDefs), this
        // keeps the provider cache shard identical across every memory
        // cycle invocation.
        cwd: null,
      }, userMessage)
    } catch (err) {
      process.stderr.write(`[cycle1] LLM error (window=${windowIdx}): ${err.message}\n`)
      return { committedChunks: 0, committedMembers: 0, skippedChunks: rows.length, rowsConsidered: rows.length }
    }
    process.stderr.write(`[cycle1-time] window=${windowIdx} llmMs=${Date.now() - _tLlm}\n`)

    const parsed = parseCycle1LineFormat(raw) || extractJsonObject(raw)
    const chunkList = Array.isArray(parsed?.chunks) ? parsed.chunks : null
    if (!chunkList) {
      process.stderr.write(`[cycle1] unparseable response (window=${windowIdx}) (${String(raw).slice(0, 200)})\n`)
      return { committedChunks: 0, committedMembers: 0, skippedChunks: rows.length, rowsConsidered: rows.length }
    }

    // Build idx (1-based) → row map matching buildEntriesText order so we can
    // resolve cycle1-agent's @N answers back to entry ids.
    const entryByIdx = new Map(rows.map((r, i) => [i + 1, r]))
    const entryById = new Map(rows.map(r => [Number(r.id), r]))
    // #5: track ids that already landed in a committed chunk so the LLM
    // cannot reuse one row across multiple chunks within the same window.
    const usedIds = new Set()
    const committedRowIds = new Set()
    let committedChunks = 0
    let committedMembers = 0
    let skippedChunks = 0
    const invalidChunks = []
    const failedRowIds = []

    for (const chunk of chunkList) {
      // Line-format path: chunk._idxList holds 1-based @N indexes; map them
      // back to row ids. Legacy JSON path: chunk.member_ids already contains
      // raw entry ids — keep that branch for fallback.
      let rawIds
      if (Array.isArray(chunk?._idxList)) {
        rawIds = chunk._idxList
          .map(n => entryByIdx.get(Number(n)))
          .filter(r => r != null)
          .map(r => Number(r.id))
      } else {
        rawIds = Array.isArray(chunk?.member_ids) ? chunk.member_ids.map(n => Number(n)) : []
      }
      // #5: validate the multiset, not just membership. Reject duplicates
      // (within chunk and across chunks) and ids outside the window.
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

      // Defensive guard: every member must share one session_id.
      // The cycle1-agent rule already forbids cross-session chunks via
      // the [sess:] markers; this catches LLM rule violations before they
      // corrupt chunk_root linkage. Should never trigger if the prompt
      // is doing its job.
      const sessionIdsInChunk = new Set(
        memberIds.map(id => String(entryById.get(id)?.session_id ?? '')),
      )
      if (sessionIdsInChunk.size > 1) {
        invalidChunks.push({ reason: 'mixed_session_ids', member_ids: memberIds })
        skippedChunks += 1
        process.stderr.write(
          `[cycle1] chunk skipped: mixed session_ids in member_ids=${JSON.stringify(memberIds)} sessions=${JSON.stringify([...sessionIdsInChunk])}\n`,
        )
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
        db.exec('BEGIN')
        updateRoot.run(rootId, element, category, summary, projectId, rootId)
        for (const mid of memberIds) {
          if (mid === rootId) continue
          updateMember.run(rootId, projectId, mid, rootId)
        }
        db.exec('COMMIT')
        committedChunks += 1
        committedMembers += memberIds.length
        for (const mid of memberIds) {
          usedIds.add(mid)
          committedRowIds.add(mid)
        }
        // #4: queue the embedding sync rather than awaiting inline so a slow
        // embedText call cannot stall the rest of the window's Promise.all.
        markEmbeddingDirty(db, rootId)
      } catch (err) {
        try { db.exec('ROLLBACK') } catch {}
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

  // #2: bounded concurrency fan-out (semaphore wrapper) replaces unbounded
  // Promise.all over windows. Each call still runs in its own task, but at
  // most `concurrency` windows are inflight against the LLM at once.
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

  // Fire-and-forget the embedding flush so cycle1 returns as soon as the
  // chunking decisions are committed. The bge-m3 inference cost (especially
  // on cold start) used to add several seconds to the recap path; running
  // it in the background lets the next session-start hook proceed.
  // flushEmbeddingDirty is re-entrancy guarded; failures are re-queued.
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

function buildPidMap(rowSets) {
  const pids = [...new Set(rowSets.flat().map(r => r.project_id).filter(Boolean))].sort()
  return new Map(pids.map((p, i) => [p, `P${i + 1}`]))
}

function formatEntriesForPromotePrompt(rows, pidMap) {
  if (!rows || rows.length === 0) return '(none)'
  // pidMap may be provided by caller for cross-set consistency; fall back to
  // building one locally if not (keeps the function usable standalone).
  const map = pidMap ?? buildPidMap([rows])
  const lines = rows.map(r => {
    const tag = r.project_id ? (map.get(r.project_id) ?? 'C') : 'C'
    return `- id:${r.id} ${tag} ${r.category} s:${r.score ?? 'n'} el:${r.element} sm:${String(r.summary || '').slice(0, 150)}`
  })
  if (map.size === 0) return lines.join('\n')
  const legend = [...map.entries()].map(([p, t]) => `${t}=${p}`).concat('C=COMMON').join(', ')
  return `# pid: ${legend}\n` + lines.join('\n')
}

// Phase-scoped verb whitelists. `omit` in phase3 is a no-op (silently skipped,
// not an error). phase1/2 verbs that appear in the wrong phase are rejected with
// a stderr log and the action is dropped (reviewed_at not advanced).
const PHASE_VALID_VERBS = {
  phase1_new_chunks:  new Set(['add', 'pending']),
  phase2_reevaluate:  new Set(['promote', 'keep', 'processed']),
  phase3_active_review: new Set(['demote', 'archived', 'merge', 'update']),
}

function parseCycle2LineFormat(raw, phase) {
  if (raw == null) return null
  const text = String(raw).trim()
  if (!text) return { actions: [], rejectedIds: new Set() } // empty response = no actions, valid
  const validVerbs = phase ? PHASE_VALID_VERBS[phase] : null
  const lines = text.split('\n')
  const actions = []
  const rejectedIds = new Set()
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('//') || line.startsWith('#')) continue
    if (line.startsWith('```')) continue
    const parts = line.split('|')
    if (parts.length < 2) continue
    const entryId = Number(parts[0].trim())
    const action = parts[1].trim()
    if (!Number.isFinite(entryId) || !action) continue
    // Phase-scoped whitelist check
    if (validVerbs) {
      if (action === 'omit') continue // phase3 no-op; silently skip everywhere
      if (!validVerbs.has(action)) {
        process.stderr.write(
          `[cycle2] ${phase ?? 'unknown'} unknown verb=${action} id=${entryId}\n`,
        )
        rejectedIds.add(entryId)
        continue // drop — do NOT push to actions; reviewed_at not advanced for this row
      }
    }
    if (action === 'update') {
      actions.push({
        entry_id: entryId,
        action,
        element: (parts[2] ?? '').trim(),
        summary: parts.slice(3).join('|').trim(),
      })
    } else if (action === 'merge') {
      const targetId = Number((parts[2] ?? '').trim())
      const sourceIds = (parts[3] ?? '').split(',').map(s => Number(String(s).trim())).filter(Number.isFinite)
      actions.push({
        entry_id: entryId,
        action,
        target_id: Number.isFinite(targetId) ? targetId : entryId,
        source_ids: sourceIds,
        element: (parts[4] ?? '').trim(),
        summary: parts.slice(5).join('|').trim(),
      })
    } else {
      actions.push({ entry_id: entryId, action })
    }
  }
  return { actions, rejectedIds }
}

function parsePromoteActions(raw, phase) {
  // Line-format-first: cycle2-agent now emits `<entry_id>|<action>...` per
  // line. Empty body returns []. JSON path stays as fallback for any prior
  // model behaviour or hand-crafted callers still emitting `{"actions":[]}`.
  const lineResult = parseCycle2LineFormat(raw, phase)
  if (lineResult !== null && lineResult.actions.length > 0) return lineResult
  const parsed = extractJsonObject(raw)
  if (parsed && Array.isArray(parsed.actions)) {
    // Run JSON-path actions through the same phase verb gate so invalid verbs
    // in well-formed JSON are rejected and their ids tracked as rejected.
    const validVerbs = phase ? PHASE_VALID_VERBS[phase] : null
    const filteredActions = []
    const rejectedIds = new Set()
    for (const act of parsed.actions) {
      const entryId = Number(act?.entry_id)
      if (!Number.isFinite(entryId)) continue
      const action = typeof act?.action === 'string' ? act.action.trim() : ''
      if (validVerbs && action !== 'omit' && !validVerbs.has(action)) {
        process.stderr.write(
          `[cycle2] ${phase ?? 'unknown'} unknown verb (JSON)=${action} id=${entryId}\n`,
        )
        rejectedIds.add(entryId)
        continue
      }
      if (action === 'omit') continue
      filteredActions.push(act)
    }
    return { actions: filteredActions, rejectedIds }
  }
  // Empty line-parse + no JSON → genuinely empty (valid) only when raw was
  // empty/whitespace; otherwise treat as unparseable so caller can fail loud.
  if (lineResult !== null) return lineResult
  return null
}

function applyAddOrPromote(db, entryId, nextStatus, nowMs, activeCap) {
  const row = db.prepare(`SELECT category, last_seen_at, element, summary FROM entries WHERE id = ? AND is_root = 1`).get(entryId)
  if (!row) return false
  return db.transaction(() => {
    if (nextStatus === 'active' && activeCap != null) {
      const countStmt = db.prepare(
        `SELECT COUNT(*) AS n FROM entries WHERE is_root = 1 AND status = 'active'`,
      )
      const victimStmt = db.prepare(
        `SELECT id FROM entries WHERE is_root = 1 AND status = 'active' AND id != ?
         ORDER BY last_seen_at ASC, score ASC, id ASC LIMIT 1`,
      )
      const demoteStmt = db.prepare(`UPDATE entries SET status = 'demoted' WHERE id = ?`)
      const activeCount = countStmt.get()?.n ?? 0
      if (activeCount >= activeCap) {
        const victim = victimStmt.get(entryId)
        if (!victim) {
          process.stderr.write(
            `[cycle2] applyAddOrPromote: cap=${activeCap} full, no evictable victim — skipping promote for entry ${entryId}\n`,
          )
          return false
        }
        demoteStmt.run(victim.id)
        if ((countStmt.get()?.n ?? 0) >= activeCap) {
          process.stderr.write(
            `[cycle2] applyAddOrPromote: still over cap=${activeCap} after single demote — skipping promote for entry ${entryId}\n`,
          )
          return false
        }
      }
    }
    const newScore = computeEntryScore(row.category, nowMs, nowMs)
    const res = db.prepare(
      `UPDATE entries SET status = ?, score = ?, last_seen_at = ? WHERE id = ? AND is_root = 1`,
    ).run(nextStatus, newScore, nowMs, entryId)
    return Number(res.changes ?? 0) > 0
  })()
}

export function applySimpleStatus(db, entryId, nextStatus) {
  const res = db.prepare(
    `UPDATE entries SET status = ? WHERE id = ? AND is_root = 1`,
  ).run(nextStatus, entryId)
  return Number(res.changes ?? 0) > 0
}

export async function applyUpdate(db, entryId, element, summary) {
  const fields = []
  const params = []
  const newElement = (typeof element === 'string' && element.trim()) ? element.trim() : null
  const newSummary = (typeof summary === 'string' && summary.trim()) ? summary.trim() : null
  if (newElement) {
    fields.push('element = ?'); params.push(newElement)
  }
  if (newSummary) {
    fields.push('summary = ?'); params.push(newSummary)
    fields.push('summary_hash = NULL')
  }
  if (fields.length === 0) return false
  const row = db.prepare(
    `SELECT category, last_seen_at FROM entries WHERE id = ? AND is_root = 1`,
  ).get(entryId)
  if (row) {
    const nowMs = Date.now()
    const newScore = computeEntryScore(row.category, row.last_seen_at ?? nowMs, nowMs)
    fields.push('score = ?'); params.push(newScore)
  }
  params.push(entryId)
  const res = db.prepare(
    `UPDATE entries SET ${fields.join(', ')} WHERE id = ? AND is_root = 1`,
  ).run(...params)
  if (Number(res.changes ?? 0) === 0) return false
  await syncRootEmbedding(db, entryId)
  return true
}

export function applyMerge(db, targetId, sourceIds) {
  if (!Number.isFinite(targetId)) return 0
  const target = db.prepare(`SELECT id, project_id FROM entries WHERE id = ? AND is_root = 1`).get(targetId)
  if (!target) return 0
  let moved = 0
  for (const src of sourceIds) {
    const sid = Number(src)
    if (!Number.isFinite(sid) || sid === targetId) continue
    const srcRow = db.prepare(`SELECT id, project_id FROM entries WHERE id = ? AND is_root = 1`).get(sid)
    if (!srcRow) continue
    // Cross-pool merge guard: target and source must belong to the same pool.
    if (target.project_id !== srcRow.project_id) {
      process.stderr.write(
        `[cycle2] merge rejected: cross-pool (target=${targetId} project_id=${target.project_id ?? 'COMMON'} src=${sid} project_id=${srcRow.project_id ?? 'COMMON'})\n`,
      )
      continue
    }
    try {
      db.exec('BEGIN')
      db.prepare(
        `UPDATE entries SET chunk_root = ?, project_id = ? WHERE chunk_root = ? AND id != ? AND is_root = 0`,
      ).run(targetId, target.project_id, sid, sid)
      db.prepare(
        `UPDATE entries SET status = 'archived' WHERE id = ? AND is_root = 1`,
      ).run(sid)
      db.exec('COMMIT')
      deleteRootEmbedding(db, sid)
      moved += 1
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      process.stderr.write(`[cycle2] merge failed (target=${targetId} src=${sid}): ${err.message}\n`)
    }
  }
  return moved
}

export async function runPromotePhase(db, phaseName, rows, activeRows, config, options, extraReplacements = {}) {
  if (!rows || rows.length === 0) return { actions: [] }
  const promptPath = join(resourceDir(), 'defaults', 'memory-promote-prompt.md')
  if (!existsSync(promptPath)) {
    throw new Error(`runCycle2: prompt file missing at ${promptPath}`)
  }
  const template = readFileSync(promptPath, 'utf8')
  // Build a single pidMap across both activeRows and rows so the same project
  // always gets the same P-label in both the active-context block and items block.
  const sharedPidMap = buildPidMap([activeRows ?? [], rows ?? []])
  let prompt = template
    .replace('{{PHASE}}', phaseName)
    .replace('{{CORE_MEMORY}}', formatEntriesForPromotePrompt(activeRows, sharedPidMap))
    .replace('{{ITEMS}}', formatEntriesForPromotePrompt(rows, sharedPidMap))
  for (const [k, v] of Object.entries(extraReplacements)) {
    prompt = prompt.replace(`{{${k}}}`, String(v))
  }

  const preset = options.preset || resolveMaintenancePreset('cycle2')
  const timeout = Number(config?.cycle2?.timeout ?? 600000)
  const mode = `cycle2-${phaseName}`

  // Stability fix: cycle2 was accumulating unparseable/timeout entries in
  // memory-worker.log because (1) the user prompt lacked an explicit JSON
  // directive — the role rules said "no preamble" but HAIKU still emitted
  // prose ~5% of the time, and (2) any single LLM hiccup wrote off the whole
  // phase batch. The prompt template now ends with an explicit format block;
  // here we add a single retry on unparseable (cache-busted with a tag) but
  // NOT on timeout — a 600s timeout already wasted enough wall clock, and
  // retrying would compound the burst latency that pushed cycle2 to 138s.
  const previewRaw = (raw) => String(raw ?? '').replace(/\s+/g, ' ').slice(0, 200)
  const callOnce = async (extraTag) => {
    const p = extraTag ? `${prompt}\n\n[retry:${extraTag}]` : prompt
    return await invokeLlm(p, options, mode, preset, timeout)
  }
  let raw
  try {
    raw = await callOnce(null)
  } catch (err) {
    process.stderr.write(`[cycle2] ${phaseName} LLM error: ${err.message}\n`)
    return { actions: null, parseOk: false }
  }
  let parseResult = parsePromoteActions(raw, phaseName)
  if (!parseResult) {
    process.stderr.write(`[cycle2] ${phaseName} unparseable response, retrying once (${previewRaw(raw)})\n`)
    try {
      const raw2 = await callOnce('json-only')
      parseResult = parsePromoteActions(raw2, phaseName)
      if (!parseResult) {
        process.stderr.write(`[cycle2] ${phaseName} unparseable after retry — skipping batch (${previewRaw(raw2)})\n`)
        return { actions: null, parseOk: false }
      }
    } catch (err) {
      process.stderr.write(`[cycle2] ${phaseName} retry LLM error: ${err.message}\n`)
      return { actions: null, parseOk: false }
    }
  }
  return { actions: parseResult.actions, rejectedIds: parseResult.rejectedIds, parseOk: true }
}

export async function runCycle2(db, config = {}, options = {}) {
  // #1: per-db SKIP gate mirroring cycle1.
  if (_runCycle2InFlight.has(db)) {
    process.stderr.write('[cycle2] skipped: already in flight for this db\n')
    return {
      phase1: { added: 0, pending: 0 },
      phase2: { promoted: 0, kept: 0, processed: 0 },
      phase3: { demoted: 0, merged: 0, archived: 0, updated: 0, kept: 0 },
      skippedInFlight: true,
    }
  }
  const _p = (async () => _runCycle2Impl(db, config, options))()
  _runCycle2InFlight.set(db, _p)
  try { return await _p }
  finally { _runCycle2InFlight.delete(db) }
}

async function _runCycle2Impl(db, config = {}, options = {}) {
  const batchSize = Math.max(1, Number(config.batch_size ?? 50))
  const activeCap = Math.max(1, Number(config.active_cap ?? CYCLE2_ACTIVE_CAP))
  const nowMs = Date.now()
  // Monotonic sweep cursor: use max(reviewed_at)+1 so the touch timestamp is
  // always strictly greater than any existing value, avoiding wall-clock skew.
  // Falls back to nowMs if the table is empty or reviewed_at has never been set.
  const maxReviewedRow = db.prepare(
    `SELECT MAX(reviewed_at) AS m FROM entries WHERE is_root = 1`,
  ).get()
  const sweepCursor = (maxReviewedRow?.m != null && maxReviewedRow.m > 0)
    ? maxReviewedRow.m + 1
    : nowMs

  const stats = {
    phase1: { added: 0, pending: 0 },
    phase2: { promoted: 0, kept: 0, processed: 0 },
    phase3: { demoted: 0, merged: 0, archived: 0, updated: 0, kept: 0 },
  }

  // #7: bound the active-context fetch to activeCap. Without LIMIT the cap
  // existed only as a display value passed into the phase3 prompt; the SQL
  // pulled every active root, blowing up the prompt on busy DBs.
  const loadActive = () => db.prepare(
    `SELECT id, element, category, summary, score, last_seen_at, project_id
     FROM entries WHERE is_root = 1 AND status = 'active'
     ORDER BY last_seen_at DESC, score DESC, id ASC LIMIT ?`,
  ).all(activeCap)

  // ORDER BY error_count ASC so rows with fewer parse failures are served first.
  // Includes 'active' rows so legacy active entries that pre-date the EXCLUDE
  // rubric rotate through phase3 and can be archived or demoted on each cycle.
  const loadPhase3Candidates = () => db.prepare(
    `SELECT id, element, category, summary, score, last_seen_at, project_id
     FROM entries WHERE is_root = 1 AND status IN ('pending','demoted','active')
     ORDER BY error_count ASC, reviewed_at ASC, id ASC
     LIMIT ?`,
  ).all(batchSize)

  const touchReviewed = db.prepare(
    `UPDATE entries SET reviewed_at = ? WHERE id = ?`,
  )
  const bumpErrorCount = db.prepare(
    `UPDATE entries SET error_count = COALESCE(error_count, 0) + 1 WHERE id = ?`,
  )

  const phase1Rows = db.prepare(
    `SELECT id, element, category, summary, score, project_id
     FROM entries WHERE is_root = 1 AND status IS NULL
     ORDER BY id DESC LIMIT ?`,
  ).all(batchSize)

  if (phase1Rows.length > 0) {
    const { actions: phase1Actions } = await runPromotePhase(db, 'phase1_new_chunks', phase1Rows, loadActive(), config, options)
    // #6: only apply actions whose entry_id was actually presented to the LLM.
    const allowed = new Set(phase1Rows.map(r => Number(r.id)))
    for (const act of (phase1Actions ?? [])) {
      const entryId = Number(act?.entry_id)
      if (!Number.isFinite(entryId)) continue
      if (!allowed.has(entryId)) {
        process.stderr.write(`[cycle2] phase1 action rejected: entry_id=${entryId} outside batch\n`)
        continue
      }
      try {
        if (act.action === 'add' && applyAddOrPromote(db, entryId, 'active', nowMs, activeCap)) {
          try { db.prepare(`UPDATE entries SET reviewed_at = ? WHERE id = ? AND is_root = 1`).run(sweepCursor, entryId) } catch {}
          stats.phase1.added += 1
        }
        else if (act.action === 'pending' && applySimpleStatus(db, entryId, 'pending')) stats.phase1.pending += 1
      } catch (err) {
        process.stderr.write(`[cycle2] phase1 action error (id=${entryId}): ${err.message}\n`)
      }
    }
  }

  const phase2Rows = db.prepare(
    `SELECT id, element, category, summary, score, project_id
     FROM entries WHERE is_root = 1 AND status IN ('pending', 'demoted')
     ORDER BY error_count ASC, reviewed_at ASC, id ASC LIMIT ?`,
  ).all(batchSize)

  if (phase2Rows.length > 0) {
    const phase2Active = loadActive()
    const { actions: phase2Actions, rejectedIds: phase2RejectedIds = new Set() } = await runPromotePhase(db, 'phase2_reevaluate', phase2Rows, phase2Active, config, options)
    if (phase2Actions) {
      // Touch reviewed_at AFTER successful LLM parse so the cursor only advances
      // on a real decision (parse failures increment error_count instead).
      // Exclude rejected ids so they retry next sweep.
      for (const row of phase2Rows) {
        if (phase2RejectedIds.has(Number(row.id))) continue
        try { touchReviewed.run(sweepCursor, row.id) } catch {}
      }
      // #6: phase2 batch allow-list.
      const allowed = new Set(phase2Rows.map(r => Number(r.id)))
      for (const act of phase2Actions) {
        const entryId = Number(act?.entry_id)
        if (!Number.isFinite(entryId)) continue
        if (!allowed.has(entryId)) {
          process.stderr.write(`[cycle2] phase2 action rejected: entry_id=${entryId} outside batch\n`)
          continue
        }
        try {
          if (act.action === 'promote' && applyAddOrPromote(db, entryId, 'active', nowMs, activeCap)) stats.phase2.promoted += 1
          else if (act.action === 'keep') stats.phase2.kept += 1
          else if (act.action === 'processed' && applySimpleStatus(db, entryId, 'processed')) stats.phase2.processed += 1
        } catch (err) {
          process.stderr.write(`[cycle2] phase2 action error (id=${entryId}): ${err.message}\n`)
        }
      }
    } else {
      // LLM parse failed — bump error_count on all candidates; cursor not advanced.
      for (const row of phase2Rows) {
        try { bumpErrorCount.run(row.id) } catch {}
      }
    }
  }

  const phase3Rows = loadPhase3Candidates()
  if (phase3Rows.length > 0) {
    const activeContext = loadActive()
    // ACTIVE_COUNT: use a precise COUNT(*) query rather than activeContext.length
    // (which is capped by activeCap and may under-report on busy DBs). Also
    // surface a per-project breakdown so the prompt has accurate context.
    const activeCountRow = db.prepare(
      `SELECT COUNT(*) AS total FROM entries WHERE is_root = 1 AND status = 'active'`,
    ).get()
    const activeCountTotal = activeCountRow?.total ?? 0
    const projectBreakdown = db.prepare(
      `SELECT COALESCE(project_id, '(none)') AS pid, COUNT(*) AS cnt
       FROM entries WHERE is_root = 1 AND status = 'active'
       GROUP BY pid ORDER BY cnt DESC LIMIT 10`,
    ).all()
    const activeCountLabel = projectBreakdown.length > 1
      ? `${activeCountTotal} (${projectBreakdown.map(r => `${r.pid}:${r.cnt}`).join(', ')})`
      : String(activeCountTotal)
    const { actions: phase3Actions, rejectedIds: phase3RejectedIds = new Set() } = await runPromotePhase(
      db, 'phase3_active_review', phase3Rows, activeContext, config, options,
      { ACTIVE_COUNT: activeCountLabel, ACTIVE_CAP: activeCap },
    )
    if (phase3Actions) {
      // Touch reviewed_at AFTER successful parse so cursor only advances on a
      // real decision; parse failures increment error_count for backoff.
      // Exclude rejected ids so they retry next sweep.
      for (const row of phase3Rows) {
        if (phase3RejectedIds.has(Number(row.id))) continue
        try { touchReviewed.run(sweepCursor, row.id) } catch {}
      }
    } else {
      for (const row of phase3Rows) {
        try { bumpErrorCount.run(row.id) } catch {}
      }
    }
    // #6: phase3 sees both phase3Rows AND activeContext rows (the prompt
    // formats both). All entry_id/target_id/source_ids must fall in that union.
    const allowed = new Set([
      ...phase3Rows.map(r => Number(r.id)),
      ...activeContext.map(r => Number(r.id)),
    ])
    for (const act of (phase3Actions ?? [])) {
      try {
        if (act.action === 'demote') {
          const eid = Number(act?.entry_id)
          if (!allowed.has(eid)) {
            process.stderr.write(`[cycle2] phase3 demote rejected: id=${eid} outside batch\n`); continue
          }
          if (Number.isFinite(eid) && applySimpleStatus(db, eid, 'demoted')) stats.phase3.demoted += 1
        } else if (act.action === 'archived') {
          const eid = Number(act?.entry_id)
          if (!allowed.has(eid)) {
            process.stderr.write(`[cycle2] phase3 archive rejected: id=${eid} outside batch\n`); continue
          }
          if (Number.isFinite(eid) && applySimpleStatus(db, eid, 'archived')) stats.phase3.archived += 1
        } else if (act.action === 'update') {
          const eid = Number(act?.entry_id)
          if (!allowed.has(eid)) {
            process.stderr.write(`[cycle2] phase3 update rejected: id=${eid} outside batch\n`); continue
          }
          if (Number.isFinite(eid) && await applyUpdate(db, eid, act.element, act.summary)) stats.phase3.updated += 1
        } else if (act.action === 'merge') {
          const targetId = Number(act?.target_id)
          const sourceIds = Array.isArray(act?.source_ids) ? act.source_ids : []
          if (!allowed.has(targetId)) {
            process.stderr.write(`[cycle2] phase3 merge target rejected: id=${targetId} outside batch\n`); continue
          }
          const filteredSources = sourceIds.filter(s => allowed.has(Number(s)))
          if (filteredSources.length !== sourceIds.length) {
            process.stderr.write(
              `[cycle2] phase3 merge sources filtered: ${JSON.stringify(sourceIds)} -> ${JSON.stringify(filteredSources)}\n`,
            )
          }
          const moved = applyMerge(db, targetId, filteredSources)
          if (moved > 0) {
            stats.phase3.merged += moved
            if (typeof act.element === 'string' || typeof act.summary === 'string') {
              try {
                if (await applyUpdate(db, targetId, act.element, act.summary)) stats.phase3.updated += 1
              } catch (err) {
                process.stderr.write(`[cycle2] merge target update failed (target=${targetId}): ${err.message}\n`)
              }
            }
          }
        }
      } catch (err) {
        process.stderr.write(`[cycle2] phase3 action error: ${err.message}\n`)
      }
    }
    // Count rows presented to phase3 that had no action taken (kept / no-op).
    const actedIds = new Set((phase3Actions ?? []).map(a => Number(a?.entry_id)).filter(Number.isFinite))
    for (const row of phase3Rows) {
      if (!actedIds.has(Number(row.id))) stats.phase3.kept += 1
    }
  }

  // Fire-and-forget — same rationale as cycle1's flush above. cycle2 emits
  // its phase stats immediately and lets embedding catch up in the
  // background. flushEmbeddingDirty is re-entrancy guarded.
  void flushEmbeddingDirty(db).then(d => {
    if (d.attempted > 0) {
      process.stderr.write(
        `[cycle2] embedding flush (async) attempted=${d.attempted} ok=${d.succeeded} failed=${d.failed.length}\n`,
      )
    }
  }).catch(err => {
    process.stderr.write(`[cycle2] embedding flush (async) failed: ${err.message}\n`)
  })
  stats.embedding_dirty = { attempted: 0, succeeded: 0, failed: 0, failed_ids: [], deferred: true }

  process.stderr.write(
    `[cycle2] phase1 added=${stats.phase1.added} pending=${stats.phase1.pending}` +
    ` | phase2 promoted=${stats.phase2.promoted} kept=${stats.phase2.kept} processed=${stats.phase2.processed}` +
    ` | phase3 demoted=${stats.phase3.demoted} merged=${stats.phase3.merged}` +
    ` archived=${stats.phase3.archived} updated=${stats.phase3.updated} kept=${stats.phase3.kept}\n`,
  )

  return stats
}

export function parseInterval(s) {
  if (String(s).toLowerCase() === 'immediate') return 0
  const match = String(s).match(/^(\d+)(s|m|h)$/)
  if (!match) return 600000
  const [, num, unit] = match
  const multiplier = { s: 1000, m: 60000, h: 3600000 }
  return Number(num) * multiplier[unit]
}
