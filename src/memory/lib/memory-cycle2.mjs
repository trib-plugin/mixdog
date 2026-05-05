import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir as _homedir } from 'os'
import { resolveMaintenancePreset } from '../../shared/llm/index.mjs'
import { callBridgeLlm } from './agent-ipc.mjs'
import { computeEntryScore } from './memory-score.mjs'
import {
  syncRootEmbedding, deleteRootEmbedding, flushEmbeddingDirty,
} from './memory-embed.mjs'

const CYCLE2_ACTIVE_TARGET_CAP = 100
const TIER1_THRESHOLD = 0.78
const TIER2_LOW = 0.65
const LLM_JUDGE_CAP = 20

// Status-based verb whitelist. The LLM cannot archive a 'fixed' entry —
// user-injected memories are protected; only update/merge are permitted.
const STATUS_ALLOWED_VERBS = {
  pending: new Set(['active', 'archived']),
  active:  new Set(['active', 'archived', 'update', 'merge']),
  fixed:   new Set(['fixed', 'update', 'merge']),
}

function resourceDir() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT
  throw new Error('CLAUDE_PLUGIN_ROOT env var required for prompt loading')
}

async function invokeLlm(prompt, mode, preset, timeout) {
  return await callBridgeLlm({
    role: 'cycle2-agent',
    taskType: 'maintenance',
    mode,
    preset,
    timeout,
    cwd: null,
  }, prompt)
}

function buildPidMap(rowSets) {
  const pids = [...new Set(rowSets.flat().map(r => r.project_id).filter(Boolean))].sort()
  return new Map(pids.map((p, i) => [p, `P${i + 1}`]))
}

function formatEntriesForPromotePrompt(rows, pidMap) {
  if (!rows || rows.length === 0) return '(none)'
  const map = pidMap ?? buildPidMap([rows])
  const lines = rows.map(r => {
    const tag = r.project_id ? (map.get(r.project_id) ?? 'C') : 'C'
    const stat = r.status ? `[${r.status}]` : '[?]'
    return `- id:${r.id} ${stat} ${tag} ${r.category} s:${r.score ?? 'n'} el:${r.element} sm:${String(r.summary || '').slice(0, 100)}`
  })
  if (map.size === 0) return lines.join('\n')
  const legend = [...map.entries()].map(([p, t]) => `${t}=${p}`).concat('C=COMMON').join(', ')
  return `# pid: ${legend}\n` + lines.join('\n')
}

// Parse pipe-format unified verdicts. Each line: <id>|<verb> [|...].
// Verbs validated against the row's current status via STATUS_ALLOWED_VERBS.
// Returns { actions, rejected } or null when no parseable lines.
function parseUnifiedFormat(raw, statusById) {
  if (raw == null) return null
  const text = String(raw).trim()
  if (!text) return { actions: [], rejected: new Set() }
  const lines = text.split('\n')
  const actions = []
  const rejected = new Set()
  let sawValid = false
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
    sawValid = true
    const status = statusById.get(entryId)
    if (!status) continue
    const allowed = STATUS_ALLOWED_VERBS[status]
    if (!allowed || !allowed.has(action)) {
      process.stderr.write(`[cycle2] verb rejected: id=${entryId} status=${status} verb=${action}\n`)
      rejected.add(entryId)
      continue
    }
    if (action === 'update') {
      actions.push({
        entry_id: entryId, action,
        element: (parts[2] ?? '').trim(),
        summary: parts.slice(3).join('|').trim(),
      })
    } else if (action === 'merge') {
      const targetId = Number((parts[2] ?? '').trim())
      const sourceIds = (parts[3] ?? '').split(',').map(s => Number(String(s).trim())).filter(Number.isFinite)
      actions.push({
        entry_id: entryId, action,
        target_id: Number.isFinite(targetId) ? targetId : entryId,
        source_ids: sourceIds,
        element: (parts[4] ?? '').trim(),
        summary: parts.slice(5).join('|').trim(),
      })
    } else {
      actions.push({ entry_id: entryId, action })
    }
  }
  if (!sawValid && rejected.size === 0) return null
  return { actions, rejected }
}

