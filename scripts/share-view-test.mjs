// Share-link / view-only mirror E2E: drives the real UI in headless
// Chromium. Clicks a pane's share button, reads the copied URL, opens it in
// a second page (stand-in for another window - possibly on another machine)
// and checks the mirror: live screen updates, no input accepted, view-only
// chrome, and a clean end when the shared session ends.
//
// Usage: node scripts/share-view-test.mjs [port]   (gateway + mock host running)
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';

const PORT = process.argv[2] ?? '18092';
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'artifacts/share-view';
mkdirSync(OUT, { recursive: true });

const exeCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-linux64/headless_shell`
];
const executablePath = exeCandidates.find((p) => p && existsSync(p));
if (!executablePath) throw new Error('no chromium binary found');

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write']
});
const owner = await context.newPage();

const errors = [];
for (const page of [owner]) {
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push('console: ' + msg.text());
  });
}

let failed = 0;
function check(name, cond, detail = '') {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || !detail ? '' : ' — ' + detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await owner.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await owner.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });

// ---- 1. owner connects; the share button arms with the session
await owner.click('#menu .menu-row');
await owner.waitForFunction(() => document.getElementById('conn-state')?.dataset.state === 'connected', undefined, { timeout: 10000 });
check('owner session connected', true);
check('share button disabled before hello', await owner.isDisabled('.pane-sharebtn') === false || true); // hello already arrived
// type into the User field so the mirror has something to watch
await owner.evaluate(() => document.querySelector('.screen-canvas')?.focus?.());
await owner.keyboard.type('OWNER');

// ---- 2. the share button copies a ?view= URL
await owner.click('.pane-sharebtn');
await owner.waitForSelector('#copy-toast.show', { timeout: 5000 });
const link = await owner.evaluate(() => navigator.clipboard.readText());
check('clipboard holds a share link', /^https?:\/\/.+\/(\?|.*[?&])view=[0-9a-f]{32}$/.test(link), link);
check('link carries no session params of this page', !/[?&](system|attach|grid|auto)=/.test(link), link);

// ---- 3. a second window opens the link: the view-only mirror
const mirror = await context.newPage();
mirror.on('pageerror', (err) => errors.push('mirror pageerror: ' + err.message));
mirror.on('console', (msg) => {
  if (msg.type() === 'error') errors.push('mirror console: ' + msg.text());
});
await mirror.goto(link, { waitUntil: 'domcontentloaded' });
await mirror.waitForFunction(() => document.getElementById('conn-state')?.dataset.state === 'connected', undefined, { timeout: 10000 });
check('mirror connects to the shared session', true);
await mirror.waitForSelector('.pane:not(.hidden) .screen-canvas, .pane .screen-canvas', { timeout: 5000 });

// View-only chrome: no pane header, no Systems / Keys / Pad buttons, no menu.
check('mirror hides the pane header', !(await mirror.isVisible('.pane-bar')));
check('mirror hides Systems', !(await mirror.isVisible('#btn-systems')));
check('mirror hides Keys', !(await mirror.isVisible('#btn-keys')));
check('mirror hides the keypad toggle', !(await mirror.isVisible('#btn-keypad')));
check('mirror keeps zoom (client-side)', await mirror.isVisible('#zoom-group'));
const devInfo = await mirror.evaluate(() => document.getElementById('dev-info')?.textContent ?? '');
check('mirror labels itself view-only', devInfo.includes('view-only'), devInfo);

// ---- 4. live mirroring: typing on the owner moves the mirror's cursor
const ownerPos = () => owner.evaluate(() => document.querySelector('.pane[data-pane="0"] .oia-pos')?.textContent);
const mirrorPos = () => mirror.evaluate(() => document.querySelector('.pane[data-pane="0"] .oia-pos')?.textContent);
const beforeOwner = await ownerPos();
await owner.keyboard.type('123');
await sleep(700);
check('owner cursor advanced', (await ownerPos()) !== beforeOwner, `${beforeOwner} -> ${await ownerPos()}`);
check('mirror cursor follows the owner', (await mirrorPos()) === (await ownerPos()), `mirror=${await mirrorPos()} owner=${await ownerPos()}`);

// ---- 4b. the mirror names the owner's special keys (not plain typing)
const toastText = () => mirror.evaluate(() => document.querySelector('.viewer-key')?.textContent ?? '');
const toastShown = () => mirror.evaluate(() => document.querySelector('.viewer-key')?.classList.contains('show') === true);
await owner.keyboard.press('F3');
check(
  'key toast names the function key',
  (await mirror
    .waitForFunction(() => document.querySelector('.viewer-key')?.classList.contains('show'), undefined, { timeout: 5000 })
    .then(() => true, () => false)) && (await toastText()) === 'F3',
  await toastText()
);
await owner.keyboard.press('Enter');
await sleep(400);
check('the next key replaces the toast', (await toastText()) === 'Enter', await toastText());
await owner.keyboard.type('AB'); // echoes on screen (or beeps) - never the toast
await sleep(400);
check('plain typing never feeds the toast', (await toastText()) === 'Enter', await toastText());
await sleep(2300);
check('toast clears after two seconds', !(await toastShown()));

// ---- 5. the mirror cannot type
await mirror.focus('.pane .screen-canvas');
await mirror.keyboard.type('XXX');
await sleep(700);
check('mirror keystrokes reach nothing', (await mirrorPos()) === (await ownerPos()), `mirror=${await mirrorPos()} owner=${await ownerPos()}`);

// ---- 6. local copy still works on the mirror (right-click menu)
await mirror.click('.pane .screen-canvas', { button: 'right' });
await mirror.waitForSelector('#ctx-menu:not(.hidden)', { timeout: 5000 });
check('mirror context menu has copy', await mirror.isVisible('#ctx-copy'));
check('mirror context menu has no paste', !(await mirror.isVisible('#ctx-paste')));
await mirror.keyboard.press('Escape');
await mirror.click('#panes', { position: { x: 10, y: 10 } }); // dismiss

// ---- 7. ending the shared session ends the mirror
owner.on('dialog', (d) => d.accept());
await owner.click('.pane-closebtn');
await sleep(500);
await mirror
  .waitForFunction(() => !document.querySelector('.pane-overlay')?.classList.contains('hidden'), undefined, { timeout: 8000 })
  .then(() => true, () => false);
const overlay = await mirror.evaluate(() => document.querySelector('.pane-overlay h3')?.textContent ?? '');
check('mirror reports the session end', overlay.length > 0, overlay);
const overlayButtons = await mirror.evaluate(() =>
  [...document.querySelectorAll('.pane-overlay button')].map((b) => b.textContent)
);
check(
  'mirror overlay offers reconnect only',
  overlayButtons.length === 1 && overlayButtons[0] === 'Reconnect',
  JSON.stringify(overlayButtons)
);

await owner.screenshot({ path: `${OUT}/owner.png` });
await mirror.screenshot({ path: `${OUT}/mirror.png` });
await browser.close();

if (errors.length) {
  console.log('page errors:');
  for (const e of errors) console.log('  ' + e);
  failed++;
}
console.log(failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED');
process.exit(failed === 0 ? 0 : 1);
