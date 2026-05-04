/**
 * Unified config reader/writer.
 * Single file: mixdog-config.json with sections: channels, agent, memory, search.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { resolvePluginData } from './plugin-paths.mjs'

const DATA_DIR = resolvePluginData()

const CONFIG_PATH = join(DATA_DIR, 'mixdog-config.json')

const GENERATED_KEY = '_generated'
const GENERATED_MARKER = 'from mixdog-config.json — edits will be overwritten on next boot'

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function stripGeneratedMarker(data) {
  if (!isPlainObject(data) || !Object.prototype.hasOwnProperty.call(data, GENERATED_KEY)) return data
  const { [GENERATED_KEY]: _generated, ...rest } = data
  return rest
}

// Legacy file paths for one-time migration
export const LEGACY_FILES = {
  channels: 'config.json',
  agent: 'agent-config.json',
  memory: 'memory-config.json',
  search: 'search-config.json',
}

function readJsonFile(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null  // file missing — normal first-run
    process.stderr.write(`[config] readJsonFile: unexpected read error for ${path}: ${err.message}\n`)
    return null
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    // Parse failure on mixdog-config.json: quarantine and abort merge.
    if (path === CONFIG_PATH) {
      const corrupt = `${path}.corrupt-${Date.now()}`
      try { renameSync(path, corrupt) } catch {}
      process.stderr.write(`[config] mixdog-config.json is malformed (${err.message}). Renamed to ${corrupt}. Restore it or delete to start fresh.\n`)
      return null  // readAll will fall through to legacy migration on next read
    }
    return null
  }
}

function writeJsonFile(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

function readAll() {
  const existing = readJsonFile(CONFIG_PATH)
  if (!existing) {
    // First run or quarantined config: migrate every legacy file at once,
    // then rename legacy files so they don't re-trigger migration.
    const merged = {}
    for (const [section, filename] of Object.entries(LEGACY_FILES)) {
      const legacyPath = join(DATA_DIR, filename)
      const legacy = readJsonFile(legacyPath)
      if (legacy) {
        merged[section] = stripGeneratedMarker(legacy)
        // Rename to .legacy-migrated-<ts>.json so it never re-triggers.
        try {
          renameSync(legacyPath, `${legacyPath}.legacy-migrated-${Date.now()}.json`)
        } catch {}
      }
    }
    if (Object.keys(merged).length > 0) {
      writeJsonFile(CONFIG_PATH, merged)
    }
    return merged
  }
  // Backfill: mixdog-config.json exists but one or more sections are missing or
  // empty AND a legacy file is still present (not yet renamed). Migrate those
  // remaining sections, then rename the legacy file. Idempotent: once renamed,
  // the legacy file is gone and this loop is a no-op on subsequent boots.
  let touched = false
  for (const [section, filename] of Object.entries(LEGACY_FILES)) {
    const cur = existing[section]
    const empty = cur == null
      || (isPlainObject(cur) && Object.keys(cur).length === 0)
    if (!empty) continue
    const legacyPath = join(DATA_DIR, filename)
    const legacy = readJsonFile(legacyPath)
    if (!legacy) continue
    const stripped = stripGeneratedMarker(legacy)
    if (isPlainObject(stripped) && Object.keys(stripped).length === 0) continue
    existing[section] = stripped
    touched = true
    // Rename legacy file after absorbing its content.
    try {
      renameSync(legacyPath, `${legacyPath}.legacy-migrated-${Date.now()}.json`)
    } catch {}
  }
  if (touched) writeJsonFile(CONFIG_PATH, existing)
  return existing
}

function writeAll(data) {
  writeJsonFile(CONFIG_PATH, data)
}

export function readSection(section) {
  return stripGeneratedMarker(readAll()[section] ?? null) ?? {}
}

export function writeSection(section, data) {
  const all = readAll()
  all[section] = stripGeneratedMarker(data)
  writeAll(all)
}

export function updateSection(section, updater) {
  const all = readAll()
  const current = stripGeneratedMarker(all[section] || {})
  all[section] = stripGeneratedMarker(typeof updater === 'function' ? updater(current) : updater)
  writeAll(all)
}

// ── Module enable/disable (B6 General toggles) ──────────────────────
// Top-level `modules` section in mixdog-config.json. Missing keys on load
// default to enabled:true (backcompat — existing configs keep running
// with all four modules on). Changes require a plugin restart to take
// effect; the setup UI surfaces that.
const MODULE_NAMES = ['channels', 'memory', 'search', 'agent']

export function readModules() {
  const raw = readAll().modules
  const out = {}
  for (const name of MODULE_NAMES) {
    const entry = raw && typeof raw === 'object' ? raw[name] : null
    // Default enabled:true when the entry is missing OR when the
    // `enabled` field itself is absent. Only explicit `false` disables.
    const enabled = entry && typeof entry === 'object' && entry.enabled === false ? false : true
    out[name] = { enabled }
  }
  return out
}

export function writeModules(modules) {
  const sanitized = {}
  for (const name of MODULE_NAMES) {
    const entry = modules && typeof modules === 'object' ? modules[name] : null
    const enabled = entry && typeof entry === 'object' && entry.enabled === false ? false : true
    sanitized[name] = { enabled }
  }
  const all = readAll()
  all.modules = sanitized
  writeAll(all)
}

export function isModuleEnabled(name) {
  const mods = readModules()
  return !!(mods[name] && mods[name].enabled)
}

// ── Capabilities (B2 central path policy) ───────────────────────────
// Top-level `capabilities` section in mixdog-config.json. Safe defaults
// win on missing/malformed input — every cap is OFF unless explicitly
// enabled. Settings round-trip through the setup UI; the in-process
// path gate reads them via `getCapabilities()`.
//
// homeAccess: when true, file tools may write anywhere under $HOME. When
// false (default), file tools are cwd-scoped — matches the setup UI's
// out-of-the-box "OFF" toggle so a fresh install is restrictive until the
// user explicitly opts in. This ONLY controls the main-agent path gate —
// sub-agent Edit/Write to HOME paths always go through Discord approval
// regardless (enforced in hooks/pre-tool-subagent.cjs).
const CAPABILITY_DEFAULTS = Object.freeze({ homeAccess: false })

export function readCapabilities() {
  const raw = readAll().capabilities
  const out = { ...CAPABILITY_DEFAULTS }
  if (raw && typeof raw === 'object') {
    if (raw.homeAccess === true) out.homeAccess = true
    else if (raw.homeAccess === false) out.homeAccess = false
  }
  return out
}

export function writeCapabilities(caps) {
  const sanitized = { ...CAPABILITY_DEFAULTS }
  if (caps && typeof caps === 'object') {
    if (caps.homeAccess === true) sanitized.homeAccess = true
    else if (caps.homeAccess === false) sanitized.homeAccess = false
  }
  const all = readAll()
  all.capabilities = sanitized
  writeAll(all)
  return sanitized
}

// Convenience alias requested by B2 call-site plumbing. Returns the
// same object shape as readCapabilities(); callers that only need a
// boolean can read `.homeAccess` directly.
export function getCapabilities() {
  return readCapabilities()
}

export { DATA_DIR, CONFIG_PATH, MODULE_NAMES, CAPABILITY_DEFAULTS }
