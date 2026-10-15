// E2E for paste: Ctrl+V must type the clipboard at the cursor with no
// confirmation (the prompt-free path the menu's readText() can't offer),
// tabs in pasted text advance fields, line breaks are dropped, the
// right-click menu Paste still works, and a UI surface or typing surface
// swallows the paste. Uses the mock sign-on fields (11 wide, cursor 9,45)
// and then the main menu's command line (19,26, 21 wide).
// Usage: npm run build && node scripts/paste-test.mjs
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { chromium } from 'playwright-core';

const MOCK_PORT = 18153;
const HTTP_PORT = 18158;
const DB = '/tmp/web5250-paste.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  [${cond ? 'ok' : 'FAIL'}] ${name}${cond ? '' : ' - ' + detail}`);
  if (!cond) failures++;
};

const procs = [];
process.on('exit', () => procs.forEach((p) => p.kill()));
rmSync(DB, { force: true });
procs.push(spawn(process.execPath, ['dist/mock-host.mjs', String(MOCK_PORT)], { stdio: 'inherit' }));
await sleep(300);
procs.push(
  spawn(process.execPath, ['dist/server.js'], {
    stdio: 'inherit',
    env: { ...process.env, PORT: String(HTTP_PORT), IBM_I_HOST: '127.0.0.1', IBM_I_PORT: String(MOCK_PORT), WEB5250_DB: DB }
  })
);
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${HTTP_PORT}/healthz`)).ok) break;
  } catch {}
  await sleep(200);
}

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
const page = await context.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));

// The pane's whole screen text, via the same right-click Copy screen the UI
// offers (hidden password cells copy as blanks - typed secrets never show).
async function screenText() {
  const b = await page.evaluate(() => document.getElementById('screen-canvas').getBoundingClientRect());
  await page.mouse.click(b.left + b.width / 2, b.top + b.height / 2, { button: 'right' });
  await page.waitForSelector('#ctx-menu:not(.hidden)', { timeout: 3000 });
  await page.click('#ctx-copy');
  await page.waitForTimeout(150);
  return page.evaluate(() => navigator.clipboard.readText());
}

// Viewport coordinates of the centre of a 1-based cell.
async function cellXY(r, c) {
  return page.evaluate(
    ([r, c]) => {
      const b = document.getElementById('screen-canvas').getBoundingClientRect();
      return { x: b.left + (c - 0.5) * (b.width / 80), y: b.top + (r - 0.5) * (b.height / 24) };
    },
    [r, c]
  );
}
async function clickCell(r, c) {
  const { x, y } = await cellXY(r, c);
  await page.mouse.click(x, y);
  await page.waitForTimeout(200);
}
async function pasteKeys(text) {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(400);
}

await page.goto(`http://127.0.0.1:${HTTP_PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });
await page.click('#menu .menu-row');
await page.waitForFunction(
  () => document.getElementById('conn-state')?.dataset.state === 'connected',
  undefined,
  { timeout: 10000 }
);
await page.waitForTimeout(600); // font settle + first render

// --- sign-on: cursor starts in the User field (9,45) -----------------------
check('cursor starts in the User field', (await page.textContent('#oia-pos')) === '9,45');

// --- line breaks are dropped, not submitted ---------------------------------
await pasteKeys('XY\nZ');
{
  const screen = await screenText();
  check('pasted line break is dropped, not entered', screen.includes('XYZ'), JSON.stringify(screen.slice(0, 400)));
  check('multi-line paste keeps the sign-on screen', screen.includes('AS/400 Sign On'));
}

// --- a tab in the pasted text advances to the next field -------------------
await pasteKeys('AB\tCD');
check('text before the pasted tab lands in the User field', (await screenText()).includes('XYZAB'));
check('pasted tab jumps to the Password field, rest types there', (await page.textContent('#oia-pos')) === '10,47');

// --- sign on: overwrite the user field, then the password ------------------
await clickCell(9, 45);
await page.keyboard.type('MOCKUSER');
await page.keyboard.press('Tab');
await page.keyboard.type('SECRETPW');
await page.keyboard.press('Enter');
await sleep(900); // main menu renders
check('signed on to the main menu', (await screenText()).includes('User tasks'));

// --- Ctrl+V pastes with no confirmation -------------------------------------
await clickCell(19, 26); // command line's first input cell
check('click places the command-line cursor', (await page.textContent('#oia-pos')) === '19,26');
await pasteKeys('HELLO5250');
check('ctrl+v types the clipboard at the cursor', (await screenText()).includes('HELLO5250'));

// --- right-click menu Paste still reads and types ---------------------------
await page.evaluate(() => navigator.clipboard.writeText('MENUP8'));
{
  const b = await page.evaluate(() => document.getElementById('screen-canvas').getBoundingClientRect());
  await page.mouse.click(b.left + b.width / 2, b.top + b.height / 2, { button: 'right' });
  await page.waitForSelector('#ctx-menu:not(.hidden)', { timeout: 3000 });
  await page.click('#ctx-paste');
}
await page.waitForTimeout(400);
check('menu Paste still types the clipboard', (await screenText()).includes('MENUP8'));

// --- a UI surface keeps the paste for itself --------------------------------
// Synthetic event, so the check does not depend on the keystroke reaching
// the page while the help is open.
await page.click('#btn-keys');
await page.waitForSelector('#keys-modal:not(.hidden)');
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.setData('text/plain', 'GUARDTXT');
  document.body.focus();
  window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await page.click('#keys-close');
await page.waitForTimeout(300);
check('paste while the help is open does not type', !((await screenText()).includes('GUARDTXT')));

// --- a typing surface keeps its paste: the pane never sees it ---------------
// The hidden mobile input is the touch path; a paste aimed at it must not
// also type into the terminal through the window listener.
await page.evaluate(() => {
  document.getElementById('mobile-input').focus();
  const dt = new DataTransfer();
  dt.setData('text/plain', 'ONCE');
  document.getElementById('mobile-input').dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
  );
});
await page.waitForTimeout(300);
check('paste aimed at a typing surface never reaches the pane', !((await screenText()).includes('ONCE')));

await page.screenshot({ path: 'artifacts/paste-final.png' });
await browser.close();

if (errors.length) {
  console.log('page errors:', errors.join(' | '));
  failures += errors.length;
}
console.log(failures === 0 ? 'ALL OK' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
