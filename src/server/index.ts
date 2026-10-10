// Web-to-5250 gateway entry point.
//
// HTTP: serves the built SPA (relative asset paths so it works behind
//       Pangolin under any sub-path) plus /healthz for uptime checks.
// WS:    upgrades any path ending in /ws to a terminal session.
//
// Authentication is intentionally absent: Pangolin enforces identity at the
// edge (this service should never be exposed directly to the internet).
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.ts';
import { GatewaySession, type SessionQuery } from './gateway.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const cfg = loadConfig();

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://internal');
  const pathname = decodeURIComponent(url.pathname);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }

  // Health endpoint (also matches /<prefix>/healthz behind path-based rules).
  if (pathname === '/healthz' || pathname.endsWith('/healthz')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'web5250' }));
    return;
  }

  serveStatic(pathname, res);
});

/**
 * Resolve a file under dist/public. Pangolin may forward the request path
 * as-is (sub-path rule without rewrite) so we also try progressively
 * stripping leading segments until a file matches. Extensionless paths
 * fall back to index.html (SPA behaviour).
 */
function resolveAsset(pathname: string): string | null {
  let rel = pathname.replace(/^\/+/, '');
  for (let i = 0; i <= rel.split('/').length; i++) {
    const candidate = path.normalize(path.join(publicDir, rel));
    if (!candidate.startsWith(publicDir)) return null; // traversal guard
    if (rel && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
    const idx = rel.indexOf('/');
    if (idx === -1) break;
    rel = rel.slice(idx + 1);
  }
  const index = path.join(publicDir, 'index.html');
  return fs.existsSync(index) ? index : null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json'
};

function serveStatic(pathname: string, res: http.ServerResponse): void {
  const file = resolveAsset(pathname);
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- WebSocket
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://internal');
  if (!url.pathname.endsWith('/ws')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const query = parseSessionQuery(url);
    // Behind Pangolin, X-Forwarded-For carries the end-user identity -
    // logged so operators can correlate browser users with 5250 devices.
    const fwd = req.headers['x-forwarded-for'];
    const clientIp = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0]?.trim();
    console.log(
      `[ws] session open${clientIp ? ` from ${clientIp}` : ''} -> ${query.host ?? cfg.ibmHost}:${query.port ?? cfg.ibmPort}`
    );
    const session = new GatewaySession(ws, cfg, query);
    ws.on('message', (data) => session.handleMessage(data.toString()));
    ws.on('close', () => session.destroy());
    ws.on('error', () => session.destroy());
    session.start();
  });
});

function parseSessionQuery(url: URL): SessionQuery {
  const q = url.searchParams;
  const num = (v: string | null): number | undefined => {
    const n = Number.parseInt(v ?? '', 10);
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : undefined;
  };
  return {
    host: sanitize(q.get('host'), 253),
    port: num(q.get('port')),
    ssl: q.get('ssl') === '1' || q.get('ssl') === 'true' ? true : undefined,
    termType: sanitize(q.get('term'), 20),
    codePage: sanitize(q.get('cp'), 10),
    devName: sanitize(q.get('devname'), 10)
  };
}

function sanitize(v: string | null, max: number): string | undefined {
  if (!v) return undefined;
  const s = v.replace(/[^A-Za-z0-9._:-]/g, '');
  return s.slice(0, max) || undefined;
}

// Heartbeat: drop browsers that stop answering pings (idle tunnels).
const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if ((ws as unknown as { alive?: boolean }).alive === false) {
      ws.terminate();
      continue;
    }
    (ws as unknown as { alive?: boolean }).alive = false;
    ws.ping();
  }
}, 30000);
for (const ws of wss.clients) (ws as unknown as { alive?: boolean }).alive = true;
wss.on('connection', (ws) => {
  (ws as unknown as { alive?: boolean }).alive = true;
  ws.on('pong', () => {
    (ws as unknown as { alive?: boolean }).alive = true;
  });
});

server.listen(cfg.port, cfg.host, () => {
  console.log(
    `web5250 listening on http://${cfg.host}:${cfg.port} -> ${cfg.ibmHost}:${cfg.ibmPort}` +
      ` (${cfg.ibmSsl ? 'TLS' : 'telnet'}, ${cfg.termType}, ${cfg.codePage})`
  );
});

function shutdown(): void {
  clearInterval(pingInterval);
  for (const ws of wss.clients) ws.terminate();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
