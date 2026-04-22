/**
 * Unified LLM usage logger — writes to bridge-trace.jsonl.
 *
 * Phase D: Merged llm-usage.jsonl and llm-maintenance.jsonl into
 * bridge-trace.jsonl. All usage records now go to the same trace file
 * with kind:'usage'. Maintenance records carry maintenanceLog:true.
 *
 * Signature unchanged — callers are unaffected.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { resolvePluginData } from '../plugin-paths.mjs';

function resolveDataDir() {
    return resolvePluginData();
}

const HISTORY_DIR_NAME = 'history';
let _tracePathResolved = null;
function getTracePath() {
    if (_tracePathResolved) return _tracePathResolved;
    const dir = join(resolveDataDir(), HISTORY_DIR_NAME);
    try { mkdirSync(dir, { recursive: true }); } catch {}
    _tracePathResolved = join(dir, 'bridge-trace.jsonl');
    return _tracePathResolved;
}

/**
 * Append a usage entry to bridge-trace.jsonl.
 *
 * @param {object} entry — usage record
 * @param {object} opts
 * @param {boolean} [opts.maintenance=false] — flag record as maintenance-origin
 *
 * Entry schema:
 *   ts, preset, model, provider, mode, duration,
 *   profileId, sessionId,
 *   inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 *   prefixHash, costUsd
 */
const _missingProviderWarned = new Set();
function warnMissingProviderOnce(key) {
    if (_missingProviderWarned.has(key)) return;
    _missingProviderWarned.add(key);
    try {
        process.stderr.write(`[usage-log] provider missing on usage entry (model=${key}). audit the caller.\n`);
    } catch { /* logging only */ }
}

export function logLlmCall(entry, opts = {}) {
    try {
        if (!entry.provider) warnMissingProviderOnce(entry.model || '?');
        const row = {
            ts: entry.ts || new Date().toISOString(),
            kind: 'usage',
            ...entry,
            maintenanceLog: opts.maintenance === true ? true : undefined,
        };
        appendFileSync(getTracePath(), JSON.stringify(row) + '\n');
    } catch {
        // Never let logging break the caller.
    }
}
