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
import { executeBuiltinTool } from './tools/builtin.mjs'
import { executeCodeGraphTool } from './tools/code-graph.mjs'
import { addPending, removePending } from './dispatch-persist.mjs'
import { notifyActivity } from './activity-bus.mjs'

const ROLE_BY_TOOL = Object.freeze({
  recall:  { role: 'recall-agent',  build: buildRecallPrompt,   label: 'recall-agent' },
  search:  { role: 'search-agent',  build: buildSearchPrompt,   label: 'search-agent' },
  explore: { role: 'explorer',      build: buildExplorerPrompt, label: 'explorer agent' },
})

// Web search provider credentials live in search-config.json. When none of
// them are populated the downstream sub-agent spawns, burns tokens, and
// returns a polite "provider not configured" apology that the user can
// mistake for a real answer. Precheck here to fail the MCP call directly
// with guidance instead. Runs only for `search` — `recall`/`explore` need
// no external credentials.
function searchProviderKeysMissing() {
  try {
    const path = join(getPluginData(), 'search-config.json')
    if (!existsSync(path)) return true
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const creds = raw?.rawSearch?.credentials || {}
    for (const entry of Object.values(creds)) {
      if (!entry || typeof entry !== 'object') continue
      const v = entry.apiKey ?? entry.token ?? ''
      if (typeof v === 'string' && v.trim().length > 0) return false
    }
    return true
  } catch {
    // On read/parse failure treat as missing so the user is told to fix it
    // rather than silently spawning an agent that will also fail.
    return true
  }
}

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

const GITHUB_OWNER_PART = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?'
const GITHUB_REPO_PART = '[A-Za-z0-9._-]+'
const GITHUB_REPO_URL_RE = new RegExp(`(?:https?:\\/\\/)?(?:www\\.)?github\\.com\\/(${GITHUB_OWNER_PART})\\/(${GITHUB_REPO_PART})(?=$|[\\/#?\\s])`, 'i')
const GITHUB_REPO_EXACT_RE = new RegExp(`^\\s*(${GITHUB_OWNER_PART})\\/(${GITHUB_REPO_PART})\\s*$`, 'i')
const GITHUB_REPO_EMBEDDED_RE = new RegExp(`(?:^|[^\\w.-])(${GITHUB_OWNER_PART})\\/(${GITHUB_REPO_PART})(?=$|[^\\w.-])`, 'i')
const FILE_EXT_RE = /\.[a-z0-9]{1,6}$/i

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

function normalizeGithubRepoName(repo) {
  return String(repo || '')
    .replace(/\.git$/i, '')
    .replace(/[.,;:!?)]$/g, '')
}

function githubRepoTarget(owner, repo) {
  const cleanOwner = String(owner || '').trim()
  const cleanRepo = normalizeGithubRepoName(repo).trim()
  if (!cleanOwner || !cleanRepo) return null
  if (cleanOwner.includes('.') || cleanRepo.includes('/')) return null
  if (FILE_EXT_RE.test(cleanRepo)) return null
  return { owner: cleanOwner, repo: cleanRepo }
}

function extractGithubRepoReadTarget(query) {
  const text = String(query || '').trim()
  if (!text) return null

  const urlMatch = text.match(GITHUB_REPO_URL_RE)
  if (urlMatch) return githubRepoTarget(urlMatch[1], urlMatch[2])

  const exactMatch = text.match(GITHUB_REPO_EXACT_RE)
  if (exactMatch) return githubRepoTarget(exactMatch[1], exactMatch[2])

  if (!/\b(?:github|repo|repository)\b/i.test(text)) return null
  const embeddedMatch = text.match(GITHUB_REPO_EMBEDDED_RE)
  return embeddedMatch ? githubRepoTarget(embeddedMatch[1], embeddedMatch[2]) : null
}

