// Zoom + split-view E2E: drives the real UI in headless Chromium against the
// gateway + mock host. Covers the zoom buttons (Fit / ½ / ¼), the in-place
// split tree (splitting a pane nests; dividers drag to resize), per-pane
// sessions with display name dedupe, keyboard focus routing, tiles/tabs
// modes, reload reattach, pane add/close and pop-out.
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
check('menu has Split ↔ button', await page.isVisible('#menu-splith'));
check('menu has Split ↕ button', await page.isVisible('#menu-splitv'));

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

// ---- 5. Systems → menu → Split ↔ (in place - no navigation, one shell)
page.once('dialog', (d) => void d.accept().catch(() => {})); // Systems ends the live session: asks
await page.click('#btn-systems');
await page.waitForSelector('#menu:not(.hidden)', { timeout: 5000 });
check('zoom group hidden again on menu', !(await page.isVisible('#zoom-group')));
await page.fill('#menu-devname', 'MULTI');
await page.click('#menu-splith');
await page.waitForSelector('#panes > .split.split-h', { timeout: 5000 });
check('split layout with 2 panes', (await page.locator('#panes .pane').count()) === 2);
check('still one app shell (no iframes)', (await page.locator('#panes iframe').count()) === 0);
check('URL kept ?grid=2', page.url().includes('grid=2'));
check('top bar still present', await page.isVisible('#topbar'));
// Each pane without a session shows its own in-pane picker; the full-window
// menu is gone.
await page.waitForSelector(`${paneSel(0)} .sys-menu .menu-row`, { timeout: 5000 });
await page.waitForSelector(`${paneSel(1)} .sys-menu .menu-row`, { timeout: 5000 });
check('a picker per empty pane', (await page.locator('.sys-menu').count()) === 2);
check('full-window menu closed', !(await page.isVisible('#menu')));
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/02-grid-menus.png` });

// ---- 6. sign on in both panes → two independent sessions
async function waitConnected() {
  await page.waitForFunction(
    () => document.getElementById('conn-state')?.dataset.state === 'connected',
    undefined,
    { timeout: 10000 }
  );
}
async function signOnActivePane(paneIdx = 0) {
  await waitConnected();
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
// Pane 2 (the fresh half) holds focus after a split - Enter picks its row.
await page.keyboard.press('Enter');
await signOnActivePane(1);
const name1 = await page.textContent('#dev-info');
check('pane 2 signed on (MULTI)', name1.includes('MULTI'), name1);

// Pane 1: its picker is already open in the other half - one click on the
// (already selected) row connects it and focuses the pane.
await page.click(`${paneSel(0)} .sys-menu .menu-row`);
await signOnActivePane(0);
const name0 = await page.textContent('#dev-info');
check('pane 1 signed on (deduped name)', name0.includes('MULTI') && name0 !== name1, `${name1} | ${name0}`);
await page.screenshot({ path: `${OUT}/03-grid-signedon.png` });

// ---- 6a. closing an active session asks first; dismissing keeps the pane.
// window.confirm is stubbed for these assertions: this Chromium/Playwright
// pair double-delivers dialog events and blocks the click until they are
// handled, which makes asserting on the native dialogs racy.
{
  await page.evaluate(() => {
    window.__nativeConfirm = window.confirm;
    window.__confirms = [];
    window.__confirmReply = false;
    window.confirm = (m) => {
      window.__confirms.push(m);
      return window.__confirmReply;
    };
  });
  await page.click(`${paneSel(0)} .pane-closebtn`);
  await page.waitForTimeout(300);
  const asked = await page.evaluate(() => window.__confirms);
  check('closing an active session asks', asked.length === 1 && asked[0].includes('End the current session'),
    JSON.stringify(asked));
  check('dismissing keeps the pane', (await page.locator('#panes .pane').count()) === 2);
}

// ---- 6b. split a pane in place: the focused pane halves, the rest is
// untouched; the divider between the halves is draggable.
{
  const paneBox = (i) => page.evaluate((i) => {
    const r = document.querySelector(`.pane[data-pane="${i}"]`).getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, i);

  // Split pane 2 (bottom of the pair) top-and-bottom: pane 2 keeps its
  // session in the upper half, a fresh pane 3 lands below it.
  await page.click(`${paneSel(1)} .pane-screen`);
  const fullH = await page.evaluate(() =>
    Math.round(document.querySelector('.pane[data-pane="1"]').getBoundingClientRect().height));
  await page.click(`${paneSel(1)} .pane-splitbtn-v`);
  await page.waitForTimeout(400);
  check('splitting a pane adds one', (await page.locator('#panes .pane').count()) === 3);
  check('the new pane gets a picker', (await page.locator('.sys-menu').count()) === 1);
  const [b0, b1, b2] = [await paneBox(0), await paneBox(1), await paneBox(2)];
  check('pane 1 untouched (left half)', Math.round(b0.right) <= Math.round(b1.left) + 1,
    `${JSON.stringify(b0)} | ${JSON.stringify(b1)}`);
  check('new pane stacks under pane 2', Math.abs(b1.left - b2.left) < 2 && b2.top > b1.bottom - 2,
    `${JSON.stringify(b1)} | ${JSON.stringify(b2)}`);
  // The new pane became the focused one (it needs the system pick); put the
  // focus back on pane 2 to see its session survived the split.
  await page.click(`${paneSel(1)} .pane-screen`);
  check('session survives being split',
    (await page.evaluate(() => document.getElementById('conn-state')?.dataset.state)) === 'connected');

  // Drag the divider between panes 2 and 3 down: pane 2 grows, 3 shrinks
  // (a ↕ split's divider moves vertically).
  const heights = () => page.evaluate(() =>
    [1, 2].map((i) => Math.round(document.querySelector(`.pane[data-pane="${i}"]`).getBoundingClientRect().height)));
  const hBefore = await heights();
  const sp = await page.evaluate(() => {
    const pane = document.querySelector('.pane[data-pane="2"]');
    const splitter = pane.parentElement.querySelector('.splitter');
    const r = splitter.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(sp.x, sp.y);
  await page.mouse.down();
  await page.mouse.move(sp.x, sp.y + 70, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const hAfter = await heights();
  check('divider drag resizes both sides',
    hAfter[0] > hBefore[0] + 50 && hAfter[1] < hBefore[1] - 50,
    `${hBefore} -> ${hAfter}`);
  check('sessions survive a resize',
    (await page.evaluate(() => document.getElementById('conn-state')?.dataset.state)) === 'connected');
  void fullH;
  await page.screenshot({ path: `${OUT}/03b-nested-split.png` });

  // Connect the fresh pane: it lands on the sign-on screen, and closing it
  // there is free - no confirm (the logon exception).
  await page.click(`${paneSel(2)} .sys-menu .menu-row`);
  await page.waitForTimeout(700);
  await page.evaluate(() => { window.__confirms = []; });
  await page.click(`${paneSel(2)} .pane-closebtn`);
  await page.waitForTimeout(400);
  const askedLogon = await page.evaluate(() => window.__confirms);
  check('closing on the sign-on screen asks nothing', askedLogon.length === 0, JSON.stringify(askedLogon));
  check('closing a pane collapses the split', (await page.locator('#panes .pane').count()) === 2);
  const hBack = await page.evaluate(() =>
    Math.round(document.querySelector('.pane[data-pane="1"]').getBoundingClientRect().height));
  check('pane 2 reclaims the space', Math.abs(hBack - fullH) < 12, `${hAfter[0]} -> ${hBack} (was ${fullH})`);
}

// ---- 7. typing goes only to the focused pane
{
  await page.evaluate(() => { window.confirm = window.__nativeConfirm; });
  await page.click(`${paneSel(0)} .pane-screen`);
  const { x, y } = await cellXY(10, 20);
  await page.mouse.click(x, y);
  const before = await panePos(0);
  const otherBefore = await panePos(1);
  await page.keyboard.type('X');
  await page.waitForFunction(
    (prev) => document.querySelector('.pane[data-pane="0"] .oia-pos')?.textContent !== prev,
    before,
    { timeout: 5000 }
  ).catch(() => {});
  const moved = await panePos(0);
  const other = await panePos(1);
  check('keystroke moved only pane 1 cursor', moved !== before && other === otherBefore,
    `${before} → ${moved}, pane2 at ${other} (was ${otherBefore})`);
}

// ---- 7a. drag a pane header onto the other pane: they swap places
{
  const labelOf = (i) => page.evaluate(
    (i) => document.querySelector(`.pane[data-pane="${i}"] .pane-label`)?.textContent, i);
  const before0 = await labelOf(0);
  const before1 = await labelOf(1);
  await page.dragAndDrop(`${paneSel(0)} .pane-label`, `${paneSel(1)} .pane-screen`);
  await page.waitForTimeout(300);
  check('dragging a header swaps panes',
    (await labelOf(0)) === before1 && (await labelOf(1)) === before0,
    `${before0} | ${before1} -> ${await labelOf(0)} | ${await labelOf(1)}`);
  check('sessions survive the swap',
    (await page.evaluate(() => document.getElementById('conn-state')?.dataset.state)) === 'connected');
  // And back, so the rest of the run keeps its assumptions about order.
  await page.dragAndDrop(`${paneSel(0)} .pane-label`, `${paneSel(1)} .pane-screen`);
  await page.waitForTimeout(300);
  check('swapping back restores the order',
    (await labelOf(0)) === before0 && (await labelOf(1)) === before1);
}

// ---- 7a-2. drop at a pane's EDGE: the dragged pane takes that side of the
// target's slot (drop on the middle stays a swap).
{
  const idxOf = (label) => page.evaluate(
    (label) => [...document.querySelectorAll('#panes .pane')]
      .findIndex((p) => p.querySelector('.pane-label')?.textContent === label), label);
  const labelOf = (i) => page.evaluate(
    (i) => document.querySelector(`.pane[data-pane="${i}"] .pane-label`)?.textContent, i);
  const boxOf = (i) => page.evaluate((i) => {
    const r = document.querySelector(`.pane[data-pane="${i}"]`).getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top) };
  }, i);

  // Three panes: one left, a top/bottom pair on the right.
  await page.click(`${paneSel(1)} .pane-splitbtn-v`);
  await page.waitForTimeout(300);
  const L0 = await labelOf(0);
  const L1 = await labelOf(1);
  const L2 = await labelOf(2);
  const sz = await page.evaluate(() => {
    const b = document.querySelector('.pane[data-pane="2"]').getBoundingClientRect();
    return { w: b.width, h: b.height };
  });

  // Drop pane 1 on pane 3's LEFT edge: pane 3's slot splits, pane 1 takes
  // the left half -> one pane on top, two side by side under it.
  await page.dragAndDrop(`${paneSel(0)} .pane-label`, `${paneSel(2)} .pane-screen`,
    { targetPosition: { x: 6, y: sz.h / 2 } });
  await page.waitForTimeout(300);
  const i0 = await idxOf(L0);
  const i1 = await idxOf(L1);
  const i2 = await idxOf(L2);
  const [b0, b1, b2] = [await boxOf(i0), await boxOf(i1), await boxOf(i2)];
  check('edge drop splits the target slot',
    i0 >= 0 && i1 >= 0 && i2 >= 0 && b1.top < b0.top && b0.left < b2.left && Math.abs(b0.top - b2.top) < 2,
    `L0@${JSON.stringify(b0)} L1@${JSON.stringify(b1)} L2@${JSON.stringify(b2)}`);
  await page.click(`${paneSel(i1)} .pane-screen`);
  check('sessions survive an edge drop',
    (await page.evaluate(() => document.getElementById('conn-state')?.dataset.state)) === 'connected');

  // Back to two panes in the original order for the sections below: close
  // the empty pane, then swap the pair back.
  const emptyIdx = await page.evaluate(
    () => document.querySelector('#panes .pane .sys-menu')?.closest('.pane')?.dataset.pane);
  await page.locator(`${paneSel(emptyIdx)} .pane-closebtn`).click();
  await page.waitForTimeout(300);
  await page.dragAndDrop(`${paneSel(await idxOf(L0))} .pane-label`, `${paneSel(await idxOf(L1))} .pane-screen`);
  await page.waitForTimeout(300);
  check('restored to the original two-pane order',
    (await idxOf(L0)) === 0 && (await idxOf(L1)) === 1);
}

// ---- 7b. tabs view - sessions must survive
{
  await page.click('#grid-view-tabs');
  check('tab strip visible in tabs mode', await page.isVisible('#tabbar'));
  const onStage = await page.locator('#panes .pane').count();
  check('only the active pane is on stage', onStage === 1, String(onStage));
  check('the solo tab pane fills the stage', await page.evaluate(() => {
    const pane = document.querySelector('#panes .pane').getBoundingClientRect();
    const wrap = document.getElementById('panes').getBoundingClientRect();
    return pane.height >= wrap.height * 0.85 && pane.width >= wrap.width * 0.85;
  }));

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
await page.waitForSelector('#tabbar:not(.hidden)', { timeout: 5000 });
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

// Close the empty pane (wherever the tree put it - find it by its picker):
// its session detaches (grace) and the layout shrinks to the still-connected
// pane - which is the classic single-session view again.
const emptyIdx = await page.evaluate(
  () => document.querySelector('#panes .pane .sys-menu')?.closest('.pane')?.dataset.pane);
await page.locator(`${paneSel(emptyIdx)} .pane-closebtn`).click();
await page.waitForTimeout(400);
check('× closes a pane', (await page.locator('#panes .pane').count()) === 1);
check('closing the last extra pane leaves the classic view',
  !(await page.locator('#panes .split').count()));
check('the last pane fills the stage', await page.evaluate(() => {
  const pane = document.querySelector('#panes .pane').getBoundingClientRect();
  const wrap = document.getElementById('panes').getBoundingClientRect();
  return pane.height >= wrap.height * 0.85 && pane.width >= wrap.width * 0.85;
}));
check('surviving pane still connected',
  await page.evaluate(() => document.getElementById('conn-state')?.dataset.state) === 'connected');

// Re-enter split from the menu: + Pane is back and adds again.
page.once('dialog', (d) => void d.accept().catch(() => {})); // Systems ends the live session: asks
await page.click('#btn-systems');
await page.waitForSelector('#menu:not(.hidden)', { timeout: 5000 });
await page.click('#menu-splith');
await page.waitForSelector('#panes > .split.split-h', { timeout: 5000 });
check('split re-entered from the menu', (await page.locator('#panes .pane').count()) === 2);
await page.click('#btn-addpane');
await page.waitForTimeout(600);
check('+ re-enabled and adds again', (await page.locator('#panes .pane').count()) === 3);

// A closed pane ends its session outright, so its device name frees
// immediately (no grace zombie): the next pane to connect gets it back.
{
  const devOf = (i) => page.evaluate(
    (i) => document.querySelector(`.pane[data-pane="${i}"] .pane-label`)?.textContent?.split(' · ')[1], i);
  const emptyIdx = await page.evaluate(
    () => document.querySelector('#panes .pane .sys-menu')?.closest('.pane')?.dataset.pane);
  await page.click(`${paneSel(emptyIdx)} .sys-menu .menu-row`);
  await page.waitForTimeout(900);
  const freedDev = await devOf(emptyIdx);
  await page.click(`${paneSel(emptyIdx)} .pane-closebtn`); // sign-on screen: no confirm
  await page.waitForTimeout(400);
  await page.click('#btn-addpane');
  await page.waitForTimeout(600);
  const empty2 = await page.evaluate(
    () => document.querySelector('#panes .pane .sys-menu')?.closest('.pane')?.dataset.pane);
  await page.click(`${paneSel(empty2)} .sys-menu .menu-row`);
  await page.waitForTimeout(900);
  check('a closed pane frees its device name', (await devOf(empty2)) === freedDev,
    `${freedDev} -> ${await devOf(empty2)}`);
}

// ---- 8. preassigned deep link ?grid=2&systems=1,1 connects both panes
await page.goto(`${BASE}/?grid=2&systems=1,1`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#panes > .split.split-h', { timeout: 5000 });
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
page.once('dialog', (d) => void d.accept().catch(() => {})); // Exit split ends the extra session
await page.click('#btn-exitsplit');
await page.waitForTimeout(500);
check('back to single pane', (await page.locator('#panes .pane').count()) === 1);
check('split layout gone', !(await page.locator('#panes .split').count()));
check('exit cleared grid param', !page.url().includes('grid='));
check('remaining session still connected',
  await page.evaluate(() => document.getElementById('conn-state')?.dataset.state) === 'connected');

console.log(errors.length ? 'PAGE ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(errors.length || failed ? 1 : 0);
