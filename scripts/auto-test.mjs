// End-to-end test for automated data-entry launches (?auto=1):
//   1. Happy path: gateway signs on with AUTO_SIGNON_USER/AUTO_SIGNON_PASSWORD,
//      waits for the "initial program" screen (the mock's MAIN menu), types
//      the input string + Enter, hands over; PF3 "exit" → host sign-off →
//      session teardown.
//   2. Sign-on rejection: host redraws QDSIGNON → `auto ended` with
//      reason signon-failed + teardown.
//   3. Unconfigured gateway: auto upgrade refused with 403.
//
// Usage: npm run build && npm run test:auto
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MOCK_PORT = 18043; // accepts the configured sign-on
const MOCK_REJECT_PORT = 18044; // MOCK_SIGNON_REJECT=1: refuses every sign-on
const HTTP_PORT = 18090; // gateway WITH auto credentials
const HTTP_PLAIN_PORT = 18091; // gateway WITHOUT auto credentials
const AUTO_USER = 'AUTOBOT';
const AUTO_PW = 'SECRETPW';

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

// ------------------------------------------------------------- terminal model
class Term {
  rows = 24;
  cols = 80;
  cells = [];
  cursor = [1, 1];
  oia = { lock: 'none', insert: false, messageWait: false, errorCode: false };
  rawLog = [];
  autoMsgs = [];
  statuses = [];

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
    } else if (msg.t === 'auto') {
      this.autoMsgs.push(msg);
    } else if (msg.t === 'status') {
      this.statuses.push(msg.status);
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

async function main() {
  console.log('Starting mock hosts and gateways...');
  procs.push(spawn(process.execPath, ['scripts/mock-host.mjs', String(MOCK_PORT)], { stdio: 'inherit' }));
  procs.push(
    spawn(process.execPath, ['scripts/mock-host.mjs', String(MOCK_REJECT_PORT)], {
      stdio: 'inherit',
      env: { ...process.env, MOCK_SIGNON_REJECT: '1' }
    })
  );
  await sleep(300);
  const baseEnv = {
    ...process.env,
    IBM_I_HOST: '127.0.0.1',
    IBM_I_PORT: String(MOCK_PORT),
    IBM_I_DEV_PREFIX: 'AUTO_',
    IBM_I_TERM_TYPE: 'IBM-3477-FC',
    IBM_I_CODEPAGE: 'cp037',
    ALLOW_CUSTOM_HOST: '1'
  };
  procs.push(
    spawn(process.execPath, ['dist/server.js'], {
      stdio: 'inherit',
      env: {
        ...baseEnv,
        PORT: String(HTTP_PORT),
        AUTO_SIGNON_USER: AUTO_USER,
        AUTO_SIGNON_PASSWORD: AUTO_PW,
        WEB5250_DB: join(mkdtempSync(join(tmpdir(), 'web5250-auto-')), 'menu.db')
      }
    })
  );
  procs.push(
    spawn(process.execPath, ['dist/server.js'], {
      stdio: 'inherit',
      env: {
        ...baseEnv,
        PORT: String(HTTP_PLAIN_PORT),
        WEB5250_DB: join(mkdtempSync(join(tmpdir(), 'web5250-plain-')), 'menu.db')
      }
    })
  );
  if (!(await waitHealthy(HTTP_PORT)) || !(await waitHealthy(HTTP_PLAIN_PORT))) {
    console.error('gateways never became healthy');
    process.exit(1);
  }

  // ------------------------------------------------ 1. happy path
  console.log('\n1. Automated launch (sign-on, input string, hand over)');
  const s = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?auto=1&input=Q7&inputenter=0&inputdelay=500`);
  check(
    'auto started announced',
    await waitFor(s.term, (t) => t.autoMsgs.some((m) => m.phase === 'started'), 5000),
    JSON.stringify(s.term.autoMsgs)
  );
  check(
    'signed on automatically (MAIN menu as configured user)',
    await waitFor(
      s.term,
      (t) => t.text().includes('IBM i Main Menu') && t.text().includes(`Signed on as ${AUTO_USER}`),
      10000,
      s.term.text().slice(0, 300)
    )
  );
  check(
    'input string typed into the screen (no Enter: inputenter=0)',
    // Q7 is not on any mock screen, so its appearance proves injection.
    await waitFor(s.term, (t) => t.text().includes('Q7'), 6000),
    s.term.text().slice(0, 300)
  );
  check('automation armed (no end message)', !s.term.autoMsgs.some((m) => m.phase === 'ended'));
  check('password never crosses the WebSocket', !s.term.rawLog.some((m) => m.includes(AUTO_PW)));

  console.log('\n2. Program exit closes the session');
  s.sock.send(JSON.stringify({ t: 'key', k: 'pf3' }));
  check(
    'host drop reported as status closed',
    await waitFor(s.term, (t) => t.statuses.includes('closed'), 10000),
    JSON.stringify(s.term.statuses)
  );
  check('browser socket closed after exit', (await Promise.race([s.closed, sleep(4000).then(() => null)])) !== null);

  // --------------------------------- 2b. default Enter after the input string
  console.log('\n2b. inputenter default submits the string');
  // 90 = the mock's "Sign off" selection: proves the injected Enter carried
  // the injected value to the host (sign-off screen, then the drop).
  const e = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?auto=1&input=90&inputdelay=500`);
  check(
    'injected Enter submits (sign-off screen appears)',
    await waitFor(e.term, (t) => t.text().includes('Sign off completed'), 10000),
    e.term.text().slice(0, 300)
  );
  check(
    'host drop reported as status closed',
    await waitFor(e.term, (t) => t.statuses.includes('closed'), 10000),
    JSON.stringify(e.term.statuses)
  );
  check('browser socket closed', (await Promise.race([e.closed, sleep(4000).then(() => null)])) !== null);

  // ------------------------------------------------ 3. sign-on rejected
  console.log('\n3. Sign-on rejection ends the launch');
  const r = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?auto=1&host=127.0.0.1&port=${MOCK_REJECT_PORT}`);
  check(
    'auto ended with reason signon-failed',
    await waitFor(
      r.term,
      (t) => t.autoMsgs.some((m) => m.phase === 'ended' && m.reason === 'signon-failed'),
      10000
    ),
    JSON.stringify(r.term.autoMsgs)
  );
  check('browser socket closed after rejection', (await Promise.race([r.closed, sleep(4000).then(() => null)])) !== null);

  // ------------------------------------------------ 4. unconfigured gateway
  console.log('\n4. Auto launch without configured credentials is refused');
  const refused = new WebSocket(`ws://127.0.0.1:${HTTP_PLAIN_PORT}/ws?auto=1`);
  let refusedClosed = false;
  await new Promise((resolve) => {
    refused.addEventListener('close', () => {
      refusedClosed = true;
      resolve();
    });
    refused.addEventListener('error', () => resolve()); // 403 surfaces as error too
    refused.addEventListener('open', () => resolve()); // must NOT happen; resolve to fail fast below
  });
  check('upgrade rejected (no session opened)', refusedClosed && refused.readyState === WebSocket.CLOSED);

  // ------------------------------------------------ 5. manual sessions unaffected
  console.log('\n5. Manual session on the same gateway still works');
  const m = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws`);
  check(
    'manual sign-on screen rendered, keyboard free',
    await waitFor(m.term, (t) => t.text().includes('AS/400 Sign On') && t.oia.lock === 'none', 8000),
    m.term.text().slice(0, 200)
  );
  check('no automation messages on manual sessions', m.term.autoMsgs.length === 0);
  m.sock.close();
  await sleep(300);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('auto test crashed:', err);
  process.exitCode = 1;
});
