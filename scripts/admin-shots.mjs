// Regenerates the admin/configuration screenshots under docs/screenshots/
// against the mock host (same setup as readme-shots.mjs, which produces the
// terminal-side shots). Two browser contexts: one holds a live signed-on
// session (device DEMO, user MOCKUSER) so the Sessions console and audit
// trail have real traffic to show; the other drives the PIN-gated admin
// console - systems catalog, the system editor form, the keymaps tab with
// the visual keyboard editor, live sessions, settings and the audit trail.
// The catalog and keymaps are seeded through the admin API like an
// administrator would build them.
// Usage: npm run build && node scripts/admin-shots.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { chromium } from 'playwright-core';

const MOCK_PORT = 18163;
const HTTP_PORT = 18212;
const DB = '/tmp/web5250-admin-shots.db';
const OUT = 'docs/screenshots';
const PIN = '2026';
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

// ---------------------------------------- seed keymaps + catalog (admin API)
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
  const send = async (url, method, body) => {
    const res = await fetch(url, { method, headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`admin ${method} ${url}: ${await res.text()}`);
    return res.json();
  };

  // Keymaps first: an uploaded .kmp and a hand-built migration map.
  const ibmi = await send(`${base}/admin/keymaps/import`, 'POST', {
    name: 'IBM i Access',
    description: 'Uploaded from ACS Keyboard Remap',
    kmp: readFileSync('data/IBMi.kmp', 'utf8')
  });
  const migration = await send(`${base}/admin/keymaps`, 'POST', {
    name: 'MIGRATION',
    description: 'PC5250 habits: Esc=Attn, Ctrl+F9=Clear',
    bindings: [
      { code: 'Escape', shift: true, ctrl: false, alt: false, action: 'attn' },
      { code: 'F9', shift: false, ctrl: true, alt: false, action: 'clear' },
      { code: 'KeyR', shift: false, ctrl: false, alt: true, action: 'reset' },
      { code: 'NumpadEnter', shift: false, ctrl: false, alt: false, action: 'fieldexit' },
      { code: 'Backspace', shift: false, ctrl: false, alt: true, action: 'bsdelete' },
      { code: 'KeyQ', shift: false, ctrl: false, alt: true, action: 'char', ch: '£' }
    ]
  });
  await send(`${base}/admin/keymaps/default`, 'PUT', { id: migration.keymap.id });

  // The catalog, one row per deployment style (only MOCK400 connects).
  const listed = await send(`${base}/admin/systems`, 'GET');
  const first = (listed.systems ?? [])[0];
  if (first) {
    await send(`${base}/admin/systems/${first.id}`, 'PUT', {
      name: 'MOCK400',
      description: 'Production partition - QINTER',
      host: '127.0.0.1',
      port: MOCK_PORT,
      ssl: false,
      termType: 'IBM-3477-FC',
      codePage: 'cp037'
    });
  }
  await send(`${base}/admin/systems`, 'POST', {
    name: 'DEV740', description: 'Developer partition (V7R4)', host: 'dev740.example.org',
    port: 992, ssl: true, termType: 'IBM-3477-FC', codePage: 'cp037', keymapId: migration.keymap.id
  });
  await send(`${base}/admin/systems`, 'POST', {
    name: 'WRKINQ', description: 'Batch and report host', host: 'wrkinq.example.org',
    termType: 'IBM-3477-FC', codePage: 'cp037', proxyHost: '192.168.40.22', proxyPort: 1080,
    keymapId: ibmi.keymap.id
  });
  await send(`${base}/admin/systems`, 'POST', {
    name: 'CLOSE', description: 'Period-end close', host: 'payroll.example.org',
    termType: 'IBM-3477-FC', codePage: 'cp037', signOnUser: 'CLOSEJOB', signOnPassword: 'stored'
  });
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

// Context A holds the live session the console will look at.
const owner = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pageA = await owner.newPage();
// Viewport coordinates of the centre of a 1-based cell on the main canvas.
const cellXY = (r, c) =>
  pageA.evaluate(
    ([r, c]) => {
      const b = document.querySelector('#screen-canvas').getBoundingClientRect();
      return { x: b.left + (c - 0.5) * (b.width / 80), y: b.top + (r - 0.5) * (b.height / 24) };
    },
    [r, c]
  );
const awaitPos = async (want) =>
  pageA
    .waitForFunction(
      (w) => document.getElementById('oia-pos')?.textContent === w,
      want,
      { timeout: 8000 }
    )
    .then(
      () => true,
      () => false
    );

await pageA.goto(`http://127.0.0.1:${HTTP_PORT}/`, { waitUntil: 'domcontentloaded' });
await pageA.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });
await pageA.fill('#menu-devname', 'DEMO');
await pageA.click('#menu .menu-row');
await pageA.waitForFunction(
  () => document.getElementById('conn-state')?.dataset.state === 'connected',
  undefined,
  { timeout: 10000 }
);
{
  const { x, y } = await cellXY(9, 45);
  await pageA.mouse.click(x, y);
}
await pageA.keyboard.type('MOCKUSER');
await pageA.keyboard.press('Tab');
await pageA.keyboard.type('SECRETPW');
await pageA.keyboard.press('Enter');
if (!(await awaitPos('6,26'))) throw new Error('owner sign-on did not reach the menu');
console.log('owner session live (DEMO / MOCKUSER)');

