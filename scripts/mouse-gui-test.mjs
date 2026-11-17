// E2E for IBM_I_MOUSE_GUI: with the flag the 5250 query reply claims a
// pointer device (visible in the Diag export), a 5494-dialect host programs
// the mouse per screen (the mock conditions its mouse SF on the claim, like
// a real host) - right-click then opens the host's own menu instead of the
// local Copy/Paste one, picking a choice runs the host's action, and
// Shift+right-click keeps the local menu. Without the flag nothing is
// programmed and right-click stays local. Uses SHOW_DIAG_BUTTON=1 so the
// query-reply line can be asserted from the browser.
// Usage: npm run build && node scripts/mouse-gui-test.mjs
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { chromium } from 'playwright-core';

let HTTP_PORT = 18220;
let MOCK_PORT = 18166;
const DB = '/tmp/web5250-mousegui.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  [${cond ? 'ok' : 'FAIL'}] ${name}${cond ? '' : ' - ' + detail}`);
  if (!cond) failures++;
};

const procs = [];
process.on('exit', () => procs.forEach((p) => p.kill()));
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

// Boot mock + gateway with the given extra env, drive to the work list.
// Returns the page plus stop(): the phase's processes must die (and the
// SQLite file WITH its WAL sidecars go) before the next phase boots on the
// same DB path.
async function toWorkList(extraEnv) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(DB + suffix, { force: true });
  const phaseProcs = [];
  procs.push(phaseProcs);
  const mockPort = ++MOCK_PORT;
  const httpPort = ++HTTP_PORT;
  const mock = spawn(process.execPath, ['dist/mock-host.mjs', String(mockPort)], { stdio: 'inherit' });
  phaseProcs.push(mock);
  await sleep(300);
  const srv = spawn(process.execPath, ['dist/server.js'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(httpPort),
      IBM_I_HOST: '127.0.0.1',
      IBM_I_PORT: String(mockPort),
      WEB5250_DB: DB,
      SHOW_DIAG_BUTTON: '1',
      ...extraEnv
    }
  });
  phaseProcs.push(srv);
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${httpPort}/healthz`)).ok) break;
    } catch {}
    await sleep(200);
  }
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${httpPort}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });
  await page.click('#menu .menu-row');
  await page.waitForFunction(
    () => document.getElementById('conn-state')?.dataset.state === 'connected',
    undefined,
    { timeout: 10000 }
  );
  await sleep(600); // font settle + first render
  const cellXY = (r, c) =>
    page.evaluate(
      ([r, c]) => {
        const b = document.getElementById('screen-canvas').getBoundingClientRect();
        return { x: b.left + (c - 0.5) * (b.width / 80), y: b.top + (r - 0.5) * (b.height / 24) };
      },
      [r, c]
    );
  const { x, y } = await cellXY(9, 45);
  await page.mouse.click(x, y);
  await page.keyboard.type('MOCKUSER');
  await page.keyboard.press('Tab');
  await page.keyboard.type('SECRETPW');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.getElementById('oia-pos')?.textContent === '6,26',
    undefined,
    { timeout: 8000 }
  );
  await sleep(400);
  // Option 4 -> WORK WITH DEMO ITEMS (cursor lands at 7,8).
  const sel = await cellXY(6, 26);
  await page.mouse.click(sel.x, sel.y);
  await page.keyboard.type('4');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.getElementById('oia-pos')?.textContent === '7,8',
    undefined,
    { timeout: 8000 }
  );
  await sleep(400);
  return { page, stop: () => phaseProcs.forEach((p) => p.kill()) };
}

async function localMenuOpen(page) {
  await sleep(400);
  return page.evaluate(() => !document.getElementById('ctx-menu')?.classList.contains('hidden'));
}

// --- with IBM_I_MOUSE_GUI=1 --------------------------------------------------
{
  const { page, stop } = await toWorkList({ IBM_I_MOUSE_GUI: '1' });
  console.log('IBM_I_MOUSE_GUI=1:');

  // The query reply claims a pointer device - straight from the Diag export.
  await page.click('#btn-diag');
  await sleep(400);
  const diag = await page.evaluate(() => navigator.clipboard.readText());
  check('query reply claims pointer device (Diag export)', diag.includes('query reply claims pointer device (b53=17 b54=88)'), diag.slice(0, 200));

  // Right-click a list row: the host programmed this screen's right button,
  // so the click goes to the host (menu flow: save image -> host menu).
  const row = await cellXY9(page, 9, 15);
  const t0 = Date.now();
  await page.mouse.click(row.x, row.y, { button: 'right' });
  let sawHostMenu = false;
  try {
    // Not waitForSelector: the framed menu container itself is zero-size
    // (the choices are absolutely positioned inside it), so Playwright's
    // visibility rules would never see it - the class is the truth.
    await page.waitForFunction(
      () => !document.getElementById('host-menu')?.classList.contains('hidden'),
      undefined,
      { timeout: 8000 }
    );
    sawHostMenu = true;
  } catch {}
  console.log(`    (host menu after ${Date.now() - t0} ms)`);
  check('host-programmed right-click opens the host menu', sawHostMenu);
  check('local Copy/Paste menu stayed closed', !(await localMenuOpen(page)));
  check('host menu offers the application choices', (await page.textContent('#host-menu')).includes('1=Select item'));

  // Picking a choice runs the host action and closes the menu.
  await page.click('#host-menu >> text=1=Select item');
  await sleep(500);
  check('pick runs the host action', (await screenText(page)).includes('Menu pick 1 processed.'));
  check('host menu closed after the pick', await page.evaluate(() => document.getElementById('host-menu')?.classList.contains('hidden')));

  // Shift+right-click is the documented escape hatch to the local menu.
  await page.keyboard.press('Escape'); // close the menu screenText opened
  await sleep(200);
  const row2 = await cellXY9(page, 10, 15);
  await page.keyboard.down('Shift');
  await page.mouse.click(row2.x, row2.y, { button: 'right' });
  await page.keyboard.up('Shift');
  check('Shift+right-click opens the local menu anyway', await localMenuOpen(page));
  await page.keyboard.press('Escape');
  await page.close();
  stop();
  await sleep(300);
}

// --- without the flag --------------------------------------------------------
{
  const { page, stop } = await toWorkList({});
  console.log('IBM_I_MOUSE_GUI unset:');
  const diagBtn = await page.isVisible('#btn-diag');
  check('Diag button present (SHOW_DIAG_BUTTON)', diagBtn);
  await page.click('#btn-diag');
  await sleep(400);
  const diag = await page.evaluate(() => navigator.clipboard.readText());
  check('query reply claims no pointer device', !diag.includes('claims pointer device'));

  const row = await cellXY9(page, 9, 15);
  await page.mouse.click(row.x, row.y, { button: 'right' });
  check('unclaimed pointer: right-click stays local', await localMenuOpen(page));
  await page.keyboard.press('Escape');
  await page.close();
  stop();
}

async function cellXY9(page, r, c) {
  return page.evaluate(
    ([r, c]) => {
      const b = document.getElementById('screen-canvas').getBoundingClientRect();
      return { x: b.left + (c - 0.5) * (b.width / 80), y: b.top + (r - 0.5) * (b.height / 24) };
    },
    [r, c]
  );
}

async function screenText(page) {
  // Shift+right-click so the local menu opens even on host-programmed screens.
  const b = await page.evaluate(() => document.getElementById('screen-canvas').getBoundingClientRect());
  await page.keyboard.down('Shift');
  await page.mouse.click(b.left + b.width / 2, b.top + b.height / 2, { button: 'right' });
  await page.keyboard.up('Shift');
  await page.waitForSelector('#ctx-menu:not(.hidden)', { timeout: 3000 });
  await page.click('#ctx-copy');
  await sleep(150);
  return page.evaluate(() => navigator.clipboard.readText());
}

await browser.close();
console.log(failures === 0 ? 'ALL OK' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