// Promote a 'pending' row to 'active' with score recompute and promoted_at set.
function applyPromoteFromPending(db, entryId, nowMs) {
  const row = db.prepare(`SELECT category FROM entries WHERE id = ? AND is_root = 1 AND status = 'pending'`).get(entryId)
  if (!row) return false
  const newScore = computeEntryScore(row.category, nowMs, nowMs)
  const res = db.prepare(
    `UPDATE entries SET status = 'active', score = ?, last_seen_at = ?,
      promoted_at = COALESCE(promoted_at, ?)
     WHERE id = ? AND is_root = 1 AND status = 'pending'`,
  ).run(newScore, nowMs, nowMs, entryId)
  return Number(res.changes ?? 0) > 0
}

// Generic status update for archived/demote terminal transitions.
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
    const srcRow = db.prepare(`SELECT id, project_id, status FROM entries WHERE id = ? AND is_root = 1`).get(sid)
    if (!srcRow) continue
    if (srcRow.status === 'fixed') {
      process.stderr.write(`[cycle2] merge rejected: source is fixed (id=${sid})\n`)
      continue
    }
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

// ─── phase_merge: cosine-similarity dedup pass (unchanged) ───────────────────

function _bufToVec(raw) {
  if (!raw || raw.length === 0) return null
  const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw.buffer ?? raw)
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const n = u8.byteLength / 4
  const v = new Float32Array(n)
  for (let i = 0; i < n; i++) v[i] = view.getFloat32(i * 4, true)
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(v[i])) {
      process.stderr.write(`[cycle2] phase_merge skipping non-finite embedding\n`)
      return null
    }
  }
  return v
}

function _cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, ma = 0, mb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i] }
  const denom = Math.sqrt(ma) * Math.sqrt(mb)
  return denom === 0 ? 0 : dot / denom
}

function _pickKeeper(a, b) {
  // Prefer 'fixed' over 'active' so user-injected entries always win merge.
  if (a.status === 'fixed' && b.status !== 'fixed') return a
  if (b.status === 'fixed' && a.status !== 'fixed') return b
  if ((a.score ?? 0) !== (b.score ?? 0)) return (a.score ?? 0) > (b.score ?? 0) ? a : b
  if ((a.last_seen_at ?? 0) !== (b.last_seen_at ?? 0)) return (a.last_seen_at ?? 0) > (b.last_seen_at ?? 0) ? a : b
  return a.id < b.id ? a : b
}

async function _llmJudgePair(summaryA, summaryB) {
  const prompt =
    `Two memory entries below. Are they restating the same principle? Reply ONE WORD: merge or distinct.\n\nA: ${summaryA}\nB: ${summaryB}`
  try {
    const raw = await callBridgeLlm({
      role: 'cycle2-agent',
      taskType: 'maintenance',
      mode: 'cycle2-phase_merge_judge',
      preset: 'HAIKU',
      timeout: 30000,
      cwd: null,
    }, prompt)
    return String(raw ?? '').trim().toLowerCase().startsWith('merge')
  } catch (err) {
    process.stderr.write(`[cycle2] phase_merge llm-judge error: ${err.message}\n`)
    return false
  }
}

