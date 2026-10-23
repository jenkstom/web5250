// End-to-end test for the session console, maintenance windows, remote
// assist, and session recording/replay: mock IBM i host + built gateway +
// WebSocket clients that drive sessions like browsers would, including the
// edge-identity header (TRUSTED_USER_HEADER) the console keys on.
//
// Usage: npm run build && npm run test:console
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const MOCK_PORT = 18073;
const HTTP_PORT = 18071;
const ADMIN_PIN = '4321';
const IDENTITY_HEADER = 'x-test-user';

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

async function waitFor(fn, timeoutMs, what = '') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true; // await handles sync predicates and promises alike
    await sleep(60);
  }
  return false;
}

/** A browser-shaped client: message log + tiny terminal model. */
async function openClient(url, identity) {
  const sock = new WebSocket(url, identity ? { headers: { [IDENTITY_HEADER]: identity } } : undefined);
  const msgs = [];
  let hello = null;
  const cells = new Map();
  sock.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    msgs.push(msg);
    if (msg.t === 'hello') hello = msg;
    if (msg.t === 'screen') for (const [pos, attr, ch] of msg.cells) cells.set(pos, String(ch ?? ' '));
    if (msg.t === 'update' && Array.isArray(msg.cells)) for (const [pos, attr, ch] of msg.cells) cells.set(pos, String(ch ?? ' '));
  });
  const closed = new Promise((resolve) => sock.addEventListener('close', () => resolve(true)));
  await new Promise((resolve, reject) => {
    sock.addEventListener('open', resolve);
    sock.addEventListener('error', reject);
  });
  for (let i = 0; i < 60 && !hello; i++) await sleep(50);
  return {
    sock,
    msgs,
    get hello() {
      return hello;
    },
    closed,
    row(n) {
      let s = '';
      for (let c = 0; c < 80; c++) s += cells.get((n - 1) * 80 + c) ?? ' ';
      return s;
    },
    text() {
      const out = [];
      for (let r = 1; r <= 24; r++) out.push(this.row(r).replace(/\s+$/, ''));
      return out.join('\n');
    },
    has(msg) {
      return msgs.some((m) => msg(m));
    }
  };
}

const key = (sock, k, ch) => sock.send(JSON.stringify({ t: 'key', k, ch }));
const type = (sock, s) => {
  for (const ch of s) key(sock, 'char', ch);
};

