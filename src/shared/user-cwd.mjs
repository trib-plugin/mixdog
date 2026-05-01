/**
 * user-cwd.mjs — shared helper to resolve the user's working directory
 * from the persisted user-cwd.txt sentinel file.
 *
 * Extracted from builtin.mjs so server-main.mjs can call the same primitive
 * before dispatching to executeBuiltinTool, without circular-import risk.
 *
 * TODO: invalidate on SessionStart — hook should call _invalidateUserCwdCache()
 * when a new session writes user-cwd.txt so the lazy value is refreshed.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

let _cachedUserCwd = undefined // undefined = not yet resolved; null = absent

/**
 * Returns the user's working directory from user-cwd.txt (written by the
 * SessionStart hook), or null if the file is absent or empty.
 * Result is cached after the first read; call _invalidateUserCwdCache() to
 * force a fresh read on the next call.
 */
export function resolveDefaultUserCwd() {
  if (_cachedUserCwd !== undefined) return _cachedUserCwd
  try {
    const txt = readFileSync(join(process.env.CLAUDE_PLUGIN_DATA || '', 'user-cwd.txt'), 'utf8').trim()
    _cachedUserCwd = txt || null
  } catch {
    _cachedUserCwd = null
  }
  return _cachedUserCwd
}

/** Clears the cached value so the next resolveDefaultUserCwd() re-reads disk. */
export function invalidateUserCwdCache() {
  _cachedUserCwd = undefined
}
