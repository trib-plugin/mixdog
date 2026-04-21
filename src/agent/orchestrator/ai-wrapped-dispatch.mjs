/**
 * ai-wrapped-dispatch — dispatch hub for `recall` / `search` / `explore`.
 *
 * All three MCP tools flagged `aiWrapped: true` in tools.json route here
 * instead of the direct module handler. Each query spawns its own Pool C
 * agent session and runs concurrently via Promise.allSettled, so wall-clock
 * latency is bound by the slowest query rather than the sum. A single query
 * spawns a single agent, so the per-array cost scales linearly with query
 * count. Shared Pool B/C cache shards mean only the first concurrent agent
 * pays the cold-write; peers ride the warm prefix.
 *
 * Dispatch completion pushes into the caller's session via the existing
 * `notifications/claude/channel` bridge. The notify meta carries
 * `type: 'dispatch_result'` plus an `instruction` string so the Lead
 * integrates the answer on its next turn automatically.
 */

import { homedir } from 'os'
import { resolve as resolvePath, isAbsolute, join } from 'path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { loadConfig, getPluginData } from './config.mjs'
import { resolvePresetName } from './smart-bridge/bridge-llm.mjs'
import { smartReadTruncate } from './tools/builtin.mjs'
import { addPending, removePending } from './dispatch-persist.mjs'
import { notifyActivity } from './activity-bus.mjs'

const ROLE_BY_TOOL = Object.freeze({
  recall:  { role: 'recall-agent',  build: buildRecallPrompt,   label: 'recall-agent' },
  search:  { role: 'search-agent',  build: buildSearchPrompt,   label: 'search-agent' },
  explore: { role: 'explorer',      build: buildExplorerPrompt, label: 'explorer agent' },
})

// Background dispatch registry. Entries live in-memory for the plugin server
// process lifetime — the merged answer is auto-pushed via the channel,
// and the registry is kept around for observability only. Pruned
// opportunistically to keep the map bounded.
const _dispatchResults = new Map() // id → { status, role, tool, queries, createdAt, completedAt?, content?, error? }
const DISPATCH_RESULT_MAX_ENTRIES = 200
const DISPATCH_RESULT_TTL_MS = 30 * 60_000 // 30 minutes — enough for the Lead to loop back, short enough to not hoard memory
const QUERY_RESULT_CACHE_MAX_ENTRIES = 256
const QUERY_RESULT_CACHE_TTLS_MS = Object.freeze({
  recall: 60_000,
  explore: 60_000,
  search: 30_000,
})
const _queryResultCache = new Map() // key → { ts, content }
const _queryInflight = new Map() // key → Promise<string>
const QUERY_CACHE_DISK_FILE = 'aiwrapped-query-cache.json'
const QUERY_CACHE_DISK_MAX_CONTENT_CHARS = 64 * 1024
let _diskCacheLoaded = false
let _cacheFlushTimer = null

function cacheTtlMs(tool) {
  return QUERY_RESULT_CACHE_TTLS_MS[tool] || 30_000
}

