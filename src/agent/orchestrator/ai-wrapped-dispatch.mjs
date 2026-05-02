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
import { resolve as resolvePath, isAbsolute, join, relative } from 'path'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { loadConfig, getPluginData } from './config.mjs'
import { resolvePresetName } from './smart-bridge/bridge-llm.mjs'
import { smartReadTruncate } from './tools/builtin.mjs'
import { executeBuiltinTool } from './tools/builtin.mjs'
import { executeCodeGraphTool } from './tools/code-graph.mjs'
import { addPending, removePending } from './dispatch-persist.mjs'
import { notifyActivity } from './activity-bus.mjs'
import { stripLeadingSoftWarns } from './tool-loop-guard.mjs'

// Fan-out deadline: default 240 s. Override via env FANOUT_DEADLINE_S.
// Applied to both sync and background fan-out paths. After expiry, settled
// subs are merged as partial; pending subs are aborted.
const _FANOUT_DEADLINE_MS = (() => {
  const v = parseInt(process.env.FANOUT_DEADLINE_S, 10)
  return Number.isFinite(v) && v > 0 ? v * 1000 : 240_000
})()

// Hard errors that should trigger sibling abort + partial-error escalation.
// SessionClosedError is excluded — it means the parent itself aborted, not
// a sub failure.
function isHardSubError(reason) {
  if (!reason) return false
  if (reason?.name === 'SessionClosedError') return false
  return true
}

const ROLE_BY_TOOL = Object.freeze({
  recall:  { role: 'recall-agent',  build: (q, cwd) => _internals.builders.recall(q, cwd),   label: 'recall-agent' },
  search:  { role: 'search-agent',  build: (q, cwd) => _internals.builders.search(q, cwd),   label: 'search-agent' },
  explore: { role: 'explorer',      build: (q, cwd) => _internals.builders.explore(q, cwd),  label: 'explorer agent' },
})

// Cumulative-character cap for explore output. V8's max string length
// sits around 512 MB; concatenating raw matches + per-query syntheses
// across a very broad cwd (e.g. the whole `~/.claude` tree) used to blow
// past that and crash the MCP server with `Invalid string length`.
// 50 MB chars stays well clear and is still far above any realistic
// single-answer payload.
const EXPLORE_OUTPUT_CHAR_CAP = 50_000_000
// Per-piece pre-clamp. Caps each subagent body before it is folded into
// the cumulative buffer so a single runaway response can't blow past V8
// max-string-length (~512MB) at template-literal construction time,
// before the running-total guard below ever gets to run.
const EXPLORE_PER_PIECE_CHAR_CAP = 5_000_000
const EXPLORE_TRUNCATION_MARKER = '\n\n[explore: output truncated at 50MB cap; narrow cwd or split queries to see more]'

// Clamp a raw subagent body (or error string) to the per-piece cap
// BEFORE it gets wrapped with header / separator. Returns the (possibly
// truncated) string; truncation reuses the existing marker so callers
// see a consistent signal.
function clampPiece(raw) {
  if (typeof raw !== 'string') return raw
  if (raw.length <= EXPLORE_PER_PIECE_CHAR_CAP) return raw
  return raw.slice(0, EXPLORE_PER_PIECE_CHAR_CAP) + EXPLORE_TRUNCATION_MARKER
}

