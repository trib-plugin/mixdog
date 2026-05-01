/**
 * status-snapshot.mjs — v0.1.19
 *
 * Writes <DATA_DIR>/channels/status-snapshot.json every 10 seconds so that
 * setup-server can read cross-process state (cron next-fire, deferred count,
 * Discord unread, ngrok tunnel URL) without IPC.
 *
 * Atomic write: tmp → rename so readers never see a partial file.
 *
 * Usage (from channels/index.mjs):
 *   import { startSnapshotWriter } from './lib/status-snapshot.mjs';
 *   startSnapshotWriter(scheduler, backend, webhookServer);
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { DATA_DIR } from './config.mjs';

const SNAPSHOT_DIR  = path.join(DATA_DIR, 'channels');
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, 'status-snapshot.json');
const INTERVAL_MS   = 10_000;

// ── In-memory Discord unread tracking ────────────────────────────────────────
// Key: channelId  Value: { label, latestSeenId, unseenCount }
// No persistence across restarts — clean start is fine for v1.
const _discordUnread = new Map();

/**
 * Called whenever the backend delivers messages for a channelId.
 * `messages` is the array returned by backend.fetchMessages().
 * We record the most-recently-seen message id and count messages
 * received since the last call as "unread since last fetch".
 */
export function recordFetchedMessages(channelId, channelLabel, messages) {
  if (!Array.isArray(messages) || messages.length === 0) return;
  const prev = _discordUnread.get(channelId);
  const prevLatestId = prev?.latestSeenId ?? null;
  const newLatestId  = messages[messages.length - 1]?.id ?? null;

  // Count messages newer than the last seen id (BigInt-compare Discord snowflakes).
  let unseenCount = 0;
  if (prevLatestId) {
    for (const m of messages) {
      try {
        if (BigInt(m.id) > BigInt(prevLatestId)) unseenCount++;
      } catch { unseenCount++; }
    }
  }
  // First call: zero unread (baseline, not retroactive).

  _discordUnread.set(channelId, {
    label: channelLabel ?? channelId,
    latestSeenId: newLatestId,
    unseenCount,
  });
}

/** Reset unread counter for a channel (e.g. user explicitly read it). */
export function markChannelRead(channelId) {
  const entry = _discordUnread.get(channelId);
  if (entry) {
    _discordUnread.set(channelId, { ...entry, unseenCount: 0 });
  }
}

// ── Ngrok tunnel URL probe ───────────────────────────────────────────────────
async function probeNgrokUrl() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { req && req.destroy(); } catch {} resolve(null); }, 400);
    let req;
    try {
      req = http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
        clearTimeout(timer);
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const tunnel = (parsed.tunnels || []).find(t => t.public_url);
            resolve(tunnel ? tunnel.public_url : null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => { clearTimeout(timer); resolve(null); });
      req.setTimeout(400, () => { clearTimeout(timer); try { req.destroy(); } catch {} resolve(null); });
    } catch { clearTimeout(timer); resolve(null); }
  });
}

// ── Next-fire computation for legacy schedule kinds ──────────────────────────
/**
 * Compute the next fire timestamp (ms) for a legacy-format schedule entry.
 * Returns null if the next fire is >12h away or the format is unrecognised.
 */
function computeNextLegacyFire(schedule) {
  const { time } = schedule;
  if (!time) return null;
  const now = Date.now();
  const TWELVE_H = 12 * 60 * 60 * 1000;

  // HH:MM exact time
  if (/^\d{2}:\d{2}$/.test(time)) {
    const [hh, mm] = time.split(':').map(Number);
    for (const offsetDays of [0, 1]) {
      const d = new Date(now);
      d.setDate(d.getDate() + offsetDays);
      d.setHours(hh, mm, 0, 0);
      const diff = d.getTime() - now;
      if (diff > 0 && diff <= TWELVE_H) return d.getTime();
    }
    return null;
  }

  // everyNm
  const everyMatch = time.match(/^every(\d+)m$/);
  if (everyMatch) {
    const intervalMs = parseInt(everyMatch[1]) * 60_000;
    return now + intervalMs;  // conservative: next fire is 1 interval away
  }

  // hourly — next :00
  if (time === 'hourly') {
    const d = new Date(now);
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    const diff = d.getTime() - now;
    return diff <= TWELVE_H ? d.getTime() : null;
  }

  // daily — we can't know the exact time without more config; skip
  return null;
}

