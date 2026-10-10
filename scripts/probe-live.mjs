// Probe a live TN5250 host: negotiate, capture the first screens, and report
// (a) raw record hex, (b) what our parser built from it (fields, cursor, OIA).
// Usage: node scripts/probe-live.mjs <host> [port]
import { Tn5250Client } from '../src/server/tn5250/client.ts';

const host = process.argv[2] ?? '192.0.2.10';
const port = Number.parseInt(process.argv[3] ?? '23', 10);

const client = new Tn5250Client({
  host,
  port,
  ssl: false,
  tlsRejectUnauthorized: false,
  termType: 'IBM-3477-FC',
  deviceName: 'PROBE1',
  codePage: 'cp037'
});

const origParse = client.parse;
let recordCount = 0;
client.onStatus = (s, d) => console.log(`[status] ${s}${d ? ' (' + d + ')' : ''}`);

// Tap onRecord by wrapping the telnet onRecord via onScreenChange side effects
// is not enough - instead monkey-patch the parser's parse().
setTimeout(() => {
  const parser = client.parser;
  const orig = parser.parse.bind(parser);
  parser.parse = (rec) => {
    recordCount++;
    console.log(`\n=== record #${recordCount} (${rec.length} bytes) ===`);
    console.log(rec.toString('hex').replace(/(..)/g, '$1 '));
    orig(rec);
    const s = client.screen;
    console.log(
      `[after parse] fields=${s.fields.length} cursor=${s.rowOf(s.cursorPos)},${s.colOf(s.cursorPos)} ` +
        `lock=${s.lock} waiting=${s.waitingForInput} readType=0x${s.readType.toString(16)}`
    );
    if (s.fields.length) {
      for (const f of s.fields.slice(0, 8)) {
        console.log(
          `  field @${s.rowOf(f.startPos)},${s.colOf(f.startPos)} attr=0x${f.attr.toString(16)} ` +
            `len=${f.length} ffw0=0x${f.ffw0.toString(16)} ffw1=0x${f.ffw1.toString(16)} bypass=${f.isBypass}`
        );
      }
    }
  };
}, 0);

client.connect();
setTimeout(() => {
  const s = client.screen;
  console.log('\n=== screen text after 8s ===');
  for (let r = 1; r <= s.rows; r++) {
    let line = '';
    for (let c = 1; c <= s.cols; c++) line += s.chars[s.posOf(r, c)] ?? ' ';
    console.log(`${String(r).padStart(2)}|${line.replace(/\s+$/, '')}`);
  }
  console.log(`fields=${s.fields.length} cursor=${s.rowOf(s.cursorPos)},${s.colOf(s.cursorPos)} lock=${s.lock} waiting=${s.waitingForInput}`);
  process.exit(0);
}, 8000);
