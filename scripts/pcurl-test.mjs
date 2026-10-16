// STRPCCMD URL E2E: mock host + built gateway + a WS client. Covers the
// host->emulator PC command: a URI-bearing PCCMD arrives as an `openurl`
// WebSocket message (never painted on screen), the emulator's Enter
// completion lets the host continue (WAIT(*YES)), non-URI commands are
// ignored, and read-only mirrors never receive the URL.
//
// Usage: npm run build && npm run test:pcuri
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MOCK_PORT = 18223;
const HTTP_PORT = 18280;

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

class Term {
  rows = 24;
  cols = 80;
  cells = [];
  cursor = [1, 1];
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

function wsTerm(query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/ws${query}`);
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
        SESSION_GRACE_MS: '0',
        WEB5250_DB: join(mkdtempSync(join(tmpdir(), 'web5250-pcuri-')), 'menu.db')
      }
    })
  );
  if (!(await waitHealthy())) {
    console.error('gateway never became healthy');
    process.exit(1);
  }

  const { ws, term, opened } = wsTerm();
  await opened;
  const send = (msg) => ws.send(JSON.stringify(msg));
  const key = (k, ch) => send({ t: 'key', k, ch });
  const type = (s) => {
    for (const ch of s) key('char', ch);
  };
  const openurls = () => term.rawLog.filter((m) => m.includes('"openurl"'));

  console.log('\n1. Sign on to the MAIN menu');
  check(
    'sign-on screen rendered',
    await waitFor(() => term.text().includes('AS/400 Sign On'), 8000, term.text().slice(0, 200))
  );
  type('MOCKUSER');
  key('tab');
  type('SECRETPW');
  key('enter');
  check(
    'MAIN menu rendered with the STRPCCMD options',
    await waitFor(
      () => term.text().includes('IBM i Main Menu') && term.text().includes('96. Open a web page'),
      8000,
      term.text().slice(0, 300)
    )
  );

  // A read-only mirror: it must never be told to open windows.
  const shareToken = (() => {
    for (const m of term.rawLog) {
      const msg = JSON.parse(m);
      if (msg.t === 'hello' && typeof msg.shareToken === 'string') return msg.shareToken;
    }
    return null;
  })();
  check('hello carried a share token', Boolean(shareToken));
  const mirror = shareToken ? wsTerm(`?view=${shareToken}`) : null;
  if (mirror) await mirror.opened;
  await sleep(400); // let the mirror catch up to the current screen

  console.log('\n2. Option 96: STRPCCMD with a URL (WAIT(*YES))');
  key('char', '9');
  key('char', '6');
  key('enter');
  check(
    'openurl message arrived with the exact URI',
    await waitFor(() => openurls().some((m) => m.includes('http://mock.example/report?from=menu')), 8000, JSON.stringify(openurls()))
  );
  check('only one openurl so far', openurls().length === 1, String(openurls().length));
  check(
    'host continued after the Enter completion (menu redrawn)',
    await waitFor(() => term.text().includes('IBM i Main Menu'), 8000, term.text().slice(0, 200))
  );
  await sleep(600); // any painting of the carrier would have arrived by now
  const painted = term.text();
  check('the URI never appears on the screen', !painted.includes('mock.example'), painted.slice(0, 200));
  check('the PCO magic never appears on the screen', !painted.includes('PCO'), painted.slice(0, 200));
  if (mirror) {
    check('the read-only mirror got no openurl', !mirror.term.rawLog.some((m) => m.includes('"openurl"')));
  }

  console.log('\n3. Option 97: STRPCCMD without a URL is ignored');
  const before = openurls().length;
  key('char', '9');
  key('char', '7');
  key('enter');
  await sleep(1500);
  check('no openurl for a non-URI command', openurls().length === before, String(openurls().length));
  check(
    'menu redrawn all the same (Enter completion)',
    await waitFor(() => term.text().includes('IBM i Main Menu'), 8000, term.text().slice(0, 200))
  );
  check('notepad never appears on the screen', !term.text().includes('notepad'));

  console.log('\n4. Session still healthy');
  key('pf3');
  check(
    'sign off completed',
    await waitFor(() => term.text().includes('Sign off completed'), 8000, term.text().slice(0, 200))
  );

  ws.close();
  mirror?.ws.close();
  await sleep(400);

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
