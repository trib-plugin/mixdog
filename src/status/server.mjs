/**
 * MCP-embedded status HTTP server.
 *
 * A tiny loopback-only HTTP server that exposes GET /bridge/status for
 * statusline consumers. Unlike setup-server.mjs (port 3458, on-demand via
 * /mixdog:config), this one runs for the lifetime of the MCP server
 * process so line 2 of the statusline has a reliable data source even
 * when the setup UI isn't open.
 *
 * Binds to an ephemeral port on 127.0.0.1 and advertises the port via
 * ~/.claude/mixdog-status.json so bin/statusline.sh can discover it
 * without hard-coded port numbers.
 */

import http from 'http';
import { writeFileSync, unlinkSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
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
