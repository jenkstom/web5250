// Admin-menu keyboard E2E: drives the real UI in headless Chromium. The
// regression this guards: keys typed into the menu's own widgets must stay
// there - Enter submitting the admin PIN used to bubble to the menu-level
// handler and connect to the selected system instead of opening the editor
// (and 'a' typed into the display-name field used to open admin).
//
// Usage: node scripts/admin-test.mjs [port]   (gateway + mock host running,
//        gateway started with ADMIN_PIN=1234)
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const PORT = process.argv[2] ?? '18092';
const BASE = `http://127.0.0.1:${PORT}`;
const PIN = process.env.ADMIN_TEST_PIN ?? '1234';

const exeCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-linux64/headless_shell`
];
const executablePath = exeCandidates.find((p) => p && existsSync(p));
if (!executablePath) throw new Error('no chromium binary found');

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

const errors = [];
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
// Deliberate 401s (the wrong-PIN attempt) surface as console errors; not
// page errors. Real script errors still fail the run via pageerror.

let failed = 0;
function check(name, cond, detail = '') {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || !detail ? '' : ' — ' + detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connState = () => page.evaluate(() => document.getElementById('conn-state')?.dataset.state ?? '');
const connected = async (ms = 600) => {
  await sleep(ms);
  return ['connected', 'connecting', 'negotiating'].includes(await connState());
};

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });
await page.evaluate(() => sessionStorage.clear()); // no token carried over: the PIN flow is what we test

// ---- 1. wrong PIN: error, editor stays closed, nothing connects
await page.click('#menu-admin-btn');
await page.waitForSelector('#admin-modal:not(.hidden)', { timeout: 5000 });
await page.waitForSelector('#admin-pin-input', { timeout: 5000 });
await page.fill('#admin-pin-input', '0000');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('admin-pin-error')?.textContent !== '', undefined, { timeout: 5000 });
check('wrong PIN shows an error', true);
check('wrong PIN does not connect', !(await connected()));
check('wrong PIN keeps the menu up', await page.isVisible('#menu:not(.hidden) .menu-row'));

// ---- 2. correct PIN + Enter: the editor opens (the reported bug)
await page.fill('#admin-pin-input', PIN);
await page.keyboard.press('Enter');
await page.waitForSelector('#admin-editor:not(.hidden)', { timeout: 5000 });
check('PIN + Enter opens the admin editor', true);
check('PIN + Enter does not connect', !(await connected(900)), `conn=${await connState()}`);
check('the menu stays up behind the editor', await page.isVisible('#menu:not(.hidden) .menu-row'));

// ---- 3. keys inside the editor form belong to the form
await page.click('#admin-add');
await page.waitForSelector('#admin-form:not(.hidden)', { timeout: 5000 });
await page.fill('#f-name', 'APPSRV'); // 'A' here used to bubble out and (re)open admin pre-fix
await page.keyboard.press('Enter');
await sleep(500);
check('form keys do not connect', !(await connected()), `conn=${await connState()}`);
check('form stays open after Enter', await page.isVisible('#admin-form:not(.hidden)'));

// ---- 4. Escape in admin closes only the admin overlay
await page.keyboard.press('Escape');
await sleep(300);
check('Escape closes admin', !(await page.isVisible('#admin-modal')));
check('Escape keeps the menu up', await page.isVisible('#menu:not(.hidden) .menu-row'));

// ---- 5. the display-name field is an input, not a menu hotkey
await page.fill('#menu-devname', 'ADMIN');
await sleep(300);
check("typing in Display doesn't open admin", !(await page.isVisible('#admin-modal')));

// ---- 6. the menu itself still connects with Enter (option input focus)
await page.focus('#menu-option'); // step 5 left focus in the Display field
await page.keyboard.press('Enter');
check('menu Enter still connects to the selected system', await page.waitForFunction(
  () => document.getElementById('conn-state')?.dataset.state === 'connected',
  undefined,
  { timeout: 10000 }
).then(() => true, () => false), `conn=${await connState()}`);

await browser.close();
if (errors.length) {
  console.log('page errors:');
  for (const e of errors) console.log('  ' + e);
  failed++;
}
console.log(failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED');
process.exit(failed === 0 ? 0 : 1);
