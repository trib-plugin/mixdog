// apply_patch — one-turn multi-file edits from a unified diff.
//
// Typical Lead workflow without this tool is `read` → `edit` per file, which
// costs N+1 turns for an N-file refactor. A unified diff already encodes
// every hunk's surrounding context, so we can apply the whole patch
// server-side and skip the read round-trips entirely.
//
// Backend: the `diff` npm package (v9+). `parsePatch(str)` splits a multi-
// file diff into one object per file with `{oldFileName, newFileName,
// hunks}`. `applyPatch(source, patch)` returns the new content or `false`
// when any hunk can't be located (context mismatch).
//
// Safety model (diverges from edit):
//   - No Read-before-Edit requirement. The patch's context lines are
//     themselves the "proof of read" — if they don't match, applyPatch
//     rejects the hunk and nothing is written.
//   - Still mtime-guarded against concurrent external writes: we stat
//     before reading and stat again immediately before writing; if the
//     mtime advanced between those two points another writer touched the
//     file and we abort that entry (errorCode 7 parity).
//
// With `reject_partial: true` (the default) the whole batch is two-phase:
// we build every file's new content in memory first; only if all files
// succeeded do we write any of them. Atomic batch semantics keep a
// failed patch from landing a half-applied tree.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve as pathResolve, isAbsolute, dirname as pathDirname } from 'node:path';
import { parsePatch, applyPatch } from 'diff';
import {
  normalizeInputPath,
  normalizeOutputPath,
  resolveAgainstCwd,
  atomicWrite,
  invalidateBuiltinResultCache,
  recordReadSnapshotForPath,
  clearReadSnapshotForPath,
} from './builtin.mjs';
import { markCodeGraphDirtyPaths } from './code-graph.mjs';

const DEV_NULL = /^\/dev\/null$/;

function hashText(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex');
}

// Strip the leading `a/` or `b/` prefix that `diff -u` / git emit by
// default, plus timestamp suffixes (`\t2024-...`) that some tools append
// to header lines. parsePatch already splits the name from the header
// so timestamps land in `oldHeader` / `newHeader`, but be defensive.
function stripDiffPrefix(name) {
  if (!name) return name;
  // `parsePatch` leaves the raw "a/foo.ts" form in oldFileName. Git-style
  // prefixes are the near-universal convention — strip one leading `a/`
  // or `b/` component. Skip the strip when the path looks absolute
  // (starts with `/` or a Windows drive letter) because those never have
  // a git prefix.
  if (isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name)) return name;
  const m = /^[ab]\/(.+)$/.exec(name);
  return m ? m[1] : name;
}

function resolveEntryPath(basePath, rawName) {
  const stripped = stripDiffPrefix(rawName);
  const norm = normalizeInputPath(stripped);
  return isAbsolute(norm) ? pathResolve(norm) : resolveAgainstCwd(norm, basePath);
}

function resolveBasePath(cwd, basePath) {
  if (!basePath) return cwd;
  const norm = normalizeInputPath(basePath);
  return isAbsolute(norm) ? pathResolve(norm) : resolveAgainstCwd(norm, cwd);
}

// Categorise the per-file entry. A unified diff can describe:
//   - modify   : both files named, oldFileName exists on disk
//   - create   : oldFileName === /dev/null (or file doesn't exist + hunks start at 0)
//   - delete   : newFileName === /dev/null
function classifyEntry(entry) {
  const oldIsNull = DEV_NULL.test(entry.oldFileName || '');
  const newIsNull = DEV_NULL.test(entry.newFileName || '');
  if (oldIsNull && !newIsNull) return 'create';
  if (!oldIsNull && newIsNull) return 'delete';
  return 'modify';
}

// Rebuild the post-patch content for a create entry. `applyPatch` on an
// empty string works for create patches so we reuse it rather than
// hand-rolling a line splice.
function buildCreateContent(entry) {
  const out = applyPatch('', entry);
  return out === false ? null : out;
}

