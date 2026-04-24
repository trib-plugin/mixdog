import { readFileSync, writeFileSync, unlinkSync, appendFileSync } from "fs";
import { join, isAbsolute } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { DATA_DIR } from "./config.mjs";
import { runScript as execScript, ensureNopluginDir } from "./executor.mjs";
import { makeBridgeLlm } from '../../agent/orchestrator/smart-bridge/bridge-llm.mjs';

const schedulerLlm = makeBridgeLlm({ taskType: 'scheduler-task', role: 'scheduler-task', sourceType: 'scheduler' });
const proactiveLlm = makeBridgeLlm({ taskType: 'proactive-decision', role: 'proactive-decision', sourceType: 'scheduler' });
const SCHEDULE_LOG = join(DATA_DIR, "schedule.log");
function logSchedule(msg) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`;
  process.stderr.write(`mixdog scheduler: ${msg}
`);
  try {
    appendFileSync(SCHEDULE_LOG, line);
  } catch {
  }
}
import { isHoliday } from "./holidays.mjs";
import { tryRead } from "./settings.mjs";
// node-cron is an optional runtime dep. If the module isn't installed
// (e.g. a fresh v0.6.190 where node_modules predates the package.json
// bump), fall back to the legacy tick() path instead of crashing the
// whole channels worker.
let cron = null;
try {
  const mod = await import("node-cron");
  cron = mod.default || mod;
} catch (err) {
  process.stderr.write(`mixdog scheduler: node-cron unavailable, cron expressions disabled (${err?.code || err?.message || err})\n`);
}
const TICK_INTERVAL = 6e4;
// Legacy time formats handled by the tick() path. Anything else is
// forwarded to node-cron for parsing/scheduling.
const LEGACY_TIME_RE = /^(?:\d{2}:\d{2}|every\d+m|hourly|daily)$/;
function isCronExpression(time) {
  if (typeof time !== "string" || !time) return false;
  if (LEGACY_TIME_RE.test(time)) return false;
  if (!cron) return false;
  const tokens = time.trim().split(/\s+/);
  if (tokens.length !== 5 && tokens.length !== 6) return false;
  try { return cron.validate(time); } catch { return false; }
}
// Build a {hhmm, dateStr, dow} snapshot in the given IANA TZ. Falls
// back to local Date math when tz is absent.
function tzSnapshot(now, tz) {
  if (!tz) {
    return {
      hhmm: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
      dateStr: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
      dow: now.getDay(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    hour12: false, timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    hhmm: `${hour}:${parts.minute}`,
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    dow: dowMap[parts.weekday] ?? now.getDay(),
  };
}
// Proactive frequency → period (idleMinutes) + daily cap.
//
// NEW SEMANTICS (D4): `idleMinutes` is the period between proactive
// *opportunities* — the scheduler wakes every `idleMinutes` and, if the
// 15-min idle guard also passes, fires. `daily` remains a soft cap used
// for telemetry/reporting only; firing is period-gated, not slot-gated.
//
// Mapping: 1→180m (~3h), 2→120m (2h), 3→90m (1.5h), 4→60m (1h),
// 5→30m (half-hour). Higher frequency = shorter period.
const FREQUENCY_MAP = {
  1: { daily: 3, idleMinutes: 180 },
  // period ~3h
  2: { daily: 5, idleMinutes: 120 },
  // period 2h
  3: { daily: 7, idleMinutes: 90 },
  // period 1.5h
  4: { daily: 10, idleMinutes: 60 },
  // period 1h
  5: { daily: 15, idleMinutes: 30 }
  // period 30m
};
class Scheduler {
  nonInteractive;
  interactive;
  proactive;
  channelsConfig;
  promptsDir;
  tickTimer = null;
  lastFired = /* @__PURE__ */ new Map();
  // name -> "YYYY-MM-DDTHH:MM"
  running = /* @__PURE__ */ new Set();
  injectFn = null;
  sendFn = null;
  pendingCheck = null;
  // Activity tracking
  lastActivity = 0;
  // timestamp of last inbound message
  // Proactive state (period-based — see FREQUENCY_MAP notes)
  proactiveLastFireAt = 0;
  // timestamp of last proactive fire (0 = never in this session)
  proactiveStartAt = Date.now();
  // plugin-start wall clock; used as conservative "last fire" baseline
  // on cold start so we don't fire immediately after restart.
  proactiveFiredToday = 0;
  // count of proactive fires today (telemetry only)
  proactiveInFlight = false;
  // true while an in-progress fireProactiveTick is awaiting the LLM
  deferred = /* @__PURE__ */ new Map();
  // name -> deferred-until timestamp
  skippedToday = /* @__PURE__ */ new Set();
  // names skipped for today
  skippedTodayDate = "";
  // "YYYY-MM-DD" local date the skippedToday set belongs to
  holidayCountry = null;
  // ISO country code for holiday check
  holidayChecked = "";
  // "YYYY-MM-DD" last checked date
  todayIsHoliday = false;
  // cached result for today
  quietSchedule = null;
  // global quiet hours "HH:MM-HH:MM"
  cronJobs = /* @__PURE__ */ new Map();
  // name -> node-cron ScheduledTask for cron-expression entries
  //
  // 0.1.62 wiring:
  //   `topConfig` is the normalized top-level channels config from
  //   loadConfig()/applyDefaults() — it carries `quiet`, `schedules`,
  //   `proactive` at the top level. `channelsConfig` is still accepted
  //   separately (channel metadata only, not quiet config) because
  //   resolveChannel() needs the channel-label → platform-id map.
  constructor(nonInteractive, interactive, proactive, channelsConfig, topConfig) {
    this.nonInteractive = nonInteractive.filter((s) => s.enabled !== false);
    this.interactive = interactive.filter((s) => s.enabled !== false);
    this.proactive = proactive ?? null;
    this.channelsConfig = channelsConfig ?? null;
    this.promptsDir = join(DATA_DIR, "prompts");
    this._applyQuietConfig(topConfig);
  }
  /** Resolve quiet/schedules/proactive flags from the top-level config
   *  (0.1.62 shape: `topConfig.quiet`, `topConfig.schedules`,
   *  `topConfig.proactive`). Falls through silently to defaults
   *  (empty schedule, holidays off, respect flags default true) when
   *  topConfig is missing or malformed — defensive, not legacy. */
  _applyQuietConfig(topConfig) {
    const cfg = (topConfig && typeof topConfig === "object") ? topConfig : null;
    const quietSrc = cfg?.quiet ?? null;
    const schedulesSrc = cfg?.schedules ?? null;
    const proactiveCfgSrc = cfg?.proactive ?? null;
    // Holidays: read from topConfig.quiet.holidays only.
    const hol = quietSrc?.holidays;
    if (hol === true) {
      const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? "";
      this.holidayCountry = locale.split("-")[1] || locale.toUpperCase().slice(0, 2);
    } else if (typeof hol === "string" && hol) {
      this.holidayCountry = hol;
    } else {
      this.holidayCountry = null;
    }
    // Quiet window string "HH:MM-HH:MM" from topConfig.quiet.schedule.
    this.quietSchedule = quietSrc?.schedule ?? null;
    // Opt-in flags: default true when unspecified, matching applyDefaults.
    this.respectQuietProactive = proactiveCfgSrc?.respectQuiet !== false;
    this.respectQuietSchedules = schedulesSrc?.respectQuiet !== false;
    // Stash the normalized cfg for helpers that want the whole object.
    // Currently scheduler uses its own TZ-aware isQuietHours(), but this
    // field lets future code call the shared isInQuietWindow(cfg, now)
    // without re-deriving the shape.
    this._quietCfg = quietSrc ? { quiet: quietSrc } : null;
    // Raw boolean for `quiet.holidays === true` — surfaces weekend-quiet
    // semantics that match webhook's isInQuietWindow (config.mjs). Kept
    // separate from holidayCountry (which feeds schedule.skipHolidays /
    // days==="weekday" public-holiday skips — a different feature).
    this.weekendQuiet = quietSrc?.holidays === true;
  }
  setInjectHandler(fn) {
    this.injectFn = fn;
  }
  setSendHandler(fn) {
    this.sendFn = fn;
  }
  setPendingCheck(fn) {
    this.pendingCheck = typeof fn === 'function' ? fn : null;
  }
  noteActivity() {
    this.lastActivity = Date.now();
  }
  /** Defer a schedule by N minutes from now */
  defer(name, minutes) {
    this.deferred.set(name, Date.now() + minutes * 6e4);
  }
  /** Skip a schedule for the rest of today */
  skipToday(name) {
    this.rolloverSkippedTodayIfNeeded();
    this.skippedToday.add(name);
  }
  /** Roll the skippedToday bucket over when the local date has changed */
  rolloverSkippedTodayIfNeeded() {
    const today = new Date().toLocaleDateString('sv-SE');
    if (this.skippedTodayDate !== today) {
      this.skippedToday.clear();
      this.skippedTodayDate = today;
    }
  }
  /** Check if a schedule should be skipped (deferred or skipped today) */
  shouldSkip(name) {
    this.rolloverSkippedTodayIfNeeded();
    if (this.skippedToday.has(name)) return true;
    const until = this.deferred.get(name);
    if (until && Date.now() < until) return true;
    if (until && Date.now() >= until) this.deferred.delete(name);
    return false;
  }
  /** Get current session state based on activity */
  getSessionState() {
    // External busy signal wins — a pending bridge dispatch or any other
    // probe that reports "work in flight" keeps the state active even if
    // the user hasn't typed in a while. Probe failures must never crash
    // fireTimed / schedule logic, so wrap defensively.
    try {
      if (this.pendingCheck && this.pendingCheck()) return "active";
    } catch { /* probe failure is not fatal; fall through */ }
    if (this.lastActivity === 0) return "idle";
    const elapsed = Date.now() - this.lastActivity;
    if (elapsed < 2 * 6e4) return "active";
    if (elapsed < 15 * 6e4) return "recent";
    return "idle";
  }
  /** Get time context for prompt enrichment */
  getTimeContext() {
    const now = /* @__PURE__ */ new Date();
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dow = now.getDay();
    return {
      hour: now.getHours(),
      dayOfWeek: days[dow],
      isWeekend: dow === 0 || dow === 6
    };
  }
  /** Wrap prompt with session context metadata */
  wrapPrompt(name, prompt, type) {
    const state = this.getSessionState();
    const time = this.getTimeContext();
    const header = [
      `[schedule: ${name} | type: ${type} | session: ${state}]`,
      `[time: ${time.dayOfWeek} ${String(time.hour).padStart(2, "0")}:${String((/* @__PURE__ */ new Date()).getMinutes()).padStart(2, "0")} | weekend: ${time.isWeekend}]`,
      `Before starting any work, briefly tell the user what you're about to do in one short sentence.`
    ].join("\n");
    return `${header}

${prompt}`;
  }
  static SCHEDULER_LOCK = join(tmpdir(), "mixdog-scheduler.lock");
  static INSTANCE_UUID = randomUUID();
  start() {
    if (this.tickTimer) return;
    const total = this.nonInteractive.length + this.interactive.length + (this.proactive ? 1 : 0);
    if (total === 0) {
      process.stderr.write("mixdog scheduler: no schedules configured\n");
      return;
    }
    ensureNopluginDir();
    const lockContent = `${process.pid}
${Date.now()}
${Scheduler.INSTANCE_UUID}`;
    try {
      writeFileSync(Scheduler.SCHEDULER_LOCK, lockContent, { flag: "wx" });
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const content = readFileSync(Scheduler.SCHEDULER_LOCK, "utf8");
          const lines = content.split("\n");
          const pid = parseInt(lines[0]);
          const lockTime = parseInt(lines[1]) || 0;
          const lockUuid = lines[2] || "";
          const lockAge = Date.now() - lockTime;
          let isAlive = false;
          try {
            process.kill(pid, 0);
            isAlive = true;
          } catch {
          }
          if (isAlive) {
            if (lockAge > 60 * 60 * 1e3 && lockUuid !== Scheduler.INSTANCE_UUID) {
              process.stderr.write(`mixdog scheduler: lock PID ${pid} alive but stale (${Math.round(lockAge / 6e4)}m), reclaiming (PID reuse)
`);
            } else {
              process.stderr.write(`mixdog scheduler: another session (PID ${pid}) owns the scheduler, skipping
`);
              return;
            }
          }
        } catch {
        }
        writeFileSync(Scheduler.SCHEDULER_LOCK, lockContent);
      } else {
        throw err;
      }
    }
    process.on("exit", () => {
      try {
        unlinkSync(Scheduler.SCHEDULER_LOCK);
      } catch {
      }
    });
    logSchedule(`${this.nonInteractive.length} non-interactive, ${this.interactive.length} interactive, proactive=${this.proactive ? 'on' : 'off'}
`);
    this.registerCronJobs();
    this.tick();
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL);
  }
  /** Register any cron-expression entries with node-cron. Legacy
   *  HH:MM / everyNm / hourly / daily entries stay on the tick() path. */
  registerCronJobs() {
    const all = [
      ...this.nonInteractive.map((s) => ({ schedule: s, type: "non-interactive" })),
      ...this.interactive.map((s) => ({ schedule: s, type: "interactive" })),
    ];
    for (const { schedule: s, type } of all) {
      if (!isCronExpression(s.time)) continue;
      try {
        const task = cron.schedule(s.time, () => this.onCronFire(s, type), {
          timezone: s.timezone || undefined,
          name: s.name,
        });
        this.cronJobs.set(s.name, task);
        logSchedule(`registered cron "${s.name}" = "${s.time}"${s.timezone ? ` tz=${s.timezone}` : ""}\n`);
      } catch (err) {
        process.stderr.write(`mixdog scheduler: failed to register cron "${s.name}" (${s.time}): ${err}\n`);
      }
    }
  }
  /** Fire path for a cron-triggered entry. Applies day/quiet/holiday
   *  guards against the schedule's TZ (or local when absent). */
  async onCronFire(schedule, type) {
    const now = /* @__PURE__ */ new Date();
    const tz = schedule.timezone || null;
    const snap = tzSnapshot(now, tz);
    const isWeekend = snap.dow === 0 || snap.dow === 6;
    const days = schedule.days ?? "daily";
    if (!this.matchesDays(days, snap.dow, isWeekend)) return;
    if (this.holidayCountry) {
      try {
        const holiday = await isHoliday(this.tzDate(now, tz), this.holidayCountry);
        if (holiday && (schedule.skipHolidays || days === "weekday")) {
          logSchedule(`skipping "${schedule.name}" \u2014 public holiday\n`);
          return;
        }
      } catch {}
    }
    if ((schedule.dnd || this.respectQuietSchedules) && this.isQuietHours(now, tz)) return;
    if (this.shouldSkip(schedule.name)) return;
    this.lastFired.set(schedule.name, now.toISOString());
    this.fireTimed(schedule, type).catch(
      (err) => process.stderr.write(`mixdog scheduler: ${schedule.name} failed: ${err}\n`)
    );
  }
  /** Produce a Date whose calendar day matches the TZ-adjusted dateStr,
   *  so holiday lookups by country work against the right day. */
  tzDate(now, tz) {
    if (!tz) return now;
    const snap = tzSnapshot(now, tz);
    return new Date(`${snap.dateStr}T12:00:00Z`);
  }
  stop() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.destroyCronJobs();
  }
  destroyCronJobs() {
    for (const [, task] of this.cronJobs) {
      try { task.destroy(); } catch {}
    }
    this.cronJobs.clear();
  }
  restart() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.destroyCronJobs();
    try {
      unlinkSync(Scheduler.SCHEDULER_LOCK);
    } catch {
    }
    this.start();
  }
  reloadConfig(nonInteractive, interactive, proactive, channelsConfig, topConfig, options = {}) {
    this.nonInteractive = nonInteractive.filter((s) => s.enabled !== false);
    this.interactive = interactive.filter((s) => s.enabled !== false);
    this.proactive = proactive ?? null;
    this.channelsConfig = channelsConfig ?? null;
    this.promptsDir = join(DATA_DIR, "prompts");
    this._applyQuietConfig(topConfig);
    this.holidayChecked = "";
    this.todayIsHoliday = false;
    // Period-based proactive state reset (D4): clear fire counter +
    // bump the baseline so reload doesn't insta-fire after config swap.
    this.proactiveFiredToday = 0;
    this.proactiveStartAt = Date.now();
    if (this.deferred.size > 0 || this.skippedToday.size > 0) {
      process.stderr.write(`mixdog scheduler: reload clearing ${this.deferred.size} deferred, ${this.skippedToday.size} skipped
`);
    }
    this.deferred.clear();
    this.skippedToday.clear();
    if (options.restart === false) {
      // Caller owns lifecycle; still drop stale cron bindings so they don't fire against old config.
      this.destroyCronJobs();
      return;
    }
    this.restart();
  }
  getStatus() {
    const result = [];
    for (const s of this.nonInteractive) {
      result.push({
        name: s.name,
        time: s.time,
        days: s.days ?? "daily",
        type: "non-interactive",
        running: false,
        lastFired: this.lastFired.get(s.name) ?? null
      });
    }
    for (const s of this.interactive) {
      result.push({
        name: s.name,
        time: s.time,
        days: s.days ?? "daily",
        type: "interactive",
        running: false,
        lastFired: this.lastFired.get(s.name) ?? null
      });
    }
    if (this.proactive) {
      const periodMs = this.proactivePeriodMs();
      const baseline = this.proactiveLastFireAt || this.proactiveStartAt;
      const nextEligibleAt = baseline + periodMs;
      const nextLabel = Date.now() >= nextEligibleAt
        ? 'eligible-now (awaiting idle)'
        : new Date(nextEligibleAt).toLocaleTimeString();
      const sessionState = this.getSessionState();
      const freq = Math.max(1, Math.min(5, this.proactive.frequency ?? 3));
      const periodMin = FREQUENCY_MAP[freq].idleMinutes;
      result.push({
        name: 'proactive',
        time: `period=${periodMin}m (freq=${freq}), next=${nextLabel}`,
        days: "daily",
        type: "proactive",
        running: false,
        lastFired: this.proactiveLastFireAt > 0 ? new Date(this.proactiveLastFireAt).toISOString() : null,
        meta: { session: sessionState, firedToday: this.proactiveFiredToday }
      });
    }
    return result;
  }
  async triggerManual(name) {
    const timed = [...this.nonInteractive, ...this.interactive].find((e) => e.name === name);
    if (timed) {
      if (this.running.has(name)) return `"${name}" is already running`;
      const isNonInteractive = this.nonInteractive.includes(timed);
      const now = /* @__PURE__ */ new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      this.lastFired.set(name, `${dateStr}T${hhmm}`);
      await this.fireTimed(timed, isNonInteractive ? "non-interactive" : "interactive");
      return `triggered "${name}"`;
    }
    if (this.proactive) {
      const topic = name.replace(/^proactive:/, "");
      // "proactive" alone or "proactive:" with no topic → fire without preferred topic
      if (name === "proactive" || topic === "") {
        await this.fireProactiveTick();
        return `triggered proactive (auto-topic)`;
      }
      const item = this.proactive.items.find((i) => i.topic === topic);
      if (item) {
        await this.fireProactiveTick(item.topic);
        return `triggered proactive "${topic}"`;
      }
      // topic specified but not in items → still fire with it as preference
      await this.fireProactiveTick(topic);
      return `triggered proactive "${topic}"`;
    }
    return `schedule "${name}" not found`;
  }
  // ── Tick ─────────────────────────────────────────────────────────────
  tick() {
    this.tickAsync().catch(
      (err) => process.stderr.write(`mixdog scheduler: tick error: ${err}
`)
    );
  }
  async tickAsync() {
    const now = /* @__PURE__ */ new Date();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const key = `${dateStr}T${hhmm}`;
    const dow = now.getDay();
    const isWeekend = dow === 0 || dow === 6;
    if (this.holidayCountry && this.holidayChecked !== dateStr) {
      this.holidayChecked = dateStr;
      try {
        this.todayIsHoliday = await isHoliday(now, this.holidayCountry);
        if (this.todayIsHoliday) {
          process.stderr.write(`mixdog scheduler: today (${dateStr}) is a holiday \u2014 weekday schedules will be skipped
`);
        }
      } catch (err) {
        process.stderr.write(`mixdog scheduler: holiday check failed: ${err}
`);
        this.todayIsHoliday = false;
      }
    }
    const allTimed = [
      ...this.nonInteractive.map((s) => ({ schedule: s, type: "non-interactive" })),
      ...this.interactive.map((s) => ({ schedule: s, type: "interactive" }))
    ];
    for (const { schedule: s, type } of allTimed) {
      // Cron-expression entries are handled by node-cron; skip here to avoid double-fire.
      if (this.cronJobs.has(s.name)) continue;
      const tz = s.timezone || null;
      const snap = tz ? tzSnapshot(now, tz) : { hhmm, dateStr, dow };
      const snapIsWeekend = snap.dow === 0 || snap.dow === 6;
      const snapKey = `${snap.dateStr}T${snap.hhmm}`;
      const days = s.days ?? "daily";
      if (!this.matchesDays(days, snap.dow, snapIsWeekend)) continue;
      if (this.todayIsHoliday && !tz && (s.skipHolidays || days === "weekday")) {
        const skipKey = `holiday:${dateStr}:${s.name}`;
        if (!this.lastFired.has(skipKey)) {
          this.lastFired.set(skipKey, dateStr);
          logSchedule(`skipping "${s.name}" \u2014 public holiday
`);
        }
        continue;
      }
      if ((s.dnd || this.respectQuietSchedules) && this.isQuietHours(now, tz)) continue;
      const intervalMatch = s.time.match(/^every(\d+)m$/);
      let shouldFire = false;
      if (intervalMatch) {
        const intervalMs = parseInt(intervalMatch[1]) * 6e4;
        const lastKey = this.lastFired.get(s.name);
        const lastTime = lastKey ? new Date(lastKey).getTime() : 0;
        shouldFire = Date.now() - lastTime >= intervalMs;
      } else if (s.time === "hourly") {
        shouldFire = snap.hhmm.endsWith(":00") && this.lastFired.get(s.name) !== snapKey;
      } else {
        shouldFire = s.time === snap.hhmm && this.lastFired.get(s.name) !== snapKey;
      }
      if (!shouldFire) continue;
      if (this.shouldSkip(s.name)) continue;
      // TZ-specific holiday check for tz-bound schedules (local-TZ schedules use the cached todayIsHoliday above).
      if (tz && this.holidayCountry && (s.skipHolidays || days === "weekday")) {
        try {
          const holiday = await isHoliday(this.tzDate(now, tz), this.holidayCountry);
          if (holiday) {
            logSchedule(`skipping "${s.name}" \u2014 public holiday\n`);
            continue;
          }
        } catch {}
      }
      this.lastFired.set(s.name, now.toISOString());
      this.fireTimed(s, type).catch(
        (err) => process.stderr.write(`mixdog scheduler: ${s.name} failed: ${err}
`)
      );
    }
    this.tickProactive(now, dateStr);
  }
  // ── Proactive tick (period-based, D4) ───────────────────────────────
  //
  // Period = FREQUENCY_MAP[freq].idleMinutes. On every scheduler tick we
  // check two conditions:
  //   (a) now - proactiveLastFireAt >= period  (period elapsed)
  //   (b) getSessionState() === "idle"          (15-min idle guard)
  // If both hold (plus dnd/quiet/shouldSkip), we fire and update
  // proactiveLastFireAt. Cold start uses proactiveStartAt as the
  // baseline so restarts don't trigger an immediate fire.
  proactivePeriodMs() {
    const freq = Math.max(1, Math.min(5, this.proactive?.frequency ?? 3));
    return FREQUENCY_MAP[freq].idleMinutes * 6e4;
  }
  tickProactive(now, _dateStr) {
    if (!this.proactive) return;
    if (this.respectQuietProactive && this.isQuietHours(now)) {
      // One-liner so operators can see the skip without flooding the log.
      // Period-based cycle is preserved: we do NOT advance the baseline here.
      if (!this._quietSkipLogged) {
        logSchedule(`skipping proactive — quiet hours ${this.quietSchedule}
`);
        this._quietSkipLogged = true;
      }
      return;
    }
    this._quietSkipLogged = false;
    if (this.shouldSkip('proactive')) return;
    const periodMs = this.proactivePeriodMs();
    const baseline = this.proactiveLastFireAt || this.proactiveStartAt;
    if (Date.now() - baseline < periodMs) return;
    if (this.getSessionState() !== "idle") return;
    this.fireProactiveTick();
  }
  /** Day abbreviation → JS day number (0=Sun...6=Sat) */
  static DAY_ABBRS = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6
  };
  /** Check if today matches the schedule's days setting */
  matchesDays(days, dow, isWeekend) {
    if (days === "daily") return true;
    if (days === "weekday") return !isWeekend;
    if (days === "weekend") return isWeekend;
    const dayList = days.split(",").map((d) => d.trim().toLowerCase());
    return dayList.some((d) => Scheduler.DAY_ABBRS[d] === dow);
  }
  /** Check if current time is within global quiet hours (quiet.schedule).
   *  tz optional — when set, HH:MM is evaluated in the given IANA zone.
   *
   *  TODO(0.1.63+): migrate to the shared isInQuietWindow(cfg, now) helper
   *  in lib/config.mjs once that helper grows TZ awareness. The shared
   *  helper currently evaluates only against host-local time, so scheduler
   *  keeps this version to honor per-schedule `timezone:` overrides. When
   *  the shared helper gains tz support, pass `this._quietCfg` straight to
   *  it and drop this method. */
  isQuietHours(now, tz) {
    // Schedule-string window check (HH:MM-HH:MM, TZ-aware when tz set).
    if (this.quietSchedule) {
      const parts = this.quietSchedule.split("-");
      if (parts.length === 2) {
        const [start, end] = parts;
        const hhmm = tz
          ? tzSnapshot(now, tz).hhmm
          : `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        const inWindow = start > end
          ? (hhmm >= start || hhmm < end)
          : (hhmm >= start && hhmm < end);
        if (inWindow) return true;
      }
    }
    // Weekend-quiet branch: mirrors webhook's isInQuietWindow semantics
    // for `quiet.holidays === true` — Sat/Sun in the scheduler's active
    // TZ counts as quiet. TZ-aware via tzSnapshot (webhook is host-local;
    // scheduler legitimately differs to honor per-schedule `timezone:`).
    // Public-holiday skips (holidayCountry / skipHolidays / days==="weekday")
    // are a separate feature and untouched here.
    if (this.weekendQuiet) {
      const dow = tzSnapshot(now, tz).dow;
      if (dow === 0 || dow === 6) return true;
    }
    return false;
  }
  // Legacy random-slot generator removed (D4). Proactive is now strictly
  // period-based \u2014 see tickProactive() + FREQUENCY_MAP.idleMinutes.
  // ── Fire timed schedule ─────────────────────────────────────────────
  async fireTimed(schedule, type) {
    const execMode = schedule.exec ?? "prompt";
    if (execMode === "script" || execMode === "script+prompt") {
      if (!schedule.script) {
        process.stderr.write(`mixdog scheduler: no script specified for "${schedule.name}"
`);
        return;
      }
      if (this.running.has(schedule.name)) return;
      this.running.add(schedule.name);
      const channelId2 = this.resolveChannel(schedule.channel);
      logSchedule(`firing ${schedule.name} (${type}, exec=${execMode})
`);
      try {
        const scriptResult = await this.runScript(schedule.script);
        if (execMode === "script") {
          this.running.delete(schedule.name);
          if (scriptResult && this.sendFn) {
            await this.sendFn(channelId2, scriptResult).catch(
              (err) => process.stderr.write(`mixdog scheduler: ${schedule.name} relay failed: ${err}
`)
            );
          }
          process.stderr.write(`mixdog scheduler: ${schedule.name} script done
`);
          return;
        }
        const prompt2 = this.loadPrompt(schedule.prompt ?? `${schedule.name}.md`);
        if (!prompt2) {
          this.running.delete(schedule.name);
          process.stderr.write(`mixdog scheduler: prompt not found for "${schedule.name}"
`);
          return;
        }
        const combinedPrompt = `${prompt2}

---
## Script Output
\`\`\`
${scriptResult}
\`\`\``;
        this.running.delete(schedule.name);
        await this.fireTimedPrompt(schedule, type, combinedPrompt, channelId2);
        return;
      } catch (err) {
        this.running.delete(schedule.name);
        process.stderr.write(`mixdog scheduler: ${schedule.name} script error: ${err}
`);
        return;
      }
    }
    const prompt = this.resolvePrompt(schedule);
    if (!prompt) {
      process.stderr.write(`mixdog scheduler: prompt not found for "${schedule.name}"
`);
      return;
    }
    const channelId = this.resolveChannel(schedule.channel);
    await this.fireTimedPrompt(schedule, type, prompt, channelId);
  }
  /** Fire a timed schedule with the given prompt content */
  async fireTimedPrompt(schedule, type, prompt, channelId) {
    logSchedule(`firing ${schedule.name} (${type})
`);
    if (type === "interactive") {
      if (this.injectFn) {
        this.injectFn(channelId, schedule.name, " ", {
          instruction: prompt,
          type: "schedule"
        });
      }
      return;
    }
    if (this.running.has(schedule.name)) return;
    this.running.add(schedule.name);
    const presetId = schedule.model || schedule.preset || 'sonnet-mid';
    schedulerLlm({ prompt, preset: presetId, mode: 'active', timeout: 120000, sourceName: schedule.name })
      .then((result) => {
        this.running.delete(schedule.name);
        if (result && this.sendFn) {
          this.sendFn(channelId, result).catch(
            (err) => process.stderr.write(`mixdog scheduler: ${schedule.name} relay failed: ${err}\n`)
          );
        }
        logSchedule(`${schedule.name} done\n`);
      })
      .catch((err) => {
        this.running.delete(schedule.name);
        logSchedule(`${schedule.name} LLM error: ${err.message}\n`);
      });
  }
  // ── Script execution (delegates to shared executor) ────────────────
  runScript(scriptName) {
    return new Promise((resolve, reject) => {
      execScript(`schedule:${scriptName}`, scriptName, (result, code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`script exited with code ${code}`));
        } else {
          resolve(result);
        }
      });
    });
  }
  // ── Fire proactive ─────────────────────────────────────────────────
  proactiveDataFetcher = null;
  proactiveDbUpdater = null;
  setProactiveHandlers(dataFetcher, dbUpdater) {
    this.proactiveDataFetcher = dataFetcher;
    this.proactiveDbUpdater = dbUpdater;
  }
  async fireProactiveTick(preferredTopic) {
    // In-flight guard: during the ~90s LLM call, subsequent ticks must not
    // overlap even while the session still reads as idle.
    if (this.proactiveInFlight) {
      logSchedule('proactive: skip (already in-flight)\n');
      return;
    }
    // Pre-check: skip LLM call entirely if user is active (manual trigger with topic bypasses)
    if (!preferredTopic && this.getSessionState() !== 'idle') {
      logSchedule('proactive: skip (session active, pre-check)\n');
      return;
    }
    // D5: dataFetcher is expected to return { memory, sources }, where
    // `memory` includes recent ~20 role=user chunks (chronological, newest
    // first) plus preference/fact/user-profile core-memory entries. The
    // 50-proactive-decision template reads from `memoryContext` directly.
    const data = await this.proactiveDataFetcher?.({ userChunkLimit: 20 }) ?? { memory: "", sources: [] };
    const now = /* @__PURE__ */ new Date();
    const timeInfo = `${now.toLocaleDateString("ko-KR")} ${now.toLocaleTimeString("ko-KR")} (${["\uC77C", "\uC6D4", "\uD654", "\uC218", "\uBAA9", "\uAE08", "\uD1A0"][now.getDay()]}\uC694\uC77C)`;
    const sourcesText = data.sources.length > 0 ? data.sources.map((s) => `- [${s.category}] ${s.topic} (score: ${s.score}, used: ${s.hit_count}/${s.hit_count + s.skip_count})`).join("\n") : "(no sources registered)";
    const preferredTopicText = preferredTopic ? `
## Manual Trigger Preference
Prefer the topic "${preferredTopic}" if it is available and suitable. Only choose another source when that topic is unavailable or clearly not a good fit right now.
` : "";
    // Task-level variables substituted at dispatch time.
    // Full template lives in rules/bridge/50-proactive-decision.md (auto-
    // injected into BP2 roleCatalog by loadHiddenRoleSnippets); the task
    // block below carries only the runtime context snapshot.
    const task = `## Current Time
${timeInfo}

## User Recent Context (from memory)
${data.memory || "(no recent context)"}

## Available Conversation Sources
${sourcesText}
${preferredTopicText}`;
    // Advance baseline + set in-flight at fire-intent time: baseline now
    // moves on "we attempted a fire" (not on "talk succeeded"), so skip /
    // error / parse-fail branches no longer re-enter every tick.
    this.proactiveLastFireAt = Date.now();
    this.proactiveInFlight = true;
    logSchedule("proactive: firing LLM\n");
    const presetId = this.proactive?.model || 'sonnet-mid';
    try {
      try {
        const raw = await proactiveLlm({ prompt: task, preset: presetId, mode: 'active', timeout: 90000, sourceName: 'proactive' });
        let result;
        try {
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
        } catch {
          logSchedule("proactive: failed to parse response\n");
          return;
        }
        if (!result) return;
        if (result.log || result.researchSummary) {
          const logPath = join(DATA_DIR, "proactive.log");
          const parts = [`[${(/* @__PURE__ */ new Date()).toISOString()}]`];
          if (result.log) parts.push(result.log);
          if (result.researchSummary) parts.push(`research: ${result.researchSummary}`);
          try {
            appendFileSync(logPath, parts.join(' ') + '\n');
          } catch {}
        }
        if (result.sourceUpdates) {
          this.proactiveDbUpdater?.(result.sourceUpdates);
        }
        if (result.action !== "talk" || !result.message) {
          logSchedule(`proactive: skip (${result.log || "no reason"})\n`);
          return;
        }
        logSchedule(`proactive: "${result.sourcePicked}" \u2192 inject\n`);
        this.proactiveFiredToday++;
        if (this.injectFn) {
          this.injectFn("", `proactive:${result.sourcePicked || "chat"}`, " ", {
            instruction: result.message
          });
        }
      } catch (err) {
        logSchedule(`proactive: LLM error: ${err.message}\n`);
      }
    } finally {
      this.proactiveInFlight = false;
    }
  }
  // ── Helpers ─────────────────────────────────────────────────────────
  /** Resolve a channel label to its platform ID via channelsConfig, fallback to raw value */
  resolveChannel(label) {
    const entry = this.channelsConfig?.[label];
    if (entry?.channelId) return entry.channelId;
    return label;
  }
  /** Resolve prompt: try file first, fall back to inline text */
  resolvePrompt(schedule) {
    const ref = schedule.prompt ?? `${schedule.name}.md`;
    const fromFile = this.loadPrompt(ref);
    if (fromFile) return fromFile;
    if (schedule.prompt) return schedule.prompt;
    return null;
  }
  loadPrompt(nameOrPath) {
    const full = isAbsolute(nameOrPath) ? nameOrPath : join(this.promptsDir, nameOrPath);
    return tryRead(full);
  }
}
export {
  Scheduler
};