function normalizeQueryForCache(query) {
  return String(query || '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[，、]/g, ',')
    .replace(/[。]/g, '.')
    .replace(/[？]/g, '?')
    .replace(/[！]/g, '!')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildQueryCacheKey(tool, query, cwd, brief) {
  return [
    tool,
    brief === false ? 'full' : 'brief',
    cwd || '',
    normalizeQueryForCache(query),
  ].join('|')
}

function getDiskCachePath() {
  return join(getPluginData(), QUERY_CACHE_DISK_FILE)
}

function ensureDiskCacheLoaded(now = Date.now()) {
  if (_diskCacheLoaded) return
  _diskCacheLoaded = true
  try {
    const path = getDiskCachePath()
    if (!existsSync(path)) return
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (!raw || typeof raw !== 'object') return
    for (const [key, entry] of Object.entries(raw)) {
      if (!entry || typeof entry !== 'object') continue
      const ts = Number(entry.ts || 0)
      const content = typeof entry.content === 'string' ? entry.content : null
      if (!content || !Number.isFinite(ts)) continue
      const tool = key.split('|', 1)[0]
      if (now - ts > cacheTtlMs(tool)) continue
      _queryResultCache.set(key, { ts, content })
    }
    pruneQueryCaches(now)
  } catch {
    // Best-effort cache load — ignore corrupt or missing files.
  }
}

function scheduleDiskCacheFlush() {
  if (_cacheFlushTimer) return
  _cacheFlushTimer = setTimeout(() => {
    _cacheFlushTimer = null
    try {
      const path = getDiskCachePath()
      mkdirSync(getPluginData(), { recursive: true })
      const payload = {}
      const now = Date.now()
      for (const [key, entry] of _queryResultCache) {
        const tool = key.split('|', 1)[0]
        if (!entry?.content || now - (entry.ts || 0) > cacheTtlMs(tool)) continue
        payload[key] = {
          ts: entry.ts,
          content: entry.content.slice(0, QUERY_CACHE_DISK_MAX_CONTENT_CHARS),
        }
      }
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(payload), 'utf-8')
      renameSync(tmp, path)
    } catch {
      // Best-effort only — never let cache persistence affect dispatch.
    }
  }, 250)
  if (typeof _cacheFlushTimer.unref === 'function') _cacheFlushTimer.unref()
}

function resetQueryCachesForTesting() {
  _queryResultCache.clear()
  _queryInflight.clear()
  _diskCacheLoaded = false
  if (_cacheFlushTimer) {
    clearTimeout(_cacheFlushTimer)
    _cacheFlushTimer = null
  }
}

function pruneQueryCaches(now = Date.now()) {
  for (const [key, entry] of _queryResultCache) {
    const tool = key.split('|', 1)[0]
    if (now - (entry?.ts || 0) > cacheTtlMs(tool)) {
      _queryResultCache.delete(key)
    }
  }
  while (_queryResultCache.size > QUERY_RESULT_CACHE_MAX_ENTRIES) {
    const oldest = _queryResultCache.keys().next().value
    if (!oldest) break
    _queryResultCache.delete(oldest)
  }
  scheduleDiskCacheFlush()
}

function getCachedQueryResult(tool, key, now = Date.now()) {
  ensureDiskCacheLoaded(now)
  const entry = _queryResultCache.get(key)
  if (!entry) return null
  if (now - entry.ts > cacheTtlMs(tool)) {
    _queryResultCache.delete(key)
    scheduleDiskCacheFlush()
    return null
  }
  return entry.content
}

async function runCachedQuery(tool, key, runner) {
  ensureDiskCacheLoaded()
  pruneQueryCaches()
  const cached = getCachedQueryResult(tool, key)
  if (cached !== null) return cached
  const inflight = _queryInflight.get(key)
  if (inflight) return inflight
  const p = Promise.resolve()
    .then(runner)
    .then((content) => {
      _queryResultCache.set(key, { ts: Date.now(), content })
      _queryInflight.delete(key)
      pruneQueryCaches()
      scheduleDiskCacheFlush()
      return content
    })
    .catch((err) => {
      _queryInflight.delete(key)
      throw err
    })
  _queryInflight.set(key, p)
  return p
}

function _pruneDispatchResults() {
  if (_dispatchResults.size < DISPATCH_RESULT_MAX_ENTRIES) return
  const now = Date.now()
  for (const [id, entry] of _dispatchResults) {
    const age = now - (entry.completedAt || entry.createdAt || now)
    if (entry.status !== 'running' && age > DISPATCH_RESULT_TTL_MS) _dispatchResults.delete(id)
  }
  if (_dispatchResults.size >= DISPATCH_RESULT_MAX_ENTRIES) {
    // Still full — evict the oldest regardless of status.
    const oldest = _dispatchResults.keys().next().value
    if (oldest) _dispatchResults.delete(oldest)
  }
}

export function getDispatchResult(id) {
  if (!id) return null
  return _dispatchResults.get(String(id)) || null
}

export async function dispatchAiWrapped(name, args, ctx) {
  const rawQuery = args.query
  if (rawQuery == null) return fail('query is required')
  const queries = Array.isArray(rawQuery) ? rawQuery : [rawQuery]
  if (queries.length === 0) return fail('query cannot be empty')

  const spec = ROLE_BY_TOOL[name]
  if (!spec) throw new Error(`Unknown aiWrapped tool: ${name}`)

  // Recursion break — the tool schema stays full across every session so
  // that all roles share one cache shard. The counterweight lives here:
  // when a hidden-role session (recall-agent / search-agent / explorer /
  // cycle1 / cycle2) calls back into an aiWrapped dispatcher, we reject
  // the call at runtime. Without this, `recall` inside a recall-agent turn
  // would spawn another recall-agent session and fan out forever.
  if (ctx?.callerSessionId) {
    try {
      const { loadSession } = await import('./session/store.mjs')
      const { isHiddenRole } = await import('./internal-roles.mjs')
      const caller = loadSession(ctx.callerSessionId)
      if (caller && isHiddenRole(caller.role)) {
        return fail(
          `"${name}" is blocked inside the "${caller.role}" hidden role (recursion break). `
          + `Use the direct executor (memory_search / web_search / read / grep / glob / multi_read) for your query.`,
        )
      }
    } catch {
      // Fail-open on introspection errors — one stray call beats a broken session.
    }
  }

  const { makeBridgeLlm } = await import('./smart-bridge/bridge-llm.mjs')

  // `brief` (default true) applies a ~3000-token cap to each sub-agent
  // answer before it rides back into the Lead context. Pass `brief:false`
  // when the caller explicitly wants the uncapped synthesis. See
  // bridge-llm.mjs::applyBriefCap for the cap shape.
  const brief = args.brief !== false;
  const resolvedCwd = resolveCwd(args.cwd)

  // Sync vs background. Lead (external MCP client, no callerSessionId)
  // defaults to background=true to avoid Claude Code's ~14s MCP request
  // timeout. Role sessions (callerSessionId set — worker / reviewer / ...)
  // default to background=false so the merged answer lands in the SAME
  // turn; otherwise a role can't use the result for its next step and
  // falls back to ad-hoc shell search (the bash_session loop failure).
  const background = typeof args.background === 'boolean'
    ? args.background
    : !ctx?.callerSessionId

  if (!background) {
    const settled = await Promise.allSettled(
      queries.map((q) => {
        const key = buildQueryCacheKey(name, q, resolvedCwd, brief)
        return runCachedQuery(name, key, async () => {
          const llm = makeBridgeLlm({ role: spec.role, cwd: resolvedCwd, brief })
          return llm({ prompt: spec.build(q, resolvedCwd) })
        })
      }),
    )
    const merged = queries.length === 1
      ? (settled[0].status === 'fulfilled'
          ? (settled[0].value || '(no response)')
          : `[${spec.label} error] ${settled[0].reason?.message || String(settled[0].reason)}`)
      : settled.map((r, i) => {
          const header = `### Query ${i + 1}: ${queries[i]}`
          if (r.status === 'fulfilled') return `${header}\n${r.value || '(no response)'}`
          return `${header}\n[${spec.label} error] ${r.reason?.message || String(r.reason)}`
        }).join('\n\n---\n\n')
    return ok(merged)
  }

  // Background dispatch path. The caller (Lead) gets an immediate handle;
  // sub-agents stream in the background and the merged answer is pushed
  // via the channel notification bridge.
  _pruneDispatchResults()
  const id = `dispatch_${name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  _dispatchResults.set(id, {
    status: 'running',
    tool: name,
    role: spec.role,
    queries,
    createdAt: Date.now(),
  })
  // Persist so a plugin restart mid-dispatch can emit a single Aborted
  // notification on next bootstrap instead of silently orphaning the handle.
  addPending(process.env.CLAUDE_PLUGIN_DATA, id, name, queries)
  // Starting a bridge dispatch counts as session activity — keeps
  // proactive chat suppressed while long-running work is in flight.
  notifyActivity()
  // Emit a channel notification mirroring the bridge worker UX — a short
  // "<tool> started" banner that lets both Lead and user terminal see the
  // lifecycle begin. Non-silent so the MCP notification reaches the terminal
  // (silent forwarding skips MCP and only hits the external channel IPC).
  // The merged result itself still arrives later via pushDispatchResult.
  if (typeof ctx?.notifyFn === 'function') {
    try { ctx.notifyFn(`${name} started`) } catch { /* best-effort */ }
  }
  Promise.allSettled(
    queries.map((q) => {
      const key = buildQueryCacheKey(name, q, resolvedCwd, brief)
      return runCachedQuery(name, key, async () => {
        const llm = makeBridgeLlm({ role: spec.role, cwd: resolvedCwd, brief })
        return llm({ prompt: spec.build(q, resolvedCwd) })
      })
    }),
  ).then((settled) => {
    const merged = queries.length === 1
      ? (settled[0].status === 'fulfilled'
          ? (settled[0].value || '(no response)')
          : `[${spec.label} error] ${settled[0].reason?.message || String(settled[0].reason)}`)
      : settled.map((r, i) => {
          const header = `### Query ${i + 1}: ${queries[i]}`
          if (r.status === 'fulfilled') return `${header}\n${r.value || '(no response)'}`
          return `${header}\n[${spec.label} error] ${r.reason?.message || String(r.reason)}`
        }).join('\n\n---\n\n')
    const entry = _dispatchResults.get(id)
    if (entry) {
      entry.status = 'done'
      entry.content = merged
      entry.completedAt = Date.now()
    }
    removePending(process.env.CLAUDE_PLUGIN_DATA, id)
    pushDispatchResult(ctx, id, name, queries, merged)
  }).catch((err) => {
    const msg = err?.message || String(err)
    const entry = _dispatchResults.get(id)
    if (entry) {
      entry.status = 'error'
      entry.error = msg
      entry.completedAt = Date.now()
    }
    removePending(process.env.CLAUDE_PLUGIN_DATA, id)
    pushDispatchResult(ctx, id, name, queries, `[${spec.label} dispatch error] ${msg}`, { error: true })
  })
  const queryCount = queries.length === 1 ? `1 query` : `${queries.length} queries`
  return ok(`${name} started — ${queryCount}. Merged answer will be auto-pushed via the channel (handle ${id}).`)
}