async function main() {
  console.log('Starting mock host and console gateway...');
  procs.push(spawn(process.execPath, ['scripts/mock-host.mjs', String(MOCK_PORT)], { stdio: 'inherit' }));
  await sleep(300);
  const dataDir = mkdtempSync(join(tmpdir(), 'web5250-console-'));
  procs.push(
    spawn(process.execPath, ['dist/server.js'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: String(HTTP_PORT),
        IBM_I_HOST: '127.0.0.1',
        IBM_I_PORT: String(MOCK_PORT),
        IBM_I_DEV_PREFIX: 'CON_',
        IBM_I_TERM_TYPE: 'IBM-3477-FC',
        IBM_I_CODEPAGE: 'cp037',
        ADMIN_PIN,
        TRUSTED_USER_HEADER: IDENTITY_HEADER,
        ASSIST_MAX_MS: '60000',
        SESSION_GRACE_MS: '20000',
        WEB5250_DB: join(dataDir, 'menu.db')
      }
    })
  );
  if (!(await waitHealthy(HTTP_PORT))) {
    console.error('gateway never became healthy');
    process.exit(1);
  }
  const http = `http://127.0.0.1:${HTTP_PORT}`;
  const auth = await (
    await fetch(`${http}/api/admin/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: ADMIN_PIN })
    })
  ).json();
  const H = { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` };

  // ------------------------------------------- 1. meta + recording opt-in
  console.log('\n1. Meta and per-system recording opt-in');
  const meta = await (await fetch(`${http}/api/meta`)).json();
  check('meta reports assist enabled', meta.assistEnabled === true);
  check('meta reports the identity header', meta.identityHeader === true);

  const systems = await (await fetch(`${http}/api/systems`)).json();
  const sysId = systems.systems[0].id;
  const upd = await fetch(`${http}/api/admin/systems/${sysId}`, {
    method: 'PUT',
    headers: H,
    body: JSON.stringify({ name: systems.systems[0].name, host: '127.0.0.1', port: MOCK_PORT, recording: true })
  });
  check('admin can enable recording on the system', upd.status === 200 && (await upd.json()).system.recording === true);

  // --------------------------------- 2. identity, sign-on capture, sessions
  console.log('\n2. Identity, sign-on capture, session list');
  const owner = await openClient(`ws://127.0.0.1:${HTTP_PORT}/ws?system=${sysId}&devname=CONSOLE`, 'alice');
  check('hello carries the edge identity', owner.hello?.you === 'alice', JSON.stringify(owner.hello?.you));
  check('hello reports the session is recorded', owner.hello?.recording === true, JSON.stringify(owner.hello?.recording));

  check(
    'sign-on screen arrives',
    await waitFor(() => owner.has((m) => m.t === 'screen') && owner.text().includes('Sign On'), 8000),
    owner.text().slice(0, 120)
  );
  type(owner.sock, 'MOCKUSER');
  key(owner.sock, 'tab');
  type(owner.sock, 'SECRETPW');
  key(owner.sock, 'enter');
  check(
    'signed on to the MAIN menu',
    await waitFor(() => owner.text().includes('IBM i Main Menu') && owner.text().includes('MOCKUSER'), 8000),
    owner.text().slice(0, 200)
  );

  let sessions = [];
  const listSessions = async () => {
    sessions = (await (await fetch(`${http}/api/admin/sessions`, { headers: H })).json()).sessions;
  };
  await listSessions();
  check(
    'console lists the session with identity + user',
    sessions.length === 1 &&
      sessions[0].identity === 'alice' &&
      sessions[0].signedOnUser === 'MOCKUSER' &&
      sessions[0].devName === 'CONSOLE' &&
      sessions[0].state === 'active',
    JSON.stringify(sessions[0])
  );
  check(
    'console row leaks no session/share tokens',
    !('sessionToken' in (sessions[0] ?? {})) && !('shareToken' in (sessions[0] ?? {}) && sessions[0].shareToken),
    JSON.stringify(Object.keys(sessions[0] ?? {}))
  );
  check('console row marks recording', sessions[0]?.recording === true);

  check(
    'session list requires the admin token',
    (await fetch(`${http}/api/admin/sessions`)).status === 401
  );

  // ------------------------------------------------------ 3. signal banner
  console.log('\n3. Console signal (banner notice)');
  const signal = await fetch(`${http}/api/admin/sessions/${sessions[0].id}/signal`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ message: 'Testing maintenance notice', level: 'warn' })
  });
  check('signal accepted', signal.status === 200);
  check(
    'owner received the notice banner',
    await waitFor(() => owner.has((m) => m.t === 'notice' && m.message === 'Testing maintenance notice'), 5000)
  );

  // ------------------------------------------------------ 4. remote assist
  console.log('\n4. Remote assist: request, consent, control, revoke');
  const helper = await openClient(`ws://127.0.0.1:${HTTP_PORT}/ws?view=${owner.hello.shareToken}`, 'bob');
  check('helper hello is a mirror with identity', helper.hello?.viewOnly === true && helper.hello?.you === 'bob');
  helper.sock.send(JSON.stringify({ t: 'ctrlrequest' }));
  check(
    'owner gets the consent prompt naming the requester',
    await waitFor(() => owner.has((m) => m.t === 'ctrlask' && m.from === 'bob'), 5000)
  );
  owner.sock.send(JSON.stringify({ t: 'assistreply', accept: true }));
  check(
    'helper is granted control',
    await waitFor(() => helper.has((m) => m.t === 'ctrlreply' && m.ok === true), 5000),
    JSON.stringify(helper.msgs.filter((m) => m.t === 'ctrlreply'))
  );
  check(
    'owner sees the lease in ctrlstate',
    await waitFor(() => owner.has((m) => m.t === 'ctrlstate' && m.holder === 'bob'), 5000)
  );

  // The controller can type; the owner sees whose non-printing key it was.
  // (Printable characters echo on screen and are deliberately not announced.)
  type(helper.sock, '4');
  check(
    'controller typing reaches the screen',
    await waitFor(() => owner.text().includes('IBM i Main Menu') && helper.text().includes('IBM i Main Menu'), 5000),
    helper.text().slice(0, 120)
  );
  key(helper.sock, 'tab');
  check(
    'owner is told the key and its origin',
    await waitFor(() => owner.has((m) => m.t === 'keyevent' && m.by === 'bob'), 5000),
    JSON.stringify(owner.msgs.filter((m) => m.t === 'keyevent'))
  );

  // A controller may never end the session.
  helper.sock.send(JSON.stringify({ t: 'end' }));
  await sleep(500);
  check('controller cannot end the session', !(await Promise.race([owner.closed, sleep(300).then(() => false)])));

  const keyEventsBefore = owner.msgs.filter((m) => m.t === 'keyevent').length;
  owner.sock.send(JSON.stringify({ t: 'ctrlrevoke' }));
  // The owner has no prior null-holder ctrlstate (that hello copy goes to
  // mirrors only), so waiting on the owner blocks until the real broadcast
  // lands; the helper's copy ships in the same flush.
  check(
    'revocation clears the lease everywhere',
    (await waitFor(() => owner.has((m) => m.t === 'ctrlstate' && m.holder === null && m.reason === 'revoked'), 5000)) &&
      helper.has((m) => m.t === 'ctrlstate' && m.holder === null && m.reason === 'revoked'),
    JSON.stringify({
      helperCtrl: helper.msgs.filter((m) => m.t === 'ctrlstate').map((m) => [m.holder, m.reason]),
      ownerCtrl: owner.msgs.filter((m) => m.t === 'ctrlstate').map((m) => [m.holder, m.reason])
    })
  );
  key(helper.sock, 'tab');
  await sleep(700);
  check(
    'helper input is dropped again after the lease ends',
    owner.msgs.filter((m) => m.t === 'keyevent').length === keyEventsBefore,
    JSON.stringify(owner.msgs.filter((m) => m.t === 'keyevent').slice(-3))
  );

  // Break-glass stays off by default: a forged token buys nothing.
  helper.sock.send(JSON.stringify({ t: 'ctrlrequest', adminToken: 'forged'.repeat(8) }));
  check(
    'break-glass request refused (ASSIST without consent config)',
    await waitFor(() => helper.has((m) => m.t === 'ctrlreply' && m.reason === 'not-authorized'), 5000),
    JSON.stringify(helper.msgs.filter((m) => m.t === 'ctrlreply'))
  );
  helper.sock.close();

  // ------------------------------------------------- 5. maintenance windows
  console.log('\n5. Maintenance windows');
  const maint = await fetch(`${http}/api/admin/systems/${sysId}/maintenance`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ on: true, message: 'Backup window' })
  });
  check('maintenance switched on', maint.status === 200);
  check(
    'live session got the maintenance banner',
    await waitFor(() => owner.has((m) => m.t === 'notice' && String(m.message).includes('Backup window')), 5000)
  );
  const refused = await openClient(`ws://127.0.0.1:${HTTP_PORT}/ws?system=${sysId}`);
  check(
    'new session refused with the maintenance message',
    await waitFor(() => refused.has((m) => m.t === 'status' && m.status === 'error' && String(m.detail).includes('maintenance')), 5000),
    JSON.stringify(refused.msgs.filter((m) => m.t === 'status'))
  );
  refused.sock.close();
  const menuBlocked = await (await fetch(`${http}/api/systems`)).json();
  check('public menu shows the window', menuBlocked.systems[0]?.maintenance?.on === true);

  // Deadline drain: a short window ends the live session at the bell.
  const drain = await fetch(`${http}/api/admin/systems/${sysId}/maintenance`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ on: true, message: 'Drain now', deadlineMs: Date.now() + 1500 })
  });
  check('deadline accepted', drain.status === 200);
  check(
    'session drained at the deadline',
    await waitFor(() => owner.has((m) => m.t === 'notice' && String(m.message).includes('ending sessions')), 8000)
  );
  check('owner socket closed by the drain', await Promise.race([owner.closed, sleep(3000).then(() => false)]));
  const off = await fetch(`${http}/api/admin/systems/${sysId}/maintenance`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ on: false })
  });
  check('maintenance switched off', off.status === 200);
  const afterOff = await (await fetch(`${http}/api/systems`)).json();
  check('menu is open again', afterOff.systems[0]?.maintenance === null || afterOff.systems[0]?.maintenance === undefined);

  // ------------------------------------- 6. recording, replay, history
  console.log('\n6. Recording, replay tokens, history');
  let recording = null;
  check(
    'recording finalized after the session ended',
    await waitFor(async () => {
      const rows = (await (await fetch(`${http}/api/admin/recordings`, { headers: H })).json()).recordings;
      recording = rows.find((r) => r.identity === 'alice' && r.endedAt !== null) ?? null;
      return recording !== null;
    }, 8000)
  );
  check('recording captured the IBM i user', recording?.signedOnUser === 'MOCKUSER', JSON.stringify(recording));

  const link = await (
    await fetch(`${http}/api/admin/recordings/${recording.id}/link`, { method: 'POST', headers: H })
  ).json();
  const replay = await (await fetch(`${http}/api/replay/${link.token}`)).json();
  const frames = String(replay.frames ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  check('replay fetch returns frames', frames.length > 10, String(frames.length));
  check('replay holds screen snapshots (seek points)', frames.some((f) => f.t === 'screen'));
  check(
    'replay holds origin-tagged key events',
    frames.some((f) => f.t === 'key' && f.by === 'bob') && frames.some((f) => f.t === 'key' && f.by === 'alice'),
    JSON.stringify(frames.filter((f) => f.t === 'key').slice(0, 4))
  );
  check('replay holds the assist grant', frames.some((f) => f.t === 'ctrl' && f.holder === 'bob'));
  check('replay holds the maintenance notice', frames.some((f) => f.t === 'notice' && String(f.message).includes('Backup window')));
  check('passwords never reached the recording', !String(replay.frames).includes('SECRETPW'));

  // Owner history + owner-minted links (edge identity as the only auth).
  const mine = await (await fetch(`${http}/api/recordings/mine`, { headers: { [IDENTITY_HEADER]: 'alice' } })).json();
  check('history lists the own recording', mine.recordings?.some((r) => r.id === recording.id), JSON.stringify(mine));
  const notMine = await (await fetch(`${http}/api/recordings/mine`, { headers: { [IDENTITY_HEADER]: 'mallory' } })).json();
  check('another identity sees none of it', (notMine.recordings ?? []).length === 0, JSON.stringify(notMine));
  const minted = await (
    await fetch(`${http}/api/replay/mint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [IDENTITY_HEADER]: 'alice' },
      body: JSON.stringify({ id: recording.id })
    })
  ).json();
  check('owner can mint a replay link', typeof minted.token === 'string', JSON.stringify(minted));
  check('minted link plays', (await fetch(`${http}/api/replay/${minted.token}`)).status === 200);
  const malloryMint = await fetch(`${http}/api/replay/mint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [IDENTITY_HEADER]: 'mallory' },
    body: JSON.stringify({ id: recording.id })
  });
  check('another identity cannot mint for it', malloryMint.status === 404);

  const revoked = await fetch(`${http}/api/admin/replay/${link.token}`, { method: 'DELETE', headers: H });
  check('admin can revoke a replay link', revoked.status === 200);
  check('revoked link is dead', (await fetch(`${http}/api/replay/${link.token}`)).status === 404);

  // ---------------------------------------------------------- 7. audit
  console.log('\n7. Audit trail');
  const audit = await (await fetch(`${http}/api/admin/audit?limit=200`, { headers: H })).json();
  const actions = new Set((audit.entries ?? []).map((e) => e.action));
  check(
    'audit records console, assist, maintenance and replay actions',
    ['session.signal', 'assist.request', 'assist.grant', 'assist.revoked', 'maintenance.on', 'maintenance.drain', 'replay.link', 'replay.revoke'].every((a) =>
      actions.has(a)
    ),
    JSON.stringify([...actions])
  );
  check(
    'assist actors are the edge identities',
    (audit.entries ?? []).some((e) => e.action === 'assist.grant' && e.actor === 'bob'),
    JSON.stringify((audit.entries ?? []).filter((e) => e.action.startsWith('assist.')))
  );

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('console test crashed:', err);
  process.exitCode = 1;
});
