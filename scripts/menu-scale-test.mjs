// E2E for the system selection menu at catalog scale:
//   1. The selection cursor follows the viewport: arrowing past the fold (or
//      jumping by typed number) must scroll the panel so the highlighted row
//      stays visible - it used to walk off-screen silently.
//   2. The Option ==> field takes three digits, so catalogs beyond 99
//      systems stay reachable by number (it used to cap at 2).
// Seeds 120 systems through the admin config import, then drives the real
// menu in headless Chromium.
// Usage: npm run build && npm run test:menuscale
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const MOCK_PORT = 18063;
const HTTP_PORT = 18110;
const ADMIN_PIN = '1234';
const COUNT = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  [${cond ? 'ok' : 'FAIL'}] ${name}${cond ? '' : ' - ' + detail}`);
  if (!cond) failures++;
}
const procs = [];
process.on('exit', () => procs.forEach((p) => p.kill()));

async function waitHealthy(port) {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

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
      ADMIN_PIN,
      WEB5250_DB: join(mkdtempSync(join(tmpdir(), 'web5250-menuscale-')), 'menu.db')
    }
  })
);
if (!(await waitHealthy(HTTP_PORT))) {
  console.error('gateway never became healthy');
  process.exit(1);
}

// Seed the catalog in one import (SYS001..SYS120; the import replaces the
// first-boot seed, so row N is SYS<NNN> exactly).
const auth = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/admin/auth`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ pin: ADMIN_PIN })
});
const { token } = await auth.json();
const seeded = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/admin/config`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({
    systems: Array.from({ length: COUNT }, (_, i) => ({
      name: `SYS${String(i + 1).padStart(3, '0')}`,
      host: '127.0.0.1',
      port: MOCK_PORT
    }))
  })
});
check(`${COUNT} systems imported`, seeded.ok, String(seeded.status));

const exeCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-linux64/headless_shell`
];
const executablePath = exeCandidates.find((p) => p && existsSync(p));
if (!executablePath) throw new Error('no chromium binary found');

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await page.goto(`http://127.0.0.1:${HTTP_PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });
await page.waitForFunction(
  () => document.querySelectorAll('#menu-list .menu-row').length === 120,
  undefined,
  { timeout: 10000 }
);

/** Selected row's geometry: on-screen-ness of the cursor, plus menu scroll. */
const selInfo = () =>
  page.evaluate(() => {
    const sel = document.querySelector('#menu-list .sel');
    if (!sel) return null;
    const r = sel.getBoundingClientRect();
    return {
      text: (sel.textContent ?? '').replace(/\s+/g, ' ').trim(),
      top: r.top,
      bottom: r.bottom,
      vh: window.innerHeight,
      scrollTop: document.getElementById('menu').scrollTop
    };
  });
const onScreen = (s) => s !== null && s.top >= 0 && s.bottom <= s.vh;

// ---- 1. arrows keep the cursor visible past the fold
await page.focus('#menu-option');
for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowDown');
await sleep(400);
const afterArrows = await selInfo();
check('30x ArrowDown moved the selection (row 31)', (afterArrows?.text ?? '').includes('SYS031'), afterArrows?.text);
check('the panel scrolled to follow', (afterArrows?.scrollTop ?? 0) > 0, JSON.stringify(afterArrows));
check('selected row is on screen', onScreen(afterArrows), JSON.stringify(afterArrows));

// ---- 2. a typed 3-digit number jumps - and lands on screen
await page.fill('#menu-option', '115');
await sleep(300);
const afterType = await selInfo();
check('typed 115 selected row 115', (afterType?.text ?? '').includes('SYS115'), afterType?.text);
check('the jumped-to row is on screen', onScreen(afterType), JSON.stringify(afterType));

// The field itself must accept three digits (it capped at 2 before).
const maxlen = await page.getAttribute('#menu-option', 'maxlength');
check('Option field accepts 3 digits', maxlen === '3', String(maxlen));

await browser.close();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