export const _internals = {
  buildQueryCacheKey,
  cacheTtlMs,
  getCachedQueryResult,
  normalizeQueryForCache,
  ensureDiskCacheLoaded,
  scheduleDiskCacheFlush,
  pruneQueryCaches,
  runCachedQuery,
  resetQueryCachesForTesting,
  _queryResultCache,
  _queryInflight,
}


function buildExplorerPrompt(query, cwd) {
  // cwd rides in the session's tier3Reminder (<system-reminder># cwd) via
  // bridge-llm's opts.cwd plumbing, but the inner explorer agent can still
  // drift to its launch workspace when the reminder is missed or
  // low-weighted — so we also pin the search root explicitly in the user
  // message body. Only emitted when the caller supplied an explicit cwd;
  // unspecified cwd keeps the original prompt prefix and preserves the
  // cache-shared shape with recall/search builders.
  const rootLine = cwd
    ? `Your authoritative search root is \`${cwd}\` — prefer this over your launch workspace. Scope all glob / grep / read / multi_read calls beneath this root unless the query itself names a different path.\n\n`
    : ''
  return `${rootLine}Query: ${query}

Use your read-only tools (\`glob\` / \`grep\` / \`read\` / \`multi_read\`) to find grounded answers.

Rules:
- Work in 2 rounds max: locate -> confirm. If round 2 already grounds the answer, stop and synthesize.
- When 2+ exact file paths are known, prefer one \`multi_read\` / array \`path\` call instead of serial reads.
- Do NOT use shell search or \`bash_session\` for navigation.
- If you catch yourself planning another \`grep -> read\` loop on the same topic, stop and answer from the evidence you already have.

Return concise prose with concrete file paths.`
}

