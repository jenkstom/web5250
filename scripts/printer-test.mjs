// Printer-session E2E: the mock host's printer mode + the built gateway.
// Covers the happy path (SCS jobs arrive, are listed, download with the
// right bytes), display sessions alongside printers, retention (drop-oldest),
// the failure paths (host refuses startup, device name in use), raw mode
// (PDF sniffing), and the credential-visibility rules of the new API.
//
// Usage: npm run build && npm run test:printer
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MOCK_PORT = 18223;
const MOCK_STARTUP_REFUSED_PORT = 18224;
const MOCK_DEV_INUSE_PORT = 18225;
const MOCK_RAW_PORT = 18226;
const MOCK_MANY_PORT = 18227;
const GW_PORT = 18280;
const GW_RETENTION_PORT = 18281;
const GW_ERROR_PORT = 18282;
const GW_RAW_PORT = 18283;
const ADMIN_PIN = '9876';
const DEVICE = 'WEB5250P';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail = '') {
  const mark = cond ? 'ok' : 'FAIL';
  console.log(`  [${mark}] ${name}${cond ? '' : ` - ${detail}`}`);
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
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return false;
}

async function waitFor(pred, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(60);
  }
  return false;
}

async function startGateway(port, db, env = {}) {
  const gw = spawn(process.execPath, ['dist/server.js'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(port),
      IBM_I_HOST: '127.0.0.1',
      IBM_I_PORT: String(MOCK_PORT),
      IBM_I_DEV_PREFIX: 'TEST_',
      IBM_I_TERM_TYPE: 'IBM-3477-FC',
      IBM_I_CODEPAGE: 'cp037',
      ADMIN_PIN,
      SESSION_GRACE_MS: '0',
      WEB5250_DB: db,
      IBM_I_PRINTER_ENABLED: '1',
      IBM_I_PRINTER_DEVNAME: DEVICE,
      IBM_I_PRINTER_MODE: 'text',
      ...env
    }
  });
  procs.push(gw);
  if (!(await waitHealthy(port))) {
    console.error(`gateway on ${port} never became healthy`);
    process.exit(1);
  }
  return gw;
}

async function adminAuth(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/admin/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: ADMIN_PIN })
  });
  const data = await res.json();
  return { 'content-type': 'application/json', authorization: `Bearer ${data.token}` };
}

const printerStatus = async (port) =>
  (await (await fetch(`http://127.0.0.1:${port}/api/printer-status`)).json()).printers;

const listJobs = async (port) =>
  (await (await fetch(`http://127.0.0.1:${port}/api/printjobs`)).json()).jobs;

// ------------------------------------------------------------ WS "browser"
class Term {
  rows = 24;
  cols = 80;
  cells = [];
  status = null;

  apply(msg) {
    if (msg.t === 'screen') {
      this.rows = msg.rows;
      this.cols = msg.cols;
      this.cells = new Array(this.rows * this.cols).fill(' ');
      for (const [pos, , ch] of msg.cells) this.cells[pos] = String(ch ?? ' ');
    } else if (msg.t === 'update') {
      if (Array.isArray(msg.cells)) {
        for (const [pos, , ch] of msg.cells) this.cells[pos] = String(ch ?? ' ');
      }
    } else if (msg.t === 'status') {
      this.status = msg;
    }
  }

  text() {
    const out = [];
    for (let r = 1; r <= this.rows; r++) {
      let s = '';
      for (let c = 0; c < this.cols; c++) s += this.cells[(r - 1) * this.cols + c] ?? ' ';
      out.push(s.replace(/\s+$/, ''));
    }
    return out.join('\n');
  }
}

function wsTerm(port, query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
  const term = new Term();
  ws.addEventListener('message', (ev) => term.apply(JSON.parse(String(ev.data))));
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return { ws, term, opened };
}

// ------------------------------------------------------------------- setup
console.log('Starting mock hosts...');
const mock = (port, env = {}) =>
  procs.push(spawn(process.execPath, ['scripts/mock-host.mjs', String(port)], { stdio: 'inherit', env: { ...process.env, ...env } }));
mock(MOCK_PORT, { MOCK_PRINT_JOBS: '2' });
mock(MOCK_STARTUP_REFUSED_PORT, { MOCK_PRINT_STARTUP: '8902' });
mock(MOCK_DEV_INUSE_PORT, { MOCK_PRINT_DEV_INUSE: '1' });
mock(MOCK_RAW_PORT, { MOCK_PRINT_MODE: 'raw', MOCK_PRINT_JOBS: '1' });
mock(MOCK_MANY_PORT, { MOCK_PRINT_JOBS: '5' });
await sleep(300);