// ── Snapshot computation ─────────────────────────────────────────────────────
async function computeSnapshot(scheduler) {
  const now = Date.now();

  // ── Schedules ──────────────────────────────────────────────────────────────
  let nextSchedule = null;   // { name, fireAt, kind }
  const deferred  = [];

  if (scheduler) {
    const allLegacy = [
      ...(scheduler.nonInteractive || []),
      ...(scheduler.interactive    || []),
    ];

    // 1. Legacy (HH:MM, everyNm, hourly, daily) next-fire
    for (const s of allLegacy) {
      if (s.enabled === false) continue;
      if (scheduler.cronJobs && scheduler.cronJobs.has(s.name)) continue; // handled below
      if (scheduler.shouldSkip && scheduler.shouldSkip(s.name)) continue;
      const fireAt = computeNextLegacyFire(s);
      if (fireAt && (!nextSchedule || fireAt < nextSchedule.fireAt)) {
        nextSchedule = { name: s.name, fireAt, kind: s.time ?? 'legacy' };
      }
    }

    // 2. Cron-expression next-fire via node-cron ScheduledTask.nextDate()
    if (scheduler.cronJobs && scheduler.cronJobs.size > 0) {
      for (const [name, task] of scheduler.cronJobs) {
        if (scheduler.shouldSkip && scheduler.shouldSkip(name)) continue;
        try {
          // node-cron ScheduledTask exposes nextDate() / getNextDate()
          // depending on the installed version; try both.
          const nd =
            (typeof task.nextDate  === 'function' ? task.nextDate()  : null) ??
            (typeof task.getNextDate === 'function' ? task.getNextDate() : null);
          if (!nd) continue;
          const fireAt = nd instanceof Date ? nd.getTime() : Number(nd);
          if (!isFinite(fireAt)) continue;
          if (!nextSchedule || fireAt < nextSchedule.fireAt) {
            nextSchedule = { name, fireAt, kind: 'cron' };
          }
        } catch { /* node-cron version mismatch — skip */ }
      }
    }

    // 3. Deferred entries
    if (scheduler.deferred) {
      for (const [name, until] of scheduler.deferred) {
        if (until > now) deferred.push({ name, until });
      }
    }
  }

  // ── Discord unread ─────────────────────────────────────────────────────────
  const unreadList = [];
  let totalUnread  = 0;
  for (const [channelId, entry] of _discordUnread) {
    unreadList.push({
      channelId,
      channelLabel: entry.label,
      count: entry.unseenCount,
    });
    totalUnread += entry.unseenCount;
  }

  // ── Ngrok tunnel URL ───────────────────────────────────────────────────────
  const tunnelUrl = await probeNgrokUrl();

  return {
    writtenAt: now,
    schedules: {
      next: nextSchedule
        ? { name: nextSchedule.name, fireAt: nextSchedule.fireAt, kind: nextSchedule.kind }
        : null,
      deferred,
      deferredCount: deferred.length,
    },
    discord: {
      unread: unreadList,
      totalUnread,
    },
    ngrok: {
      tunnelUrl,
    },
  };
}

// ── Atomic writer ────────────────────────────────────────────────────────────
async function writeSnapshot(scheduler) {
  try {
    const snap = await computeSnapshot(scheduler);
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const tmpPath = SNAPSHOT_PATH + `.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(snap, null, 2), 'utf8');
    fs.renameSync(tmpPath, SNAPSHOT_PATH);
  } catch (err) {
    // Non-fatal — statusline degrades gracefully when snapshot is absent.
    process.stderr.write(
      `mixdog status-snapshot: write failed: ${err?.message ?? err}\n`
    );
    // Clean up tmp if it exists
    // (tmp name is ephemeral — no reliable path to clean up on error)
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
let _scheduler = null;
let _snapshotTimer = null;

/**
 * Start the snapshot writer.
 * Call once from channels/index.mjs after the scheduler is created.
 * Re-entrant: calling again replaces the scheduler reference.
 */
export function startSnapshotWriter(scheduler) {
  _scheduler = scheduler;

  // Write immediately on startup
  void writeSnapshot(_scheduler);

  // Then every 10 seconds
  if (!_snapshotTimer) {
    _snapshotTimer = setInterval(() => {
      void writeSnapshot(_scheduler);
    }, INTERVAL_MS);
    // Don't prevent process exit
    if (_snapshotTimer.unref) _snapshotTimer.unref();
  }
}

/** Update the scheduler reference (e.g. after reloadConfig). */
export function updateSnapshotScheduler(scheduler) {
  _scheduler = scheduler;
}

/** Stop the writer and remove the snapshot file. */
export function stopSnapshotWriter() {
  if (_snapshotTimer) {
    clearInterval(_snapshotTimer);
    _snapshotTimer = null;
  }
  try { fs.unlinkSync(SNAPSHOT_PATH); } catch {}
}
