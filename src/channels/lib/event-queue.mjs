import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync as fsExistsSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "./config.mjs";
import { ensureDir } from "./state-file.mjs";
import { logEvent } from "./executor.mjs";
const QUEUE_DIR = join(DATA_DIR, "events", "queue");
const IN_PROGRESS_DIR = join(DATA_DIR, "events", "in-progress");
const PROCESSED_DIR = join(DATA_DIR, "events", "processed");
class EventQueue {
  config;
  channelsConfig;
  tickTimer = null;
  batchTimer = null;
  runningCount = 0;
  injectFn = null;
  sendFn = null;
  sessionStateGetter = null;
  ownerGetter = null;
  ownerSkipLogged = false;
  notifiedFiles = /* @__PURE__ */ new Set();
  // Monotonic enqueue counter — prevents same-millisecond enqueue ordering
  // from being decided by Math.random() (lex sort on the random suffix).
  // Counter is 8-digit zero-padded so lex sort matches numeric order.
  enqueueSeq = 0;
  // track files already notified during active state
  constructor(config, channelsConfig) {
    this.config = config ?? {};
    this.channelsConfig = channelsConfig ?? null;
  }
  setInjectHandler(fn) {
    this.injectFn = fn;
  }
  setSendHandler(fn) {
    this.sendFn = fn;
  }
  setSessionStateGetter(fn) {
    this.sessionStateGetter = fn;
  }
  setOwnerGetter(fn) {
    this.ownerGetter = fn;
  }
  // ── Lifecycle ─────────────────────────────────────────────────────
  start() {
    if (this.tickTimer) return;
    ensureDir(QUEUE_DIR);
    ensureDir(IN_PROGRESS_DIR);
    ensureDir(PROCESSED_DIR);
    const tickMs = (this.config.tickInterval ?? 10) * 1e3;
    this.tickTimer = setInterval(() => this.processQueue(), tickMs);
    setTimeout(() => this.processQueue(), 3e3);
    const batchMs = (this.config.batchInterval ?? 30) * 6e4;
    this.batchTimer = setInterval(() => this.processBatch(), batchMs);
    logEvent("queue started");
  }
  stop() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }
  reloadConfig(config, channelsConfig) {
    this.stop();
    this.config = config ?? {};
    this.channelsConfig = channelsConfig ?? null;
    this.start();
  }
  // ── Enqueue ───────────────────────────────────────────────────────
  enqueue(item) {
    ensureDir(QUEUE_DIR);
    const seq = String(this.enqueueSeq++).padStart(8, "0");
    const id = `${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 6)}`;
    const filename = `${item.priority === "high" ? "0" : item.priority === "normal" ? "1" : "2"}-${id}.json`;
    // Write to .tmp first then atomic rename so a partially-written file
    // can't be read back by the next tick mid-enqueue. POSIX/NTFS rename
    // within the same dir is atomic.
    const finalPath = join(QUEUE_DIR, filename);
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(item, null, 2));
    renameSync(tmpPath, finalPath);
    logEvent(`${item.name}: enqueued (${item.priority})`);
    if (item.priority === "high") {
      this.processQueue();
    }
  }
  // ── Process queue ─────────────────────────────────────────────────
  processQueue() {
    // Belt-and-suspenders ownership guard: if this process is not the
    // active owner, do nothing. The runtime should only have started this
    // queue on the owner path, but an ownership hand-off can briefly leave
    // two processes both ticking — this short-circuits that window.
    // This is multi-process active-owner gating, not HTTP authentication.
    if (this.ownerGetter) {
      let isOwner = true;
      try { isOwner = !!this.ownerGetter(); } catch { isOwner = true; }
      if (!isOwner) {
        if (!this.ownerSkipLogged) {
          logEvent("queue: skipping tick — not owner");
          this.ownerSkipLogged = true;
        }
        return;
      }
      this.ownerSkipLogged = false;
    }
    const maxConcurrent = this.config.maxConcurrent ?? 2;
    const files = this.readQueueFiles();
    if (files.length === 0) return;
    const sessionState = this.sessionStateGetter?.() ?? "idle";
    const interactiveFiles = [];
    for (const file of files) {
      const item = this.readItem(file);
      if (!item) continue;
      if (item.priority === "low") continue;
      if (item.exec === "interactive") {
        interactiveFiles.push({ file, item });
        continue;
      }
      if (this.runningCount >= maxConcurrent) return;
      // Atomic claim: rename into in-progress/ before executing. If the
      // rename fails (another tick / cleanup raced, or file vanished),
      // skip this handle.
      const claimed = this.claimFile(file);
      if (!claimed) continue;
      this.executeItem(item, claimed);
    }
    if (interactiveFiles.length === 0) return;
    if (sessionState === "idle") {
      this.notifiedFiles.clear();
      for (const { file, item } of interactiveFiles) {
        const claimed = this.claimFile(file);
        if (!claimed) continue;
        this.executeItem(item, claimed);
      }
    } else {
      const unnotified = interactiveFiles.filter((f) => !this.notifiedFiles.has(f.file));
      if (unnotified.length > 0 && this.injectFn) {
        const count = interactiveFiles.length;
        this.injectFn("", "queue", " ", {
          instruction: `There are ${count} pending webhook/event items in the queue. The user is currently busy. Do not process them now \u2014 just be aware they exist. When the user seems available, briefly mention "${count} pending items" naturally.`,
          type: "queue"
        });
        for (const { file } of unnotified) {
          this.notifiedFiles.add(file);
        }
        logEvent(`queue: notified ${count} pending interactive items (session=${sessionState})`);
      }
    }
  }
  processBatch() {
    // Belt-and-suspenders ownership guard: if this process is not the
    // active owner, do nothing. The runtime should only have started this
    // queue on the owner path, but an ownership hand-off can briefly leave
    // two processes both ticking — this short-circuits that window.
    // This is multi-process active-owner gating, not HTTP authentication.
    if (this.ownerGetter) {
      let isOwner = true;
      try { isOwner = !!this.ownerGetter(); } catch { isOwner = true; }
      if (!isOwner) {
        if (!this.ownerSkipLogged) {
          logEvent("queue: skipping batch tick — not owner");
          this.ownerSkipLogged = true;
        }
        return;
      }
      this.ownerSkipLogged = false;
    }
    const files = this.readQueueFiles();
    const lowFiles = files.filter((f) => f.startsWith("2-"));
    if (lowFiles.length === 0) return;
    const groups = /* @__PURE__ */ new Map();
    for (const file of lowFiles) {
      const item = this.readItem(file);
      if (!item) continue;
      const group = groups.get(item.name) ?? { items: [], files: [] };
      group.items.push(item);
      group.files.push(file);
      groups.set(item.name, group);
    }
    for (const [name, group] of groups) {
      // Claim all batch files atomically BEFORE building the combined
      // prompt so overlapping batch ticks don't double-process. Files
      // that fail to claim are dropped from this batch, and their
      // corresponding items are excluded from the prompt.
      const claimedPairs = [];
      for (let i = 0; i < group.files.length; i++) {
        const claimed = this.claimFile(group.files[i]);
        if (claimed) claimedPairs.push({ file: claimed, item: group.items[i] });
      }
      if (claimedPairs.length === 0) continue;
      const combined = claimedPairs.length === 1 ? claimedPairs[0].item.prompt : `Batch of ${claimedPairs.length} events:

${claimedPairs.map((p, i) => `--- Event ${i + 1} ---
${p.item.prompt}`).join("\n\n")}`;
      const batchItem = {
        ...claimedPairs[0].item,
        prompt: combined
      };
      logEvent(`${name}: processing batch of ${claimedPairs.length}`);
      this.executeItem(batchItem, null);
      for (const { file: claimedPath } of claimedPairs) {
        this.moveInProgressToProcessed(claimedPath, "batched");
      }
    }
  }
  // ── Execute ───────────────────────────────────────────────────────
  // Only interactive items pass through the queue now. Delegate-mode
  // webhooks invoke bridge directly and never enqueue here; the legacy
  // non-interactive / script exec branches were removed.
  executeItem(item, file) {
    if (this.injectFn) {
      const opts = { type: "webhook" };
      if (item.instruction) {
        opts.instruction = `${item.instruction}\n\n${item.prompt}`;
      } else {
        opts.instruction = item.prompt;
      }
      this.injectFn("", `event:${item.name}`, " ", opts);
    }
    if (file) this.moveToProcessed(file, "injected");
  }
  // ── Helpers ───────────────────────────────────────────────────────
  readQueueFiles() {
    try {
      return readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return [];
    }
  }
  readItem(file) {
    try {
      return JSON.parse(readFileSync(join(QUEUE_DIR, file), "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") {
        logEvent(`queue: corrupt file ${file}`);
      }
      return null;
    }
  }
  // Atomically rename from queue/ to in-progress/. Returns the new
  // filename on success, or null if another worker already claimed it /
  // the file vanished. Uses renameSync which is atomic on same volume.
  claimFile(file) {
    try {
      ensureDir(IN_PROGRESS_DIR);
      const claimed = `in-progress-${Date.now()}-${file}`;
      renameSync(join(QUEUE_DIR, file), join(IN_PROGRESS_DIR, claimed));
      return claimed;
    } catch (err) {
      // ENOENT: another tick grabbed it; EEXIST: target collision (very rare).
      if (err && err.code && err.code !== "ENOENT" && err.code !== "EEXIST") {
        logEvent(`queue: claim failed for ${file}: ${err.message ?? err}`);
      }
      return null;
    }
  }
  moveToProcessed(file, status) {
    // `file` may already live under in-progress/ (claimed) or still in
    // queue/ (batch paths / legacy callers). Try both.
    try {
      ensureDir(PROCESSED_DIR);
      const fromInProgress = join(IN_PROGRESS_DIR, file);
      const fromQueue = join(QUEUE_DIR, file);
      const src = this.existsSync(fromInProgress) ? fromInProgress : fromQueue;
      renameSync(src, join(PROCESSED_DIR, `${status}-${file}`));
    } catch {
    }
  }
  moveInProgressToProcessed(file, status) {
    try {
      ensureDir(PROCESSED_DIR);
      renameSync(join(IN_PROGRESS_DIR, file), join(PROCESSED_DIR, `${status}-${file}`));
    } catch {
    }
  }
  existsSync(p) {
    try {
      // readdirSync-free existence check via renameSync would be destructive —
      // fall back to a cheap stat via readFileSync on non-content probe.
      // Use fs.existsSync semantics without importing it twice.
      return fsExistsSync(p);
    } catch {
      return false;
    }
  }
  resolveChannel(label) {
    if (!label || !this.channelsConfig) return "";
    const entry = this.channelsConfig?.[label];
    return entry?.channelId ?? label;
  }
  /** Remove items from queue — after processing, dismissal, or any resolution */
  resolveItems(name, status = "done") {
    const files = this.readQueueFiles();
    let count = 0;
    for (const file of files) {
      const item = this.readItem(file);
      if (!item) continue;
      if (item.name === name || name === "*") {
        this.moveToProcessed(file, status);
        this.notifiedFiles.delete(file);
        count++;
      }
    }
    if (count > 0) logEvent(`queue: resolved ${count} items (name=${name}, status=${status})`);
    return count;
  }
  /** Get queue status */
  getStatus() {
    const pending = this.readQueueFiles().length;
    return { pending, running: this.runningCount };
  }
  /** List pending interactive items */
  getPendingInteractive() {
    return this.readQueueFiles().map((f) => this.readItem(f)).filter((item) => item !== null && item.exec === "interactive");
  }
}
export {
  EventQueue
};
