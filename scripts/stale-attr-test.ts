// Repro for "leftovers when the host repaints without CLEAR UNIT": the host
// (Hirschbach live stream) erases via RA-spaces and rewrites labels, but
// cells still flagged attrPlace from the previous format eat the new text.
// Usage: node scripts/repro-stale-attr.ts
import { Screen5250 } from '../src/server/tn5250/screen.ts';
import { Parser5250 } from '../src/server/tn5250/parser.ts';
import { Ebcdic } from '../src/server/tn5250/ebcdic.ts';
import type { Telnet5250 } from '../src/server/tn5250/telnet.ts';

const warns: string[] = [];
const telnet = { sendGds: () => {} } as unknown as Telnet5250;
const ebcdic = new Ebcdic('cp037');
const screen = new Screen5250(ebcdic);
const parser = new Parser5250(screen, telnet, ebcdic, (m) => warns.push(m));

const e = (s: string): number[] => [...s].map((ch) => ebcdic.uni2ebcdic(ch));
const gds = (payload: number[]): Buffer => {
  const len = payload.length + 10; // 2-byte length word + 8-byte GDS header
  return Buffer.from([(len >> 8) & 0xff, len & 0xff, 0x12, 0xa0, 0, 0, 4, 0, 0, 2, ...payload]);
};

// --- old screen: labels + input fields (attribute cells at 5,12 / 11,12 /
// 11,16 - where the next screen will write heading text) and a '+' at 17,78.
const old: number[] = [
  0x04, 0x40, // ESC, CLEAR UNIT
  0x04, 0x11, 0x00, 0x00, // ESC, WTD cc0 cc1
  0x01, 0x07, 0, 0, 0, 0x18, 0, 0, 0, // SOH (clear format table)
  // row 5: label then a field whose attribute cell sits at 5,12
  0x11, 5, 9, 0x24, ...e('OLD'),
  0x11, 5, 12, 0x1d, 0x24, 0x00, 0x0a, ...e('FIELDONE'),
  // row 11: two fields, attribute cells at 11,12 and 11,16
  0x11, 11, 9, 0x24, ...e('AB'),
  0x11, 11, 12, 0x1d, 0x24, 0x00, 0x03, ...e('XYZ'),
  0x11, 11, 16, 0x1d, 0x24, 0x00, 0x05, ...e('INPUT'),
  // row 17: a '+' indicator at 17,78
  0x11, 17, 78, 0x20, ...e('+')
];
parser.parse(gds(old));

// --- new screen, in the live host's rx#5 dialect: NO CLEAR UNIT - an
// RA-spaces erase over rows 3..19, then the new labels written straight
// over the old field attribute cells.
const next: number[] = [
  0x04, 0x11, 0x00, 0x20, // ESC, WTD cc0 cc1
  0x11, 3, 1, 0x20, 0x02, 19, 80, 0x00, // SBA(3,1) attr RA->(19,80) spaces
  0x11, 5, 9, 0x24, ...e('REVIEW UPDATE'),
  0x11, 11, 9, 0x24, ...e('INQUIRY/DISPLAY'),
  0x11, 17, 70, 0x20, ...e('123456789')
];
parser.parse(gds(next));

const row = (r: number): string => screen.chars.slice((r - 1) * 80, r * 80).join('').replace(/\s+$/, '');
console.log('row 5 : |' + row(5) + '|');
console.log('row 11: |' + row(11) + '|');
console.log('row 17: |' + row(17) + '|');
console.log('attrPlace left at 5,12/11,12/11,16/17,78:',
  screen.attrPlace[screen.posOf(5, 12)], screen.attrPlace[screen.posOf(11, 12)],
  screen.attrPlace[screen.posOf(11, 16)], screen.attrPlace[screen.posOf(17, 78)]);

const ok =
  row(5).includes('REVIEW UPDATE') &&
  row(11).includes('INQUIRY/DISPLAY') &&
  row(17).endsWith('123456789');
console.log(ok ? 'PASS' : 'FAIL');
if (warns.length) console.log('warns:', warns.join(' | '));
process.exit(ok ? 0 : 1);