export async function runPhaseMerge(db, options = {}) {
  const rows = db.prepare(
    `SELECT id, category, summary, score, last_seen_at, status, embedding
     FROM entries WHERE is_root = 1 AND status IN ('active','fixed') AND embedding IS NOT NULL
     ORDER BY score DESC, last_seen_at DESC, id ASC`,
  ).all()

  if (rows.length < 2) return { merged: 0, llm_calls: 0, tier1_pairs: 0, tier2_pairs: 0 }

  const vecs = rows.map(r => ({ ...r, vec: _bufToVec(r.embedding) }))

  const tier1Pairs = []
  const tier2Pairs = []

  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const a = vecs[i], b = vecs[j]
      if (a.category !== b.category) continue
      // Both fixed? Skip — user-injected entries don't auto-merge.
      if (a.status === 'fixed' && b.status === 'fixed') continue
      const sim = _cosineSim(a.vec, b.vec)
      if (sim >= TIER1_THRESHOLD) tier1Pairs.push({ a, b, sim })
      else if (sim >= TIER2_LOW) tier2Pairs.push({ a, b, sim })
    }
  }

  tier2Pairs.sort((x, y) => y.sim - x.sim)

  let merged = 0
  let llmCalls = 0
  const mergedIds = new Set()

  const doMerge = (a, b, sim) => {
    if (mergedIds.has(a.id) || mergedIds.has(b.id)) return
    const keeper = _pickKeeper(a, b)
    const loser = keeper.id === a.id ? b : a
    if (loser.status === 'fixed') return  // never archive a fixed loser
    const moved = applyMerge(db, keeper.id, [loser.id])
    if (moved > 0) {
      merged += moved
      mergedIds.add(loser.id)
      process.stderr.write(
        `[cycle2] phase_merge merged id=${loser.id} -> keeper=${keeper.id} category=${keeper.category} sim=${typeof sim === 'number' ? sim.toFixed(3) : '?'}\n`,
      )
    }
  }

  for (const pair of tier1Pairs) doMerge(pair.a, pair.b, pair.sim)

  for (const pair of tier2Pairs) {
    if (llmCalls >= LLM_JUDGE_CAP) break
    if (mergedIds.has(pair.a.id) || mergedIds.has(pair.b.id)) continue
    llmCalls++
    const shouldMerge = await _llmJudgePair(
      String(pair.a.summary ?? '').slice(0, 400),
      String(pair.b.summary ?? '').slice(0, 400),
    )
    if (shouldMerge) doMerge(pair.a, pair.b, pair.sim)
  }

  process.stderr.write(
    `[cycle2] phase_merge tier1_pairs=${tier1Pairs.length} tier2_pairs=${tier2Pairs.length}` +
    ` llm_calls=${llmCalls} merged=${merged}\n`,
  )

  return { merged, llm_calls: llmCalls, tier1_pairs: tier1Pairs.length, tier2_pairs: tier2Pairs.length }
}

// ─── Current rules digest cache ──────────────────────────────────────────────

let _currentRulesDigest = null
let _currentRulesDigestTs = 0
function loadCurrentRulesDigest() {
  const now = Date.now()
  if (_currentRulesDigest && now - _currentRulesDigestTs < 60_000) return _currentRulesDigest
  const sources = [
    join(_homedir(), '.claude', 'CLAUDE.md'),
    join(resourceDir(), 'rules', 'shared', '00-language.md'),
    join(resourceDir(), 'rules', 'shared', '01-general.md'),
    join(resourceDir(), 'rules', 'shared', '01-tool.md'),
    join(resourceDir(), 'rules', 'shared', '04-memory.md'),
    join(resourceDir(), 'rules', 'shared', '06-team.md'),
    join(resourceDir(), 'rules', 'shared', '07-workflow.md'),
  ]
  const parts = []
  for (const p of sources) {
    try {
      if (!existsSync(p)) continue
      const txt = readFileSync(p, 'utf8').trim()
      if (txt) parts.push(`# Source: ${p}\n${txt}`)
    } catch {}
  }
  const joined = parts.join('\n\n---\n\n')
  const CAP = 12_000
  _currentRulesDigest = joined.length > CAP ? joined.slice(0, CAP) + '\n…[truncated]' : joined
  _currentRulesDigestTs = now
  return _currentRulesDigest
}

// ─── Unified gate ────────────────────────────────────────────────────────────