// Build a merged answer with a hard cumulative-size cap. Mirrors the
// per-mode shape used by the regular merge path (single query returns
// the raw answer; multi-query prepends `### Query N:` headers and joins
// with `---`) but stops appending once the running total crosses the
// cap, then emits a single inline marker. Each piece is also pre-clamped
// to EXPLORE_PER_PIECE_CHAR_CAP so a single oversized response can't
// blow up before the running-total check fires.
// partialInfo: { completed, total, deadlineSecs } | null — appends footer when set.
function mergeExploreSettled(settled, queries, label, partialInfo) {
  const isSingle = queries.length === 1
  if (isSingle) {
    const r = settled[0]
    const raw = r.status === 'fulfilled'
      ? (r.value || '(no response)')
      : `[${label} error] ${r.reason?.message || String(r.reason)}`
    // Single-query path: per-piece cap == cumulative cap effectively, but
    // still pre-clamp to keep the post-clamp slice bounded and cheap.
    const clamped = clampPiece(raw)
    if (typeof clamped === 'string' && clamped.length > EXPLORE_OUTPUT_CHAR_CAP) {
      return clamped.slice(0, EXPLORE_OUTPUT_CHAR_CAP) + EXPLORE_TRUNCATION_MARKER
    }
    return _appendPartialFooter(clamped, partialInfo)
  }
  const parts = []
  let total = 0
  let truncated = false
  let truncatedAtPiece = -1
  const sep = '\n\n---\n\n'
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]
    const header = `### Query ${i + 1}: ${queries[i]}`
    const rawBody = r.status === 'fulfilled'
      ? (r.value || '(no response)')
      : `[${label} error] ${r.reason?.message || String(r.reason)}`
    // Pre-clamp the body BEFORE template construction so a 400MB rogue
    // response can't allocate a 400MB+ piece string just to be discarded.
    const body = clampPiece(rawBody)
    const piece = `${header}\n${body}`
    const addLen = (parts.length === 0 ? 0 : sep.length) + piece.length
    // Running-total guard: stop appending once the next piece would push
    // us past the cumulative cap. Truncate the trailing piece to the
    // remaining budget so we still emit something for the boundary query.
    if (total + addLen > EXPLORE_OUTPUT_CHAR_CAP) {
      const remaining = EXPLORE_OUTPUT_CHAR_CAP - total - (parts.length === 0 ? 0 : sep.length)
      if (remaining > 0) {
        parts.push(piece.slice(0, remaining))
        total += (parts.length === 1 ? 0 : sep.length) + remaining
      }
      truncated = true
      truncatedAtPiece = i + 1
      break
    }
    parts.push(piece)
    total += addLen
  }
  const merged = parts.join(sep)
  if (!truncated) return merged
  const note = truncatedAtPiece > 0
    ? `\n\n[explore: merge truncated at piece ${truncatedAtPiece}/${settled.length}]`
    : ''
  return _appendPartialFooter(merged + EXPLORE_TRUNCATION_MARKER + note, partialInfo)
}

// Append "(M/N ok, dl=Xs)" footer when partialInfo is truthy.
function _appendPartialFooter(text, partialInfo) {
  if (!partialInfo) return text
  const { completed, total, deadlineSecs } = partialInfo
  return `${text}\n\n(${completed}/${total} ok, dl=${deadlineSecs}s)`
}

// Same footer for recall/search merged strings.
function _mergeRecallSearchSettled(settled, queries, label, partialInfo) {
  const merged = queries.length === 1
    ? (settled[0].status === 'fulfilled'
        ? (settled[0].value || '(no response)')
        : `[${label} error] ${settled[0].reason?.message || String(settled[0].reason)}`)
    : settled.map((r, i) => {
        const header = `### Query ${i + 1}: ${queries[i]}`
        if (r.status === 'fulfilled') return `${header}\n${r.value || '(no response)'}`
        return `${header}\n[${label} error] ${r.reason?.message || String(r.reason)}`
      }).join('\n\n---\n\n')
  return _appendPartialFooter(merged, partialInfo)
}

