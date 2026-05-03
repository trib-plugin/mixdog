#!/usr/bin/env bun
// Standalone memory worker launcher for benchmark / dev use.
// Mirrors the mainline init contract in src/memory/index.mjs:
//   acquireLock → register exit handler → call init() → keep alive.
// Signal handlers call the exported stop() for clean shutdown before exit.
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
process.env.CLAUDE_PLUGIN_ROOT ??= PLUGIN_ROOT;
process.env.CLAUDE_PLUGIN_DATA ??= join(homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin');

// Import memory module — import.meta.url guard in index.mjs does NOT fire
// because this file's URL differs from process.argv[1].
const { init, stop, acquireLock, releaseLock, isExistingServerHealthy, runProxyMode } = await import('../src/memory/index.mjs');

const existing = await isExistingServerHealthy();
if (existing) {
  await runProxyMode(existing);
  process.exit(0);
}
acquireLock();
process.on('exit', releaseLock);
process.on('SIGINT', () => { stop().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { stop().finally(() => process.exit(0)); });
await init();
process.stderr.write(`[start-memory-worker] init complete; HTTP listening\n`);
