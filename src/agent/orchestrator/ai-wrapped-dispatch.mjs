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
import { getHiddenRole } from './internal-roles.mjs'
import { readSection } from '../../shared/config.mjs'
import { resolvePresetName } from './smart-bridge/bridge-llm.mjs'
import { smartReadTruncate } from './tools/builtin.mjs'
import { executeBuiltinTool } from './tools/builtin.mjs'
import { executeCodeGraphTool } from './tools/code-graph.mjs'
import { addPending, removePending } from './dispatch-persist.mjs'
import { notifyActivity } from './activity-bus.mjs'
import { stripLeadingSoftWarns } from './tool-loop-guard.mjs'
import { stripAnsi, normalizeWhitespace, dedupRepeatedLines } from './tools/result-compression.mjs'
import {
  EXPLORE_OUTPUT_CHAR_CAP,
  EXPLORE_PER_PIECE_CHAR_CAP,
  EXPLORE_TRUNCATION_MARKER,
} from './explore-validator.mjs'
import { getRawProviderCredentialSource } from '../../search/lib/config.mjs'

// Fan-out deadline — documented runtime envelope.
// Default 240 s; override via env FANOUT_DEADLINE_S. 240 s balances
// the slowest search/recall sub-agent latency against session responsiveness.
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

// tool→role mapping derived from the declarative hidden-roles config
// (defaults/hidden-roles.json). Each aiWrapped tool name matches the
// `invokedBy` field of exactly one hidden role entry. Builders are
// wired in after the prompt functions are defined (see _internals).
function _roleNameForTool(tool) {
  // Scan all hidden roles for the one whose invokedBy matches the tool name.
  // The set is small (8 entries) so linear scan is fine at module load time.
  for (const name of ['explorer', 'recall-agent', 'search-agent']) {
    const def = getHiddenRole(name)
    if (def && def.invokedBy === tool) return name
  }
  return null
}

const ROLE_BY_TOOL = Object.freeze({
  recall:  { role: _roleNameForTool('recall'),  build: (q, cwd) => _internals.builders.recall(q, cwd),  label: _roleNameForTool('recall')  || 'recall-agent' },
  search:  { role: _roleNameForTool('search'),  build: (q, cwd) => _internals.builders.search(q, cwd),  label: _roleNameForTool('search')  || 'search-agent' },
  explore: { role: _roleNameForTool('explore'), build: (q, cwd) => _internals.builders.explore(q, cwd), label: _roleNameForTool('explore') || 'explorer' },
})
// search-agent output validator. Reviewer-recommended (gpt-5.5):
// prompt polishing alone hits diminishing returns against LLM phrasing
// drift; line-allowlist post-filter enforces the output contract
// deterministically.
const SEARCH_ALLOWED_LINE_PREFIXES = [
  '- ',
  '[unverified]',
  '[search-config-error]',
  '## Q',
]

function _isSearchAllowedLine(line) {
  const trimmed = line.trim()
  if (trimmed === '') return true
  return SEARCH_ALLOWED_LINE_PREFIXES.some(p => trimmed.startsWith(p))
}

function filterSearchOutput(raw) {
  if (typeof raw !== 'string' || !raw) return raw
  const lines = raw.split('\n')
  const kept = lines.filter(_isSearchAllowedLine)
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
  while (kept.length > 0 && kept[0].trim() === '') kept.shift()
  if (kept.length === 0) {
    const today = new Date().toLocaleString('sv-SE').slice(0, 10)
    return `[unverified] no usable output (accessed ${today})`
  }
  return kept.join('\n')
}

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
  const sep = '\n\n'
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]
    // Short header (## Q1) — query text already in caller context.
    const header = `## Q${i + 1}`
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
        // Short header (## Q1) for all retrieval tools — query text already in caller context.
        const header = `## Q${i + 1}`
        if (r.status === 'fulfilled') return `${header}\n${r.value || '(no response)'}`
        return `${header}\n[${label} error] ${r.reason?.message || String(r.reason)}`
      }).join('\n\n')
  return _appendPartialFooter(merged, partialInfo)
}