// Single LLM pass over rows whose status is in {pending, active, fixed}.
// Returns { actions, rejected, parseOk } following parseUnifiedFormat shape.
export async function runUnifiedGate(db, rows, activeContext, config = {}, options = {}) {
  if (!rows || rows.length === 0) return { actions: [], rejected: new Set(), parseOk: true }
  const promptPath = join(resourceDir(), 'defaults', 'memory-promote-prompt.md')
  if (!existsSync(promptPath)) {
    throw new Error(`runCycle2: prompt file missing at ${promptPath}`)
  }
  const template = readFileSync(promptPath, 'utf8')
  const sharedPidMap = buildPidMap([activeContext ?? [], rows ?? []])
  const rulesDigest = loadCurrentRulesDigest() || '(no current rules digest available)'
  const activeCount = activeContext?.length ?? 0
  const activeCap = options.activeCap ?? CYCLE2_ACTIVE_TARGET_CAP

  const prompt = template
    .replace('{{CURRENT_RULES}}', rulesDigest)
    .replace('{{CORE_MEMORY}}', formatEntriesForPromotePrompt(activeContext, sharedPidMap))
    .replace('{{ITEMS}}', formatEntriesForPromotePrompt(rows, sharedPidMap))
    .replace('{{ACTIVE_COUNT}}', String(activeCount))
    .replace('{{ACTIVE_CAP}}', String(activeCap))

  const preset = options.preset || resolveMaintenancePreset('cycle2')
  const timeout = Number(config?.cycle2?.timeout ?? 600000)
  const mode = 'cycle2-unified'

  const previewRaw = (raw) => String(raw ?? '').replace(/\s+/g, ' ').slice(0, 200)
  const callOnce = async (extraTag) => {
    const p = extraTag ? `${prompt}\n\n[retry:${extraTag}]` : prompt
    return await invokeLlm(p, mode, preset, timeout)
  }

  const statusById = new Map(rows.map(r => [Number(r.id), String(r.status)]))

  process.stderr.write(`[cycle2-diag] unified prompt=${prompt.length} bytes; rows=${rows.length}\n`)

  let raw
  try {
    raw = await callOnce(null)
  } catch (err) {
    process.stderr.write(`[cycle2] unified LLM error: ${err.message}\n`)
    return { actions: null, rejected: new Set(), parseOk: false }
  }
  process.stderr.write(`[cycle2-diag] unified raw (first 1500): ${String(raw ?? '').replace(/\n/g, '⏎').slice(0, 1500)}\n`)

  let parsed = parseUnifiedFormat(raw, statusById)
  if (!parsed) {
    process.stderr.write(`[cycle2] unparseable response, retrying once (${previewRaw(raw)})\n`)
    try {
      const raw2 = await callOnce('json-only')
      parsed = parseUnifiedFormat(raw2, statusById)
      if (!parsed) {
        process.stderr.write(`[cycle2] unparseable after retry — skipping batch (${previewRaw(raw2)})\n`)
        return { actions: null, rejected: new Set(), parseOk: false }
      }
    } catch (err) {
      process.stderr.write(`[cycle2] retry LLM error: ${err.message}\n`)
      return { actions: null, rejected: new Set(), parseOk: false }
    }
  }
  return { actions: parsed.actions, rejected: parsed.rejected, parseOk: true }
}

// ─── Sonnet cascade ──────────────────────────────────────────────────────────

