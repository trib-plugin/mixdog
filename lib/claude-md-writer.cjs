'use strict';

/**
 * mixdog CLAUDE.md managed-block writer.
 *
 * Manages a single marker-delimited block inside a CLAUDE.md file.
 * Only content *between* the markers is ever touched — anything the
 * user has written outside the block is preserved verbatim.
 *
 * Every write also purges blocks tagged with legacy markers (see
 * LEGACY_MARKERS below) so a plugin rename never leaves stale copies
 * behind. Duplicate current-marker blocks (e.g. authored by hand) are
 * collapsed to the first occurrence on every write.
 *
 * All writes are atomic (temp file + rename) to prevent partial writes
 * from corrupting the target file.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MARKER_START = '<!-- BEGIN mixdog managed -->';
const MARKER_END = '<!-- END mixdog managed -->';

// Marker pairs from previous plugin names. Every write strips any block
// delimited by these so a rename never leaves the old block behind next
// to the new one. Append new entries in lockstep with MARKER_START/END
// whenever the plugin is renamed again.
const LEGACY_MARKERS = Object.freeze([
  Object.freeze({
    start: '<!-- BEGIN trib-plugin managed -->',
    end: '<!-- END trib-plugin managed -->',
  }),
]);

/**
 * Expand a leading `~` to the current user's home directory.
 * Any other path is returned unchanged.
 *
 * @param {string} p
 * @returns {string}
 */
function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Write `data` to `filePath` atomically via a sibling temp file.
 * Creates parent directories as needed.
 */
function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmp, data, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup of the temp file on rename failure
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * Build the managed block string from its inner content.
 */
function wrapBlock(content) {
  const body = typeof content === 'string' ? content : '';
  return `${MARKER_START}\n${body}\n${MARKER_END}`;
}

/**
 * Strip every (start, end) block from `text`. Handles duplicates by
 * looping until no more pairs remain. Invalid pairs (end before start,
 * unmatched markers) are left alone.
 */
function stripAllBlocks(text, start, end) {
  let out = text;
  while (true) {
    const si = out.indexOf(start);
    const ei = out.indexOf(end, si + start.length);
    if (si === -1 || ei === -1) break;
    out = out.slice(0, si) + out.slice(ei + end.length);
  }
  return out;
}

/**
 * Collapse any run of 3+ consecutive newlines down to exactly 2 (one
 * blank line). Used after block removal to normalise whitespace gaps.
 */
function collapseBlankRuns(text) {
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Remove any legacy-marker blocks from `text`. No-op when none are
 * present, so it is safe to call on every upsert.
 */
function stripLegacyBlocks(text) {
  let out = text;
  for (const m of LEGACY_MARKERS) {
    out = stripAllBlocks(out, m.start, m.end);
  }
  return out;
}

/**
 * Insert or update the managed block inside `filePath`.
 *
 * Behavior:
 *   - `~` in filePath is expanded via os.homedir()
 *   - If the file does not exist, create it containing just the block
 *   - Legacy-marker blocks (see LEGACY_MARKERS) are always purged first
 *     so plugin renames never leave stale copies behind
 *   - The FIRST current-marker block is replaced in place; any extra
 *     duplicates elsewhere in the file are removed
 *   - If no current-marker block exists, append the block to the end,
 *     separated from existing content by a blank line
 *   - Blank-line runs introduced by the stripping are collapsed and the
 *     file always ends with exactly one trailing newline
 *
 * @param {string} filePath
 * @param {string} content — raw inner content (no markers)
 */
function upsertManagedBlock(filePath, content) {
  const resolved = expandHome(filePath);
  const block = wrapBlock(content);

  let existing = null;
  try {
    existing = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }

  if (existing === null) {
    // File does not exist — create with just the block (trailing newline).
    atomicWrite(resolved, block + '\n');
    return;
  }

  // Purge legacy-marker blocks from any earlier plugin name.
  const cleaned = stripLegacyBlocks(existing);

  const startIdx = cleaned.indexOf(MARKER_START);
  const endIdx = cleaned.indexOf(MARKER_END, startIdx + MARKER_START.length);

  let next;
  if (startIdx !== -1 && endIdx !== -1) {
    // Replace the first current-marker block in place. Any additional
    // duplicate blocks in the tail are stripped so only one remains.
    const before = cleaned.slice(0, startIdx);
    const afterRaw = cleaned.slice(endIdx + MARKER_END.length);
    const after = stripAllBlocks(afterRaw, MARKER_START, MARKER_END);
    next = before + block + after;
  } else if (cleaned.length === 0) {
    next = block + '\n';
  } else if (cleaned.endsWith('\n\n')) {
    next = cleaned + block + '\n';
  } else if (cleaned.endsWith('\n')) {
    next = cleaned + '\n' + block + '\n';
  } else {
    next = cleaned + '\n\n' + block + '\n';
  }

  // Normalise whitespace runs introduced by any of the strip paths, and
  // guarantee exactly one trailing newline.
  next = collapseBlankRuns(next).replace(/\s+$/g, '');
  if (next.length > 0) next += '\n';

  if (next !== existing) atomicWrite(resolved, next);
}

/**
 * Remove the managed block (markers inclusive) from `filePath`, plus
 * any legacy-marker blocks.
 *
 * Behavior:
 *   - `~` in filePath is expanded via os.homedir()
 *   - No-op if the file does not exist
 *   - Cleans up surplus blank lines left behind by the removal
 *   - Atomic write
 *
 * @param {string} filePath
 * @returns {boolean} true if an actual write happened, false if no-op
 */
function removeManagedBlock(filePath) {
  const resolved = expandHome(filePath);

  let existing;
  try {
    existing = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }

  let next = existing;
  next = stripAllBlocks(next, MARKER_START, MARKER_END);
  next = stripLegacyBlocks(next);

  // Stitch the halves back together and collapse the gap.
  next = collapseBlankRuns(next).replace(/\s+$/g, '');
  if (next.length > 0) next += '\n';

  if (next !== existing) {
    atomicWrite(resolved, next);
    return true;
  }
  return false;
}

module.exports = {
  MARKER_START,
  MARKER_END,
  LEGACY_MARKERS,
  expandHome,
  upsertManagedBlock,
  removeManagedBlock,
};
