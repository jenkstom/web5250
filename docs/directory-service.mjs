#!/usr/bin/env node
// Reference implementation of the web5250 directory service
// (see docs/directory-service.md and docs/directory-service-openapi.yaml).
//
// A deliberately small, read-only HTTP service that fronts an existing
// SQLite database of 5250 hosts and their accounts:
//
//   GET /v1/entries                    menu entries (no credentials)
//   GET /v1/entries/<id>/credentials   sign-on pair for one entry
//   GET /healthz                       liveness (no auth)
//
// Everything else is 404. There are no write endpoints.
//
// Run:  API_TOKEN=$(openssl rand -hex 32) PORT=8088 node directory-service.mjs
// Node >= 22.13 (node:sqlite). No npm dependencies.
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const int = (v, def) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

const LISTEN_HOST = process.env.LISTEN_HOST ?? '127.0.0.1';
const PORT = int(process.env.PORT, 8088);
const DB_PATH = process.env.DB_PATH ?? './directory.db';
const API_TOKEN = (process.env.API_TOKEN ?? '').trim();
if (!API_TOKEN) {
  console.error('refusing to start without API_TOKEN (set it to a long random value)');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The database. A starter schema is created when the file is empty so the
// service runs standalone; point DB_PATH at the existing database instead and
// adapt LIST_SQL / CRED_SQL below to its real table and column names.
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS hosts (
    id       TEXT PRIMARY KEY,   -- stable sync key: [A-Za-z0-9._:-]{1,64}
    label    TEXT NOT NULL,      -- menu name (blank = fall back to host)
    host     TEXT NOT NULL,      -- IP or hostname the gateway connects to
    port     INTEGER,            -- NULL = the gateway template's port
    ssl      INTEGER,            -- NULL/0/1; NULL = the template's setting
    username TEXT,               -- NULL (either column) = no auto sign-on
    password TEXT
  )
`);

/** Menu order = row order. Add WHERE/JOIN for whatever "enabled" means for you. */
const LIST_SQL = `
  SELECT id, label, host, port, ssl, username, password
  FROM hosts ORDER BY rowid`;

const CRED_SQL = `
  SELECT username, password FROM hosts WHERE id = ?`;

// ---------------------------------------------------------------------------
const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const HOST_RE = /^[A-Za-z0-9._:-]{1,253}$/;

/** Bearer-token check that does not leak the token's length or early bytes. */
function authorized(req) {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return false;
  const a = createHash('sha256').update(m[1]).digest();
  const b = createHash('sha256').update(API_TOKEN).digest();
  return timingSafeEqual(a, b);
}

const send = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
};

function listEntries() {
  const rows = db.prepare(LIST_SQL).all();
  const entries = [];
  for (const r of rows) {
    const id = String(r.id ?? '').trim();
    const host = String(r.host ?? '').trim();
    if (!ID_RE.test(id) || !HOST_RE.test(host)) continue; // skip broken rows
    entries.push({
      id,
      name: String(r.label ?? '').trim().slice(0, 40) || host,
      host,
      ...(Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535 ? { port: r.port } : {}),
      ...(r.ssl === 1 || r.ssl === true ? { ssl: true } : {}),
      autoSignOn: Boolean(r.username && r.password)
    });
  }
  return entries;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://internal');
  const parts = url.pathname.split('/').filter(Boolean); // v1/entries[/id/credentials]

  if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname.endsWith('/healthz'))) {
    try {
      db.prepare('SELECT 1').get();
      send(res, 200, { status: 'ok' });
    } catch (e) {
      send(res, 503, { error: `database unreachable: ${String(e.message ?? e)}` });
    }
    return;
  }

  if (parts.length >= 2 && parts[0] === 'v1' && parts[1] === 'entries') {
    if (!authorized(req)) {
      send(res, 401, { error: 'Authorization: Bearer <token> required' });
      return;
    }
    try {
      // GET /v1/entries
      if (req.method === 'GET' && parts.length === 2) {
        send(res, 200, { entries: listEntries() });
        return;
      }
      // GET /v1/entries/<id>/credentials
      if (req.method === 'GET' && parts.length === 4 && parts[3] === 'credentials') {
        const id = decodeURIComponent(parts[2]);
        if (!ID_RE.test(id)) {
          send(res, 404, { error: 'no such entry' });
          return;
        }
        const row = db.prepare(CRED_SQL).get(id);
        const username = row?.username ? String(row.username).trim() : '';
        const password = row?.password ? String(row.password) : '';
        if (!username || !password) {
          send(res, 404, { error: 'no credential stored for this entry' });
          return;
        }
        send(res, 200, { username: username.slice(0, 10), password: password.slice(0, 128) });
        return;
      }
    } catch (e) {
      send(res, 500, { error: String(e.message ?? e) });
      return;
    }
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, LISTEN_HOST, () => {
  console.log(`directory service on http://${LISTEN_HOST}:${PORT} (db: ${DB_PATH})`);
});
