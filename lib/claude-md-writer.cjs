'use strict';

/**
 * mixdog CLAUDE.md managed-block writer.
 *
 * Manages a single marker-delimited block inside a CLAUDE.md file.
 * Only content *between* the markers is ever touched — anything the
 * user has written outside the block is preserved verbatim.
 *
 * All writes are atomic (temp file + rename) to prevent partial writes
 * from corrupting the target file.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MARKER_START = '<!-- BEGIN mixdog managed -->';
const MARKER_END = '<!-- END mixdog managed -->';

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
 * Insert or update the managed block inside `filePath`.
 *
 * Behavior:
 *   - `~` in filePath is expanded via os.homedir()
 *   - If the file does not exist, create it containing just the block
 *   - If the file exists and contains both markers, replace the text
 *     between them (markers preserved in place)
 *   - If the file exists but markers are missing, append the block to
 *     the end of the file, separated from existing content by a blank
 *     line
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

  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace the text between start-of-MARKER_START and end-of-MARKER_END.
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + MARKER_END.length);
    const next = before + block + after;
    if (next !== existing) atomicWrite(resolved, next);
    return;
  }

  // Markers missing — append the block, separated by a blank line.
  let next;
  if (existing.length === 0) {
    next = block + '\n';
  } else if (existing.endsWith('\n\n')) {
    next = existing + block + '\n';
  } else if (existing.endsWith('\n')) {
    next = existing + '\n' + block + '\n';
  } else {
    next = existing + '\n\n' + block + '\n';
  }
  atomicWrite(resolved, next);
}

/**
 * Remove the managed block (markers inclusive) from `filePath`.
 *
 * Behavior:
 *   - `~` in filePath is expanded via os.homedir()
 *   - No-op if the file does not exist
 *   - No-op if markers are not both present
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

  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return false;

  const before = existing.slice(0, startIdx);
  const after = existing.slice(endIdx + MARKER_END.length);

  // Stitch the two halves back together and collapse the gap. A block
  // that stood alone between two blank lines would otherwise leave four
  // consecutive newlines behind.
  let next = before + after;

  // Collapse any run of 3+ newlines down to exactly 2 (one blank line).
  next = next.replace(/\n{3,}/g, '\n\n');

  // Trim trailing whitespace-only lines but keep exactly one final newline
  // when the file still has content.
  next = next.replace(/\s+$/g, '');
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
  expandHome,
  upsertManagedBlock,
  removeManagedBlock,
};
