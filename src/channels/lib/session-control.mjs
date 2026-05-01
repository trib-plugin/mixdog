import { existsSync, readFileSync, unlinkSync, writeFileSync, renameSync } from "fs";
import { setTimeout as delay } from "timers/promises";
import { getControlPath, getControlResponsePath } from "./runtime-paths.mjs";
async function controlClaudeSession(instanceId, command, timeoutMs = 3e3) {
  const controlPath = getControlPath(instanceId);
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  // Per-request response file avoids concurrent callers unlinking each other's responses
  const responsePath = getControlResponsePath(instanceId) + `.${id}`;
  const sharedResponsePath = getControlResponsePath(instanceId);
  try {
    unlinkSync(sharedResponsePath);
  } catch {
  }
  // Write control atomically via tmp+rename
  const controlTmp = controlPath + `.${id}.tmp`;
  writeFileSync(controlTmp, JSON.stringify({ id, command, requestedAt: Date.now(), responsePath }));
  renameSync(controlTmp, controlPath);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(responsePath) || existsSync(sharedResponsePath)) {
      try {
        const readPath = existsSync(responsePath) ? responsePath : sharedResponsePath;
        const payload = JSON.parse(readFileSync(readPath, "utf8"));
        if (payload.id === id) return payload;
      } catch {
      }
    }
    await delay(100);
  }
  return {
    ok: false,
    mode: "unsupported",
    message: "session control timeout"
  };
}
export {
  controlClaudeSession
};