// Context B drives the admin console for the shots.
const admin = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await admin.newPage();
page.on('dialog', (d) => {
  // Signal uses a prompt for the banner text; other dialogs are confirms.
  if (d.type() === 'prompt') void d.accept('Host backup tonight 22:00 - please sign off');
  else void d.accept().catch(() => {});
});
await page.goto(`http://127.0.0.1:${HTTP_PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });

// 1. The PIN gate.
await page.click('#menu-admin-btn');
await page.waitForSelector('#admin-pin-input:not(.hidden)', { timeout: 5000 });
await page.screenshot({ path: `${OUT}/admin-pin.png` });

// 2. Sign in; the Systems list.
await page.fill('#admin-pin-input', PIN);
await page.keyboard.press('Enter');
await page.waitForSelector('#admin-editor:not(.hidden)', { timeout: 5000 });
await page.waitForSelector('#admin-list .admin-row', { timeout: 5000 });
await sleep(300); // font settle
await page.screenshot({ path: `${OUT}/admin-systems.png` });

// 3. The system editor form (tall - raise the viewport for this one shot).
await page.locator('#admin-list li', { hasText: 'MOCK400' }).locator('button', { hasText: 'Edit' }).click();
await page.waitForSelector('#admin-form:not(.hidden)', { timeout: 5000 });
await page.setViewportSize({ width: 1280, height: 1180 });
await sleep(300);
await page.screenshot({ path: `${OUT}/admin-system-form.png` });
await page.setViewportSize({ width: 1280, height: 1000 });

// 4. Keymaps tab: the list with the default chip and per-host usage.
await page.click('#admin-cancel-edit');
await page.click('#admin-tabs button[data-tab="keymaps"]');
await page.waitForSelector('#keymap-list .admin-row', { timeout: 5000 });
await sleep(300);
await page.screenshot({ path: `${OUT}/admin-keymaps.png` });

// 5. The visual editor with a bound key selected.
await page.locator('#keymap-list li', { hasText: 'MIGRATION' }).locator('button', { hasText: 'Edit' }).click();
await page.waitForSelector('#keymap-editor:not(.hidden)', { timeout: 5000 });
await page.locator('.keycap[data-code="F9"]').click();
await page.waitForFunction(
  () => (document.getElementById('km-key-title')?.textContent ?? '').includes('F9'),
  undefined,
  { timeout: 5000 }
);
await sleep(300);
await page.screenshot({ path: `${OUT}/admin-keymap-editor.png` });
await page.click('#km-cancel');

// 6. Live sessions (the owner context holds DEMO / MOCKUSER) with a
//    maintenance window armed for the shot.
{
  const auth = await (
    await fetch(`${base0()}/admin/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: PIN })
    })
  ).json();
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` };
  const post = (url, body) =>
    fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  await post(`${base0()}/admin/maintenance`, {
    on: true,
    message: 'IPL tonight 22:00 - please sign off before then'
  });
}
await page.click('#admin-tabs button[data-tab="sessions"]');
await page.waitForFunction(
  () => (document.getElementById('sessions-list')?.textContent ?? '').includes('MOCKUSER'),
  undefined,
  { timeout: 8000 }
);
await sleep(400); // the 5 s poll refreshes viewers/assist markers
await page.screenshot({ path: `${OUT}/admin-sessions.png` });

// Signal + mirror the session for the audit trail (both are audited).
await page.locator('#sessions-list .admin-row', { hasText: 'DEMO' }).locator('button', { hasText: 'Signal' }).click();
await sleep(500);
await page.locator('#sessions-list .admin-row', { hasText: 'DEMO' }).locator('button', { hasText: 'Mirror' }).click();
await sleep(500);

// 7. Settings: arm the sign-on protection PIN through the UI.
await page.click('#admin-tabs button[data-tab="settings"]');
await page.fill('#f-signonpin', 'MONTHLY-ROTATING');
await page.click('#settings-save');
await page.waitForFunction(
  () => (document.getElementById('settings-signonpin-status')?.textContent ?? '').includes('IS set'),
  undefined,
  { timeout: 5000 }
);
await sleep(200);
await page.screenshot({ path: `${OUT}/admin-settings.png` });

// 8. Audit trail: mirror, signal, maintenance and PIN changes all landed.
{
  const auth = await (
    await fetch(`${base0()}/admin/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: PIN })
    })
  ).json();
  await fetch(`${base0()}/admin/maintenance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` },
    body: JSON.stringify({ on: false })
  });
}
await page.click('#admin-tabs button[data-tab="audit"]');
await page.waitForSelector('#audit-list .audit-row', { timeout: 5000 });
await sleep(300);
await page.screenshot({ path: `${OUT}/admin-audit.png` });

await browser.close();
console.log(`shots written to ${OUT}/`);
process.exit(0);

function base0() {
  return `http://127.0.0.1:${HTTP_PORT}/api`;
}
