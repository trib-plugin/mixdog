'use strict';
/**
 * CJS shim for shared config reading in hooks.
 *
 * Read-only mirror of src/shared/config.mjs's section accessor. Hook
 * processes only read mixdog-config.json — never write, never rename.
 */

const fs = require('fs');
const path = require('path');
const { resolvePluginData } = require('./plugin-paths.cjs');

const DATA_DIR = resolvePluginData();

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

function readSection(section) {
  if (!DATA_DIR) return {};
  const unified = readJsonFile(path.join(DATA_DIR, 'mixdog-config.json'));
  if (!unified || typeof unified !== 'object') return {};
  const raw = unified[section];
  if (raw == null) return {};
  return stripGeneratedMarker(raw) || {};
}

module.exports = { readSection };
