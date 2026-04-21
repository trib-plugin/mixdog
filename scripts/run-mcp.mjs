#!/usr/bin/env node
/**
 * MCP server launcher for mixdog.
 * Starts the server.mjs in stdio mode.
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { execSync, spawn, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(__dirname, '..');
const serverPath = join(pluginRoot, 'server.mjs');
const requiredDeps = [
  join(pluginRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'),
  join(pluginRoot, 'node_modules', 'zod', 'package.json'),
  join(pluginRoot, 'node_modules', 'zod-to-json-schema', 'package.json'),
  join(pluginRoot, 'node_modules', 'openai', 'package.json'),
];

function hasRequiredDeps() {
  return requiredDeps.every((file) => existsSync(file));
}

function ensureDependencies() {
  if (hasRequiredDeps()) return;
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = existsSync(join(pluginRoot, 'package-lock.json'))
    ? ['ci', '--ignore-scripts', '--omit=optional']
    : ['install', '--ignore-scripts', '--omit=optional'];
  process.stderr.write(`[run-mcp] bootstrapping dependencies via ${npmCmd} ${args.join(' ')}\n`);
  const result = spawnSync(npmCmd, args, {
    cwd: pluginRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    },
  });
  if (result.status !== 0 || !hasRequiredDeps()) {
    const detail = result.status ?? result.signal ?? 'unknown';
    throw new Error(`dependency bootstrap failed (${detail})`);
  }
}

ensureDependencies();

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
    execSync(`wmic process where processid=${proc.pid} call setpriority "below normal"`, { stdio: 'ignore', windowsHide: true });
  } catch {}
}

function killChild() {
  if (isWin && proc.pid) {
    try {
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