// ============================================== 1. text mode: jobs arrive
{
  console.log('\n1. Text-mode printer session (seeded from IBM_I_PRINTER_*)');
  const db = join(mkdtempSync(join(tmpdir(), 'web5250-print-')), 'menu.db');
  await startGateway(GW_PORT, db);

  check(
    'printer reaches ready',
    await waitFor(async () => (await printerStatus(GW_PORT))[0]?.state === 'ready', 10000),
    JSON.stringify(await printerStatus(GW_PORT))
  );
  const st = (await printerStatus(GW_PORT))[0];
  check('status carries device and mode', st.device === DEVICE && st.mode === 'text', JSON.stringify(st));

  check(
    'two spool jobs arrive',
    await waitFor(async () => (await listJobs(GW_PORT)).length === 2, 10000),
    JSON.stringify(await listJobs(GW_PORT))
  );
  const jobs = await listJobs(GW_PORT);
  check(
    'job metadata is complete',
    jobs.every(
      (j) =>
        /^[0-9a-f]{32}$/.test(j.token) && j.device === DEVICE && j.mode === 'text' &&
        j.format === 'txt' && j.bytes > 0 && j.pages === 2 && j.systemName === 'IBM i'
    ),
    JSON.stringify(jobs)
  );

  // Fetch both jobs; identify them by content (both have two pages).
  const texts = await Promise.all(
    jobs.map(async (j) => ({
      job: j,
      text: await (await fetch(`http://127.0.0.1:${GW_PORT}/api/printjobs/${j.token}`)).text()
    }))
  );
  const job1 = texts.find((t) => t.text.includes('SPOOL REPORT 001'));
  const job2 = texts.find((t) => t.text.includes('SPOOL REPORT 002'));
  check('both jobs downloaded', Boolean(job1 && job2), JSON.stringify(texts.map((t) => t.text.slice(0, 24))));

  const dl = await fetch(`http://127.0.0.1:${GW_PORT}/api/printjobs/${job1.job.token}`);
  const text = job1.text;
  check('download: text/plain utf-8, no-store', dl.headers.get('content-type') === 'text/plain; charset=utf-8' && dl.headers.get('cache-control') === 'no-store', `${dl.headers.get('content-type')} ${dl.headers.get('cache-control')}`);
  check('download names the file', (dl.headers.get('content-disposition') ?? '').startsWith('attachment; filename="spool-WEB5250P-'), dl.headers.get('content-disposition') ?? '');
  check('extracted text has both pages and the form feed', text.includes('MOCK400 SPOOL REPORT 001') && text.includes('REPORT 1 PAGE 2') && text.includes('\f'), JSON.stringify(text.slice(0, 120)));

  check(
    'record-split + segment-split job reassembles',
    job2.text.includes('MOCK400 SPOOL REPORT 002') && job2.text.includes('Second page content'),
    JSON.stringify(job2.text.slice(0, 160))
  );

  const missing = await fetch(`http://127.0.0.1:${GW_PORT}/api/printjobs/${'0'.repeat(32)}`);
  check('unknown token is a JSON 404', missing.status === 404 && (await missing.json()).error !== undefined);

  // ------------------------------------------------ display still works
  const { ws, term, opened } = wsTerm(GW_PORT, '?system=1');
  await opened;
  check(
    'display sessions coexist with the printer',
    await waitFor(() => term.text().includes('AS/400 Sign On'), 8000, term.text().slice(0, 200))
  );
  ws.close();
  await sleep(300);

  // ------------------------------------------------------ leak checks
  console.log('\n2. Printer details stay off the public system list');
  const http = `http://127.0.0.1:${GW_PORT}`;
  const publicBody = await (await fetch(`${http}/api/systems`)).text();
  check('public list flags the printer', publicBody.includes('"printerEnabled":true'), publicBody);
  check('public list has no printer device name', !publicBody.includes(DEVICE), publicBody);
  const authHeaders = await adminAuth(GW_PORT);
  const adminRow = (await (await fetch(`${http}/api/admin/systems`, { headers: authHeaders })).json()).systems[0];
  check('admin row carries the printer fields', adminRow.printerEnabled === true && adminRow.printerDeviceName === DEVICE && adminRow.printerMode === 'text', JSON.stringify(adminRow));

  // ---------------------------------------------------- delete is admin
  const del = await fetch(`${http}/api/printjobs/${job1.job.token}`, { method: 'DELETE' });
  check('job delete requires the admin token', del.status === 401);
  const delAuth = await fetch(`${http}/api/printjobs/${job1.job.token}`, { method: 'DELETE', headers: authHeaders });
  check('admin can delete a job', delAuth.status === 200);
  check(
    'deleted job is gone from the list',
    await waitFor(async () => (await listJobs(GW_PORT)).length === 1, 5000),
    JSON.stringify(await listJobs(GW_PORT))
  );
  check('deleted job download 404s', (await fetch(`${http}/api/printjobs/${job1.job.token}`)).status === 404);
}

