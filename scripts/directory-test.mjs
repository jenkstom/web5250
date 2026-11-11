// End-to-end test for the directory service integration. Directory hosts
// are ephemeral: they live in gateway memory only, so the menu carries them
// for exactly as long as the directory service keeps answering.
//   1. Legacy purge: rows materialized by an older gateway are deleted from
//      the catalog on boot (nothing directory-sourced is stored anymore).
//   2. Boot sync: entries materialize from the template (name pattern,
//      per-entry port/ssl overrides, description fallback) with "dir:<id>"
//      ids, listed after the manual rows.
//   3. Auto sign-on: opening a directory system signs on with the entry's
//      credential; the password never crosses the WebSocket.
//   4. Entry without a credential (404): manual sign-on screen.
//   5. Credential fetch failure (500): manual sign-on screen + banner.
//   6. Re-sync via the admin route: add/update/remove, stable ids.
//   7. Manually-configured system with a stored sign-on pair: same
//      automatic sign-on, credentials stripped from the public list.
//   8. Directory outage: the directory rows vanish from the menu (an
//      unreachable service shows nothing, not stale hosts); recovery brings
//      them back with the same ids; a gateway restart stores nothing.
//   9. Proxy fallback: with no DIRECTORY_TEMPLATE_PROXY_* set, directory
//      hosts tunnel through the IBM_I_PROXY_* SOCKS5 proxy.
//
// Usage: npm run build && npm run test:directory
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const MOCK_PORT = 18053; // mock 5250 host (accepts any non-empty sign-on)
const DIR_PORT = 18054; // mock directory service
const HTTP_PORT = 18055; // gateway under test
const SOCKS_PORT = 18058; // SOCKS5 mock for the proxy-fallback part
const PROXY_PORT = 18056; // gateway booted with IBM_I_PROXY_* set
const PIN = '4321';
const TOKEN = 'dir-token-1';
const DIR_USER = 'DIRUSER';
const DIR_PW = 'DirSecret9';
const PROXY_USER = 'tunneler';
const PROXY_PASS = 's3cret-pw';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  [${cond ? 'ok' : 'FAIL'}] ${name}${cond ? '' : ' - ' + detail}`);
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
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return false;
}

// --------------------------------------------------------- mock directory
const state = {
  requireToken: TOKEN,
  failCredsFor: null,
  entries: [
    { id: 'prod-01', name: 'PROD', description: 'Production LPAR', host: '127.0.0.1', port: MOCK_PORT, ssl: false, autoSignOn: true },
    { id: 'dev-02', name: 'DEV', host: '127.0.0.1', port: MOCK_PORT, autoSignOn: false }
  ],
  creds: { 'prod-01': { username: DIR_USER, password: DIR_PW } }
};

const dirSrv = createServer((req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const auth = req.headers.authorization === `Bearer ${state.requireToken}`;
  const parts = req.url.split('?')[0].split('/').filter(Boolean); // v1/entries[/id/credentials]
  if (req.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'entries') {
    if (!auth) return json(401, { error: 'bad token' });
    return json(200, { entries: state.entries });
  }
  if (req.method === 'GET' && parts.length === 4 && parts[3] === 'credentials') {
    if (!auth) return json(401, { error: 'bad token' });
    const id = parts[2];
    if (state.failCredsFor === id) return json(500, { error: 'database on fire' });
    const cred = state.creds[id];
    if (!cred) return json(404, { error: 'no credential stored' });
    return json(200, cred);
  }
  json(404, { error: 'not found' });
});

// ------------------------------------------------------- local SOCKS5 server
// Server side of RFC 1928 + RFC 1929: always demands username/password.
// Records what it saw so the assertions can check the tunnel really ran.
class Socks5Server {
  stats = { authed: [], authFailures: 0, tunnels: [] };

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

// ------------------------------------------------------------- terminal model
class Term {
  rows = 24;
  cols = 80;
  cells = [];
  cursor = [1, 1];
  oia = { lock: 'none' };
  rawLog = [];
  autoMsgs = [];
  statuses = [];
  notices = [];

  apply(msg) {
    this.rawLog.push(JSON.stringify(msg));
    if (msg.t === 'screen') {
      this.rows = msg.rows;
      this.cols = msg.cols;
      this.cells = new Array(this.rows * this.cols).fill(' ');
      for (const [pos, , ch] of msg.cells) this.cells[pos] = String(ch ?? ' ');
    } else if (msg.t === 'update') {
      if (Array.isArray(msg.cells)) {
        for (const [pos, , ch] of msg.cells) this.cells[pos] = String(ch ?? ' ');
      }
    } else if (msg.t === 'oia') {
      this.oia = { ...this.oia, ...msg };
    } else if (msg.t === 'auto') {
      this.autoMsgs.push(msg);
    } else if (msg.t === 'status') {
      this.statuses.push(msg.status);
    } else if (msg.t === 'notice') {
      this.notices.push(msg);
    }
  }

  text() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      out.push(this.cells.slice(r * this.cols, (r + 1) * this.cols).join('').replace(/\s+$/, ''));
    }
    return out.join('\n');
  }
}

async function waitFor(term, pred, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred(term)) return true;
    await sleep(60);
  }
  return false;
}

async function openSession(url) {
  const sock = new WebSocket(url);
  const term = new Term();
  sock.addEventListener('message', (ev) => term.apply(JSON.parse(String(ev.data))));
  const closed = new Promise((resolve) => sock.addEventListener('close', () => resolve(true)));
  await new Promise((resolve, reject) => {
    sock.addEventListener('open', resolve);
    sock.addEventListener('error', reject);
  });
  return { sock, term, closed };
}

// ------------------------------------------------------------ gateway helpers
const api = (name, opts = {}) => {
  const headers = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`http://127.0.0.1:${opts.port ?? HTTP_PORT}/${name}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
};

