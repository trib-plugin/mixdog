/**
 * dispatch-persist — crash / restart recovery for async dispatch handles.
 *
 * Plugin MCP server can be restarted by Claude Code at any time (idle timeout,
 * user reload, etc.). Any in-flight dispatch whose merge callback had not yet
 * run would otherwise be orphaned silently — handle issued, no result, no
 * abort notification.
 *
 * This module persists the minimum needed to recover:
 *   - handle   (`dispatch_<tool>_...`)
 *   - tool     (`recall` / `search` / `explore`)
 *   - queries  (for the abort message)
 *   - createdAt
 *
 * On add: write through to disk. On complete/error: remove entry.
 * On bootstrap: read file, emit one abort Noti per surviving entry, clear.
 *
 * Best-effort everywhere — never let persist IO break the caller.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';

const TTL_MS = 30 * 60_000;
const FILE_NAME = 'pending-dispatches.json';

// Single-writer mutex — serializes all R/M/W mutations within one process.
let _writeLock = Promise.resolve();

function pathFor(dataDir) {
  return join(dataDir, FILE_NAME);
}

function readAll(dataDir) {
  try {
    const p = pathFor(dataDir);
    if (!existsSync(p)) return {};
    const raw = readFileSync(p, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(dataDir, map) {
  try {
    const p = pathFor(dataDir);
    mkdirSync(dirname(p), { recursive: true });
    const rand = Math.random().toString(36).slice(2, 8);
    const tmp = `${p}.${rand}.tmp`;
    writeFileSync(tmp, JSON.stringify(map), 'utf8');
    renameSync(tmp, p);
  } catch { /* best-effort */ }
}

/**
 * Prune expired entries. Returns `{ map, changed }` so callers can decide
 * whether to write the pruned state back to disk. `changed === true` iff
 * at least one entry was deleted (or was present but falsy). addPending
 * always writes regardless, so it does not need the flag; hasPending /
 * recoverPending / removePending use it to persist the pruned map instead
 * of letting expired entries accumulate in pending-dispatches.json across
 * restarts.
 */
function gc(map) {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of Object.entries(map)) {
    if (!v || (now - (v.createdAt || 0)) > TTL_MS) {
      delete map[k];
      changed = true;
    }
  }
  return { map, changed };
}

export function addPending(dataDir, handle, tool, queries) {
  if (!dataDir || !handle) return;
  _writeLock = _writeLock.then(() => {
    try {
      const { map } = gc(readAll(dataDir));
      map[handle] = { tool, queries: Array.isArray(queries) ? queries : [String(queries)], createdAt: Date.now() };
      writeAll(dataDir, map);
    } catch { /* best-effort */ }
  });
}

/**
 * Best-effort check: is there at least one non-expired in-flight dispatch
 * recorded for this dataDir? Used by the scheduler's idle-state probe so
 * proactive chat stays suppressed while a bridge dispatch is still
 * running. Never throws.
 */
export function hasPending(dataDir) {
  if (!dataDir) return false;
  try {
    const { map, changed } = gc(readAll(dataDir));
    if (changed) writeAll(dataDir, map);
    return Object.keys(map).length > 0;
  } catch {
    return false;
  }
}

export function removePending(dataDir, handle) {
  if (!dataDir || !handle) return;
  _writeLock = _writeLock.then(() => {
    try {
      const { map, changed } = gc(readAll(dataDir));
      let mutated = changed;
      if (handle in map) {
        delete map[handle];
        mutated = true;
      }
      if (mutated) writeAll(dataDir, map);
    } catch { /* best-effort */ }
  });
}

/**
 * Called once at plugin bootstrap after the MCP transport is connected.
 * For every pending entry remaining from the previous process lifetime,
 * emit a single Aborted notification with `type: 'dispatch_result'` so the
 * Lead can close the loop on its next turn. Then clear the file.
 */
export function recoverPending(dataDir, notifyFn) {
  if (!dataDir || typeof notifyFn !== 'function') return 0;
  let count = 0;
  try {
    const { map, changed } = gc(readAll(dataDir));
    const handles = Object.keys(map);
    if (handles.length === 0) {
      // Even with zero survivors, a gc() pass may have removed expired
      // entries — persist the empty state so the file does not retain
      // stale records across the next restart.
      if (changed) writeAll(dataDir, {});
      return 0;
    }
    for (const handle of handles) {
      const entry = map[handle] || {};
      const tool = entry.tool || 'dispatch';
      const queries = Array.isArray(entry.queries) ? entry.queries : [];
      const qCount = queries.length;
      const qSuffix = qCount === 1 ? '1 query' : `${qCount} queries`;
      const content = `[${tool}] Aborted — plugin restart interrupted dispatch (${qSuffix}). Retry if still needed.`;
      const meta = {
        type: 'dispatch_result',
        dispatch_id: handle,
        tool,
        error: true,
        instruction: `Earlier ${tool} dispatch (${handle}) was aborted by a plugin restart. Retry if the answer is still needed.`,
      };
      try { notifyFn(content, meta); count++; } catch { /* best-effort */ }
    }
    // Clear AFTER notifications fired (not before — if the write fails we at
    // least still reported, rather than losing the record silently).
    writeAll(dataDir, {});
  } catch { /* best-effort */ }
  return count;
}
