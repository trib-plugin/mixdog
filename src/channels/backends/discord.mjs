import { randomBytes } from "crypto";

// discord.js is loaded lazily so that importing this module does not pay
// the discord.js initialization cost at top level.
let _discord = null;
let _ChannelType = null;
async function ensureDiscord() {
  if (_discord) return _discord;
  _discord = await import("discord.js");
  _ChannelType = _discord.ChannelType;
  return _discord;
}
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  renameSync,
  realpathSync
} from "fs";
import { join, sep } from "path";
import { chunk } from "../lib/format.mjs";
import { withConfigLock } from "../lib/config-lock.mjs";
import { readSection, updateSection } from "../../shared/config.mjs";
const MAX_CHUNK_LIMIT = 2e3;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const RECENT_SENT_CAP = 200;
function defaultAccess() {
  return {
    dmPolicy: "pairing",
    allowFrom: [],
    channels: {},
    pending: {}
  };
}
function normalizeAccess(parsed) {
  const defaults = defaultAccess();
  return {
    dmPolicy: parsed?.dmPolicy ?? defaults.dmPolicy,
    allowFrom: parsed?.allowFrom ?? defaults.allowFrom,
    channels: parsed?.channels ?? defaults.channels,
    pending: parsed?.pending ?? defaults.pending,
    mentionPatterns: parsed?.mentionPatterns,
    ackReaction: parsed?.ackReaction,
    replyToMode: parsed?.replyToMode,
    textChunkLimit: parsed?.textChunkLimit,
    chunkMode: parsed?.chunkMode
  };
}
function safeAttName(att) {
  return (att.name ?? att.id).replace(/[\[\]\r\n;]/g, "_");
}
class DiscordBackend {
  name = "discord";
  onMessage = null;
  onInteraction = null;
  onModalRequest = null;
  onCustomCommand = null;
  client;
  stateDir;
  configFile;
  approvedDir;
  inboxDir;
  token;
  isStatic;
  bootAccess = null;
  initialAccess;
  recentSentIds = /* @__PURE__ */ new Set();
  sendCount = 0;
  approvalTimer = null;
  typingIntervals = /* @__PURE__ */ new Map();
  constructor(config, stateDir) {
    this.token = config.token;
    this.stateDir = stateDir;
    this.configFile = config.configPath ?? "";
    this.approvedDir = join(stateDir, "approved");
    this.inboxDir = join(stateDir, "inbox");
    this.isStatic = config.accessMode === "static";
    this.initialAccess = normalizeAccess(config.access);
    this.client = null;
  }
  // ── Lifecycle ──────────────────────────────────────────────────────
  async connect() {
    const { Client, GatewayIntentBits, Partials } = await ensureDiscord();
    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Channel]
    });
    if (this.isStatic) {
      const a = this.loadAccess();
      if (a.dmPolicy === "pairing") {
        process.stderr.write('mixdog discord: static mode \u2014 dmPolicy "pairing" downgraded to "allowlist"\n');
        a.dmPolicy = "allowlist";
      }
      a.pending = {};
      this.bootAccess = a;
    }
    this.client.on("error", (err) => {
      process.stderr.write(`mixdog discord: client error: ${err}
`);
    });
    this.client.on("messageCreate", (msg) => {
      if (msg.author.id === this.client.user?.id) {
        return;
      }
      if (msg.author.bot) return;
      this.handleInbound(msg).catch(
        (e) => process.stderr.write(`mixdog discord: handleInbound failed: ${e}
`)
      );
    });
    this.client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.isChatInputCommand() && interaction.commandName === "stop") {
          await interaction.reply({ content: "\u23F9 Stopping...", ephemeral: true });
          if (this.onInteraction) {
            this.onInteraction({
              type: "button",
              customId: "stop_task",
              userId: interaction.user.id,
              channelId: interaction.channelId ?? ""
            });
          }
          return;
        }
        if (interaction.isModalSubmit()) {
          if (this.onInteraction) {
            const fields = {};
            for (const row of interaction.components) {
              for (const comp of row.components ?? []) {
                if (comp.customId && comp.value != null) fields[comp.customId] = String(comp.value);
              }
            }
            this.onInteraction({
              type: "modal",
              customId: interaction.customId,
              userId: interaction.user.id,
              channelId: interaction.channelId ?? "",
              fields,
              message: interaction.message ? { id: interaction.message.id } : void 0
            });
          }
          await interaction.deferUpdate().catch(() => {
          });
          return;
        }
        if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isRoleSelectMenu() || interaction.isUserSelectMenu() || interaction.isChannelSelectMenu()) {
          const needsModal = interaction.isButton() && (interaction.customId === "sched_add_next" || interaction.customId === "sched_edit_next" || interaction.customId === "quiet_set_next" || interaction.customId === "activity_add_next" || interaction.customId === "profile_edit");
          if (needsModal) {
            if (this.onModalRequest) {
              this.onModalRequest(interaction);
            }
            return;
          }
          await interaction.deferUpdate().catch(() => {
          });
          if (this.onInteraction) {
            this.onInteraction({
              type: interaction.isButton() ? "button" : "select",
              customId: interaction.customId,
              userId: interaction.user.id,
              channelId: interaction.channelId,
              values: interaction.isStringSelectMenu() ? interaction.values : void 0,
              message: interaction.message ? { id: interaction.message.id } : void 0
            });
          }
        }
      } catch (err) {
        process.stderr.write(`mixdog discord: interaction error: ${err}
`);
      }
    });
    this.client.on("ready", async (c) => {
      process.stderr.write(`mixdog discord: gateway connected as ${c.user.tag}
`);
      try {
        // Plugin registers no global commands; clear the global slot so any
        // pre-existing entry from prior installs is not surfaced to users.
        await c.application?.commands.set([]);
        process.stderr.write(`mixdog discord: global application commands cleared
`);

        // Replace each guild's command set with just /stop. set() overwrites,
        // so the desired set is the only one that survives.
        const desiredCommands = [
          { name: "stop", description: "Stop the current Claude Code response" },
        ];
        for (const [guildId] of c.guilds.cache) {
          await c.application?.commands.set(desiredCommands, guildId);
        }
        process.stderr.write(`mixdog discord: /stop command registered (${c.guilds.cache.size} guild(s))
`);
      } catch (err) {
        process.stderr.write(`mixdog discord: slash command registration failed: ${err}
`);
      }
    });
    this.client.on("shardDisconnect", (ev, id) => {
      process.stderr.write(`mixdog discord: shard ${id} disconnected (code ${ev.code}). Will auto-reconnect.
`);
    });
    this.client.on("shardReconnecting", (id) => {
      process.stderr.write(`mixdog discord: shard ${id} reconnecting...
`);
    });
    this.client.on("shardResume", (id, replayedEvents) => {
      process.stderr.write(`mixdog discord: shard ${id} resumed (replayed ${replayedEvents} events)
`);
    });
    this.client.on("warn", (msg) => {
      process.stderr.write(`mixdog discord: warn: ${msg}
`);
    });
    const readyPromise = new Promise((resolve, reject) => {
      this.client.once("ready", () => resolve());
      const readyTimeout = setTimeout(() => reject(new Error("discord ready timeout (30s)")), 3e4);
      this.client.once("ready", () => clearTimeout(readyTimeout));
    });
    await this.client.login(this.token);
    await readyPromise;
    this.persistAccessFromChannelsConfig();
    if (!this.isStatic) {
      this.approvalTimer = setInterval(() => this.checkApprovals(), 5e3);
    }
  }
  async disconnect() {
    if (this.approvalTimer) {
      clearInterval(this.approvalTimer);
      this.approvalTimer = null;
    }
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    if (this.client) this.client.destroy();
  }
  resetSendCount() {
    this.sendCount = 0;
  }
  startTyping(channelId) {
    this.stopTyping(channelId);
    const ch = this.client.channels.cache.get(channelId);
    if (ch && "sendTyping" in ch) {
      void ch.sendTyping().catch(() => {
      });
      const interval = setInterval(() => {
        if ("sendTyping" in ch) {
          ch.sendTyping().catch(() => {
          });
        }
      }, 9e3);
      this.typingIntervals.set(channelId, interval);
    }
  }
  stopTyping(channelId) {
    const interval = this.typingIntervals.get(channelId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(channelId);
    }
  }
  // ── Outbound operations ────────────────────────────────────────────
  async sendMessage(chatId, text, opts) {
    const ch = await this.fetchAllowedChannel(chatId);
    if (!("send" in ch)) throw new Error("channel is not sendable");
    const files = opts?.files ?? [];
    const replyTo = opts?.replyTo;
    for (const f of files) {
      this.assertSendable(f);
      const st = statSync(f);
      if (st.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`);
      }
    }
    if (files.length > 10) throw new Error("max 10 attachments per message");
    if (text && this.sendCount > 0) {
      text = "\u3164\n" + text;
    }
    const access = this.loadAccess();
    const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT));
    const replyMode = access.replyToMode ?? "off";
    const chunks = chunk(text, limit);
    const sentIds = [];
    try {
      for (let i = 0; i < chunks.length; i++) {
        const shouldReplyTo = replyTo != null && replyMode !== "off" && (replyMode === "all" || i === 0);
        const embeds = i === 0 ? opts?.embeds ?? [] : [];
        const components = i === 0 ? opts?.components ?? [] : [];
        const sent = await ch.send({
          content: chunks[i],
          ...embeds.length > 0 ? { embeds } : {},
          ...components.length > 0 ? { components } : {},
          ...i === 0 && files.length > 0 ? { files } : {},
          ...shouldReplyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {}
        });
        this.noteSent(sent.id);
        sentIds.push(sent.id);
      }
      this.sendCount += sentIds.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`send failed after ${sentIds.length}/${chunks.length} chunk(s): ${msg}`);
    }
    return { sentIds };
  }
  async fetchMessages(channelId, limit) {
    const ch = await this.fetchAllowedChannel(channelId);
    const capped = Math.min(limit, 100);
    const msgs = await ch.messages.fetch({ limit: capped });
    const me = this.client.user?.id;
    return [...msgs.values()].reverse().map((m) => ({
      id: m.id,
      user: m.author.id === me ? "me" : m.author.username,
      text: m.content.replace(/[\r\n]+/g, " \u23CE "),
      ts: m.createdAt.toISOString(),
      isMe: m.author.id === me,
      attachmentCount: m.attachments.size
    }));
  }
  async react(chatId, messageId, emoji) {
    const ch = await this.fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(messageId);
    await msg.react(emoji);
  }
  async removeReaction(chatId, messageId, emoji) {
    const ch = await this.fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(messageId);
    const me = this.client.user?.id;
    if (me) {
      const reaction = msg.reactions.cache.get(emoji);
      if (reaction) await reaction.users.remove(me);
    }
  }
  async editMessage(chatId, messageId, text, opts) {
    const ch = await this.fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(messageId);
    const access = this.loadAccess();
    const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT));
    const chunks = chunk(text, limit);
    // Edit the original message with the first chunk; send subsequent chunks
    // as new messages to the same channel (same behaviour as reply chunking).
    const edited = await msg.edit({
      content: chunks[0] || null,
      ...opts?.embeds ? { embeds: opts.embeds } : {},
      ...opts?.components ? { components: opts.components } : {}
    });
    const sentIds = [edited.id];
    for (let i = 1; i < chunks.length; i++) {
      const sent = await ch.send({ content: chunks[i] });
      this.noteSent(sent.id);
      sentIds.push(sent.id);
    }
    return sentIds[0];
  }
  async deleteMessage(chatId, messageId) {
    const ch = await this.fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(messageId);
    await msg.delete();
  }
  async downloadAttachment(chatId, messageId) {
    const ch = await this.fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(messageId);
    if (msg.attachments.size === 0) return [];
    const results = [];
    for (const att of msg.attachments.values()) {
      const path = await this.downloadSingleAttachment(att);
      results.push({
        path,
        name: safeAttName(att),
        contentType: att.contentType ?? "unknown",
        size: att.size
      });
    }
    return results;
  }
  async validateChannel(chatId) {
    await this.fetchAllowedChannel(chatId);
  }
  // ── Access control ─────────────────────────────────────────────────
  readConfigAccess() {
    try {
      const parsed = readSection("channels");
      const access = normalizeAccess(parsed.access ?? this.initialAccess);
      if (parsed.channelsConfig) {
        for (const entry of Object.values(parsed.channelsConfig)) {
          if (typeof entry === "object" && entry !== null) {
            const id = entry.channelId;
            if (id && !(id in access.channels)) {
              access.channels[id] = { requireMention: false, allowFrom: [] };
            }
          }
        }
      }
      return access;
    } catch {
      return this.initialAccess;
    }
  }
  persistAccessFromChannelsConfig() {
    if (this.isStatic || !this.configFile) return;
    try {
      const parsed = readSection("channels");
      if (!parsed.channelsConfig) return;
      const access = normalizeAccess(parsed.access);
      let changed = false;
      for (const entry of Object.values(parsed.channelsConfig)) {
        if (typeof entry === "object" && entry !== null) {
          const id = entry.channelId;
          if (id && !(id in access.channels)) {
            access.channels[id] = { requireMention: false, allowFrom: [] };
            changed = true;
          }
        }
      }
      if (changed) this.saveAccess(access);
    } catch (err) {
      process.stderr.write(`mixdog discord: persistAccessFromChannelsConfig failed: ${err}\n`);
    }
  }
  loadAccess() {
    return this.bootAccess ?? this.readConfigAccess() ?? this.initialAccess;
  }
  saveAccess(a) {
    if (this.isStatic) return;
    if (!this.configFile) return;
    return withConfigLock(() => {
      mkdirSync(this.stateDir, { recursive: true, mode: 448 });
      const access = {
        dmPolicy: a.dmPolicy,
        allowFrom: a.allowFrom,
        channels: a.channels,
        pending: a.pending,
        ...a.mentionPatterns ? { mentionPatterns: a.mentionPatterns } : {},
        ...a.ackReaction ? { ackReaction: a.ackReaction } : {},
        ...a.replyToMode ? { replyToMode: a.replyToMode } : {},
        ...a.textChunkLimit ? { textChunkLimit: a.textChunkLimit } : {},
        ...a.chunkMode ? { chunkMode: a.chunkMode } : {}
      };
      updateSection("channels", (channels) => ({
        ...channels,
        access
      }));
    });
  }
  pruneExpired(a) {
    const now = Date.now();
    let changed = false;
    for (const [code, p] of Object.entries(a.pending)) {
      if (p.expiresAt < now) {
        delete a.pending[code];
        changed = true;
      }
    }
    return changed;
  }
  async gate(msg) {
    const access = this.loadAccess();
    if (this.pruneExpired(access)) this.saveAccess(access);
    if (access.dmPolicy === "disabled") return { action: "drop" };
    const senderId = msg.author.id;
    const isDM = msg.channel.type === _ChannelType.DM;
    if (isDM) {
      if (access.allowFrom.includes(senderId)) return { action: "deliver", access };
      if (access.dmPolicy === "allowlist") return { action: "drop" };
      for (const [code2, p] of Object.entries(access.pending)) {
        if (p.senderId === senderId) {
          if ((p.replies ?? 1) >= 2) return { action: "drop" };
          p.replies = (p.replies ?? 1) + 1;
          this.saveAccess(access);
          return { action: "pair", code: code2, isResend: true };
        }
      }
      if (Object.keys(access.pending).length >= 3) return { action: "drop" };
      const code = randomBytes(3).toString("hex");
      const now = Date.now();
      access.pending[code] = {
        senderId,
        chatId: msg.channelId,
        createdAt: now,
        expiresAt: now + 60 * 60 * 1e3,
        replies: 1
      };
      this.saveAccess(access);
      return { action: "pair", code, isResend: false };
    }
    const channelId = msg.channel.isThread() ? msg.channel.parentId ?? msg.channelId : msg.channelId;
    const policy = access.channels[channelId];
    if (!policy) return { action: "drop" };
    const channelAllowFrom = policy.allowFrom ?? [];
    const requireMention = policy.requireMention ?? false;
    if (channelAllowFrom.length > 0 && !channelAllowFrom.includes(senderId)) {
      return { action: "drop" };
    }
    if (requireMention && !await this.isMentioned(msg, access.mentionPatterns)) {
      return { action: "drop" };
    }
    return { action: "deliver", access };
  }
  async isMentioned(msg, extraPatterns) {
    if (this.client.user && msg.mentions.has(this.client.user)) return true;
    const refId = msg.reference?.messageId;
    if (refId) {
      if (this.recentSentIds.has(refId)) return true;
      try {
        const ref = await msg.fetchReference();
        if (ref.author.id === this.client.user?.id) return true;
      } catch {
      }
    }
    const text = msg.content;
    for (const pat of extraPatterns ?? []) {
      try {
        if (new RegExp(pat, "i").test(text)) return true;
      } catch {
      }
    }
    return false;
  }
  // ── Inbound handling ───────────────────────────────────────────────
  async handleInbound(msg) {
    const result = await this.gate(msg);
    if (result.action === "drop") return;
    if (result.action === "pair") {
      const lead = result.isResend ? "Still pending" : "Pairing required";
      try {
        await msg.reply(`${lead} \u2014 run in Claude Code:

/discord:access pair ${result.code}`);
      } catch (err) {
        process.stderr.write(`mixdog discord: failed to send pairing code: ${err}
`);
      }
      return;
    }
    if (result.access.ackReaction) {
      void msg.react(result.access.ackReaction).catch(() => {
      });
    }
    const atts = [];
    for (const att of msg.attachments.values()) {
      atts.push({
        name: safeAttName(att),
        contentType: att.contentType ?? "unknown",
        size: att.size
      });
    }
    const text = msg.content || (atts.length > 0 ? "(attachment)" : "");
    if (text.match(/^\/(bot|profile)\s*\(/) && this.onCustomCommand) {
      const replyFn = async (reply, opts) => {
        try {
          const ch = await this.fetchAllowedChannel(msg.channelId);
          if ("send" in ch) {
            await ch.send({
              ...reply ? { content: reply } : {},
              ...opts?.embeds?.length ? { embeds: opts.embeds } : {},
              ...opts?.components?.length ? { components: opts.components } : {}
            });
          }
        } catch (err) {
          process.stderr.write(`mixdog discord: custom command reply failed: ${err}
`);
        }
      };
      this.onCustomCommand(text, msg.channelId, msg.author.id, replyFn);
      return;
    }
    if (this.onMessage) {
      this.onMessage({
        chatId: msg.channelId,
        messageId: msg.id,
        user: msg.author.username,
        userId: msg.author.id,
        text,
        ts: msg.createdAt.toISOString(),
        attachments: atts
      });
    }
  }
  // ── Approval polling ───────────────────────────────────────────────
  checkApprovals() {
    let files;
    try {
      files = readdirSync(this.approvedDir);
    } catch {
      return;
    }
    if (files.length === 0) return;
    for (const senderId of files) {
      const file = join(this.approvedDir, senderId);
      let dmChannelId;
      try {
        dmChannelId = readFileSync(file, "utf8").trim();
      } catch {
        rmSync(file, { force: true });
        continue;
      }
      if (!dmChannelId) {
        rmSync(file, { force: true });
        continue;
      }
      void (async () => {
        try {
          const ch = await this.fetchTextChannel(dmChannelId);
          if ("send" in ch) {
            await ch.send("Paired! Say hi to Claude.");
          }
          rmSync(file, { force: true });
        } catch (err) {
          process.stderr.write(`mixdog discord: approval confirm failed: ${err}
`);
          rmSync(file, { force: true });
        }
      })();
    }
  }
  // ── Channel helpers ────────────────────────────────────────────────
  async fetchTextChannel(id) {
    const ch = await this.client.channels.fetch(id);
    if (!ch || !ch.isTextBased()) {
      throw new Error(`channel ${id} not found or not text-based`);
    }
    return ch;
  }
  async fetchAllowedChannel(id) {
    const ch = await this.fetchTextChannel(id);
    const access = this.loadAccess();
    if (ch.type === _ChannelType.DM) {
      let recipientId = ch.recipientId;
      if (!recipientId && ch.partial) {
        const fetched = await ch.fetch();
        recipientId = fetched.recipientId;
      }
      if (recipientId && access.allowFrom.includes(recipientId)) return ch;
    } else {
      const key = ch.isThread() ? ch.parentId ?? ch.id : ch.id;
      if (key in access.channels) return ch;
    }
    throw new Error(`channel ${id} is not allowlisted \u2014 add via /discord:access`);
  }
  noteSent(id) {
    this.recentSentIds.add(id);
    if (this.recentSentIds.size > RECENT_SENT_CAP) {
      const first = this.recentSentIds.values().next().value;
      if (first) this.recentSentIds.delete(first);
    }
  }
  assertSendable(f) {
    let real, stateReal;
    try {
      real = realpathSync(f);
      stateReal = realpathSync(this.stateDir);
    } catch {
      return;
    }
    const inbox = join(stateReal, "inbox");
    if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
      throw new Error(`refusing to send channel state: ${f}`);
    }
  }
  async downloadSingleAttachment(att) {
    if (att.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`
      );
    }
    const res = await fetch(att.url);
    if (!res.ok) {
      throw new Error(`attachment download failed: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) {
      throw new Error(`attachment download returned empty buffer: ${att.name ?? att.id}`);
    }
    if (att.size > 0 && buf.length !== att.size) {
      process.stderr.write(`mixdog discord: attachment size mismatch: expected ${att.size} got ${buf.length} (${att.name ?? att.id})\n`);
    }
    const name = att.name ?? `${att.id}`;
    const rawExt = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "bin";
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, "") || "bin";
    const path = join(this.inboxDir, `${Date.now()}-${att.id}.${ext}`);
    mkdirSync(this.inboxDir, { recursive: true });
    writeFileSync(path, buf);
    return path;
  }
}
export {
  DiscordBackend
};