// Preflight: reject explore cwd values whose entry count exceeds the
// cardinality threshold. Objective check — threshold is the only runtime
// envelope constant; path-list heuristics were removed.
//
// Implementation: glob '**/*' with head_limit = EXPLORE_BROAD_CWD_THRESHOLD+1
// via executeBuiltinTool so the walk stops as soon as the limit is hit
// (no full tree scan). Returns a non-empty error string when rejected,
// '' when acceptable. Callers MUST abort with an MCP error when non-empty.
//
// EXPLORE_BROAD_CWD_THRESHOLD — maximum number of filesystem entries
// (files + directories) allowed under the explore cwd. Chosen so that
// a typical workspace (~3 000 entries after node_modules exclusion) passes
// while a user home dir or a drive root (~50 000+) is rejected immediately.
const EXPLORE_BROAD_CWD_THRESHOLD = 5000

async function checkBroadCwdBlock(resolvedCwd, rawCwdInput) {
  const display = (typeof rawCwdInput === 'string' && rawCwdInput.trim())
    ? rawCwdInput.trim()
    : (resolvedCwd || '')
  if (!resolvedCwd) return ''
  let entryCount = 0
  try {
    const raw = await executeBuiltinTool('glob', {
      pattern: '**/*',
      path: resolvedCwd,
      head_limit: EXPLORE_BROAD_CWD_THRESHOLD + 1,
    })
    if (typeof raw === 'string' && !raw.startsWith('Error:')) {
      entryCount = raw.split('\n').filter(Boolean).length
    }
  } catch {
    // On glob error (unreadable dir, etc.) allow through — the agent will
    // surface its own error rather than giving a misleading preflight block.
    return ''
  }
  if (entryCount > EXPLORE_BROAD_CWD_THRESHOLD) {
    return `Error: explore root too broad: ${entryCount} entries under "${display}" (limit ${EXPLORE_BROAD_CWD_THRESHOLD}). Narrow to a specific subdirectory.`
  }
  return ''
}

