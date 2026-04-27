import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { cleanMemoryText } from './memory.mjs'
import { resolveMaintenancePreset } from '../../shared/llm/index.mjs'
import { callBridgeLlm } from './agent-ipc.mjs'
import { computeEntryScore } from './memory-score.mjs'
import { embedText } from './embedding-provider.mjs'

export async function syncRootEmbedding(db, rootId) {
  const row = db.prepare(`SELECT element, summary FROM entries WHERE id = ? AND is_root = 1`).get(rootId)
  if (!row) return false
  const text = [row.element, row.summary].filter(Boolean).join(' — ').trim()
  if (!text) return false
  let vector
  try { vector = await embedText(text) }
  catch (err) {
    process.stderr.write(`[embed-sync] embedText failed (id=${rootId}): ${err.message}\n`)
    return false
  }
  if (!Array.isArray(vector) || vector.length === 0) return false
  const blob = Buffer.alloc(vector.length * 4)
  for (let i = 0; i < vector.length; i++) blob.writeFloatLE(vector[i], i * 4)
  try {
    db.prepare(`UPDATE entries SET embedding = ? WHERE id = ? AND is_root = 1`).run(blob, rootId)
    const upd = db.prepare(`UPDATE vec_entries SET embedding = ? WHERE rowid = ?`).run(blob, BigInt(rootId))
    if (Number(upd.changes ?? 0) === 0) {
      db.prepare(`INSERT INTO vec_entries(rowid, embedding) VALUES (?, ?)`).run(BigInt(rootId), blob)
    }
    return true
  } catch (err) {
    process.stderr.write(`[embed-sync] db write failed (id=${rootId}): ${err.message}\n`)
    return false
  }
}

export function deleteRootEmbedding(db, rootId) {
  try {
    db.prepare(`UPDATE entries SET embedding = NULL WHERE id = ? AND is_root = 1`).run(rootId)
    db.prepare(`DELETE FROM vec_entries WHERE rowid = ?`).run(BigInt(rootId))
    return true
  } catch (err) {
    process.stderr.write(`[embed-sync] delete failed (id=${rootId}): ${err.message}\n`)
    return false
  }
}

const VALID_CATEGORIES = new Set([
  'rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue',
])

