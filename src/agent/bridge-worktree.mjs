/**
 * Bridge worker git-worktree isolation (v0.6.243).
 *
 * Problem: parallel bridge workers editing overlapping files caused
 *   - plugin.json version bump races (workers 24 & 25)
 *   - stalled mid-write corrupting a file another worker was reading
 *     (worker 21's 0-byte openai-oauth-ws.mjs)
 *   - zombie sessions (pre-worker 23) making edits after user reject
 *
 * Fix: every bridge dispatch gets a private git worktree rooted at
 *   <PLUGIN_ROOT>/.mixdog-worktrees/<sessionId>/ on branch
 *   mixdog/worker/<sessionId>. The worker's cwd is the worktree; main
 *   checkout is untouched until the Lead explicitly merges.
 *
 * Non-goals:
 *   - No auto-merge. The Lead (user session) decides per-worker.
 *   - No worktrees for non-bridge tools (recall/search/explore are RO).
 *
 * Fallback contract: if worktree creation fails (disk full, old git,
 * detached HEAD, merge-in-progress, non-git root, …) the dispatch
 * falls back to shared-cwd mode and logs `[bridge] worktree unavailable`
 * — never hard-fails.
 */

import { execSync } from 'child_process';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
} from 'fs';
import { join, resolve, relative, sep } from 'path';

const WORKTREE_DIR_NAME = '.mixdog-worktrees';
const BRANCH_PREFIX = 'mixdog/worker/';
// sessionId validator: UUID-ish. We deliberately DO NOT restrict to
// canonical UUID-36 because the orchestrator historically prefixes
// ("sess_", "bridge_") and hex-suffixes. The rule is: allow letters,
// digits, `_`, `-`, `.` (non-leading). Reject path separators, `..`,
// whitespace, null bytes, control chars.
const SAFE_SESSION_ID = /^[A-Za-z0-9_][A-Za-z0-9_\-.]{2,127}$/;

function nowIso() {
    try { return new Date().toISOString(); } catch { return ''; }
}

/**
 * Test-hook surface. Production code calls the real `git` via execSync;
 * tests override `runGit` to simulate failures. Never mutates global.
 * @typedef {Object} Hooks
 * @property {(args: string[], opts: { cwd: string }) => string} [runGit]
 * @property {(msg: string) => void} [log]
 */