// Sonnet re-judge over first-pass keep verdicts. Sonnet sees rules + summary
// and returns binary keep/drop. Failures fail-open (preserve first-pass).
async function sonnetCascade(candidates, rulesDigest, options = {}) {
  if (!candidates || candidates.length === 0) return new Map()
  const lines = candidates.map(c =>
    `id:${c.id} status:${c.status} verb:${c.verb} cat:${c.category} el:${c.element} sm:${String(c.summary || '').slice(0, 200)}`,
  ).join('\n')
  const prompt = [
    `Final gate over first-pass keep verdicts.`,
    `Verify each candidate is a DURABLE INVARIANT (identity / preference / principle / policy)`,
    `or a PROJECT-ESSENTIAL PROCESS — and NOT a temporary judgment, work artifact, narrative,`,
    `static fact, or duplicate of source-of-truth rules.`,
    ``,
    `Source-of-truth rules (excerpt — DO NOT duplicate in memory):`,
    String(rulesDigest || '').slice(0, 4000),
    ``,
    `Candidates:`,
    lines,
    ``,
    `Reply one line per id: "<id>|keep" to retain, "<id>|drop" to reject.`,
    `NO prose, NO preamble, NO meta-commentary. First character must be a digit.`,
  ].join('\n')

  // Hardcoded — resolveMaintenancePreset falls back to first preset (HAIKU)
  // when no binding exists, which would defeat the cascade. SONNET HIGH
  // matches the worker pool's default preset id from agent-config.
  const preset = options.cascadePreset || 'SONNET HIGH'
  let raw
  try {
    raw = await callBridgeLlm({
      role: 'cycle2-agent',
      taskType: 'maintenance',
      mode: 'cycle2-cascade',
      preset,
      timeout: 600000,
      cwd: null,
    }, prompt)
  } catch (err) {
    process.stderr.write(`[cycle2] cascade error: ${err.message} — fail-open\n`)
    return new Map()
  }

  const verdicts = new Map()
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('```')) continue
    const parts = trimmed.split('|')
    if (parts.length < 2) continue
    const id = Number(parts[0].trim())
    const v = parts[1].trim().toLowerCase()
    if (Number.isFinite(id) && (v === 'keep' || v === 'drop')) verdicts.set(id, v)
  }
  process.stderr.write(`[cycle2] cascade evaluated=${candidates.length} drops=${[...verdicts.values()].filter(v => v === 'drop').length}\n`)
  return verdicts
}

// ─── runCycle2 ───────────────────────────────────────────────────────────────

const _runCycle2InFlight = new WeakMap()

