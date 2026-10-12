// Visual E2E: drives the real UI in headless Chromium (playwright-core +
// the locally cached browser). Produces screenshots under artifacts/.
// Usage: node scripts/visual-test.mjs [port]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';

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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push('console: ' + msg.text());
});

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });

// The app opens on the system-selection menu: capture it, exercise the admin
// editor (PIN sign-on when ADMIN_PIN is set), then connect to the first system.
await page.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });
await page.waitForTimeout(400); // font settle
await page.screenshot({ path: `${OUT}/00-menu.png` });

await page.click('#menu-admin-btn');
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/01-admin-pin.png` });
if (await page.isVisible('#admin-pin-input')) {
  await page.fill('#admin-pin-input', String(process.env.ADMIN_PIN ?? '1234'));
  await page.click('#admin-pin-ok');
  await page.waitForSelector('#admin-editor:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/02-admin-editor.png` });
  await page.click('#admin-close');
}

// Clicking the (pre-selected) first row starts the session.
await page.click('#menu .menu-row');

// Wait for the sign-on screen: canvas has drawn content (wait for any screen msg)
await page.waitForFunction(
  () => document.getElementById('conn-state')?.dataset.state === 'connected',
  { timeout: 10000 }
);
await page.waitForTimeout(600); // font settle + first render
await page.screenshot({ path: `${OUT}/03-signon.png` });

// Focus terminal and type credentials like a user
await page.click('#terminal');
await page.keyboard.type('MOCKUSER');
await page.screenshot({ path: `${OUT}/04-userid.png` });
await page.keyboard.press('Tab');
await page.keyboard.type('SECRETPW');
await page.screenshot({ path: `${OUT}/05-password.png` });
await page.keyboard.press('Enter');
await page.waitForFunction(
  () => {
    const el = document.getElementById('oia-msg');
    return !el?.textContent?.includes('error');
  },
  { timeout: 8000 }
);
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/06-main-menu.png` });

// F1 help + F3 back, then verify OIA snapshot state via DOM
await page.keyboard.press('F1');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/07-help.png` });
await page.keyboard.press('F3');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/08-main-again.png` });

// Reverse-video cursor: the mock's Selection field (attr 0x21) holds the
// cursor on the main menu. It must render as a blinking underline over the
// green reverse background (not a black-on-black blank block), and hold
// steady once the terminal loses focus.
const cursorPx = () =>
  page.evaluate(() => {
    const canvas = document.getElementById('screen-canvas');
    const ctx = canvas.getContext('2d');
    const [r, c] = (document.getElementById('oia-pos')?.textContent ?? '1,1')
      .split(',')
      .map(Number);
    const cw = canvas.width / 80;
    const chh = canvas.height / 24;
    const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
    return {
      // bottom edge of the cursor cell (the underline strip) and its centre
      edge: px(Math.floor((c - 0.5) * cw), Math.floor(r * chh) - 1),
      centre: px(Math.floor((c - 0.5) * cw), Math.floor((r - 0.5) * chh))
    };
  });

let first = await cursorPx();
let blinked = false;
for (let i = 0; i < 12 && !blinked; i++) {
  await page.waitForTimeout(160);
  const s = await cursorPx();
  blinked = JSON.stringify(s.edge) !== JSON.stringify(first.edge);
}
if (!blinked) console.log('CURSOR: no blink observed', JSON.stringify(first));
await page.evaluate(() => document.activeElement?.blur());
await page.waitForTimeout(120);
const steady1 = await cursorPx();
await page.waitForTimeout(800);
const steady2 = await cursorPx();
console.log(
  'CURSOR:',
  JSON.stringify({
    blinked,
    steadyWhenBlurred: JSON.stringify(steady1) === JSON.stringify(steady2),
    cellCentre: steady1.centre // green (reverse bg) proves no black block cursor
  })
);
const cursorOk =
  blinked &&
  JSON.stringify(steady1) === JSON.stringify(steady2) &&
  steady1.centre[1] > steady1.centre[0] && // green dominant: reverse bg intact
  steady1.centre[1] > 60;

const oia = await page.evaluate(() => ({
  state: document.getElementById('conn-state')?.dataset.state,
  lock: document.getElementById('oia-lock')?.textContent,
  pos: document.getElementById('oia-pos')?.textContent,
  dev: document.getElementById('dev-info')?.textContent
}));

await browser.close();

console.log('OIA:', JSON.stringify(oia));
console.log('JS errors:', errors.length ? errors.join(' | ') : 'none');
console.log('screenshots written to', OUT);
if (errors.length || oia.state !== 'connected' || oia.lock || !cursorOk) process.exit(1);
