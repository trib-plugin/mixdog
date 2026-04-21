#!/usr/bin/env node
import { spawn } from 'child_process';
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
      MIXDOG_SETUP_PARENT_PID: String(process.ppid || ''),
    },
    windowsHide: true,
    shell: false,
  });
  child.unref();
} else if (!await requestOpen()) {
  process.stderr.write(`Failed to open config UI window for http://localhost:${PORT}\n`, () => process.exit(1));
}

process.stdout.write(`Config UI: http://localhost:${PORT}\n`, () => process.exit(0));
