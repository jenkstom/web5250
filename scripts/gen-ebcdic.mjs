// Generates src/server/tn5250/ebcdic-tables.ts using the system iconv
// (glibc ships every EBCDIC code page IBM i uses). Each output entry is a
// 256-element string array indexed by EBCDIC byte value.
//
// The generated file is committed so neither the Docker build nor runtime
// needs iconv/codepage access.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PAGES = {
  cp037: 'IBM037', // US/Canada EBCDIC (default)
  cp273: 'IBM273', // Austria/Germany
  cp277: 'IBM277', // Denmark/Norway
  cp278: 'IBM278', // Finland/Sweden
  cp280: 'IBM280', // Italy
  cp284: 'IBM284', // Spain/Latin America
  cp285: 'IBM285', // UK
  cp297: 'IBM297', // France
  cp500: 'IBM500', // International
  cp871: 'IBM871', // Iceland
  cp1047: 'IBM1047', // Latin-1 Open Systems
  cp1140: 'IBM1140' // cp037 with Euro at 0x9F
};

function decodePage(iconvName) {
  const res = spawnSync('iconv', ['-f', iconvName, '-t', 'UTF-32LE'], {
    input: Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
    maxBuffer: 1 << 20
  });
  if (res.status !== 0 || res.stdout.length !== 1024) {
    throw new Error(`iconv failed for ${iconvName}: ${res.stderr}`);
  }
  const chars = [];
  for (let i = 0; i < 256; i++) {
    chars.push(String.fromCodePoint(res.stdout.readUInt32LE(i * 4)));
  }
  return chars;
}

function esc(ch) {
  const cp = ch.codePointAt(0);
  if (ch === '\\') return "'\\\\'";
  if (ch === "'") return "'\\''";
  if (cp >= 0x20 && cp < 0x7f) return `'${ch}'`;
  return `'\\u${cp.toString(16).padStart(4, '0')}'`;
}

let out = `// GENERATED FILE - do not edit by hand.
// Run \`npm run gen:ebcdic\` to regenerate (uses system iconv).
// Each entry: 256 unicode characters indexed by EBCDIC byte value.
export const EBCDIC_PAGES: Record<string, string[]> = {\n`;

for (const [name, iconvName] of Object.entries(PAGES)) {
  const map = decodePage(iconvName);
  // Sanity: space must be 0x40 in every EBCDIC page we care about.
  if (map[0x40] !== ' ') throw new Error(`${name}: expected space at 0x40`);
  out += `  ${name}: [\n`;
  for (let i = 0; i < 256; i += 16) {
    out += '    ' + map.slice(i, i + 16).map(esc).join(', ') + ',\n';
  }
  out += '  ],\n';
}
out += '};\n';

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, '..', 'src', 'server', 'tn5250', 'ebcdic-tables.ts');
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, out);
console.log(`Generated ebcdic-tables.ts with ${Object.keys(PAGES).length} code pages.`);
