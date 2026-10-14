// Zoom + split-view E2E: drives the real UI in headless Chromium against the
// gateway + mock host. Covers the zoom buttons (Fit / ½ / ¼), the in-place
// split view (one shell, N terminal panes), per-pane sessions with display
// name dedupe, keyboard focus routing, tiles/tabs modes, reload reattach,
// pane add/close and pop-out.
//
// Usage: node scripts/zoom-grid-test.mjs [port]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';

const PORT = process.argv[2] ?? '18092';
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
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write']
});
const page = await context.newPage();

const errors = [];
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push('console: ' + msg.text());
});

let failed = 0;
function check(name, cond, detail = '') {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || !detail ? '' : ' — ' + detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Viewport coordinates of the centre of a 1-based cell of pane 0's canvas
// (the zoom checks run single-pane; the split sections aim clicks per pane).
const cellXY = (r, c, sel = '#screen-canvas') =>
  page.evaluate(
    ([r, c, sel]) => {
      const b = document.querySelector(sel).getBoundingClientRect();
      const cols = Number(sel === '#screen-canvas' ? 80 : 80);
      const rows = 24;
      return { x: b.left + (c - 0.5) * (b.width / cols), y: b.top + (r - 0.5) * (b.height / rows) };
    },
    [r, c, sel]
  );
const canvasW = () => page.evaluate(() => document.getElementById('screen-canvas').getBoundingClientRect().width);
const paneSel = (i) => `.pane[data-pane="${i}"]`;
const panePos = (i) => page.evaluate((i) => document.querySelector(`.pane[data-pane="${i}"] .oia-pos`)?.textContent, i);
const waitForPos = (i, want, timeout = 5000) =>
  page.waitForFunction(
    ([i, w]) => document.querySelector(`.pane[data-pane="${i}"] .oia-pos`)?.textContent === w,
    [i, want],
    { timeout }
  ).then(() => true, () => false);

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

// ---- 1. menu state
await page.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });
check('zoom group hidden on menu', !(await page.isVisible('#zoom-group')));
check('menu has Split ×2 button', await page.isVisible('#menu-split2'));
check('menu has Split ×4 button', await page.isVisible('#menu-split4'));

// ---- 2. connect: zoom group appears, Fit is active
await page.click('#menu .menu-row');
await page.waitForFunction(
  () => document.getElementById('conn-state')?.dataset.state === 'connected',
  undefined,
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

// ---- 4. zoom choice survives reload (½ still selected now) - and the
// session itself survives: the reloaded page reattaches to the running
// gateway-side session instead of dropping back to the menu.
await page.click('#btn-half');
const devBefore = await page.textContent('#dev-info');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => document.getElementById('conn-state')?.dataset.state === 'connected',
  undefined,
  { timeout: 10000 }
);
check('½ active after reload (persisted)', await page.evaluate(() => document.getElementById('btn-half').classList.contains('active')));
await page.waitForTimeout(500); // fit settles after the reattached screen lands
check('canvas at half after reload', Math.abs((await canvasW()) - wFit / 2) <= 2);
check('reload reattached the same session', (await page.textContent('#dev-info')) === devBefore,
  `${JSON.stringify(await page.textContent('#dev-info'))} vs ${JSON.stringify(devBefore)}`);
await page.click('#btn-fit');

