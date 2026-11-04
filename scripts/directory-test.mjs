// End-to-end test for the directory service integration:
//   1. Boot sync: entries materialize from the template (name pattern,
//      per-entry port/ssl overrides, description fallback) and list after
//      the manual rows.
//   2. Auto sign-on: opening a directory system signs on with the entry's
//      credential; the password never crosses the WebSocket.
//   3. Entry without a credential (404): manual sign-on screen.
//   4. Credential fetch failure (500): manual sign-on screen + banner.
//   5. Re-sync via the admin route: add/update/remove, stable row ids.
//   6. Directory outage (401): last-good rows stay, lastError reported.
//   7. Manually-configured system with a stored sign-on pair: same
//      automatic sign-on, credentials stripped from the public list.
//
// Usage: npm run build && npm run test:directory
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MOCK_PORT = 18053; // mock 5250 host (accepts any non-empty sign-on)
const DIR_PORT = 18054; // mock directory service
const HTTP_PORT = 18055; // gateway under test
const PIN = '4321';
const TOKEN = 'dir-token-1';
const DIR_USER = 'DIRUSER';
const DIR_PW = 'DirSecret9';

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
  return fetch(`http://127.0.0.1:${HTTP_PORT}/${name}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
};

async function systemsList() {
  const res = await api('api/systems');
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
  procs.push(
    spawn(process.execPath, ['dist/server.js'], {
      stdio: 'inherit',
      env: {
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
        WEB5250_DB: join(mkdtempSync(join(tmpdir(), 'web5250-dir-')), 'menu.db')
      }
    })
  );
  if (!(await waitHealthy(HTTP_PORT))) {
    console.error('gateway never became healthy');
    process.exit(1);
  }

  // ------------------------------------------------ 1. boot sync materializes
  console.log('\n1. Boot sync materializes directory entries from the template');
  let rows = [];
  for (let i = 0; i < 50 && rows.filter((s) => s.directory).length < 2; i++) {
    rows = await systemsList();
    if (rows.filter((s) => s.directory).length < 2) await sleep(200);
  }
  const dir = rows.filter((s) => s.directory);
  const manual = rows.filter((s) => !s.directory);
  const prod = dir.find((s) => s.name === 'DIR PROD');
  const dev = dir.find((s) => s.name === 'DIR DEV');
  check('both entries synced', dir.length === 2, JSON.stringify(dir.map((s) => s.name)));
  check('manual (seeded) rows list before directory rows', manual.length === 1 && rows[0].name === 'IBM i', JSON.stringify(rows.map((s) => s.name)));
  check('name pattern applied (DIR {name})', Boolean(prod) && Boolean(dev));
  check('entry description used when template description empty', prod?.description === 'Production LPAR', String(prod?.description));
  check('per-entry port override beat the template default', prod?.port === MOCK_PORT, String(prod?.port));
  check('autoSignOn flags reach the menu', prod?.autoSignOn === true && dev?.autoSignOn === false, JSON.stringify({ p: prod?.autoSignOn, d: dev?.autoSignOn }));
  check('public rows carry no credentials/refs', JSON.stringify(prod).includes('password') === false && prod.directoryRef === undefined);

  // ------------------------------------------------------- 2. auto sign-on
  console.log('\n2. Opening a directory system signs on automatically');
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

  // ------------------------------------- 3. entry without stored credential
  console.log('\n3. Entry without a credential opens the manual sign-on screen');
  const m = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?system=${dev.id}`);
  check(
    'manual sign-on screen rendered, keyboard free',
    await waitFor(m.term, (t) => t.text().includes('AS/400 Sign On') && t.oia.lock === 'none', 8000),
    m.term.text().slice(0, 200)
  );
  check('no automation on a credential-less entry', m.term.autoMsgs.length === 0);
  m.sock.close();
  await sleep(300);

  // ------------------------------------------ 4. credential fetch failure
  console.log('\n4. Directory outage during credential fetch degrades to manual + banner');
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

  // ------------------------------------------- 5. re-sync: add/update/remove
  console.log('\n5. Re-sync adds, updates and removes with stable ids');
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
  check('updated entry keeps its gateway row id', prod2?.id === prod.id, `${prod2?.id} vs ${prod.id}`);
  check('removed entry disappears from the menu', !rows.some((r) => r.name === 'DIR DEV'));
  check('new entry appears', rows.some((r) => r.name === 'DIR HR'));

  // Export excludes directory rows but notes the count.
  const exp = await api('api/admin/config', { token: adminToken });
  const doc = await exp.json();
  check('export excludes directory rows and notes the count', doc.directoryRowsExcluded === 2 && doc.systems.length === 1 && doc.systems.every((x) => x.directory !== true), JSON.stringify({ n: doc.directoryRowsExcluded, systems: doc.systems.map((x) => x.name) }));

  // ------------------------------------- 6. outage keeps the last-good list
  console.log('\n6. Directory outage keeps the last-good menu rows');
  state.requireToken = 'wrong-token';
  const bad = await adminSync(adminToken);
  check('sync call reports the failure', bad.ok, String(bad.status));
  const badBody = await bad.json();
  check('status view records the error', typeof badBody.directory?.lastError === 'string' && badBody.directory.lastError.length > 0, JSON.stringify(badBody.directory));
  rows = await systemsList();
  check('menu still lists the last-good directory rows', rows.filter((r) => r.directory).length === 2, JSON.stringify(rows.map((r) => r.name)));
  const auditRes = await api('api/admin/audit', { token: adminToken });
  const audit = await auditRes.json();
  check('audit trail has directory events', (audit.entries ?? []).some((e) => String(e.action).startsWith('directory.')), JSON.stringify((audit.entries ?? []).slice(0, 3)));

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
  const adminRows = await (await api('api/admin/systems', { token: adminToken })).json();
  const adminManual = (adminRows.systems ?? []).find((r) => r.name === 'MANUAL');
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
