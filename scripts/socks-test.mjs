// SOCKS5-proxy E2E: a local SOCKS5 server (username/password auth) + the
// mock IBM i host + the built gateway. Covers the tunnel itself, the
// per-system admin API, credential visibility, the failure paths, and the
// SQLite migration of databases from before the proxy columns.
//
// Usage: npm run build && npm run test:socks
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const MOCK_PORT = 18123;
const SOCKS_PORT = 18108;
const GW_OLD_PORT = 18180; // pre-proxy database (migration)
const GW_NEW_PORT = 18181; // fresh database, proxy seeded from env
const ADMIN_PIN = '9876';
const PROXY_USER = 'tunneler';
const PROXY_PASS = 's3cret-pw';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail = '') {
  const mark = cond ? 'ok' : 'FAIL';
  console.log(`  [${mark}] ${name}${cond ? '' : ` - ${detail}`}`);
  if (!cond) failures++;
}

const procs = [];
function cleanup() {
  for (const p of procs) p.kill();
}
process.on('exit', cleanup);

async function waitHealthy(port) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return false;
}

// ------------------------------------------------------- local SOCKS5 server
// Server side of RFC 1928 + RFC 1929: always demands username/password.
// Records what it saw so the assertions can check the handshake really ran
// (credentials presented, auth failures counted, tunnel target correct).
class Socks5Server {
  stats = { authed: [], authFailures: 0, tunnels: [], gotNoAuthOffer: 0 };

  constructor(user, pass) {
    this.user = user;
    this.pass = pass;
    this.server = net.createServer((sock) => this.session(sock));
  }

  listen(port) {
    return new Promise((resolve) => this.server.listen(port, '127.0.0.1', resolve));
  }

  session(sock) {
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    const drop = () => sock.destroy();

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (stage === 'greeting') {
          if (buf.length < 2) return;
          const n = buf[1];
          if (buf.length < 2 + n) return;
          const methods = [...buf.subarray(2, 2 + n)];
          buf = buf.subarray(2 + n);
          if (!methods.includes(0)) this.stats.gotNoAuthOffer++;
          if (methods.includes(2)) {
            sock.write(Buffer.from([5, 2]));
            stage = 'auth';
            continue;
          }
          sock.write(Buffer.from([5, 0xff])); // refuses no-auth
          return drop();
        }
        if (stage === 'auth') {
          if (buf.length < 2) return;
          const ulen = buf[1];
          if (buf.length < 2 + ulen + 1) return;
          const plen = buf[2 + ulen];
          if (buf.length < 2 + ulen + 1 + plen) return;
          const user = buf.subarray(2, 2 + ulen).toString('utf8');
          const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString('utf8');
          buf = buf.subarray(3 + ulen + plen);
          if (user !== this.user || pass !== this.pass) {
            this.stats.authFailures++;
            sock.write(Buffer.from([1, 1]));
            return drop();
          }
          this.stats.authed.push(user);
          sock.write(Buffer.from([1, 0]));
          stage = 'connect';
          continue;
        }
        // stage === 'connect': [VER CMD RSV ATYP addr port]
        if (buf.length < 4) return;
        if (buf[1] !== 1) return drop(); // only CONNECT
        const atyp = buf[3];
        const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? 1 + buf[4] : 0;
        if (!addrLen || buf.length < 4 + addrLen + 2) return;
        const host =
          atyp === 1
            ? [...buf.subarray(4, 8)].join('.')
            : atyp === 3
              ? buf.subarray(5, 4 + addrLen).toString('utf8')
              : 'v6';
        const port = buf.readUInt16BE(4 + addrLen);
        buf = buf.subarray(4 + addrLen + 2);
        sock.off('data', onData);
        const upstream = net.connect({ host, port });
        upstream.on('connect', () => {
          // 0.0.0.0:0 bound address; then a pure pipe.
          sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (buf.length) upstream.write(buf);
          sock.pipe(upstream);
          upstream.pipe(sock);
          this.stats.tunnels.push(`${host}:${port}`);
        });
        upstream.on('error', () => drop());
        return;
      }
    };

    sock.on('data', onData);
    sock.on('error', drop);
  }
}

// ------------------------------------------------------------ WS "browser"
class Term {
  rows = 24;
  cols = 80;
  cells = [];
  cursor = [1, 1];
  status = null;
  rawLog = [];

  apply(msg) {
    this.rawLog.push(JSON.stringify(msg));
    if (msg.t === 'screen') {
      this.rows = msg.rows;
      this.cols = msg.cols;
      this.cells = new Array(this.rows * this.cols).fill(' ');
      for (const [pos, , ch] of msg.cells) this.cells[pos] = String(ch ?? ' ');
      this.cursor = msg.cursor ?? this.cursor;
    } else if (msg.t === 'update') {
      if (Array.isArray(msg.cells)) {
        for (const [pos, , ch] of msg.cells) this.cells[pos] = String(ch ?? ' ');
      }
      if (Array.isArray(msg.cursor)) this.cursor = msg.cursor;
    } else if (msg.t === 'status') {
      this.status = msg;
    }
  }