const CYCLE2_ACTIVE_CAP = 50

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
  return entries.map(e => {
    const content = cleanMemoryText(String(e.content ?? '')).slice(0, 400)
    // [sess:XXXXXXXX] = first 8 chars of session_id; the cycle1-agent rule
    // forbids merging member_ids across different session markers.
    const sess = e.session_id ? String(e.session_id).slice(0, 8) : 'null----'
    return `- id:${e.id} ts:${e.ts} role:${e.role} [sess:${sess}] content:${content}`
  }).join('\n')
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
  const timeout = Number(config?.cycle1?.timeout ?? 600000)

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
    SELECT id, ts, role, content, session_id
    FROM entries
    WHERE chunk_root IS NULL AND session_id IS NOT NULL
    ORDER BY ts DESC, id DESC
    LIMIT ?
  `).all(fetchLimit)

  if (rowsDesc.length < minBatch) {
    return {
      processed: 0,
      chunks: 0,
      skipped: 0,
      sessions: 0,
      skippedInFlight: false,
      pendingRows: pendingRowsAtStart,
    }
  }

  const allRows = rowsDesc.slice().reverse() // chronological ASC

  // Split into sub-windows of batchSize rows for Promise.all parallelism.
  const windows = []
  for (let i = 0; i < allRows.length; i += batchSize) {
    windows.push(allRows.slice(i, i + batchSize))
  }

  const updateRoot = db.prepare(`
    UPDATE entries
    SET chunk_root = ?, is_root = 1, element = ?, category = ?, summary = ?,
        status = NULL, last_seen_at = CAST(strftime('%s','now') AS INTEGER) * 1000
    WHERE id = ?
  `)
  const updateMember = db.prepare(`
    UPDATE entries SET chunk_root = ? WHERE id = ? AND id != ?
  `)

  async function processWindow(rows, windowIdx) {
    if (rows.length === 0) {
      return { committedChunks: 0, committedMembers: 0, skippedChunks: 0, rowsConsidered: 0 }
    }

    const userMessage = [
      `Run cycle1: chunk these entries and emit JSON per the cycle1 spec.`,
      `Entries below carry [sess:XXXXXXXX] markers; never merge member_ids across different session markers.`,
      '',
      buildEntriesText(rows),
    ].join('\n')

    let raw
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

    const parsed = extractJsonObject(raw)
    const chunkList = Array.isArray(parsed?.chunks) ? parsed.chunks : null
    if (!chunkList) {
      process.stderr.write(`[cycle1] unparseable response (window=${windowIdx}) (${String(raw).slice(0, 200)})\n`)
      return { committedChunks: 0, committedMembers: 0, skippedChunks: rows.length, rowsConsidered: rows.length }
    }

    const entryById = new Map(rows.map(r => [Number(r.id), r]))
    let committedChunks = 0
    let committedMembers = 0
    let skippedChunks = 0

    for (const chunk of chunkList) {
      const memberIds = Array.isArray(chunk?.member_ids)
        ? chunk.member_ids.map(n => Number(n)).filter(n => Number.isFinite(n) && entryById.has(n))
        : []
      const element = String(chunk?.element ?? '').trim()
      const category = String(chunk?.category ?? '').trim().toLowerCase()
      const summary = String(chunk?.summary ?? '').trim()

      if (memberIds.length === 0 || !element || !summary || !VALID_CATEGORIES.has(category)) {
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
        skippedChunks += 1
        process.stderr.write(
          `[cycle1] chunk skipped: mixed session_ids in member_ids=${JSON.stringify(memberIds)} sessions=${JSON.stringify([...sessionIdsInChunk])}\n`,
        )
        continue
      }

      const members = memberIds.map(id => entryById.get(id))
      const rootId = selectRootId(members)
      if (rootId === null) {
        skippedChunks += 1
        continue
      }

      try {
        db.exec('BEGIN')
        updateRoot.run(rootId, element, category, summary, rootId)
        for (const mid of memberIds) {
          if (mid === rootId) continue
          updateMember.run(rootId, mid, rootId)
        }
        db.exec('COMMIT')
        committedChunks += 1
        committedMembers += memberIds.length
        await syncRootEmbedding(db, rootId)
      } catch (err) {
        try { db.exec('ROLLBACK') } catch {}
        process.stderr.write(`[cycle1] chunk commit failed (root=${rootId}): ${err.message}\n`)
        skippedChunks += 1
      }
    }

    process.stderr.write(
      `[cycle1] window=${windowIdx} entries=${rows.length} chunks=${committedChunks} members=${committedMembers} skipped=${skippedChunks}\n`,
    )

    return { committedChunks, committedMembers, skippedChunks, rowsConsidered: rows.length }
  }

  const results = await Promise.all(windows.map((rows, idx) => processWindow(rows, idx)))

  let totalChunks = 0
  let totalMembers = 0
  let totalSkipped = 0
  let totalRowsConsidered = 0
  for (const r of results) {
    totalChunks += r.committedChunks
    totalMembers += r.committedMembers
    totalSkipped += r.skippedChunks
    totalRowsConsidered += r.rowsConsidered
  }

  process.stderr.write(
    `[cycle1] windows=${windows.length} rows=${totalRowsConsidered} chunks=${totalChunks} members=${totalMembers} skipped=${totalSkipped}\n`,
  )

  return {
    processed: totalMembers,
    chunks: totalChunks,
    skipped: totalSkipped,
    sessions: windows.length,
    skippedInFlight: false,
    pendingRows: pendingRowsAtStart,
  }
}

function formatEntriesForPromotePrompt(rows) {
  if (!rows || rows.length === 0) return '(none)'
  return rows.map(r =>
    `- entry_id:${r.id} category:${r.category} score:${r.score ?? 'null'} element:${r.element} summary:${String(r.summary || '').slice(0, 200)}`,
  ).join('\n')
}

function parsePromoteActions(raw) {
  const parsed = extractJsonObject(raw)
  if (!parsed || !Array.isArray(parsed.actions)) return null
  return parsed.actions
}

function applyAddOrPromote(db, entryId, nextStatus, nowMs) {
  const row = db.prepare(`SELECT category, last_seen_at FROM entries WHERE id = ? AND is_root = 1`).get(entryId)
  if (!row) return false
  const newScore = computeEntryScore(row.category, nowMs, nowMs)
  const res = db.prepare(
    `UPDATE entries SET status = ?, score = ?, last_seen_at = ? WHERE id = ? AND is_root = 1`,
  ).run(nextStatus, newScore, nowMs, entryId)
  return Number(res.changes ?? 0) > 0
}

function applySimpleStatus(db, entryId, nextStatus) {
  const res = db.prepare(
    `UPDATE entries SET status = ? WHERE id = ? AND is_root = 1`,
  ).run(nextStatus, entryId)
  return Number(res.changes ?? 0) > 0
}

async function applyUpdate(db, entryId, element, summary) {
  const fields = []
  const params = []
  if (typeof element === 'string' && element.trim()) {
    fields.push('element = ?'); params.push(element.trim())
  }
  if (typeof summary === 'string' && summary.trim()) {
    fields.push('summary = ?'); params.push(summary.trim())
    fields.push('summary_hash = NULL')
  }
  if (fields.length === 0) return false
  params.push(entryId)
  const res = db.prepare(
    `UPDATE entries SET ${fields.join(', ')} WHERE id = ? AND is_root = 1`,
  ).run(...params)
  if (Number(res.changes ?? 0) === 0) return false
  await syncRootEmbedding(db, entryId)
  return true
}

function applyMerge(db, targetId, sourceIds) {
  if (!Number.isFinite(targetId)) return 0
  const target = db.prepare(`SELECT id FROM entries WHERE id = ? AND is_root = 1`).get(targetId)
  if (!target) return 0
  let moved = 0
  for (const src of sourceIds) {
    const sid = Number(src)
    if (!Number.isFinite(sid) || sid === targetId) continue
    const srcRow = db.prepare(`SELECT id FROM entries WHERE id = ? AND is_root = 1`).get(sid)
    if (!srcRow) continue
    try {
      db.exec('BEGIN')
      db.prepare(
        `UPDATE entries SET chunk_root = ? WHERE chunk_root = ? AND id != ? AND is_root = 0`,
      ).run(targetId, sid, sid)
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

async function runPromotePhase(db, phaseName, rows, activeRows, config, options, extraReplacements = {}) {
  if (!rows || rows.length === 0) return { actions: [] }
  const promptPath = join(resourceDir(), 'defaults', 'memory-promote-prompt.md')
  if (!existsSync(promptPath)) {
    throw new Error(`runCycle2: prompt file missing at ${promptPath}`)
  }
  const template = readFileSync(promptPath, 'utf8')
  let prompt = template
    .replace('{{PHASE}}', phaseName)
    .replace('{{CORE_MEMORY}}', formatEntriesForPromotePrompt(activeRows))
    .replace('{{ITEMS}}', formatEntriesForPromotePrompt(rows))
  for (const [k, v] of Object.entries(extraReplacements)) {
    prompt = prompt.replace(`{{${k}}}`, String(v))
  }

  const preset = options.preset || resolveMaintenancePreset('cycle2')
  const timeout = Number(config?.cycle2?.timeout ?? 600000)
  const mode = `cycle2-${phaseName}`

  try {
    const raw = await invokeLlm(prompt, options, mode, preset, timeout)
    const actions = parsePromoteActions(raw)
    if (!actions) {
      process.stderr.write(`[cycle2] ${phaseName} unparseable response (${String(raw).slice(0, 200)})\n`)
      return { actions: [] }
    }
    return { actions }
  } catch (err) {
    process.stderr.write(`[cycle2] ${phaseName} LLM error: ${err.message}\n`)
    return { actions: [] }
  }
}

export async function runCycle2(db, config = {}, options = {}) {
  const batchSize = Math.max(1, Number(config.batch_size ?? 50))
  const activeCap = Math.max(1, Number(config.active_cap ?? CYCLE2_ACTIVE_CAP))
  const nowMs = Date.now()

  const stats = {
    phase1: { added: 0, pending: 0 },
    phase2: { promoted: 0, kept: 0, processed: 0 },
    phase3: { demoted: 0, merged: 0, archived: 0, updated: 0 },
  }

  const loadActive = () => db.prepare(
    `SELECT id, element, category, summary, score, last_seen_at
     FROM entries WHERE is_root = 1 AND status = 'active'
     ORDER BY score DESC`,
  ).all()

  const loadPhase3Candidates = () => db.prepare(
    `SELECT id, element, category, summary, score, last_seen_at
     FROM entries WHERE is_root = 1 AND status IN ('active', 'processed')
     ORDER BY last_seen_at ASC, score DESC
     LIMIT ?`,
  ).all(batchSize)

  const phase1Rows = db.prepare(
    `SELECT id, element, category, summary, score
     FROM entries WHERE is_root = 1 AND status IS NULL
     ORDER BY id DESC LIMIT ?`,
  ).all(batchSize)

  if (phase1Rows.length > 0) {
    const { actions } = await runPromotePhase(db, 'phase1_new_chunks', phase1Rows, loadActive(), config, options)
    for (const act of actions) {
      const entryId = Number(act?.entry_id)
      if (!Number.isFinite(entryId)) continue
      try {
        if (act.action === 'add' && applyAddOrPromote(db, entryId, 'active', nowMs)) stats.phase1.added += 1
        else if (act.action === 'pending' && applySimpleStatus(db, entryId, 'pending')) stats.phase1.pending += 1
      } catch (err) {
        process.stderr.write(`[cycle2] phase1 action error (id=${entryId}): ${err.message}\n`)
      }
    }
  }

  const phase2Rows = db.prepare(
    `SELECT id, element, category, summary, score
     FROM entries WHERE is_root = 1 AND status IN ('pending', 'demoted')
     ORDER BY id DESC LIMIT ?`,
  ).all(batchSize)

  if (phase2Rows.length > 0) {
    const { actions } = await runPromotePhase(db, 'phase2_reevaluate', phase2Rows, loadActive(), config, options)
    for (const act of actions) {
      const entryId = Number(act?.entry_id)
      if (!Number.isFinite(entryId)) continue
      try {
        if (act.action === 'promote' && applyAddOrPromote(db, entryId, 'active', nowMs)) stats.phase2.promoted += 1
        else if (act.action === 'keep') stats.phase2.kept += 1
        else if (act.action === 'processed' && applySimpleStatus(db, entryId, 'processed')) stats.phase2.processed += 1
      } catch (err) {
        process.stderr.write(`[cycle2] phase2 action error (id=${entryId}): ${err.message}\n`)
      }
    }
  }

  const phase3Rows = loadPhase3Candidates()
  if (phase3Rows.length > 0) {
    const activeContext = loadActive()
    const { actions } = await runPromotePhase(
      db, 'phase3_active_review', phase3Rows, activeContext, config, options,
      { ACTIVE_COUNT: activeContext.length, ACTIVE_CAP: activeCap },
    )
    for (const act of actions) {
      try {
        if (act.action === 'demote') {
          const eid = Number(act?.entry_id)
          if (Number.isFinite(eid) && applySimpleStatus(db, eid, 'demoted')) stats.phase3.demoted += 1
        } else if (act.action === 'archived') {
          const eid = Number(act?.entry_id)
          if (Number.isFinite(eid) && applySimpleStatus(db, eid, 'archived')) stats.phase3.archived += 1
        } else if (act.action === 'update') {
          const eid = Number(act?.entry_id)
          if (Number.isFinite(eid) && await applyUpdate(db, eid, act.element, act.summary)) stats.phase3.updated += 1
        } else if (act.action === 'merge') {
          const targetId = Number(act?.target_id)
          const sourceIds = Array.isArray(act?.source_ids) ? act.source_ids : []
          const moved = applyMerge(db, targetId, sourceIds)
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
  }

  process.stderr.write(
    `[cycle2] phase1 added=${stats.phase1.added} pending=${stats.phase1.pending}` +
    ` | phase2 promoted=${stats.phase2.promoted} kept=${stats.phase2.kept} processed=${stats.phase2.processed}` +
    ` | phase3 demoted=${stats.phase3.demoted} merged=${stats.phase3.merged}` +
    ` archived=${stats.phase3.archived} updated=${stats.phase3.updated}\n`,
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