function extractIdentifierCandidate(query) {
  const text = String(query || '')
  const backticked = text.match(/`([^`]{2,120})`/)
  if (backticked?.[1] && /^[A-Za-z_][A-Za-z0-9_]{1,}$/.test(backticked[1].trim())) {
    return backticked[1].trim()
  }
  const STOPWORDS = new Set([
    'Where', 'What', 'Which', 'Find', 'Return', 'Summarize', 'Read',
    'Use', 'Your', 'This', 'That', 'These', 'Those', 'The', 'A', 'An',
    'How', 'Why', 'When', 'Who',
  ])
  const candidates = text.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) || []
  let best = null
  let bestScore = -Infinity
  for (const token of candidates) {
    if (STOPWORDS.has(token)) continue
    let score = 0
    if (/^[A-Z][A-Z0-9_]+$/.test(token)) score += 10
    if (/^[a-z]+(?:[A-Z][A-Za-z0-9]*)+$/.test(token)) score += 7
    if (/^[A-Z][A-Za-z0-9]*_[A-Za-z0-9_]+$/.test(token)) score += 8
    if (/^[A-Z][a-z]+$/.test(token)) score -= 4
    score += Math.min(token.length, 24) / 10
    if (score > bestScore) {
      best = token
      bestScore = score
    }
  }
  return best
}

function parseFindSymbolBestCandidate(rawText) {
  const lines = String(rawText || '').split('\n').map((line) => line.trim()).filter(Boolean)
  const marker = lines.indexOf('# best declaration candidate')
  if (marker === -1 || marker + 2 >= lines.length) return null
  const loc = lines[marker + 1]
  const decl = lines[marker + 2]
  const match = loc.match(/^(.+?):(\d+):(\d+)\s+\(([^,]+),/)
  if (!match) return null
  const [, filePath, lineStr, colStr, lang] = match
  const contextLine = lines.find((line, idx) => idx > marker + 2 && line.startsWith('context:'))
  return {
    filePath,
    line: Number(lineStr),
    col: Number(colStr),
    lang,
    declaration: decl,
    context: contextLine ? contextLine.replace(/^context:\s*/, '') : '',
  }
}

function summarizeDeclarationShape(identifier, declaration) {
  const line = String(declaration || '')
  if (/\bObject\.freeze\(\[/.test(line)) return `${identifier} starts a frozen array definition.`
  if (/\bObject\.freeze\(\{/.test(line)) return `${identifier} starts a frozen object definition.`
  if (/\bexport\s+const\b/.test(line)) return `${identifier} is exported as a constant.`
  if (/\bconst\b/.test(line)) return `${identifier} is defined as a constant.`
  if (/\bfunction\b/.test(line)) return `${identifier} is defined as a function.`
  if (/\bclass\b/.test(line)) return `${identifier} is defined as a class.`
  if (/\binterface\b/.test(line)) return `${identifier} is defined as an interface.`
  if (/\btype\b/.test(line)) return `${identifier} is defined as a type alias.`
  return `${identifier} is defined here.`
}

function parseGrepBestCandidate(rawText) {
  const lines = String(rawText || '').split('\n').map((line) => line.trim()).filter(Boolean)
  const topHeader = lines.indexOf('# top candidates')
  if (topHeader !== -1) {
    const candidate = lines[topHeader + 1]
    const m = candidate?.match(/^\d+\.\s+(.+?):(\d+)\s+\[(decl|hit)\]\s+(.+)$/)
    if (m) {
      return { filePath: m[1], line: Number(m[2]), kind: m[3], content: m[4] }
    }
  }
  for (const line of lines) {
    const m = line.match(/^(.+?):(\d+):(.+)$/)
    if (!m) continue
    return { filePath: m[1], line: Number(m[2]), kind: 'hit', content: m[3].trim() }
  }
  return null
}

function parseNumberedReadLines(rawText) {
  return String(rawText || '').split('\n')
    .map((line) => {
      const m = line.match(/^(\d+)\t(.*)$/)
      return m ? { line: Number(m[1]), text: m[2] } : null
    })
    .filter(Boolean)
}

function inferEnclosingFunctionHint(readOut, targetLine) {
  const rows = parseNumberedReadLines(readOut)
  if (!rows.length) return null
  let idx = rows.findIndex((row) => row.line >= targetLine)
  if (idx === -1) idx = rows.length - 1
  const banned = new Set(['if', 'for', 'while', 'switch', 'catch', 'function'])
  for (let i = idx; i >= 0; i--) {
    const line = rows[i].text.trim()
    let m = line.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
      || line.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_][A-Za-z0-9_]*\s*=>)/)
      || line.match(/^(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/)
    if (m?.[1] && !banned.has(m[1])) return m[1]
  }
  return null
}

// Explore fast path runs before the LLM call and, if it finds a candidate,
// returns its synthesized answer directly — skipping the LLM entirely. That's
// correct for simple "where is X defined?" queries but wrong for multi-angle
// research queries that just happen to mention an identifier. Gate on prompt
// shape: short, non-imperative only.
function _isSimpleExploreLookup(query) {
  const text = String(query || '').trim()
  if (!text) return false
  const words = text.split(/\s+/).filter(Boolean)
  if (/\b(list|propose|evaluate|trace|review|audit|summarize|design|implement|refactor|analyze|compare|suggest|recommend|walkthrough|walk\s+through)\b/i.test(text)) return false
  if (/\b(who\s+calls|callers?|called\s+by|all\s+references|reference\s+graph)\b/i.test(text)) return false
  if (words.length > 12) {
    const strongIdentifiers = text.match(/\b(?:[A-Z][A-Z0-9_]{2,}|[a-z]+(?:[A-Z][A-Za-z0-9]*)+)\b/g) || []
    const uniqueStrong = [...new Set(strongIdentifiers)]
    const hasQuotedStrongIdentifier = uniqueStrong.length === 1 && text.includes(`\`${uniqueStrong[0]}\``)
    const lookupIntent = /\b(find|locate|where|file|function|definition|defined|contains|identifier|symbol)\b/i.test(text)
    if (words.length > 45 || uniqueStrong.length !== 1 || (!lookupIntent && !hasQuotedStrongIdentifier)) return false
  }
  return true
}

