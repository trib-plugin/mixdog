#!/usr/bin/env node
/**
 * MCP server launcher for mixdog.
 * Starts the server.mjs in stdio mode.
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', 'server.mjs');

// Spawn the server with stdio inheritance and reduced CPU priority
const isWin = process.platform === 'win32';
const proc = spawn('node', [serverPath], {
  stdio: 'inherit',
  env: { ...process.env, UV_THREADPOOL_SIZE: '2' },
  ...(isWin ? { windowsHide: true } : {}),
});

// Lower process priority on Windows to reduce fan noise
if (isWin && proc.pid) {
  try {
    const { execSync } = await import('child_process');
    execSync(`wmic process where processid=${proc.pid} call setpriority "below normal"`, { stdio: 'ignore', windowsHide: true });
  } catch {}
}

function killChild() {
  if (isWin && proc.pid) {
    try {
      const { execSync } = await import('child_process');
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    } catch {}
  } else {
    proc.kill('SIGTERM');
  }
}

process.on('SIGTERM', killChild);
process.on('SIGINT', killChild);
process.stdin.on('end', killChild);
process.stdin.on('close', killChild);

proc.on('exit', (code) => {
  process.exit(code || 0);
});