export async function runCycle2(db, config = {}, options = {}) {
  if (_runCycle2InFlight.has(db)) {
    process.stderr.write('[cycle2] skipped: already in flight for this db\n')
    return {
      promoted: 0, archived: 0, demoted: 0, merged: 0,
      updated: 0, kept: 0, fixed_kept: 0, rejected_verb: 0,
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
  const activeTargetCap = Number.isFinite(Number(config.active_target_cap))
    ? Math.max(1, Number(config.active_target_cap))
    : CYCLE2_ACTIVE_TARGET_CAP
  const nowMs = Date.now()

  const stats = {
    promoted: 0, archived: 0, demoted: 0, merged: 0,
    updated: 0, kept: 0, fixed_kept: 0, rejected_verb: 0,
    rescore: { updated: 0 },
    phase_merge: { merged: 0, llm_calls: 0, tier1_pairs: 0, tier2_pairs: 0 },
    phase4: { archived: 0 },
    cascade: { evaluated: 0, dropped: 0 },
  }

  // Re-score sweep: recompute score for active entries with current weighting.
  const activeForRescore = db.prepare(
    `SELECT id, category, last_seen_at FROM entries WHERE is_root = 1 AND status = 'active'`,
  ).all()
  if (activeForRescore.length > 0) {
    const rescoreUpdate = db.prepare(`UPDATE entries SET score = ? WHERE id = ?`)
    db.transaction(() => {
      for (const r of activeForRescore) {
        const newScore = computeEntryScore(r.category, r.last_seen_at ?? nowMs, nowMs)
        if (Number.isFinite(newScore)) {
          try { rescoreUpdate.run(newScore, r.id); stats.rescore.updated += 1 } catch {}
        }
      }
    })()
  }

  // Unified candidate selection: pending/active/fixed by reviewed_at rotation.
  // Pending sorts first so freshly extracted chunks reach evaluation quickly.
  const rows = db.prepare(`
    SELECT id, element, category, summary, score, last_seen_at, project_id, status
    FROM entries
    WHERE is_root = 1 AND status IN ('pending','active','fixed')
    ORDER BY
      CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 WHEN 'fixed' THEN 2 END ASC,
      reviewed_at ASC,
      error_count ASC,
      score ASC,
      id ASC
    LIMIT ?
  `).all(batchSize)

  // Active+fixed snapshot for prompt context (do-not-duplicate reference).
  const activeContext = db.prepare(`
    SELECT id, element, category, summary, score, last_seen_at, project_id, status
    FROM entries
    WHERE is_root = 1 AND status IN ('active', 'fixed')
    ORDER BY score DESC, last_seen_at DESC, id ASC
    LIMIT 100
  `).all()

  const gateResult = rows.length > 0
    ? await runUnifiedGate(db, rows, activeContext, config, { activeCap: activeTargetCap, preset: options.preset })
    : { actions: [], rejected: new Set(), parseOk: true }

  const touchReviewed = db.prepare(`UPDATE entries SET reviewed_at = ? WHERE id = ?`)
  const bumpErrorCount = db.prepare(`UPDATE entries SET error_count = COALESCE(error_count, 0) + 1 WHERE id = ?`)
  const archiveStmt = db.prepare(`UPDATE entries SET status = 'archived' WHERE id = ? AND is_root = 1`)
  const sweepCursor = nowMs

  const rowsById = new Map(rows.map(r => [Number(r.id), r]))

  // Cascade pre-pass: pull first-pass keeps (verb 'active' from pending/active,
  // or 'fixed' from fixed) into Sonnet for re-judge. update/merge/archived skip.
  const cascadeCandidates = []
  if (gateResult.actions) {
    for (const a of gateResult.actions) {
      if (a.action !== 'active' && a.action !== 'fixed') continue
      const row = rowsById.get(Number(a.entry_id))
      if (!row) continue
      cascadeCandidates.push({
        id: row.id, status: row.status, verb: a.action,
        category: row.category, element: row.element, summary: row.summary,
      })
    }
  }

  const rulesDigest = loadCurrentRulesDigest() || ''
  let cascadeVerdicts = new Map()
  if (cascadeCandidates.length > 0) {
    cascadeVerdicts = await sonnetCascade(cascadeCandidates, rulesDigest, options)
    stats.cascade.evaluated = cascadeCandidates.length
  }

  // Apply actions.
  if (gateResult.actions) {
    for (const a of gateResult.actions) {
      const id = Number(a.entry_id)
      if (!Number.isFinite(id)) continue
      const row = rowsById.get(id)
      if (!row) continue

      try {
        // Cascade override: drop a tentatively-kept entry → archive (unless fixed).
        if ((a.action === 'active' || a.action === 'fixed') && cascadeVerdicts.get(id) === 'drop') {
          if (row.status === 'fixed') {
            // 'fixed' is sacrosanct — Sonnet's drop is advisory only.
            stats.fixed_kept += 1
          } else {
            if (archiveStmt.run(id).changes > 0) {
              stats.archived += 1
              stats.cascade.dropped += 1
            }
          }
          touchReviewed.run(sweepCursor, id)
          continue
        }

        if (a.action === 'active') {
          if (row.status === 'pending') {
            if (applyPromoteFromPending(db, id, nowMs)) stats.promoted += 1
          } else if (row.status === 'active') {
            stats.kept += 1
          }
        } else if (a.action === 'fixed') {
          stats.fixed_kept += 1
        } else if (a.action === 'archived') {
          if (archiveStmt.run(id).changes > 0) stats.archived += 1
        } else if (a.action === 'demote') {
          // Unified design has no demoted state; treat as archived.
          if (archiveStmt.run(id).changes > 0) stats.demoted += 1
        } else if (a.action === 'update') {
          if (await applyUpdate(db, id, a.element, a.summary)) stats.updated += 1
        } else if (a.action === 'merge') {
          const sourceIds = Array.isArray(a.source_ids) ? a.source_ids : []
          const targetId = Number(a.target_id)
          if (!Number.isFinite(targetId)) continue
          const moved = applyMerge(db, targetId, sourceIds)
          if (moved > 0) {
            stats.merged += moved
            if (typeof a.element === 'string' || typeof a.summary === 'string') {
              try { if (await applyUpdate(db, targetId, a.element, a.summary)) stats.updated += 1 }
              catch (err) {
                process.stderr.write(`[cycle2] merge target update failed (target=${targetId}): ${err.message}\n`)
              }
            }
          }
        }
        touchReviewed.run(sweepCursor, id)
      } catch (err) {
        process.stderr.write(`[cycle2] action error (id=${id}): ${err.message}\n`)
      }
    }
  } else if (rows.length > 0) {
    // Parse failure — bump error_count, do not advance reviewed_at.
    for (const r of rows) {
      try { bumpErrorCount.run(r.id) } catch {}
    }
  }

  // Rejected verb rows: advance reviewed_at + bump error_count so an all-reject
  // batch does not loop forever. error_count ASC sort pushes them to the back.
  if (gateResult.rejected && gateResult.rejected.size > 0) {
    stats.rejected_verb = gateResult.rejected.size
    for (const id of gateResult.rejected) {
      try { touchReviewed.run(sweepCursor, id); bumpErrorCount.run(id) } catch {}
    }
  }

  // phase_merge: cosine dedup over active+fixed (fixed never archived).
  const phaseMergeStats = await runPhaseMerge(db, options)
  stats.phase_merge = phaseMergeStats

  // phase4 hard cap: archive lowest-priority active rows over target.
  // 'fixed' rows are excluded from victim selection (cap counts only active).
  const activeCountBeforeP4 = (db.prepare(
    `SELECT COUNT(*) AS n FROM entries WHERE is_root = 1 AND status = 'active'`,
  ).get())?.n ?? 0
  if (activeCountBeforeP4 > activeTargetCap) {
    const overflow = activeCountBeforeP4 - activeTargetCap
    process.stderr.write(
      `[cycle2] phase4 active_cap_enforce: active=${activeCountBeforeP4} target=${activeTargetCap} overflow=${overflow}\n`,
    )
    const victims = db.prepare(`
      SELECT id FROM entries WHERE is_root = 1 AND status = 'active'
      ORDER BY last_seen_at ASC, score ASC, id ASC LIMIT ?
    `).all(overflow)
    for (const v of victims) {
      try {
        if (archiveStmt.run(v.id).changes > 0) stats.phase4.archived += 1
      } catch (err) {
        process.stderr.write(`[cycle2] phase4 archive failed (id=${v.id}): ${err.message}\n`)
      }
    }
  }

  // Async embedding flush (fire-and-forget).
  void flushEmbeddingDirty(db).then(d => {
    if (d.attempted > 0) {
      process.stderr.write(
        `[cycle2] embedding flush (async) attempted=${d.attempted} ok=${d.succeeded} failed=${d.failed.length}\n`,
      )
    }
  }).catch(err => {
    process.stderr.write(`[cycle2] embedding flush (async) failed: ${err.message}\n`)
  })

  process.stderr.write(
    `[cycle2] rescore=${stats.rescore.updated}` +
    ` | gate promoted=${stats.promoted} archived=${stats.archived} demoted=${stats.demoted}` +
    ` updated=${stats.updated} kept=${stats.kept} fixed_kept=${stats.fixed_kept}` +
    ` rejected_verb=${stats.rejected_verb}` +
    ` | cascade eval=${stats.cascade.evaluated} drop=${stats.cascade.dropped}` +
    ` | phase_merge merged=${stats.phase_merge.merged} llm=${stats.phase_merge.llm_calls}` +
    ` | phase4 archived=${stats.phase4.archived}\n`,
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