function defaultRunGit(args, opts = {}) {
    const cmd = `git ${args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
    return execSync(cmd, {
        cwd: opts.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
    }).toString();
}

function defaultLog(msg) {
    try { process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n'); } catch { /* best-effort */ }
}

/**
 * Validate a sessionId is safe to use as a filesystem + branch component.
 * Rejects `..`, path separators, control chars, and anything that would
 * let an attacker escape the `.mixdog-worktrees/` prefix.
 * @param {string} sessionId
 * @returns {string|null} error message or null if ok
 */
export function validateSessionId(sessionId) {
    if (typeof sessionId !== 'string') return 'sessionId must be a string';
    if (!sessionId) return 'sessionId is empty';
    if (!SAFE_SESSION_ID.test(sessionId)) return `sessionId contains unsafe characters: ${JSON.stringify(sessionId)}`;
    if (sessionId.includes('..')) return 'sessionId contains ".."';
    if (sessionId.includes('/') || sessionId.includes('\\')) return 'sessionId contains path separator';
    return null;
}

/**
 * Compute the absolute worktree path for a given session. Throws if
 * the computed path would escape the plugin root (defense-in-depth on
 * top of validateSessionId).
 * @param {string} pluginRoot
 * @param {string} sessionId
 */
export function worktreePathFor(pluginRoot, sessionId) {
    const err = validateSessionId(sessionId);
    if (err) throw new Error(`[bridge-worktree] ${err}`);
    const base = resolve(pluginRoot, WORKTREE_DIR_NAME);
    const target = resolve(base, sessionId);
    // target must be a strict descendant of base — no `../` tricks.
    const rel = relative(base, target);
    if (rel.startsWith('..') || rel.includes(`..${sep}`) || resolve(base, rel) !== target) {
        throw new Error(`[bridge-worktree] computed path escapes plugin root: ${target}`);
    }
    return target;
}

function branchFor(sessionId) {
    return `${BRANCH_PREFIX}${sessionId}`;
}

/**
 * Check that the plugin root is a git repo in a state that supports
 * worktree creation. Returns `null` if ok, or a reason string if not.
 */
function diagnosePluginRoot(pluginRoot, runGit) {
    // .git may be a dir (normal repo) OR a file (submodule / worktree).
    // Both are acceptable; just needs to exist.
    const gitPath = join(pluginRoot, '.git');
    if (!existsSync(gitPath)) return 'not a git repo (.git missing)';
    // Refuse during in-progress merge/rebase/cherry-pick — creating a
    // worktree from HEAD mid-merge produces surprising results.
    try {
        const gitDir = runGit(['rev-parse', '--git-common-dir'], { cwd: pluginRoot }).trim();
        const absGitDir = resolve(pluginRoot, gitDir);
        for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply']) {
            if (existsSync(join(absGitDir, marker))) return `plugin root is mid-${marker.toLowerCase()}`;
        }
    } catch (e) {
        return `git rev-parse failed: ${e.message || e}`;
    }
    try {
        const head = runGit(['symbolic-ref', '-q', 'HEAD'], { cwd: pluginRoot }).trim();
        if (!head) return 'detached HEAD';
    } catch {
        return 'detached HEAD';
    }
    return null;
}

/**
 * Create a symlink from `<worktree>/node_modules` to `<pluginRoot>/node_modules`
 * so the worker can `import` its deps without copying. Best-effort: on
 * Windows-without-admin symlinks can fail; we tolerate that and let the
 * worker walk up (node's module resolution falls back to parent dirs).
 */
function tryLinkNodeModules(pluginRoot, worktreePath, log) {
    try {
        const src = join(pluginRoot, 'node_modules');
        if (!existsSync(src)) return; // no deps installed — nothing to link
        const dst = join(worktreePath, 'node_modules');
        if (existsSync(dst)) return; // already provided (e.g. idempotent re-create)
        // Use junction on Windows (doesn't need admin), symlink dir elsewhere.
        const type = process.platform === 'win32' ? 'junction' : 'dir';
        symlinkSync(src, dst, type);
    } catch (e) {
        // Not fatal: node will resolve node_modules by walking up from the
        // worktree dir into the plugin root parent chain.
        log(`[bridge-worktree] node_modules link skipped: ${e.message || e}`);
    }
}

/**
 * Check whether a worktree already registered for this sessionId points
 * at our expected path. Returns { exists, valid } — valid=true means
 * the directory + registration match and we can reuse it idempotently.
 */
function probeExistingWorktree(pluginRoot, sessionId, expectedPath, runGit) {
    let registered = false;
    try {
        const list = runGit(['worktree', 'list', '--porcelain'], { cwd: pluginRoot });
        // Porcelain: blocks separated by blank lines, first line per block
        // is `worktree <absolute-path>`.
        const paths = [];
        for (const line of list.split(/\r?\n/)) {
            const m = /^worktree\s+(.+)$/.exec(line);
            if (m) paths.push(resolve(m[1]));
        }
        registered = paths.some(p => p === resolve(expectedPath));
    } catch {
        // fall through — treat as not registered
    }
    const onDisk = existsSync(expectedPath);
    return { registered, onDisk };
}

/**
 * Create (or idempotently reuse) a private worktree for a bridge worker.
 * Never throws: on any failure returns `{ fallback: true, ... }` with
 * `path` set to the original plugin root so the caller can proceed in
 * shared-cwd mode.
 *
 * @param {string} sessionId
 * @param {string} pluginRoot
 * @param {Hooks}  [hooks]
 * @returns {{ path: string, branch: string|null, fallback: boolean, reason?: string, reused?: boolean }}
 */
export function createWorkerWorktree(sessionId, pluginRoot, hooks = {}) {
    const runGit = hooks.runGit || defaultRunGit;
    const log = hooks.log || defaultLog;

    const validationErr = validateSessionId(sessionId);
    if (validationErr) {
        // Path-safety failures are a programmer bug, not a recoverable
        // fallback — surface to the caller so dispatch refuses the job.
        throw new Error(`[bridge-worktree] ${validationErr}`);
    }
    if (!pluginRoot || typeof pluginRoot !== 'string') {
        throw new Error('[bridge-worktree] pluginRoot is required');
    }

    const worktreePath = worktreePathFor(pluginRoot, sessionId);
    const branch = branchFor(sessionId);

    const diagnosis = diagnosePluginRoot(pluginRoot, runGit);
    if (diagnosis) {
        log(`[bridge] worktree unavailable, running in shared mode — ${diagnosis}`);
        return { path: pluginRoot, branch: null, fallback: true, reason: diagnosis };
    }

    // Ensure the container dir exists.
    try { mkdirSync(resolve(pluginRoot, WORKTREE_DIR_NAME), { recursive: true }); } catch { /* best-effort */ }

    // Idempotent re-create: if a worktree is already registered at this
    // path, just return it.
    const probe = probeExistingWorktree(pluginRoot, sessionId, worktreePath, runGit);
    if (probe.registered && probe.onDisk) {
        tryLinkNodeModules(pluginRoot, worktreePath, log);
        return { path: worktreePath, branch, fallback: false, reused: true };
    }

    // If there's a stale directory but no registration, clear it — the
    // next `git worktree add` would otherwise fail with "already exists".
    if (probe.onDisk && !probe.registered) {
        try { rmSync(worktreePath, { recursive: true, force: true }); }
        catch (e) {
            log(`[bridge-worktree] cannot clear stale path ${worktreePath}: ${e.message || e}`);
            log(`[bridge] worktree unavailable, running in shared mode`);
            return { path: pluginRoot, branch: null, fallback: true, reason: 'stale path blocks create' };
        }
    }

    // Create worktree + branch in one command.
    const relPath = `${WORKTREE_DIR_NAME}/${sessionId}`;
    try {
        runGit(['worktree', 'add', '-b', branch, relPath, 'HEAD'], { cwd: pluginRoot });
    } catch (e) {
        const msg = (e && (e.stderr?.toString?.() || e.message)) || String(e);
        log(`[bridge] worktree unavailable, running in shared mode — git worktree add failed: ${msg.trim()}`);
        return { path: pluginRoot, branch: null, fallback: true, reason: `git worktree add failed: ${msg.trim()}` };
    }

    tryLinkNodeModules(pluginRoot, worktreePath, log);
    return { path: worktreePath, branch, fallback: false, reused: false };
}

/**
 * Tear down a worker worktree and its branch. Idempotent: missing
 * worktree / missing branch are no-ops. Force-removes even if the
 * branch has unpushed commits (workers never push anyway) but emits
 * a WARN log first so ops can audit.
 *
 * @param {string} sessionId
 * @param {string} pluginRoot
 * @param {Hooks & { reason?: string }} [options]
 * @returns {{ removed: boolean, branchDeleted: boolean, warnings: string[] }}
 */
export function cleanupWorkerWorktree(sessionId, pluginRoot, options = {}) {
    const runGit = options.runGit || defaultRunGit;
    const log = options.log || defaultLog;
    const reason = options.reason || 'cleanup';

    const validationErr = validateSessionId(sessionId);
    if (validationErr) throw new Error(`[bridge-worktree] ${validationErr}`);

    const worktreePath = worktreePathFor(pluginRoot, sessionId);
    const branch = branchFor(sessionId);
    const warnings = [];

    let removed = false;
    let branchDeleted = false;

    // Detect unpushed commits before nuking — audit trail, not a blocker.
    try {
        const head = runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: pluginRoot }).trim();
        if (head) {
            try {
                const baseHead = runGit(['rev-parse', 'HEAD'], { cwd: pluginRoot }).trim();
                if (head !== baseHead) {
                    try {
                        const ahead = runGit(['rev-list', '--count', `${baseHead}..${head}`], { cwd: pluginRoot }).trim();
                        const n = Number(ahead) || 0;
                        if (n > 0) {
                            const w = `[bridge-worktree] WARN branch ${branch} has ${n} unpushed commit(s); force-removing anyway (${reason})`;
                            warnings.push(w);
                            log(w);
                        }
                    } catch { /* ignore rev-list failure */ }
                }
            } catch { /* ignore */ }
        }
    } catch { /* branch doesn't exist — fine */ }

    // git worktree remove --force (handles locked worktrees too).
    if (existsSync(worktreePath)) {
        try {
            runGit(['worktree', 'remove', '--force', `${WORKTREE_DIR_NAME}/${sessionId}`], { cwd: pluginRoot });
            removed = true;
        } catch (e) {
            // Fall through to manual rm — git might already have lost
            // the registration (e.g. someone rm -rf'd the dir).
            const msg = (e && (e.stderr?.toString?.() || e.message)) || String(e);
            log(`[bridge-worktree] worktree remove failed for ${sessionId}: ${msg.trim()} — falling back to rm`);
            try {
                rmSync(worktreePath, { recursive: true, force: true });
                removed = true;
            } catch (e2) {
                log(`[bridge-worktree] rm fallback failed for ${sessionId}: ${e2.message || e2}`);
            }
            // Prune dangling worktree registration regardless.
            try { runGit(['worktree', 'prune'], { cwd: pluginRoot }); } catch { /* ignore */ }
        }
    } else {
        // Dir already gone — prune any stale registration silently.
        try { runGit(['worktree', 'prune'], { cwd: pluginRoot }); } catch { /* ignore */ }
    }

    // Delete the branch (force, -D) — workers own their branch entirely.
    try {
        runGit(['branch', '-D', branch], { cwd: pluginRoot });
        branchDeleted = true;
    } catch {
        // Branch may already be gone (e.g. worktree remove pruned it).
        branchDeleted = false;
    }

    log(`[bridge-worktree] cleanup sessionId=${sessionId} removed=${removed} branchDeleted=${branchDeleted} reason=${reason} at=${nowIso()}`);

    return { removed, branchDeleted, warnings };
}

/**
 * Scan `.mixdog-worktrees/` for directories whose sessionId is not in the
 * provided live-set. Useful on MCP boot: pass the set of sessionIds from
 * listSessions() that are still `running`, everything else is an orphan.
 *
 * @param {string} pluginRoot
 * @param {Set<string>|string[]} activeSessionIds
 * @param {Hooks} [hooks]
 * @returns {string[]} session ids identified as orphans (also the dir names)
 */
export function listOrphanedWorktrees(pluginRoot, activeSessionIds, hooks = {}) {
    const log = hooks.log || defaultLog;
    const active = activeSessionIds instanceof Set
        ? activeSessionIds
        : new Set(Array.isArray(activeSessionIds) ? activeSessionIds : []);
    const base = resolve(pluginRoot, WORKTREE_DIR_NAME);
    if (!existsSync(base)) return [];
    let entries;
    try { entries = readdirSync(base, { withFileTypes: true }); }
    catch (e) {
        log(`[bridge-worktree] orphan scan read failed: ${e.message || e}`);
        return [];
    }
    const orphans = [];
    for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const id = ent.name;
        if (validateSessionId(id) !== null) continue; // skip unsafe names — leave for humans
        if (active.has(id)) continue;
        orphans.push(id);
    }
    return orphans;
}

/**
 * Convenience wrapper: find and clean up orphaned worktrees in one call.
 * Called by server.mjs on boot.
 *
 * @param {string} pluginRoot
 * @param {Set<string>|string[]} activeSessionIds
 * @param {Hooks} [hooks]
 * @returns {{ scanned: number, cleaned: string[], failures: Array<{id: string, error: string}> }}
 */
export function sweepOrphanedWorktrees(pluginRoot, activeSessionIds, hooks = {}) {
    const log = hooks.log || defaultLog;
    const orphans = listOrphanedWorktrees(pluginRoot, activeSessionIds, hooks);
    const cleaned = [];
    const failures = [];
    for (const id of orphans) {
        try {
            cleanupWorkerWorktree(id, pluginRoot, { ...hooks, reason: 'boot-sweep' });
            cleaned.push(id);
        } catch (e) {
            failures.push({ id, error: e.message || String(e) });
        }
    }
    if (orphans.length > 0) {
        log(`[bridge-worktree] boot sweep — scanned=${orphans.length} cleaned=${cleaned.length} failed=${failures.length}`);
    }
    return { scanned: orphans.length, cleaned, failures };
}
