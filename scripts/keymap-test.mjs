// End-to-end test for the Keymaps tab (admin-managed keyboard maps):
//   A. .kmp upload/download - IBM i Access / PCOMM keyboard files parsed
//      into overlay bindings and serialized back, sample file included
//      (data/IBMi.kmp), untranslatable entries reported not guessed at
//   B. CRUD + validation + assignment - create/edit/delete, duplicate
//      names, bad actions, per-host assignment, default set/clear, delete
//      cleans up host references and the default
//   C. config export/import - v2 documents carry keymaps (by name) and the
//      default; v1 documents still import; dangling names change nothing
//   D. UI (headless Chromium) - the visual editor builds a binding by hand,
//      the default applies, and a remapped key reaches the host session
//      while an unbound key keeps its built-in meaning
//
// Usage: npm run build && npm run test:keymaps
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const MOCK_PORT = 18083;
const HTTP_PORT = 18130;
const ADMIN_PIN = '1234';

const SAMPLE_KMP = readFileSync('data/IBMi.kmp', 'utf8');
// Exercises the parser's whole surface: mnemonics and aliases, all three
// modifier prefixes, a Java F13 code (240), numpad location bits, a
// "|codepoint" character insert, plus entries that must be skipped.
const SYNTH_KMP = [
  '[KeyRemap]',
  'keyVersion=2',
  'codePage=037',
  'sessionType=2',
  'autoApply=false',
  'XF:[textlogicaldisp]=[textlogicaldisp]',
  'B10=[enter]',
  'B112=[pf1]',
  'B240=[pf13]',
  'S27=[attn]',
  'A68=[reset]',
  'C192=[fldext]',
  'B33554442=[enter]',
  'A81=|163',
  'B8=[backspace]',
  'A8=[bsdelete]',
  'S8=[destbackspace]',
  'B34=[pagedn]',
  'B999=[dup]',
  'C17=[reset]',
  'B65=66'
].join('\r\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- terminal model
// Minimal screen reader for raw-WS sessions (same idea as signonpin-test).
class Term {
  rows = 24;
  cols = 80;
  cells = [];
  apply(msg) {
    if (msg.t === 'screen') {
      this.rows = msg.rows;
      this.cols = msg.cols;
      this.cells = new Array(this.rows * this.cols).fill(' ');
      for (const [pos, , ch] of msg.cells) this.cells[pos] = String(ch ?? ' ');
    } else if (msg.t === 'update' && Array.isArray(msg.cells)) {
      for (const [pos, , ch] of msg.cells) this.cells[pos] = String(ch ?? ' ');
    }
  }
  text() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      out.push(this.cells.slice(r * this.cols, (r + 1) * this.cols).join('').replace(/\s+$/, ''));
    }
    return out.join('\n');
  }
}

async function openSession(url) {
  const sock = new WebSocket(url);
  const term = new Term();
  sock.addEventListener('message', (ev) => term.apply(JSON.parse(String(ev.data))));
  await new Promise((resolve, reject) => {
    sock.addEventListener('open', resolve);
    sock.addEventListener('error', reject);
  });
  return { sock, term };
}

