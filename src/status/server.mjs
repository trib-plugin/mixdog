/**
 * Status HTTP server (forked child process).
 *
 * A tiny loopback-only HTTP server that exposes GET /bridge/status for
 * statusline consumers. Lives in its OWN process (forked by server.mjs
 * at boot) so bursty MCP tool activity in the parent can't starve the
 * statusline's short 1-second curl timeout.
 *
 * Binds to an ephemeral port on 127.0.0.1 and advertises the port via
 * ~/.claude/mixdog-status.json so bin/statusline.sh can discover it
 * without hard-coded port numbers.
 *
 * Can be used two ways:
 *   1. Imported: `startStatusServer({ dataDir, advertisePath, log })` —
 *      kept as a named export for tests / ad-hoc in-process hosting.
 *   2. Spawned directly via `fork('src/status/server.mjs')` — config is
 *      read from MIXDOG_STATUS_DATA_DIR / MIXDOG_STATUS_ADVERTISE_PATH
 *      env vars. The parent kills this process at shutdown.
 */

import http from 'http';
import { writeFileSync, unlinkSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import { pathToFileURL } from 'url';
import { buildBridgeStatus, renderBridgeStatusText } from './aggregator.mjs';

function writeAdvertisement(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

export async function startStatusServer({ dataDir, advertisePath, log = () => {} }) {
  const server = http.createServer(async (req, res) => {
    // Loopback-only: reject non-localhost peers (belt-and-braces —
    // binding to 127.0.0.1 should already exclude them).
    const remote = req.socket?.remoteAddress || '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!isLoopback) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }

    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/bridge/status') {
        const wantText = url.searchParams.get('format') === 'text'
          || (req.headers['accept'] || '').includes('text/plain');
        const payload = await buildBridgeStatus(dataDir);
        if (wantText) {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(renderBridgeStatusText(payload));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        }
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const record = { pid: process.pid, port, startedAt: Date.now() };
  try { writeAdvertisement(advertisePath, record); }
  catch (e) { log(`[status-server] advertise write failed: ${e.message}`); }

  log(`[status-server] listening on 127.0.0.1:${port} (advertise=${advertisePath})`);

  return {
    port,
    close: () => new Promise((resolve) => {
      try { unlinkSync(advertisePath); } catch {}
      server.close(() => resolve());
    }),
  };
}

// ── Child-process entry point ─────────────────────────────────────────
// When invoked directly (`node src/status/server.mjs`), read config
// from env and boot. Parent signals shutdown by disconnecting IPC or
// sending SIGTERM; either way we tear down the server and exit.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const dataDir = process.env.MIXDOG_STATUS_DATA_DIR;
  const advertisePath = process.env.MIXDOG_STATUS_ADVERTISE_PATH;
  if (!dataDir || !advertisePath) {
    process.stderr.write('[status-server] missing MIXDOG_STATUS_DATA_DIR or MIXDOG_STATUS_ADVERTISE_PATH\n');
    process.exit(2);
  }
  const log = (m) => process.stdout.write(m + '\n');
  let handle = null;
  let shuttingDown = false;
  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[status-server] shutdown (${reason})`);
    try { if (handle) await handle.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('disconnect', () => shutdown('parent-disconnect'));
  try {
    handle = await startStatusServer({ dataDir, advertisePath, log });
  } catch (e) {
    process.stderr.write(`[status-server] failed to start: ${e && (e.stack || e.message) || e}\n`);
    process.exit(1);
  }
}
