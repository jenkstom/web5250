// Bidirectional EBCDIC <-> Unicode translation for a single code page.
import { EBCDIC_PAGES } from './ebcdic-tables.ts';

export class Ebcdic {
  private readonly toUni: string[];
  private readonly toEbcdicMap: Map<string, number>;

  constructor(pageName: string) {
    const page = EBCDIC_PAGES[pageName];
    if (!page) {
      throw new Error(
        `unsupported code page "${pageName}" (available: ${Object.keys(EBCDIC_PAGES).join(', ')})`
      );
    }
    this.toUni = page;
    this.toEbcdicMap = new Map();
    for (let b = 0; b < 256; b++) {
      const ch = page[b];
      // First byte wins so control-ish mappings never shadow real glyphs.
      if (!this.toEbcdicMap.has(ch)) this.toEbcdicMap.set(ch, b);
    }
  }

  static availablePages(): string[] {
    return Object.keys(EBCDIC_PAGES);
  }

  /** EBCDIC byte -> unicode char. Text bytes are 0x40..0xFE. */
  ebcdic2uni(byte: number): string {
    if (byte >= 0x40 && byte < 0xff) return this.toUni[byte];
    // Control-range bytes are kept as raw code points (mirrors tn5250j),
    // so things like the DUP character (0x1C) survive round trips.
    return String.fromCharCode(byte);
  }

  /** Unicode char -> EBCDIC byte; falls back to EBCDIC space (0x40). */
  uni2ebcdic(ch: string): number {
    const mapped = this.toEbcdicMap.get(ch);
    if (mapped !== undefined && mapped >= 0x40 && mapped < 0xff) return mapped;
    const cp = ch.codePointAt(0) ?? 0x40;
    if (cp < 0x20) return cp; // control chars pass through raw
    return 0x40; // unsupported glyph -> space
  }
}
