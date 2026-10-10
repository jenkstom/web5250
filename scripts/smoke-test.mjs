// End-to-end smoke test: mock IBM i host + built gateway + a WebSocket
// client that drives the terminal like a browser would.
//
// Usage: npm run build && npm run smoke
import { spawn } from 'node:child_process';

const MOCK_PORT = 18023;
const HTTP_PORT = 18080;

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
        IBM_I_CODEPAGE: 'cp037'
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

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exitCode = 1;
});
