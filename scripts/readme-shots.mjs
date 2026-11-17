// Regenerates the README screenshots under docs/screenshots/ against the
// mock host. The systems catalog is mocked up through the admin API (extra
// rows carry fake hosts - only the first row actually connects), and the
// SQL entry screen is reached with STRSQL on the mock main menu's command
// line. The pasted statement goes through the real 1.5 paste path (Ctrl+V
// in the browser), so the shot shows the feature, not painted cells.
// Usage: npm run build && node scripts/readme-shots.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright-core';

const MOCK_PORT = 18161;
const HTTP_PORT = 18210;
const DB = '/tmp/web5250-readme.db';
const OUT = 'docs/screenshots';
const PIN = '2026';
const SQL = [
  'select pucustomer  as id,',
  '       pucustomer  as label,',
  '       pucomm      as info',
  '  from pucustomer',
  " where pustat = 'A'"
].join('\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });
rmSync(DB, { force: true });

const procs = [];
process.on('exit', () => procs.forEach((p) => p.kill()));
procs.push(spawn(process.execPath, ['dist/mock-host.mjs', String(MOCK_PORT)], { stdio: 'inherit' }));
await sleep(300);
procs.push(
  spawn(process.execPath, ['dist/server.js'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(HTTP_PORT),
      IBM_I_HOST: '127.0.0.1',
      IBM_I_PORT: String(MOCK_PORT),
      WEB5250_DB: DB,
      ADMIN_PIN: PIN
    }
  })
);
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${HTTP_PORT}/healthz`)).ok) break;
  } catch {}
  await sleep(200);
}

// --- mock up the system catalog (admin API; only the first row connects) ---
{
  const base = `http://127.0.0.1:${HTTP_PORT}/api`;
  const auth = await (
    await fetch(`${base}/admin/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: PIN })
    })
  ).json();
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` };
  const listed = await (await fetch(`${base}/admin/systems`, { headers })).json();
  const rows = Array.isArray(listed) ? listed : (listed.systems ?? []);
  const first = rows[0];
  const send = async (url, method, body) => {
    const res = await fetch(url, { method, headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`admin ${method} ${url}: ${await res.text()}`);
  };
  if (first) {
    await send(`${base}/admin/systems/${first.id}`, 'PUT', {
      name: 'AOS iSeries',
      description: 'Production partition - QINTER',
      host: '127.0.0.1',
      port: MOCK_PORT,
      ssl: false,
      termType: 'IBM-3477-FC',
      codePage: 'cp037'
    });
  }
  await send(`${base}/admin/systems`, 'POST', { name: 'DEV740', description: 'Developer partition (V7R4)', host: 'dev740.example.org', port: 992, ssl: true, termType: 'IBM-3477-FC', codePage: 'cp037' });
  await send(`${base}/admin/systems`, 'POST', { name: 'WRKINQ', description: 'Batch and report host', host: 'wrkinq.example.org', termType: 'IBM-3477-FC', codePage: 'cp037', proxyHost: '192.168.40.22', proxyPort: 1080 });
  await send(`${base}/admin/systems`, 'POST', { name: 'CLOSE', description: 'Period-end close', host: 'payroll.example.org', termType: 'IBM-3477-FC', codePage: 'cp037', signOnUser: 'CLOSEJOB', signOnPassword: 'stored' });
}

// --- browser ----------------------------------------------------------------
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
page.on('pageerror', (err) => console.log('pageerror:', err.message));
page.on('dialog', (d) => void d.accept().catch(() => {})); // Systems ends the live session: asks

// Viewport coordinates of the centre of a 1-based cell, in the whole-window
// terminal or in a split pane's canvas.
const cellXY = (r, c, sel = '#screen-canvas') =>
  page.evaluate(
    ([r, c, sel]) => {
      const b = document.querySelector(sel).getBoundingClientRect();
      return { x: b.left + (c - 0.5) * (b.width / 80), y: b.top + (r - 0.5) * (b.height / 24) };
    },
    [r, c, sel]
  );
const paneSel = (i) => `.pane[data-pane="${i}"]`;
const oia = (i = -1) =>
  i < 0
    ? page.evaluate(() => document.getElementById('oia-pos')?.textContent)
    : page.evaluate((i) => document.querySelector(`.pane[data-pane="${i}"] .oia-pos`)?.textContent, i);
const awaitPos = async (want, i = -1) =>
  page
    .waitForFunction(
      ([w, i]) =>
        (i < 0
          ? document.getElementById('oia-pos')?.textContent
          : document.querySelector(`.pane[data-pane="${i}"] .oia-pos`)?.textContent) === w,
      [want, i],
      { timeout: 8000 }
    )
    .then(
      () => true,
      () => false
    );

// Type credentials into the User field of whatever screen the active pane
// shows (sign-on), then submit and wait for the main menu cursor.
async function signOn(paneIdx = -1) {
  const sel = paneIdx < 0 ? '#screen-canvas' : `${paneSel(paneIdx)} canvas`;
  const { x, y } = await cellXY(9, 45, sel);
  await page.mouse.click(x, y);
  await page.keyboard.type('MOCKUSER');
  await page.keyboard.press('Tab');
  await page.keyboard.type('SECRETPW');
  await page.keyboard.press('Enter');
  if (!(await awaitPos('6,26', paneIdx))) throw new Error(`sign-on did not reach the menu (${paneIdx})`);
  await sleep(500); // font settle
}

// Drive the active pane to the SQL entry screen, paste the statement, and
// leave the cursor blinking at the end of the last pasted line.
async function sqlWithPaste(paneIdx = -1) {
  const sel = paneIdx < 0 ? '#screen-canvas' : `${paneSel(paneIdx)} canvas`;
  {
    const { x, y } = await cellXY(19, 26, sel);
    await page.mouse.click(x, y);
  }
  await page.keyboard.type('STRSQL');
  await page.keyboard.press('Enter');
  if (!(await awaitPos('5,7', paneIdx))) throw new Error(`STRSQL did not open (${paneIdx})`);
  {
    const { x, y } = await cellXY(5, 7, sel);
    await page.mouse.click(x, y);
  }
  await page.evaluate((t) => navigator.clipboard.writeText(t), SQL);
  await page.keyboard.press('Control+v');
  await sleep(700); // the paste types line by line
}

await page.goto(`http://127.0.0.1:${HTTP_PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });
await sleep(400); // font settle
await page.screenshot({ path: `${OUT}/menu.png` });

await page.click('#menu .menu-row');
await page.waitForFunction(
  () => document.getElementById('conn-state')?.dataset.state === 'connected',
  undefined,
  { timeout: 10000 }
);
await sleep(600);
{
  const { x, y } = await cellXY(9, 45);
  await page.mouse.click(x, y);
}
await page.keyboard.type('MOCKUSER');
await page.keyboard.press('Tab');
await page.screenshot({ path: `${OUT}/signon.png` });
await page.keyboard.type('SECRETPW');
await page.keyboard.press('Enter');
if (!(await awaitPos('6,26'))) throw new Error('sign-on did not reach the menu');
await sleep(500);
await page.screenshot({ path: `${OUT}/main-menu.png` });

{
  const { x, y } = await cellXY(6, 26);
  await page.mouse.click(x, y);
}
await page.keyboard.type('4');
await page.keyboard.press('Enter');
if (!(await awaitPos('7,8'))) throw new Error('option 4 did not open the list');
await sleep(400);
await page.screenshot({ path: `${OUT}/worklist.png` });

await page.keyboard.press('F3');
if (!(await awaitPos('6,26'))) throw new Error('F3 did not leave the list');
await sqlWithPaste();
await page.screenshot({ path: `${OUT}/sql-paste.png` });

// Split view: end the session (Systems asks - dialogs auto-accepted), name
// the device, split in place, then bring both panes up independently.
await page.click('#btn-systems');
await page.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 5000 });
await page.fill('#menu-devname', 'DEMO');
await page.click('#menu-splith');
await page.waitForSelector('#panes > .split.split-h', { timeout: 5000 });
await page.waitForSelector(`${paneSel(0)} .sys-menu .menu-row, ${paneSel(1)} .sys-menu .menu-row`, {
  timeout: 5000
});
await sleep(400);
await page.keyboard.press('Enter'); // fresh half holds focus: connect it
await page.waitForFunction(
  () => document.getElementById('conn-state')?.dataset.state === 'connected',
  undefined,
  { timeout: 10000 }
);
await signOn(1);
await page.click(`${paneSel(0)} .sys-menu .menu-row`);
await page.waitForFunction(
  () => document.getElementById('conn-state')?.dataset.state === 'connected',
  undefined,
  { timeout: 10000 }
);
await signOn(0);
await sqlWithPaste(1);
await sleep(300);
await page.screenshot({ path: `${OUT}/split.png` });

await browser.close();
console.log(`shots written to ${OUT}/`);
process.exit(0);
