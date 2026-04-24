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
const CONFIG_FILE = join(DATA_DIR, "config.json");
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
    return {
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
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      mkdirSync(DATA_DIR, { recursive: true });
      updateSection("channels", () => DEFAULT_CONFIG);
      process.stderr.write(
        `mixdog: default channels config created in ${MIXDOG_CONFIG_PATH}
  edit discord.token and channelsConfig.main.channelId to connect.
`
      );
      return DEFAULT_CONFIG;
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
const BOT_FILE = join(DATA_DIR, "bot.json");
function loadBotConfig() {
  try {
    return JSON.parse(readFileSync(BOT_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveBotConfig(bot) {
  writeFileSync(BOT_FILE, JSON.stringify(bot, null, 2) + "\n");
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
  createBackend,
  loadBotConfig,
  loadConfig,
  loadProfileConfig,
  saveBotConfig,
  saveProfileConfig
};
