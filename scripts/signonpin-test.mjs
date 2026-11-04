// End-to-end test for the sign-on protection PIN (admin Settings tab):
//   A. API/WS level - the gate's behaviour on the wire
//      1. unarmed: a stored-credential system signs on automatically
//      2. armed: no ticket -> manual sign-on screen + "skipped" notice
//      3. ticket exchange: wrong PIN 401, right PIN -> one automatic sign-on
//      4. tickets are single-use
//      5. ?auto=1 launches (shared AUTO_SIGNON_* account) are exempt
//   B. UI level (headless Chromium) - the dialog users see
//      1. opening the system asks; wrong PIN errors without connecting
//      2. "Sign on myself" connects with the skipped notice
//      3. correct PIN signs on automatically; a second connect in the same
//         page doesn't ask again (the PIN is remembered per page)
//   C. repeated wrong PINs lock the exchange briefly; clearing the gate
//      restores unarmed behaviour.
//
// Usage: npm run build && npm run test:signonpin
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const MOCK_PORT = 18053;
const HTTP_PORT = 18100;
const ADMIN_PIN = '1234';
const SIGNON_PIN = '9988';
const STORED_USER = 'STOREDU';
const STORED_PW = 'STOREDPW';
const AUTO_USER = 'AUTOBOT';
const AUTO_PW = 'AUTOPW';

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