// Web search provider credentials live in search-config.json. When none of
// them are populated the downstream sub-agent spawns, burns tokens, and
// returns a polite "provider not configured" apology that the user can
// mistake for a real answer. Precheck here to fail the MCP call directly
// with guidance instead. Runs only for `search` — `recall`/`explore` need
// no external credentials.
//
// Provider env-var lookup delegates to getRawProviderCredentialSource from
// src/search/lib/config.mjs — single source of truth for provider→env-key
// mappings; no duplicate table maintained here.
function searchProviderKeysMissing() {
  try {
    const raw = readSection('search')
    const creds = raw?.rawSearch?.credentials || {}
    for (const entry of Object.values(creds)) {
      if (!entry || typeof entry !== 'object') continue
      const v = entry.apiKey ?? ''
      if (typeof v === 'string' && v.trim().length > 0) return false
    }
    // Config has no credentials — also accept env-var credentials.
    // Delegates to getRawProviderCredentialSource (search/lib/config.mjs)
    // which owns the provider→env-key mapping table.
    const knownProviders = ['serper', 'brave', 'perplexity', 'firecrawl', 'tavily', 'xai']
    const cfg = raw || {}
    for (const provider of knownProviders) {
      if (getRawProviderCredentialSource(cfg, provider)) return false
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
const QUERY_RESULT_CACHE_MAX_ENTRIES = 200
const QUERY_RESULT_CACHE_TTL_MS = 5 * 60_000 // 5 min — provider-level cache handles freshness per tool
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

function cacheTtlMs(_tool) {
  return QUERY_RESULT_CACHE_TTL_MS
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
    `- \`${candidate.filePath}:${candidate.line}\` — literal match for \`${identifier}\``,
  ]
  if (candidate.content) parts.push(`- match: ${candidate.content}`)
  const enclosing = inferEnclosingFunctionHint(readOut, candidate.line)
  if (enclosing) {
    parts.push(`- enclosing: \`${enclosing}\``)
  }
  if (readOut && !String(readOut).startsWith('Error:')) {
    const compactRead = String(readOut).split('\n').slice(0, 8).join('\n')
    parts.push(compactRead)
  }
  return parts.join('\n')
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
      `- \`${symbolCandidate.filePath}:${symbolCandidate.line}\` — \`${identifier}\``,
      summarizeDeclarationShape(identifier, symbolCandidate.declaration),
      `Declaration: ${symbolCandidate.declaration}`,
    ]
    if (symbolCandidate.context) {
      pieces.push(`Context: ${symbolCandidate.context}`)
    }
    const enclosing = inferEnclosingFunctionHint(readOut, symbolCandidate.line)
    if (enclosing) {
      pieces.push(`- enclosing: \`${enclosing}\``)
    }
    if (readOut && !String(readOut).startsWith('Error:')) {
      const compactRead = String(readOut).split('\n').slice(0, 8).join('\n')
      pieces.push(compactRead)
    }
    return pieces.filter(Boolean).join('\n')
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
  if (cached !== null) {
    return cached
  }
  const inflight = _queryInflight.get(key)
  if (inflight) return inflight
  const p = Promise.resolve()
    .then(runner)
    .then((content) => {
      const storeContent = content
      _queryResultCache.set(key, { ts: Date.now(), content: storeContent })
      _queryInflight.delete(key)
      pruneQueryCaches()
      scheduleDiskCacheFlush()
      return storeContent
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

function appendRetrievalCompleteHint(_tool, body, _queryCount) {
  // Trailer (`[tool: synthesize ...]`) dropped per user spec for all retrieval
  // tools (search/recall/explore) — caller wants core facts only, no noise.
  return typeof body === 'string' ? body : String(body ?? '')
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

  // Hard-block broad cwds for explore before spawning any sub-agents.
  // V8 string-limit risk: scanning home / ~/.claude / fs-root can blow the
  // mcp server process. Fail fast here so neither the sync nor background
  // path ever launches a sub-agent against a dangerous root.
  if (name === 'explore') {
    const _earlyBroadErr = await checkBroadCwdBlock(resolvedCwd, hasExplicitCwdArg ? args.cwd : '')
    if (_earlyBroadErr) return fail(_earlyBroadErr)
  }

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
        const raw = await llm({ prompt: spec.build(q, resolvedCwd) })
        return name === 'search' ? filterSearchOutput(raw)
          : raw
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
      const broadErr = await checkBroadCwdBlock(resolvedCwd, hasExplicitCwdArg ? args.cwd : '')
      if (broadErr) return fail(broadErr)
      merged = mergeExploreSettled(settled, queries, spec.label, partialInfo)
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
  // (start banner removed — notifyFn takes no opts so silent_to_agent is
  //  not available; pushing "X started" to the channel is channel noise.
  //  The merged result arrives later via pushDispatchResult.)
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
        const raw = await llm({ prompt: spec.build(q, resolvedCwd) })
        return name === 'search' ? filterSearchOutput(raw)
          : raw
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
      const broadErr = await checkBroadCwdBlock(resolvedCwd, hasExplicitCwdArg ? args.cwd : '')
      if (broadErr) {
        removePending(process.env.CLAUDE_PLUGIN_DATA, id)
        pushDispatchResult(ctx, id, name, queries, broadErr, { error: true })
        return
      }
      merged = mergeExploreSettled(settled, queries, spec.label, bgPartialInfo)
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
  const today = new Date().toLocaleString('sv-SE').slice(0, 10)
  return `${rootLine}<query>${_escapeXml(query)}</query>
<final_pass>
**POSITIVE OUTPUT SPEC** — your answer MUST start with one of:
  (a) \`path:line\` or \`- \` (bullet) — filesystem fact
  (b) \`[unverified] path:line\` — weak candidate from this turn's tool output
  (c) \`not found under <root>\` — with patterns tried on next line
  (d) \`### \` — header for grouped finding sets
Any other first character = VIOLATION. DELETE the offending first line and start over from the first concrete fact.

Before emitting, scan your draft and DELETE any line matching these patterns:
- preamble: "Best code match for", "Best literal match for", "Direct caller lookup", "Filename pattern matches", "Complete grounded result", "Here's what I found", "I will summarize", "I will verify", "I will look it up"
- process narration: "Let me ", "I'll ", "Now I'll ", "Looking at ", "Let's ", "Now I'll check ", "Moving on to ", "Finding callers for ", "Checking config file ", "Cannot call tool", "Routing rule related files:"
- ask-back / refusal: "I need more specificity", "The query is ambiguous", "This query is insufficient", "Cannot call tool", "The query is too broad"
- closer: "If you need ...", "let me know", "If needed ...", "Do you need this?", "If you want ...", "For more details ...", "Would you like ...?", "Would you like me to also show ..."
- memory chunk-id lines: any line containing #N / \`#N\` / ⟨#N⟩ where N is digits — explorer reads filesystem only; never cite memory ids
- redirect: "For more information, visit", "자세한 내용은 ...에서 확인", "권장합니다"

Each fact line must be: \`path:line — description\` or \`- path:line — description\` or \`[unverified] path:line — candidate\`.
Line content (variable name, constant, function name, literal value) MUST appear literally in this turn's tool output for that exact line range — do NOT invent or paraphrase code content.
After the last fact line, STOP. No trailing summary, no offer, no question. (accessed ${today})
</final_pass>`
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
  // Local-date anchor (recall pattern) — UTC slice off-by-one near KST midnight.
  const today = new Date().toLocaleString('sv-SE').slice(0, 10)
  return `<current_date>${today}</current_date>
<query>${_escapeXml(query)}</query>
<final_pass>
**POSITIVE OUTPUT SPEC** — your answer MUST start with one of:
  (a) '- ' (bullet marker, hyphen+space) — for fact-bullet list
  (b) '[unverified] ' — for unverified-prefixed bullet or single-line scrape no-content
  (c) '[search-config-error]' — for terminal config-error line
Any other first character ('I', 'B', 'W', 'H', 'F', 'T', 'O', '이', '검', '다', '웹' etc.) = VIOLATION. REWRITE the answer to start with (a)/(b)/(c).

Before emitting, scan your draft and DELETE any line matching these patterns:
- preamble: "Based on the search results...", "Here's what I found", "검색 결과에서...", "다음과 같습니다"
- process narration (English): "Let me verify...", "Let me check...", "Let me synthesize...", "I'll search...", "I'll answer based on...", "I'll synthesize...", "I've queried...", "I have sufficient information...", "I've hit the soft-warn threshold...", "What I found:", "From the results so far...", "The snippet doesn't include..." — never narrate steps; just emit the final answer
- process narration (Korean): "이미 충분한 정보를 확보했습니다", "정보를 확보했습니다", "웹 검색 결과를 바탕으로 답변하겠습니다", "다음과 같이 답변드립니다", "확인된 내용은 다음과 같습니다" — 단계 설명 금지, 답변만 emit
- redirect: "For [more/complete/detailed] X, visit/see...", "you would need to visit", "official announcement is available at", "자세한 내용은 ...에서 확인", "권장합니다", "Recommendation: ... visit the official ... directly", "scroll to or search within that section"
- closer: "Would you like...", "If you need...", "Let me know...", "please provide ... and I can search again", "추가로 ... 알려드릴까요"
- URL scrape with no extractable content → emit ONE line: "[unverified] scrape returned empty content (<the actual URL from <query>>, accessed ${today})". The phrase 'scrape returned empty content' is fixed; the parenthetical MUST contain the actual URL string from <query>, not the literal token 'URL'. DO NOT add redirect, DO NOT explain the scrape mechanism.
Each fact-bullet: inline (URL, accessed ${today}); bare claim → prefix "[unverified]" before content. ≤5 bullets per query, ≤4 per array sub-query. Sparse / no-result is NOT an exception — emit anchored facts only, mark rest [unverified], STOP.
After the last bullet, STOP. NO trailing summary sentence (e.g. "In summary...", "Your actual X depends on...", "AWS Bedrock does not publicly document...", "실제 X는 ...에 따라 다릅니다"). Only the 3 allowed shapes from the system prompt — anything else (closing prose, qualifier paragraph, dependency note) is a violation.
</final_pass>`
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
  if (typeof notify !== 'function') {
    // notifyFn absent means the background result has nowhere to go — the
    // promise would silently vanish.  Write a visible stderr line so the
    // operator can diagnose "auto-pushed" answers that never arrived, and
    // return a structured marker so callers can detect the gap.
    try {
      process.stderr.write(`[ai-wrapped-dispatch] pushDispatchResult: no notifyFn — result lost tool=${tool} id=${id}\n`)
    } catch {}
    return { lost: true, tool, id, reason: 'no-notify-fn' }
  }
  const queryCount = queries.length === 1
    ? `1 query`
    : `${queries.length} queries`
  const bodyHeader = flags.error
    ? `${tool} failed`
    : `${tool} — ${queryCount}`
  // Smart truncation — large recall/search/explore merged bodies
  // (multi-query fan-out) can blow past the 30 KB smart-read cap and waste
  // Lead context. Apply the same head/tail summariser used by `read`
  // (single + array form) so Lead still sees the interesting frames (first queries
  // and final queries) without paying for the middle mass. Truncation acts
  // on the body only — the `Done.` header is prepended AFTER, so it never
  // gets cut.
  let bodyStr = typeof body === 'string' ? body : String(body ?? '')
  // Sub-agents tend to echo the soft-warn marker line as the
  // first line of their reply. The marker is intentionally prepended onto
  // tool RESULTS so the model self-corrects (see tool-loop-guard.mjs
  // buildSoftWarn / buildRunUpSoftWarn / buildMixedSoftWarn /
  // buildBudgetSoftWarn — those PREPEND sites must stay), but it should
  // not surface in the outbound report to Lead. Strip leading markers only.
  bodyStr = stripLeadingSoftWarns(bodyStr)
  // Apply result-compression helpers before smart-truncate so sub-agent
  // aggregated bodies (recall/explore/search merged answers) shed ANSI
  // escapes, redundant whitespace, and repeated lines before the head/tail
  // budget gets allocated.
  bodyStr = stripAnsi(bodyStr)
  bodyStr = normalizeWhitespace(bodyStr)
  bodyStr = dedupRepeatedLines(bodyStr)
  const bodyBytes = Buffer.byteLength(bodyStr, 'utf8')
  const bodyLines = bodyStr.length === 0 ? 0 : bodyStr.split('\n').length
  const { text: cappedBody } = smartReadTruncate(bodyStr, bodyLines, bodyBytes)
  const originalBody = `${bodyHeader}\n\n${cappedBody}`
  // Prepend a `Done.` wrapper that mirrors the Pool B worker
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
        process.stderr.write(`[ai-wrapped-dispatch] pushDispatchResult async failed: tool=${tool} id=${id} err=${err?.message ?? String(err)} — re-queuing to pending\n`)
      } catch {}
      // Re-insert into the pending queue so the next plugin bootstrap
      // (recoverPending) can surface the result as Aborted rather than
      // losing it silently.  Only write if CLAUDE_PLUGIN_DATA is available.
      const dataDir = process.env.CLAUDE_PLUGIN_DATA
      if (dataDir && id && tool) {
        // .catch callback is not async — use dynamic import().then chain.
        import('./dispatch-persist.mjs').then(({ addPending }) => {
          const qs = Array.isArray(queries) ? queries : [String(queries ?? '')]
          addPending(dataDir, id, tool, qs)
        }).catch(() => { /* best-effort */ })
      }
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