// Detect "very broad" cwds — user home, ~/.claude, or filesystem root.
// We only warn (prepend a soft note); the call is never blocked.
function buildBroadCwdWarning(resolvedCwd, rawCwdInput) {
  const display = (typeof rawCwdInput === 'string' && rawCwdInput.trim())
    ? rawCwdInput.trim()
    : (resolvedCwd || '')
  if (!resolvedCwd) return ''
  let normalized
  try {
    normalized = resolvePath(resolvedCwd).replace(/[\\/]+$/g, '')
  } catch {
    normalized = String(resolvedCwd).replace(/[\\/]+$/g, '')
  }
  const home = (() => {
    try { return resolvePath(homedir()).replace(/[\\/]+$/g, '') }
    catch { return '' }
  })()
  // Filesystem root: POSIX `/` (length <= 1 after trim) or Windows drive
  // root like `C:` / `C:\` / `D:/`.
  const isFsRoot = normalized === ''
    || normalized === '/'
    || /^[A-Za-z]:$/.test(normalized)
    || /^[A-Za-z]:[\\/]?$/.test(resolvedCwd.trim())
  const isHome = home && normalized === home
  const isDotClaude = home && (
    normalized === join(home, '.claude').replace(/[\\/]+$/g, '')
  )
  if (isFsRoot || isHome || isDotClaude) {
    return `[explore: cwd "${display}" is broad; consider narrowing to a subdir for sharper results]\n\n`
  }
  return ''
}

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
  recall: 5 * 60_000,    // 5 min — memory mutates slowly via cycle1
  explore: 5 * 60_000,   // 5 min — code rarely changes within a session
  search: 30 * 60_000,   // 30 min — external web facts are stable
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
  if (!_isSimpleExploreLookup(query)) return null
  const filenamePatternResult = await runExploreFilenamePatternFastPath(query, cwd)
  if (filenamePatternResult) return filenamePatternResult
  const callerResult = await runExploreCallerFastPath(query, cwd)
  if (callerResult) return callerResult
  const literalResult = await runExploreLiteralFastPath(query, cwd)
  if (literalResult) return literalResult
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
  _pruneDispatchResults()
  return _dispatchResults.get(String(id)) || null
}

