// End-to-end smoke test: mock IBM i host + built gateway + a WebSocket
// client that drives the terminal like a browser would. Also covers the
// connection-menu API: system list, PIN auth, CRUD, ?system= sessions.
//
// Usage: npm run build && npm run smoke
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MOCK_PORT = 18023;
const HTTP_PORT = 18080;
const ADMIN_PIN = '4321';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail = '') {
  const mark = cond ? 'ok' : 'FAIL';
  console.log(`  [${mark}] ${name}${cond ? '' : ' - ' + detail}`);
  if (!cond) failures++;
}

const procs = [];
function cleanup() {
  for (const p of procs) p.kill();
}
process.on('exit', cleanup);

async function waitHealthy() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/healthz`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return false;
}

// ------------------------------------------------------------- terminal model
class Term {
  rows = 24;
  cols = 80;
  cells = [];
  cursor = [1, 1];
  oia = { lock: 'none', insert: false, messageWait: false, errorCode: false };
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
    } else if (msg.t === 'oia') {
      this.oia = { ...this.oia, ...msg };
    }
  }

  row(n) {
    let s = '';
    for (let c = 0; c < this.cols; c++) s += this.cells[(n - 1) * this.cols + c] ?? ' ';
    return s;
  }

  text() {
    const out = [];
    for (let r = 1; r <= this.rows; r++) out.push(this.row(r).replace(/\s+$/, ''));
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

async function main() {
  console.log('Starting mock host and gateway...');
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
        IBM_I_DEV_PREFIX: 'TEST_',
        IBM_I_TERM_TYPE: 'IBM-3477-FC',
        IBM_I_CODEPAGE: 'cp037',
        ADMIN_PIN,
        WEB5250_DB: join(mkdtempSync(join(tmpdir(), 'web5250-smoke-')), 'menu.db')
      }
    })
  );

  if (!(await waitHealthy())) {
    console.error('gateway never became healthy');
    process.exit(1);
  }

  const ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/ws`);
  const term = new Term();
  ws.addEventListener('message', (ev) => term.apply(JSON.parse(String(ev.data))));

  const send = (msg) => ws.send(JSON.stringify(msg));
  const key = (k, ch) => send({ t: 'key', k, ch });
  const type = (s) => {
    for (const ch of s) key('char', ch);
  };

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  console.log('\n1. Sign-on screen');
  check(
    'QDSIGNON-like screen rendered',
    await waitFor(term, (t) => t.text().includes('AS/400 Sign On') && t.text().includes('Password'), 8000, term.text().slice(0, 200))
  );
  check('24x80 grid', term.rows === 24 && term.cols === 80);
  check('cursor at User field (9,45)', term.cursor[0] === 9 && term.cursor[1] === 45, JSON.stringify(term.cursor));
  check('keyboard unlocked after read invite', await waitFor(term, (t) => t.oia.lock === 'none', 5000, JSON.stringify(term.oia)));

  console.log('\n2. Error path (Enter with empty fields)');
  key('enter');
  check(
    'X II + error text on row 24',
    await waitFor(
      term,
      (t) => t.oia.lock === 'ii' && t.oia.errorCode && t.row(24).includes('not valid'),
      5000,
      `lock=${term.oia.lock} row24="${term.row(24)}"`
    )
  );
  key('reset');
  check(
    'Reset clears error',
    await waitFor(term, (t) => t.oia.lock === 'none' && !t.row(24).includes('not valid'), 5000, `lock=${term.oia.lock} row24="${term.row(24)}"`)
  );

  console.log('\n3. Sign on');
  type('MOCKUSER');
  check(
    'typed user id visible',
    await waitFor(term, (t) => t.row(9).includes('MOCKUSER'), 3000, `"${term.row(9)}"`)
  );
  key('tab');
  check('Tab moves to password field', await waitFor(term, (t) => t.cursor[0] === 10, 3000, JSON.stringify(term.cursor)));
  type('SECRETPW');
  key('fieldexit');
  check(
    'Field Exit jumps to next field',
    await waitFor(term, (t) => t.cursor[0] === 12 && t.cursor[1] === 45, 3000, JSON.stringify(term.cursor))
  );
  key('enter');
  check(
    'MAIN menu rendered',
    await waitFor(term, (t) => t.text().includes('IBM i Main Menu') && t.text().includes('Signed on as MOCKUSER'), 8000, term.text().slice(0, 300))
  );
  check(
    'keyboard unlocked again',
    await waitFor(term, (t) => t.oia.lock === 'none', 5000, JSON.stringify(term.oia))
  );

  console.log('\n4. Function keys');
  key('pf1');
  check('F1 help panel', await waitFor(term, (t) => t.text().includes('mock help panel'), 5000, term.text().slice(0, 200)));
  key('pf3');
  check('F3 returns to MAIN', await waitFor(term, (t) => t.text().includes('IBM i Main Menu'), 5000, term.text().slice(0, 200)));

  console.log('\n5. Option field + sign off');
  type('90');
  key('enter');
  check('Sign off screen', await waitFor(term, (t) => t.text().includes('Sign off completed'), 5000, term.text().slice(0, 200)));

  console.log('\n6. Password never crosses the WebSocket');
  check('SECRETPW absent from all messages', !term.rawLog.some((m) => m.includes('SECRETPW')));

  ws.close();
  await sleep(400);

  // ------------------------------------------------------ 7. menu API + admin
  console.log('\n7. Connection menu API');
  const http = `http://127.0.0.1:${HTTP_PORT}`;
  const meta = await (await fetch(`${http}/api/meta`)).json();
  check('meta reports admin enabled', meta.adminEnabled === true);
  check('meta lists terminal models + code pages', Array.isArray(meta.termTypes) && meta.termTypes.includes('IBM-3477-FC') && meta.codePages.includes('cp037'));

  const seeded = await (await fetch(`${http}/api/systems`)).json();
  check('system list seeded from env', seeded.systems.length === 1 && seeded.systems[0].host === '127.0.0.1', JSON.stringify(seeded));

  check('wrong PIN rejected', (await fetch(`${http}/api/admin/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '0000' }) })).status === 401);
  const auth = await (await fetch(`${http}/api/admin/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: ADMIN_PIN }) })).json();
  check('correct PIN returns token', typeof auth.token === 'string' && auth.token.length > 30);
  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` };

  check('create without token is rejected', (await fetch(`${http}/api/admin/systems`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 401);

  const bad = await fetch(`${http}/api/admin/systems`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'X', host: 'bad host!' }) });
  check('invalid host rejected with 400', bad.status === 400, await bad.text());

  const created = await (
    await fetch(`${http}/api/admin/systems`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'MOCK2', description: 'second system', host: '127.0.0.1', port: MOCK_PORT, devPrefix: 'MENU_' })
    })
  ).json();
  check('admin can create a system', created.system?.id > 0 && created.system?.devPrefix === 'MENU_', JSON.stringify(created));

  const two = await (await fetch(`${http}/api/systems`)).json();
  check('list now has two systems', two.systems.length === 2);

  // ------------------------------------------- 8. session via ?system=<id>
  console.log('\n8. Menu-driven session (?system=)');
  const ws2 = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/ws?system=${created.system.id}`);
  const term2 = new Term();
  let hello2 = null;
  ws2.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.t === 'hello') hello2 = msg;
    term2.apply(msg);
  });
  await new Promise((resolve, reject) => {
    ws2.addEventListener('open', resolve);
    ws2.addEventListener('error', reject);
  });
  check('hello names the selected system', await waitFor(term2, () => hello2?.systemName === 'MOCK2', 3000), JSON.stringify(hello2));
  check('session renders sign-on screen', await waitFor(term2, () => term2.text().includes('AS/400 Sign On'), 8000, term2.text().slice(0, 120)));
  ws2.close();

  const ghost = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/ws?system=99999`);
  const ghostClosed = new Promise((resolve) => ghost.addEventListener('close', () => resolve(true)));
  check('unknown system id rejected', (await ghostClosed) === true);
  await sleep(200);

  // -------------------------------------- 8b. display names stay unique
  console.log('\n8b. Display names (?devname=)');
  const sysId = seeded.systems[0].id;
  const openNamed = async (name) => {
    const sock = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/ws?system=${sysId}&devname=${name}`);
    let hello = null;
    sock.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.t === 'hello') hello = msg;
    });
    await new Promise((resolve, reject) => {
      sock.addEventListener('open', resolve);
      sock.addEventListener('error', reject);
    });
    for (let i = 0; i < 50 && !hello; i++) await sleep(60);
    return { sock, hello };
  };
  const a = await openNamed('TESTDEV');
  const b = await openNamed('TESTDEV');
  check('first session keeps the requested name', a.hello?.devName === 'TESTDEV', JSON.stringify(a.hello));
  check('second session gets a numeric suffix', b.hello?.devName === 'TESTDEV1', JSON.stringify(b.hello));
  const long1 = await openNamed('ABCDEFGHIJ'); // 10 chars: twice to force a suffix
  const long2 = await openNamed('ABCDEFGHIJ');
  check('suffix fits the 10-char device limit', long2.hello?.devName === 'ABCDEFGHI1', JSON.stringify(long2.hello?.devName));
  a.sock.close();
  long1.sock.close();
  long2.sock.close();
  await sleep(400);
  const c = await openNamed('TESTDEV');
  check('name reusable after the session ends', c.hello?.devName === 'TESTDEV', JSON.stringify(c.hello));
  b.sock.close();
  c.sock.close();
  await sleep(200);

  // ------------------------------------------------- 9. update/move/delete
  console.log('\n9. Admin edit, reorder, delete');
  const id = created.system.id;
  const upd = await fetch(`${http}/api/admin/systems/${id}`, { method: 'PUT', headers: authHeaders, body: JSON.stringify({ name: 'RENAMED', host: '127.0.0.1', port: MOCK_PORT }) });
  check('admin can rename a system', upd.status === 200 && (await upd.json()).system.name === 'RENAMED');

  check(
    'move up works',
    (await fetch(`${http}/api/admin/systems/${id}/move`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ dir: 'up' }) })).status === 200
  );
  const moved = await (await fetch(`${http}/api/systems`)).json();
  check('renamed system is now first', moved.systems[0].id === id, JSON.stringify(moved.systems.map((s) => s.name)));

  check('delete works', (await fetch(`${http}/api/admin/systems/${id}`, { method: 'DELETE', headers: authHeaders })).status === 200);
  check('delete of missing id is 404', (await fetch(`${http}/api/admin/systems/${id}`, { method: 'DELETE', headers: authHeaders })).status === 404);
  const after = await (await fetch(`${http}/api/systems`)).json();
  check('list back to one system, renumbered', after.systems.length === 1 && after.systems[0].position === 1);

  // Rate limiting (last: leaves admin locked for a minute on the test server)
  let lastStatus = 0;
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${http}/api/admin/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '0000' }) });
    lastStatus = r.status;
  }
  check('6th bad PIN is locked out (429)', lastStatus === 429, `status=${lastStatus}`);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exitCode = 1;
});
