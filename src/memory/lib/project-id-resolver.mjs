import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

/** @type {Map<string, string|null>} */
const cache = new Map();
let ghNotFoundWarned = false;

/**
 * Walk up from `start`, returning the first directory that contains `name`,
 * or null if the filesystem root is reached without a match.
 * @param {string} start - absolute directory path
 * @param {string} name  - entry name to look for
 * @returns {string|null} absolute path of the containing directory
 */
function findAncestor(start, name) {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, name))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

/**
 * Parse a git remote url and return "owner/repo" slug, or null on failure.
 * Handles:
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 * @param {string} gitRoot
 * @returns {string|null}
 */
function slugFromGitConfig(gitRoot) {
  const configPath = join(gitRoot, '.git', 'config');
  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }

  // Find [remote "origin"] section and extract url value
  const sectionMatch = text.match(/\[remote\s+"origin"\][^\[]*url\s*=\s*([^\r\n]+)/);
  if (!sectionMatch) return null;

  const url = sectionMatch[1].trim();

  // https://github.com/owner/repo(.git)?
  let m = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (m) return m[1];

  return null;
}

/**
 * Call `gh repo view <slug> --json viewerPermission --jq .viewerPermission`.
 * Returns the trimmed permission string, or null on any failure.
 * @param {string} slug
 * @returns {string|null}
 */
function fetchViewerPermission(slug) {
  try {
    const result = execFileSync(
      'gh',
      ['repo', 'view', slug, '--json', 'viewerPermission', '--jq', '.viewerPermission'],
      { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return result.toString().trim();
  } catch (err) {
    if (err.code === 'ENOENT' || (err.message && err.message.includes('spawn'))) {
      if (!ghNotFoundWarned) {
        ghNotFoundWarned = true;
        process.stderr.write('[project-id] gh CLI not found, falling back to COMMON\n');
      }
    }
    // timeout, non-zero exit, or spawn failure → null silently
    return null;
  }
}

/**
 * Resolve a project_id for the given working directory.
 *
 * 3-tier priority:
 *   1. .mixdog/project.id file in cwd or any ancestor
 *   2. .git root → parse origin url → gh CLI permission check → owner/repo slug
 *   3. null (COMMON)
 *
 * Optional `whitelist` (from fetchRepoWhitelist) accelerates tier-2:
 * if the owner is in whitelist.owners the gh permission check is skipped.
 *
 * Result is memoized by git-root (or cwd when no .git found).
 *
 * @param {string} cwd - absolute or relative working directory
 * @param {{ whitelist?: { repos: string[], owners: string[] } }} [opts]
 * @returns {string|null}
 */
export function resolveProjectId(cwd, { whitelist } = {}) {
  const absCwd = resolve(cwd);

  // --- Tier 1: .mixdog/project.id file ---
  const mixdogRoot = findAncestor(absCwd, '.mixdog');
  if (mixdogRoot) {
    const idFile = join(mixdogRoot, '.mixdog', 'project.id');
    if (existsSync(idFile)) {
      const content = readFileSync(idFile, 'utf8').trim();
      // "common" (case-insensitive) → forced COMMON
      if (content.toLowerCase() === 'common') {
        // Cache the null so repeated calls skip the ancestor walk.
        if (!cache.has(mixdogRoot)) cache.set(mixdogRoot, null);
        return null;
      }
      if (content) {
        const cacheKey = mixdogRoot;
        if (!cache.has(cacheKey)) cache.set(cacheKey, content);
        return content;
      }
    }
  }

  // --- Tier 2+: locate .git root ---
  const gitRoot = findAncestor(absCwd, '.git');
  const cacheKey = gitRoot ?? absCwd;

  if (cache.has(cacheKey)) return cache.get(cacheKey);

  if (!gitRoot) {
    cache.set(cacheKey, null);
    return null;
  }

  // --- Tier 3: parse git origin slug ---
  const slug = slugFromGitConfig(gitRoot);
  if (!slug) {
    cache.set(cacheKey, null);
    return null;
  }

  // --- Tier 4: gh CLI permission check (skip if owner is in whitelist) ---
  let projectId;
  const owner = slug.split('/')[0].toLowerCase();
  if (whitelist?.owners?.includes(owner)) {
    // Owner already verified via whitelist — adopt slug directly
    projectId = slug;
  } else {
    const permission = fetchViewerPermission(slug);
    const WRITE_LEVEL = new Set(['WRITE', 'MAINTAIN', 'ADMIN']);
    projectId = (permission && WRITE_LEVEL.has(permission)) ? slug : null;
  }

  cache.set(cacheKey, projectId);

  // --- Tier 5: lazily write .mixdog/project.id for fast future lookups ---
  if (projectId) {
    try {
      const mixdogDir = join(gitRoot, '.mixdog');
      mkdirSync(mixdogDir, { recursive: true });
      writeFileSync(join(mixdogDir, 'project.id'), projectId, 'utf8');
    } catch {
      // non-critical; ignore write errors
    }
  }

  return projectId;
}

/**
 * Clear the in-process memoization cache.
 * Useful in tests or after workspace changes.
 */
export function clearCache() {
  cache.clear();
}
