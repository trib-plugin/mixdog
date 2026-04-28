/**
 * Bridge-status aggregator.
 *
 * Builds the JSON / text payload consumed by statusline.sh and setup.html.
 * Extracted from setup-server.mjs (0.1.25 and earlier) so both the setup
 * server (on-demand, port 3458) and the MCP-embedded status server (always
 * on, ephemeral port) can serve the same response without drifting.
 *
 * All reads are best-effort; any single source failing leaves that segment
 * empty rather than failing the whole response.
 */

import http from 'http';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'fs';
import { join } from 'path';

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

const RUNNING_STALL_MS = 10 * 60 * 1000; // mirror store.mjs
const RECENT_MS = 30 * 60 * 1000;
const SNAPSHOT_STALE_MS = 30_000;
const TWELVE_H = 12 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildRecapSegment(recap = {}) {
  const validStates = new Set(['idle', 'running', 'injected', 'empty', 'error']);
  const rawState = typeof recap.state === 'string' && validStates.has(recap.state) ? recap.state : 'idle';
  return {
    state: rawState,
    running: recap.running === true,
    startedAt: normalizeTimestamp(recap.startedAt),
    lastCompletedAt: normalizeTimestamp(recap.lastCompletedAt),
    updatedAt: normalizeTimestamp(recap.updatedAt),
    errorMessage: typeof recap.errorMessage === 'string' ? recap.errorMessage.slice(0, 200) : null,
  };
}

