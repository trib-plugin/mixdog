#!/usr/bin/env node
import { spawn, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const server = join(__dirname, 'setup-server.mjs');
const PORT = 3458;

function ping() {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${PORT}/`, res => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
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

const alive = await ping();

if (!alive) {
  // Pass launcher's parent PID (Claude Code CLI process) so setup-server can
  // self-terminate when that parent dies — prevents Windows zombies after the
  // MCP host exits (v0.6.0 zombie fix covered workers only; this is the
  // detached-process equivalent).
  const child = spawn(process.execPath, [server], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    cwd: dirname(__dirname),
    env: {
      ...process.env,
      MIXDOG_SETUP_OPEN_ON_START: '1',
      MIXDOG_SETUP_PARENT_PID: String(findAncestorPid() || ''),
    },
    windowsHide: true,
    shell: false,
  });
  child.unref();
} else if (!await requestOpen()) {
  process.stderr.write(`Failed to open config UI window for http://localhost:${PORT}\n`, () => process.exit(1));
}

process.stdout.write(`Config UI: http://localhost:${PORT}\n`, () => process.exit(0));
