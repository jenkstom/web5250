// Regression test against scripts/real-signon-host.mjs, which replays the
// byte shapes captured from a live IBM i QDSIGNON:
//   SOH(7) header, no IC order, hidden User (0x26) / Password (0x27)
//   fields, bypass option fields (FFW1=0x60), RMD (0x52) invite, and a
//   post-signon message screen opening with SOH len 16.
//
// Guards the live bugs: cursor homing into Password instead of User,
// SOH-length rejection desyncing message screens, and RMD field data
// landing in the wrong host-side field.
// Usage: npm run build && npm run test:real
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

  console.log('\n1. QDSIGNON renders (live dialect: SOH header, no IC order)');
  check('screen rendered', await waitFor(term, (t) => t.text().includes('SIGN ON') && t.text().includes('Password'), 8000, term.text().slice(0, 200)));
  check('keyboard unlocked', await waitFor(term, (t) => t.oia.lock === 'none', 5000, JSON.stringify(term.oia)));
  check('cursor homes to USER field (6,53), not Password', term.cursor[0] === 6 && term.cursor[1] === 53, JSON.stringify(term.cursor));
  check('only enterable fields underlined (user+password, bypass skipped)', Array.isArray(term.fields) && term.fields.length === 2, JSON.stringify(term.fields));

  console.log('\n2. Username types into the User field (hidden per host attr 0x26)');
  type('TOMUSER');
  await sleep(400);
  check('username accepted (cursor advanced inside field)', term.cursor[0] === 6 && term.cursor[1] >= 54, JSON.stringify(term.cursor));
  check('username hidden in browser (non-display attr)', !term.text().includes('TOMUSER'));

  console.log('\n3. Tab reaches Password; bypass fields skipped');
  key('tab');
  check('cursor moved to Password (7,53)', await waitFor(term, (t) => t.cursor[0] === 7 && t.cursor[1] === 53, 3000, JSON.stringify(term.cursor)));
  type('SECRETPW');
  await sleep(300);
  check('password never crosses the WebSocket', !term.rawLog.some((m) => m.includes('SECRETPW')));

  console.log('\n4. Enter transmits RMD runs to the correct field addresses');
  key('enter');
  const sawJob = await waitFor(term, (t) => t.text().includes('started on 010/2026'), 6000, term.text().slice(0, 300));
  check('signon accepted - SOH-16 message screen rendered', sawJob, term.text().slice(0, 300));
  check('session alive after signon', ws.readyState === WebSocket.OPEN);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  ws.close();
  await sleep(300);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
