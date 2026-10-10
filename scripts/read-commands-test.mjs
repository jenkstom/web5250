// Regression: the read-command variants real hosts emit while paging
// (ROLL + READ IMMEDIATE 0x72, READ MDT ALT 0x82, read-screen variants).
// Guards the class of bug where an unrecognized command made the parser
// send a negative response - which IBM i answers by dropping the session.
// Usage: node scripts/read-commands-test.mjs
import { Screen5250 } from '../src/server/tn5250/screen.ts';
import { Parser5250 } from '../src/server/tn5250/parser.ts';
import { Ebcdic } from '../src/server/tn5250/ebcdic.ts';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  [${cond ? 'ok' : 'FAIL'}] ${name}${cond ? '' : ' - ' + detail}`);
  if (!cond) failures++;
};

const e = new Ebcdic('cp037');
const E = (s) => [...s].map((c) => e.uni2ebcdic(c));

// Fake transport: capture outbound GDS records; flag any negative response.
const outbound = [];
const fakeTelnet = {
  sendGds(flags, opcode, payload) {
    outbound.push({ flags, opcode, payload: Buffer.from(payload ?? []) });
  }
};

function record(...streams) {
  const commands = streams.flat();
  const body = [0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, 0x03, ...commands];
  // 2-byte length prefix counts every byte after itself (before IAC doubling).
  return Buffer.from([((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body]); // RFC 1205: length counts itself
}
const esc = (cmd, ...rest) => [0x04, cmd, ...rest];
const SBA = 0x11, SF = 0x1d, IC = 0x13;

const s = new Screen5250(e);
const p = new Parser5250(s, fakeTelnet, e, (m) => console.log('   warn:', m));

// 1. Sign-on-like screen with a list body (fields + text), RIF invite.
p.parse(
  record(
    esc(0x40),
    esc(0x11, 0x40, 0x20, ...[
      [SBA, 2, 5, ...E('WRKACTJOB-ish list')],
      [SBA, 4, 5, ...E('option')],
      [SBA, 4, 20, SF, 0x20, 0x00, 0x02],
      [SBA, 24, 5, ...E('F3=Exit  PageDown=Next')],
      [IC, 4, 21]
    ].flat()),
    esc(0x42, 0x00, 0x00)
  )
);
check('invite parsed (waiting)', s.waitingForInput === true);
check('option field present', s.fields.length === 1 && s.fields[0].length === 2, JSON.stringify(s.fields.map((f) => f.length)));

// 2. Type into the field, then the host pages: ROLL command + full rewrite.
s.typeChar('9');
const aidCountBefore = outbound.length;
p.parse(record(esc(0x23, 0x01, 0x01, 0x23))); // ROLL up 1, lines 1..23
p.parse(
  record(
    esc(0x11, 0x40, 0x20, ...[
      [SBA, 2, 5, ...E('page 2 of list')],
      [SBA, 4, 20, SF, 0x20, 0x00, 0x02],
      [IC, 4, 21]
    ].flat()),
    esc(0x52, 0x00, 0x00)
  )
);
check('ROLL + rewrite + RMD invite survived', s.waitingForInput === true);
check('no negative responses during paging', outbound.slice(aidCountBefore).every((r) => (r.flags & 0x80) === 0), JSON.stringify(outbound.slice(aidCountBefore).map((r) => r.flags)));

// 3. READ IMMEDIATE (0x72): host wants the data NOW. Reply must carry the
//    [cursor row, cursor col, AID=0] header before the field runs. (The
//    page-2 rewrite reset MDTs via WCC0, so type first - an unmodified
//    screen legitimately reads back empty.)
s.typeChar('9');
outbound.length = 0;
p.parse(record(esc(0x72, 0x00, 0x00)));
{
  const replies = outbound.filter((r) => r.opcode === 3);
  check('0x72 answered immediately', replies.length === 1, JSON.stringify(outbound.map((r) => r.opcode)));
  const body = replies[0]?.payload ?? Buffer.alloc(0);
  check('0x72 reply starts with row,col,AID=0', body.length >= 3 && body[2] === 0x00, body.toString('hex'));
  check('0x72 reply carries field text', body.length > 3, body.toString('hex'));
  check('0x72 not treated as unknown command', outbound.every((r) => (r.flags & 0x80) === 0));
}

// 4. READ MDT FIELDS ALT (0x82): an invite like 0x52.
p.parse(record(esc(0x82, 0x00, 0x00)));
check('0x82 invite accepted (waiting)', s.waitingForInput === true);
check('0x82 sets MDT-style read type', s.readType === 0x82, `0x${s.readType.toString(16)}`);

// 5. Read-screen variants: answered with a dump, never an error record.
for (const cmd of [0x62, 0x64, 0x66, 0x68, 0x6a, 0x6c]) {
  outbound.length = 0;
  p.parse(record(esc(cmd, 0x00, 0x00)));
  const ok = outbound.some((r) => r.opcode === 0) && outbound.every((r) => (r.flags & 0x80) === 0);
  check(`read-screen 0x${cmd.toString(16)} answered with dump`, ok, JSON.stringify(outbound.map((r) => [r.flags, r.opcode])));
}

// 6. Sanity: a genuinely unknown command still reports a negative response.
outbound.length = 0;
p.parse(record(esc(0x37, 0x00, 0x00)));
check('unknown command still negative-responds', outbound.some((r) => (r.flags & 0x80) !== 0));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
