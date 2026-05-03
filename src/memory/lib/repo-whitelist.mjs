import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizePath } from './path-normalize.mjs'

let _ghWarnEmitted = false

/**
 * Parse accounts from `gh auth list --hostname github.com` output.
 * Returns an array of account login strings (best-effort, may return [''] on failure).
 * Example line: "  jaeyoungjay  github.com  (active)"
 */
function parseAuthAccounts(output) {
  // `gh auth status` output lines look like:
  //   "  ✓ Logged in to github.com account JYP8877 (keyring)"
  //   "  - Active account: true"
  const accounts = []
  for (const line of output.split('\n')) {
    const m = line.match(/Logged in to github\.com account\s+(\S+)/i)
    if (m) accounts.push(m[1])
  }
  return accounts.length > 0 ? accounts : ['']
}

/**
 * Call `gh repo list` for the given account (empty string = default account).
 * Returns array of { nameWithOwner, viewerPermission } objects.
 */
function fetchReposForAccount(account) {
  const args = ['repo', 'list']
  if (account) args.push(account)
  args.push('--no-archived', '--limit', '1000', '--json', 'nameWithOwner,viewerPermission')
  try {
    const out = execFileSync('gh', args, {
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return JSON.parse(out.toString())
  } catch {
    return []
  }
}

const WRITE_LEVEL = new Set(['WRITE', 'MAINTAIN', 'ADMIN'])

/**
 * Fetch or return cached repo whitelist.
 *
 * Cache schema: { repos: string[], owners: string[], fetchedAt: number }
 *
 * @param {{ cachePath?: string, ttlMs?: number, force?: boolean }} opts
 * @returns {Promise<{ repos: string[], owners: string[], fetchedAt: number }>}
 */
export async function fetchRepoWhitelist({ cachePath, ttlMs = 24 * 3600 * 1000, force = false } = {}) {
  const empty = { repos: [], owners: [], fetchedAt: 0 }

  // Try reading valid cache
  if (!force && cachePath) {
    try {
      if (existsSync(cachePath)) {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
        if (
          Array.isArray(cached?.repos) &&
          Array.isArray(cached?.owners) &&
          typeof cached?.fetchedAt === 'number' &&
          Date.now() - cached.fetchedAt < ttlMs
        ) {
          return cached
        }
      }
    } catch {
      // corrupt cache — fall through
    }
  }

  // Enumerate logged-in accounts
  let accounts = ['']
  try {
    const authOut = execFileSync(
      'gh',
      ['auth', 'status', '--hostname', 'github.com'],
      { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    accounts = parseAuthAccounts(authOut.toString())
  } catch (err) {
    if (err.code === 'ENOENT' || (err.message && err.message.includes('spawn'))) {
      if (!_ghWarnEmitted) {
        _ghWarnEmitted = true
        process.stderr.write('[repo-whitelist] gh CLI not found — skipping whitelist fetch\n')
      }
    }
    // Return stale cache if available, else empty
    if (cachePath) {
      try {
        if (existsSync(cachePath)) {
          const stale = JSON.parse(readFileSync(cachePath, 'utf8'))
          if (Array.isArray(stale?.repos)) return stale
        }
      } catch {}
    }
    return empty
  }

  // Enumerate organizations the active token can access.
  let orgs = []
  try {
    const orgOut = execFileSync(
      'gh',
      ['api', 'user/orgs', '--paginate', '--jq', '.[].login'],
      { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    orgs = orgOut.toString().split('\n').filter(Boolean)
  } catch {
    // non-critical; continue with account-only fetch
  }

  // Fetch repos for each account + each org, dedup
  const repoSet = new Set()
  const ownerSet = new Set()

  for (const target of [...accounts, ...orgs]) {
    const list = fetchReposForAccount(target)
    for (const r of list) {
      if (!r?.nameWithOwner || !WRITE_LEVEL.has(r.viewerPermission)) continue
      const slug = r.nameWithOwner.toLowerCase()
      repoSet.add(slug)
      ownerSet.add(slug.split('/')[0])
    }
  }

  const result = {
    repos: Array.from(repoSet),
    owners: Array.from(ownerSet),
    fetchedAt: Date.now(),
  }

  // Persist cache
  if (cachePath) {
    try {
      mkdirSync(dirname(cachePath), { recursive: true })
      writeFileSync(cachePath, JSON.stringify(result, null, 2) + '\n', 'utf8')
    } catch {
      // non-critical
    }
  }

  return result
}

/**
 * Check whether a normalized path string contains a known repo.
 * Matches `/<owner>/<repo>/` anywhere in path, or path ending with `/<owner>/<repo>`.
 * Case-insensitive.
 *
 * @param {{ repos: string[], owners: string[] } | null | undefined} whitelist
 * @param {string} pathStr
 * @returns {string | null} owner/repo slug if matched, null otherwise
 */
export function whitelistRepoMatch(whitelist, pathStr) {
  if (!whitelist?.repos?.length || !pathStr) return null
  const norm = normalizePath(pathStr).toLowerCase().replace(/\\/g, '/')
  for (const slug of whitelist.repos) {
    // slug is already lowercased at build time
    if (norm.includes('/' + slug + '/') || norm.endsWith('/' + slug)) {
      return slug
    }
  }
  return null
}
