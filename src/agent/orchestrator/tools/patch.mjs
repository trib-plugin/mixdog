// apply_patch — one-turn multi-file edits from a unified diff.
//
// Inverse of the `diff` tool. Typical Lead workflow without this tool is
// `read` → `edit` (or `multi_edit` / `edit_lines`) per file, which costs
// N+1 turns for an N-file refactor. A unified diff already encodes every
// hunk's surrounding context, so we can apply the whole patch server-side
// and skip the read round-trips entirely.
//
// Backend: the `diff` npm package (v9+). `parsePatch(str)` splits a multi-
// file diff into one object per file with `{oldFileName, newFileName,
// hunks}`. `applyPatch(source, patch)` returns the new content or `false`
// when any hunk can't be located (context mismatch).
//
// Safety model (diverges from edit/multi_edit/edit_lines):
//   - No Read-before-Edit requirement. The patch's context lines are
//     themselves the "proof of read" — if they don't match, applyPatch
//     rejects the hunk and nothing is written.
//   - Still mtime-guarded against concurrent external writes: we stat
//     before reading and stat again immediately before writing; if the
//     mtime advanced between those two points another writer touched the
//     file and we abort that entry (errorCode 7 parity).
//   - isSafePath scope-checked per file so a malicious patch can't escape
//     cwd (or $HOME) via `../..` in the header path.
//
// With `reject_partial: true` (the default) the whole batch is two-phase:
// we build every file's new content in memory first; only if all files
// succeeded do we write any of them. This matches the atomic semantics
// of `batch_edit` and keeps a failed patch from landing a half-applied
// tree.

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve as pathResolve, isAbsolute } from 'node:path';
import { parsePatch, applyPatch } from 'diff';
import {
  normalizeInputPath,
  normalizeOutputPath,
  isSafePath,
  atomicWrite,
  invalidateBuiltinResultCache,
  recordReadSnapshotForPath,
  clearReadSnapshotForPath,
} from './builtin.mjs';
import { markCodeGraphDirtyPaths } from './code-graph.mjs';
import { getCapabilities } from '../../../shared/config.mjs';

const DEV_NULL = /^\/dev\/null$/;

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
  return isAbsolute(norm) ? pathResolve(norm) : pathResolve(basePath, norm);
}