// Count how many source lines a hunk consumes vs produces so we can
// surface a concise `lines_changed` figure without re-diffing.
function countHunkChanges(hunks) {
  let added = 0;
  let removed = 0;
  for (const h of hunks || []) {
    for (const line of h.lines || []) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  return { added, removed };
}

// Lenient hunk-header repair. The `diff` package validates the line
// counts declared in `@@ -A,B +C,D @@` against the actual body and
// throws when they disagree. LLM-authored patches frequently ship
// with stale counts (body is correct but the writer mis-counted
// while editing). When the initial parsePatch fails for that reason
// we re-derive B and D from the body and retry once. Body lines are
// classified as: ' ' = context (counts toward both old and new),
// '-' = removed (old only), '+' = added (new only), '\\' = "No
// newline at end of file" marker (skipped). Only header metadata
// is rewritten, never hunk body lines, so a body that doesn't match
// the real source is still rejected by applyPatch downstream — the
// safety floor stays intact.
export function normalizeHunkHeaders(patchStr) {
  // Normalize CRLF/LF line endings up front so trailing `\r` from
  // Windows-emitted patches doesn't leak into the rebuilt hunk header
  // tail or get misclassified as a body line.
  // Also strip a leading UTF-8 BOM (`\uFEFF`) so the first FILE_HEADER_RE
  // and HUNK_RE matches don't fail on diffs saved by editors that prepend
  // the BOM (Notepad, some PowerShell redirections).
  const lines = String(patchStr).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
  const FILE_HEADER_RE = /^(?:--- |\+\+\+ |diff )/;
  const out = [];
  let mutated = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = HUNK_RE.exec(line);
    if (!m) { out.push(line); i++; continue; }
    const oldStart = m[1];
    const newStart = m[3];
    const tail = m[5] || '';
    let j = i + 1;
    let oldCount = 0;
    let newCount = 0;
    while (j < lines.length) {
      const bl = lines[j];
      if (HUNK_RE.test(bl) || FILE_HEADER_RE.test(bl)) break;
      const c = bl.length > 0 ? bl[0] : '';
      if (c === ' ') { oldCount++; newCount++; }
      else if (c === '-') { oldCount++; }
      else if (c === '+') { newCount++; }
      // '\\' = "No newline at end of file" marker; '' = stray blank — skip both
      j++;
    }
    const rebuilt = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${tail}`;
    if (rebuilt !== line) mutated = true;
    out.push(rebuilt);
    for (let k = i + 1; k < j; k++) out.push(lines[k]);
    i = j;
  }
  return { patch: out.join('\n'), mutated };
}

async function apply_patch(args, cwd, options = {}) {
  // Strip a leading UTF-8 BOM up-front: editors / PowerShell redirections
  // sometimes prepend `\uFEFF` to text files and the bare BOM trips both
  // parsePatch and the lenient `/^@@ -\d/m` envelope check.
  const patchStr = (typeof args?.patch === 'string' ? args.patch : '').replace(/^\uFEFF/, '');
  if (!patchStr.trim()) {
    throw new Error('apply_patch: "patch" is required (unified diff string)');
  }
  const readStateScope = options?.readStateScope ?? options?.sessionId ?? null;
  const basePath = resolveBasePath(cwd, args?.base_path);
  const dryRun = args?.dry_run === true;
  // Default true — atomic batch semantics.
  const rejectPartial = args?.reject_partial !== false;
  // Strict parse first. Fall back to lenient repair whenever a hunk
  // header is present — stale line counts from LLM-authored patches
  // are the dominant failure mode, and lenient retry only rewrites
  // header metadata (counts), never body lines, so applyPatch still
  // rejects a body that doesn't match the real source. If lenient
  // retry also fails, the original strict error surfaces unchanged.
  let parsed = null;
  let parseErr = null;
  let lenientApplied = false;
  try {
    parsed = parsePatch(patchStr);
  } catch (err) {
    parseErr = err?.message || String(err);
  }
  if (!parsed && /^@@ -\d/m.test(patchStr)) {
    try {
      const { patch: normalized, mutated } = normalizeHunkHeaders(patchStr);
      if (mutated) {
        parsed = parsePatch(normalized);
        if (parsed) lenientApplied = true;
      }
    } catch { /* fall through to the original error */ }
  }
  if (!parsed) {
    return `Error: failed to parse patch: ${parseErr || 'unknown'}`;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return 'Error: patch contained no file sections';
  }

  // Phase 1 — compute new content for every entry without touching disk.
  // Each plan row is the minimum set of inputs phase 2 needs to persist
  // the change (or to render a dry-run summary).
  const plan = [];

  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    const kind = classifyEntry(entry);
    // For create, anchor the on-disk path on newFileName (oldFileName is /dev/null).
    const headerName = kind === 'create' ? entry.newFileName : entry.oldFileName;
    if (!headerName) {
      plan.push({ ok: false, index: i, error: 'missing file header in patch section' });
      continue;
    }
    const strippedHeader = stripDiffPrefix(headerName);
    const displayPath = normalizeOutputPath(strippedHeader);

    // Scope-check the resolved absolute path, not the raw header, so
    // `a/../../escape.txt` is caught after path resolution.
    const fullPath = resolveEntryPath(basePath, headerName);
    const { added, removed } = countHunkChanges(entry.hunks);

    if (kind === 'delete') {
      let stat;
      try { stat = statSync(fullPath); }
      catch (err) {
        if (err?.code === 'ENOENT') {
          plan.push({ ok: false, index: i, displayPath, error: `delete target missing: ${displayPath}` });
          continue;
        }
        plan.push({ ok: false, index: i, displayPath, error: err?.message || String(err) });
        continue;
      }
      // Read original bytes so rollback can recreate the file if a
      // downstream rename fails mid-batch. Store the raw Buffer
      // alongside the utf-8 decode so phase 2 can do a byte-perfect
      // compare — string compare alone misses invalid-UTF-8 byte
      // changes that both decode to U+FFFD.
      let preContent = '';
      let preBytes = null;
      try {
        preBytes = readFileSync(fullPath);
        preContent = preBytes.toString('utf-8');
      } catch { /* best-effort; rollback may be lossy for binary deletes */ }
      plan.push({
        ok: true, index: i, kind, fullPath, displayPath,
        preContent, preBytes, preMtime: stat.mtimeMs,
        hunks_applied: entry.hunks?.length || 0,
        lines_changed: added + removed,
      });
      continue;
    }

    if (kind === 'create') {
      const newContent = buildCreateContent(entry);
      if (newContent === null) {
        plan.push({
          ok: false, index: i, displayPath,
          error: 'failed to build create content (malformed hunk)',
          firstFailedHunk: entry.hunks?.[0] || null,
        });
        continue;
      }
      // Refuse to overwrite an existing file through a "create" header —
      // that's almost always a sign the patch was generated against a
      // stale tree. Caller can re-emit as a modify patch if intentional.
      let exists = false;
      try { statSync(fullPath); exists = true; } catch {}
      if (exists) {
        plan.push({
          ok: false, index: i, displayPath,
          error: `create target already exists: ${displayPath}`,
        });
        continue;
      }
      plan.push({
        ok: true, index: i, kind, fullPath, displayPath,
        newContent, preMtime: 0,
        hunks_applied: entry.hunks?.length || 0,
        lines_changed: added + removed,
      });
      continue;
    }

    // modify — stat + read + applyPatch
    let stat;
    try { stat = statSync(fullPath); }
    catch (err) {
      if (err?.code === 'ENOENT') {
        plan.push({ ok: false, index: i, displayPath, error: `file not found: ${displayPath}` });
      } else {
        plan.push({ ok: false, index: i, displayPath, error: err?.message || String(err) });
      }
      continue;
    }
    let source;
    let preBytes = null;
    try {
      preBytes = readFileSync(fullPath);
      source = preBytes.toString('utf-8');
    }
    catch (err) {
      plan.push({ ok: false, index: i, displayPath, error: err?.message || String(err) });
      continue;
    }
    // Reject non-UTF-8 input on the modify path: applyPatch operates on
    // strings, so any byte that doesn't round-trip through utf-8 decode →
    // re-encode would be silently rewritten as U+FFFD (EF BF BD) when the
    // result is serialized back. atomicWrite would then corrupt every
    // non-UTF-8 region of the file even though the patch's edits live
    // entirely inside an ASCII span. The lossless alternative (splice the
    // patched span back at the byte level) is hunk-aware and well over the
    // 200-LOC budget for this fix; refusing the entry preserves data
    // integrity and surfaces the issue to the caller.
    if (!Buffer.from(source, 'utf-8').equals(preBytes)) {
      plan.push({
        ok: false, index: i, displayPath,
        error: `file is not valid UTF-8 — apply_patch refuses non-UTF-8 modify targets (would corrupt bytes outside the patched span)`,
      });
      continue;
    }
    // Keep the original content for rollback: when reject_partial:true and
    // a mid-batch rename fails, we replay this snapshot back onto disk for
    // every file we already rewrote. preBytes is the raw Buffer so phase 2
    // can compare bytes directly instead of going through the lossy utf-8
    // round-trip (invalid bytes both decode to U+FFFD).
    const preContent = source;
    // `applyPatch(source, patch)` returns the new string, or `false` when
    // any hunk's context didn't match. There's no per-hunk error detail
    // from the library, so we locate the first rejected hunk by replaying
    // each hunk individually on top of the running buffer.
    const merged = applyPatch(source, entry);
    if (merged === false) {
      let firstFailedHunk = null;
      let running = source;
      for (const h of entry.hunks || []) {
        const stepPatch = { ...entry, hunks: [h] };
        const step = applyPatch(running, stepPatch);
        if (step === false) { firstFailedHunk = h; break; }
        running = step;
      }
      plan.push({
        ok: false, index: i, displayPath,
        error: `hunk rejected (context mismatch)`,
        firstFailedHunk,
      });
      continue;
    }
    plan.push({
      ok: true, index: i, kind, fullPath, displayPath,
      newContent: merged, preContent, preBytes, preMtime: stat.mtimeMs,
      hunks_applied: entry.hunks?.length || 0,
      lines_changed: added + removed,
    });
  }

  const failures = plan.filter(p => !p.ok);
  const successes = plan.filter(p => p.ok);

  // Dry-run short-circuit. Report everything without touching disk.
  if (dryRun) {
    const lines = [];
    if (lenientApplied) lines.push('(lenient: hunk counts re-derived from body)');
    lines.push(`dry-run: ${plan.length} file(s), ${successes.length} ok, ${failures.length} failed`);
    for (const p of plan) {
      if (p.ok) {
        lines.push(`  OK   ${p.kind.padEnd(6)} ${p.displayPath} (${p.lines_changed} lines changed across ${p.hunks_applied} hunk${p.hunks_applied === 1 ? '' : 's'})`);
      } else {
        lines.push(`  FAIL ${(p.displayPath || '(unknown)').padEnd(0)} — ${p.error}`);
        if (p.firstFailedHunk) {
          const h = p.firstFailedHunk;
          lines.push(`       @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
          const expectedText = typeof h.oldText === 'string' ? h.oldText
            : Array.isArray(h.lines) ? h.lines.filter(l => typeof l === 'string' && l.startsWith('-')).map(l => l.slice(1)).join('\n')
            : '';
          const previewLines = expectedText.split('\n').slice(0, 3).map(l => l.length > 80 ? l.slice(0, 77) + '...' : l);
          if (previewLines.some(l => l.length > 0)) {
            lines.push(`       expected:`);
            for (const pl of previewLines) lines.push(`         | ${pl}`);
          }
        }
      }
    }
    return lines.join('\n');
  }

  // Atomic mode: if any entry failed and reject_partial is set, abort.
  if (failures.length > 0 && rejectPartial) {
    const lines = [];
    if (lenientApplied) lines.push('(lenient: hunk counts re-derived from body)');
    lines.push(`Error: patch rejected (${failures.length} of ${plan.length} file(s) failed; reject_partial=true, nothing written)`);
    for (const p of failures) {
      lines.push(`  FAIL ${p.displayPath || '(unknown)'} — ${p.error}`);
      if (p.firstFailedHunk) {
        const h = p.firstFailedHunk;
        lines.push(`       @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
        const expectedText = typeof h.oldText === 'string' ? h.oldText
          : Array.isArray(h.lines) ? h.lines.filter(l => typeof l === 'string' && l.startsWith('-')).map(l => l.slice(1)).join('\n')
          : '';
        const previewLines = expectedText.split('\n').slice(0, 3).map(l => l.length > 80 ? l.slice(0, 77) + '...' : l);
        if (previewLines.some(l => l.length > 0)) {
          lines.push(`       expected:`);
          for (const pl of previewLines) lines.push(`         | ${pl}`);
        }
      }
    }
    return lines.join('\n');
  }

  // Phase 2 — persist successful entries with atomic writes.
  //
  // Each entry is published via atomicWrite (tempfile + fsync + rename)
  // so a crash mid-batch cannot leave a truncated target on disk. Two
  // modes:
  //
  //  reject_partial:true  — "all or nothing". If any rename fails we
  //    roll back every already-written file using the pre-patch
  //    snapshots we captured in phase 1 (atomicWrite again, reversing
  //    to preContent). This is best-effort: a rollback can itself fail
  //    (disk full, permission change), in which case we report the
  //    specific files left in a bad state so the operator can recover.
  //
  //  reject_partial:false — each file is independently atomic; a failure
  //    on file N leaves files 1..N-1 persisted and N..M untouched.
  //
  // Re-stat-before-write mtime check stays in place to catch a concurrent
  // external writer between phase-1 read and phase-2 publish.
  const { unlinkSync, mkdirSync, renameSync, rmdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const written = [];
  const skipped = [];
  // Side-name tombstones: deletes are staged via `rename(orig → orig.tmp)`
  // first so a downstream write failure can be undone (rename back) without
  // reaching for filesystem trash. Finalised by a tail unlink loop only
  // when the whole batch succeeds.
  const DELETE_SIDE_SUFFIX = `.apply_patch-tomb-${process.pid}-${Date.now().toString(36)}`;
  const stagedDeletes = []; // [{ p, sidePath }]
  // Parent directories created during phase 2 for `create` entries. Tracked
  // so a rollback can remove the new dirs we minted (deepest-first), but
  // never an older directory that already existed.
  const createdDirs = []; // [{ p, dirs: ['<deepest>', ..., '<shallowest>'] }]

  function _planNewDirs(targetPath) {
    const newDirs = [];
    let cursor = pathDirname(targetPath);
    // Walk up while the dir doesn't exist; stop at the first existing
    // ancestor. mkdirSync recursive will then create exactly newDirs.
    while (cursor && cursor !== pathDirname(cursor)) {
      let exists = true;
      try { statSync(cursor); } catch { exists = false; }
      if (exists) break;
      newDirs.push(cursor);
      cursor = pathDirname(cursor);
    }
    // Stored deepest-first — same order rollback needs to rmdir from leaf
    // toward root (each must be empty when removed).
    return newDirs;
  }

  // Three-stage drift check: mtime first (cheap, catches the common
  // editor-save case), size next (cheap, no extra IO since statSync
  // already returned size), bytes last (one readFileSync without an
  // encoding so two invalid-UTF-8 sequences that both decode to
  // U+FFFD are still distinguished). Without the byte-perfect final
  // stage an outside edit that lands inside the mtime resolution
  // window with same-size lossy-decode-equal content would silently
  // get overwritten by atomicWrite.
  const _assertUnchangedSinceRead = (p) => {
    const curStat = statSync(p.fullPath);
    if (curStat.mtimeMs > p.preMtime + 1) {
      throw Object.assign(new Error('file modified since read (mtime drift)'), { __skip: true });
    }
    const preByteLen = p.preBytes ? p.preBytes.length : Buffer.byteLength(p.preContent ?? '', 'utf-8');
    if (curStat.size !== preByteLen) {
      throw Object.assign(new Error('file modified since read (size drift)'), { __skip: true });
    }
    // Read raw bytes for the final compare. If even this fails
    // (permission churn, mid-rename, file vanished between stat and
    // read), classify as drift instead of letting an unrelated
    // exception bubble out — atomicWrite would fail anyway and the
    // caller wants a consistent skip classification.
    let curBuf;
    try { curBuf = readFileSync(p.fullPath); }
    catch (err) {
      throw Object.assign(new Error(`file unreadable since read (${err?.code || 'ERR'})`), { __skip: true });
    }
    const preBuf = p.preBytes || Buffer.from(p.preContent ?? '', 'utf-8');
    if (!curBuf.equals(preBuf)) {
      throw Object.assign(new Error('file modified since read (content drift)'), { __skip: true });
    }
  };

  const persistOne = async (p) => {
    const t0 = Date.now();
    if (p.kind === 'delete') {
      _assertUnchangedSinceRead(p);
      // Stage the delete by rename to a sibling tombstone path. Finalize
      // (real unlink) only after every batch entry succeeded; on abort we
      // rename back to restore the original byte-for-byte.
      const sidePath = `${p.fullPath}${DELETE_SIDE_SUFFIX}`;
      renameSync(p.fullPath, sidePath);
      stagedDeletes.push({ p, sidePath });
    } else if (p.kind === 'create') {
      // Compute which ancestor dirs don't exist yet so a rollback can
      // unwind them. Has to happen BEFORE mkdirSync, otherwise every
      // ancestor already exists and the diff-set is empty.
      const newDirs = _planNewDirs(p.fullPath);
      mkdirSync(dirname(p.fullPath), { recursive: true });
      if (newDirs.length) createdDirs.push({ p, dirs: newDirs });
      // Pass flags:'wx' (O_EXCL) so atomicWrite detects a racing writer
      // atomically and aborts rather than clobbering the target.
      await atomicWrite(p.fullPath, p.newContent, { sessionId: options?.sessionId, flags: 'wx' });
    } else {
      _assertUnchangedSinceRead(p);
      await atomicWrite(p.fullPath, p.newContent, { sessionId: options?.sessionId });
    }
    process.stderr.write(`[patch] applied path=${p.displayPath} hunks=${p.hunks_applied} ms=${Date.now() - t0}\n`);
  };

  const rollbackOne = async (p) => {
    // Best-effort reversal. For modify we restore the captured pre-patch
    // bytes via atomicWrite; for delete we rename the tombstone back to
    // its original path; for create we unlink the new file AND remove any
    // parent dirs we minted on the way in. Rollback failures are surfaced
    // in the output so the operator knows which files are in a transient
    // bad state.
    if (p.kind === 'create') {
      try { unlinkSync(p.fullPath); } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      // Remove dirs we created — deepest first. Stop at the first non-
      // empty dir (rmdirSync throws ENOTEMPTY) so we never delete a
      // pre-existing populated directory.
      const tracked = createdDirs.find((entry) => entry.p === p);
      if (tracked) {
        for (const dir of tracked.dirs) {
          try { rmdirSync(dir); }
          catch (err) {
            // ENOTEMPTY / ENOENT are benign — the dir gained content from
            // another concurrent write or was never created. Anything
            // else surfaces as a rollback failure.
            if (err?.code !== 'ENOTEMPTY' && err?.code !== 'ENOENT') throw err;
            break;
          }
        }
      }
    } else if (p.kind === 'delete') {
      // Reverse the rename — original bytes are still on disk under the
      // tombstone path so this is byte-perfect.
      const staged = stagedDeletes.find((s) => s.p === p);
      if (staged) {
        try { renameSync(staged.sidePath, p.fullPath); }
        catch (err) {
          // Fall back to writing the captured bytes if the tombstone
          // disappeared (extremely unlikely; only if something else
          // unlinked it between persist and rollback).
          if (err?.code === 'ENOENT' && p.preBytes) {
            await atomicWrite(p.fullPath, p.preBytes, { sessionId: options?.sessionId });
          } else {
            throw err;
          }
        }
      } else if (p.preBytes ?? p.preContent != null) {
        await atomicWrite(p.fullPath, p.preBytes ?? p.preContent ?? '', { sessionId: options?.sessionId });
      }
    } else {
      // modify — restore original bytes via the raw Buffer when
      // available so invalid-UTF-8 content survives a rollback intact.
      const restoreData = p.preBytes ?? p.preContent ?? '';
      await atomicWrite(p.fullPath, restoreData, { sessionId: options?.sessionId });
    }
  };

  // Tail-unlink the staged delete tombstones. Called only after every
  // entry persisted cleanly so an abort can still rename them back. Any
  // unlink failure here is best-effort (the rename already removed the
  // original); surface as a SKIP rather than failing the whole patch.
  const finalizeStagedDeletes = (target) => {
    for (const staged of target) {
      try { unlinkSync(staged.sidePath); }
      catch (err) {
        if (err?.code !== 'ENOENT') {
          skipped.push({ displayPath: staged.p.displayPath, reason: `tombstone cleanup: ${err?.message || String(err)}` });
        }
      }
    }
  };

  if (rejectPartial) {
    // Staged all-or-nothing. Abort + rollback on first write failure.
    const persistedForRollback = [];
    let abortErr = null;
    let abortedEntry = null;
    for (const p of successes) {
      try {
        await persistOne(p);
        persistedForRollback.push(p);
        written.push(p);
      } catch (err) {
        abortErr = err;
        abortedEntry = p;
        break;
      }
    }
    if (abortErr) {
      // Unwind every file we already persisted. Collect rollback
      // failures separately so they can be surfaced to the caller.
      const rollbackFailures = [];
      for (const done of persistedForRollback.reverse()) {
        try { await rollbackOne(done); }
        catch (rollbackErr) {
          rollbackFailures.push({ displayPath: done.displayPath, reason: rollbackErr?.message || String(rollbackErr) });
        }
      }
      const lines = [`Error: patch aborted mid-apply (reject_partial=true) — ${abortedEntry?.displayPath}: ${abortErr?.message || String(abortErr)}`];
      lines.push(`  rolled back ${persistedForRollback.length} file(s)`);
      for (const rf of rollbackFailures) {
        lines.push(`  ROLLBACK-FAIL ${rf.displayPath} — ${rf.reason}`);
      }
      return lines.join('\n');
    }
    // All persisted — finalize tombstones now that no more aborts are possible.
    finalizeStagedDeletes(stagedDeletes);
  } else {
    // Independent per-file atomic writes. Surviving successes are
    // reported; failures land in `skipped`.
    for (const p of successes) {
      try {
        await persistOne(p);
        written.push(p);
      } catch (err) {
        if (err && err.__skip) {
          skipped.push({ displayPath: p.displayPath, reason: err.message });
        } else {
          skipped.push({ displayPath: p.displayPath, reason: err?.message || String(err) });
        }
      }
    }
    // Per-entry semantics: every staged delete that persisted is its own
    // independent atomic op, so finalize them all unconditionally.
    finalizeStagedDeletes(stagedDeletes);
  }

  const lines = [];
  if (lenientApplied) lines.push('(lenient hunks)');
  const summary = [`applied ${written.length}`];
  if (failures.length) summary.push(`${failures.length} failed`);
  if (skipped.length) summary.push(`${skipped.length} skipped`);
  lines.push(summary.join(', '));
  if (written.length > 0) {
    invalidateBuiltinResultCache(written.map((p) => p.fullPath));
    markCodeGraphDirtyPaths(cwd, written.map((p) => p.fullPath));
    for (const p of written) {
      if (p.kind === 'delete') clearReadSnapshotForPath(p.fullPath, readStateScope);
      else recordReadSnapshotForPath(p.fullPath, readStateScope, {
        source: 'apply_patch',
        isPartialView: false,
        contentHash: hashText(p.newContent),
      });
    }
  }
  for (const p of written) {
    lines.push(`  OK ${p.kind} ${p.displayPath} ±${p.lines_changed}L/${p.hunks_applied}h`);
  }
  for (const p of failures) {
    lines.push(`  FAIL ${p.displayPath || '(unknown)'} — ${p.error}`);
    if (p.firstFailedHunk) {
      const h = p.firstFailedHunk;
      lines.push(`       @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    }
  }
  for (const s of skipped) {
    lines.push(`  SKIP ${s.displayPath} — ${s.reason}`);
  }
  return lines.join('\n');
}

export const PATCH_TOOL_DEFS = [
  {
    name: 'apply_patch',
    title: 'Apply Unified Diff',
    annotations: { title: 'Apply Unified Diff', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Apply a unified-diff patch in ONE turn. Prefer this over repeated `read` → `edit` loops when 2+ files change or the exact edit is already clear. Single/multi-file diffs (git-style `--- a/` / `+++ b/` headers, `a/` `b/` prefixes stripped). Patch context lines self-verify, so it skips the normal read-before-edit round-trip. `/dev/null` → new file creates; file → `/dev/null` deletes. Default atomic (`reject_partial:true`) — any failed hunk rejects whole patch. Use `dry_run:true` to preview changes + first failed hunk without writing. Paths resolve against `base_path` (or cwd), scope-checked like other write tools. For 2+ hunks across different files in one turn, batch all hunks into a single patch string rather than making multiple `apply_patch` calls.',
    inputSchema: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'Unified diff. Single or multi-file. Git-style `a/`/`b/` headers; `/dev/null` for create/delete.' },
        base_path: { type: 'string', description: 'Directory to resolve diff-header paths against. Default cwd.' },
        dry_run: { type: 'boolean', description: 'Preview without writing. Shows first failed hunk per file. Default false.' },
        reject_partial: { type: 'boolean', description: 'If any hunk fails, reject the whole patch (atomic). Default true; false to apply each successful file independently.' },
      },
      required: ['patch'],
    },
  },
];

export async function executePatchTool(name, args, cwd, options = {}) {
  const effectiveCwd = cwd || process.cwd();
  switch (name) {
    case 'apply_patch': return apply_patch(args || {}, effectiveCwd, options);
    default: throw new Error(`Unknown patch tool: ${name}`);
  }
}
