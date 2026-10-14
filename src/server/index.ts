// Web-to-5250 gateway entry point.
//
// HTTP: serves the built SPA (relative asset paths so it works behind
//       Pangolin under any sub-path) plus /healthz for uptime checks and the
//       /api/* JSON surface (connection menu + PIN-gated admin editor).
// WS:    upgrades any path ending in /ws to a terminal session, optionally
//       targeting a menu-selected system (?system=<id> in the SQLite store)
//       or re-attaching to a running one (?attach=<session token>).
//
// Authentication is intentionally absent: Pangolin enforces identity at the
// edge (this service should never be exposed directly to the internet).
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.ts';
import { HostSession, type SessionQuery, type AutoQuery } from './gateway.ts';
import { getSession, allSessions } from './sessions.ts';
import { Systems } from './systems.ts';
import { createApiHandler } from './api.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const cfg = loadConfig();
const systems = new Systems(cfg.dbPath, cfg);
const api = createApiHandler(cfg, systems);

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://internal');
  const pathname = decodeURIComponent(url.pathname);

  if (api(req, res, pathname)) return;

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
  const headers: Record<string, string> = { 'content-type': type, 'cache-control': 'no-cache' };
  // Optional lockdown for iframe embedding (automated launches): when
  // FRAME_ANCESTORS is set, only those origins (plus the app itself, which
  // frames its own pages for the ?grid= split view) may frame the app.
  if (ext === '.html' && cfg.frameAncestors) {
    headers['content-security-policy'] = `frame-ancestors 'self' ${cfg.frameAncestors}`;
  }
  res.writeHead(200, headers);
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
  const query = parseSessionQuery(url);
  // Resolve the menu selection (?system=<id>) before upgrading so the
  // session connects with the admin-configured parameters.
  const system = query.systemId !== undefined ? systems.get(query.systemId) : undefined;
  if (query.systemId !== undefined && !system) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  // Automated launches need the server-held sign-on credential; refuse before
  // any session resources are spent rather than failing mid-sign-on.
  if (query.auto && (!cfg.autoSignOnUser || !cfg.autoSignOnPassword)) {
    console.log('[ws] auto-launch rejected: AUTO_SIGNON_USER/AUTO_SIGNON_PASSWORD not configured');
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // Behind Pangolin, X-Forwarded-For carries the end-user identity -
    // logged so operators can correlate browser users with 5250 devices.
    const fwd = req.headers['x-forwarded-for'];
    const clientIp = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0]?.trim();

    // ?attach=<token>: bind this socket to an already-running host session
    // (pop-out window, reload re-attach). A second attach takes the session
    // over from the first front-end, which is told with status 'detached'.
    if (query.attach) {
      const core = getSession(query.attach);
      if (!core || core.isDestroyed) {
        console.log(`[ws] attach refused: unknown or expired session token`);
        // Upgrade anyway and say why - the browser shows a real message
        // instead of a bare close.
        ws.send(
          JSON.stringify({
            t: 'status',
            status: 'error',
            detail: 'This session is no longer available (it ended or the grace period expired).'
          })
        );
        ws.close(1000, 'unknown session');
        return;
      }
      const target = { host: core.sessionInfo.host, port: core.sessionInfo.port };
      console.log(
        `[ws] attach${clientIp ? ` from ${clientIp}` : ''}${core.systemName ? ` [${core.systemName}]` : ''} -> ` +
          `${target.host}:${target.port} (${core.devName ?? 'no device'})`
      );
      wireSocket(ws, core.attach(ws));
      return;
    }

    const target = system ?? { host: cfg.ibmHost, port: cfg.ibmPort, name: undefined as string | undefined };
    console.log(
      `[ws] session open${clientIp ? ` from ${clientIp}` : ''}${system ? ` [${system.name}]` : ''} -> ` +
        `${target.host}:${target.port}`
    );
    wireSocket(ws, new HostSession(cfg, query, system).attach(ws));
  });
});

/** Shared per-socket wiring: messages in, detach (not destroy) on close. */
function wireSocket(ws: import('ws').WebSocket, session: import('./gateway.ts').GatewaySession): void {
  ws.on('message', (data) => session.handleMessage(data.toString()));
  // Closing the socket detaches the front-end; the host session itself lives
  // on for SESSION_GRACE_MS unless this was an ?auto=1 launch (strict) or an
  // explicit {t:'end'} arrived.
  ws.on('close', () => session.socketClosed());
  ws.on('error', () => session.socketClosed());
  session.start();
}

