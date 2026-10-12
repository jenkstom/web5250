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

// Viewport coordinates of the centre of a 1-based screen cell. Clicks
// position the 5250 cursor (as on tn5250j), so "just focus the terminal"
// clicks must land on a deliberate cell.
const cellXY = (r, c) =>
  page.evaluate(
    ([r, c]) => {
      const b = document.getElementById('screen-canvas').getBoundingClientRect();
      return { x: b.left + (c - 0.5) * (b.width / 80), y: b.top + (r - 0.5) * (b.height / 24) };
    },
    [r, c]
  );

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

// Focus terminal and type credentials like a user. The click lands on the
// User field itself - clicks position the cursor, so a stray click would
// drag it off the field before typing.
{
  const { x, y } = await cellXY(9, 45);
  await page.mouse.click(x, y);
}
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

// Title-bar seams: the mock's reverse-video bar (row 1) must render as one
// solid run. Filling each cell separately at a fractional fit() scale leaves
// a dark antialiased hairline at cell boundaries (seen vs tn5250j), so the
// renderer coalesces same-attribute fills and snaps them to device pixels.
// Scan every boundary in the strip above cap height - the bar background is
// there but no glyph ink, so only a seam can deviate from the bar colour.
const bar = await page.evaluate(() => {
  const canvas = document.getElementById('screen-canvas');
  const ctx = canvas.getContext('2d');
  const cw = canvas.width / 80;
  const y = 3; // device pixels from the row top, above ascender ink
  const row = ctx.getImageData(0, y, canvas.width, 1).data;
  const px = (x) => [row[x * 4], row[x * 4 + 1], row[x * 4 + 2]];
  const modal = px(Math.round(5.5 * cw)); // centre of the bar's first cell
  let seams = 0;
  for (let k = 6; k < 80; k++) {
    const c = px(Math.round(k * cw));
    if (Math.abs(c[1] - modal[1]) > 15) seams++;
  }
  return { modal, seams };
});
console.log('TITLE BAR:', JSON.stringify(bar));

// Mouse behaviour, tn5250j-style: left click parks the cursor in ANY field
// (not just the one it is in), attribute cells are stepped past, and clicks
// on plain cells move freely. Right-click opens the terminal's own
// Copy/Paste menu instead of the browser's context menu.
const oiaPos = () => page.evaluate(() => document.getElementById('oia-pos')?.textContent);
const awaitPos = (want) =>
  page.waitForFunction(
    (w) => document.getElementById('oia-pos')?.textContent === w,
    want,
    { timeout: 3000 }
  ).then(
    () => true,
    () => false
  );