// ---- 5. Systems → menu → Split ×2 (in place - no navigation, one shell)
await page.click('#btn-systems');
await page.waitForSelector('#menu:not(.hidden)', { timeout: 5000 });
check('zoom group hidden again on menu', !(await page.isVisible('#zoom-group')));
await page.fill('#menu-devname', 'MULTI');
await page.click('#menu-split2');
await page.waitForSelector('#panes.split', { timeout: 5000 });
check('split layout with 2 panes', (await page.locator('#panes .pane').count()) === 2);
check('still one app shell (no iframes)', (await page.locator('#panes iframe').count()) === 0);
check('URL kept ?grid=2', page.url().includes('grid=2'));
check('top bar still present', await page.isVisible('#topbar'));
// The shared menu reopens for the first pane without a session.
await page.waitForSelector('#menu:not(.hidden)', { timeout: 5000 });
check('menu reopened for the empty pane', true);
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/02-grid-menus.png` });

// ---- 6. sign on in both panes → two independent sessions
// Pane 0: the reopened menu is already targeting it.
async function signOnActivePane(paneIdx = 0) {
  await page.keyboard.press('Enter'); // picks the selected system row
  await page.waitForFunction(
    () => document.getElementById('conn-state')?.dataset.state === 'connected',
    undefined,
    { timeout: 10000 }
  );
  const { x, y } = await cellXY(9, 45, `${paneSel(paneIdx)} canvas`);
  await page.mouse.click(x, y);
  await page.keyboard.type('MOCKUSER');
  await page.keyboard.press('Tab');
  await page.keyboard.type('SECRETPW');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => !(document.querySelector('.pane.active-pane .oia-msg')?.textContent ?? '').includes('error'),
    undefined,
    { timeout: 8000 }
  );
  await page.waitForTimeout(600);
}
await signOnActivePane(0);
const name0 = await page.textContent('#dev-info');
check('pane 1 signed on (MULTI)', name0.includes('MULTI'), name0);

// Pane 2: click it (focus), open its menu via the pane header, sign on.
await page.click(`${paneSel(1)} .pane-screen`);
await page.click(`${paneSel(1)} .pane-menubtn`);
await page.waitForSelector('#menu:not(.hidden)', { timeout: 5000 });
await signOnActivePane(1);
const name1 = await page.textContent('#dev-info');
check('pane 2 signed on (deduped name)', name1.includes('MULTI') && name1 !== name0, `${name0} | ${name1}`);
await page.screenshot({ path: `${OUT}/03-grid-signedon.png` });

// ---- 7. typing goes only to the focused pane
{
  await page.click(`${paneSel(0)} .pane-screen`);
  const { x, y } = await cellXY(10, 20);
  await page.mouse.click(x, y);
  const before = await panePos(0);
  await page.keyboard.type('X');
  await page.waitForFunction(
    (prev) => document.querySelector('.pane[data-pane="0"] .oia-pos')?.textContent !== prev,
    before,
    { timeout: 5000 }
  ).catch(() => {});
  const moved = await panePos(0);
  const other = await panePos(1);
  check('keystroke moved only pane 1 cursor', moved !== before && other === '6,26', `${before} → ${moved}, pane2 at ${other}`);
}

// ---- 7b. rearrange tiles + tabs view - sessions must survive
{
  // track the same pane by its stable data-pane index (DOM order changes)
  const paneLefts = () => page.evaluate(() =>
    [0, 1].map((i) => document.querySelector(`.pane[data-pane="${i}"]`).getBoundingClientRect().left));
  const before = await paneLefts();
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.pane[data-pane="0"] .pane-bar button')]
      .find((b) => b.title === 'Move this session right');
    btn.click();
  });
  const after = await paneLefts();
  check('▶ moves the first pane right', after[0] > before[0] && after[1] < before[1],
    `${before.map(Math.round)} -> ${after.map(Math.round)}`);

  await page.click('#grid-view-tabs');
  check('tab strip visible in tabs mode', await page.isVisible('#tabbar'));
  const visible = await page.evaluate(() =>
    [...document.querySelectorAll('#panes .pane')].map((w) => w.style.display !== 'none'));
  check('only the active pane is on stage', visible.filter(Boolean).length === 1, JSON.stringify(visible));

  // Switch panes through the tab strip; the hidden ones stay connected.
  const tabs = page.locator('#tabbar .tab');
  check('one tab per pane', (await tabs.count()) === 2);
  const states = [];
  for (let i = 0; i < 2; i++) {
    await tabs.nth(i).click();
    states.push(await page.textContent('#conn-state'));
  }
  check('both sessions still connected after switching', states.every((s) => s === 'connected'), states.join(' | '));
  const devnames = [];
  for (let i = 0; i < 2; i++) {
    await tabs.nth(i).click();
    devnames.push(await page.textContent('#dev-info'));
  }
  check('dev-info follows the focused pane', devnames[0] === name0 && devnames[1] === name1, devnames.join(' | '));
}

// The view choice persists across a reload - and the panes reattach to
// their running sessions (grid state carries their tokens).
await page.click('#grid-view-tabs');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#panes.split.tabs', { timeout: 5000 });
await page.waitForTimeout(800); // panes boot + reattach
check('tabs mode persists across reload', await page.isVisible('#tabbar'));
const tabs = page.locator('#tabbar .tab');
check('tab strip rebuilt after reload', (await tabs.count()) === 2);
const devnames = [];
for (let i = 0; i < 2; i++) {
  await tabs.nth(i).click();
  await page.waitForFunction(
    () => document.getElementById('conn-state')?.dataset.state === 'connected',
    undefined,
    { timeout: 12000 }
  );
  devnames.push(await page.textContent('#dev-info'));
}
check(
  'panes reattached to their sessions (same devices)',
  devnames.length === 2 && devnames.every((d) => d.includes('MULTI')) && devnames[0] !== devnames[1],
  JSON.stringify(devnames)
);

// ---- 7c. dynamic panes: + adds, × closes, ↗ pops a session out to a
// real browser window (which takes the session over from the pane).
await page.click('#grid-view-tiles');
await page.waitForTimeout(200);

await page.click('#btn-addpane');
await page.waitForTimeout(800);
check('+ adds a pane', (await page.locator('#panes .pane').count()) === 3);
check('layout follows the pane count', await page.evaluate(() => document.getElementById('panes').dataset.panes === '3'));

// Pop out the first pane: a popup window opens and reattaches to the same
// session while the pane disappears from the layout.
const popBtn = page.locator('.pane[data-pane="0"] .pane-popbtn');
const [popup] = await Promise.all([page.waitForEvent('popup'), popBtn.click()]);
await popup.waitForFunction(
  () => document.getElementById('conn-state')?.dataset.state === 'connected',
  undefined,
  { timeout: 12000 }
);
const popDev = await popup.evaluate(() => document.getElementById('dev-info')?.textContent ?? '');
check('popped-out window took over the session', popDev.includes('MULTI'), popDev);
await page.waitForTimeout(400);
check('pane removed after pop-out', (await page.locator('#panes .pane').count()) === 2);
await popup.close();

// Close the empty pane: its session detaches (grace) and the layout
// shrinks to the still-connected pane.
const closeBtn = page.locator('.pane[data-pane="1"] .pane-closebtn');
await closeBtn.click();
await page.waitForTimeout(400);
check('× closes a pane', (await page.locator('#panes .pane').count()) === 1);
check('surviving pane still connected',
  await page.evaluate(() => document.getElementById('conn-state')?.dataset.state) === 'connected');

// Adding again works after closing (the + button re-enables).
await page.click('#btn-addpane');
await page.waitForTimeout(600);
check('+ re-enabled and adds again', (await page.locator('#panes .pane').count()) === 2);

// ---- 8. preassigned deep link ?grid=2&systems=1,1 connects both panes
await page.goto(`${BASE}/?grid=2&systems=1,1`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#panes.split', { timeout: 5000 });
check('deep link spawns two panes', (await page.locator('#panes .pane').count()) === 2);
for (let i = 0; i < 2; i++) {
  await page.click(`${paneSel(i)} .pane-screen`);
  await page.waitForFunction(
    () => document.getElementById('conn-state')?.dataset.state === 'connected',
    undefined,
    { timeout: 12000 }
  );
}
check('preassigned panes both connected without interaction', true);
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/04-grid-deeplink.png` });

// ---- 9. Exit split returns to the single-pane app (pane 1's session ends,
// pane 0's keeps running - it is the app's only session again).
await page.click('#btn-exitsplit');
await page.waitForTimeout(500);
check('back to single pane', (await page.locator('#panes .pane').count()) === 1);
check('split layout gone', !(await page.locator('#panes.split').count()));
check('exit cleared grid param', !page.url().includes('grid='));
check('remaining session still connected',
  await page.evaluate(() => document.getElementById('conn-state')?.dataset.state) === 'connected');

console.log(errors.length ? 'PAGE ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(errors.length || failed ? 1 : 0);