async function runExploreFilenamePatternFastPath(query, cwd) {
  const text = String(query || '').toLowerCase()
  if (!cwd) return null
  if (!/\bsrc\b/.test(text)) return null
  if (!/\broute(?:s|d)?\b/.test(text) || !/\bpolic(?:y|ies)\b/.test(text)) return null
  if (!/\b(file|files|module|modules|json|locate|find)\b/.test(text)) return null
  let globOut = ''
  try {
    globOut = await executeBuiltinTool('glob', {
      pattern: [
        'src/**/*route*.mjs',
        'src/**/*route*.js',
        'src/**/*route*.ts',
        'src/**/*policy*.json',
      ],
      path: cwd,
      head_limit: 0,
    }, cwd)
  } catch {
    return null
  }
  if (!globOut || String(globOut).startsWith('Error:')) return null
  return [
    'Filename pattern matches for route modules and policy JSON files under `src`:',
    'Complete grounded result; no follow-up filesystem listing is needed for this lookup.',
    String(globOut).trim(),
  ].join('\n')
}

async function runExploreCallerFastPath(query, cwd) {
  if (!cwd) return null
  const text = String(query || '').trim()
  if (!/\b(who\s+calls|caller(?:s|\(s\))?\s+of|called\s+by|caller\s+file|caller\s+function)\b/i.test(text)) return null
  if (/\b(list\s+all|all\s+references|reference\s+graph|impact|trace|audit|review)\b/i.test(text)) return null
  if (text.split(/\s+/).filter(Boolean).length > 50) return null
  const identifier = extractIdentifierCandidate(text)
  if (!identifier) return null
  let callers = ''
  try {
    callers = await executeCodeGraphTool('code_graph', {
      mode: 'callers',
      symbol: identifier,
      limit: 20,
    }, cwd)
  } catch {
    return null
  }
  if (!callers || String(callers).startsWith('Error:') || /^\(no callers\)/i.test(String(callers).trim())) return null
  return [
    `Direct caller lookup for \`${identifier}\` from code_graph:`,
    'Complete grounded result; no follow-up file read is needed when caller and evidence line are present.',
    String(callers).trim(),
  ].join('\n')
}