function resolveBasePath(cwd, basePath) {
  if (!basePath) return cwd;
  const norm = normalizeInputPath(basePath);
  return isAbsolute(norm) ? pathResolve(norm) : pathResolve(cwd, norm);
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

async function apply_patch(args, cwd) {
  const patchStr = typeof args?.patch === 'string' ? args.patch : '';
  if (!patchStr.trim()) {
    throw new Error('apply_patch: "patch" is required (unified diff string)');
  }
  const basePath = resolveBasePath(cwd, args?.base_path);
  const dryRun = args?.dry_run === true;
  // B2: capability-gated HOME access. Scope check below honours the same
  // `allowHome` flag the builtin tools read, so patches can't escape cwd
  // unless `capabilities.homeAccess` is explicitly enabled.
  let allowHome = false;
  try { allowHome = getCapabilities().homeAccess === true; } catch { allowHome = false; }
  const pathOpts = { allowHome };
  // Default true — atomic batch semantics match batch_edit.
  const rejectPartial = args?.reject_partial !== false;
  if (!isSafePath(basePath, cwd, pathOpts)) {
    return `Error: base_path outside allowed scope — ${normalizeOutputPath(basePath)}`;
  }

  let parsed;
  try {
    parsed = parsePatch(patchStr);
  } catch (err) {
    return `Error: failed to parse patch: ${err?.message || err}`;
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
    if (!isSafePath(fullPath, basePath, pathOpts) && !isSafePath(fullPath, cwd, pathOpts)) {
      plan.push({
        ok: false,
        index: i,
        displayPath,
        error: `path outside allowed scope — ${displayPath}`,
      });
      continue;
    }

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
      // downstream rename fails mid-batch.
      let preContent = '';
      try { preContent = readFileSync(fullPath, 'utf-8'); } catch { /* best-effort; rollback may be lossy for binary deletes */ }
      plan.push({
        ok: true, index: i, kind, fullPath, displayPath,
        preContent, preMtime: stat.mtimeMs,
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
    try { source = readFileSync(fullPath, 'utf-8'); }
    catch (err) {
      plan.push({ ok: false, index: i, displayPath, error: err?.message || String(err) });
      continue;
    }
    // Keep the original content for rollback: when reject_partial:true and
    // a mid-batch rename fails, we replay this snapshot back onto disk for
    // every file we already rewrote.
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
      newContent: merged, preContent, preMtime: stat.mtimeMs,
      hunks_applied: entry.hunks?.length || 0,
      lines_changed: added + removed,
    });
  }

  const failures = plan.filter(p => !p.ok);
  const successes = plan.filter(p => p.ok);

  // Dry-run short-circuit. Report everything without touching disk.
  if (dryRun) {
    const lines = [`dry-run: ${plan.length} file(s), ${successes.length} ok, ${failures.length} failed`];
    for (const p of plan) {
      if (p.ok) {
        lines.push(`  OK   ${p.kind.padEnd(6)} ${p.displayPath} (${p.lines_changed} lines changed across ${p.hunks_applied} hunk${p.hunks_applied === 1 ? '' : 's'})`);
      } else {
        lines.push(`  FAIL ${(p.displayPath || '(unknown)').padEnd(0)} — ${p.error}`);
        if (p.firstFailedHunk) {
          const h = p.firstFailedHunk;
          lines.push(`       @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
        }
      }
    }
    return lines.join('\n');
  }

  // Atomic mode: if any entry failed and reject_partial is set, abort.
  if (failures.length > 0 && rejectPartial) {
    const lines = [`Error: patch rejected (${failures.length} of ${plan.length} file(s) failed; reject_partial=true, nothing written)`];
    for (const p of failures) {
      lines.push(`  FAIL ${p.displayPath || '(unknown)'} — ${p.error}`);
      if (p.firstFailedHunk) {
        const h = p.firstFailedHunk;
        lines.push(`       @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
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
  const { unlinkSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const written = [];
  const skipped = [];

  const persistOne = async (p) => {
    if (p.kind === 'delete') {
      const curStat = statSync(p.fullPath);
      if (curStat.mtimeMs > p.preMtime + 1) {
        throw Object.assign(new Error('file modified since read (mtime drift)'), { __skip: true });
      }
      unlinkSync(p.fullPath);
    } else if (p.kind === 'create') {
      mkdirSync(dirname(p.fullPath), { recursive: true });
      await atomicWrite(p.fullPath, p.newContent);
    } else {
      const curStat = statSync(p.fullPath);
      if (curStat.mtimeMs > p.preMtime + 1) {
        throw Object.assign(new Error('file modified since read (mtime drift)'), { __skip: true });
      }
      await atomicWrite(p.fullPath, p.newContent);
    }
  };

  const rollbackOne = async (p) => {
    // Best-effort reversal. For modify/delete we have `preContent`; for
    // create we unlink the newly-written file. Rollback failures are
    // surfaced in the output so the operator knows which files are in a
    // transient bad state.
    if (p.kind === 'create') {
      try { unlinkSync(p.fullPath); } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    } else {
      // modify / delete — restore original bytes. For delete, this
      // recreates the file; for modify, it rewrites with the pre-patch
      // content. atomicWrite is crash-safe here too.
      await atomicWrite(p.fullPath, p.preContent ?? '');
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
  }

  const lines = [];
  lines.push(`applied: ${written.length} file(s)` + (failures.length ? `, ${failures.length} failed` : '') + (skipped.length ? `, ${skipped.length} skipped` : ''));
  if (written.length > 0) {
    invalidateBuiltinResultCache(written.map((p) => p.fullPath));
    markCodeGraphDirtyPaths(cwd, written.map((p) => p.fullPath));
    for (const p of written) {
      if (p.kind === 'delete') clearReadSnapshotForPath(p.fullPath);
      else recordReadSnapshotForPath(p.fullPath);
    }
  }
  for (const p of written) {
    lines.push(`  OK   ${p.kind.padEnd(6)} ${p.displayPath} (${p.lines_changed} lines changed across ${p.hunks_applied} hunk${p.hunks_applied === 1 ? '' : 's'})`);
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
    description: 'Apply a unified-diff patch in ONE turn — inverse of `diff`. Prefer this over repeated `read` → `edit` loops when 2+ files change or the exact edit is already clear. Single/multi-file diffs (git-style `--- a/` / `+++ b/` headers, `a/` `b/` prefixes stripped). Patch context lines self-verify, so it skips the normal read-before-edit round-trip. `/dev/null` → new file creates; file → `/dev/null` deletes. Default atomic (`reject_partial:true`) — any failed hunk rejects whole patch. Use `dry_run:true` to preview changes + first failed hunk without writing. Paths resolve against `base_path` (or cwd), scope-checked like other write tools.',
    inputSchema: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'Unified diff content. Single-file or multi-file. Supports git-style `a/` / `b/` header prefixes and `/dev/null` for create/delete entries.' },
        base_path: { type: 'string', description: 'Directory to resolve relative paths from the diff headers against. Default: current working directory.' },
        dry_run: { type: 'boolean', description: 'Preview which files would change without writing. Shows first failed hunk per failing file. Default false.' },
        reject_partial: { type: 'boolean', description: 'If any file\'s hunk fails, reject the whole patch and write nothing (atomic). Default true. Set false to apply every successful file even when others failed.' },
      },
      required: ['patch'],
    },
  },
];

export async function executePatchTool(name, args, cwd) {
  const effectiveCwd = cwd || process.cwd();
  switch (name) {
    case 'apply_patch': return apply_patch(args || {}, effectiveCwd);
    default: throw new Error(`Unknown patch tool: ${name}`);
  }
}
