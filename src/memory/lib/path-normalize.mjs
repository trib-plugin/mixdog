import os from 'node:os'

const HOME = os.homedir()

/**
 * Minimal path normalization for cross-platform project-id resolution.
 * Keeps only objective corrections:
 * - Expands leading ~ to os.homedir()
 * - Casefolds Windows drive letter (C:/ → c:/)
 *
 * Removed: file:// stripping, quote stripping, $HOME/%USERPROFILE% expansion,
 * backslash conversion — these were heuristic guesses at malformed input that
 * no longer belong in this layer.
 *
 * @param {string} p
 * @returns {string}
 */
export function normalizePath(p) {
  if (typeof p !== 'string') return p

  // Expand ~ to home directory
  p = p.replace(/^~(?=[\/\\]|$)/, HOME)

  // Casefold Windows drive letter (handles both forward-slash and backslash)
  p = p.replace(/^([A-Z]):([/\\])/i, (_, d, sep) => d.toLowerCase() + ':' + sep)

  return p
}
