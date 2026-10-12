// Mobile E2E: drives the UI in headless Chromium emulating a touch phone
// (playwright-core + locally cached browser). Verifies the small-screen fit,
// soft-keyboard focus flow, keypad behaviour, visual-viewport shrink/expand
// (keyboard open/close) and the SHOW_DIAG_BUTTON config. Screenshots land in
// artifacts/ as mobile-*.png.
// Usage: node scripts/mobile-test.mjs [port]
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';

const PORT = process.argv[2] ?? '18092';
const OUT = 'artifacts';
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
  viewport: { width: 375, height: 667 }, // iPhone SE-ish
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2
});
const page = await context.newPage();

const errors = [];
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push('console: ' + msg.text());
});

// Collect key frames sent over the session WebSocket.
const sentKeys = [];
page.on('websocket', (ws) => {
  ws.on('framesent', (data) => {
    try {
      const msg = JSON.parse(data.payload.toString());
      if (msg.t === 'key') sentKeys.push(msg);
    } catch {
      /* control frames */
    }
  });
});

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const metrics = () =>
  page.evaluate(() => {
    const canvas = document.getElementById('screen-canvas');
    const stage = document.getElementById('stage');
    const app = document.getElementById('app');
    const cr = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    return {
      appH: app.offsetHeight,
      canvas: { w: cr.width, h: cr.height, x: cr.x, y: cr.y, right: cr.right, bottom: cr.bottom },
      stage: { w: sr.width, h: sr.height, x: sr.x, y: sr.y, right: sr.right, bottom: sr.bottom },
      intrinsicRatio: canvas.width / canvas.height,
      boxRatio: cr.width / cr.height
    };
  });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });

// The (pointer: coarse) media query drives the mobile affordances; verify the
// emulation actually reports a touch-primary device.
const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
check('pointer: coarse matches (touch emulation)', coarse);

// ---------------------------------------------------------------- menu fits
await page.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/mobile-00-menu.png` });
const menuOverflow = await page.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
);
check('menu has no horizontal overflow', !menuOverflow);

// ------------------------------------------------------------ session + fit
await page.tap('#menu .menu-row');
await page.waitForFunction(
  () => document.getElementById('conn-state')?.dataset.state === 'connected',
  { timeout: 10000 }
);
await page.waitForTimeout(600); // font settle + first render

let m = await metrics();
check(
  'canvas fits inside stage width',
  m.canvas.right <= m.stage.right + 1 && m.canvas.x >= m.stage.x - 1,
  `canvas ${Math.round(m.canvas.w)}x${Math.round(m.canvas.h)} vs stage ${Math.round(m.stage.w)}x${Math.round(m.stage.h)}`
);
check('canvas fits inside stage height', m.canvas.bottom <= m.stage.bottom + 1, `bottom=${Math.round(m.canvas.bottom)} stage.bottom=${Math.round(m.stage.bottom)}`);
check(
  'canvas aspect preserved',
  Math.abs(m.intrinsicRatio - m.boxRatio) < 0.02,
  `intrinsic=${m.intrinsicRatio.toFixed(3)} box=${m.boxRatio.toFixed(3)}`
);
const shrunk = m.canvas.w < m.canvas.h * 6; // 80 cols at mobile width => clearly scaled down
check('canvas actually scaled down for the narrow screen', shrunk, `box=${Math.round(m.canvas.w)}x${Math.round(m.canvas.h)}`);
await page.screenshot({ path: `${OUT}/mobile-01-terminal.png` });

// The keypad must be up on touch devices from the start, arrows included.
const keypadVisible = await page.isVisible('#keypad');
check('on-screen keypad visible on touch device', keypadVisible);
const arrows = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('#kp-edit button')].map((b) => b.textContent);
  return ['↑', '↓', '←', '→'].every((a) => labels.includes(a));
});
check('keypad has cursor arrows', arrows);

// ------------------------------------------------------ soft keyboard focus
// Tapping the screen must focus the hidden input: on a real device that
// gesture is what raises the OS keyboard.
await page.tap('#terminal');
await page.waitForTimeout(150);
const focus1 = await page.evaluate(() => document.activeElement?.id);
check('tap on terminal focuses the hidden typing input', focus1 === 'mobile-input', `activeElement=#${focus1}`);

// Tapping a keypad key sends the key AND leaves focus on the input (a focus
// grab would close the OS keyboard on a real device). The keypad auto
// collapsed when the input took focus; Pad brings it back without dropping
// that focus.
const keypadHidden = await page.evaluate(() => document.getElementById('keypad').classList.contains('hidden'));
check('keypad auto-collapses while the device keyboard is open', keypadHidden);
await page.tap('#btn-keypad');
await page.waitForTimeout(150);
const keypadBack = await page.evaluate(() => !document.getElementById('keypad').classList.contains('hidden'));
check('Pad button brings the keypad back while typing', keypadBack);
const focusAfterPad = await page.evaluate(() => document.activeElement?.id);
check('Pad tap keeps the typing input focused', focusAfterPad === 'mobile-input', `activeElement=#${focusAfterPad}`);
sentKeys.length = 0;
await page.tap('#kp-edit button[title="Cursor right"]');
await page.waitForTimeout(200);
check(
  'keypad arrow sends the key over WS',
  sentKeys.some((m) => m.k === 'right'),
  JSON.stringify(sentKeys.map((m) => m.k))
);
const focus2 = await page.evaluate(() => document.activeElement?.id);
check('keypad tap keeps the typing input focused', focus2 === 'mobile-input', `activeElement=#${focus2}`);

