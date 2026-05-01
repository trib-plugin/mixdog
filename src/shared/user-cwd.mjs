/**
 * IMPORTANT — cwd model role:
 * pwd() resolves the user's working directory for RELATIVE PATH RESOLUTION only.
 * It is NOT a sandbox boundary. Sandbox decisions are governed by Claude Code's
 * settings.json permissions; mcp's isSafePath only hard-blocks dangerous patterns
 * (UNC paths, parent escapes, known system paths).
 */

/**
 * user-cwd.mjs — shared helper to resolve the user's working directory
 * from the persisted user-cwd.txt sentinel file.
 *
 * Extracted from builtin.mjs so server-main.mjs can call the same primitive
 * before dispatching to executeBuiltinTool, without circular-import risk.
 *
 * v2: Claude Code-style single-source-of-truth model.
 *   - captureOriginalUserCwd() reads user-cwd.txt ONCE at first call and freezes.
 *   - AsyncLocalStorage override (runWithCwdOverride) isolates concurrent worker cwds.
 *   - pwd() = override ?? originalCwd (mirrors Claude Code's cwd.ts pattern).
 *   - resolveDefaultUserCwd() kept as back-compat alias for getOriginalCwd().
 *   - invalidateUserCwdCache() kept as no-op (capture-once semantics make
 *     re-reads unsafe; the value is frozen after first read by design).
 */

import { AsyncLocalStorage } from 'async_hooks'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'

let _originalUserCwd = null  // null = not yet captured
const _cwdOverride = new AsyncLocalStorage()

// Hook payloads can deliver POSIX paths on Windows (e.g. `/c/Project`); Node's
// path.resolve does not map MSYS-style drive prefixes, so the value must be
// rewritten to the platform-native shape before isSafePath compares it.
function _normalizePlatformCwd(p) {
  if (!p || typeof p !== 'string') return p
  if (process.platform !== 'win32') return resolve(p)
  const m = p.match(/^[\/\\]([a-zA-Z])[\/\\](.*)$/)
  const native = m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}` : p
  return resolve(native)
}

/**
 * Idempotent: reads user-cwd.txt once and freezes _originalUserCwd.
 * Subsequent calls return the already-frozen value without re-reading disk.
 */
export function captureOriginalUserCwd() {
  if (_originalUserCwd !== null) return _originalUserCwd
  try {
    const txt = readFileSync(join(process.env.CLAUDE_PLUGIN_DATA || '', 'user-cwd.txt'), 'utf8').trim()
    _originalUserCwd = _normalizePlatformCwd(txt) || process.cwd()
  } catch { _originalUserCwd = process.cwd() }
  return _originalUserCwd
}

/**
 * Returns the frozen original user cwd (captured on first call).
 */
export function getOriginalCwd() { return captureOriginalUserCwd() }

/**
 * Run fn inside an async context where pwd() returns cwd.
 * All descendant async calls within fn see cwd as their working directory.
 */
export function runWithCwdOverride(cwd, fn) {
  return _cwdOverride.run(cwd, fn)
}

/**
 * Current effective working directory:
 *   override set by runWithCwdOverride (innermost wins) ?? original user cwd.
 */
export function pwd() {
  return _cwdOverride.getStore() ?? getOriginalCwd()
}

/**
 * Back-compat alias for existing callers that import resolveDefaultUserCwd.
 * Returns the frozen original cwd (same as getOriginalCwd()).
 */
export function resolveDefaultUserCwd() { return getOriginalCwd() }

/**
 * No-op kept for back-compat. capture-once semantics make re-reads unsafe;
 * the frozen value is the single source of truth for this process lifetime.
 */
export function invalidateUserCwdCache() { /* no-op: capture-once semantics */ }