// ==================================================== 3. retention purge
{
  console.log('\n3. Retention: newest PRINTJOBS_MAX_COUNT jobs survive');
  const db = join(mkdtempSync(join(tmpdir(), 'web5250-print-ret-')), 'menu.db');
  await startGateway(GW_RETENTION_PORT, db, {
    PRINTJOBS_MAX_COUNT: '3',
    IBM_I_PORT: String(MOCK_MANY_PORT)
  });
  // Five jobs arrive back-to-back; poll until the store settles on the
  // newest three (a snapshot taken the instant the count hits 3 still sees
  // reports 001-003 before 004/005 arrive and push the oldest out).
  const settled = async () => {
    const jobs = await listJobs(GW_RETENTION_PORT);
    if (jobs.length !== 3) return [];
    return Promise.all(
      jobs.map(async (j) => await (await fetch(`http://127.0.0.1:${GW_RETENTION_PORT}/api/printjobs/${j.token}`)).text())
    );
  };
  check(
    'five jobs arrive, three newest survive (drop-oldest)',
    await waitFor(async () => {
      const texts = await settled();
      return (
        texts.length === 3 &&
        texts.every((t) => !t.includes('SPOOL REPORT 001') && !t.includes('SPOOL REPORT 002')) &&
        texts.filter((t) => /SPOOL REPORT 00[345]/.test(t)).length === 3
      );
    }, 10000)
  );
}

// ===================================================== 4. failure paths
{
  console.log('\n4. Failure paths (host refuses / name in use)');
  const db = join(mkdtempSync(join(tmpdir(), 'web5250-print-err-')), 'menu.db');
  await startGateway(GW_ERROR_PORT, db, { IBM_I_PORT: String(MOCK_STARTUP_REFUSED_PORT) });
  check(
    'startup refusal surfaces in printer-status',
    await waitFor(async () => (await printerStatus(GW_ERROR_PORT))[0]?.state === 'error', 10000),
    JSON.stringify(await printerStatus(GW_ERROR_PORT))
  );
  check(
    'refusal names the host code',
    /8902|device not available/.test((await printerStatus(GW_ERROR_PORT))[0]?.detail ?? ''),
    JSON.stringify(await printerStatus(GW_ERROR_PORT))
  );

  const db2 = join(mkdtempSync(join(tmpdir(), 'web5250-print-inuse-')), 'menu.db');
  await startGateway(GW_ERROR_PORT + 100, db2, { IBM_I_PORT: String(MOCK_DEV_INUSE_PORT) });
  check(
    'device-name collision surfaces in printer-status',
    await waitFor(async () => /in use/.test((await printerStatus(GW_ERROR_PORT + 100))[0]?.detail ?? ''), 10000),
    JSON.stringify(await printerStatus(GW_ERROR_PORT + 100))
  );
}

// ======================================================== 5. raw mode
{
  console.log('\n5. Raw mode (host print transform output, PDF sniffing)');
  const db = join(mkdtempSync(join(tmpdir(), 'web5250-print-raw-')), 'menu.db');
  await startGateway(GW_RAW_PORT, db, {
    IBM_I_PORT: String(MOCK_RAW_PORT),
    IBM_I_PRINTER_MODE: 'raw'
  });
  check(
    'raw job arrives and is sniffed as pdf',
    await waitFor(async () => (await listJobs(GW_RAW_PORT)).some((j) => j.format === 'pdf'), 10000),
    JSON.stringify(await listJobs(GW_RAW_PORT))
  );
  const job = (await listJobs(GW_RAW_PORT)).find((j) => j.format === 'pdf');
  const dl = await fetch(`http://127.0.0.1:${GW_RAW_PORT}/api/printjobs/${job.token}`);
  const body = await dl.text();
  check('pdf download: application/pdf and %PDF magic', dl.headers.get('content-type') === 'application/pdf' && body.startsWith('%PDF-1.4'), `${dl.headers.get('content-type')} ${body.slice(0, 8)}`);
  check('raw job carries no page count', job.pages === null, JSON.stringify(job));
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
