// Cursor-key navigation on option-column lists (WRK-style screens):
// Up/Down must walk the option fields line by line, Right must leave the
// field, and an option typed after walking must land on the right line.
// Usage: npm run build && node scripts/list-nav-test.mjs
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const MOCK_PORT = 18023;
const HTTP_PORT = 18097;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  [${cond ? 'ok' : 'FAIL'}] ${name}${cond ? '' : ' - ' + detail}`);
  if (!cond) failures++;
};
const procs = [];
process.on('exit', () => procs.forEach((p) => p.kill()));

procs.push(spawn(process.execPath, ['dist/mock-host.mjs', String(MOCK_PORT)], { stdio: 'inherit' }));
await sleep(300);
procs.push(
  spawn(process.execPath, ['dist/server.js'], {
    stdio: 'inherit',
    env: { ...process.env, PORT: String(HTTP_PORT), IBM_I_HOST: '127.0.0.1', IBM_I_PORT: String(MOCK_PORT), WEB5250_DB: '/tmp/web5250-list.db' }
  })
);
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${HTTP_PORT}/healthz`)).ok) break;
  } catch {}
  await sleep(200);
}

// Minimal terminal model over the gateway WS (same protocol the browser speaks).
class Term {
  rows = 24;
  cols = 80;
  cells = [];
  cursor = [1, 1];
  constructor(ws) {
    this.ws = ws;
    ws.on('message', (d) => {
      const msg = JSON.parse(String(d));
      if (msg.t === 'screen') {
        this.rows = msg.rows;
        this.cols = msg.cols;
        this.cells = new Array(this.rows * this.cols).fill(' ');
        for (const [pos, , ch] of msg.cells) this.cells[pos] = String(ch ?? ' ');
        this.cursor = msg.cursor ?? this.cursor;
      } else if (msg.t === 'update') {
        for (const [pos, , ch] of msg.cells ?? []) this.cells[pos] = String(ch ?? ' ');
        if (Array.isArray(msg.cursor)) this.cursor = msg.cursor;
      }
    });
  }
  key(k, ch) {
    this.ws.send(JSON.stringify(ch === undefined ? { t: 'key', k } : { t: 'key', k, ch }));
  }
  text() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      out.push(this.cells.slice(r * this.cols, (r + 1) * this.cols).join('').replace(/\s+$/, ''));
    }
    return out.join('\n');
  }
}

async function waitIdle(term, pred, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred(term)) return true;
    await sleep(60);
  }
  console.log(`  (timeout waiting for ${what}; screen:\n${term.text()}\n)`);
  return false;
}
const has = (term, s) => term.text().includes(s);

const ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/ws`);
const term = new Term(ws);
await new Promise((r) => ws.on('open', r));

check('sign-on screen arrived', await waitIdle(term, (t) => has(t, 'Sign On'), 'sign-on'));
term.key('char', 'LISTUSER');
term.key('tab');
term.key('char', 'PW');
term.key('enter');
check('MAIN menu arrived', await waitIdle(term, (t) => has(t, 'Main Menu'), 'main menu'));

// Open the option list (menu selection 4).
term.key('char', '4');
term.key('enter');
check('list screen arrived', await waitIdle(term, (t) => has(t, 'WORK WITH DEMO ITEMS'), 'list'));
check('cursor homes into first option field', term.cursor.join(',') === '7,8', term.cursor.join(','));

// Up/Down walk the option column line by line.
term.key('down');
await sleep(150);
check('Down -> line 2 option field', term.cursor.join(',') === '8,8', term.cursor.join(','));
for (const r of [9, 10]) {
  term.key('down');
  await sleep(150);
  check(`Down -> row ${r}`, term.cursor[0] === r && term.cursor[1] === 8, term.cursor.join(','));
}
term.key('up');
await sleep(150);
check('Up goes back a line', term.cursor.join(',') === '9,8', term.cursor.join(','));

// Right advances within the 2-cell option field, then steps off the field
// entirely (old code clamped the cursor inside the current field).
term.key('right');
await sleep(150);
check('Right within the option field', term.cursor.join(',') === '9,9', term.cursor.join(','));
term.key('right');
await sleep(150);
check('Right leaves the option field', term.cursor[0] === 9 && term.cursor[1] === 10, term.cursor.join(','));

// Walking past the last option line keeps moving (free cursor, column kept).
term.key('down'); term.key('down'); term.key('down'); term.key('down'); term.key('down');
term.key('down'); term.key('down'); term.key('down'); term.key('down'); // row 9 -> 18
await sleep(250);
check('Down past the list still moves the cursor', term.cursor[0] === 18 && term.cursor[1] === 10, term.cursor.join(','));

// Home + Down: deterministic walk to line 4 (row 10). Type an option there,
// move away, Enter - the option must be attributed to line 4, proving the
// cursor walk parked in the right field.
term.key('home');
await sleep(150);
check('Home returns to the first option field', term.cursor.join(',') === '7,8', term.cursor.join(','));
term.key('down'); term.key('down'); term.key('down');
await sleep(250);
check('walked to row 10', term.cursor[0] === 10 && term.cursor[1] === 8, term.cursor.join(','));
term.key('char', '2');
term.key('down'); // leave the field, option stays on line 4
term.key('enter');
check(
  'option typed on the walked-to line reached the host',
  await waitIdle(term, (t) => has(t, 'Option 2 entered on line 4'), 'status line'),
  term.text().split('\n')[21] ?? ''
);

// F3 exits the list back to the menu.
term.key('pf3');
check('F3 returns to the menu', await waitIdle(term, (t) => has(t, 'Main Menu'), 'main menu'));

ws.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
