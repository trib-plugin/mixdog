import os from 'node:os'

const HOME = os.homedir()

/**
 * Normalize a path string for cross-platform project-id resolution.
 * - Expands ~ / $HOME / %USERPROFILE% to os.homedir()
 * - Strips file:// scheme prefix
 * - Strips leading/trailing quotes and surrounding punctuation (", ', `, (, ))
 * - Converts backslashes to forward slashes
 * - Casefolds Windows drive letter (C:/ → c:/)
 *
 * @param {string} p
 * @returns {string}
 */
export function normalizePath(p) {
  if (typeof p !== 'string') return p

  // Strip file:// scheme
  p = p.replace(/^file:\/\//, '')

  // Strip surrounding quotes and common punctuation
  p = p.replace(/^["'`(\[]+/, '').replace(/["'`)'\]]+$/, '')

  // Expand ~ and $HOME / %USERPROFILE%
  p = p.replace(/^~(?=[\/\\]|$)/, HOME)
  p = p.replace(/^\$HOME(?=[\/\\]|$)/, HOME)
  p = p.replace(/^%USERPROFILE%(?=[\/\\]|$)/i, HOME)

  // Backslash → forward slash
  p = p.replace(/\\/g, '/')

  // Casefold Windows drive letter
  p = p.replace(/^([A-Z]):(\/)/i, (_, d, sep) => d.toLowerCase() + ':' + sep)

  return p
}
