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
  attrs = [];
  cursor = [1, 1];
  oia = { lock: 'none', insert: false, messageWait: false, errorCode: false };
  rawLog = [];

  apply(msg) {
    this.rawLog.push(JSON.stringify(msg));
    if (msg.t === 'screen') {
      this.rows = msg.rows;
      this.cols = msg.cols;
      this.cells = new Array(this.rows * this.cols).fill(' ');
      this.attrs = new Array(this.rows * this.cols).fill(0x20);
      for (const [pos, attr, ch] of msg.cells) {
        this.cells[pos] = String(ch ?? ' ');
        this.attrs[pos] = Number(attr);
      }
      this.cursor = msg.cursor ?? this.cursor;
    } else if (msg.t === 'update') {
      if (Array.isArray(msg.cells)) {
        for (const [pos, attr, ch] of msg.cells) {
          this.cells[pos] = String(ch ?? ' ');
          if (attr !== undefined) this.attrs[pos] = Number(attr);
        }
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
        ALLOW_CUSTOM_HOST: '1', // lets section 10 aim a session at a dead port
        SESSION_GRACE_MS: '0', // legacy close-equals-teardown for the sections below
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
  // Attribute-position masking: the User field's attribute cell (9,44) must
  // reach the browser as a plain blank (0x20) — a real display shows the
  // attribute byte without video, so a 0x26 (white/underscore) field must
  // not appear to start one cell left of the cursor.
  const attrCell = term.attrs[(9 - 1) * 80 + (44 - 1)];
  const dataCell = term.attrs[(9 - 1) * 80 + (45 - 1)];
  check('attribute cell masked to plain blank (0x20)', attrCell === 0x20, `attr(9,44)=0x${attrCell.toString(16)}`);
  check('data cell carries the real field attr (0x26)', dataCell === 0x26, `attr(9,45)=0x${dataCell.toString(16)}`);
  type('MOCKUSER');
  check(
    'typed user id visible',
    await waitFor(term, (t) => t.row(9).includes('MOCKUSER'), 3000, `"${term.row(9)}"`)
  );
  key('tab');
  check('Tab moves to password field', await waitFor(term, (t) => t.cursor[0] === 10, 3000, JSON.stringify(term.cursor)));
  key('btab');
  check('Backtab returns to the User field', await waitFor(term, (t) => t.cursor[0] === 9 && t.cursor[1] === 45, 3000, JSON.stringify(term.cursor)));
  key('btab');
  check('Backtab from the first field wraps to the last', await waitFor(term, (t) => t.cursor[0] === 16 && t.cursor[1] === 45, 3000, JSON.stringify(term.cursor)));
  key('tab');
  check('Tab wraps around to the first field', await waitFor(term, (t) => t.cursor[0] === 9 && t.cursor[1] === 45, 3000, JSON.stringify(term.cursor)));
  key('tab');
  check('Tab re-enters the password field', await waitFor(term, (t) => t.cursor[0] === 10, 3000, JSON.stringify(term.cursor)));
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

  // ------------------------- 10. attach / takeover / grace (SESSION_GRACE_MS)
  // A second gateway with a short grace period: a detached session stays
  // alive and re-attachable via its hello token, a second attach takes it
  // over, and {t:'end'} or grace expiry destroys it for real.
  console.log('\n10. Session attach, takeover and grace');
  {
    const GRACE_PORT = HTTP_PORT + 1;
    procs.push(
      spawn(process.execPath, ['dist/server.js'], {
        stdio: 'inherit',
        env: {
          ...process.env,
          PORT: String(GRACE_PORT),
          IBM_I_HOST: '127.0.0.1',
          IBM_I_PORT: String(MOCK_PORT),
          IBM_I_DEV_PREFIX: 'GRACE_',
          IBM_I_TERM_TYPE: 'IBM-3477-FC',
          IBM_I_CODEPAGE: 'cp037',
          ALLOW_CUSTOM_HOST: '1',
          SESSION_GRACE_MS: '2500',
          WEB5250_DB: join(mkdtempSync(join(tmpdir(), 'web5250-smoke-')), 'menu.db')
        }
      })
    );
    const graceHttp = `http://127.0.0.1:${GRACE_PORT}`;
    let healthy = false;
    for (let i = 0; i < 50 && !healthy; i++) {
      try {
        healthy = (await fetch(`${graceHttp}/healthz`)).ok;
      } catch {
        await sleep(200);
      }
    }
    check('grace gateway became healthy', healthy);
    const openOn = async (qs) => {
      const sock = new WebSocket(`ws://127.0.0.1:${GRACE_PORT}/ws${qs}`);
      const term = new Term();
      let hello = null;
      let detachedDetail = '';
      sock.addEventListener('message', (ev) => {
        const msg = JSON.parse(String(ev.data));
        term.apply(msg);
        if (msg.t === 'hello') hello = msg;
        if (msg.t === 'status' && msg.status === 'detached') detachedDetail = msg.detail ?? '';
      });
      const closed = new Promise((resolve) => sock.addEventListener('close', () => resolve(true)));
      await new Promise((resolve, reject) => {
        sock.addEventListener('open', resolve);
        sock.addEventListener('error', reject);
      });
      for (let i = 0; i < 60 && !hello; i++) await sleep(50);
      // detachedDetail via getter: it is assigned after this object is returned.
      return { sock, term, hello, closed, get detachedDetail() { return detachedDetail; } };
    };

    const first = await openOn(`?devname=ATTACHDEV`);
    check('hello carries a session token', typeof first.hello?.sessionToken === 'string' && first.hello.sessionToken.length >= 16, JSON.stringify(first.hello?.sessionToken));
    check('hello carries the grace period', first.hello?.graceMs === 2500, JSON.stringify(first.hello?.graceMs));
    check('session reached the sign-on screen', await waitFor(first, () => first.term.text().includes('Sign On'), 8000));
    const beforeText = first.term.text();

    // Detach: closing the socket must NOT tear the session down.
    first.sock.close();
    await sleep(400);
    const second = await openOn(`?attach=${first.hello.sessionToken}`);
    check('attach replays the same device name', second.hello?.devName === 'ATTACHDEV', JSON.stringify(second.hello?.devName));
    check('attach replays the screen', await waitFor(second, () => second.term.text() === beforeText, 5000));

    // Takeover: a third attach evicts the second front-end.
    const third = await openOn(`?attach=${first.hello.sessionToken}`);
    check('takeover attaches the new front-end', third.hello?.devName === 'ATTACHDEV', JSON.stringify(third.hello?.devName));
    check('evicted front-end is told it was detached', await waitFor(second, () => second.detachedDetail !== '', 5000), JSON.stringify(second.detachedDetail));
    check('evicted socket closes', await Promise.race([second.closed, sleep(3000).then(() => false)]));
    third.sock.send(JSON.stringify({ t: 'end' }));
    check('explicit end closes the socket', await Promise.race([third.closed, sleep(3000).then(() => false)]));
    await sleep(300);
    const fresh = await openOn(`?devname=ATTACHDEV`);
    check('device name released after explicit end', fresh.hello?.devName === 'ATTACHDEV', JSON.stringify(fresh.hello?.devName));

    // Grace expiry: a detached session that is not re-attached disappears.
    fresh.sock.close();
    await sleep(3400);
    const late = await openOn(`?attach=${fresh.hello.sessionToken}`);
    check(
      'expired token refused with a status error',
      await waitFor(late, () => late.term.rawLog.some((m) => m.includes('no longer available')), 5000),
      JSON.stringify(late.term.rawLog.filter((m) => m.includes('status')).slice(-2))
    );
    late.sock.close();
    await sleep(200);
  }

  // ------------------------------- 10b. share / view-only mirrors (?view=)
  // A session's hello carries an independent share token; ?view=<token>
  // attaches read-only mirrors (any number at once) that see the same
  // screen stream, cannot type, cannot end the session, and follow it down
  // when it ends. The share token must not double as a control token.
  console.log('\n10b. Share link / view-only mirrors');
  {
    const SHARE_PORT = HTTP_PORT + 2;
    procs.push(
      spawn(process.execPath, ['dist/server.js'], {
        stdio: 'inherit',
        env: {
          ...process.env,
          PORT: String(SHARE_PORT),
          IBM_I_HOST: '127.0.0.1',
          IBM_I_PORT: String(MOCK_PORT),
          IBM_I_DEV_PREFIX: 'SHARE_',
          IBM_I_TERM_TYPE: 'IBM-3477-FC',
          IBM_I_CODEPAGE: 'cp037',
          SESSION_GRACE_MS: '8000',
          WEB5250_DB: join(mkdtempSync(join(tmpdir(), 'web5250-smoke-')), 'menu.db')
        }
      })
    );
    let healthy = false;
    for (let i = 0; i < 50 && !healthy; i++) {
      try {
        healthy = (await fetch(`http://127.0.0.1:${SHARE_PORT}/healthz`)).ok;
      } catch {
        await sleep(200);
      }
    }
    check('share gateway became healthy', healthy);

    const openOn = async (qs) => {
      const sock = new WebSocket(`ws://127.0.0.1:${SHARE_PORT}/ws${qs}`);
      const term = new Term();
      let hello = null;
      const statuses = [];
      const keyevents = [];
      sock.addEventListener('message', (ev) => {
        const msg = JSON.parse(String(ev.data));
        term.apply(msg);
        if (msg.t === 'hello') hello = msg;
        if (msg.t === 'status') statuses.push(msg.status);
        if (msg.t === 'keyevent') keyevents.push(msg.k);
      });
      const closed = new Promise((resolve) => sock.addEventListener('close', () => resolve(true)));
      await new Promise((resolve, reject) => {
        sock.addEventListener('open', resolve);
        sock.addEventListener('error', reject);
      });
      for (let i = 0; i < 60 && !hello; i++) await sleep(50);
      return { sock, term, hello, statuses, keyevents, closed };
    };

    const owner = await openOn('?devname=SHAREDEV');
    check(
      'hello carries a share token distinct from the session token',
      typeof owner.hello?.shareToken === 'string' && owner.hello.shareToken.length >= 16 && owner.hello.shareToken !== owner.hello?.sessionToken,
      JSON.stringify({ sessionToken: owner.hello?.sessionToken, shareToken: owner.hello?.shareToken })
    );
    check('owner reaches the sign-on screen', await waitFor(owner, () => owner.term.text().includes('Sign On'), 8000));

    // Two mirrors at once (the link works for any number of viewers).
    const v1 = await openOn(`?view=${owner.hello.shareToken}`);
    const v2 = await openOn(`?view=${owner.hello.shareToken}`);
    check('viewer hello is marked view-only', v1.hello?.viewOnly === true && v2.hello?.viewOnly === true, JSON.stringify(v1.hello));
    check('viewer gets no control token', v1.hello?.sessionToken === undefined, JSON.stringify(v1.hello));
    check(
      'viewers see the current screen',
      (await waitFor(v1, () => v1.term.text().includes('Sign On'), 5000)) &&
        (await waitFor(v2, () => v2.term.text().includes('Sign On'), 5000))
    );

    // The mirror follows the owner in real time (typed characters).
    for (const ch of 'MIRROR') owner.sock.send(JSON.stringify({ t: 'key', k: 'char', ch }));
    check(
      'both mirrors follow the owner typing',
      (await waitFor(v1, () => v1.term.row(9).includes('MIRROR'), 5000)) &&
        (await waitFor(v2, () => v2.term.row(9).includes('MIRROR'), 5000)),
      `v1="${v1.term.row(9).trim()}" v2="${v2.term.row(9).trim()}"`
    );
    const before = owner.term.row(9);

    // Viewer input is dropped - watching never becomes typing.
    v1.sock.send(JSON.stringify({ t: 'key', k: 'char', ch: 'X' }));
    v1.sock.send(JSON.stringify({ t: 'enter' }));
    await sleep(700);
    check('viewer keystrokes change nothing (owner)', owner.term.row(9) === before, `"${owner.term.row(9).trim()}"`);
    check('viewer keystrokes change nothing (viewer)', v1.term.row(9) === before, `"${v1.term.row(9).trim()}"`);

    // A viewer {t:'end'} must not end a session it does not own.
    v2.sock.send(JSON.stringify({ t: 'end' }));
    await sleep(600);
    check('viewer cannot end the session', !(await Promise.race([owner.closed, sleep(300).then(() => false)])));

    // The owner detaching does not disturb the mirrors; a re-attach resumes
    // in front of them (and no viewer ever sees a takeover 'detached').
    owner.sock.close();
    await sleep(400);
    check('mirrors stay up while the owner is away', !(await Promise.race([v1.closed, sleep(300).then(() => false)])));
    const back = await openOn(`?attach=${owner.hello.sessionToken}`);
    check('owner re-attaches to the same device', back.hello?.devName === 'SHAREDEV', JSON.stringify(back.hello?.devName));
    for (const ch of 'BACK') back.sock.send(JSON.stringify({ t: 'key', k: 'char', ch }));
    check('mirrors follow the re-attached owner', await waitFor(v1, () => v1.term.row(9).includes('MIRRORBACK'), 5000), `"${v1.term.row(9).trim()}"`);
    check('no viewer ever saw a detached takeover', !v1.statuses.includes('detached') && !v2.statuses.includes('detached'), JSON.stringify(v1.statuses));

    // Non-printing keys are named for the mirrors (the toast the browser
    // renders); printable characters echo on the screen and stay unreported.
    back.sock.send(JSON.stringify({ t: 'key', k: 'insert' }));
    check(
      'viewer is told the owner pressed a special key',
      await waitFor(v1, () => v1.keyevents.length === 1 && v1.keyevents[0] === 'insert', 3000),
      JSON.stringify(v1.keyevents)
    );
    back.sock.send(JSON.stringify({ t: 'key', k: 'pf3' }));
    check(
      'the next key replaces it',
      await waitFor(v1, () => v1.keyevents.length === 2 && v1.keyevents[1] === 'pf3', 3000),
      JSON.stringify(v1.keyevents)
    );
    back.sock.send(JSON.stringify({ t: 'key', k: 'char', ch: 'Z' }));
    await sleep(500);
    check('printable characters are not announced', v1.keyevents.length === 2, JSON.stringify(v1.keyevents));

    // Ending the session ends every mirror with it.
    back.sock.send(JSON.stringify({ t: 'end' }));
    check('mirror 1 closes with the session', await Promise.race([v1.closed, sleep(3000).then(() => false)]));
    check('mirror 2 closes with the session', await Promise.race([v2.closed, sleep(3000).then(() => false)]));

    // A dead share link reports itself instead of a bare close.
    const lateViewer = await openOn(`?view=${owner.hello.shareToken}`);
    check(
      'dead share token refused with a status error',
      await waitFor(lateViewer, () => lateViewer.term.rawLog.some((m) => m.includes('no longer available')), 5000),
      JSON.stringify(lateViewer.term.rawLog.slice(-2))
    );
    lateViewer.sock.close();

    // The share token must not double as an attach (control) token.
    const hijack = await openOn(`?attach=${owner.hello.shareToken}`);
    check(
      'share token cannot attach as a controller',
      await waitFor(hijack, () => hijack.term.rawLog.some((m) => m.includes('no longer available')), 5000),
      JSON.stringify(hijack.term.rawLog.slice(-2))
    );
    hijack.sock.close();
    await sleep(200);
  }

  // ------------------------------------- 11. host failure reaps the session
  console.log('\n11. Host failure tears down the session');
  const openSession = async (url) => {
    const sock = new WebSocket(url);
    const msgs = [];
    let hello = null;
    sock.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.t === 'hello') hello = msg;
      msgs.push(msg);
    });
    const closed = new Promise((resolve) => sock.addEventListener('close', (ev) => resolve(ev)));
    await new Promise((resolve, reject) => {
      sock.addEventListener('open', resolve);
      sock.addEventListener('error', reject);
    });
    for (let i = 0; i < 50 && !hello; i++) await sleep(60);
    return { sock, msgs, hello, closed };
  };
  const sawStatus = (s, name) => s.msgs.some((m) => m.t === 'status' && m.status === name);

  // (a) connect failure: the gateway must release the display name and close
  //     the browser socket instead of leaving a dead session behind.
  const dead = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?host=127.0.0.1&port=1&devname=DEADDEV`);
  check('connect failure reports status error', await waitFor(dead, () => sawStatus(dead, 'error'), 8000), JSON.stringify(dead.msgs.filter((m) => m.t === 'status')));
  const deadClose = await Promise.race([dead.closed, sleep(3000).then(() => null)]);
  check('gateway closes the browser socket after the error', deadClose !== null);
  const dead2 = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?host=127.0.0.1&port=1&devname=DEADDEV`);
  check('device name released after connect failure (no suffix creep)', dead2.hello?.devName === 'DEADDEV', JSON.stringify(dead2.hello?.devName));
  dead2.sock.close();

  // (b) host dies mid-session: same teardown, observable end to end.
  const live = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?system=${sysId}&devname=DYINGDEV`);
  check('session is live before the host dies', await waitFor(live, () => live.msgs.some((m) => m.t === 'screen'), 8000));
  procs[0].kill(); // the mock host: its client sockets close underneath us
  check('session reports closed when the host dies', await waitFor(live, () => sawStatus(live, 'closed'), 8000));
  const liveClose = await Promise.race([live.closed, sleep(3000).then(() => null)]);
  check('browser socket closed after host death', liveClose !== null);
  const revived = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?system=${sysId}&devname=DYINGDEV`);
  check('device name reusable after mid-session host death', revived.hello?.devName === 'DYINGDEV', JSON.stringify(revived.hello?.devName));
  revived.sock.close();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exitCode = 1;
});