function appendRetrievalCompleteHint(tool, body, queryCount) {
  const text = typeof body === 'string' ? body : String(body ?? '')
  const plural = queryCount === 1 ? 'this query' : 'these queries'
  return [
    text,
    '',
    `[${tool}: synthesize from result; do not re-call ${plural} unless result explicitly returns no hits.]`,
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
      if (!caller) {
        return fail(
          `"${name}" blocked: caller session "${ctx.callerSessionId}" not found — recursion guard fails closed.`,
        )
      }
      if (isHiddenRole(caller.role)) {
        return fail(
          `"${name}" is blocked inside the "${caller.role}" hidden role (recursion break). `
          + `Use the direct executor (memory_search / web_search / read / grep / glob) for your query.`,
        )
      }
    } catch (e) {
      return fail(
        `"${name}" blocked: recursion guard introspection failed (${e?.message || e}). Fail-closed for safety.`,
      )
    }
  }

  const { makeBridgeLlm } = await import('./smart-bridge/bridge-llm.mjs')

  // `brief` (default true) applies a ~3000-token cap to each sub-agent
  // answer before it rides back into the Lead context. Pass `brief:false`
  // when the caller explicitly wants the uncapped synthesis. See
  // bridge-llm.mjs::applyBriefCap for the cap shape.
  const brief = args.brief !== false;
  const hasExplicitCwdArg = typeof args.cwd === 'string' && args.cwd.trim()
  const cwdInput = hasExplicitCwdArg
    ? args.cwd
    : ctx?.callerCwd
  const queryText = queries.map((q) => String(q ?? '')).join('\n')
  const resolvedCwd = name === 'explore'
    ? resolveExploreCwd(cwdInput, ctx?.callerCwd, queryText, Boolean(hasExplicitCwdArg))
    : resolveCwd(cwdInput, ctx?.callerCwd)

  // Sync by default — the merged sub-agent answer lands in-turn as the MCP
  // tool response, no channel round-trip, no turn fragmentation. Opt into
  // background=true for heavy multi-angle queries that risk exceeding the
  // ~14s MCP request timeout; in that case a handle is returned immediately
  // and the merged answer is pushed via the channel bridge when ready.
  const background = typeof args.background === 'boolean'
    ? args.background
    : false

  if (!background) {
    // Deadline race: allSettled vs a timer. Controllers keyed by query index
    // so we can abort only the pending subs when the deadline fires.
    // Use globalThis.AbortController (Node 15+).
    const makeAC = () => { try { return new AbortController() } catch { return null } }
    const syncSubControllers = queries.map(() => makeAC())

    // Parent abort → sub controllers link.
    let _parentSig = null
    try {
      if (ctx?.callerSessionId) {
        const { getAbortSignalForSession } = await import('./session/abort-lookup.mjs')
        _parentSig = await getAbortSignalForSession(ctx.callerSessionId)
      }
    } catch { /* best-effort */ }

    if (_parentSig) {
      if (_parentSig.aborted) {
        syncSubControllers.forEach(ac => { try { ac?.abort() } catch {} })
      } else {
        _parentSig.addEventListener('abort', () => {
          syncSubControllers.forEach(ac => { try { ac?.abort() } catch {} })
        }, { once: true })
      }
    }

    // Hard-error escalation tracking.
    let _hardErrorEscalated = false
    const _escapedSettled = []

    const promises = queries.map((q, i) => {
      const key = buildQueryCacheKey(name, q, resolvedCwd, brief)
      const subSignal = syncSubControllers[i]?.signal ?? null
      const p = runCachedQuery(name, key, async () => {
        const llm = makeBridgeLlm({
          role: spec.role, cwd: resolvedCwd, brief,
          parentSessionId: ctx?.callerSessionId || null,
          parentSignal: subSignal,
        })
        return llm({ prompt: spec.build(q, resolvedCwd) })
      })
      p.then(
        (val) => { _escapedSettled[i] = { status: 'fulfilled', value: val } },
        (err) => {
          _escapedSettled[i] = { status: 'rejected', reason: err }
          if (!_hardErrorEscalated && isHardSubError(err)) {
            _hardErrorEscalated = true
            // Abort siblings.
            syncSubControllers.forEach((ac, j) => { if (j !== i) try { ac?.abort() } catch {} })
          }
        },
      )
      return p
    })

    // Deadline timer.
    let _deadlineTimer = null
    let _deadlineFired = false
    const _deadlineMs = _FANOUT_DEADLINE_MS
    const _deadlinePromise = new Promise((resolve) => {
      _deadlineTimer = setTimeout(() => {
        _deadlineFired = true
        syncSubControllers.forEach(ac => { try { ac?.abort() } catch {} })
        resolve('__deadline__')
      }, _deadlineMs)
      if (typeof _deadlineTimer?.unref === 'function') _deadlineTimer.unref()
    })

    // Race: all subs settle vs deadline.
    await Promise.race([Promise.allSettled(promises), _deadlinePromise])
    clearTimeout(_deadlineTimer)

    // Build settled from what resolved so far.
    const settled = await Promise.allSettled(
      promises.map((p, i) =>
        _escapedSettled[i] !== undefined
          ? Promise.resolve(_escapedSettled[i].status === 'fulfilled'
              ? _escapedSettled[i].value
              : Promise.reject(_escapedSettled[i].reason))
          : Promise.race([p, Promise.resolve(undefined).then(() => Promise.reject(new Error('sub-agent timed out (deadline)')))])
      ),
    )

    const completedCount = settled.filter(r => r.status === 'fulfilled' || (r.status === 'rejected' && !String(r.reason?.message || '').includes('timed out'))).length
    const partialInfo = _deadlineFired
      ? { completed: completedCount, total: queries.length, deadlineSecs: Math.round(_deadlineMs / 1000) }
      : null

    let merged
    if (name === 'explore') {
      merged = mergeExploreSettled(settled, queries, spec.label, partialInfo)
      const warn = buildBroadCwdWarning(resolvedCwd, hasExplicitCwdArg ? args.cwd : '')
      if (warn) merged = warn + merged
    } else {
      merged = _mergeRecallSearchSettled(settled, queries, spec.label, partialInfo)
    }

    // All-failed detection: every entry rejected, OR every fulfilled value is
    // a config-error marker. Surface as MCP isError so caller doesn't merge
    // the failures back into context as if they were normal results.
    const allFailed = settled.every(r =>
      r.status === 'rejected'
      || (typeof r.value === 'string' && /\[search-config-error[^\]]*\]/.test(r.value))
    )
    // Hard-error escalation: any hard sub error and not all already covered.
    if (_hardErrorEscalated && !allFailed) {
      const hardFailed = settled.filter(r => r.status === 'rejected' && isHardSubError(r.reason)).length
      const okCount = settled.filter(r => r.status === 'fulfilled').length
      if (okCount === 0) return fail(merged)
      // Partial-error: some completed, annotate but don't fail the whole call.
      process.stderr.write(`[ai-wrapped-dispatch] partial-error: ${hardFailed} hard errors, ${okCount} ok — escalated\n`)
    }
    if (allFailed) return fail(merged)
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
  // Wire caller abort: when the caller session aborts (ESC, new prompt),
  // mark the dispatch handle cancelled so a later result push doesn't echo
  // a stale answer back to a session that already moved on. Best-effort:
  // background sub-agents continue running on the bridge, but their result
  // is suppressed at push time.
  let _callerAborted = false;
  try {
    if (ctx?.callerSessionId) {
      import('./session/abort-lookup.mjs').then(({ getAbortSignalForSession }) => {
        Promise.resolve(getAbortSignalForSession(ctx.callerSessionId)).then((sig) => {
          if (!sig) return;
          if (sig.aborted) { _callerAborted = true; return; }
          sig.addEventListener('abort', () => {
            _callerAborted = true;
            const entry = _dispatchResults.get(id);
            if (entry && entry.status === 'running') {
              entry.status = 'cancelled';
              entry.completedAt = Date.now();
            }
          }, { once: true });
        }).catch(() => {});
      }).catch(() => {});
    }
  } catch {}
  // Background fan-out with parent abort cascade + deadline.
  ;(async () => {
    // Parent signal for background path — caller abort wires into sub controllers.
    let _bgParentSig = null
    try {
      if (ctx?.callerSessionId) {
        const { getAbortSignalForSession } = await import('./session/abort-lookup.mjs')
        _bgParentSig = await getAbortSignalForSession(ctx.callerSessionId)
      }
    } catch { /* best-effort */ }

    const bgSubControllers = queries.map(() => { try { return new AbortController() } catch { return null } })

    if (_bgParentSig) {
      if (_bgParentSig.aborted) {
        bgSubControllers.forEach(ac => { try { ac?.abort() } catch {} })
      } else {
        _bgParentSig.addEventListener('abort', () => {
          bgSubControllers.forEach(ac => { try { ac?.abort() } catch {} })
        }, { once: true })
      }
    }

    let _bgHardErrorEscalated = false
    const _bgEscapedSettled = []

    const bgPromises = queries.map((q, i) => {
      const key = buildQueryCacheKey(name, q, resolvedCwd, brief)
      const subSig = bgSubControllers[i]?.signal ?? null
      const p = runCachedQuery(name, key, async () => {
        const llm = makeBridgeLlm({
          role: spec.role, cwd: resolvedCwd, brief,
          parentSessionId: ctx?.callerSessionId || null,
          parentSignal: subSig,
        })
        return llm({ prompt: spec.build(q, resolvedCwd) })
      })
      p.then(
        (val) => { _bgEscapedSettled[i] = { status: 'fulfilled', value: val } },
        (err) => {
          _bgEscapedSettled[i] = { status: 'rejected', reason: err }
          if (!_bgHardErrorEscalated && isHardSubError(err)) {
            _bgHardErrorEscalated = true
            bgSubControllers.forEach((ac, j) => { if (j !== i) try { ac?.abort() } catch {} })
            const bgEntry = _dispatchResults.get(id)
            if (bgEntry && bgEntry.status === 'running') bgEntry.status = 'partial-error'
          }
        },
      )
      return p
    })

    let _bgDeadlineTimer = null
    let _bgDeadlineFired = false
    const _bgDeadlineMs = _FANOUT_DEADLINE_MS
    const _bgDeadlinePromise = new Promise((resolve) => {
      _bgDeadlineTimer = setTimeout(() => {
        _bgDeadlineFired = true
        bgSubControllers.forEach(ac => { try { ac?.abort() } catch {} })
        resolve('__deadline__')
      }, _bgDeadlineMs)
      if (typeof _bgDeadlineTimer?.unref === 'function') _bgDeadlineTimer.unref()
    })

    await Promise.race([Promise.allSettled(bgPromises), _bgDeadlinePromise])
    clearTimeout(_bgDeadlineTimer)

    const settled = await Promise.allSettled(
      bgPromises.map((p, i) =>
        _bgEscapedSettled[i] !== undefined
          ? (_bgEscapedSettled[i].status === 'fulfilled'
              ? Promise.resolve(_bgEscapedSettled[i].value)
              : Promise.reject(_bgEscapedSettled[i].reason))
          : Promise.resolve(undefined).then(() => Promise.reject(new Error('sub-agent timed out (deadline)'))),
      ),
    )

    const bgCompletedCount = settled.filter(r => r.status === 'fulfilled' || (r.status === 'rejected' && !String(r.reason?.message || '').includes('timed out'))).length
    const bgPartialInfo = _bgDeadlineFired
      ? { completed: bgCompletedCount, total: queries.length, deadlineSecs: Math.round(_bgDeadlineMs / 1000) }
      : null

    let merged
    if (name === 'explore') {
      merged = mergeExploreSettled(settled, queries, spec.label, bgPartialInfo)
      const warn = buildBroadCwdWarning(resolvedCwd, hasExplicitCwdArg ? args.cwd : '')
      if (warn) merged = warn + merged
    } else {
      merged = _mergeRecallSearchSettled(settled, queries, spec.label, bgPartialInfo)
    }
    _pruneDispatchResults()
    const entry = _dispatchResults.get(id)
    const allFailed = settled.every(r =>
      r.status === 'rejected'
      || (typeof r.value === 'string' && /\[search-config-error[^\]]*\]/.test(r.value))
    )
    if (entry) {
      entry.status = allFailed ? 'error' : 'done'
      entry.isError = allFailed
      entry.content = merged
      entry.completedAt = Date.now()
    }
    removePending(process.env.CLAUDE_PLUGIN_DATA, id)
    if (_callerAborted) {
      // Caller already moved on; suppress notification but keep registry
      // entry for observability.
      return
    }
    pushDispatchResult(ctx, id, name, queries, merged, { error: allFailed })
  })().catch((err) => {
    const msg = err?.message || String(err)
    _pruneDispatchResults()
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
  builders: {
    recall: buildRecallPrompt,
    search: buildSearchPrompt,
    explore: buildExplorerPrompt,
  },
}


function _escapeXml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildExplorerPrompt(query, cwd) {
  const rootLine = cwd ? `<root>${_escapeXml(cwd)}</root>\n` : ''
  return `${rootLine}<query>${_escapeXml(query)}</query>`
}

function buildRecallPrompt(query, _cwd) {
  // Inject current_date + current_time so the recall-agent can resolve
  // relative time words ("이어서 / 최근 / 계속 / 지금까지") against an
  // absolute anchor instead of guessing. Without this anchor the agent
  // defaults to 30d and BM25 surfaces fact-rich older entries over the
  // current session's freshest events (#16812 recency bias).
  // R11 reviewer L6: emit LOCAL time so it agrees with parsePeriod's
  // calendar-day math (today/yesterday anchor at LOCAL midnight). UTC
  // anchors created Sun-Mon mismatches near KST midnight.
  const localIso = new Date().toLocaleString('sv-SE')
  const today = localIso.slice(0, 10)
  const time = localIso.slice(11, 19)
  return `<current_date>${today}</current_date>\n<current_time>${time}</current_time>\n<query>${_escapeXml(query)}</query>`
}

function buildSearchPrompt(query, _cwd) {
  const today = new Date().toISOString().slice(0, 10)
  return `<current_date>${today}</current_date>\n<query>${_escapeXml(query)}</query>`
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

function resolveExploreCwd(input, callerCwd, queryText, hasExplicitCwdArg = false) {
  const base = resolveCwd(callerCwd, process.cwd())
  const resolved = resolveCwd(input, base || process.cwd())
  if (!hasExplicitCwdArg || !base || !resolved) return resolved
  if (isPathInside(base, resolved)) return resolved
  // Caller passed an explicit cwd outside callerCwd. If it points to a real
  // directory, trust the deliberate redirect (Lead exploring a sibling tree,
  // plugin source, etc.). queryMentionsCwd stays as fallback for ambiguous /
  // non-existent inputs that look like model typos.
  if (_cwdIsExistingDir(resolved)) return resolved
  if (queryMentionsCwd(queryText, input, resolved)) return resolved
  return base
}

function _cwdIsExistingDir(p) {
  if (!p || typeof p !== 'string') return false
  let st
  try { st = statSync(p) } catch { return false }
  return Boolean(st && st.isDirectory())
}

function isPathInside(baseCwd, targetCwd) {
  if (!baseCwd || !targetCwd) return false
  const rel = relative(resolvePath(baseCwd), resolvePath(targetCwd))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function queryMentionsCwd(queryText, rawCwd, resolvedCwd) {
  const text = String(queryText || '')
  if (!text.trim()) return false
  const candidates = new Set()
  const raw = typeof rawCwd === 'string' ? rawCwd.trim() : ''
  if (raw) {
    candidates.add(raw)
    if (raw.startsWith('~')) candidates.add(raw.replace(/^~/, homedir()))
  }
  if (typeof resolvedCwd === 'string' && resolvedCwd.trim()) candidates.add(resolvedCwd.trim())

  for (const candidate of candidates) {
    const normalized = candidate.replace(/[\\/]+$/g, '')
    if (normalized === '~') {
      if (/(?:^|[\s`"'(])~(?:$|[\s`"'./\\)])/u.test(text)) return true
      continue
    }
    if (normalized.length < 3) continue
    if (text.includes(candidate) || text.includes(normalized)) return true
    const slashVariant = candidate.replace(/\\/g, '/')
    const slashNormalized = normalized.replace(/\\/g, '/')
    if (text.includes(slashVariant) || text.includes(slashNormalized)) return true
  }
  return false
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
  // Lead context. Apply the same head/tail summariser used by `read`
  // (single + array form) so Lead still sees the interesting frames (first queries
  // and final queries) without paying for the middle mass. Truncation acts
  // on the body only — the `Done.` header is prepended AFTER, so it never
  // gets cut.
  let bodyStr = typeof body === 'string' ? body : String(body ?? '')
  // v0.1.117 — Sub-agents tend to echo the soft-warn marker line as the
  // first line of their reply. The marker is intentionally prepended onto
  // tool RESULTS so the model self-corrects (see tool-loop-guard.mjs
  // buildSoftWarn / buildRunUpSoftWarn / buildMixedSoftWarn /
  // buildBudgetSoftWarn — those PREPEND sites must stay), but it should
  // not surface in the outbound report to Lead. Strip leading markers only.
  bodyStr = stripLeadingSoftWarns(bodyStr)
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
