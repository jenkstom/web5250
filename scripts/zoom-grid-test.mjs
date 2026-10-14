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
check('canvas at half after reload', Math.abs((await canvasW()) - wFit / 2) <= 2);
check('reload reattached the same session', (await page.textContent('#dev-info')) === devBefore,
  `${JSON.stringify(await page.textContent('#dev-info'))} vs ${JSON.stringify(devBefore)}`);
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

// ---- 7b. rearrange tiles + tabs view - sessions must never reload
{
  // A sentinel that only survives as long as the iframe document does: a
  // DOM move of an iframe would reload it and wipe the value.
  for (const f of panes) await f.evaluate(() => { window.__sentinel = 42; });

  const wrapLefts = () => page.evaluate(() =>
    [...document.querySelectorAll('.grid-pane')].map((w) => w.getBoundingClientRect().left));
  const before = await wrapLefts();
  await page.evaluate(() => {
    // (the bar ends with the pop-out/close buttons; pick ▶ by title)
    const btn = [...document.querySelectorAll('.grid-pane .grid-pane-bar button')]
      .find((b) => b.title === 'Move this session right');
    btn.click();
  });
  const after = await wrapLefts();
  check('▶ moves the first tile right', after[0] > before[0] && after[1] < before[1],
    `${before.map(Math.round)} -> ${after.map(Math.round)}`);

  // Synthetic drag: drop the first pane's bar onto the second pane.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    const bar = document.querySelector('.grid-pane-bar');
    bar.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    const target = document.querySelectorAll('.grid-pane')[1];
    target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    bar.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
  });
  const dragged = await wrapLefts();
  check('drag onto a tile reorders back', Math.abs(dragged[0] - before[0]) <= 1,
    `${dragged.map(Math.round)}`);
  const sent = [];
  for (const f of panes) sent.push(await f.evaluate(() => window.__sentinel));
  check('rearranging did not reload the panes', sent.every((s) => s === 42), JSON.stringify(sent));

  // Tabs view: one pane on stage, the other hidden but still connected.
  await page.click('#grid-view-tabs');
  check('tab bar visible in tabs mode', await page.isVisible('#grid-tabbar'));
  const visible = await page.evaluate(() =>
    [...document.querySelectorAll('.grid-pane')].map((w) => w.style.display !== 'none'));
  check('only the active pane is on stage', visible.filter(Boolean).length === 1, JSON.stringify(visible));
  const hiddenState = await panes[1].evaluate(() => document.getElementById('conn-state')?.dataset.state);
  check('hidden pane stays connected', hiddenState === 'connected', String(hiddenState));

  const tabTexts = await page.evaluate(() =>
    [...document.querySelectorAll('.grid-tab')].map((t) => t.textContent));
  check('tabs show system · device names',
    // (names are relative: earlier runs' sessions may still hold MULTI/MULTI1
    // in re-attach grace, so this run legitimately gets suffixed names)
    tabTexts[0]?.includes('MULTI') && tabTexts[1]?.includes('MULTI') && tabTexts[0] !== tabTexts[1],
    tabTexts.join(' | '));

  // Switch to the second tab via the tab strip.
  await page.evaluate(() => document.querySelectorAll('.grid-tab')[1].click());
  await page.waitForTimeout(200);
  const vis2 = await page.evaluate(() =>
    [...document.querySelectorAll('.grid-pane')].map((w) => w.style.display !== 'none'));
  check('tab switch moves the stage', vis2[0] === false && vis2[1] === true, JSON.stringify(vis2));
  const fills = await page.evaluate(() => {
    const w = document.querySelector('.grid-pane:not([style*="none"])').getBoundingClientRect();
    const g = document.getElementById('grid-panes').getBoundingClientRect();
    return { paneW: w.width, gridW: g.width, paneH: w.height, gridH: g.height };
  });
  check('tabbed pane fills the whole area',
    fills.paneW > fills.gridW * 0.95 && fills.paneH > fills.gridH * 0.95, JSON.stringify(fills));
  await page.screenshot({ path: `${OUT}/05-tabs.png` });

  // Back to tiles: everything on stage again and still alive.
  await page.click('#grid-view-tiles');
  const vis3 = await page.evaluate(() =>
    [...document.querySelectorAll('.grid-pane')].map((w) => w.style.display !== 'none'));
  check('tiles view shows every pane again', vis3.every(Boolean), JSON.stringify(vis3));
  const states = [];
  for (const f of panes) {
    states.push(await f.evaluate(() => document.getElementById('conn-state')?.dataset.state));
  }
  check('both sessions still connected after switching', states.every((s) => s === 'connected'), states.join(' | '));
  const sent2 = [];
  for (const f of panes) sent2.push(await f.evaluate(() => window.__sentinel));
  check('view switches did not reload the panes', sent2.every((s) => s === 42), JSON.stringify(sent2));

  // The view choice persists across a reload - and the panes reattach to
  // their running sessions (grid state carries their tokens).
  await page.click('#grid-view-tabs');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(800); // panes boot
  check('tabs mode persists across reload', await page.isVisible('#grid-tabbar'));
  const reframes = page.frames().filter((f) => f !== page.mainFrame());
  check('reloaded grid has both panes', reframes.length === 2, String(reframes.length));
  for (const f of reframes) {
    await f.waitForFunction(
      () => document.getElementById('conn-state')?.dataset.state === 'connected',
      null,
      { timeout: 12000 }
    );
  }
  const devnames = [];
  for (const f of reframes) devnames.push(await f.evaluate(() => document.getElementById('dev-info')?.textContent ?? ''));
  check(
    'panes reattached to their sessions (same devices)',
    devnames.length === 2 && devnames.every((d) => d.includes('MULTI')),
    JSON.stringify(devnames)
  );

  // ---- 7c. dynamic panes: + adds, × closes, ⧉ pops a session out to a
  // real browser window (which takes the session over from the pane).
  await page.click('#grid-view-tiles');
  await page.waitForTimeout(200);

  await page.click('#grid-add');
  await page.waitForTimeout(800);
  check('+ adds a pane', (await page.evaluate(() => document.querySelectorAll('.grid-pane').length)) === 3);
  check('layout follows the pane count', await page.evaluate(() => document.getElementById('grid-panes').dataset.panes === '3'));

  // Pop out the first pane (MULTI): a popup window opens and reattaches to
  // the same session while the pane disappears from the grid.
  const popBtn = page.locator('.grid-pane .grid-pane-bar button[title*="own window"]').first();
  const [popup] = await Promise.all([page.waitForEvent('popup'), popBtn.click()]);
  await popup.waitForFunction(
    () => document.getElementById('conn-state')?.dataset.state === 'connected',
    null,
    { timeout: 12000 }
  );
  const popDev = await popup.evaluate(() => document.getElementById('dev-info')?.textContent ?? '');
  check('popped-out window took over the session', popDev.includes('MULTI'), popDev);
  await page.waitForTimeout(400);
  check('pane removed after pop-out', (await page.evaluate(() => document.querySelectorAll('.grid-pane').length)) === 2);
  await popup.close();

  // Close a pane: its session detaches (grace) and the grid shrinks.
  const closeBtn = page.locator('.grid-pane .grid-pane-bar button[title^="Close this pane"]').first();
  await closeBtn.click();
  await page.waitForTimeout(400);
  check('× closes a pane', (await page.evaluate(() => document.querySelectorAll('.grid-pane').length)) === 1);
  const lastState = await page
    .frames()
    .filter((f) => f !== page.mainFrame())[0]
    .evaluate(() => document.getElementById('conn-state')?.dataset.state);
  check('surviving pane still connected', lastState === 'connected', String(lastState));

  // Adding again works after closing (the + button re-enables).
  await page.click('#grid-add');
  await page.waitForTimeout(600);
  check('+ re-enabled and adds again', (await page.evaluate(() => document.querySelectorAll('.grid-pane').length)) === 2);
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