// ------------------------------------------------- type a sign-on "softly"
// The input still holds focus (a real device would show the keyboard);
// typed characters travel exactly once (key mapped on keydown, or delivered
// through the input event).
sentKeys.length = 0;
await page.keyboard.type('MOCKUSER');
const charFrames = sentKeys.filter((m) => m.k === 'char');
check(
  'typed characters reach the host exactly once',
  charFrames.map((m) => m.ch).join('') === 'MOCKUSER' && charFrames.length === 8,
  JSON.stringify(charFrames.map((m) => m.ch))
);
const posBeforeEnter = await page.evaluate(() => document.getElementById('oia-pos')?.textContent);
await page.keyboard.press('Tab');
await page.keyboard.type('SECRETPW');
await page.keyboard.press('Enter');
await page
  .waitForFunction(
    (before) => document.getElementById('oia-pos')?.textContent !== before,
    posBeforeEnter,
    { timeout: 8000 }
  )
  .catch(() => {});
await page.waitForTimeout(500);
const mainMenu = await page.evaluate(
  () => document.getElementById('conn-state')?.dataset.state === 'connected' &&
    !document.getElementById('oia-msg')?.textContent?.includes('error')
);
check('soft-keyboard sign-on reaches the main menu', mainMenu);
await page.screenshot({ path: `${OUT}/mobile-02-mainmenu.png` });

// ------------------------------------------------ Kbd button toggles focus
await page.tap('#btn-kbd');
await page.waitForTimeout(150);
const focus3 = await page.evaluate(() => document.activeElement?.id);
check('Kbd button dismisses (blurs) the typing input', focus3 !== 'mobile-input', `activeElement=#${focus3}`);
await page.tap('#btn-kbd');
await page.waitForTimeout(150);
const focus4 = await page.evaluate(() => document.activeElement?.id);
check('Kbd button summons the typing input again', focus4 === 'mobile-input', `activeElement=#${focus4}`);

// ------------------------------------- keyboard open/close: shrink & expand
// A soft keyboard shrinks window.visualViewport without touching the layout
// viewport; simulate exactly that and watch the app follow.
const fullH = (await metrics()).appH;
await page.evaluate(() => {
  const vv = window.visualViewport;
  Object.defineProperty(vv, 'height', { configurable: true, get: () => 280 });
  vv.dispatchEvent(new Event('resize'));
});
await page.waitForTimeout(300);
m = await metrics();
check('app shrinks to the keyboard-open viewport', Math.abs(m.appH - 280) <= 2, `appH=${m.appH}`);
check(
  'canvas still fits with the keyboard "open"',
  m.canvas.bottom <= m.stage.bottom + 1 && m.canvas.right <= m.stage.right + 1,
  `canvas=${Math.round(m.canvas.w)}x${Math.round(m.canvas.h)} stage=${Math.round(m.stage.w)}x${Math.round(m.stage.h)}`
);
check(
  'canvas aspect preserved while shrunk',
  Math.abs(m.intrinsicRatio - m.boxRatio) < 0.02,
  `box=${m.boxRatio.toFixed(3)}`
);
await page.screenshot({ path: `${OUT}/mobile-03-keyboard-open.png` });

await page.evaluate(() => {
  const vv = window.visualViewport;
  delete vv.height; // restore the native getter
  vv.dispatchEvent(new Event('resize'));
});
await page.waitForTimeout(300);
m = await metrics();
check('app expands again when the keyboard closes', Math.abs(m.appH - fullH) <= 2, `appH=${m.appH} (was ${fullH})`);
await page.screenshot({ path: `${OUT}/mobile-04-keyboard-closed.png` });

// ------------------------------------------------------------- diag button
const diagVisible = await page.isVisible('#btn-diag');
check('Diag button hidden by default', !diagVisible);
const kbdVisible = await page.isVisible('#btn-kbd');
check('Kbd button visible on touch device', kbdVisible);

// ------------------------------------------------- very small phone (320px)
await page.setViewportSize({ width: 320, height: 568 });
await page.waitForTimeout(400);
m = await metrics();
check(
  'fits on a 320px phone (keypad hidden)',
  m.canvas.right <= m.stage.right + 1 && m.canvas.bottom <= m.stage.bottom + 1,
  `canvas=${Math.round(m.canvas.w)}x${Math.round(m.canvas.h)} stage=${Math.round(m.stage.w)}x${Math.round(m.stage.h)}`
);
await page.tap('#btn-keypad'); // keypad up while the input stays focused
await page.waitForTimeout(300);
m = await metrics();
check(
  'fits on a 320px phone with the keypad up',
  m.canvas.right <= m.stage.right + 1 && m.canvas.bottom <= m.stage.bottom + 1,
  `canvas=${Math.round(m.canvas.w)}x${Math.round(m.canvas.h)}`
);
const pageOverflow = await page.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
);
check('no horizontal page overflow at 320px', !pageOverflow);
await page.screenshot({ path: `${OUT}/mobile-05-tiny.png` });

// --------------------------------------------------------- landscape phone
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(400);
m = await metrics();
check(
  'fits in landscape',
  m.canvas.right <= m.stage.right + 1 && m.canvas.bottom <= m.stage.bottom + 1,
  `canvas=${Math.round(m.canvas.w)}x${Math.round(m.canvas.h)}`
);
await page.screenshot({ path: `${OUT}/mobile-06-landscape.png` });

await browser.close();

console.log('JS errors:', errors.length ? errors.join(' | ') : 'none');
if (errors.length) failures++;
console.log(failures ? `mobile test: ${failures} FAILURE(S)` : 'mobile test: all checks passed');
process.exit(failures ? 1 : 0);