  text() {
    const out = [];
    for (let r = 1; r <= this.rows; r++) {
      let s = '';
      for (let c = 0; c < this.cols; c++) s += this.cells[(r - 1) * this.cols + c] ?? ' ';
      out.push(s.replace(/\s+$/, ''));
    }
    return out.join('\n');
  }
}

function wsTerm(port, query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
  const term = new Term();
  ws.addEventListener('message', (ev) => term.apply(JSON.parse(String(ev.data))));
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return { ws, term, opened };
}

async function waitFor(pred, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(60);
  }
  return false;
}

// ------------------------------------------------------------------- setup
console.log('Starting mock host + SOCKS5 proxy server...');
procs.push(spawn(process.execPath, ['scripts/mock-host.mjs', String(MOCK_PORT)], { stdio: 'inherit' }));
const socks = new Socks5Server(PROXY_USER, PROXY_PASS);
await socks.listen(SOCKS_PORT);
await sleep(300);

function gatewayEnv(port, db) {
  return {
    ...process.env,
    PORT: String(port),
    IBM_I_HOST: '127.0.0.1',
    IBM_I_PORT: String(MOCK_PORT),
    IBM_I_DEV_PREFIX: 'TEST_',
    IBM_I_TERM_TYPE: 'IBM-3477-FC',
    IBM_I_CODEPAGE: 'cp037',
    ADMIN_PIN,
    SESSION_GRACE_MS: '0',
    WEB5250_DB: db,
    IBM_I_PROXY_HOST: '127.0.0.1',
    IBM_I_PROXY_PORT: String(SOCKS_PORT),
    IBM_I_PROXY_USER: PROXY_USER,
    IBM_I_PROXY_PASSWORD: PROXY_PASS
  };
}

async function adminAuth(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/admin/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: ADMIN_PIN })
  });
  const data = await res.json();
  return { 'content-type': 'application/json', authorization: `Bearer ${data.token}` };
}