async function runExploreGrepLiteralFastPath(identifier, cwd) {
  if (!identifier || !cwd) return null
  let grepOut = ''
  try {
    grepOut = await executeBuiltinTool('grep', {
      pattern: identifier,
      path: cwd,
      glob: ['**/*.*'],
      output_mode: 'content',
      head_limit: 20,
      '-n': true,
      '-C': 1,
    }, cwd)
  } catch {
    return null
  }
  const candidate = parseGrepBestCandidate(grepOut)
  if (!candidate?.filePath || !Number.isFinite(candidate.line)) return null
  let readOut = ''
  try {
    readOut = await executeBuiltinTool('read', {
      path: candidate.filePath,
      offset: Math.max(0, candidate.line - 4),
      limit: 12,
    }, cwd)
  } catch {
    readOut = ''
  }
  const parts = [
    `Best literal match for \`${identifier}\`: \`${candidate.filePath}:${candidate.line}\`.`,
  ]
  if (candidate.content) parts.push(`Match: ${candidate.content}`)
  const enclosing = inferEnclosingFunctionHint(readOut, candidate.line)
  if (enclosing) {
    parts.push(`Enclosing function hint: \`${enclosing}\`.`)
  }
  if (readOut && !String(readOut).startsWith('Error:')) {
    const compactRead = String(readOut).split('\n').slice(0, 8).join('\n')
    parts.push(`Nearby lines:\n${compactRead}`)
  }
  return parts.join('\n\n')
}

async function runExploreLiteralFastPath(query, cwd) {
  if (!cwd) return null
  const text = String(query || '').trim()
  if (/\b(list\s+all|all\s+references|reference\s+graph|impact|trace|audit|review)\b/i.test(text)) return null
  if (text.split(/\s+/).filter(Boolean).length > 60) return null
  const identifier = extractIdentifierCandidate(text)
  const explicitIdentifier = identifier && (text.includes(`\`${identifier}\``) || /^[A-Z][A-Z0-9_]{2,}$/.test(identifier))
  const literalIntent = /\b(literal|exact|contains|occurrence|identifier)\b/i.test(text)
  if (!identifier || (!literalIntent && !explicitIdentifier)) return null
  if (!identifier || !/^(?:[A-Z][A-Z0-9_]{2,}|[a-z]+(?:[A-Z][A-Za-z0-9]*)+)$/.test(identifier)) return null
  return runExploreGrepLiteralFastPath(identifier, cwd)
}

