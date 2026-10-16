// Real-IBM i printer-session validation (operator-run; env-gated).
//
// Unlike test:printer (mock host), this connects the gateway's printer
// session to a live host and waits for YOU to print: run it, then route a
// known spool file to the device's output queue - WRKSPLF, option 2
// (Change) next to the file, page down and set "Output queue" to the
// device (e.g. WEB5250P), Enter. The connected printer session is the
// writer, so the file starts printing down the session immediately. The
// script downloads whatever arrives, saves it under artifacts/, and checks
// it against PRINTER_TEST_EXPECT when given.
//
// Usage:
//   PRINTER_TEST_HOST=as400.corp.lan PRINTER_TEST_DEVNAME=WEB5250P \
//   PRINTER_TEST_EXPECT="SALES REPORT" [PRINTER_TEST_PORT=23]
//   [PRINTER_TEST_SSL=false] [PRINTER_TEST_MODE=text] [PRINTER_TEST_CP=cp037] \
//   [PRINTER_TEST_WAIT_MS=180000]  npm run build && npm run test:printer-real
//
// Host prerequisites (see docs/printer-session-notes.md section 6):
//   CRTCTLVDE CTLD(QVIRCD0001)                      // once, if missing
//   VRYCFG CFGOBJ(QVIRCD0001) CFGTYPE(*CTL) STATUS(*ON)
//   CRTDEVPRT DEVD(WEB5250P) DEVCLS(*VRT) CTL(QVIRCD0001)
//            TYPE(3812) MODEL(1) FONT(011) FORMFEED(*CONT)
//   VRYCFG CFGOBJ(WEB5250P) CFGTYPE(*DEV) STATUS(*ON)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = process.env.PRINTER_TEST_HOST;
const PORT = process.env.PRINTER_TEST_PORT ?? '23';
const SSL = process.env.PRINTER_TEST_SSL === 'true' || process.env.PRINTER_TEST_SSL === '1';
const DEVNAME = (process.env.PRINTER_TEST_DEVNAME ?? 'WEB5250P').toUpperCase();
const MODE = process.env.PRINTER_TEST_MODE === 'raw' ? 'raw' : 'text';
const CP = (process.env.PRINTER_TEST_CP ?? 'cp037').toLowerCase();
const EXPECT = process.env.PRINTER_TEST_EXPECT ?? null;
const WAIT_MS = Number.parseInt(process.env.PRINTER_TEST_WAIT_MS ?? '180000', 10);
const HTTP_PORT = 18085;

if (!HOST) {
  console.error(
    'Set PRINTER_TEST_HOST (and optionally PORT/SSL/DEVNAME/MODE/CP/EXPECT).\n' +
      'Example: PRINTER_TEST_HOST=as400.corp.lan PRINTER_TEST_EXPECT="SALES REPORT" npm run test:printer-real'
  );
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  [${cond ? 'ok' : 'FAIL'}] ${name}${cond ? '' : ` - ${detail}`}`);
  if (!cond) failures++;
}

const procs = [];
process.on('exit', () => {
  for (const p of procs) p.kill();
});

async function waitHealthy() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${HTTP_PORT}/healthz`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return false;
}

console.log(`Starting gateway -> ${HOST}:${PORT} (${SSL ? 'TLS' : 'telnet'}, ${DEVNAME}, ${MODE}, ${CP})...`);
const gw = spawn(process.execPath, ['dist/server.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(HTTP_PORT),
    IBM_I_HOST: HOST,
    IBM_I_PORT: PORT,
    IBM_I_SSL: String(SSL),
    IBM_I_CODEPAGE: CP,
    IBM_I_PRINTER_ENABLED: '1',
    IBM_I_PRINTER_DEVNAME: DEVNAME,
    IBM_I_PRINTER_MODE: MODE,
    WEB5250_DB: join(mkdtempSync(join(tmpdir(), 'web5250-print-real-')), 'menu.db')
  }
});
procs.push(gw);
if (!(await waitHealthy())) {
  console.error('gateway never became healthy');
  process.exit(1);
}

const status = async () =>
  (await (await fetch(`http://127.0.0.1:${HTTP_PORT}/api/printer-status`)).json()).printers?.[0];
const listJobs = async () =>
  (await (await fetch(`http://127.0.0.1:${HTTP_PORT}/api/printjobs`)).json()).jobs ?? [];

// Wait for the startup response - errors here are host-side configuration.
let ready = false;
for (let i = 0; i < 100 && !ready; i++) {
  const st = await status();
  if (st?.state === 'ready') ready = true;
  else if (st?.state === 'error') console.log(`  printer: ${st.detail} (retrying with backoff)`);
  await sleep(1000);
}
check('printer session reached ready on the real host', ready, JSON.stringify(await status()));
if (!ready) process.exit(1);

console.log(
  `\nNow print on the host: send a spool file to ${DEVNAME}'s output queue\n` +
    `(WRKSPLF -> option 2 next to it -> Output queue = ${DEVNAME}, or move it).\n` +
    `Waiting up to ${Math.round(WAIT_MS / 1000)}s...`
);

let job = null;
for (const deadline = Date.now() + WAIT_MS; !job && Date.now() < deadline; ) {
  job = (await listJobs())[0] ?? null;
  if (!job) await sleep(2000);
}
check('a spool job arrived', Boolean(job), 'nothing arrived before the timeout');
if (!job) process.exit(1);

const dl = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/printjobs/${job.token}`);
const buf = Buffer.from(await dl.arrayBuffer());
mkdirSync('artifacts', { recursive: true });
const out = `artifacts/printer-real-job.${job.format}`;
writeFileSync(out, buf);
console.log(`  saved ${buf.length} bytes -> ${out} (${dl.headers.get('content-type')})`);
check('download served the job', dl.ok && buf.length === job.bytes);

if (job.format === 'txt') {
  const text = buf.toString('utf8');
  const preview = text.replace(/\f/g, '\n--- page break ---\n').split('\n').slice(0, 12).join('\n');
  console.log(`  first lines:\n${preview
    .split('\n')
    .map((l) => `    | ${l}`)
    .join('\n')}`);
  check('text extraction is not empty', text.trim().length > 0);
  if (EXPECT) check(`text contains "${EXPECT}"`, text.includes(EXPECT));
} else if (EXPECT) {
  console.log(`  (raw mode: expectation text skipped; inspect ${out})`);
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