// ============================ part 1: pre-proxy database migrates in place
{
  const dir = mkdtempSync(join(tmpdir(), 'web5250-socks-old-'));
  const db = join(dir, 'menu.db');
  // The schema as it was before the proxy columns existed.
  const legacy = new DatabaseSync(db);
  legacy.exec(`
    CREATE TABLE systems (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      host        TEXT NOT NULL,
      port        INTEGER NOT NULL DEFAULT 23,
      ssl         INTEGER NOT NULL DEFAULT 0,
      term_type   TEXT NOT NULL,
      code_page   TEXT NOT NULL,
      dev_prefix  TEXT,
      position    INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  legacy
    .prepare(
      `INSERT INTO systems (name, description, host, port, ssl, term_type, code_page, dev_prefix, position)
       VALUES ('LEGACY', 'row from before proxies', '127.0.0.1', ?, 0, 'IBM-3477-FC', 'cp037', NULL, 1)`
    )
    .run(MOCK_PORT);
  legacy.close();

  console.log('\n1. Legacy database (no proxy columns)');
  const gw = spawn(process.execPath, ['dist/server.js'], {
    stdio: 'inherit',
    env: gatewayEnv(GW_OLD_PORT, db)
  });
  procs.push(gw);
  if (!(await waitHealthy(GW_OLD_PORT))) {
    console.error('gateway never became healthy on the legacy database');
    process.exit(1);
  }

  const listed = await (await fetch(`http://127.0.0.1:${GW_OLD_PORT}/api/systems`)).json();
  check(
    'legacy row survives the in-place migration',
    listed.systems.length === 1 && listed.systems[0].name === 'LEGACY' && listed.systems[0].viaProxy === false,
    JSON.stringify(listed)
  );

  const { ws, term, opened } = wsTerm(GW_OLD_PORT);
  await opened;
  check(
    'legacy row still connects directly',
    await waitFor(() => term.text().includes('AS/400 Sign On'), 8000, term.text().slice(0, 200))
  );
  check('no tunnel was used', socks.stats.tunnels.length === 0, JSON.stringify(socks.stats.tunnels));
  ws.close();
  await sleep(300);

  gw.kill();
  await sleep(500);
}

// ============================ part 2: fresh database, proxied seed system
{
  console.log('\n2. Seeded proxied system (IBM_I_PROXY_* env)');
  const db = join(mkdtempSync(join(tmpdir(), 'web5250-socks-new-')), 'menu.db');
  const gw = spawn(process.execPath, ['dist/server.js'], {
    stdio: 'inherit',
    env: gatewayEnv(GW_NEW_PORT, db)
  });
  procs.push(gw);
  if (!(await waitHealthy(GW_NEW_PORT))) {
    console.error('gateway never became healthy on the fresh database');
    process.exit(1);
  }

  // Like the browser, connect through the menu row (?system=<id>); a bare
  // /ws would use the raw IBM_I_* env defaults, bypassing the seeded row.
  const seeded = (await (await fetch(`http://127.0.0.1:${GW_NEW_PORT}/api/systems`)).json())
    .systems[0];
  const { ws, term, opened } = wsTerm(GW_NEW_PORT, `?system=${seeded.id}`);
  await opened;
  check(
    'sign-on screen arrives through the tunnel',
    await waitFor(() => term.text().includes('AS/400 Sign On') && term.text().includes('Password'), 8000, term.text().slice(0, 200))
  );
  check('the proxy authenticated our user', socks.stats.authed[0] === PROXY_USER, JSON.stringify(socks.stats.authed));
  check(
    'the tunnel pointed at the mock host',
    socks.stats.tunnels[0] === `127.0.0.1:${MOCK_PORT}`,
    JSON.stringify(socks.stats.tunnels)
  );
  check('terminal is 24x80', term.rows === 24 && term.cols === 80);
  check(
    'proxy password never crosses the WebSocket',
    !term.rawLog.some((m) => m.includes(PROXY_PASS))
  );
  ws.close();
  await sleep(300);

  // ------------------------------------------------- credential visibility
  console.log('\n3. Proxy details stay off the public API');
  const http = `http://127.0.0.1:${GW_NEW_PORT}`;
  const publicBody = await (await fetch(`${http}/api/systems`)).text();
  check('public list marks the system as proxied', publicBody.includes('"viaProxy":true'), publicBody);
  check('public list has no proxy host/user/password', !publicBody.includes('proxyUser') && !publicBody.includes('proxyPass') && !publicBody.includes('proxyHost'), publicBody);
  check('proxy password not in the public body', !publicBody.includes(PROXY_PASS));

  const authHeaders = await adminAuth(GW_NEW_PORT);
  const adminList = await (await fetch(`${http}/api/admin/systems`, { headers: authHeaders })).json();
  const seededRow = adminList.systems[0];
  check(
    'admin list carries the proxy fields',
    seededRow.proxyHost === '127.0.0.1' && seededRow.proxyPort === SOCKS_PORT && seededRow.proxyUser === PROXY_USER && seededRow.proxyPass === PROXY_PASS,
    JSON.stringify(seededRow)
  );
  check('admin systems route requires the token', (await fetch(`${http}/api/admin/systems`)).status === 401);

  // ------------------------------------------------------- failure paths
  console.log('\n4. Wrong proxy password');
  const bad = await (
    await fetch(`${http}/api/admin/systems`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'BADPROXY',
        host: '127.0.0.1',
        port: MOCK_PORT,
        proxyHost: '127.0.0.1',
        proxyPort: SOCKS_PORT,
        proxyUser: PROXY_USER,
        proxyPass: 'not-the-password'
      })
    })
  ).json();
  check('system with a wrong proxy password can be saved', bad.system?.id > 0, JSON.stringify(bad));
  {
    const { ws, term, opened } = wsTerm(GW_NEW_PORT, `?system=${bad.system.id}`);
    await opened;
    check(
      'session reports the auth failure',
      await waitFor(() => term.status?.status === 'error' && /rejected/.test(term.status.detail ?? ''), 8000, JSON.stringify(term.status)),
    );
    check('the proxy counted one auth failure', socks.stats.authFailures === 1, String(socks.stats.authFailures));
    ws.close();
    await sleep(300);
  }

  console.log('\n5. No credentials against an auth-requiring proxy');
  const nocreds = await (
    await fetch(`${http}/api/admin/systems`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'NOCREDS',
        host: '127.0.0.1',
        port: MOCK_PORT,
        proxyHost: '127.0.0.1',
        proxyPort: SOCKS_PORT
      })
    })
  ).json();
  check('credential-less proxied system can be saved', nocreds.system?.id > 0, JSON.stringify(nocreds));
  {
    const { ws, term, opened } = wsTerm(GW_NEW_PORT, `?system=${nocreds.system.id}`);
    await opened;
    check(
      'session reports the refused method',
      await waitFor(() => term.status?.status === 'error' && /no acceptable auth method/.test(term.status.detail ?? ''), 8000, JSON.stringify(term.status))
    );
    ws.close();
    await sleep(300);
  }

  console.log('\n6. Validation');
  const orphan = await fetch(`${http}/api/admin/systems`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'X', host: '127.0.0.1', port: MOCK_PORT, proxyUser: 'u' })
  });
  check('proxy user without a proxy host is rejected', orphan.status === 400, await orphan.text());

  const badPort = await fetch(`${http}/api/admin/systems`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'X', host: '127.0.0.1', port: MOCK_PORT, proxyHost: '127.0.0.1', proxyPort: '70000' })
  });
  check('out-of-range proxy port is rejected', badPort.status === 400, await badPort.text());

  console.log('\n7. Direct systems keep working alongside proxied ones');
  const direct = await (
    await fetch(`${http}/api/admin/systems`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'DIRECT', host: '127.0.0.1', port: MOCK_PORT })
    })
  ).json();
  const tunnelsBefore = socks.stats.tunnels.length;
  {
    const { ws, term, opened } = wsTerm(GW_NEW_PORT, `?system=${direct.system.id}`);
    await opened;
    check(
      'direct system reaches the sign-on screen',
      await waitFor(() => term.text().includes('AS/400 Sign On'), 8000, term.text().slice(0, 200))
    );
    check('no new tunnel was opened', socks.stats.tunnels.length === tunnelsBefore);
    ws.close();
    await sleep(300);
  }
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