async function systemsList(port) {
  const res = await api('api/systems', { port });
  const data = (await res.json()) ?? {};
  return data.systems ?? [];
}

async function adminSync(adminToken) {
  return api('api/admin/directory/sync', { method: 'POST', token: adminToken });
}

async function main() {
  console.log('Starting mock host, mock directory and gateway...');
  await new Promise((r) => dirSrv.listen(DIR_PORT, '127.0.0.1', r));
  procs.push(spawn(process.execPath, ['scripts/mock-host.mjs', String(MOCK_PORT)], { stdio: 'inherit' }));
  await sleep(300);

  // ============================ 1. legacy purge on boot
  // A database as an older gateway left it: one manual row, one row
  // materialized from the directory service. The new gateway must keep the
  // manual row and delete the materialized one (directory hosts are
  // in-memory now; a stale copy would linger on the menu forever).
  const dbA = join(mkdtempSync(join(tmpdir(), 'web5250-dir-')), 'menu.db');
  {
    const legacy = new DatabaseSync(dbA);
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
        proxy_host  TEXT,
        proxy_port  INTEGER,
        proxy_user  TEXT,
        proxy_pass  TEXT,
        printer_enabled     INTEGER NOT NULL DEFAULT 0,
        printer_device_name TEXT,
        printer_mode        TEXT NOT NULL DEFAULT 'text',
        recording  INTEGER NOT NULL DEFAULT 0,
        position   INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        directory  TEXT,
        directory_ref TEXT,
        directory_autosignon INTEGER NOT NULL DEFAULT 0,
        sign_on_user TEXT,
        sign_on_password TEXT
      )
    `);
    const ins = legacy.prepare(
      `INSERT INTO systems (name, host, port, term_type, code_page, directory, directory_ref, directory_autosignon, position)
       VALUES (?, '127.0.0.1', ?, 'IBM-3477-FC', 'cp037', ?, ?, ?, ?)`
    );
    ins.run('LEGACY', MOCK_PORT, null, null, 0, 1);
    ins.run('DIRSTALE', MOCK_PORT, 'directory', 'stale-01', 0, 2);
    legacy.close();
  }

  const gatewayEnv = {
    ...process.env,
    PORT: String(HTTP_PORT),
    IBM_I_HOST: '127.0.0.1',
    IBM_I_PORT: String(MOCK_PORT),
    IBM_I_TERM_TYPE: 'IBM-3477-FC',
    IBM_I_CODEPAGE: 'cp037',
    ADMIN_PIN: PIN,
    DIRECTORY_URL: `http://127.0.0.1:${DIR_PORT}`,
    DIRECTORY_TOKEN: TOKEN,
    DIRECTORY_SYNC_INTERVAL_MS: '60000',
    // The template: pattern-named rows, an unreachable default port
    // (every entry must override it to connect), a device prefix.
    DIRECTORY_TEMPLATE_NAME: 'DIR {name}',
    DIRECTORY_TEMPLATE_DESCRIPTION: '',
    DIRECTORY_TEMPLATE_PORT: '23',
    DIRECTORY_TEMPLATE_DEV_PREFIX: 'DIRP_',
    WEB5250_DB: dbA
  };
  let gw = spawn(process.execPath, ['dist/server.js'], { stdio: 'inherit', env: gatewayEnv });
  procs.push(gw);
  if (!(await waitHealthy(HTTP_PORT))) {
    console.error('gateway never became healthy');
    process.exit(1);
  }

  console.log('\n1. Boot purges rows materialized by an older gateway');
  let rows = [];
  for (let i = 0; i < 50 && (await systemsList()).length < 3; i++) await sleep(200);
  rows = await systemsList();
  check(
    'the manual row survives, the materialized row is gone',
    rows.some((s) => s.name === 'LEGACY') && !rows.some((s) => s.name === 'DIRSTALE'),
    JSON.stringify(rows.map((s) => s.name))
  );

  // ------------------------------------------- 2. boot sync materializes (memory)
  console.log('\n2. Boot sync lists directory entries from the template');
  for (let i = 0; i < 50 && rows.filter((s) => s.directory).length < 2; i++) {
    rows = await systemsList();
    if (rows.filter((s) => s.directory).length < 2) await sleep(200);
  }
  const dir = rows.filter((s) => s.directory);
  const manual = rows.filter((s) => !s.directory);
  const prod = dir.find((s) => s.name === 'DIR PROD');
  const dev = dir.find((s) => s.name === 'DIR DEV');
  check('both entries listed', dir.length === 2, JSON.stringify(dir.map((s) => s.name)));
  check('stored rows list before directory rows', manual.length === 1 && rows[0].name === 'LEGACY', JSON.stringify(rows.map((s) => s.name)));
  check('name pattern applied (DIR {name})', Boolean(prod) && Boolean(dev));
  check('ids are namespaced dir:<entry id>', prod?.id === 'dir:prod-01' && dev?.id === 'dir:dev-02', JSON.stringify({ p: prod?.id, d: dev?.id }));
  check('entry description used when template description empty', prod?.description === 'Production LPAR', String(prod?.description));
  check('per-entry port override beat the template default', prod?.port === MOCK_PORT, String(prod?.port));
  check('autoSignOn flags reach the menu', prod?.autoSignOn === true && dev?.autoSignOn === false, JSON.stringify({ p: prod?.autoSignOn, d: dev?.autoSignOn }));
  check('public rows carry no credentials/refs', JSON.stringify(prod).includes('password') === false && prod.directoryRef === undefined);
  check('no proxy configured on this gateway: direct connection', prod?.viaProxy === false, JSON.stringify(prod?.viaProxy));

  // ------------------------------------------------------- 3. auto sign-on
  console.log('\n3. Opening a directory system signs on automatically');
  const s = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?system=${prod.id}`);
  check(
    'signed on with the directory credential (MAIN menu)',
    await waitFor(s.term, (t) => t.text().includes('IBM i Main Menu') && t.text().includes(`Signed on as ${DIR_USER}`), 10000),
    s.term.text().slice(0, 300)
  );
  check('automation started message sent', s.term.autoMsgs.some((m) => m.phase === 'started'));
  check('password never crosses the WebSocket', !s.term.rawLog.some((m) => m.includes(DIR_PW)));
  s.sock.close();
  await sleep(300);

  // ------------------------------------- 4. entry without stored credential
  console.log('\n4. Entry without a credential opens the manual sign-on screen');
  const m = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?system=${dev.id}`);
  check(
    'manual sign-on screen rendered, keyboard free',
    await waitFor(m.term, (t) => t.text().includes('AS/400 Sign On') && t.oia.lock === 'none', 8000),
    m.term.text().slice(0, 200)
  );
  check('no automation on a credential-less entry', m.term.autoMsgs.length === 0);
  m.sock.close();
  await sleep(300);

  // ------------------------------------------ 5. credential fetch failure
  console.log('\n5. Directory outage during credential fetch degrades to manual + banner');
  state.failCredsFor = 'prod-01';
  const f = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?system=${prod.id}`);
  check(
    'manual sign-on screen (session still usable)',
    await waitFor(f.term, (t) => t.text().includes('AS/400 Sign On') && t.oia.lock === 'none', 8000),
    f.term.text().slice(0, 200)
  );
  check(
    'banner explains the unavailable auto sign-on',
    f.term.notices.some((n) => String(n.message ?? '').includes('Automatic sign-on is unavailable')),
    JSON.stringify(f.term.notices)
  );
  state.failCredsFor = null;
  f.sock.close();
  await sleep(300);

  // ------------------------------------------- 6. re-sync: add/update/remove
  console.log('\n6. Re-sync adds, updates and removes with stable ids');
  const auth = await api('api/admin/auth', { method: 'POST', body: { pin: PIN } });
  const { token: adminToken } = await auth.json();
  state.entries = [
    { ...state.entries[0], name: 'PROD2' }, // rename in the directory
    { id: 'hr-03', name: 'HR', host: '127.0.0.1', port: MOCK_PORT, autoSignOn: true } // new
    // dev-02 removed
  ];
  state.creds['hr-03'] = { username: 'HRUSER', password: 'hr-pw' };
  const syncRes = await adminSync(adminToken);
  const syncBody = await syncRes.json();
  check('admin sync route succeeds', syncRes.ok && syncBody.directory?.lastCounts?.added === 1 && syncBody.directory?.lastCounts?.removed === 1, JSON.stringify(syncBody));
  rows = await systemsList();
  const prod2 = rows.find((r) => r.name === 'DIR PROD2');
  check('renamed entry keeps its gateway id', prod2?.id === prod.id, `${prod2?.id} vs ${prod.id}`);
  check('removed entry disappears from the menu', !rows.some((r) => r.name === 'DIR DEV'));
  check('new entry appears', rows.some((r) => r.name === 'DIR HR'));

  // Directory hosts are not stored: the editor and the export carry the
  // stored (manual) catalog only.
  const adminRows = await (await api('api/admin/systems', { token: adminToken })).json();
  check(
    'admin editor lists stored systems only (no directory rows)',
    (adminRows.systems ?? []).every((r) => !r.directory) && (adminRows.systems ?? []).some((r) => r.name === 'LEGACY'),
    JSON.stringify((adminRows.systems ?? []).map((r) => r.name))
  );
  const exp = await api('api/admin/config', { token: adminToken });
  const doc = await exp.json();
  check(
    'export carries the stored catalog only',
    doc.directoryRowsExcluded === undefined && doc.systems.length === 1 && doc.systems.every((x) => !x.directory),
    JSON.stringify({ n: doc.directoryRowsExcluded, systems: doc.systems.map((x) => x.name) })
  );

  // ----------------------------- 7. manually-configured sign-on account
  console.log('\n7. Manually-configured system with a stored sign-on account');
  const createRes = await api('api/admin/systems', {
    method: 'POST',
    token: adminToken,
    body: {
      name: 'MANUAL',
      description: '',
      host: '127.0.0.1',
      port: MOCK_PORT,
      ssl: false,
      termType: 'IBM-3477-FC',
      codePage: 'cp037',
      signOnUser: 'MANUALUSR',
      signOnPassword: 'ManualPw7'
    }
  });
  const created = (await createRes.json())?.system;
  check('admin create accepts a sign-on pair (response stays credential-free)', createRes.status === 201 && created?.name === 'MANUAL' && created?.signOnUser === undefined, JSON.stringify(created));
  const adminRows2 = await (await api('api/admin/systems', { token: adminToken })).json();
  const adminManual = (adminRows2.systems ?? []).find((r) => r.name === 'MANUAL');
  check('authenticated editor view round-trips the pair (like proxy credentials)', adminManual?.signOnUser === 'MANUALUSR' && adminManual?.signOnPassword === 'ManualPw7', JSON.stringify(adminManual));
  rows = await systemsList();
  const manualRow = rows.find((r) => r.name === 'MANUAL');
  check('public row shows the auto sign-on marker but no credential', manualRow?.autoSignOn === true && manualRow?.signOnUser === undefined && manualRow?.signOnPassword === undefined && !JSON.stringify(rows).includes('ManualPw7'), JSON.stringify(manualRow));
  const s7 = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?system=${manualRow.id}`);
  check(
    'stored credential signs the session on automatically',
    await waitFor(s7.term, (t) => t.text().includes('IBM i Main Menu') && t.text().includes('Signed on as MANUALUSR'), 10000),
    s7.term.text().slice(0, 300)
  );
  check('stored password never crosses the WebSocket', !s7.term.rawLog.some((m) => m.includes('ManualPw7')));
  s7.sock.close();
  await sleep(300);
  const halfRes = await api('api/admin/systems', {
    method: 'POST',
    token: adminToken,
    body: { name: 'HALF', host: '127.0.0.1', port: MOCK_PORT, termType: 'IBM-3477-FC', codePage: 'cp037', signOnUser: 'NOBODY' }
  });
  check('a sign-on user without a password is rejected', halfRes.status === 400, String(halfRes.status));

  // ------------------------------------- 8. outage: rows vanish, nothing stored
  console.log('\n8. Directory outage removes the directory rows (no stale hosts)');
  state.requireToken = 'wrong-token';
  const bad = await adminSync(adminToken);
  check('sync call succeeds (the failure is reported, not thrown)', bad.ok, String(bad.status));
  const badBody = await bad.json();
  check('status view records the error', typeof badBody.directory?.lastError === 'string' && badBody.directory.lastError.length > 0, JSON.stringify(badBody.directory));
  check('last counts report the removal', badBody.directory?.lastCounts?.removed === 2 && badBody.directory?.lastCounts?.total === 0, JSON.stringify(badBody.directory?.lastCounts));
  rows = await systemsList();
  check('menu drops every directory row while the service is down', rows.filter((r) => r.directory).length === 0 && rows.some((r) => r.name === 'MANUAL'), JSON.stringify(rows.map((r) => r.name)));
  const auditRes = await api('api/admin/audit', { token: adminToken });
  const audit = await auditRes.json();
  check('audit trail has directory events', (audit.entries ?? []).some((e) => String(e.action).startsWith('directory.')), JSON.stringify((audit.entries ?? []).slice(0, 3)));

  // Recovery: the same entries come back with the same ids.
  state.requireToken = TOKEN;
  const back = await adminSync(adminToken);
  check('recovery sync succeeds', back.ok, String(back.status));
  rows = await systemsList();
  check(
    'directory rows return after recovery, ids unchanged',
    rows.filter((r) => r.directory).length === 2 && rows.some((r) => r.id === prod.id && r.name === 'DIR PROD2'),
    JSON.stringify(rows.map((r) => [r.id, r.name]))
  );

  // Restart with the directory down: nothing directory-sourced may survive
  // in the catalog (it was never written there).
  console.log('\n8b. Gateway restart leaves nothing directory-sourced in the catalog');
  state.requireToken = 'wrong-token';
  gw.kill();
  await sleep(600);
  gw = spawn(process.execPath, ['dist/server.js'], { stdio: 'inherit', env: gatewayEnv });
  procs.push(gw);
  if (!(await waitHealthy(HTTP_PORT))) {
    console.error('gateway never became healthy after restart');
    process.exit(1);
  }
  for (let i = 0; i < 20; i++) await sleep(200); // let the boot sync fail
  rows = await systemsList();
  check(
    'after restart: stored systems only on the menu',
    rows.filter((r) => r.directory).length === 0 && rows.some((r) => r.name === 'LEGACY') && rows.some((r) => r.name === 'MANUAL'),
    JSON.stringify(rows.map((r) => r.name))
  );
  const auth2 = await api('api/admin/auth', { method: 'POST', body: { pin: PIN } });
  const { token: adminToken2 } = await auth2.json();
  const stored = await (await api('api/admin/systems', { token: adminToken2 })).json();
  check(
    'the catalog itself holds only the manual rows',
    (stored.systems ?? []).length === 2 && (stored.systems ?? []).every((r) => !r.directory),
    JSON.stringify((stored.systems ?? []).map((r) => r.name))
  );

  // ------------------------------------- 9. proxy fallback (IBM_I_PROXY_*)
  console.log('\n9. Directory hosts fall back to the IBM_I proxy when no template proxy is set');
  state.requireToken = TOKEN; // this gateway must sync on boot
  const socks = new Socks5Server(PROXY_USER, PROXY_PASS);
  await socks.listen(SOCKS_PORT);
  procs.push(
    spawn(process.execPath, ['dist/server.js'], {
      stdio: 'inherit',
      env: {
        ...gatewayEnv,
        PORT: String(PROXY_PORT),
        WEB5250_DB: join(mkdtempSync(join(tmpdir(), 'web5250-dir-px-')), 'menu.db'),
        IBM_I_PROXY_HOST: '127.0.0.1',
        IBM_I_PROXY_PORT: String(SOCKS_PORT),
        IBM_I_PROXY_USER: PROXY_USER,
        IBM_I_PROXY_PASSWORD: PROXY_PASS
        // deliberately no DIRECTORY_TEMPLATE_PROXY_*: the IBM_I proxy applies
      }
    })
  );
  if (!(await waitHealthy(PROXY_PORT))) {
    console.error('proxy gateway never became healthy');
    process.exit(1);
  }
  let pxRows = [];
  for (let i = 0; i < 50 && (await systemsList(PROXY_PORT)).filter((s) => s.directory).length < 2; i++) {
    pxRows = await systemsList(PROXY_PORT);
    if (pxRows.filter((s) => s.directory).length < 2) await sleep(200);
  }
  pxRows = await systemsList(PROXY_PORT);
  const pxDir = pxRows.filter((s) => s.directory);
  check('directory rows report the SOCKS5 proxy', pxDir.length === 2 && pxDir.every((s) => s.viaProxy === true), JSON.stringify(pxDir.map((s) => [s.name, s.viaProxy])));
  const s9 = await openSession(`ws://127.0.0.1:${PROXY_PORT}/ws?system=${pxDir[0].id}`);
  check(
    'session opens through the SOCKS5 tunnel',
    await waitFor(s9.term, (t) => t.text().includes('IBM i Main Menu'), 10000),
    s9.term.text().slice(0, 300)
  );
  check(
    'the SOCKS5 server saw the authenticated tunnel to the host',
    socks.stats.authed.includes(PROXY_USER) && socks.stats.tunnels.some((t) => t === `127.0.0.1:${MOCK_PORT}`),
    JSON.stringify(socks.stats)
  );
  s9.sock.close();
  await sleep(300);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  dirSrv.close();
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('directory test crashed:', err);
  dirSrv.close();
  cleanup();
  process.exitCode = 1;
});