function parseSessionQuery(url: URL): SessionQuery {
  const q = url.searchParams;
  const num = (v: string | null): number | undefined => {
    const n = Number.parseInt(v ?? '', 10);
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : undefined;
  };
  const int = (v: string | null): number | undefined => {
    const n = Number.parseInt(v ?? '', 10);
    return Number.isFinite(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER ? n : undefined;
  };
  return {
    host: sanitize(q.get('host'), 253),
    port: num(q.get('port')),
    ssl: q.get('ssl') === '1' || q.get('ssl') === 'true' ? true : undefined,
    termType: sanitize(q.get('term'), 20),
    codePage: sanitize(q.get('cp'), 10),
    devName: sanitizeDevName(q.get('devname')),
    systemId: int(q.get('system')),
    attach: sanitize(q.get('attach'), 64),
    auto: parseAuto(q)
  };
}

function parseAuto(q: URLSearchParams): AutoQuery | undefined {
  const on = q.get('auto');
  if (on !== '1' && on !== 'true') return undefined;
  const delay = Number.parseInt(q.get('inputdelay') ?? '', 10);
  return {
    input: printable(q.get('input'), 256),
    inputEnter: q.get('inputenter') !== '0',
    inputDelayMs: Number.isFinite(delay) && delay >= 0 && delay <= 10000 ? delay : 500
  };
}

/** Printable-ASCII run (what a 5250 field can hold); others are dropped. */
function printable(v: string | null, max: number): string | undefined {
  if (!v) return undefined;
  const s = [...v].filter((ch) => ch >= ' ' && ch <= '~').join('');
  return s.slice(0, max) || undefined;
}

function sanitize(v: string | null, max: number): string | undefined {
  if (!v) return undefined;
  const s = v.replace(/[^A-Za-z0-9._:-]/g, '');
  return s.slice(0, max) || undefined;
}

/** Device-name characters per the 5250 spec: letters, digits, $ # @ _ . */
function sanitizeDevName(v: string | null): string | undefined {
  if (!v) return undefined;
  const s = v.trim().toUpperCase().replace(/[^A-Z0-9#$@_]/g, '').slice(0, 10);
  return s || undefined;
}

// Heartbeat: pings at WS_PING_INTERVAL_MS; drop a browser only after
// WS_PING_MAX_MISSES consecutive missed pongs (a single delayed control
// frame through a proxy must not kill a live session). Terminating a dead
// browser tears down its host connection and releases the display name, so
// the grace window - interval x misses - bounds how long an iSeries session
// can outlive its front-end.
const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    const w = ws as unknown as { alive?: boolean; misses?: number };
    if (w.alive === false) {
      w.misses = (w.misses ?? 0) + 1;
      if (w.misses >= cfg.wsPingMaxMisses) {
        ws.terminate();
        continue;
      }
    } else {
      w.misses = 0;
    }
    w.alive = false;
    ws.ping();
  }
}, cfg.wsPingIntervalMs);
wss.on('connection', (ws) => {
  const w = ws as unknown as { alive?: boolean };
  w.alive = true;
  ws.on('pong', () => {
    w.alive = true;
  });
});

server.listen(cfg.port, cfg.host, () => {
  console.log(
    `web5250 listening on http://${cfg.host}:${cfg.port} -> ${cfg.ibmHost}:${cfg.ibmPort}` +
      ` (${cfg.ibmSsl ? 'TLS' : 'telnet'}, ${cfg.termType}, ${cfg.codePage})`
  );
  console.log(
    `menu: ${systems.list().length} system(s) configured (db: ${cfg.dbPath})` +
      `, admin ${cfg.adminPin ? 'enabled' : 'disabled (set ADMIN_PIN to enable)'}`
  );
});

function shutdown(): void {
  clearInterval(pingInterval);
  // Tear every host session down (releases the devices on the IBM i side)
  // before the sockets go away.
  for (const core of allSessions()) core.destroy();
  for (const ws of wss.clients) ws.terminate();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
