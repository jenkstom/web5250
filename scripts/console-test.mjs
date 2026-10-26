// End-to-end test for the session console, maintenance windows, remote
// assist, and session recording/replay: mock IBM i host + built gateway +
// WebSocket clients that drive sessions like browsers would, including the
// edge-identity header (TRUSTED_USER_HEADER) the console keys on.
//
// Usage: npm run build && npm run test:console
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  check(
    'hello offers recording without starting it',
    owner.hello?.recording === false && owner.hello?.recordingAllowed === true,
    JSON.stringify(owner.hello?.recording)
  );

  // Recording is owner-initiated: start it before the sign-on typing so the
  // replay captures the whole flow.
  owner.sock.send(JSON.stringify({ t: 'recstart' }));
  check(
    'owner starts the recording (REC on)',
    await waitFor(() => owner.has((m) => m.t === 'recstate' && m.recording === true), 5000)
  );

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

  // ------------------------------------------------ 6b. recording removal
  console.log('\n6b. Console removes recordings (live and finished)');
  // Live first: carol connects, starts and stops her own recording (that
  // finalizes one), starts again, and the console deletes it while live.
  const carol = await openClient(`ws://127.0.0.1:${HTTP_PORT}/ws?system=${sysId}&devname=DELREC`, 'carol');
  check(
    'carol can record but is not recorded yet',
    carol.hello?.recording === false && carol.hello?.recordingAllowed === true,
    JSON.stringify(carol.hello?.recording)
  );
  carol.sock.send(JSON.stringify({ t: 'recstart' }));
  carol.sock.send(JSON.stringify({ t: 'recstop' }));
  check(
    'owner stop clears the REC state',
    await waitFor(() => carol.has((m) => m.t === 'recstate' && m.recording === false), 5000)
  );
  let stoppedRec = null;
  check(
    'stopped recording finalizes in the list',
    await waitFor(async () => {
      const rows = (await (await fetch(`${http}/api/admin/recordings`, { headers: H })).json()).recordings;
      stoppedRec = rows.find((r) => r.identity === 'carol' && r.endedAt !== null) ?? null;
      return stoppedRec !== null;
    }, 8000)
  );
  carol.sock.send(JSON.stringify({ t: 'recstart' }));
  let liveRec = null;
  check(
    'live recording appears in the console list',
    await waitFor(async () => {
      const rows = (await (await fetch(`${http}/api/admin/recordings`, { headers: H })).json()).recordings;
      liveRec = rows.find((r) => r.identity === 'carol' && r.endedAt === null) ?? null;
      return liveRec !== null;
    }, 8000)
  );
  const delLive = await fetch(`${http}/api/admin/recordings/${liveRec.id}`, { method: 'DELETE', headers: H });
  check('console can delete a live recording', delLive.status === 200);
  check(
    'owner is told the recording stopped',
    await waitFor(() => carol.has((m) => m.t === 'recstate' && m.recording === false), 5000)
  );
  check(
    'deleted live recording leaves the list',
    await waitFor(async () => {
      const rows = (await (await fetch(`${http}/api/admin/recordings`, { headers: H })).json()).recordings;
      return !rows.some((r) => r.id === liveRec.id);
    }, 5000)
  );
  carol.sock.close();

  // Finished: the alice recording (with a live replay token) dies completely.
  const delDone = await fetch(`${http}/api/admin/recordings/${recording.id}`, { method: 'DELETE', headers: H });
  check('console can delete a finished recording', delDone.status === 200);
  check(
    'finished recording leaves the list',
    await waitFor(async () => {
      const rows = (await (await fetch(`${http}/api/admin/recordings`, { headers: H })).json()).recordings;
      return !rows.some((r) => r.id === recording.id);
    }, 5000)
  );
  check('deleted recording download 404s', (await fetch(`${http}/api/admin/recordings/${recording.id}/download`, { headers: H })).status === 404);
  check('minting for a deleted recording 404s', (await fetch(`${http}/api/admin/recordings/${recording.id}/link`, { method: 'POST', headers: H })).status === 404);
  check('existing replay links die with it', (await fetch(`${http}/api/replay/${minted.token}`)).status === 404);
  const delAgain = await fetch(`${http}/api/admin/recordings/${recording.id}`, { method: 'DELETE', headers: H });
  check('deleting a gone recording is a JSON 404', delAgain.status === 404);
  const delNoAuth = await fetch(`${http}/api/admin/recordings/${recording.id}`, { method: 'DELETE' });
  check('recording delete requires the admin token', delNoAuth.status === 401);

  // ---------------------------------------------------------- 7. audit
  console.log('\n7. Audit trail');
  const audit = await (await fetch(`${http}/api/admin/audit?limit=200`, { headers: H })).json();
  const actions = new Set((audit.entries ?? []).map((e) => e.action));
  check(
    'audit records console, assist, maintenance and replay actions',
    ['session.signal', 'assist.request', 'assist.grant', 'assist.revoked', 'maintenance.on', 'maintenance.drain', 'replay.link', 'replay.revoke', 'recording.delete', 'recording.start', 'recording.stop'].every((a) =>
      actions.has(a)
    ),
    JSON.stringify([...actions])
  );
  check(
    'assist actors are the edge identities',
    (audit.entries ?? []).some((e) => e.action === 'assist.grant' && e.actor === 'bob'),
    JSON.stringify((audit.entries ?? []).filter((e) => e.action.startsWith('assist.')))
  );

  // ------------------------- 8. consent policy + break-glass session end
  console.log('\n8. Consent policy and break-glass session end');
  // Two small gateways with opposite consent policies; the second also
  // enables break-glass so its takeover can end the whole session.
  const policyGw = async (port, db, extra) => {
    procs.push(spawn(process.execPath, ['dist/server.js'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: String(port),
        IBM_I_HOST: '127.0.0.1',
        IBM_I_PORT: String(MOCK_PORT),
        IBM_I_DEV_PREFIX: 'POL_',
        IBM_I_TERM_TYPE: 'IBM-3477-FC',
        IBM_I_CODEPAGE: 'cp037',
        ADMIN_PIN,
        TRUSTED_USER_HEADER: IDENTITY_HEADER,
        ASSIST_CONSENT_TIMEOUT_MS: '5000',
        SESSION_GRACE_MS: '20000',
        WEB5250_DB: join(dataDir, db),
        ...extra
      }
    }));
    if (!(await waitHealthy(port))) throw new Error(`policy gateway on ${port} never became healthy`);
    const auth = await (
      await fetch(`http://127.0.0.1:${port}/api/admin/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: ADMIN_PIN }) })
    ).json();
    const sysId = (await (await fetch(`http://127.0.0.1:${port}/api/systems`)).json()).systems[0].id;
    return { auth: auth.token, sysId };
  };

  const auditOf = async (port, token) =>
    (await (await fetch(`http://127.0.0.1:${port}/api/admin/audit?limit=50`, { headers: { authorization: `Bearer ${token}` } })).json()).entries ?? [];

  // deny: an unanswered request is declined at the timeout.
  const g2 = await policyGw(HTTP_PORT + 1, 'policy-deny.db', { ASSIST_CONSENT_DEFAULT: 'deny' });
  const oscar = await openClient(`ws://127.0.0.1:${HTTP_PORT + 1}/ws?system=${g2.sysId}&devname=POLICY`, 'oscar');
  check('policy owner connected', await waitFor(() => oscar.text().includes('Sign On'), 8000));
  const deb = await openClient(`ws://127.0.0.1:${HTTP_PORT + 1}/ws?view=${oscar.hello.shareToken}`, 'deb');
  await sleep(300);
  deb.sock.send(JSON.stringify({ t: 'ctrlrequest' }));
  check(
    'deny policy declines the unanswered request',
    await waitFor(() => deb.has((m) => m.t === 'ctrlreply' && m.ok === false && m.reason === 'timeout'), 9000)
  );
  check('deny policy grants nothing', !deb.has((m) => m.t === 'ctrlreply' && m.ok === true));
  check('deny timeout is audited', (await auditOf(HTTP_PORT + 1, g2.auth)).some((e) => e.action === 'assist.timeout'));
  oscar.sock.close();
  deb.sock.close();

  // allow + break-glass: silence grants control; the takeover's End closes
  // the whole session - the owner's socket and the takeover both die.
  const g3 = await policyGw(HTTP_PORT + 3, 'policy-allow.db', {
    ASSIST_CONSENT_DEFAULT: 'allow',
    ADMIN_ASSIST_BREAKGLASS: '1'
  });
  const vera = await openClient(`ws://127.0.0.1:${HTTP_PORT + 3}/ws?system=${g3.sysId}&devname=ALLOWED`, 'vera');
  check('allow owner connected', await waitFor(() => vera.text().includes('Sign On'), 8000));
  const adm = await openClient(`ws://127.0.0.1:${HTTP_PORT + 3}/ws?view=${vera.hello.shareToken}`, 'deb');
  await sleep(300);
  adm.sock.send(JSON.stringify({ t: 'ctrlrequest' }));
  check(
    'allow policy auto-grants the unanswered request',
    await waitFor(() => adm.has((m) => m.t === 'ctrlreply' && m.ok === true), 9000),
    JSON.stringify(adm.msgs.filter((m) => m.t === 'ctrlreply'))
  );
  check('auto-grant is audited', (await auditOf(HTTP_PORT + 3, g3.auth)).some((e) => e.action === 'assist.auto-grant'));

  // break-glass on a fresh session: instant control, End closes everything.
  const vera2 = await openClient(`ws://127.0.0.1:${HTTP_PORT + 3}/ws?system=${g3.sysId}&devname=BREAKGLS`, 'vera');
  check('second owner connected', await waitFor(() => vera2.text().includes('Sign On'), 8000));
  const adm2 = await openClient(`ws://127.0.0.1:${HTTP_PORT + 3}/ws?view=${vera2.hello.shareToken}`, 'deb');
  await sleep(300);
  adm2.sock.send(JSON.stringify({ t: 'ctrlrequest', adminToken: g3.auth }));
  check(
    'break-glass grants control immediately',
    await waitFor(() => adm2.has((m) => m.t === 'ctrlreply' && m.ok === true && m.breakglass === true), 5000)
  );
  key(adm2.sock, 'f3');
  await sleep(200);
  adm2.sock.send(JSON.stringify({ t: 'end' }));
  check(
    'admin End closes the owner session',
    await waitFor(() => vera2.has((m) => m.t === 'status' && m.status !== 'connected'), 8000)
  );
  check(
    'admin End closes the takeover too',
    await waitFor(() => adm2.closed || adm2.has((m) => m.t === 'status' && m.status !== 'connected'), 8000)
  );
  check(
    'takeover end is audited as the admin',
    (await auditOf(HTTP_PORT + 3, g3.auth)).some(
      (e) => e.action === 'session.end' && e.actor === 'deb' && String(e.detail).includes('break-glass')
    )
  );
  vera.sock.close();
  vera2.sock.close();

  // ---------------------------------------------------- 9. storage retention
  // Everything on the data volume ages out at 30 days by default: audit rows,
  // recording rows/files, spool-job files. Seed a DB with data the way a
  // 40-day-old crashed instance would have left it and check the boot sweep.
  console.log('\n9. Storage retention (30-day default)');
  {
    const DAY = 24 * 60 * 60 * 1000;
    const old = Date.now() - 40 * DAY;
    const fresh = Date.now() - 60 * 1000;
    const retDb = join(dataDir, 'retention.db');
    const oldEndedId = 'a'.repeat(32); // ended long ago: row + file swept
    const oldLiveId = 'b'.repeat(32); // crash-orphaned live row, stale file
    const freshLiveId = 'c'.repeat(32); // crash-orphaned live row, fresh file
    const orphanId = 'd'.repeat(32); // file with no metadata row at all
    const seed = new DatabaseSync(retDb);
    seed.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        ts     INTEGER NOT NULL,
        actor  TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS recordings (
        id              TEXT PRIMARY KEY,
        system_id       INTEGER NOT NULL,
        system_name     TEXT NOT NULL,
        dev_name        TEXT,
        identity        TEXT,
        signed_on_user  TEXT,
        started_at      INTEGER NOT NULL,
        ended_at        INTEGER,
        bytes           INTEGER NOT NULL DEFAULT 0,
        frames          INTEGER NOT NULL DEFAULT 0,
        seq             INTEGER NOT NULL
      );
    `);
    const insAudit = seed.prepare('INSERT INTO audit (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)');
    insAudit.run(old, 'seed', 'assist.grant', 'OLD', 'past the TTL');
    insAudit.run(fresh, 'seed', 'assist.grant', 'KEEP', 'inside the TTL');
    const insRec = seed.prepare(
      'INSERT INTO recordings (id, system_id, system_name, started_at, ended_at, seq) VALUES (?, 7, ?, ?, ?, ?)'
    );
    insRec.run(oldEndedId, 'OLDENDED', old, old, 1);
    insRec.run(oldLiveId, 'OLDLIVE', old, null, 2);
    insRec.run(freshLiveId, 'FRESHLIVE', fresh, null, 3);
    seed.close();

    const recDir = join(dataDir, 'recordings');
    mkdirSync(recDir, { recursive: true });
    for (const [id, ts] of [
      [oldEndedId, old],
      [oldLiveId, old],
      [freshLiveId, fresh],
      [orphanId, fresh]
    ]) {
      const file = join(recDir, `${id}.jsonl`);
      writeFileSync(file, '{"t":"screen"}\n');
      utimesSync(file, new Date(ts), new Date(ts));
    }
    // Spool files recover from disk by name+mtime, so they exercise the
    // printer TTL without any DB seeding.
    const jobDir = join(dataDir, 'printjobs', '7');
    mkdirSync(jobDir, { recursive: true });
    const oldJob = join(jobDir, `${'e'.repeat(32)}.txt`);
    const freshJob = join(jobDir, `${'f'.repeat(32)}.txt`);
    for (const [file, ts] of [[oldJob, old], [freshJob, fresh]]) {
      writeFileSync(file, 'SPOOL REPORT\n');
      utimesSync(file, new Date(ts), new Date(ts));
    }

    const RET_PORT = HTTP_PORT + 5;
    procs.push(
      spawn(process.execPath, ['dist/server.js'], {
        stdio: 'inherit',
        env: {
          ...process.env,
          PORT: String(RET_PORT),
          IBM_I_HOST: '127.0.0.1',
          IBM_I_PORT: String(MOCK_PORT),
          ADMIN_PIN,
          WEB5250_DB: retDb
        }
      })
    );
    check('retention gateway healthy', await waitHealthy(RET_PORT));

    const after = new DatabaseSync(retDb);
    const auditDetails = new Set(
      after.prepare('SELECT detail FROM audit').all().map((r) => String(r.detail))
    );
    check('audit rows past the TTL are pruned at boot', !auditDetails.has('past the TTL'));
    check('audit rows inside the TTL survive', auditDetails.has('inside the TTL'));
    const recIds = new Map(
      after.prepare('SELECT id, ended_at FROM recordings').all().map((r) => [String(r.id), r.ended_at])
    );
    check('TTL-expired recording row is swept', !recIds.has(oldEndedId));
    check('crash-orphaned stale recording is finalized then swept', !recIds.has(oldLiveId));
    check(
      'crash-orphaned fresh recording is finalized, not swept',
      recIds.has(freshLiveId) && recIds.get(freshLiveId) !== null,
      JSON.stringify([...recIds])
    );
    after.close();
    check('kept recording file survives its sweep', existsSync(join(recDir, `${freshLiveId}.jsonl`)));
    check('recording file with no metadata row is removed', !existsSync(join(recDir, `${orphanId}.jsonl`)));
    check('recording file of a swept row is removed', !existsSync(join(recDir, `${oldEndedId}.jsonl`)));
    check('TTL-expired spool job file is swept at boot', !existsSync(oldJob));
    check('fresh spool job file survives', existsSync(freshJob));
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('console test crashed:', err);
  process.exitCode = 1;
});
