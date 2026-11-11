// E2E for the system selection menu at catalog scale:
//   1. The list paginates: one page of rows renders, the pager reports the
//      page count, and arrows / a typed number move the cursor across page
//      boundaries while keeping it visible.
//   2. PageUp/PageDown (and the pager buttons) turn pages: paging forward
//      selects the new page's first row, paging back its last row.
//   3. Quick search: letters typed in the Option/Filter field (overtyping
//      the echoed number) filter the list live - matches renumber, the
//      pager and a "N of M" count follow, no-match names the filter, and
//      Escape restores the full catalog with digits still working.
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
  () => document.querySelectorAll('#menu-list .menu-row').length === 10,
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

/** The pager's label and button states as the page sees them. */
const pagerInfo = () =>
  page.evaluate(() => ({
    label: document.getElementById('menu-page-label').textContent,
    visible: !document.getElementById('menu-pager').classList.contains('hidden'),
    prevDisabled: document.getElementById('menu-prev').disabled,
    nextDisabled: document.getElementById('menu-next').disabled
  }));

// ---- 0. the list paginates from the start
let pager = await pagerInfo();
check('page 1 of 12 shown', pager.label === 'Page 1 / 12', pager.label);
check('Prev disabled on the first page', pager.prevDisabled === true, JSON.stringify(pager));
check('one page of rows rendered', (await page.locator('#menu-list .menu-row').count()) === 10);

// ---- 1. arrows cross page boundaries and keep the cursor visible
await page.focus('#menu-option');
for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowDown');
await sleep(400);
const afterArrows = await selInfo();
pager = await pagerInfo();
check('30x ArrowDown moved the selection (row 31)', (afterArrows?.text ?? '').includes('SYS031'), afterArrows?.text);
check('arrows turned the pages along the way', pager.label === 'Page 4 / 12', pager.label);
check('selected row is on screen', onScreen(afterArrows), JSON.stringify(afterArrows));

// ArrowUp from the top row of a page lands on the previous page's last row.
for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown'); // row 31 -> 41, top of page 5
await sleep(200);
await page.keyboard.press('ArrowUp'); // top row of page 5 -> last row of page 4
await sleep(300);
const afterUp = await selInfo();
check('ArrowUp at a page top steps onto the previous page', (afterUp?.text ?? '').includes('SYS040'), afterUp?.text);
check('that row is on screen', onScreen(afterUp), JSON.stringify(afterUp));

// ---- 2. a typed 3-digit number jumps across pages - and lands on screen
await page.fill('#menu-option', '115');
await sleep(300);
const afterType = await selInfo();
pager = await pagerInfo();
check('typed 115 selected row 115', (afterType?.text ?? '').includes('SYS115'), afterType?.text);
check('the jump turned to the row\'s page', pager.label === 'Page 12 / 12', pager.label);
check('Next disabled on the last page', pager.nextDisabled === true, JSON.stringify(pager));
check('the jumped-to row is on screen', onScreen(afterType), JSON.stringify(afterType));

// ---- 3. PageUp/PageDown turn pages
const selText = async () => ((await selInfo())?.text ?? '');
await page.keyboard.press('PageUp'); // 12 -> 11
await sleep(150);
await page.keyboard.press('PageUp'); // 11 -> 10
await sleep(300);
let text = await selText();
pager = await pagerInfo();
check('two PageUps land on page 10', pager.label === 'Page 10 / 12', pager.label);
check('paging back selects the page\'s last row', text.includes('SYS100'), text);
await page.keyboard.press('PageDown'); // 10 -> 11, first row
await sleep(300);
text = await selText();
pager = await pagerInfo();
check('PageDown forward selects the page\'s first row', pager.label === 'Page 11 / 12' && text.includes('SYS101'), `${pager.label} / ${text}`);
check('both pager buttons live mid-list', pager.prevDisabled === false && pager.nextDisabled === false, JSON.stringify(pager));

// The pager buttons do the same job by mouse.
await page.click('#menu-prev');
await sleep(300);
pager = await pagerInfo();
check('the Prev button turns back a page', pager.label === 'Page 10 / 12', pager.label);

// ---- 4. quick search: letters typed in the field filter the list live
const countInfo = () =>
  page.evaluate(() => ({
    text: document.getElementById('menu-count').textContent,
    hidden: document.getElementById('menu-count').classList.contains('hidden'),
    value: document.getElementById('menu-option').value
  }));
// Real typing over the echoed selection number (100): the first letter must
// overtype it, or the filter would read "100sys1" and match nothing.
await page.focus('#menu-option');
await page.keyboard.press('ControlOrMeta+a');
await page.keyboard.type('sys1');
await sleep(300);
pager = await pagerInfo();
let count = await countInfo();
let selTxt = await selText();
check(
  'letters filter live (SYS100..SYS120 match "sys1")',
  count.text === '21 of 120' && count.value === 'sys1' && (await page.locator('#menu-list .menu-row').count()) === 10,
  JSON.stringify(count)
);
check('the pager follows the filtered set', pager.visible && pager.label === 'Page 1 / 3', pager.label);
check('rows renumber within the filtered set', selTxt.startsWith('1.') && selTxt.includes('SYS100'), selTxt);
await page.keyboard.press('ArrowDown');
await sleep(200);
selTxt = await selText();
check('arrows move within the filtered set', selTxt.includes('SYS101'), selTxt);

// Refining narrows further; a set that fits one page hides the pager.
await page.keyboard.press('ControlOrMeta+a');
await page.keyboard.type('sys11');
await sleep(300);
pager = await pagerInfo();
count = await countInfo();
selTxt = await selText();
check(
  'a longer filter narrows to SYS110..SYS119 on one page',
  (await page.locator('#menu-list .menu-row').count()) === 10 &&
    !pager.visible &&
    count.text === '10 of 120' &&
    selTxt.includes('SYS110'),
  `${pager.label} / ${count.text} / ${selTxt}`
);

// No matches: the empty state names the filter.
await page.keyboard.press('ControlOrMeta+a');
await page.keyboard.type('zzz');
await sleep(300);
count = await countInfo();
const emptyText = await page.evaluate(() => document.getElementById('menu-empty').textContent);
check(
  'no matches shows the no-match state, not "no systems"',
  (await page.locator('#menu-list .menu-row').count()) === 0 &&
    count.text === '0 of 120' &&
    (emptyText ?? '').includes('No systems match "zzz".'),
  `${count.text} / ${emptyText}`
);

// Escape clears the filter and restores the full catalog; digits work again.
await page.keyboard.press('Escape');
await sleep(300);
pager = await pagerInfo();
count = await countInfo();
check(
  'Escape clears the filter',
  pager.visible && pager.label === 'Page 1 / 12' && count.hidden,
  `${pager.label} / ${JSON.stringify(count)}`
);
await page.keyboard.press('ControlOrMeta+a');
await page.keyboard.type('60');
await sleep(300);
selTxt = await selText();
check('digits jump again after clearing the filter', selTxt.includes('SYS060'), selTxt);

// The field must hold a filter term (and digits for catalogs beyond 999).
const maxlen = await page.getAttribute('#menu-option', 'maxlength');
check('Option/Filter field takes a search term (25 chars)', maxlen === '25', String(maxlen));

await browser.close();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
