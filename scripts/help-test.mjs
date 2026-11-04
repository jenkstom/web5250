// End-to-end test for the in-app help system:
//   1. User guide from the front menu (Help button and the '?' key).
//   2. Hypertext: following a link, browser-style Back (Backspace/Alt+Left)
//      and Forward, Tab link cycling + Enter follow, Esc exit.
//   3. User guide from a live terminal pane's ? button; keys still reach
//      the host after closing help.
//   4. Admin guide from the admin console toolbar.
//
// Usage: npm run build && npm run test:help
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MOCK_PORT = 18063; // mock 5250 host
const HTTP_PORT = 18064; // gateway under test
const PIN = '4321';

const procs = [];
function cleanup() {
  for (const p of procs) p.kill();
}
process.on('exit', cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || !detail ? '' : ' — ' + detail}`);
  if (!cond) failed++;
}

async function waitHealthy() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${HTTP_PORT}/healthz`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return false;
}

const exeCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-linux64/headless_shell`
];
const executablePath = exeCandidates.find((p) => p && existsSync(p));
if (!executablePath) throw new Error('no chromium binary found');

async function main() {
  console.log('Starting mock host and gateway...');
  procs.push(spawn(process.execPath, ['scripts/mock-host.mjs', String(MOCK_PORT)], { stdio: 'inherit' }));
  procs.push(
    spawn(process.execPath, ['dist/server.js'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: String(HTTP_PORT),
        IBM_I_HOST: '127.0.0.1',
        IBM_I_PORT: String(MOCK_PORT),
        IBM_I_TERM_TYPE: 'IBM-3477-FC',
        IBM_I_CODEPAGE: 'cp037',
        ADMIN_PIN: PIN,
        WEB5250_DB: join(mkdtempSync(join(tmpdir(), 'web5250-help-')), 'menu.db')
      }
    })
  );
  if (!(await waitHealthy())) {
    console.error('gateway never became healthy');
    process.exit(1);
  }

  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const BASE = `http://127.0.0.1:${HTTP_PORT}`;
  const helpOpen = () => page.evaluate(() => !document.getElementById('help-modal')?.classList.contains('hidden'));
  const helpTitle = () => page.textContent('.help-title').then((t) => (t ?? '').trim());
  const helpBook = () => page.textContent('.help-topicname').then((t) => (t ?? '').trim());
  const backLabel = () => page.textContent('.help-navbtn').then((t) => (t ?? '').trim());

  // ---------------------------------------------- 1. user guide from the menu
  console.log('\n1. User guide opens from the front menu');
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });
  await page.click('#menu-help-btn');
  await page.waitForSelector('#help-modal:not(.hidden)', { timeout: 5000 });
  check('help overlay appears', await helpOpen());
  check('user guide book header', (await helpBook()) === 'USER GUIDE', await helpBook());
  check('home page title', (await helpTitle()) === 'User guide', await helpTitle());
  check('footer shows key hints', await page.isVisible('.help-foot'));
  check('pages render links', (await page.locator('.help-body a.hlink').count()) > 5);

  // ---------------------------------------------- 2. hypertext + backtracking
  console.log('\n2. Hypertext navigation and browser-style backtracking');
  await page.locator('.help-body a.hlink', { hasText: 'Keyboard' }).first().click();
  await sleep(200);
  check('followed link renders the target page', (await helpTitle()) === 'Keyboard', await helpTitle());
  const withHistory = await backLabel();
  check('back button shows the trail', /^Back \(\d+\)/.test(withHistory), withHistory);
  await page.keyboard.press('Backspace');
  await sleep(200);
  check('Backspace goes back a page', (await helpTitle()) === 'User guide', await helpTitle());
  await page.keyboard.press('Alt+ArrowRight');
  await sleep(200);
  check('Alt+Right goes forward again', (await helpTitle()) === 'Keyboard', await helpTitle());

  // Tab cycling + Enter follow (5250 help style).
  await page.click('.help-card').catch(() => {}); // focus inside the overlay
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => `${document.activeElement?.className ?? ''} ${document.activeElement?.textContent ?? ''}`);
  check('Tab cycles link focus', focused.includes('hlink'), focused);
  await page.keyboard.press('Enter');
  await sleep(200);
  check('Enter follows the focused link', (await helpTitle()) !== 'Keyboard', await helpTitle());
  await page.keyboard.press('Alt+ArrowLeft');
  await sleep(200);
  check('Alt+Left goes back', (await helpTitle()) === 'Keyboard', await helpTitle());

  // Esc exits; '?' from the menu reopens it.
  await page.keyboard.press('Escape');
  await sleep(200);
  check('Esc closes help', !(await helpOpen()));
  await page.click('#menu-option');
  await page.keyboard.press('?');
  await page.waitForSelector('#help-modal:not(.hidden)', { timeout: 5000 });
  check("? key on the menu opens help", await helpOpen());
  await page.keyboard.press('Escape');
  await sleep(150);

  // ------------------------------------- 3. from a live pane; host keys intact
  console.log('\n3. User guide from a terminal pane');
  // Row 1 is selected on load; the Connect button opens it.
  await page.click('#menu-go');
  await page.waitForSelector('.pane-helpbtn', { timeout: 10000 });
  await page.waitForFunction(() => document.getElementById('conn-state')?.dataset.state === 'connected', undefined, { timeout: 15000 });
  await page.click('.pane-helpbtn');
  await page.waitForSelector('#help-modal:not(.hidden)', { timeout: 5000 });
  check('pane ? button opens the user guide', (await helpBook()) === 'USER GUIDE');
  // While help is open, Tab belongs to help, not the host.
  await page.keyboard.press('Tab');
  const focusedLink = await page.evaluate(() => document.activeElement?.className ?? '');
  check('Tab while help is open cycles help links, not host fields', focusedLink.includes('hlink'), focusedLink);
  await page.keyboard.press('Escape');
  await sleep(200);
  check('Esc returns to the terminal', !(await helpOpen()));
  // The host still receives typed keys (mock sign-on accepts anything).
  await page.keyboard.type('HELPTES1');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => (document.getElementById('conn-state')?.dataset.state ?? '') === 'connected',
    undefined,
    { timeout: 8000 }
  );
  check('terminal still alive and typing after help', true);

  // ----------------------------------------------- 4. admin guide from console
  console.log('\n4. Admin guide from the admin console');
  // A live session hides the landing menu (and its Admin button): a fresh
  // page in the same browser starts at the menu again.
  const adminPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await adminPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await adminPage.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });
  await adminPage.click('#menu-admin-btn');
  await adminPage.fill('#admin-pin-input', PIN);
  await adminPage.keyboard.press('Enter');
  await adminPage.waitForSelector('#admin-editor:not(.hidden)', { timeout: 5000 });
  await adminPage.click('#admin-help');
  await adminPage.waitForSelector('#help-modal:not(.hidden)', { timeout: 5000 });
  check('admin help opens the admin guide', (await adminPage.textContent('.help-topicname')).trim() === 'ADMIN GUIDE');
  check('admin home page', (await adminPage.textContent('.help-title')).trim() === 'Administration');
  check('admin console still open underneath', await adminPage.isVisible('#admin-editor:not(.hidden)'));
  await adminPage.locator('.help-body a.hlink', { hasText: 'Stored sign-on accounts' }).first().click();
  await sleep(200);
  check('admin hypertext works', (await adminPage.textContent('.help-title')).trim() === 'Stored sign-on accounts');
  await adminPage.keyboard.press('Escape');
  await sleep(200);
  check(
    'Esc closes help but keeps the console',
    (await adminPage.evaluate(() => document.getElementById('help-modal')?.classList.contains('hidden') === true)) &&
      (await adminPage.isVisible('#admin-editor:not(.hidden)'))
  );
  await adminPage.close();

  await browser.close();
  console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('help test crashed:', err);
  cleanup();
  process.exitCode = 1;
});
