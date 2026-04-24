#!/usr/bin/env node
import { spawn, execSync } from 'child_process';
import { openSync, closeSync, readFileSync, writeSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const server = join(__dirname, 'setup-server.mjs');
const PORT = 3458;

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

// Walk up the process tree from our immediate parent (the shell wrapping
// `node launch.mjs`) to find the grandparent — the Claude Code CLI that
// actually owns this session. process.ppid here is the shell, which exits
// the moment launch.mjs returns; tracking it makes setup-server commit
// suicide 5s after spawn. The grandparent is the long-lived process whose
// death should actually reap the UI server.
function findAncestorPid() {
  const immediate = process.ppid;
  if (!Number.isFinite(immediate) || immediate <= 0) return 0;
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${immediate}').ParentProcessId"`,
        { encoding: 'utf8', timeout: 3000, windowsHide: true },
      ).trim();
      const pid = parseInt(out, 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    } else {
      const out = execSync(`ps -o ppid= -p ${immediate}`, { encoding: 'utf8', timeout: 3000 }).trim();
      const pid = parseInt(out, 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch {}
  // Grandparent lookup failed — the immediate parent is the shell wrapping
  // `node launch.mjs`, which exits as soon as launch.mjs returns. Passing it
  // to the watchdog would make setup-server commit suicide on the next tick.
  // Return 0 so the caller skips MIXDOG_SETUP_PARENT_PID and the watchdog
  // stays disabled — the detached server simply keeps running.
  return 0;
}

function requestOpen() {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${PORT}/open`, res => {
      res.resume();
      resolve(res.statusCode && res.statusCode < 400);
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
    child = spawn(process.execPath, [server], {
      detached: true,
      // Use a real file descriptor, not parent pipes/stdio. This keeps the
      // detached child independent after unref() while preserving first-start
      // stdout/stderr for diagnostics.
      stdio: ['ignore', launchLog.fd, launchLog.fd],
      cwd: dirname(__dirname),
      env: {
        ...process.env,
        MIXDOG_SETUP_OPEN_ON_START: '1',
        MIXDOG_SETUP_PARENT_PID: String(findAncestorPid() || ''),
      },
      windowsHide: true,
      shell: false,
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
} else if (!await requestOpen()) {
  await exitWithError(`Failed to open config UI window for http://localhost:${PORT}\n`);
}

process.stdout.write(`Config UI: http://localhost:${PORT}\n`, () => process.exit(0));