async function runExploreFastPath(query, cwd) {
  if (!cwd) return null
  const filenamePatternResult = await runExploreFilenamePatternFastPath(query, cwd)
  if (filenamePatternResult) return filenamePatternResult
  const callerResult = await runExploreCallerFastPath(query, cwd)
  if (callerResult) return callerResult
  const literalResult = await runExploreLiteralFastPath(query, cwd)
  if (literalResult) return literalResult
  if (!_isSimpleExploreLookup(query)) return null
  const identifier = extractIdentifierCandidate(query)
  if (!identifier) return null
  let symbolResult
  try {
    symbolResult = await executeCodeGraphTool('find_symbol', { symbol: identifier }, cwd)
  } catch {
    symbolResult = null
  }
  const symbolCandidate = parseFindSymbolBestCandidate(symbolResult)
  if (symbolCandidate?.filePath && Number.isFinite(symbolCandidate.line)) {
    let readOut = ''
    try {
      readOut = await executeBuiltinTool('read', {
        path: symbolCandidate.filePath,
        offset: Math.max(0, symbolCandidate.line - 4),
        limit: 12,
      }, cwd)
    } catch {
      readOut = ''
    }

    const pieces = [
      `Best code match for \`${identifier}\`: \`${symbolCandidate.filePath}:${symbolCandidate.line}\`.`,
      summarizeDeclarationShape(identifier, symbolCandidate.declaration),
      `Declaration: ${symbolCandidate.declaration}`,
    ]
    if (symbolCandidate.context) {
      pieces.push(`Context: ${symbolCandidate.context}`)
    }
    const enclosing = inferEnclosingFunctionHint(readOut, symbolCandidate.line)
    if (enclosing) {
      pieces.push(`Enclosing function hint: \`${enclosing}\`.`)
    }
    if (readOut && !String(readOut).startsWith('Error:')) {
      const compactRead = String(readOut).split('\n').slice(0, 8).join('\n')
      pieces.push(`Nearby lines:\n${compactRead}`)
    }
    return pieces.join('\n\n')
  }

  return runExploreGrepLiteralFastPath(identifier, cwd)
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

function appendRetrievalCompleteHint(tool, body, queryCount) {
  const text = typeof body === 'string' ? body : String(body ?? '')
  const plural = queryCount === 1 ? 'this query' : 'these queries'
  return [
    text,
    '',
    `[${tool} retrieval complete: synthesize from the result for ${plural}; do not call ${tool} again with the same query unless the result explicitly says there were no useful hits.]`,
  ].join('\n')
}

export async function dispatchAiWrapped(name, args, ctx) {
  const rawQuery = args.query
  if (rawQuery == null) return fail('query is required')
  const queries = Array.isArray(rawQuery) ? rawQuery : [rawQuery]
  if (queries.length === 0) return fail('query cannot be empty')

  const spec = ROLE_BY_TOOL[name]
  if (!spec) throw new Error(`Unknown aiWrapped tool: ${name}`)

  if (name === 'search' && searchProviderKeysMissing()) {
    return fail(
      'Search is not configured. Open the Config UI (run `/mixdog:config`) → Search tab '
      + 'and register at least one provider API key (Serper / Brave / Perplexity / '
      + 'Firecrawl / Tavily / xAI). The `search` tool stays disabled until then so '
      + 'the agent does not silently fall back to hallucinated answers.',
    )
  }

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
  const cwdInput = (typeof args.cwd === 'string' && args.cwd.trim())
    ? args.cwd
    : ctx?.callerCwd
  const resolvedCwd = resolveCwd(cwdInput, ctx?.callerCwd)

  // Sync by default — the merged sub-agent answer lands in-turn as the MCP
  // tool response, no channel round-trip, no turn fragmentation. Opt into
  // background=true for heavy multi-angle queries that risk exceeding the
  // ~14s MCP request timeout; in that case a handle is returned immediately
  // and the merged answer is pushed via the channel bridge when ready.
  const background = typeof args.background === 'boolean'
    ? args.background
    : false

  if (!background) {
    const settled = await Promise.allSettled(
      queries.map((q) => {
        const key = buildQueryCacheKey(name, q, resolvedCwd, brief)
        return runCachedQuery(name, key, async () => {
          if (name === 'explore') {
            const fast = await runExploreFastPath(q, resolvedCwd)
            if (fast) return fast
          }
          const llm = makeBridgeLlm({ role: spec.role, cwd: resolvedCwd, brief, parentSessionId: ctx?.callerSessionId || null })
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
    return ok(appendRetrievalCompleteHint(name, merged, queries.length))
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
        if (name === 'explore') {
          const fast = await runExploreFastPath(q, resolvedCwd)
          if (fast) return fast
        }
        const llm = makeBridgeLlm({ role: spec.role, cwd: resolvedCwd, brief, parentSessionId: ctx?.callerSessionId || null })
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

Use your read-only tools (\`code_graph\` / \`glob\` / \`grep\` / \`read\` / \`multi_read\` / \`list\`) to find grounded answers.

Rules:
- Default to ONE retrieval round. A second round is allowed only when round 1 is clearly too sparse to answer.
- Work in 2 rounds max: locate -> confirm. If round 2 already grounds the answer, stop and synthesize.
- For symbol / constant / identifier questions, prefer ONE \`find_symbol\` call before falling back to raw \`grep\`.
- For caller / reference questions, prefer \`code_graph\` with \`mode:"references"\` or \`mode:"callers"\`.
- If \`find_symbol\` returns a \`decl\` hit with file:line and declaration text, treat that as grounded location evidence. Prefer reading that file directly instead of issuing a follow-up grep.
- Never call \`find_symbol\` and \`grep\` for the same identifier in the same round unless \`find_symbol\` returned no declaration candidate.
- Prefer one broad batched probe over several narrow probes in sequence.
- When 2+ exact file paths are known, prefer one \`multi_read\` / array \`path\` call instead of serial reads.
- Do NOT use shell search or \`bash_session\` for navigation.
- If you catch yourself planning another \`grep -> read\` loop on the same topic, stop and answer from the evidence you already have.
- If the first probe already finds likely files, switch immediately to confirm/summarize instead of trying alternate phrasings.

Return concise prose with concrete file paths.`
}

function buildRecallPrompt(query, _cwd) {
  // cwd has no effect on memory_search semantics; second arg accepted for
  // builder signature uniformity (caller always passes resolvedCwd).
  return `Query: ${query}

Use the \`memory_search\` tool to retrieve ranked entries.

Rules:
- Default to exactly ONE \`memory_search\` call.
- A second \`memory_search\` call is allowed only if the first returns no useful hits and you are widening time scope or dropping an over-tight filter.
- Never call \`memory_search\` twice with identical arguments. If you already searched the query, synthesize from that evidence.
- Never do a third retrieval call.
- If the first call yields relevant entries, synthesize immediately instead of probing alternate phrasings.
- Cite entry ids inline.

Return concise prose.`
}

function buildSearchPrompt(query, _cwd) {
  // cwd has no effect on web_search semantics; second arg accepted for
  // builder signature uniformity.
  const repoTarget = extractGithubRepoReadTarget(query)
  const repoRule = repoTarget
    ? `\n- This is a GitHub repository read. Call \`web_search\` exactly once with \`github_type:\"repo\"\`, \`owner:\"${repoTarget.owner}\"\`, and \`repo:\"${repoTarget.repo}\"\`. Omit \`keywords\`, \`site\`, and \`type\`. The second-call exception does not apply to this query: stop after that one call unless the tool returns an explicit error or no GitHub repository URL. Do not run code/repository/free-text follow-up searches.`
    : ''
  return `Query: ${query}

Use the \`web_search\` tool to retrieve ranked results.

Rules:
- Default to exactly ONE \`web_search\` call.
- A second \`web_search\` call is allowed only if the first call is clearly sparse and you widen scope in a meaningful way.
- Never do a third search call.
- If the first call already returns enough evidence, synthesize immediately.
- If the first call returns a single GitHub read result (repo / file / issue / pulls) with concrete metadata, treat it as authoritative and answer immediately.
- Prefer narrower \`site\` / \`type\` / GitHub-specific arguments over retrying with near-identical free text.
- For specific documentation queries, choose a result whose title, URL, or snippet directly matches the requested topic. Do not answer with a generic homepage when the query asks for a specific page such as a models/API/reference page.
- For a query naming a concrete resource, endpoint, package, page title, or API object, broad introduction/home/guide results are sparse unless their title, URL, or snippet directly contains that requested topic. In that case, use your one allowed second call with the missing topic terms made more explicit.
- Treat documentation/API queries as normal web/domain searches unless the query explicitly asks for GitHub, repositories, source code, issues, or pull requests.
- Cite only URLs that were returned by \`web_search\`; do not infer URLs from prior knowledge or site structure.
- Do not treat a "page not found" result as a valid documentation match.
- For GitHub repo questions, repository metadata (URL, description, stars/language/default branch/license) is enough evidence.
- Only set \`github_type\` / \`owner\` / \`repo\` for explicit GitHub queries. For official docs or domain-restricted web searches, call \`web_search\` with \`keywords\`, optional \`site\`, optional \`type\`, and leave all GitHub fields omitted.
- Do not send empty optional fields such as \`owner:""\`, \`repo:""\`, \`path:""\`, \`site:""\`, \`keywords:""\`, or placeholder \`number:0\`; omit unused fields entirely.
${repoRule}
- Cite URLs inline.

Return concise prose.`
}

/**
 * Resolve user-provided cwd: expand `~`, resolve relatives against the
 * launch workspace. Falls back to null so callers use process.cwd().
 */
function resolveCwd(input, baseCwd = process.cwd()) {
  if (!input || typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed) return null
  const expanded = trimmed.startsWith('~')
    ? trimmed.replace(/^~/, homedir())
    : trimmed
  const base = (typeof baseCwd === 'string' && baseCwd) ? baseCwd : process.cwd()
  return isAbsolute(expanded) ? expanded : resolvePath(base, expanded)
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