export async function buildBridgeStatus(dataDir, options = {}) {
  const now = Date.now();

  const SESSIONS_DIR = join(dataDir, 'sessions');
  const STATUS_SNAPSHOT_PATH = join(dataDir, 'channels', 'status-snapshot.json');
  const CONFIG_PATH = join(dataDir, 'config.json');
  const TRACE_PATH = join(dataDir, 'history', 'bridge-trace.jsonl');
  const JOBS_STATE_PATH = join(dataDir, 'jobs', 'state.json');

  // ── 1. Active + recently-completed bridge sessions ────────────────
  let allSessions = [];
  if (existsSync(SESSIONS_DIR)) {
    try {
      const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try { allSessions.push(JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf-8'))); }
        catch { /* skip corrupt */ }
      }
    } catch { /* dir unreadable */ }
  }
  const running = allSessions.filter(s => {
    const lastActive = s.lastHeartbeatAt || s.updatedAt || s.createdAt || 0;
    return s.owner === 'bridge'
      && s.status === 'running'
      && s.closed !== true
      && (now - lastActive) <= RUNNING_STALL_MS;
  });
  const runningRoles = running.map(s => s.role || 'agent').filter(Boolean);

  const recentClosed = allSessions
    .filter(s => s.owner === 'bridge' && s.closed === true && (now - (s.updatedAt || 0)) <= RECENT_MS)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const lastCompleted = recentClosed[0] || null;

  // ── 2. Scheduler state ────────────────────────────────────────────
  let scheduleActive = 0;
  let scheduleDeferred = 0;
  let nextSchedule = null;
  let discordTotalUnread = null;
  let ngrokTunnelUrl = null;
  let snapshotFresh = false;
  try {
    if (existsSync(STATUS_SNAPSHOT_PATH)) {
      const snap = JSON.parse(readFileSync(STATUS_SNAPSHOT_PATH, 'utf-8'));
      if (snap && typeof snap.writtenAt === 'number' && (now - snap.writtenAt) <= SNAPSHOT_STALE_MS) {
        snapshotFresh = true;
        const cfg = readJsonFile(CONFIG_PATH) || {};
        const allSchedules = [
          ...(cfg.nonInteractive || []),
          ...(cfg.interactive || []),
        ].filter(s => s.enabled !== false && s.name);
        scheduleActive = allSchedules.length;
        scheduleDeferred = snap.schedules?.deferredCount ?? 0;
        if (snap.schedules?.next) {
          nextSchedule = { name: snap.schedules.next.name, fireAt: snap.schedules.next.fireAt };
        }
        if (typeof snap.discord?.totalUnread === 'number') {
          discordTotalUnread = snap.discord.totalUnread;
        }
        if (snap.ngrok?.tunnelUrl) {
          ngrokTunnelUrl = snap.ngrok.tunnelUrl;
        }
      }
    }
  } catch { /* snapshot unreadable */ }

  if (!snapshotFresh) {
    try {
      const cfg = readJsonFile(CONFIG_PATH) || {};
      const allSchedules = [
        ...(cfg.nonInteractive || []),
        ...(cfg.interactive || []),
      ].filter(s => s.enabled !== false && s.name);
      scheduleActive = allSchedules.length;

      const candidates = [];
      for (const s of allSchedules) {
        if (!s.time || !/^\d{2}:\d{2}$/.test(s.time)) continue;
        const [hh, mm] = s.time.split(':').map(Number);
        for (const offsetDays of [0, 1]) {
          const candidate = new Date(now);
          candidate.setDate(candidate.getDate() + offsetDays);
          candidate.setHours(hh, mm, 0, 0);
          const diff = candidate.getTime() - now;
          if (diff > 0 && diff <= TWELVE_H) {
            candidates.push({ name: s.name, fireAt: candidate.getTime(), diff });
          }
        }
      }
      candidates.sort((a, b) => a.diff - b.diff);
      if (candidates.length > 0) nextSchedule = candidates[0];
    } catch { /* config unreadable */ }
  }

  // ── 3. Recall count (last 60 min, tail 2 MB) ──────────────────────
  let recallCount = 0;
  if (existsSync(TRACE_PATH)) {
    try {
      const MAX_BYTES = 2 * 1024 * 1024;
      const stat = statSync(TRACE_PATH);
      const start = Math.max(0, stat.size - MAX_BYTES);
      const bytesToRead = stat.size - start;
      const buf = Buffer.alloc(bytesToRead);
      const fd = openSync(TRACE_PATH, 'r');
      try { readSync(fd, buf, 0, bytesToRead, start); } finally { closeSync(fd); }
      const cutoff = now - HOUR_MS;
      for (const line of buf.toString('utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.kind === 'tool' && ev.tool_name === 'recall' && new Date(ev.ts).getTime() >= cutoff) {
            recallCount++;
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* trace unreadable */ }
  }

  // ── 4. Jobs count ────────────────────────────────────────────────
  let jobsCount = 0;
  if (existsSync(JOBS_STATE_PATH)) {
    try {
      const jobsState = JSON.parse(readFileSync(JOBS_STATE_PATH, 'utf-8'));
      if (Array.isArray(jobsState)) {
        jobsCount = jobsState.filter(j => j.status === 'running').length;
      }
    } catch { /* unreadable */ }
  }

  // ── 5. Ngrok online ──────────────────────────────────────────────
  let ngrokOnline = false;
  if (ngrokTunnelUrl) {
    ngrokOnline = true;
  } else {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { req_ng && req_ng.destroy(); } catch {} resolve(); }, 300);
      let req_ng;
      try {
        req_ng = http.get('http://127.0.0.1:4040/api/tunnels', (r) => {
          clearTimeout(timer);
          let body = '';
          r.on('data', d => { body += d; });
          r.on('end', () => {
            try {
              const parsed = JSON.parse(body);
              const tunnel = (parsed.tunnels || []).find(t => t.public_url);
              if (tunnel) {
                ngrokOnline = true;
                ngrokTunnelUrl = tunnel.public_url;
              }
            } catch { /* ignore */ }
            resolve();
          });
        });
        req_ng.on('error', () => { clearTimeout(timer); resolve(); });
        req_ng.setTimeout(300, () => { clearTimeout(timer); try { req_ng.destroy(); } catch {} resolve(); });
      } catch { clearTimeout(timer); resolve(); }
    });
  }

  // ── Assemble payload ─────────────────────────────────────────────
  const sessionSegment = running.length > 0
    ? { active: running.length, roles: runningRoles }
    : { active: 0, roles: [] };

  let lastCompletedSegment = null;
  if (lastCompleted) {
    const ageMs = now - (lastCompleted.updatedAt || 0);
    lastCompletedSegment = {
      role: lastCompleted.role || 'agent',
      agoMinutes: Math.round(ageMs / 60000),
    };
  }

  const scheduleSegment = {
    active: scheduleActive,
    deferred: scheduleDeferred,
    next: nextSchedule ? {
      name: nextSchedule.name,
      fireAt: nextSchedule.fireAt,
      fireAtISO: new Date(nextSchedule.fireAt).toISOString(),
    } : null,
  };
  const recapSegment = buildRecapSegment(options.recap);

  return {
    sessions: sessionSegment,
    lastCompleted: lastCompletedSegment,
    schedule: scheduleSegment,
    recallLastHour: recallCount,
    jobs: { count: jobsCount },
    recap: recapSegment,
    ngrok: { online: ngrokOnline, tunnelUrl: ngrokTunnelUrl ?? undefined },
    ...(discordTotalUnread !== null ? { discord: { totalUnread: discordTotalUnread } } : {}),
    snapshotFresh,
    generatedAt: new Date(now).toISOString(),
  };
}

export function renderBridgeStatusText(payload) {
  const parts = [];
  const running = payload.sessions?.active || 0;
  const roles = payload.sessions?.roles || [];

  if (running > 0) {
    const roleList = [...new Set(roles)].join(',');
    parts.push(`⚙ ${running} running (${roleList})`);
  } else {
    parts.push('idle');
  }

  if (payload.lastCompleted) {
    const ageMins = payload.lastCompleted.agoMinutes || 0;
    const timeAgo = ageMins <= 0 ? 'just now' : `${ageMins}m`;
    parts.push(`✓ ${payload.lastCompleted.role} ${timeAgo}`);
  }

  if (payload.schedule?.next) {
    const d = new Date(payload.schedule.next.fireAt);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    parts.push(`⏰ ${hh}:${mm} ${payload.schedule.next.name}`);
  }

  if (payload.schedule?.active > 0) {
    const def = payload.schedule.deferred || 0;
    parts.push(def > 0
      ? `📋 ${payload.schedule.active}/${def}def`
      : `📋 ${payload.schedule.active}`);
  }

  if (payload.recallLastHour > 0) {
    parts.push(`🧠 ${payload.recallLastHour}r/1h`);
  }

  return parts.join(' · ');
}
