import { readFileSync, readdirSync, existsSync, statSync, watch, openSync, readSync, closeSync } from "fs";
import { execFileSync } from "child_process";
import { basename, join, resolve } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { formatForDiscord, chunk, safeCodeBlock } from "./format.mjs";
function cwdToProjectSlug(cwd) {
  return resolve(cwd).replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1-").replace(/\//g, "-");
}
function getParentPid(pid) {
  try {
    if (process.platform === "win32") {
      const out2 = execFileSync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`
      ], { encoding: "utf8" }).trim();
      const parsed2 = parseInt(out2, 10);
      return Number.isFinite(parsed2) ? parsed2 : null;
    }
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const parsed = parseInt(out, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function readSessionRecord(pid) {
  const sessionFile = join(homedir(), ".claude", "sessions", `${pid}.json`);
  try {
    const session = JSON.parse(readFileSync(sessionFile, "utf8"));
    if (!session.sessionId) return null;
    return {
      pid,
      sessionId: session.sessionId,
      cwd: resolve(session.cwd ?? process.cwd()),
      startedAt: typeof session.startedAt === "number" ? session.startedAt : 0,
      kind: typeof session.kind === "string" ? session.kind : "",
      entrypoint: typeof session.entrypoint === "string" ? session.entrypoint : ""
    };
  } catch {
    return null;
  }
}
function isInteractiveSession(session) {
  if (!session) return false;
  return session.kind === "interactive" || !session.kind && session.entrypoint === "cli";
}
function discoverCurrentClaudeSession() {
  let pid = process.ppid;
  for (let depth = 0; pid && pid > 1 && depth < 6; depth += 1) {
    const session = readSessionRecord(pid);
    if (session) return session;
    pid = getParentPid(pid);
  }
  return null;
}
function listInteractiveClaudeSessions() {
  const sessionsDir = join(homedir(), ".claude", "sessions");
  try {
    return readdirSync(sessionsDir).filter((file) => file.endsWith(".json")).map((file) => parseInt(basename(file, ".json"), 10)).filter((pid) => Number.isFinite(pid)).map((pid) => readSessionRecord(pid)).filter(isInteractiveSession).sort((a, b) => {
      if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt;
      return b.pid - a.pid;
    });
  } catch {
    return [];
  }
}
function getLatestInteractiveClaudeSession() {
  return listInteractiveClaudeSessions()[0] ?? null;
}
function resolveTranscriptForSession(session) {
  const projectsDir = join(homedir(), ".claude", "projects");
  const projectSlug = cwdToProjectSlug(process.cwd());
  const preferred = join(projectsDir, cwdToProjectSlug(session.cwd), `${session.sessionId}.jsonl`);
  if (existsSync(preferred)) {
    return {
      claudePid: session.pid,
      sessionId: session.sessionId,
      sessionCwd: session.cwd,
      transcriptPath: preferred,
      exists: true
    };
  }
  const fallback = join(projectsDir, projectSlug, `${session.sessionId}.jsonl`);
  if (existsSync(fallback)) {
    return {
      claudePid: session.pid,
      sessionId: session.sessionId,
      sessionCwd: session.cwd,
      transcriptPath: fallback,
      exists: true
    };
  }
  return {
    claudePid: session.pid,
    sessionId: session.sessionId,
    sessionCwd: session.cwd,
    transcriptPath: preferred,
    exists: false
  };
}
function discoverSessionBoundTranscript() {
  const session = discoverCurrentClaudeSession();
  if (!session) return null;
  return resolveTranscriptForSession(session);
}
function findLatestTranscriptByMtime(cwd) {
  const projectsDir = join(homedir(), ".claude", "projects");
  const slug = cwdToProjectSlug(cwd ?? process.cwd());
  const projectDir = join(projectsDir, slug);
  try {
    const files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl")).map((f) => {
      const full = join(projectDir, f);
      try {
        return { path: full, mtime: statSync(full).mtimeMs };
      } catch {
        return null;
      }
    }).filter((f) => f !== null).sort((a, b) => b.mtime - a.mtime);
    return files[0]?.path ?? null;
  } catch {
    return null;
  }
}
class OutputForwarder {
  constructor(cb, statusState) {
    this.cb = cb;
    this.statusState = statusState;
  }
  lastHash = "";
  sentCount = 0;
  transcriptPath = "";
  channelId = "";
  userMessageId = "";
  emoji = "";
  lastFileSize = 0;
  readFileSize = 0;
  watchingPath = "";
  watcher = null;
  idleTimer = null;
  onIdleCallback = null;
  inExplorerSequence = false;
  inRecallSequence = false;
  hasSeenAssistant = false;
  sending = false;
  sendRetryTimer = null;
  sendQueue = [];
  mainSessionId = "";
  watchDebounce = null;
  turnTextBuffer = "";
  hasBinding() {
    return !!this.transcriptPath;
  }
  /** Set context for current turn (called on user message) */
  setContext(channelId, transcriptPath, options = {}) {
    this.channelId = channelId;
    if (!transcriptPath) return;
    if (this.transcriptPath && !existsSync(this.transcriptPath)) {
      const relocated = findLatestTranscriptByMtime();
      if (relocated) {
        transcriptPath = relocated;
      }
    }
    if (this.transcriptPath !== transcriptPath) {
      this.closeWatcher();
      this.transcriptPath = transcriptPath;
      this.mainSessionId = "";
    }
    try {
      const fileSize = options.replayFromStart ? 0 : existsSync(this.transcriptPath) ? statSync(this.transcriptPath).size : 0;
      this.lastFileSize = fileSize;
      this.readFileSize = fileSize;
    } catch {
      this.lastFileSize = 0;
      this.readFileSize = 0;
    }
  }
  /** Reset counters for new turn */
  reset() {
    this.sentCount = 0;
    this.lastHash = "";
    this.inExplorerSequence = false;
    this.inRecallSequence = false;
    this.hasSeenAssistant = false;
    this.turnTextBuffer = "";
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
  /** Read new bytes from transcript file since readFileSize */
  readNewLines() {
    if (!this.transcriptPath || !existsSync(this.transcriptPath)) {
      return { lines: [], nextFileSize: this.readFileSize };
    }
    let fd = null;
    try {
      const stat = statSync(this.transcriptPath);
      if (stat.size <= this.readFileSize) {
        return { lines: [], nextFileSize: this.readFileSize };
      }
      const startOffset = this.readFileSize;
      fd = openSync(this.transcriptPath, "r");
      const buf = Buffer.alloc(stat.size - startOffset);
      readSync(fd, buf, 0, buf.length, startOffset);
      this.readFileSize = stat.size;
      return {
        lines: buf.toString("utf8").split("\n").filter((l) => l.trim()),
        nextFileSize: stat.size
      };
    } catch {
      return { lines: [], nextFileSize: this.readFileSize };
    } finally {
      if (fd != null) {
        closeSync(fd);
      }
    }
  }
  /** Track last tool_use name and file path for matching with tool_result */
  lastToolName = "";
  lastToolFilePath = "";
  /** Extract new assistant text + tool logs from transcript since readFileSize */
  extractNewText() {
    const { lines: newLines, nextFileSize } = this.readNewLines();
    let newText = "";
    for (const l of newLines) {
      try {
        const entry = JSON.parse(l);
        if (!entry.isSidechain && entry.sessionId && !this.mainSessionId) {
          this.mainSessionId = entry.sessionId;
        }
        if (entry.isSidechain) continue;
        if (this.mainSessionId && entry.sessionId && entry.sessionId !== this.mainSessionId) continue;
        if (entry.type === "user" && entry.message?.content?.some((c) => c.type === "tool_result")) {
          if (OutputForwarder.isRecallMemory(this.lastToolName)) {
            continue;
          }
          if (this.lastToolName === "Edit" && entry.toolUseResult && !OutputForwarder.isMemoryFile(this.lastToolFilePath)) {
            const old = entry.toolUseResult.oldString || "";
            const nw = entry.toolUseResult.newString || "";
            if (old || nw) {
              const diffLines = [];
              for (const l2 of old.split("\n")) diffLines.push("- " + l2);
              for (const l2 of nw.split("\n")) diffLines.push("+ " + l2);
              const shown = diffLines.slice(0, 15);
              let diffContent = shown.join("\n");
              if (diffLines.length > 15) diffContent += "\n... +" + (diffLines.length - 15) + " lines";
              const block = safeCodeBlock(diffContent, "diff");
              newText += block + "\n";
            }
          }
          continue;
        }
        if (entry.type === "assistant" && entry.message?.content) {
          this.hasSeenAssistant = true;
          const SEARCH_TOOLS = /* @__PURE__ */ new Set(["Read", "Grep", "Glob"]);
          const parts = [];
          for (const c of entry.message.content) {
            if (c.type === "text" && c.text?.trim()) {
              this.inExplorerSequence = false;
              this.inRecallSequence = false;
              let cleaned = c.text.trim().replace(/<(channel|memory-context|system-reminder|event)\b[^>]*>[\s\S]*?<\/\1>/g, "").trim();
              if (cleaned) parts.push(cleaned);
            } else if (c.type === "tool_use") {
              this.lastToolName = c.name || "";
              this.lastToolFilePath = c.input?.file_path || "";
              if (OutputForwarder.isHidden(c.name)) continue;
              if (SEARCH_TOOLS.has(c.name)) {
                if (!this.inExplorerSequence) {
                  this.inExplorerSequence = true;
                  let target = "";
                  if (c.name === "Read") target = c.input?.file_path ? basename(c.input.file_path) : "";
                  else if (c.name === "Grep") target = '"' + (c.input?.pattern || "").substring(0, 25) + '"';
                  else if (c.name === "Glob") target = (c.input?.pattern || "").substring(0, 25);
                  if (parts.length > 0) parts.push("");
                  parts.push("\u25CF **Explorer** (" + (target || c.name) + ")");
                }
                continue;
              }
              if (OutputForwarder.isRecallMemory(c.name)) {
                if (!this.inRecallSequence) {
                  this.inRecallSequence = true;
                  if (parts.length > 0) parts.push("");
                  parts.push("\u25CF **recall_memory**");
                }
                continue;
              }
              this.inExplorerSequence = false;
              this.inRecallSequence = false;
              const toolLine = OutputForwarder.buildToolLine(c.name, c.input);
              if (toolLine) {
                if (parts.length > 0) parts.push("");
                parts.push(toolLine);
              }
            }
          }
          if (parts.length) newText += parts.join("\n") + "\n";
        }
      } catch {
      }
    }
    return { text: newText.trim(), nextFileSize };
  }
  // ── Single-send gate ──────────────────────────────────────────────
  // All Discord sends pass through sendOnce() so duplicate concurrent sends are avoided.
  // Texts that should never be forwarded to Discord (Claude's internal status lines)
  static SKIP_TEXTS = /* @__PURE__ */ new Set([
    "No response requested.",
    "No response requested",
    "Waiting for user response.",
    "Waiting for user response"
  ]);
  commitReadProgress(nextFileSize) {
    if (nextFileSize <= this.lastFileSize) return;
    this.lastFileSize = nextFileSize;
    this.persistState();
  }
  async deliverQueueItem(item) {
    if (!item.text || !this.channelId) {
      this.commitReadProgress(item.nextFileSize);
      return;
    }
    if (!item.skipHashDedup && OutputForwarder.SKIP_TEXTS.has(item.text.trim())) {
      this.commitReadProgress(item.nextFileSize);
      return;
    }
    const formatted = item.preformatted ? item.text : formatForDiscord(item.text);
    const hash = item.skipHashDedup
      ? ""
      : item.dedupKey
        ? item.dedupKey
        : createHash("md5").update(formatted).digest("hex");
    if (!item.skipHashDedup && this.lastHash === hash) {
      this.commitReadProgress(item.nextFileSize);
      return;
    }
    const chunks = chunk(formatted, 2e3);
    for (const c of chunks) {
      await this.cb.send(this.channelId, c);
    }
    if (!item.skipHashDedup) {
      this.lastHash = hash;
    }
    if (item.bufferText.trim()) {
      this.turnTextBuffer = this.turnTextBuffer ? `${this.turnTextBuffer}

${item.bufferText.trim()}` : item.bufferText.trim();
    }
    this.sentCount += chunks.length;
    this.commitReadProgress(item.nextFileSize);
  }
  scheduleRetry() {
    if (this.sendRetryTimer) return;
    this.sendRetryTimer = setTimeout(() => {
      this.sendRetryTimer = null;
      void this.drainQueue();
    }, 1e3);
  }
  /** Forward new assistant text to Discord. Returns true if text was sent. */
  async forwardNewText() {
    if (!this.channelId) return false;
    const { text: newText, nextFileSize } = this.extractNewText();
    if (!newText) {
      if (!this.sending && this.sendQueue.length === 0) {
        this.commitReadProgress(nextFileSize);
      }
      return false;
    }
    this.sendQueue.push({
      type: "text",
      text: newText,
      nextFileSize,
      bufferText: newText
    });
    void this.drainQueue();
    return true;
  }
  /** Forward tool log line to Discord */
  async forwardToolLog(toolLine, toolName, toolInput) {
    if (!this.channelId) return;
    // Advance the transcript marker without embedding newText into the
    // toolLog payload — the text transcript is already delivered through
    // the regular auto-forward path (forwardNewText), so duplicating it
    // here is what caused double-posts to Discord.
    const { nextFileSize } = this.extractNewText();
    this.sendQueue.push({
      type: "toolLog",
      text: toolLine,
      nextFileSize,
      preformatted: true,
      dedupKey: OutputForwarder.buildDedupKey(toolName, toolInput)
    });
    void this.drainQueue();
  }
  /** Drain the send queue sequentially. Only one drain loop runs at a time. */
  async drainQueue() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.sendQueue.length > 0) {
        const item = this.sendQueue[0];
        try {
          if (item.type === "text") {
            await this.deliverQueueItem(item);
          } else if (item.type === "toolLog") {
            await this.processToolLog(item);
          }
          this.sendQueue.shift();
        } catch (err) {
          process.stderr.write(`mixdog: send failed: ${err}
`);
          this.scheduleRetry();
          break;
        }
      }
    } finally {
      this.sending = false;
    }
  }
  /** Internal: process a single tool log send (extracted from old forwardToolLog) */
  async processToolLog(item) {
    if (this.userMessageId) {
      const newEmoji = "\u{1F6E0}\uFE0F";
      try {
        if (this.emoji && this.emoji !== newEmoji) {
          await this.cb.removeReaction(this.channelId, this.userMessageId, this.emoji);
        }
        await this.cb.react(this.channelId, this.userMessageId, newEmoji);
        this.emoji = newEmoji;
      } catch {
      }
    }
    await this.deliverQueueItem(item);
  }
  /** Forward final text on session idle */
  async forwardFinalText(retries = 0) {
    if (!this.channelId) return;
    if (this.sending || this.sendQueue.length > 0) {
      if (retries < 5) {
        setTimeout(() => void this.forwardFinalText(retries + 1), 300);
      }
      return;
    }
    this.sending = true;
    try {
      if (this.userMessageId && this.emoji) {
        try {
          await this.cb.removeReaction(this.channelId, this.userMessageId, this.emoji);
        } catch {
        }
      }
      const { text: newText, nextFileSize } = this.extractNewText();
      if (newText) {
        await this.deliverQueueItem({
          text: newText,
          nextFileSize,
          bufferText: newText
        });
      } else {
        this.commitReadProgress(nextFileSize);
      }
      if (this.turnTextBuffer.trim()) {
        await this.cb.recordAssistantTurn?.({
          channelId: this.channelId,
          text: this.turnTextBuffer.trim(),
          sessionId: this.mainSessionId || void 0
        });
        this.turnTextBuffer = "";
      }
      this.updateState((state) => {
        state.sessionIdle = true;
      });
    } finally {
      this.sending = false;
    }
  }
  /** Hidden tools — skip both tool_use and tool_result */
  static HIDDEN_TOOLS = /* @__PURE__ */ new Set([
    "ToolSearch",
    "SendMessage",
    "TeamCreate",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "TaskGet"
  ]);
  /** Check if a tool name is recall_memory */
  static isRecallMemory(name) {
    return name === "recall_memory"
      || name === "mcp__plugin_mixdog_mixdog__recall_memory"
      || name === "mcp__plugin_mixdog_trib-plugin__recall_memory";
  }
  /** Check if a file path points to a memory file */
  static isMemoryFile(filePath) {
    if (!filePath) return false;
    const normalized = filePath.replace(/\\/g, "/");
    if (normalized.includes(".claude/projects/") && normalized.includes("/memory/")) return true;
    if (basename(normalized) === "MEMORY.md") return true;
    return false;
  }
  /** Check if a tool should be hidden */
  static isHidden(name) {
    if (OutputForwarder.HIDDEN_TOOLS.has(name)) return true;
    if (name.includes("plugin_mixdog") && !name.endsWith("recall_memory") || name === "reply" || name === "react" || name === "edit_message" || name === "fetch" || name === "download_attachment") return true;
    return false;
  }
  /**
   * Build a per-call dedup key for tool-log queue items.
   * Uses the full (unsquished) tool args so that two Reads on distinct files
   * sharing a basename, or two Grep/Glob calls sharing only a pattern prefix,
   * do not collapse onto the same key and suppress the second send.
   * Returns "" to fall back to md5(formatted) at delivery time.
   */
  static buildDedupKey(name, input) {
    if (!name || !input || typeof input !== "object") return "";
    switch (name) {
      case "Read":
        return input.file_path ? "read:" + input.file_path : "";
      case "Grep":
        return "grep:" + (input.pattern ?? "") + ":" + (input.path ?? "");
      case "Glob":
        return "glob:" + (input.pattern ?? "") + ":" + (input.path ?? "");
      default:
        return "";
    }
  }
  /** Build a tool log line from the tool name and input. */
  static buildToolLine(name, input) {
    if (OutputForwarder.isHidden(name)) return null;
    let displayName = name;
    let summary = "";
    let detail = "";
    const isSearchTool = name === "Read" || name === "Grep" || name === "Glob";
    switch (name) {
      case "Bash": {
        const desc = (input?.description || "").substring(0, 50);
        summary = desc || "Bash";
        detail = (input?.command || "").substring(0, 500);
        break;
      }
      case "Read":
        summary = input?.file_path ? basename(input.file_path) : "";
        break;
      case "Grep":
        summary = '"' + (input?.pattern || "").substring(0, 25) + '"';
        break;
      case "Glob":
        summary = (input?.pattern || "").substring(0, 25);
        break;
      case "Edit":
      case "Write":
        summary = input?.file_path ? basename(input.file_path) : "";
        detail = input?.file_path || "";
        break;
      case "Agent": {
        summary = input?.name || input?.subagent_type || "agent";
        let d = (input?.prompt || "").substring(0, 200);
        const backticks = (d.match(/```/g) || []).length;
        if (backticks % 2 === 1) d += "\n```";
        if (d.length < (input?.prompt || "").length) d += "...";
        detail = d;
        break;
      }
      case "TeamCreate":
        summary = input?.team_name || "";
        detail = input?.description || "";
        break;
      case "TaskCreate":
        summary = (input?.subject || "").substring(0, 50);
        break;
      case "Skill":
        summary = input?.skill || "";
        break;
      default:
        if (name.startsWith("mcp__")) {
          const parts = name.split("__");
          displayName = "mcp";
          summary = parts[parts.length - 1] || "";
        } else {
          summary = name;
        }
        break;
    }
    if (!summary) return null;
    let toolLine = displayName === summary ? "\u25CF **" + displayName + "**" : "\u25CF **" + displayName + "** (" + summary + ")";
    if (!isSearchTool && detail && detail !== summary) {
      const lines = detail.substring(0, 500).split("\n");
      const shown = lines.slice(0, 5);
      let block = shown.join("\n");
      if (lines.length > 5) block += "\n... +" + (lines.length - 5) + " lines";
      toolLine += "\n" + safeCodeBlock(block);
    }
    return toolLine;
  }
  // ── File watch ─────────────────────────────────────────────────────
  /** Set callback for idle detection (no new data for 5s after assistant entry) */
  setOnIdle(cb) {
    this.onIdleCallback = cb;
  }
  /** Start watching transcript file for changes (runs once, never stops) */
  startWatch() {
    if (!this.transcriptPath) return;
    if (this.watchingPath === this.transcriptPath && this.watcher) return;
    this.closeWatcher();
    this.watchingPath = this.transcriptPath;
    try {
      this.watcher = watch(this.transcriptPath, () => this.scheduleWatchFlush());
      this.watcher.on("error", () => this.closeWatcher());
    } catch {
      this.closeWatcher();
    }
  }
  /** No-op — watch is kept alive permanently */
  stopWatch() {
  }
  /** Reset the idle timer — safety net in case turn-end signal is missed */
  resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.onIdleCallback) this.onIdleCallback();
    }, 1e3);
  }
  closeWatcher() {
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
      this.watchDebounce = null;
    }
    if (this.sendRetryTimer) {
      clearTimeout(this.sendRetryTimer);
      this.sendRetryTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.watchingPath = "";
  }
  scheduleWatchFlush() {
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = null;
      if (this.transcriptPath && !existsSync(this.transcriptPath)) {
        const relocated = findLatestTranscriptByMtime();
        if (relocated && relocated !== this.transcriptPath) {
          process.stderr.write(`mixdog: watched transcript gone during flush, relocated to ${relocated}
`);
          this.closeWatcher();
          this.transcriptPath = relocated;
          this.mainSessionId = "";
          this.startWatch();
        }
        return;
      }
      void this.forwardNewText().then((hadText) => {
        if (hadText) {
          this.resetIdleTimer();
        }
      });
    }, 200);
  }
  updateState(mutator) {
    this.statusState.update(mutator);
  }
  persistState() {
    this.updateState((state) => {
      state.lastFileSize = this.lastFileSize;
      state.sentCount = this.sentCount;
      state.lastSentHash = this.lastHash;
      state.lastSentTime = Date.now();
      state.emoji = this.emoji;
      state.sessionIdle = false;
    });
  }
}
export {
  OutputForwarder,
  cwdToProjectSlug,
  discoverCurrentClaudeSession,
  discoverSessionBoundTranscript,
  findLatestTranscriptByMtime,
  getLatestInteractiveClaudeSession,
  listInteractiveClaudeSessions
};
