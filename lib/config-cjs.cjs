'use strict';
/**
 * CJS shim for shared config reading in hooks.
 *
 * Mirrors the read-only path of src/shared/config.mjs without any write
 * side-effects. Hook processes are not responsible for migration — that is
 * shared/config.mjs's job — so this helper only reads:
 *   1. mixdog-config.json  (preferred, unified)
 *   2. legacy section file (one-shot fallback when unified file is absent)
 *
 * Never writes, never renames, never migrates.
 */

const fs = require('fs');
const path = require('path');
const { resolvePluginData } = require('./plugin-paths.cjs');

const DATA_DIR = resolvePluginData();

const LEGACY_FILES = {
  channels: 'config.json',
  agent: 'agent-config.json',
  memory: 'memory-config.json',
  search: 'search-config.json',
};

const GENERATED_KEY = '_generated';

function stripGeneratedMarker(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (!Object.prototype.hasOwnProperty.call(data, GENERATED_KEY)) return data;
  const { [GENERATED_KEY]: _unused, ...rest } = data;
  return rest;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read a named section from the unified config, falling back to the
 * corresponding legacy file when mixdog-config.json is absent.
 * Returns {} on any failure or missing section.
 *
 * @param {string} section  e.g. 'channels', 'memory', 'agent', 'search'
 * @returns {object}
 */
function readSection(section) {
  if (!DATA_DIR) return {};

  // 1. Try unified file first.
  const unifiedPath = path.join(DATA_DIR, 'mixdog-config.json');
  const unified = readJsonFile(unifiedPath);
  if (unified && typeof unified === 'object') {
    const raw = unified[section];
    if (raw != null) return stripGeneratedMarker(raw) || {};
    // Section key absent in unified file — fall through to legacy.
  }

  // 2. Fallback: read legacy file directly (read-only, no migration).
  const legacyFile = LEGACY_FILES[section];
  if (!legacyFile) return {};
  const legacy = readJsonFile(path.join(DATA_DIR, legacyFile));
  if (legacy && typeof legacy === 'object') {
    return stripGeneratedMarker(legacy) || {};
  }

  return {};
}

module.exports = { readSection };
