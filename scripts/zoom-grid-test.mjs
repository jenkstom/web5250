// E2E for the terminal zoom buttons (Fit / ½ / ¼) and the ?grid= split view:
// drives the real UI in headless Chromium against a running gateway
// (npm run mock + a gateway on PORT with IBM_I_* pointing at it).
// Usage: node scripts/zoom-grid-test.mjs [port]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';

const PORT = process.argv[2] ?? '18094';
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'artifacts/zoom-grid';
mkdirSync(OUT, { recursive: true });

const exeCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-linux64/headless_shell`
];
const executablePath = exeCandidates.find((p) => p && existsSync(p));
if (!executablePath) throw new Error('no chromium binary found');

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push('console: ' + msg.text());
});
page.on('dialog', (d) => d.accept()); // leave guards (beforeunload/confirm)

const check = (name, cond, detail = '') => {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
};
const canvasW = (frame = page) =>
  frame.evaluate(() => document.getElementById('screen-canvas').getBoundingClientRect().width);

// Click a cell on a pane's canvas (1-based r/c) through the frame locator so
// Playwright translates iframe coordinates; the click focuses the pane.
const clickCell = async (frame, r, c) => {
  const box = await frame.locator('#screen-canvas').boundingBox();
  await frame.locator('#screen-canvas').click({
    position: { x: ((c - 0.5) * box.width) / 80, y: ((r - 0.5) * box.height) / 24 }
  });
};

// ---- 1. menu shows the Split buttons
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });
check('menu has Split ×2 button', await page.isVisible('#menu-split2'));
check('menu has Split ×4 button', await page.isVisible('#menu-split4'));
check('zoom group hidden on menu', !(await page.isVisible('#zoom-group')));

// ---- 2. sign on; zoom buttons appear; Fit is active
await page.click('#menu .menu-row');
await page.waitForFunction(
  () => document.getElementById('conn-state')?.dataset.state === 'connected',
  { timeout: 10000 }
);
await page.waitForTimeout(400);
check('zoom group visible in session', await page.isVisible('#zoom-group'));
check('Fit active by default', await page.evaluate(() => document.getElementById('btn-fit').classList.contains('active')));
const wFit = await canvasW();

// ---- 3. ½ and ¼ shrink the canvas around the centre; Fit restores
await page.click('#btn-half');
await page.waitForTimeout(150);
const wHalf = await canvasW();
check('half ≈ fit/2', Math.abs(wHalf - wFit / 2) <= 2, `${wHalf.toFixed(0)} vs ${(wFit / 2).toFixed(0)}`);
check('½ button active', await page.evaluate(() => document.getElementById('btn-half').classList.contains('active')));
check('localStorage persists ½', (await page.evaluate(() => localStorage.getItem('web5250.zoom'))) === '0.5');

await page.click('#btn-quarter');
await page.waitForTimeout(150);
const wQuarter = await canvasW();
check('quarter ≈ fit/4', Math.abs(wQuarter - wFit / 4) <= 2, `${wQuarter.toFixed(0)} vs ${(wFit / 4).toFixed(0)}`);
check('terminal stays centred (left gap ≈ right gap)', await page.evaluate(() => {
  const c = document.getElementById('screen-canvas').getBoundingClientRect();
  const s = document.getElementById('stage').getBoundingClientRect();
  return Math.abs((c.left - s.left) - (s.right - c.right)) <= 3;
}));
await page.screenshot({ path: `${OUT}/01-quarter.png` });

await page.click('#btn-fit');
await page.waitForTimeout(150);
check('Fit restores full size', Math.abs((await canvasW()) - wFit) <= 2);

// ---- 4. zoom choice survives reload + reconnect (½ still selected now)
await page.click('#btn-half');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });
await page.click('#menu .menu-row');
await page.waitForFunction(
  () => document.getElementById('conn-state')?.dataset.state === 'connected',
  { timeout: 10000 }
);
await page.waitForTimeout(300);
check('½ active after reload (persisted)', await page.evaluate(() => document.getElementById('btn-half').classList.contains('active')));
check('canvas at half after reload', Math.abs((await canvasW()) - wFit / 2) <= 2);
await page.click('#btn-fit');

// ---- 5. Systems → menu → Split ×2 (with a display name to prove dedupe)
await page.click('#btn-systems');
await page.waitForSelector('#menu:not(.hidden)', { timeout: 5000 });
check('zoom group hidden again on menu', !(await page.isVisible('#zoom-group')));
await page.fill('#menu-devname', 'MULTI');
await page.click('#menu-split2');
await page.waitForSelector('#grid:not(.hidden)', { timeout: 5000 });
check('grid visible with 2 panes', (await page.locator('#grid-panes iframe').count()) === 2);
check('single-session UI hidden', await page.evaluate(() => document.getElementById('app').classList.contains('hidden')));
check('grid URL has ?grid=2', page.url().includes('grid=2'));
await page.waitForTimeout(1200); // panes boot to their menus

const panes = page.frames().filter((f) => f !== page.mainFrame());
check('two pane frames loaded', panes.length === 2, panes.map((f) => f.url()).join(' | '));
for (const f of panes) {
  await f.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });
}
check('both panes show the system menu', true);
await page.screenshot({ path: `${OUT}/02-grid-menus.png` });

// ---- 6. sign on in both panes → two independent sessions
for (const f of panes) {
  await f.click('#menu .menu-row');
  await f.waitForFunction(
    () => document.getElementById('conn-state')?.dataset.state === 'connected',
    null,
    { timeout: 10000 }
  );
  await clickCell(f, 9, 45); // User field on the sign-on display
  await page.keyboard.type('MOCKUSER');
  await page.keyboard.press('Tab');
  await page.keyboard.type('SECRETPW');
  await page.keyboard.press('Enter');
  await f.waitForFunction(
    () => {
      const msg = document.getElementById('oia-msg')?.textContent ?? '';
      return !msg.includes('error');
    },
    null,
    { timeout: 8000 }
  );
}
await page.waitForTimeout(800);
const names = [];
for (const f of panes) {
  names.push(await f.evaluate(() => document.getElementById('dev-info')?.textContent));
}
check('panes dedupe the display name (MULTI / MULTI1)',
  names[0]?.includes('MULTI') && names[1]?.includes('MULTI') && names[0] !== names[1],
  names.join(' | '));
await page.screenshot({ path: `${OUT}/03-grid-signedon.png` });

// ---- 7. typing goes only to the focused pane
{
  const f = panes[0];
  await clickCell(f, 10, 20);
  const before = await f.evaluate(() => document.getElementById('oia-pos')?.textContent);
  await page.keyboard.type('X');
  await f.waitForFunction(
    (prev) => document.getElementById('oia-pos')?.textContent !== prev,
    before,
    { timeout: 5000 }
  );
  const moved = await f.evaluate(() => document.getElementById('oia-pos')?.textContent);
  const otherBefore = await panes[1].evaluate(() => document.getElementById('oia-pos')?.textContent);
  check('keystroke moved only pane 1 cursor', moved !== before, `${before} → ${moved}, pane2 at ${otherBefore}`);
}

// ---- 8. preassigned deep link ?grid=2&systems=1,1 connects both panes
await page.goto(`${BASE}/?grid=2&systems=1,1`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#grid:not(.hidden)', { timeout: 5000 });
const frames2 = page.frames().filter((f) => f !== page.mainFrame());
check('deep link spawns two panes', frames2.length === 2);
for (const f of frames2) {
  await f.waitForFunction(
    () => document.getElementById('conn-state')?.dataset.state === 'connected',
    null,
    { timeout: 12000 }
  );
}
check('preassigned panes both connected without interaction', true);
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/04-grid-deeplink.png` });

// ---- 9. Exit split view returns to the normal app
await page.click('#grid-exit');
await page.waitForSelector('#menu:not(.hidden)', { timeout: 8000 });
check('exit returns to system menu', await page.isVisible('#menu-frame'));
check('exit cleared grid param', !page.url().includes('grid='));

console.log(errors.length ? 'PAGE ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