let mouseOk = true;
let copyOk = true;
let pasteOk = true;
let fallbackOk = true;
// a different field than the cursor's (Selection 6,25): the command line
{
  const { x, y } = await cellXY(19, 30);
  await page.mouse.click(x, y);
  mouseOk = await awaitPos('19,30');
  console.log('CLICK other field:', mouseOk ? 'ok' : `FAIL pos=${await oiaPos()}`);
}
// the Selection field's attribute cell (6,25) steps onto its first data cell
if (mouseOk) {
  const { x, y } = await cellXY(6, 25);
  await page.mouse.click(x, y);
  mouseOk = await awaitPos('6,26');
  console.log('CLICK attr cell steps past:', mouseOk ? 'ok' : `FAIL pos=${await oiaPos()}`);
}
// plain screen text moves freely
if (mouseOk) {
  const { x, y } = await cellXY(1, 10);
  await page.mouse.click(x, y);
  mouseOk = await awaitPos('1,10');
  console.log('CLICK plain cell:', mouseOk ? 'ok' : `FAIL pos=${await oiaPos()}`);
}
// right-click: our menu opens and the browser menu is suppressed
if (mouseOk) {
  const { x, y } = await cellXY(10, 40);
  await page.evaluate(() => {
    document.addEventListener(
      'contextmenu',
      (e) => {
        window.__ctxDefaultPrevented = e.defaultPrevented;
      },
      { once: true }
    );
  });
  await page.mouse.click(x, y, { button: 'right' });
  await page.waitForSelector('#ctx-menu:not(.hidden)', { timeout: 3000 });
  const suppressed = await page.evaluate(() => window.__ctxDefaultPrevented === true);
  console.log('RIGHT-CLICK menu:', suppressed ? 'ok' : 'FAIL browser menu not suppressed');
  mouseOk = mouseOk && suppressed;
  // Copy screen: clipboard holds the visible screen text
  await page.click('#ctx-copy');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  copyOk = copied.includes('CAUTION: mock host') && copied.includes('IBM i Main Menu');
  console.log('COPY screen:', copyOk ? 'ok' : `FAIL copied=${JSON.stringify(copied.slice(0, 80))}`);
  // Paste: '4' into the Selection field, then Enter -> the demo list screen.
  // Paste goes to the CURSOR (right-click does not move it), so park the
  // cursor on the Selection field with a left click first.
  await page.evaluate(() => navigator.clipboard.writeText('4'));
  const sel = await cellXY(6, 26);
  await page.mouse.click(sel.x, sel.y);
  await awaitPos('6,26');
  await page.mouse.click(sel.x, sel.y, { button: 'right' });
  await page.waitForSelector('#ctx-menu:not(.hidden)', { timeout: 3000 });
  await page.click('#ctx-paste');
  const pastedOk = await awaitPos('6,27'); // paste typed '4', cursor advanced
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.getElementById('oia-pos')?.textContent === '7,8',
    undefined,
    { timeout: 8000 }
  );
  pasteOk = pastedOk;
  console.log('PASTE at cursor:', pasteOk ? 'ok' : 'FAIL cursor did not advance');
  await page.screenshot({ path: `${OUT}/09-list-via-paste.png` });

  // Host-programmed mouse (the mock maps right-down and double-click to
  // F3 on this list screen): Shift+right-click still opens the LOCAL
  // menu on a programmed screen, plain right-click performs the host
  // action (exit to the main menu), and a double click does too.
  const row = await cellXY(9, 12);
  // NB: the modifiers click option does not reach this headless build -
  // hold the key instead.
  await page.keyboard.down('Shift');
  await page.mouse.click(row.x, row.y, { button: 'right' });
  await page.keyboard.up('Shift');
  await page.waitForSelector('#ctx-menu:not(.hidden)', { timeout: 3000 });
  await page.mouse.click(...Object.values(await cellXY(20, 40))); // click-away closes
  await page.waitForFunction(() => document.getElementById('ctx-menu')?.classList.contains('hidden'));
  console.log('SHIFT+RIGHT-CLICK local menu on programmed screen: ok');
  await page.mouse.click(row.x, row.y, { button: 'right' });
  mouseOk = await awaitPos('6,26'); // mock: right-down -> F3 -> main menu
  console.log('RIGHT-CLICK host action:', mouseOk ? 'ok' : `FAIL pos=${await oiaPos()}`);
  if (mouseOk) {
    // back into the list for the double-click check
    const sel = await cellXY(6, 26);
    await page.mouse.click(sel.x, sel.y);
    await page.keyboard.type('4');
    await page.keyboard.press('Enter');
    await awaitPos('7,8');
    const dbl = await cellXY(10, 12);
    await page.mouse.dblclick(dbl.x, dbl.y);
    mouseOk = await awaitPos('6,26'); // mock: left-double -> F3 -> main menu
    console.log('DOUBLE CLICK host action:', mouseOk ? 'ok' : `FAIL pos=${await oiaPos()}`);
  }
}
// Insecure-origin copy: with the clipboard API absent (plain HTTP has no
// navigator.clipboard), Copy screen must offer a selectable fallback box,
// not throw silently.
{
  await page.evaluate(() => {
    window.__clip = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
    Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: true });
  });
  const any = await cellXY(14, 40);
  await page.mouse.click(any.x, any.y, { button: 'right' });
  await page.waitForSelector('#ctx-menu:not(.hidden)', { timeout: 3000 });
  await page.click('#ctx-copy');
  await page.waitForSelector('#copy-fallback:not(.hidden)', { timeout: 3000 });
  const fbText = await page.evaluate(() => document.getElementById('copy-text')?.value ?? '');
  fallbackOk = fbText.includes('CAUTION: mock host');
  console.log('COPY fallback (no clipboard API):', fallbackOk ? 'ok' : 'FAIL box empty');
  await page.click('#copy-close');
  await page.evaluate(() =>
    Object.defineProperty(Navigator.prototype, 'clipboard', window.__clip)
  );
  // the Close button kept focus; the blink checks below need the terminal
  await page.evaluate(() => document.getElementById('terminal').focus());
}

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
if (
  errors.length ||
  oia.state !== 'connected' ||
  oia.lock ||
  !cursorOk ||
  bar.seams > 0 ||
  !mouseOk ||
  !copyOk ||
  !pasteOk ||
  !fallbackOk
)
  process.exit(1);