const http = async (method, path, body, token) => {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

// ------------------------------------------------------------- terminal model
class Term {
  rows = 24;
  cols = 80;
  cells = [];
  cursor = [1, 1];
  autoMsgs = [];
  statuses = [];
  notices = [];

  apply(msg) {
    if (msg.t === 'screen') {
      this.rows = msg.rows;
      this.cols = msg.cols;
      this.cells = new Array(this.rows * this.cols).fill(' ');
      for (const [pos, , ch] of msg.cells) this.cells[pos] = String(ch ?? ' ');
    } else if (msg.t === 'update') {
      if (Array.isArray(msg.cells)) {
        for (const [pos, , ch] of msg.cells) this.cells[pos] = String(ch ?? ' ');
      }
    } else if (msg.t === 'auto') {
      this.autoMsgs.push(msg);
    } else if (msg.t === 'status') {
      this.statuses.push(msg.status);
    } else if (msg.t === 'notice') {
      this.notices.push(String(msg.message ?? ''));
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

async function openSession(url) {
  const sock = new WebSocket(url);
  const term = new Term();
  sock.addEventListener('message', (ev) => term.apply(JSON.parse(String(ev.data))));
  await new Promise((resolve, reject) => {
    sock.addEventListener('open', resolve);
    sock.addEventListener('error', reject);
  });
  return { sock, term };
}

async function waitFor(term, pred, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred(term)) return true;
    await sleep(60);
  }
  console.log(`  (timeout waiting for ${what}; screen:\n${term.text().slice(0, 400)}\n)`);
  return false;
}

const signedOnStored = (t) => t.text().includes(`Signed on as ${STORED_USER}`);
const manualSignon = (t) => t.text().includes('AS/400 Sign On');

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
        IBM_I_DEV_PREFIX: 'PINAUTO_',
        IBM_I_TERM_TYPE: 'IBM-3477-FC',
        IBM_I_CODEPAGE: 'cp037',
        ADMIN_PIN,
        AUTO_SIGNON_USER: AUTO_USER,
        AUTO_SIGNON_PASSWORD: AUTO_PW,
        WEB5250_DB: join(mkdtempSync(join(tmpdir(), 'web5250-signonpin-')), 'menu.db')
      }
    })
  );
  if (!(await waitHealthy(HTTP_PORT))) {
    console.error('gateway never became healthy');
    process.exit(1);
  }

  // A system with a stored sign-on account, via the admin API.
  const auth = await http('POST', 'api/admin/auth', { pin: ADMIN_PIN });
  check('admin sign-in', auth.status === 200 && typeof auth.data.token === 'string', JSON.stringify(auth.data));
  const token = auth.data.token;
  const created = await http(
    'POST',
    'api/admin/systems',
    {
      name: 'PINNED',
      description: 'stored sign-on account',
      host: '127.0.0.1',
      port: MOCK_PORT,
      devPrefix: 'PINSYS_',
      signOnUser: STORED_USER,
      signOnPassword: STORED_PW
    },
    token
  );
  check('system with stored credentials created', created.status === 201, JSON.stringify(created.data));
  const sysId = created.data.system?.id;

  console.log('\nA1. Unarmed gate: stored credentials sign on automatically');
  let meta = (await http('GET', 'api/meta')).data;
  check('meta reports no protection PIN', meta.signOnPin === false);
  let s = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?system=${sysId}`);
  check('auto sign-on without a PIN', await waitFor(s.term, signedOnStored, 8000, 'stored sign-on'));
  check('no skip notice while unarmed', !s.term.notices.some((n) => n.includes('skipped')));
  s.sock.close();

  console.log('\nA2. Arming the PIN; no ticket -> manual sign-on, still connected');
  const tooShort = await http('PUT', 'api/admin/settings', { signOnPin: 'ab' }, token);
  check('short PIN rejected', tooShort.status === 400, JSON.stringify(tooShort.data));
  const armed = await http('PUT', 'api/admin/settings', { signOnPin: SIGNON_PIN }, token);
  check('arm the protection PIN', armed.status === 200 && armed.data.signOnPin === true);
  meta = (await http('GET', 'api/meta')).data;
  check('meta reports the armed PIN', meta.signOnPin === true);
  const adminView = await http('GET', 'api/admin/settings', undefined, token);
  check('admin settings view agrees', adminView.data.signOnPin === true);

  const unauthed = await http('PUT', 'api/admin/settings', { signOnPin: '4321' });
  check('arming needs the admin token', unauthed.status === 401);

  s = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?system=${sysId}`);
  check('session opens on the manual sign-on screen', await waitFor(s.term, manualSignon, 8000, 'manual sign-on'));
  check('skip notice shown', s.term.notices.some((n) => n.includes('Automatic sign-on was skipped')));
  check('no automation without a ticket', s.term.autoMsgs.length === 0, JSON.stringify(s.term.autoMsgs));
  s.sock.close();

  console.log('\nA3. Ticket exchange');
  const wrong = await http('POST', 'api/signon-ticket', { pin: '0000' });
  check('wrong PIN rejected', wrong.status === 401 && typeof wrong.data.error === 'string');
  const good = await http('POST', 'api/signon-ticket', { pin: SIGNON_PIN });
  check('right PIN yields a ticket', good.status === 200 && typeof good.data.ticket === 'string');
  const ticket = good.data.ticket;

  s = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?system=${sysId}&signonticket=${ticket}`);
  check('ticket authorizes the automatic sign-on', await waitFor(s.term, signedOnStored, 8000, 'stored sign-on'));
  check('no skip notice with a ticket', !s.term.notices.some((n) => n.includes('skipped')));
  s.sock.close();

  console.log('\nA4. Tickets are single-use');
  const replay = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?system=${sysId}&signonticket=${ticket}`);
  check('replayed ticket falls back to manual', await waitFor(replay.term, manualSignon, 8000, 'manual sign-on'));
  check('skip notice on the replayed ticket', replay.term.notices.some((n) => n.includes('Automatic sign-on was skipped')));
  replay.sock.close();

  console.log('\nA5. ?auto=1 on the shared server account is exempt');
  const auto = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?auto=1`);
  check(
    'auto launch signs on despite the gate',
    await waitFor(auto.term, (t) => t.text().includes(`Signed on as ${AUTO_USER}`), 8000, 'auto launch sign-on')
  );
  auto.sock.close();

  // ------------------------------------------------------------- B. browser UI
  console.log('\nB. The PIN dialog in the browser');
  const exeCandidates = [
    process.env.PLAYWRIGHT_CHROMIUM,
    `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
    `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-linux64/headless_shell`
  ];
  const executablePath = exeCandidates.find((p) => p && existsSync(p));
  if (!executablePath) throw new Error('no chromium binary found');

  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  // The Systems button ends the live session first; its leave-confirmation
  // (a native confirm()) must be accepted for the menu to open.
  page.on('dialog', (d) => void d.accept());
  const connState = () => page.evaluate(() => document.getElementById('conn-state')?.dataset.state ?? '');
  const waitConnected = async (ms = 10000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if ((await connState()) === 'connected') return true;
      await sleep(100);
    }
    return false;
  };
  // A row's first click only selects it (menu.ts); the second connects.
  // A row's first click only selects it (menu.ts); the second connects -
  // unless the row was already selected (selection survives menu hide/show),
  // when one click is enough and the menu hides itself on connect.
  const openPinned = async () => {
    const row = page.locator('.menu-row', { hasText: 'PINNED' });
    await row.click();
    if (await page.isVisible('#menu')) await row.click();
  };
  // The modal's hidden state is display:none, so a selector on `.hidden` can
  // never become "visible" - watch the class instead.
  const waitModalHidden = () =>
    page.waitForFunction(
      () => document.getElementById('signon-pin-modal')?.classList.contains('hidden') === true,
      undefined,
      { timeout: 5000 }
    );

  await page.goto(`http://127.0.0.1:${HTTP_PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });

  await openPinned();
  await page.waitForSelector('#signon-pin-modal:not(.hidden)', { timeout: 5000 });
  check('opening the system asks for the PIN', true);

  await page.fill('#signon-pin-input', '1111');
  await page.click('#signon-pin-ok');
  await page.waitForFunction(
    () => (document.getElementById('signon-pin-error')?.textContent ?? '') !== '',
    undefined,
    { timeout: 5000 }
  );
  check(
    'wrong PIN shows the error and keeps asking',
    (await page.isVisible('#signon-pin-modal:not(.hidden)')) &&
      ((await page.textContent('#signon-pin-error')) ?? '').includes('not valid')
  );

  await page.click('#signon-pin-skip');
  await waitModalHidden();
  check('skip connects', await waitConnected());
  await page.waitForFunction(
    () => (document.querySelector('.pane-notices')?.textContent ?? '').includes('Automatic sign-on was skipped'),
    undefined,
    { timeout: 8000 }
  );
  check('skip notice appears in the session pane', true);

  // A fresh page has no remembered PIN; prove it, then reuse it.
  await page.evaluate(() => sessionStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });
  await openPinned();
  await page.waitForSelector('#signon-pin-modal:not(.hidden)', { timeout: 5000 });
  await page.fill('#signon-pin-input', SIGNON_PIN);
  await page.click('#signon-pin-ok');
  await waitModalHidden();
  check('correct PIN connects', await waitConnected());
  await sleep(2500); // a skip notice would have arrived by now
  const noticeText = await page.evaluate(() => document.querySelector('.pane-notices')?.textContent ?? '');
  check('proven PIN signs on automatically (no skip notice)', !noticeText.includes('skipped'), noticeText);

  // Second connect in the same page: the remembered PIN answers silently.
  await page.click('#btn-systems');
  await page.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 5000 });
  await openPinned();
  await sleep(1500);
  check('remembered PIN: no second dialog', await page.isHidden('#signon-pin-modal'));
  check('remembered PIN: reconnects', await waitConnected());
  await browser.close();

  // ------------------------------------------------ C. lockout + disarm round trip
  console.log('\nC. Lockout and clearing');
  for (let i = 0; i < 5; i++) await http('POST', 'api/signon-ticket', { pin: '0000' });
  const locked = await http('POST', 'api/signon-ticket', { pin: SIGNON_PIN });
  check('repeated wrong PINs lock the exchange', locked.status === 429, JSON.stringify(locked.data));

  const cleared = await http('PUT', 'api/admin/settings', { signOnPin: null }, token);
  check('clearing the gate', cleared.status === 200 && cleared.data.signOnPin === false);
  meta = (await http('GET', 'api/meta')).data;
  check('meta reports the gate cleared', meta.signOnPin === false);
  s = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?system=${sysId}`);
  check('unarmed again: automatic sign-on restored', await waitFor(s.term, signedOnStored, 8000, 'stored sign-on'));
  s.sock.close();

  // The reported bug: a page that loaded while the gate was unarmed cached
  // signOnPin=false; arming afterwards left it connecting with no prompt (and
  // no automatic sign-on). The connect-time gate must ask /api/meta fresh.
  console.log('\nD. A page that predates arming still gets the dialog');
  const browser2 = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  const page2 = await (await browser2.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page2.goto(`http://127.0.0.1:${HTTP_PORT}/`, { waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });
  const rearm = await http('PUT', 'api/admin/settings', { signOnPin: SIGNON_PIN }, token);
  check('re-arm after the page loaded', rearm.status === 200);
  const row2 = page2.locator('.menu-row', { hasText: 'PINNED' });
  await row2.click();
  await row2.click();
  await page2.waitForSelector('#signon-pin-modal:not(.hidden)', { timeout: 5000 });
  check('stale page still prompts after arming', true);
  await browser2.close();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('signonpin test crashed:', err);
  process.exitCode = 1;
});
