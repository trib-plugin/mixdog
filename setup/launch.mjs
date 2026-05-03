#!/usr/bin/env bun
import { spawn, execSync } from 'child_process';
import { openSync, closeSync, readFileSync, writeSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const server = join(__dirname, 'setup-server.mjs');
// Reuse the launcher's own runtime (bun.exe, since the slash command and the
// shebang both invoke bun). Spawning by absolute path lets us drop shell:true
// on Windows; the cmd.exe wrapper was swallowing the child's stderr and
// turning real bun startup errors into an empty launch log.
const CHILD_INTERPRETER = process.execPath;
const PORT = 3458;

// Slash-command shells expand ${CLAUDE_PLUGIN_ROOT} into argv but do not
// export it, so the spawned setup-server inherits a stripped env. Re-derive
// both ROOT and DATA from this script's location so plugin-paths and the
// stricter channels-lib guard (which checks CLAUDE_PLUGIN_DATA directly)
// both succeed inside the detached child.
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || dirname(__dirname);
process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT;
const { resolvePluginData } = await import('../src/shared/plugin-paths.mjs');
const PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA || resolvePluginData();
process.env.CLAUDE_PLUGIN_DATA = PLUGIN_DATA;

function ping(timeoutMs = 1500) {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${PORT}/`, res => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

// GET /api/plugin-path. Returns the absolute plugin root the running
// setup-server identifies as, or null on any failure. Used to detect a
// stale or wrong-plugin server still bound to PORT before we hand it the
// /open call — otherwise a different version's setup window can pop up
// when the user invokes this launcher.
function fetchPluginPath(timeoutMs = 1500) {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${PORT}/api/plugin-path`, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(typeof json?.path === 'string' ? json.path : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

// Walk up the process tree from our immediate parent (the shell wrapping
// `node launch.mjs`) and skip past short-lived shell shims to find the
// first long-lived ancestor — the Claude Code CLI (or MCP host) that
// actually owns this session. The immediate parent is the shell, which
// exits the moment launch.mjs returns; the grandparent on Windows slash
// commands is often a single-shot cmd.exe that also dies right away.
// Tracking either makes setup-server commit suicide ~5s after spawn (see
// the watchdog in setup-server.mjs). Walk up to MAX_DEPTH levels and
// return the first ancestor whose image name is NOT a known shell shim.
function findAncestorPid() {
  const immediate = process.ppid;
  if (!Number.isFinite(immediate) || immediate <= 0) return 0;
  const MAX_DEPTH = 6;
  const SHELL_NAMES = new Set([
    'cmd.exe', 'powershell.exe', 'pwsh.exe',
    'sh', 'sh.exe', 'bash', 'bash.exe', 'zsh', 'zsh.exe',
  ]);
  try {
    if (process.platform === 'win32') {
      // One PowerShell call walks up MAX_DEPTH levels and emits
      // "<pid>|<name>" per ancestor (immediate parent first). Spawning
      // powershell once per step would multiply startup cost, so the
      // walk is batched into a single invocation.
      const script =
        `$pid0 = ${immediate}; ` +
        `for ($i = 0; $i -lt ${MAX_DEPTH}; $i++) { ` +
        `  $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $pid0) -ErrorAction SilentlyContinue; ` +
        `  if (-not $p) { break } ` +
        `  Write-Output ('{0}|{1}' -f $p.ProcessId, $p.Name); ` +
        `  if (-not $p.ParentProcessId) { break } ` +
        `  $pid0 = $p.ParentProcessId ` +
        `}`;
      const out = execSync(
        `powershell -NoProfile -Command "${script}"`,
        { encoding: 'utf8', timeout: 3000, windowsHide: true },
      ).trim();
      for (const line of out.split(/\r?\n/)) {
        const [pidStr, name] = line.split('|');
        const pid = parseInt(pidStr, 10);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        const lower = (name || '').trim().toLowerCase();
        if (SHELL_NAMES.has(lower)) continue;
        return pid;
      }
    } else {
      let cur = immediate;
      for (let i = 0; i < MAX_DEPTH; i++) {
        const out = execSync(
          `ps -o ppid=,comm= -p ${cur}`,
          { encoding: 'utf8', timeout: 3000 },
        ).trim();
        if (!out) break;
        const m = out.match(/^\s*(\d+)\s+(.*)$/);
        if (!m) break;
        const ppid = parseInt(m[1], 10);
        if (!Number.isFinite(ppid) || ppid <= 0) break;
        const name = (m[2] || '').trim();
        // basename — `ps -o comm=` may emit a full path on some systems.
        const lower = name.split(/[\\/]/).pop().toLowerCase();
        if (!SHELL_NAMES.has(lower)) return ppid;
        cur = ppid;
      }
    }
  } catch {}
  // Ancestor lookup failed or every level we could see was a known shell
  // shim. Passing any of those to the watchdog would make setup-server
  // commit suicide as soon as the shim exits. Return 0 so the caller
  // skips MIXDOG_SETUP_PARENT_PID and the watchdog stays disabled — the
  // detached server simply keeps running.
  return 0;
}

function requestOpen() {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${PORT}/open`, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json.ok === true);
        } catch {
          resolve(res.statusCode >= 200 && res.statusCode < 300);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer(timeoutMs = 4000, shouldStop = () => false) {
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await ping(500);
    if (shouldStop()) break;
    await sleep(250);
  }
  return ready && !shouldStop();
}

function openLaunchLog() {
  const path = join(tmpdir(), `mixdog-setup-launch-${process.pid}.log`);
  const fd = openSync(path, 'a');
  writeSync(fd, [
    '',
    `[${new Date().toISOString()}] setup-server launch`,
    `launcherPid=${process.pid}`,
    `execPath=${process.execPath}`,
    `interpreter=${CHILD_INTERPRETER}`,
    `server=${server}`,
    `cwd=${dirname(__dirname)}`,
    '--- child stdout/stderr ---',
  ].join('\n') + '\n');
  return { path, fd };
}

function writeLog(fd, message) {
  try {
    if (typeof fd === 'number') writeSync(fd, message);
  } catch {}
}

function closeLog(fd) {
  try {
    if (typeof fd === 'number') closeSync(fd);
  } catch {}
}

function readLog(path) {
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
}

async function exitWithError(message) {
  await new Promise(resolve => process.stderr.write(message, resolve));
  process.exit(1);
}

const alive = await ping();

if (!alive) {
  // Pass launcher's parent PID (Claude Code CLI process) so setup-server can
  // self-terminate when that parent dies — prevents Windows zombies after the
  // MCP host exits (v0.6.0 zombie fix covered workers only; this is the
  // detached-process equivalent).
  const launchLog = openLaunchLog();
  let spawnError = null;
  let childExit = null;
  let child;

  try {
    child = spawn(CHILD_INTERPRETER, [server], {
      detached: true,
      // Use a real file descriptor, not parent pipes/stdio. This keeps the
      // detached child independent after unref() while preserving first-start
      // stdout/stderr for diagnostics. shell:false (default) on every
      // platform — cmd.exe wrapping was eating the child's stderr.
      stdio: ['ignore', launchLog.fd, launchLog.fd],
      cwd: PLUGIN_ROOT,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        CLAUDE_PLUGIN_DATA: PLUGIN_DATA,
        MIXDOG_SETUP_OPEN_ON_START: '1',
        MIXDOG_SETUP_PARENT_PID: String(findAncestorPid() || ''),
      },
      windowsHide: true,
    });
  } catch (error) {
    closeLog(launchLog.fd);
    await exitWithError(
      `Failed to spawn setup-server for http://localhost:${PORT}\n` +
      `Launch log: ${launchLog.path}\n` +
      `${error?.stack || error?.message || String(error)}\n`,
    );
  }

  child.once('error', error => {
    spawnError = error;
    writeLog(launchLog.fd, `\n[${new Date().toISOString()}] child error: ${error?.stack || error?.message || String(error)}\n`);
  });
  child.once('exit', (code, signal) => {
    childExit = { code, signal };
    writeLog(launchLog.fd, `\n[${new Date().toISOString()}] child exit: code=${code} signal=${signal}\n`);
  });
  child.unref();

  if (!await waitForServer(4000, () => Boolean(spawnError || childExit))) {
    closeLog(launchLog.fd);
    const captured = readLog(launchLog.path);
    const status = spawnError
      ? `spawn error: ${spawnError?.stack || spawnError?.message || String(spawnError)}`
      : childExit
        ? `child exit: code=${childExit.code} signal=${childExit.signal}`
        : 'child did not report an error or exit before readiness timeout';
    await exitWithError(
      `setup-server did not become ready at http://localhost:${PORT}/ within 4000ms (${status}).\n` +
      `Launch log: ${launchLog.path}\n` +
      (captured ? `--- setup-server launch log ---\n${captured}\n--- end setup-server launch log ---\n` : 'No setup-server output was captured.\n'),
    );
  }

  closeLog(launchLog.fd);
} else {
  // Server already running on PORT — confirm it belongs to THIS plugin
  // install before reusing it. A stale or different-version setup-server
  // would otherwise pop up the wrong config window.
  const remoteRoot = await fetchPluginPath();
  if (remoteRoot) {
    // Normalize: trailing slash strip + backslash → forward slash + lowercase
    // so `C:/x` and `C:\x` compare equal (lowercase only on Windows — POSIX is case-sensitive).
    const normalize = p => { const s = p.replace(/[\\/]+$/, '').replace(/\\/g, '/'); return process.platform === 'win32' ? s.toLowerCase() : s; };
    const expected = normalize(PLUGIN_ROOT);
    const actual = normalize(remoteRoot);
    if (expected !== actual) {
      await exitWithError(
        `Port ${PORT} is in use by a different mixdog plugin instance.\n` +
        `  expected plugin root: ${PLUGIN_ROOT}\n` +
        `  actual plugin root:   ${remoteRoot}\n` +
        `Stop the other setup-server (or change PORT) and retry.\n`,
      );
    }
  }
  if (!await requestOpen()) {
    await exitWithError(`Failed to open config UI window for http://localhost:${PORT}\n`);
  }
}

process.stdout.write(`Config UI: http://localhost:${PORT}\n`, () => process.exit(0));