async function waitFor(term, pred, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred(term)) return true;
    await sleep(60);
  }
  console.log(`  (timeout waiting for ${what})`);
  return false;
}

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  [${cond ? 'ok' : 'FAIL'}] ${name}${cond ? '' : ' - ' + detail}`);
  if (!cond) failures++;
}

const procs = [];
function cleanup() {
  for (const p of procs) p.kill();
}
process.on('exit', cleanup);

async function waitHealthy(port) {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return false;
}

const http = async (method, path, body, token, raw = false) => {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (raw) return res;
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const binding = (code, mods, action, ch) => ({
  code,
  shift: Boolean(mods.shift),
  ctrl: Boolean(mods.ctrl),
  alt: Boolean(mods.alt),
  action,
  ...(ch !== undefined ? { ch } : {})
});
const hasBinding = (list, b) =>
  list.some(
    (x) =>
      x.code === b.code && !!x.shift === !!b.shift && !!x.ctrl === !!b.ctrl &&
      !!x.alt === !!b.alt && x.action === b.action && (x.ch ?? '') === (b.ch ?? '')
  );

async function main() {
  console.log('Starting mock host and gateway...');
  procs.push(spawn(process.execPath, ['scripts/mock-host.mjs', String(MOCK_PORT)], { stdio: 'inherit' }));
  await sleep(300);
  procs.push(
    spawn(process.execPath, ['dist/server.js'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: String(HTTP_PORT),
        IBM_I_HOST: '127.0.0.1',
        IBM_I_PORT: String(MOCK_PORT),
        IBM_I_TERM_TYPE: 'IBM-3477-FC',
        IBM_I_CODEPAGE: 'cp037',
        ADMIN_PIN,
        WEB5250_DB: join(mkdtempSync(join(tmpdir(), 'web5250-keymaps-')), 'menu.db')
      }
    })
  );
  if (!(await waitHealthy(HTTP_PORT))) {
    console.error('gateway never became healthy');
    process.exit(1);
  }
  const auth = await http('POST', 'api/admin/auth', { pin: ADMIN_PIN });
  const token = auth.data.token;

  // -------------------------------------------------- A. .kmp round-trip
  console.log('\nA. .kmp upload and download');
  const noAuth = await http('GET', 'api/admin/keymaps');
  check('keymap admin routes need the token', noAuth.status === 401);

  const sampleImport = await http('POST', 'api/admin/keymaps/import', { name: 'IBMi', kmp: SAMPLE_KMP }, token);
  check('sample import succeeds', sampleImport.status === 201, JSON.stringify(sampleImport.data));
  const sampleBindings = sampleImport.data.keymap?.bindings ?? [];
  check('sample: Enter, Tab and Backquote bound', sampleBindings.length === 3, JSON.stringify(sampleBindings));
  check('sample: Enter -> enter', hasBinding(sampleBindings, binding('Enter', {}, 'enter')));
  check('sample: Tab -> tab', hasBinding(sampleBindings, binding('Tab', {}, 'tab')));
  check('sample: Backquote -> tab (key 192)', hasBinding(sampleBindings, binding('Backquote', {}, 'tab')));
  check(
    'sample: Ctrl+Control entry reported untranslatable',
    (sampleImport.data.skipped ?? []).some((s) => s.startsWith('C17='))
  );

  const importDup = await http('POST', 'api/admin/keymaps/import', { name: 'IBMi', kmp: SAMPLE_KMP }, token);
  check('re-import gets a numbered name, not an error', importDup.status === 201 && importDup.data.keymap?.name === 'IBMi 2');

  const synthImport = await http('POST', 'api/admin/keymaps/import', { name: 'SYNTH', kmp: SYNTH_KMP }, token);
  check('synthetic import succeeds', synthImport.status === 201, JSON.stringify(synthImport.data));
  const sb = synthImport.data.keymap?.bindings ?? [];
  check('pf keys (F1, Java F13=240)', hasBinding(sb, binding('F1', {}, 'pf1')) && hasBinding(sb, binding('F13', {}, 'pf13')));
  check('modifier prefixes S/C/A', hasBinding(sb, binding('Escape', { shift: true }, 'attn')) &&
    hasBinding(sb, binding('KeyD', { alt: true }, 'reset')) &&
    hasBinding(sb, binding('Backquote', { ctrl: true }, 'fieldexit')));
  check('numpad location bits (0x2000000+10)', hasBinding(sb, binding('NumpadEnter', {}, 'enter')));
  check('|163 types the pound sign', hasBinding(sb, binding('KeyQ', { alt: true }, 'char', '£')));
  check(
    'backspace mnemonics: [backspace] + destructive aliases',
    hasBinding(sb, binding('Backspace', {}, 'backspace')) &&
      hasBinding(sb, binding('Backspace', { alt: true }, 'bsdelete')) &&
      hasBinding(sb, binding('Backspace', { shift: true }, 'bsdelete'))
  );
  check('[pagedn] alias -> rolldown', hasBinding(sb, binding('PageDown', {}, 'rolldown')));
  check('unknown mnemonic / key / key-to-key skipped', (synthImport.data.skipped ?? []).length === 3,
    JSON.stringify(synthImport.data.skipped));

  const garbage = await http('POST', 'api/admin/keymaps/import', { name: 'BAD', kmp: 'hello world' }, token);
  check('not a keyboard file -> 400', garbage.status === 400 && typeof garbage.data.error === 'string');

  const dl = await http('GET', `api/admin/keymaps/${synthImport.data.keymap.id}/download`, undefined, token, true);
  const dlText = await dl.text();
  check('download is an attachment', /attachment; filename="synth\.kmp"/.test(dl.headers.get('content-disposition') ?? ''));
  check('download is a [KeyRemap] document', dlText.startsWith('[KeyRemap]'));
  check('download carries the bindings', dlText.includes('B112=[pf1]') && dlText.includes('S27=[attn]') && dlText.includes('A81=|163'));
  // Re-uploading the download must land on the same binding set (lossless for
  // everything the vocabulary can express).
  const roundTrip = await http('POST', 'api/admin/keymaps/import', { name: 'RT', kmp: dlText }, token);
  const rtBindings = roundTrip.data.keymap?.bindings ?? [];
  check('download re-imports to the same bindings', rtBindings.length === sb.length &&
    sb.every((b) => hasBinding(rtBindings, b)), JSON.stringify(rtBindings));

  // ------------------------------------------- B. CRUD, assignment, default
  console.log('\nB. CRUD, per-host assignment and the default');
  const made = await http('POST', 'api/admin/keymaps', {
    name: 'MIGRATION',
    description: 'test layout',
    bindings: [
      binding('KeyQ', { alt: true }, 'attn'),
      binding('Escape', {}, 'browser'),
      binding('F9', {}, 'clear'),
      binding('KeyM', { ctrl: true }, 'char', 'x')
    ]
  }, token);
  check('manual create succeeds', made.status === 201, JSON.stringify(made.data));
  const madeId = made.data.keymap?.id;

  const dupName = await http('POST', 'api/admin/keymaps', { name: 'MIGRATION' }, token);
  check('duplicate name rejected', dupName.status === 400);
  const badAction = await http('POST', 'api/admin/keymaps', {
    name: 'X', bindings: [binding('F9', {}, 'warp')]
  }, token);
  check('unknown action rejected', badAction.status === 400);
  const badChar = await http('POST', 'api/admin/keymaps', {
    name: 'X', bindings: [binding('F9', {}, 'char')]
  }, token);
  check('char without a character rejected', badChar.status === 400);
  const noName = await http('POST', 'api/admin/keymaps', { bindings: [] }, token);
  check('name required', noName.status === 400);

  const upd = await http('PUT', `api/admin/keymaps/${madeId}`, {
    name: 'MIGRATION',
    description: 'renamed',
    bindings: [binding('KeyQ', { alt: true }, 'attn'), binding('F9', { shift: true }, 'pf13')]
  }, token);
  check('update replaces bindings', upd.status === 200 && upd.data.keymap?.bindings?.length === 2);
  const upd404 = await http('PUT', 'api/admin/keymaps/99999', { name: 'X' }, token);
  check('update of a missing keymap -> 404', upd404.status === 404);

  // Assignment: the seeded system picks the keymap; a missing id fails.
  const seeded = (await http('GET', 'api/admin/systems', undefined, token)).data.systems?.[0];
  const badAssign = await http('PUT', `api/admin/systems/${seeded.id}`, {
    name: seeded.name, host: seeded.host, keymapId: 99999
  }, token);
  check('assigning a missing keymap -> 400', badAssign.status === 400, JSON.stringify(badAssign.data));
  const assign = await http('PUT', `api/admin/systems/${seeded.id}`, {
    name: seeded.name, host: seeded.host, keymapId: madeId
  }, token);
  check('per-host assignment sticks', assign.status === 200 && assign.data.system?.keymapId === madeId);
  const publicList = (await http('GET', 'api/systems')).data.systems;
  check('public menu carries keymapId', publicList.find((s) => s.id === seeded.id)?.keymapId === madeId);

  const def = await http('PUT', 'api/admin/keymaps/default', { id: madeId }, token);
  check('default set', def.status === 200 && def.data.defaultKeymapId === madeId);
  const def404 = await http('PUT', 'api/admin/keymaps/default', { id: 99999 }, token);
  check('default to a missing keymap -> 404', def404.status === 404);

  const pub = await http('GET', 'api/keymaps');
  check('public catalog: no token needed', pub.status === 200);
  check(
    'public catalog: bindings and default',
    pub.data.defaultKeymapId === madeId && pub.data.keymaps.some((k) => k.name === 'MIGRATION' && k.bindings.length === 2)
  );

  // Deleting an assigned+default keymap drops both references.
  const gone = await http('POST', 'api/admin/keymaps', {
    name: 'GONE', bindings: [binding('F7', {}, 'help')]
  }, token);
  const goneId = gone.data.keymap.id;
  await http('PUT', `api/admin/systems/${seeded.id}`, { name: seeded.name, host: seeded.host, keymapId: goneId }, token);
  await http('PUT', 'api/admin/keymaps/default', { id: goneId }, token);
  const del = await http('DELETE', `api/admin/keymaps/${goneId}`, undefined, token);
  check('delete succeeds', del.status === 200);
  const afterDel = (await http('GET', 'api/admin/systems', undefined, token)).data.systems.find((s) => s.id === seeded.id);
  check('delete nulls the host assignment', afterDel.keymapId === null);
  check('delete clears the default', (await http('GET', 'api/keymaps')).data.defaultKeymapId === null);
  const del404 = await http('DELETE', `api/admin/keymaps/${goneId}`, undefined, token);
  check('second delete -> 404', del404.status === 404);

  // ------------------------------------------------ C. config export/import
  console.log('\nC. Config export and import');
  await http('PUT', `api/admin/systems/${seeded.id}`, {
    name: seeded.name, host: seeded.host, keymapId: madeId
  }, token);
  await http('PUT', 'api/admin/keymaps/default', { id: madeId }, token);
  const exportRes = await http('GET', 'api/admin/config', undefined, token, true);
  const doc = JSON.parse(await exportRes.text());
  check('export is the v2 config document', doc.kind === 'web5250-config' && doc.version === 2);
  check('export names the default', doc.defaultKeymap === 'MIGRATION');
  check('export carries keymaps by name', doc.keymaps.some((k) => k.name === 'MIGRATION' && k.bindings.length === 2));
  check('export resolves host assignment by name', doc.systems.find((s) => s.name === seeded.name)?.keymap === 'MIGRATION');
  check('export filename changed', /web5250-config-.*\.json/.test(exportRes.headers.get('content-disposition') ?? ''));

  const v2doc = {
    kind: 'web5250-config',
    version: 2,
    defaultKeymap: 'HERP',
    keymaps: [
      // Deliberately NOT Alt+Q: section D builds that binding by hand in the
      // UI, and the live-key check must pass on that map alone.
      { name: 'HERP', description: 'imported default', bindings: [binding('F7', {}, 'help')] },
      { name: 'DERP', description: '', bindings: [] }
    ],
    systems: [
      { name: 'ALPHA', host: 'alpha.example.com', keymap: 'HERP' },
      { name: 'BETA', host: 'beta.example.com', keymap: '(built-in)' },
      { name: 'GAMMA', host: 'gamma.example.com' }
    ]
  };
  const imp = await http('PUT', 'api/admin/config', v2doc, token);
  check('v2 import replaces systems and keymaps', imp.status === 200 && imp.data.count === 3, JSON.stringify(imp.data));
  const after = await http('GET', 'api/admin/keymaps', undefined, token);
  const herp = after.data.keymaps.find((k) => k.name === 'HERP');
  const sysAfter = (await http('GET', 'api/admin/systems', undefined, token)).data.systems;
  check('imported default resolves to the new id', after.data.defaultKeymapId === herp?.id);
  check('host assignment resolved by name', sysAfter.find((s) => s.name === 'ALPHA')?.keymapId === herp?.id);
  check('(built-in) pin survives import', sysAfter.find((s) => s.name === 'BETA')?.keymapId === 0);
  check('absent keymap field = gateway default', sysAfter.find((s) => s.name === 'GAMMA')?.keymapId === null);
  const reExport = JSON.parse(await (await http('GET', 'api/admin/config', undefined, token, true)).text());
  check('re-export round-trips the pin', reExport.systems.find((s) => s.name === 'BETA')?.keymap === '(built-in)');

  const keymapsBefore = after.data.keymaps.length;
  const dangling = {
    kind: 'web5250-config', version: 2,
    keymaps: [{ name: 'OK', bindings: [] }],
    systems: [{ name: 'X', host: 'x.example.com', keymap: 'NOPE' }]
  };
  const impBad = await http('PUT', 'api/admin/config', dangling, token);
  check('dangling keymap name -> 400', impBad.status === 400 && String(impBad.data.error).includes('no keymap named "NOPE"'));
  const unchanged = (await http('GET', 'api/admin/keymaps', undefined, token)).data;
  check('failed import changed nothing', unchanged.keymaps.length === keymapsBefore &&
    unchanged.keymaps.some((k) => k.name === 'HERP'));

  const v1doc = { kind: 'web5250-systems', version: 1, systems: [{ name: 'V1', host: 'v1.example.com' }] };
  const impV1 = await http('PUT', 'api/admin/config', v1doc, token);
  check('v1 document (systems only) still imports', impV1.status === 200);
  check('v1 import leaves keymaps alone', (await http('GET', 'api/admin/keymaps', undefined, token)).data.keymaps.length === keymapsBefore);
  // A bare array works too, and D needs a system that points at the mock
  // host (the import tests above replaced the catalog with fake hosts).
  await http('PUT', 'api/admin/config', [{ name: 'MOCK', host: '127.0.0.1', port: MOCK_PORT }], token);
  const sysId = (await http('GET', 'api/admin/systems', undefined, token)).data.systems
    .find((s) => s.name === 'MOCK')?.id;

  // --------------------------------------- E. destructive backspace (live)
  // The gateway screen model: type ZQX, destructive-backspace, then look:
  // the X must be gone (plain backspace only moves the cursor - the field
  // would still read ZQX). Asserting before typing anything else: in an
  // overwrite field, backspace+type would look the same either way.
  console.log('\nE. Destructive backspace on the live gateway');
  const ws = await openSession(`ws://127.0.0.1:${HTTP_PORT}/ws?system=${sysId}`);
  const ks = (k, ch) => ws.sock.send(JSON.stringify({ t: 'key', k, ...(ch ? { ch } : {}) }));
  // The host screen must arrive before keys mean anything (the gateway
  // drops input while nothing is invited yet).
  check('sign-on screen arrived', await waitFor(ws.term, (t) => t.text().includes('Sign On'), 8000, 'sign-on screen'));
  ks('char', 'Z');
  ks('char', 'Q');
  ks('char', 'X');
  check('typed ZQX into the field', await waitFor(ws.term, (t) => t.text().includes('ZQX'), 5000, 'ZQX'));
  ks('bsdelete');
  const erased = await waitFor(
    ws.term,
    (t) => t.text().includes('ZQ') && !t.text().includes('ZQX'),
    5000,
    'the erased field'
  );
  check('bsdelete erased the character left of the cursor', erased,
    ws.term.text().split('\n').filter((l) => l.includes('ZQ')).join(' | '));
  ws.sock.close();

  // -------------------------------------------------------- D. browser UI
  console.log('\nD. The visual editor and a live remapped key');
  const exeCandidates = [
    process.env.PLAYWRIGHT_CHROMIUM,
    `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
    `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-linux64/headless_shell`
  ];
  const executablePath = exeCandidates.find((p) => p && existsSync(p));
  if (!executablePath) throw new Error('no chromium binary found');

  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(`http://127.0.0.1:${HTTP_PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu:not(.hidden) .menu-row', { timeout: 10000 });

  await page.click('#menu-admin-btn');
  await page.fill('#admin-pin-input', ADMIN_PIN);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#admin-editor:not(.hidden)', { timeout: 5000 });
  await page.click('#admin-tabs button[data-tab="keymaps"]');
  await page.waitForSelector('#keymap-list li', { timeout: 5000 });
  check('keymaps tab lists the stored maps', (await page.locator('#keymap-list li').count()) === keymapsBefore);

  // Upload through the real file input (the picker's armed-click is UI-only).
  await page.setInputFiles('#keymap-file', 'data/IBMi.kmp');
  await page.waitForFunction(
    () => (document.getElementById('keymap-note')?.textContent ?? '').includes('Imported'),
    undefined, { timeout: 5000 }
  );
  check('upload lands in the list with a note', (await page.locator('#keymap-list li', { hasText: 'IBMi' }).count()) > 0);
  // ...and jumps straight into the editor for review.
  await page.waitForSelector('#keymap-editor:not(.hidden)', { timeout: 5000 });
  check('import opens the editor', (await page.locator('#keymap-grid .keycap').count()) > 40);
  check('Enter cap glows as bound', await page.locator('.keycap[data-code="Enter"].bound').count() === 1);
  await page.click('#km-cancel');

  // Build a map by hand: Alt+Q -> Attn, leave Escape alone (built-in SysReq).
  await page.click('#keymap-add');
  await page.fill('#km-name', 'UI');
  await page.selectOption('#km-add-code', 'KeyQ');
  await page.waitForFunction(
    () => (document.getElementById('km-key-title')?.textContent ?? '').includes('Q'),
    undefined, { timeout: 5000 }
  );
  // The four state rows are Plain / Shift / Ctrl / Alt.
  await page.selectOption('#km-states .km-state:nth-child(4) select', 'attn');
  await page.waitForSelector('.keycap[data-code="KeyQ"].bound', { timeout: 5000 });
  check('bound keycap lights up', true);
  check('keycap legend shows the action', ((await page.locator('.keycap[data-code="KeyQ"] .cap-sub').textContent()) ?? '').includes('Attn'));
  check('state row shows the built-in hint', ((await page.locator('#km-states .km-state:nth-child(1) small').textContent()) ?? '').includes('q'));

  // A character binding: choose "type a character…", then type it - the
  // panel must stay usable between the two steps (it used to rebuild itself
  // and reset before the character could land).
  await page.selectOption('#km-add-code', 'KeyM');
  await page.selectOption('#km-states .km-state:nth-child(3) select', 'char');
  const charInput = page.locator('#km-states .km-state:nth-child(3) input');
  await charInput.waitFor({ state: 'visible', timeout: 5000 });
  await charInput.fill('£');
  await page.waitForSelector('.keycap[data-code="KeyM"].bound', { timeout: 5000 });
  check('character binding lands from the UI', true);

  // Destructive backspace on the Alt state of the Backspace key.
  await page.selectOption('#km-add-code', 'Backspace');
  await page.selectOption('#km-states .km-state:nth-child(4) select', 'bsdelete');
  await page.waitForSelector('.keycap[data-code="Backspace"].bound', { timeout: 5000 });
  check('Destructive Backspace is bindable from the editor', true);

  await page.click('#km-save');
  // The editor hides via the .hidden class (display:none) - watch the class,
  // not "visibility" (see the sign-on PIN test's note on this).
  await page.waitForFunction(
    () => document.getElementById('keymap-editor')?.classList.contains('hidden') === true,
    undefined, { timeout: 5000 }
  );
  check(
    'saved map appears in the list with both bindings',
    ((await page.locator('#keymap-list li', { hasText: 'UI' }).textContent()) ?? '').includes('3 binding')
  );

  await page.locator('#keymap-list li', { hasText: 'UI' }).locator('button', { hasText: 'Default' }).click();
  await page.waitForFunction(
    () => Boolean(document.querySelector('#keymap-list .km-badge')),
    undefined, { timeout: 5000 }
  );
  check('default badge appears', true);
  await page.click('#admin-close');
  await sleep(500); // the catalog re-fetch rides the console close

  // Connect to the (sole) system and try the remap against the live session.
  const row = page.locator('.menu-row').first();
  await row.click();
  if (await page.isVisible('#menu')) await row.click();
  await page.waitForFunction(
    () => document.getElementById('conn-state')?.dataset.state === 'connected',
    undefined, { timeout: 10000 }
  );

  // The owner's own pane never names its own keys (notifyKey skips the
  // origin - the owner knows what she pressed), so the live-key assertions
  // watch a mirrored viewer, which is the point of the readout anyway.
  // Section E's raw session may still be lingering in grace - mirror the
  // ACTIVE owner session, not the first MOCK row in the list.
  const live = (await http('GET', 'api/admin/sessions', undefined, token)).data.sessions
    .filter((s) => s.system === 'MOCK' && s.state === 'active')
    .at(-1);
  check('live session visible to the console', Boolean(live));
  const view = await http('POST', `api/admin/sessions/${live.id}/view`, {}, token);
  const viewer = await (await browser.newContext({ viewport: { width: 900, height: 700 } })).newPage();
  await viewer.goto(`http://127.0.0.1:${HTTP_PORT}/?view=${view.data.shareToken}`, {
    waitUntil: 'domcontentloaded'
  });
  await viewer.waitForSelector('.pane canvas', { timeout: 10000 });
  await sleep(600); // let the mirrored screen arrive

  await page.keyboard.press('Alt+q');
  await viewer.waitForFunction(
    () => (document.querySelector('.oia-key')?.textContent ?? '') === 'Attn',
    undefined, { timeout: 3000 }
  );
  check('Alt+Q sends Attn (the overlay, live to the host)', true);
  await sleep(2200); // the readout clears after 2 s
  await page.keyboard.press('Escape');
  await viewer.waitForFunction(
    () => (document.querySelector('.oia-key')?.textContent ?? '') === 'SysReq',
    undefined, { timeout: 3000 }
  );
  check('Escape keeps its built-in SysReq (overlay falls through)', true);
  await sleep(2200);
  await page.keyboard.press('Alt+Backspace');
  await viewer.waitForFunction(
    () => (document.querySelector('.oia-key')?.textContent ?? '') === 'Destructive Bksp',
    undefined, { timeout: 3000 }
  );
  check('Alt+Backspace sends the destructive backspace, live', true);
  check('no page errors along the way', pageErrors.length === 0, pageErrors.join(' | '));
  await browser.close();

  console.log(failures === 0 ? '\nAll keymap checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
