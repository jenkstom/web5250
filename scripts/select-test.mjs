// E2E for drag select/copy: drives the real UI in headless Chromium against
// the mock host and checks clipboard contents after linear, rectangular and
// word marks, cursor-placement clicks, Ctrl+C and the hidden-field guard.
// Usage: node scripts/select-test.mjs [port]
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const PORT = process.argv[2] ?? '8091';
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

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
}

// Viewport coordinates of the centre of a 1-based cell, for drag paths.
const cellXY = (r, c) =>
  page.evaluate(
    ([r, c]) => {
      const b = document.getElementById('screen-canvas').getBoundingClientRect();
      return { x: b.left + (c - 0.5) * (b.width / 80), y: b.top + (r - 0.5) * (b.height / 24) };
    },
    [r, c]
  );
const readClipboard = () => page.evaluate(() => navigator.clipboard.readText());

// Drag across two cells. Alt (rectangle) is held via the keyboard: the
// mouse API has no modifiers option, and a held keyboard modifier does
// reach the mouse events' altKey.
async function drag(r1, c1, r2, c2, alt = false) {
  if (alt) await page.keyboard.down('Alt');
  const a = await cellXY(r1, c1);
  const b = await cellXY(r2, c2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  // intermediate moves so the handler sees a real drag
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2);
  await page.mouse.move(b.x, b.y);
  await page.mouse.up();
  if (alt) await page.keyboard.up('Alt');
}

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });
await page.click('#menu .menu-row');
await page.waitForFunction(
  () => document.getElementById('conn-state')?.dataset.state === 'connected',
  undefined,
  { timeout: 10000 }
);
await page.waitForTimeout(600); // font settle + first render

// --- hidden-field guard: type the password, then mark over it -------------
await page.keyboard.type('MOCKUSER');
await page.keyboard.press('Tab');
await page.keyboard.type('SECRETPW');
await page.waitForTimeout(300);
await drag(10, 44, 10, 54);
const leak = await readClipboard();
check('hidden field copies as blanks', leak.trim() === '', JSON.stringify(leak));
// the Enter that signs on also abandons the mark
await page.keyboard.press('Enter');
await page.waitForFunction(
  () => {
    const el = document.getElementById('oia-msg');
    return !el?.textContent?.includes('error');
  },
  undefined,
  { timeout: 8000 }
);
await page.waitForTimeout(500); // main menu rendered

// --- linear drag: menu option lines (rows 8-9) ----------------------------
// row 8 from col 6 -> end of line, row 9 from col 1 -> col 22
await drag(8, 6, 9, 22);
check(
  'linear drag copies flow text',
  (await readClipboard()) === '  1. User tasks\n       2. Office tasks',
  JSON.stringify(await readClipboard())
);
check(
  'copied toast shown',
  (await page.textContent('#copy-toast'))?.includes('characters copied') === true &&
    (await page.getAttribute('#copy-toast', 'class'))?.includes('show') === true
);

// --- rectangular drag (Alt): the option dots column, rows 8-11 ------------
await drag(8, 8, 11, 9, true);
check(
  'alt+drag copies a rectangle',
  (await readClipboard()) === '1.\n2.\n3.\n4.',
  JSON.stringify(await readClipboard())
);

// --- plain click still places the host cursor -----------------------------
// (19,25) is the command line's attribute cell - the gateway steps the
// cursor off it to (19,26); a plain text cell like (24,10) lands exactly.
{
  const { x, y } = await cellXY(24, 10);
  await page.mouse.click(x, y);
}
await page.waitForFunction(() => document.getElementById('oia-pos')?.textContent === '24,10', undefined, {
  timeout: 5000
});
check('plain click places host cursor', true);

// --- double-click marks a word --------------------------------------------
{
  const { x, y } = await cellXY(4, 36); // "Main" of "IBM i Main Menu" (cols 35-38)
  await page.mouse.dblclick(x, y);
}
await page.waitForTimeout(200);
check('double-click marks the word', (await readClipboard()) === 'Main', JSON.stringify(await readClipboard()));

// --- Ctrl+C re-copies the current mark ------------------------------------
await drag(8, 11, 8, 14); // "User" on row 8
await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
await page.keyboard.press('Control+c');
await page.waitForTimeout(200);
check('ctrl+c copies the mark', (await readClipboard()) === 'User', JSON.stringify(await readClipboard()));

// --- right-click menu: Copy selection enabled with a mark, else disabled --
{
  const { x, y } = await cellXY(24, 60);
  await page.mouse.click(x, y, { button: 'right' }); // opens with the mark standing
  await page.waitForSelector('#ctx-menu:not(.hidden)', { timeout: 3000 });
  const enabled = await page.evaluate(() => !document.getElementById('ctx-copysel').disabled);
  check('ctx menu: Copy selection enabled with mark', enabled);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('ctx-menu')?.classList.contains('hidden'));
  const click = await cellXY(24, 4);
  await page.mouse.click(click.x, click.y); // plain click clears the mark
  await page.waitForTimeout(300);
  await page.mouse.click(click.x, click.y, { button: 'right' });
  await page.waitForSelector('#ctx-menu:not(.hidden)', { timeout: 3000 });
  const disabled = await page.evaluate(() => document.getElementById('ctx-copysel').disabled);
  check('ctx menu: Copy selection disabled without mark', disabled);
  await page.keyboard.press('Escape'); // dismiss the menu
  await page.waitForFunction(() => document.getElementById('ctx-menu')?.classList.contains('hidden'));
}

// --- Copy selection item copies the standing mark -------------------------
await drag(8, 11, 8, 14); // "User"
await page.evaluate(() => navigator.clipboard.writeText('sentinel2'));
{
  const { x, y } = await cellXY(24, 60);
  await page.mouse.click(x, y, { button: 'right' });
  await page.waitForSelector('#ctx-menu:not(.hidden)', { timeout: 3000 });
  await page.click('#ctx-copysel');
}
await page.waitForTimeout(200);
check('ctx menu Copy selection copies', (await readClipboard()) === 'User', JSON.stringify(await readClipboard()));

await page.screenshot({ path: 'artifacts/select-final.png' });
await browser.close();

if (errors.length) {
  console.log('page errors:', errors.join(' | '));
  failed += errors.length;
}
console.log(failed === 0 ? 'ALL OK' : `${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
