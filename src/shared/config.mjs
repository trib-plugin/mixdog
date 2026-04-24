/**
 * Unified config reader/writer.
 * Single file: mixdog-config.json with sections: channels, agent, memory, search.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { resolvePluginData } from './plugin-paths.mjs'

const DATA_DIR = resolvePluginData()

const CONFIG_PATH = join(DATA_DIR, 'mixdog-config.json')

const GENERATED_KEY = '_generated'
export const GENERATED_MARKER = 'from mixdog-config.json — edits will be overwritten on next boot'

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function stripGeneratedMarker(data) {
  if (!isPlainObject(data) || !Object.prototype.hasOwnProperty.call(data, GENERATED_KEY)) return data
  const { [GENERATED_KEY]: _generated, ...rest } = data
  return rest
}

// Legacy file paths for one-time migration
const LEGACY_FILES = {
  channels: 'config.json',
  agent: 'agent-config.json',
  memory: 'memory-config.json',
  search: 'search-config.json',
}

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch { return null }
}

function writeJsonFile(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

function readAll() {
  const existing = readJsonFile(CONFIG_PATH)
  if (existing) return existing

  // First run: migrate from legacy files
  const merged = {}
  for (const [section, filename] of Object.entries(LEGACY_FILES)) {
    const legacy = readJsonFile(join(DATA_DIR, filename))
    if (legacy) merged[section] = stripGeneratedMarker(legacy)
  }
  if (Object.keys(merged).length > 0) {
    writeJsonFile(CONFIG_PATH, merged)
  }
  return merged
}

function writeAll(data) {
  writeJsonFile(CONFIG_PATH, data)
}

export function readSection(section) {
  return stripGeneratedMarker(readAll()[section] || {})
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
// homeAccess: when true (default), file tools may write anywhere under
// $HOME. When false, file tools are cwd-scoped. This ONLY controls the
// main-agent path gate — sub-agent Edit/Write to HOME paths always go
// through Discord approval regardless (enforced in
// hooks/pre-tool-subagent.cjs).
const CAPABILITY_DEFAULTS = Object.freeze({ homeAccess: true })

export function readCapabilities() {
  const raw = readAll().capabilities
  const out = { ...CAPABILITY_DEFAULTS }
  if (raw && typeof raw === 'object') {
    if (raw.homeAccess === false) out.homeAccess = false
  }
  return out
}

export function writeCapabilities(caps) {
  const sanitized = { ...CAPABILITY_DEFAULTS }
  if (caps && typeof caps === 'object') {
    if (caps.homeAccess === false) sanitized.homeAccess = false
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
