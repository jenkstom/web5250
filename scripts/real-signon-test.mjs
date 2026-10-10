// Regression test: drives the built gateway against scripts/real-signon-host.mjs,
// which speaks the SF-order dialect real IBM i hosts use (no fabricated FFW
// bytes, WCC0 lock bits, IC + READ INPUT FIELDS in one chained record).
//
// Guards the exact symptoms seen against a live IBM i QDSIGNON:
//   - screen renders, cursor sits at first input cell (7,53)
//   - fields are enterable: typing lands, Tab advances to Password
//   - password stays non-display in the browser
//   - Enter transmits BOTH fields (host sees user+password, not CPF1296)
//   - 'screen' push carries the field layout for underline rendering
// Usage: npm run build && node scripts/real-signon-test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST_PORT = 18033;
const HTTP_PORT = 18081;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  [${cond ? 'ok' : 'FAIL'}] ${name}${cond ? '' : ' - ' + detail}`);
  if (!cond) failures++;
}

class Term {
  rows = 24;
  cols = 80;
  cells = [];
  cursor = [1, 1];
  oia = { lock: 'none', insert: false, messageWait: false, errorCode: false };
  fields = null;
  rawLog = [];
  apply(msg) {
    this.rawLog.push(JSON.stringify(msg));
    if (msg.t === 'screen') {
      this.rows = msg.rows;
      this.cols = msg.cols;
      this.cells = new Array(this.rows * this.cols).fill(' ');
      for (const [pos, , ch] of msg.cells) this.cells[pos] = String(ch ?? ' ');
      this.cursor = msg.cursor ?? this.cursor;
      if (Array.isArray(msg.fields)) this.fields = msg.fields;
    } else if (msg.t === 'update') {
      if (Array.isArray(msg.cells)) for (const [pos, , ch] of msg.cells) this.cells[pos] = String(ch ?? ' ');
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

async function waitFor(term, pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred(term)) return true;
    await sleep(60);
  }
  return false;
}

const procs = [];
process.on('exit', () => procs.forEach((p) => p.kill()));

async function main() {
  procs.push(spawn(process.execPath, ['scripts/real-signon-host.mjs', String(HOST_PORT)], { stdio: 'inherit' }));
  await sleep(300);
  procs.push(
    spawn(process.execPath, ['dist/server.js'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: String(HTTP_PORT),
        IBM_I_HOST: '127.0.0.1',
        IBM_I_PORT: String(HOST_PORT),
        IBM_I_DEV_PREFIX: 'REAL_',
        IBM_I_TERM_TYPE: 'IBM-3477-FC',
        IBM_I_CODEPAGE: 'cp037',
        ADMIN_PIN: '1234',
        WEB5250_DB: join(mkdtempSync(join(tmpdir(), 'web5250-real-')), 'menu.db')
      }
    })
  );
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${HTTP_PORT}/healthz`)).ok) break;
    } catch { /* not up */ }
    await sleep(200);
  }

  const ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/ws`);
  const term = new Term();
  ws.addEventListener('message', (ev) => term.apply(JSON.parse(String(ev.data))));
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });

  const key = (k, ch) => ws.send(JSON.stringify({ t: 'key', k, ch }));
  const type = (s) => { for (const ch of s) key('char', ch); };

  console.log('\n1. QDSIGNON renders with enterable fields');
  check('screen rendered', await waitFor(term, (t) => t.text().includes('SIGN ON') && t.text().includes('Password'), 8000, term.text().slice(0, 200)));
  check('cursor at User field (7,53)', term.cursor[0] === 7 && term.cursor[1] === 53, JSON.stringify(term.cursor));
  check('keyboard unlocked', await waitFor(term, (t) => t.oia.lock === 'none', 5000, JSON.stringify(term.oia)));
  check('field layout pushed for underlines', Array.isArray(term.fields) && term.fields.length === 2, JSON.stringify(term.fields));
  check('user field extent covers 10 data cells', term.fields?.[0]?.[1] === 10, JSON.stringify(term.fields?.[0]));

  console.log('\n2. Typing lands in the User field');
  type('TOMUSER');
  check('typed text visible', await waitFor(term, (t) => t.row(7).includes('TOMUSER'), 3000, `"${term.row(7)}"`));

  console.log('\n3. Tab advances into Password (bypass-poison regression)');
  key('tab');
  check('cursor moved to Password (8,53)', await waitFor(term, (t) => t.cursor[0] === 8 && t.cursor[1] === 53, 3000, JSON.stringify(term.cursor)));
  type('SECRETPW');
  await sleep(300);
  check('password hidden in browser', !term.text().includes('SECRETPW') && !term.rawLog.some((m) => m.includes('SECRETPW')));

  console.log('\n4. Enter transmits both fields');
  key('enter');
  const sawReply = await waitFor(term, (t) => t.row(24).includes('CPF1120'), 5000, `"${term.row(24)}"`);
  check('host accepted field data (CPF1120 wrong-password, NOT CPF1296)', sawReply, `"${term.row(24)}"`);
  check('session still alive after signon attempt', await waitFor(term, () => true, 100) && ws.readyState === WebSocket.OPEN);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  ws.close();
  await sleep(300);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
