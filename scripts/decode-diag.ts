// Decode a diagnostics capture (the Diag button output) for 5250 GUI-order
// discovery: renders each record's screen text and catalogs candidate GUI
// orders (menu bar X'22' and friends) with position and byte context.
// Usage: node scripts/decode-diag.ts <capture.txt>
import { EBCDIC_PAGES } from '../src/server/tn5250/ebcdic-tables.ts';

const capture = process.argv[2];
const page = EBCDIC_PAGES.cp037;
const e2u = (b: number) => page[b] ?? '?';

const lines = (await import('node:fs')).readFileSync(capture, 'utf8').split('\n');

for (const line of lines) {
  const m = /^ \[tn5250 (\S+)\] rx#(\d+) ([0-9a-f]+)$/.exec(' ' + line);
  if (!m) continue;
  const [, dev, num, hex] = m;
  const rec = Buffer.from(hex, 'hex');
  const rows = rec.length > 400 ? 27 : 24, cols = rows === 27 ? 132 : 80;
  let grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill(' '));
  let candidates: string[] = [];
  let pos = 6 + (rec[6] ?? 4);
  const end = rec.length;
  let wr = 0; // linear write pos
  const setPos = (r: number, c: number) => { wr = (Math.max(r, 1) - 1) * cols + (Math.max(c, 1) - 1); };
  const put = (s: string) => { for (const ch of s) { if (wr < rows * cols) grid[Math.floor(wr / cols)][wr % cols] = ch; wr++; } };
  const putRaw = (b: number) => { if (b >= 0x40 && b < 0xff) put(e2u(b)); else put('.'); wr--; }; // control-range: overwrite in place marker
  const next = () => rec[pos++] & 0xff;
  const peekCtx = (n: number) => rec.subarray(pos, pos + n).toString('hex');

  let orderPos = false; // next byte sits in order position
  const takeByte = (inWtd: boolean): boolean => {
    if (pos >= end) return false;
    const b = next();
    switch (b) {
      case 0x11: { const r = next(), c = next(); setPos(r, c); orderPos = true; break; }
      case 0x13: case 0x14: { const r = next(), c = next(); if (inWtd && (r < 1 || r > rows || c < 1 || c > cols)) candidates.push(`  INVALID ${b === 0x13 ? 'IC' : 'MC'} (${r},${c}) @pos${pos}`); orderPos = true; break; }
      case 0x12: next(); next(); orderPos = true; break;
      case 0x02: next(); next(); next(); next(); orderPos = true; break; // RA + 3
      case 0x03: { next(); next(); next(); const l = next(); for (let i = 1; i < l; i++) next(); orderPos = true; break; }
      case 0x10: { const l = (next() << 8) | next(); for (let i = 0; i < l && pos < end; i++) next(); orderPos = true; break; }
      case 0x15: { const l = (next() << 8) | next(); for (let i = 0; i < l && pos < end; i++) next(); orderPos = true; break; }
      case 0x01: { const l = next(); for (let i = 0; i < l && pos < end; i++) next(); orderPos = true; break; } // SOH approx: consume len bytes
      case 0x1d: {
        // SF: mirror the parser's three shapes just enough to resync
        let ffw0 = next();
        let attr = 0;
        if ((ffw0 & 0x40) === 0x40 || (ffw0 & 0xe0) !== 0x20) {
          next(); // ffw1
          let fcw1 = next();
          if (fcw1 === 0x81) { next(); fcw1 = next(); }
          if ((fcw1 & 0xe0) !== 0x20) { next(); attr = next(); let g = 0; while ((attr & 0xe0) !== 0x20 && g++ < 16 && pos < end) attr = next(); }
          else attr = fcw1;
        } else attr = ffw0;
        next(); next(); // length word
        put('.'); // attr cell
        orderPos = true;
        break;
      }
      case 0x04: return false; // ESC ends the WTD
      default: {
        if (orderPos && ![0x40, 0x4b, 0x60, 0x61, 0x6b, 0x7a, 0xa2, 0xa3, 0x81, 0x85, 0x89, 0x93, 0x95, 0x96, 0x99].includes(b) && ((b >= 0x20 && b <= 0x3f) || (b >= 0x02 && b <= 0x0f) || b === 0x16 || b === 0x17)) {
          const rr = Math.floor(wr / cols) + 1, cc = (wr % cols) + 1;
          const kind = (b & 0xe0) === 0x20 ? `GUI?(attr-range 0x${b.toString(16)})` : `GUI? 0x${b.toString(16)}`;
          candidates.push(`  ${kind} @ (${rr},${cc}) ctx=${peekCtx(10)}`);
        }
        if (b >= 0x20 && b <= 0x3f) put('.'); // attribute cell
        else if (b >= 0x40 && b < 0xff) put(e2u(b));
        else put('·');
        orderPos = false;
      }
    }
    return true;
  };

  // command level
  const cmds: string[] = [];
  while (pos < end) {
    const cmd = next();
    cmds.push(`0x${cmd.toString(16)}`);
    if (cmd === 0x11) { // WTD
      next(); next(); // WCC
      while (takeByte(true));
    } else if (cmd === 0x21 || cmd === 0x22) { next(); next(); next(); }
    // others: no params we care about here
  }
  console.log(`\n=== rx#${num} (${dev}) cmds: ${cmds.join(' ')} rows=${rows}`);
  for (const c of candidates) console.log(c);
  grid.forEach((row, i) => { const t = row.join('').replace(/\s+$/, ''); if (t.trim()) console.log(`  ${String(i + 1).padStart(2)}|${t}`); });
}
