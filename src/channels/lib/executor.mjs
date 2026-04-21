import { spawn } from "child_process";
import { existsSync, mkdirSync, appendFileSync } from "fs";
import { join, normalize, extname } from "path";
import { tmpdir } from "os";
import { DATA_DIR } from "./config.mjs";
import { runCliWorkerTask } from "./cli-worker-host.mjs";
const SCRIPTS_DIR = join(DATA_DIR, "scripts");
const NOPLUGIN_DIR = join(tmpdir(), "mixdog-noplugin");
const EVENT_LOG = join(DATA_DIR, "event.log");
function logEvent(msg) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`;
  try {
    process.stderr.write(`mixdog event: ${msg}
`);
  } catch {
  }
  try {
    appendFileSync(EVENT_LOG, line);
  } catch {
  }
}
function parseGithub(body, headers) {
  const event = headers["x-github-event"] || "";
  const action = body.action || "";
  const pr = body.pull_request || body.issue || {};
  return {
    event,
    action,
    title: pr.title || body.head_commit?.message || "",
    author: pr.user?.login || body.sender?.login || "",
    repo: body.repository?.full_name || "",
    url: pr.html_url || body.compare || "",
    branch: body.ref || pr.head?.ref || "",
    message: body.head_commit?.message || ""
  };
}
function parseSentry(body) {
  const data = body.data || {};
  const evt = data.event || data.issue || {};
  return {
    title: evt.title || body.message || "",
    level: evt.level || body.level || "",
    project: body.project_name || body.project || "",
    url: evt.web_url || body.url || ""
  };
}
function parseGeneric(body) {
  const result = {};
  const keys = Object.keys(body).slice(0, 5);
  for (const k of keys) {
    result[k] = typeof body[k] === "string" ? body[k] : JSON.stringify(body[k]);
  }
  return result;
}
function applyParser(parser, body, headers) {
  switch (parser) {
    case "github":
      return parseGithub(body, headers);
    case "sentry":
      return parseSentry(body);
    case "generic":
      return parseGeneric(body);
    default:
      return { raw: JSON.stringify(body) };
  }
}
function evaluateFilter(expr, data) {
  const orParts = expr.split("||").map((s) => s.trim());
  for (const orPart of orParts) {
    const andParts = orPart.split("&&").map((s) => s.trim());
    let andResult = true;
    for (const condition of andParts) {
      const match = condition.match(/^(\w+)\s*==\s*['"](.*)['"]$/);
      if (!match) {
        const neqMatch = condition.match(/^(\w+)\s*!=\s*['"](.*)['"]$/);
        if (neqMatch) {
          const [, field2, value2] = neqMatch;
          if ((data[field2] ?? "") === value2) {
            andResult = false;
            break;
          }
        } else {
          andResult = false;
          break;
        }
        continue;
      }
      const [, field, value] = match;
      if ((data[field] ?? "") !== value) {
        andResult = false;
        break;
      }
    }
    if (andResult) return true;
  }
  return false;
}
function applyTemplate(template, data) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? "");
}
function ensureNopluginDir() {
  mkdirSync(NOPLUGIN_DIR, { recursive: true });
}
function spawnClaudeP(name, prompt, onResult) {
  ensureNopluginDir();
  logEvent(`${name}: dispatching to cli worker`);
  const wrappedPrompt = prompt + "\n\nIMPORTANT: Output your final result as plain text to stdout. Do NOT use any reply, messaging, or channel tools. Just print the result.";
  const args = [
    "-p",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--plugin-dir",
    NOPLUGIN_DIR
  ];
  void runCliWorkerTask({
    command: "claude",
    args,
    stdin: wrappedPrompt,
    timeout: 12e4,
    env: { ...process.env, MIXDOG_CHANNELS_NO_CONNECT: "1" }
  }).then((result) => {
    const lines = result.stdout.trim().split("\n");
    const text = lines.slice(-30).join("\n").substring(0, 1900);
    logEvent(`${name}: cli worker completed (${result.code})`);
    onResult(text, result.code);
  }).catch((err) => {
    logEvent(`${name}: cli worker error: ${err.message}`);
    onResult("", null);
  });
}
function runScript(name, scriptName, onResult) {
  if (!existsSync(SCRIPTS_DIR)) {
    mkdirSync(SCRIPTS_DIR, { recursive: true });
  }
  const scriptPath = normalize(join(SCRIPTS_DIR, scriptName));
  if (!scriptPath.startsWith(SCRIPTS_DIR)) {
    logEvent(`${name}: script path escapes directory: ${scriptName}`);
    onResult("", null);
    return;
  }
  if (!existsSync(scriptPath)) {
    logEvent(`${name}: script not found: ${scriptPath}`);
    onResult("", null);
    return;
  }
  const ext = extname(scriptName).toLowerCase();
  const cmd = ext === ".py" ? "python3" : "node";
  const proc = spawn(cmd, [scriptPath], {
    timeout: 3e4,
    env: { ...process.env }
  });
  let stdout = "";
  let stderr = "";
  if (proc.stdout) proc.stdout.on("data", (d) => {
    stdout += d;
  });
  if (proc.stderr) proc.stderr.on("data", (d) => {
    stderr += d;
  });
  proc.on("close", (code) => {
    if (code !== 0) {
      logEvent(`${name}: script exited ${code}: ${stderr.substring(0, 500)}`);
    }
    onResult(stdout.substring(0, 2e3), code);
  });
  proc.on("error", (err) => {
    logEvent(`${name}: script spawn error: ${err.message}`);
    onResult("", null);
  });
}
export {
  applyParser,
  applyTemplate,
  ensureNopluginDir,
  evaluateFilter,
  logEvent,
  parseGeneric,
  parseGithub,
  parseSentry,
  runScript,
  spawnClaudeP
};
