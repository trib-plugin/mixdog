import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { DiscordBackend } from "../backends/discord.mjs";
import { updateSection, CONFIG_PATH as MIXDOG_CONFIG_PATH, stripGeneratedMarker } from "../../shared/config.mjs";
if (!process.env.CLAUDE_PLUGIN_DATA) {
  process.stderr.write(
    "mixdog: CLAUDE_PLUGIN_DATA not set.\n  This plugin must be run through Claude Code.\n"
  );
  process.exit(1);
}
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? new URL("..", import.meta.url).pathname;
const CONFIG_FILE = MIXDOG_CONFIG_PATH;
const DEFAULT_ACCESS = {
  dmPolicy: "pairing",
  allowFrom: [],
  channels: {}
};
const DEFAULT_CONFIG = {
  backend: "discord",
  discord: { token: "" },
  access: DEFAULT_ACCESS,
  mainChannel: "main",
  channelsConfig: {
    main: { channelId: "", mode: "interactive" }
  }
};
// Shared defaults layer (DND / proactive / per-channel respectQuiet).
// Merge semantics: user values win; defaults only fill missing fields.
// Helper is exported so the setup UI and runtime both produce the same
// shape when the file has missing sections.
const CONFIG_DEFAULTS = {
  quiet: { schedule: "23:00-09:00", holidays: false },
  proactive: { enabled: true, idleMinutes: 30, model: "sonnet-mid", respectQuiet: true },
  schedules: { respectQuiet: true },
  webhook: { respectQuiet: false }
};
function applyDefaults(config) {
  const out = { ...(config || {}) };
  out.quiet = { ...CONFIG_DEFAULTS.quiet, ...(out.quiet || {}) };
  out.proactive = { ...CONFIG_DEFAULTS.proactive, ...(out.proactive || {}) };
  out.schedules = { ...CONFIG_DEFAULTS.schedules, ...(out.schedules || {}) };
  out.webhook = { ...CONFIG_DEFAULTS.webhook, ...(out.webhook || {}) };
  // Migration: if legacy bot.quiet.schedule exists (via loadBotConfig merge at
  // callsite) and the new top-level quiet.schedule was missing, the merge above
  // already filled it from the default. Callers that need legacy-aware
  // migration should pass the copied value in before applyDefaults runs.
  return out;
}
/**
 * Shared DND / quiet-window helper used by scheduler + webhook.
 *
 * Signature contract (as of 0.1.62):
 *   isInQuietWindow(cfg, now = new Date()) -> boolean
 *
 * `cfg` accepts exactly two shapes (top-level config with `.quiet`
 * subtree, or a flat `{ schedule, holidays }` descriptor); anything
 * else returns `false`.
 *
 * Behavior:
 *   - Schedule window uses "HH:MM-HH:MM". Midnight-crossing windows
 *     (start > end, e.g. "23:00-09:00") are honored. When start === end
 *     the window is treated as empty/never (preserved doc-ambiguous
 *     behavior — callers should avoid that shape).
 *   - `holidays === true` AND today is a recognized holiday  => true,
 *     regardless of schedule window.
 *   - `holidays === false` or missing => holidays ignored.
 *
 * Holiday detection strategy (0.1.62 minimum viable):
 *   Weekend-only check against the host's local timezone (Sat/Sun).
 *   A richer sync source is a TODO — see holidays.mjs (isHoliday) for
 *   the async Nager-backed utility; wiring that into this sync path
 *   needs a pre-warmed cache lookup, which is out of scope for this PR.
 *
 * Exported so scheduler.mjs and webhook.mjs can share one implementation.
 */
function isInQuietWindow(cfg, now = new Date()) {
  if (!cfg || typeof cfg !== "object") return false;
  // Auto-detect shape: prefer cfg.quiet when present, else treat cfg as
  // the flat { schedule, holidays } descriptor.
  const quiet = cfg.quiet && typeof cfg.quiet === "object" ? cfg.quiet : cfg;
  const schedule = quiet.schedule;
  const holidays = quiet.holidays === true;

  // Holiday branch: toggle on AND today qualifies => quiet regardless of window.
  // TODO(0.1.63+): replace weekend-only check with a sync holiday lookup
  // (pre-warmed cache from holidays.mjs / isHoliday) so public-holiday
  // weekdays also count. For this pass, Sat/Sun in host-local TZ only.
  if (holidays) {
    const dow = now.getDay(); // 0=Sun ... 6=Sat, host-local TZ
    if (dow === 0 || dow === 6) return true;
  }

  // Schedule window check (unchanged from prior behavior).
  if (!schedule || typeof schedule !== "string") return false;
  const parts = schedule.split("-");
  if (parts.length !== 2) return false;
  const [start, end] = parts;
  // start === end => empty window (never matches); documented caveat.
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (start > end) return hhmm >= start || hhmm < end; // midnight-crossing
  return hhmm >= start && hhmm < end;
}
function loadConfig() {
  try {
    const raw = stripGeneratedMarker(JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
    const items = raw.schedules?.items;
    if (items && Array.isArray(items)) {
      if (!raw.nonInteractive) {
        raw.nonInteractive = items.filter(
          (i) => i.type === "nonInteractive" || i.type === "non-interactive"
        );
      }
      if (!raw.interactive) {
        raw.interactive = items.filter((i) => i.type === "interactive");
      }
    }
    const accessChannels = { ...raw.access?.channels ?? {} };
    return applyDefaults({
      ...DEFAULT_CONFIG,
      ...raw,
      backend: "discord",
      discord: { ...DEFAULT_CONFIG.discord, ...raw.discord },
      access: {
        ...DEFAULT_ACCESS,
        ...raw.access,
        channels: accessChannels,
        pending: raw.access?.pending ?? {}
      }
    });
  } catch (err) {
    if (err.code === "ENOENT") {
      mkdirSync(DATA_DIR, { recursive: true });
      updateSection("channels", () => DEFAULT_CONFIG);
      process.stderr.write(
        `mixdog: default channels config created in ${MIXDOG_CONFIG_PATH}
  edit discord.token and channelsConfig.main.channelId to connect.
`
      );
      return applyDefaults(DEFAULT_CONFIG);
    }
    throw err;
  }
}
const HEADLESS_BACKEND = {
  name: "headless",
  async connect() {
  },
  async disconnect() {
  },
  async sendMessage() {
    return { sentIds: [] };
  },
  async fetchMessages() {
    return [];
  },
  async react() {
  },
  async removeReaction() {
  },
  async editMessage() {
    return "";
  },
  async deleteMessage() {
  },
  async downloadAttachment() {
    return Buffer.alloc(0);
  },
  on() {
  }
};
function createBackend(config) {
  if (config.backend !== "discord" || !config.discord?.token) {
    process.stderr.write("mixdog: discord not configured, running in headless mode\n");
    return HEADLESS_BACKEND;
  }
  const stateDir = config.discord.stateDir ?? join(DATA_DIR, "discord");
  mkdirSync(stateDir, { recursive: true });
  return new DiscordBackend({
    ...config.discord,
    configPath: CONFIG_FILE,
    access: config.access
  }, stateDir);
}
const PROFILE_FILE = join(DATA_DIR, "profile.json");
function loadProfileConfig() {
  try {
    return JSON.parse(readFileSync(PROFILE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveProfileConfig(profile) {
  writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2) + "\n");
}
export {
  DATA_DIR,
  PLUGIN_ROOT,
  applyDefaults,
  createBackend,
  isInQuietWindow,
  loadConfig,
  loadProfileConfig,
  saveProfileConfig
};
