#!/usr/bin/env node
// Standalone memory worker launcher for benchmark / dev use.
// Imports src/memory/index.mjs (so the import.meta.url mainline guard does
// NOT fire) and calls init() — HTTP transport binds to 127.0.0.1:<port>
// and writes the port file under tmpdir/mixdog-memory/memory-port. Process
// stays alive on the http server's open socket; SIGINT to stop.
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
process.env.CLAUDE_PLUGIN_ROOT ??= PLUGIN_ROOT;
process.env.CLAUDE_PLUGIN_DATA ??= join(homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin');

const mod = await import('../src/memory/index.mjs');
await mod.init();
process.stderr.write(`[start-memory-worker] init complete; HTTP listening\n`);
process.on('SIGINT', () => { process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });
