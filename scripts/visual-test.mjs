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

  // Host-programmed mouse (the mock maps right-down to the menu key PF4 on
  // this list screen, double-click to F3): Shift+right-click still opens the
  // LOCAL menu on a programmed screen; plain right-click runs the live
  // host's menu dialect - acknowledge WTD, SAVE SCREEN (image request),
  // device image reply, menu write, pick, cookie RESTORE - and a double
  // click exits to the main menu.
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
  // The terminal renders to a canvas, so screen text is verified through
  // the local menu's Copy action (Shift+right keeps the local menu even on
  // host-programmed screens).
  const screenText = async () => {
    await page.keyboard.down('Shift');
    const any = await cellXY(2, 40);
    await page.mouse.click(any.x, any.y, { button: 'right' });
    await page.keyboard.up('Shift');
    await page.waitForSelector('#ctx-menu:not(.hidden)', { timeout: 3000 });
    await page.click('#ctx-copy');
    const t = await page.evaluate(() => navigator.clipboard.readText());
    const away = await cellXY(20, 40);
    await page.mouse.click(away.x, away.y);
    await page.waitForFunction(() => document.getElementById('ctx-menu')?.classList.contains('hidden'));
    return t;
  };

  await page.mouse.click(row.x, row.y, { button: 'right' });
  // The host inserts the cursor at the click (ack WTD, no read invite) and
  // waits for the device's screen image before drawing the menu - the flow
  // that hung forever without the image reply.
  mouseOk = await awaitPos('9,12');
  console.log('RIGHT-CLICK ack cursor at click:', mouseOk ? 'ok' : `FAIL pos=${await oiaPos()}`);
  if (mouseOk) {
    // The menu is a DEFINE SELECTION FIELD popup: a DOM overlay with one
    // item per choice (the canvas keeps showing the pre-menu screen).
    await page.waitForSelector('#host-menu:not(.hidden) .host-menu-item', { timeout: 8000 });
    const items = await page.locator('#host-menu .host-menu-item').allTextContents();
    mouseOk = items.some((t) => t.includes('1=Select item')) && items.length === 4;
    await page.screenshot({ path: `${OUT}/10-rightclick-menu.png` });
    console.log(
      'RIGHT-CLICK host popup rendered:',
      mouseOk ? 'ok' : `FAIL items=${JSON.stringify(items)}`
    );
  }
  if (mouseOk) {
    // Paging: F9 makes the host re-send the window + field with page two.
    await page.keyboard.press('F9');
    await page.waitForFunction(
      () =>
        document.querySelector('#host-menu .host-menu-item')?.textContent?.includes('5=Tag item'),
      undefined,
      { timeout: 8000 }
    );
    await page.screenshot({ path: `${OUT}/10b-rightclick-menu-page2.png` });
    console.log('HOST MENU paging (F9) re-renders: ok');
    // Pick: click an item; the mock replays our save cookie (GDS opcode 05)
    // - the list screen must come back from the cookie alone - and notes
    // the picked choice number (list position, 1-based) on the status line.
    await page.locator('#host-menu .host-menu-item', { hasText: '6=Untag item' }).click();
    await page.waitForFunction(
      () => document.getElementById('host-menu')?.classList.contains('hidden'),
      undefined,
      { timeout: 8000 }
    );
    await page.waitForTimeout(300);
    const back = await screenText();
    mouseOk = back.includes('Menu pick 2 processed.') && back.includes('Demo item 1');
    mouseOk = (await awaitPos('9,12')) && mouseOk; // cookie cursor = click cell
    await page.screenshot({ path: `${OUT}/11-menu-restored.png` });
    console.log(
      'MENU pick restores screen from device cookie:',
      mouseOk ? 'ok' : `FAIL copied="${back.replace(/\n/g, '|').slice(0, 140)}"`
    );
  }
  if (mouseOk) {
    const dbl = await cellXY(10, 12);
    await page.mouse.dblclick(dbl.x, dbl.y);
    mouseOk = await awaitPos('6,26'); // mock: left-double -> F3 -> main menu
    console.log('DOUBLE CLICK host action:', mouseOk ? 'ok' : `FAIL pos=${await oiaPos()}`);
  }
}
// Window-only GUI popup (CREATE WINDOW without a selection field, the
// F4-prompt/confirm-dialog case): the server must draw the 5494 border into
// the cell buffer, clear the work area, and put the covered screen back on
// REMOVE GUI WINDOW.
let winOk = true;
{
  const screenText = async () => {
    await page.keyboard.down('Shift');
    const any = await cellXY(2, 40);
    await page.mouse.click(any.x, any.y, { button: 'right' });
    await page.keyboard.up('Shift');
    await page.waitForSelector('#ctx-menu:not(.hidden)', { timeout: 3000 });
    await page.click('#ctx-copy');
    const t = await page.evaluate(() => navigator.clipboard.readText());
    const away = await cellXY(20, 40);
    await page.mouse.click(away.x, away.y);
    await page.waitForFunction(() => document.getElementById('ctx-menu')?.classList.contains('hidden'));
    return t;
  };
  // back to the list screen (the double-click above ended on the main menu)
  await page.keyboard.type('4');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.getElementById('oia-pos')?.textContent === '7,8',
    undefined,
    { timeout: 8000 }
  );
  await page.keyboard.press('F6');
  await page.waitForFunction(
    () => document.getElementById('oia-pos')?.textContent === '8,24',
    undefined,
    { timeout: 8000 }
  );
  await page.waitForTimeout(300);
  const pop = await screenText();
  winOk =
    pop.includes('┌') && pop.includes('└') &&
    pop.includes('Confirm Delete') &&
    pop.includes('Enter=Confirm') &&
    pop.includes('Delete Demo item 1?') &&
    // the covered list rows (items 1-4) lose their tails (work area
    // cleared); the window's own question text holds "Demo item 1?"
    !/Demo item [1-5](?![\d?])/.test(pop) &&
    pop.includes('Demo item 6'); // ...rows below the window stay intact
  await page.screenshot({ path: `${OUT}/12-window-popup.png` });
  console.log('WINDOW POPUP border + title + cleared work area:', winOk ? 'ok' : `FAIL text=${JSON.stringify(pop.split('\n').slice(4, 12))}`);
  // Any AID closes the mock window; park the cursor in the window's field
  // (the copy-screen click-away above parked it at 20,40), type Y and
  // Enter - the read must carry it through the popup field.
  await page.mouse.click(...Object.values(await cellXY(8, 26)));
  await awaitPos('8,26');
  await page.keyboard.type('Y');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.getElementById('oia-pos')?.textContent === '8,24',
    undefined,
    { timeout: 8000 }
  );
  await page.waitForTimeout(300);
  const back = await screenText();
  winOk =
    winOk &&
    back.includes('Demo item 1') && // underlying screen restored
    back.includes('Window closed (answer "Y")') && // the typed Y travelled
    !back.includes('┌'); // frame gone
  await page.screenshot({ path: `${OUT}/13-window-closed.png` });
  console.log('WINDOW POPUP removal restores the screen:', winOk ? 'ok' : `FAIL text=${JSON.stringify(back.split('\n').slice(4, 12))}`);
  await page.keyboard.press('F3'); // back to the main menu for the next section
  await page.waitForTimeout(600);
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
  !winOk ||
  !fallbackOk
)
  process.exit(1);