function buildRecallPrompt(query, _cwd) {
  // cwd has no effect on memory_search semantics; second arg accepted for
  // builder signature uniformity (caller always passes resolvedCwd).
  return `Query: ${query}\n\nUse the \`memory_search\` tool to retrieve ranked entries. Return concise prose citing entry ids inline.`
}

function buildSearchPrompt(query, _cwd) {
  // cwd has no effect on web_search semantics; second arg accepted for
  // builder signature uniformity.
  return `Query: ${query}\n\nUse the \`web_search\` tool to retrieve ranked results. Return concise prose with cited URLs.`
}

/**
 * Resolve user-provided cwd: expand `~`, resolve relatives against the
 * launch workspace. Falls back to null so callers use process.cwd().
 */
function resolveCwd(input) {
  if (!input || typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed) return null
  const expanded = trimmed.startsWith('~')
    ? trimmed.replace(/^~/, homedir())
    : trimmed
  return isAbsolute(expanded) ? expanded : resolvePath(process.cwd(), expanded)
}

/**
 * Resolve a short model tag for the given hidden role, mirroring the
 * `modelTag` format that bridge/worker lifecycle notifications use in
 * src/agent/index.mjs (e.g. `3-5-sonnet`). Best-effort — returns an
 * empty string when the preset / config can't be resolved so the header
 * still renders (falls back to `[{tool}] Done.`).
 */
