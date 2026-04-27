import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { ensureDir, readJsonFile, removeFileIfExists, writeJsonFile } from "./state-file.mjs";
const RUNTIME_ROOT = join(tmpdir(), "mixdog");
const OWNER_DIR = join(RUNTIME_ROOT, "owners");
const ACTIVE_INSTANCE_FILE = join(RUNTIME_ROOT, "active-instance.json");
const RUNTIME_STALE_TTL = 24 * 60 * 60 * 1e3;
function sanitize(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function forEachFile(dirPath, visit) {
  try {
    for (const fileName of readdirSync(dirPath)) {
      visit(join(dirPath, fileName), fileName);
    }
  } catch {
  }
}
function ensureRuntimeDirs() {
  ensureDir(RUNTIME_ROOT);
  ensureDir(OWNER_DIR);
}
function makeInstanceId(pid = process.pid) {
  return String(pid);
}
function getTurnEndPath(instanceId) {
  return join(RUNTIME_ROOT, `turn-end-${sanitize(instanceId)}`);
}
function getStatusPath(instanceId) {
  return join(RUNTIME_ROOT, `status-${sanitize(instanceId)}.json`);
}
function getControlPath(instanceId) {
  return join(RUNTIME_ROOT, `control-${sanitize(instanceId)}.json`);
}
function getControlResponsePath(instanceId) {
  return join(RUNTIME_ROOT, `control-${sanitize(instanceId)}.response.json`);
}
function getPermissionResultPath(instanceId, uuid) {
  return join(RUNTIME_ROOT, `perm-${sanitize(instanceId)}-${sanitize(uuid)}.result`);
}
function getStopFlagPath(instanceId) {
  return join(RUNTIME_ROOT, `stop-${sanitize(instanceId)}.flag`);
}
function getChannelOwnerPath(channelId) {
  return join(OWNER_DIR, `${sanitize(channelId)}.json`);
}
function readActiveInstance() {
  const state = readJsonFile(ACTIVE_INSTANCE_FILE, null);
  if (!state) return null;
  try {
    process.kill(state.pid, 0);
  } catch {
    process.stderr.write(`mixdog: stale active-instance.json (PID ${state.pid} is dead), removing
`);
    removeFileIfExists(ACTIVE_INSTANCE_FILE);
    return null;
  }
  return state;
}
function writeActiveInstance(state) {
  ensureRuntimeDirs();
  writeJsonFile(ACTIVE_INSTANCE_FILE, state);
}
function buildActiveInstanceState(instanceId, meta) {
  return {
    instanceId,
    pid: process.pid,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    turnEndFile: getTurnEndPath(instanceId),
    statusFile: getStatusPath(instanceId),
    ...meta?.channelId ? { channelId: meta.channelId } : {},
    ...meta?.transcriptPath ? { transcriptPath: meta.transcriptPath } : {},
    ...meta?.httpPort ? { httpPort: meta.httpPort } : {},
    ...typeof meta?.backendReady === "boolean" ? { backendReady: meta.backendReady } : {}
  };
}
function refreshActiveInstance(instanceId, meta) {
  const prev = readActiveInstance();
  const next = {
    ...prev?.instanceId === instanceId ? prev : buildActiveInstanceState(instanceId),
    updatedAt: Date.now(),
    ...meta?.channelId ? { channelId: meta.channelId } : {},
    ...meta?.transcriptPath ? { transcriptPath: meta.transcriptPath } : {},
    ...meta?.httpPort ? { httpPort: meta.httpPort } : {},
    ...typeof meta?.backendReady === "boolean" ? { backendReady: meta.backendReady } : {}
  };
  writeActiveInstance(next);
  return next;
}
const SERVER_PID_FILE = join(
  RUNTIME_ROOT,
  `server-${sanitize(process.env.CLAUDE_PLUGIN_DATA ?? "default")}.pid`
);
function looksLikeTribChannelsServer(pid) {
  const pidStr = String(pid);
  if (process.platform === "win32") {
    try {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pidStr}`, "/FO", "CSV", "/NH"], { encoding: "utf8" }).trim();
      if (!out || out.includes("No tasks")) return false;
      const lower = out.toLowerCase();
      return lower.includes("server.ts") && (lower.includes("node") || lower.includes("tsx") || lower.includes("mixdog"));
    } catch {
      return true;
    }
  }
  try {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", pidStr], { encoding: "utf8" }).trim();
    if (!cmd) return false;
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? "";
    if (!cmd.includes("server.ts")) return false;
    return cmd.includes("mixdog") || pluginRoot && cmd.includes(pluginRoot) || cmd.includes("tsx server.ts") || cmd.includes("node") && cmd.includes("server");
  } catch {
    return false;
  }
}
function waitForExit(pid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    const wait = 100;
    const end = Date.now() + wait;
    while (Date.now() < end) {
    }
  }
  return false;
}
function killSinglePid(pid) {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { encoding: "utf8", timeout: 5e3 });
    } catch (err) {
      console.warn(`[singleton] taskkill failed for PID ${pid}:`, err.message);
    }
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
    }
    if (!waitForExit(pid, 2e3)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
      if (!waitForExit(pid, 1e3)) {
        console.warn(`[singleton] failed to kill previous server PID ${pid}`);
      }
    }
  }
}
function killAllPreviousServers() {
  try {
    const oldPid = parseInt(readFileSync(SERVER_PID_FILE, "utf8").trim(), 10);
    if (oldPid && oldPid !== process.pid && oldPid !== process.ppid) {
      try {
        process.kill(oldPid, 0);
      } catch {
        return;
      }
      if (looksLikeTribChannelsServer(oldPid)) {
        killSinglePid(oldPid);
      }
    }
  } catch {
  }
}
function writeServerPid() {
  ensureRuntimeDirs();
  writeFileSync(SERVER_PID_FILE, String(process.pid));
}
function clearServerPid() {
  try {
    const current = readFileSync(SERVER_PID_FILE, "utf8").trim();
    if (current === String(process.pid)) removeFileIfExists(SERVER_PID_FILE);
  } catch {
  }
}
function cleanupStaleRuntimeFiles(now = Date.now()) {
  ensureRuntimeDirs();
  forEachFile(RUNTIME_ROOT, (fullPath, file) => {
    if (file === "owners" || file === "active-instance.json") return;
    try {
      if (now - statSync(fullPath).mtimeMs > RUNTIME_STALE_TTL) removeFileIfExists(fullPath);
    } catch {
    }
  });
  forEachFile(OWNER_DIR, (fullPath) => {
    try {
      if (now - statSync(fullPath).mtimeMs > RUNTIME_STALE_TTL) removeFileIfExists(fullPath);
    } catch {
    }
  });
}
function cleanupInstanceRuntimeFiles(instanceId) {
  const targets = [
    getTurnEndPath(instanceId),
    getStatusPath(instanceId),
    getControlPath(instanceId),
    getControlResponsePath(instanceId),
    getStopFlagPath(instanceId)
  ];
  for (const target of targets) {
    removeFileIfExists(target);
  }
  forEachFile(RUNTIME_ROOT, (fullPath, file) => {
    if (file.startsWith(`perm-${sanitize(instanceId)}-`)) {
      removeFileIfExists(fullPath);
    }
  });
}
function releaseOwnedChannelLocks(instanceId) {
  forEachFile(OWNER_DIR, (fullPath) => {
    const owner = readJsonFile(fullPath, null);
    if (owner?.instanceId === instanceId) removeFileIfExists(fullPath);
  });
}
function clearActiveInstance(instanceId) {
  const active = readActiveInstance();
  if (active?.instanceId !== instanceId) return;
  removeFileIfExists(ACTIVE_INSTANCE_FILE);
}
export {
  ACTIVE_INSTANCE_FILE,
  OWNER_DIR,
  RUNTIME_ROOT,
  RUNTIME_STALE_TTL,
  buildActiveInstanceState,
  cleanupInstanceRuntimeFiles,
  cleanupStaleRuntimeFiles,
  clearActiveInstance,
  clearServerPid,
  ensureRuntimeDirs,
  getChannelOwnerPath,
  getControlPath,
  getControlResponsePath,
  getPermissionResultPath,
  getStatusPath,
  getStopFlagPath,
  getTurnEndPath,
  killAllPreviousServers,
  makeInstanceId,
  readActiveInstance,
  refreshActiveInstance,
  releaseOwnedChannelLocks,
  writeActiveInstance,
  writeServerPid
};
