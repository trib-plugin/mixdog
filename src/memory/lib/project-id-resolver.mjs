import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

/** @type {Map<string, string|null>} */
const cache = new Map();

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
 * Resolve a project_id for the given working directory.
 *
 * Single source: .mixdog/project.id file in cwd or any ancestor directory.
 * Returns the file content (trimmed), or null if no file is found or the
 * content is "common" (case-insensitive).
 *
 * Removed: git origin parsing, gh CLI permission check, owner whitelist
 * branch, lazy .mixdog/project.id write. Those were multi-step heuristics
 * with no objective signal — project membership must be declared explicitly
 * via a .mixdog/project.id file.
 *
 * Result is memoized by the .mixdog root directory path.
 *
 * @param {string} cwd - absolute or relative working directory
 * @returns {string|null}
 */
export function resolveProjectId(cwd) {
  const absCwd = resolve(cwd);

  const mixdogRoot = findAncestor(absCwd, '.mixdog');
  if (!mixdogRoot) return null;

  if (cache.has(mixdogRoot)) return cache.get(mixdogRoot);

  const idFile = join(mixdogRoot, '.mixdog', 'project.id');
  if (!existsSync(idFile)) {
    cache.set(mixdogRoot, null);
    return null;
  }

  const content = readFileSync(idFile, 'utf8').trim();
  // "common" (case-insensitive) → forced COMMON
  if (content.toLowerCase() === 'common' || !content) {
    cache.set(mixdogRoot, null);
    return null;
  }

  cache.set(mixdogRoot, content);
  return content;
}

/**
 * Clear the in-process memoization cache.
 * Useful in tests or after workspace changes.
 */
export function clearCache() {
  cache.clear();
}