export function resolveAgentModelTag(role) {
  try {
    const presetName = resolvePresetName({ role })
    if (!presetName) return ''
    const config = loadConfig()
    const preset = config?.presets?.find((p) => p.id === presetName || p.name === presetName)
    const raw = preset?.model
    if (!raw || typeof raw !== 'string') return ''
    const stripped = raw.startsWith('claude-') ? raw.slice('claude-'.length) : raw
    return stripped || ''
  } catch {
    return ''
  }
}

/**
 * Build the `Done.` header that wraps async-result notifications, mirroring
 * the Pool B worker completion shape emitted in src/agent/index.mjs:
 *     [{model-tag}] [{role}] <content>
 * Dispatch re-uses the same pattern so the user sees a consistent
 * `Done.` header across bridge worker output and recall/search/explore
 * dispatch result delivery.
 *
 * When the model tag can't be resolved, falls back to `[{tool}] Done.`.
 * When the tool is empty (shouldn't happen), falls back to `Done.`.
 */
export function buildDispatchResultHeader(tool, modelTag) {
  const toolPart = tool ? `[${tool}] ` : ''
  const tagPart = modelTag ? `[${modelTag}] ` : ''
  return `${tagPart}${toolPart}Done.`
}

export function pushDispatchResult(ctx, id, tool, queries, body, flags = {}) {
  const notify = ctx?.notifyFn
  if (typeof notify !== 'function') return
  const queryCount = queries.length === 1
    ? `1 query`
    : `${queries.length} queries`
  const bodyHeader = flags.error
    ? `${tool} failed`
    : `${tool} — ${queryCount}`
  // v0.6.249 smart truncation — large recall/search/explore merged bodies
  // (multi-query fan-out) can blow past the 30 KB smart-read cap and waste
  // Lead context. Apply the same head/tail summariser used by `read` /
  // `multi_read` so Lead still sees the interesting frames (first queries
  // and final queries) without paying for the middle mass. Truncation acts
  // on the body only — the `Done.` header is prepended AFTER, so it never
  // gets cut.
  const bodyStr = typeof body === 'string' ? body : String(body ?? '')
  const bodyBytes = Buffer.byteLength(bodyStr, 'utf8')
  const bodyLines = bodyStr.length === 0 ? 0 : bodyStr.split('\n').length
  const { text: cappedBody } = smartReadTruncate(bodyStr, bodyLines, bodyBytes)
  const originalBody = `${bodyHeader}\n\n${cappedBody}`
  // v0.6.241: prepend a `Done.` wrapper that mirrors the Pool B worker
  // completion header in src/agent/index.mjs (`${modelTag}[${role}] ...`).
  // When the model tag can't be resolved, the helper falls back to
  // `[{tool}] Done.` — still better than no header.
  const spec = ROLE_BY_TOOL[tool]
  const modelTag = spec ? resolveAgentModelTag(spec.role) : ''
  const doneHeader = flags.error
    ? buildDispatchResultHeader(tool, modelTag).replace(/Done\.$/, 'Failed.')
    : buildDispatchResultHeader(tool, modelTag)
  const content = `${doneHeader}\n\n${originalBody}`
  try {
    Promise.resolve(
      notify(content, {
        type: 'dispatch_result',
        dispatch_id: id,
        tool,
        instruction: `The ${tool} dispatch you started earlier (${id}) has returned — use this answer in your next step.`,
      }),
    ).catch((err) => {
      try {
        process.stderr.write(`[ai-wrapped-dispatch] pushDispatchResult async failed: tool=${tool} id=${id} err=${err?.message ?? String(err)}\n`)
      } catch {}
    })
  } catch (err) {
    try { process.stderr.write(`[ai-wrapped-dispatch] pushDispatchResult failed: tool=${tool} id=${id} err=${err?.message ?? String(err)}\n`); } catch {}
  }
}

function ok(text) {
  return { content: [{ type: 'text', text }] }
}

function fail(msg) {
  return { content: [{ type: 'text', text: `[aiWrapped error] ${msg}` }], isError: true }
}
