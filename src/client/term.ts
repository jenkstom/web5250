// Terminal state + canvas renderer for the 24x80 / 27x132 5250 grid.
//
// Attribute bytes (0x20-0x3F) map to the classic 5250 palette
// (5494 Functions Reference SC30-3533-04, Table 15-10):
//   0x20-0x27 green (bit 0x02 -> white)   0x28-0x2F red
//   0x30-0x37 turquoise (0x02 -> yellow)  0x38-0x3F pink (0x02 -> blue)
//   bit 0x01 -> reverse video, bit 0x04 -> underscore
// Non-display is only X'27'/X'2F'/X'37'/X'3F' (low three bits all 1).
export interface OiaState {
  lock: string;
  insert: boolean;
  messageWait: boolean;
  errorCode: boolean;
}

/** The four hidden attribute bytes (password fields). */
const isNonDisplay = (attr: number): boolean => (attr & 0x07) === 0x07;

const PALETTE = {
  black: '#000000',
  green: '#4be463',
  white: '#eef3ee',
  red: '#ff5f5f',
  yellow: '#ffe14d',
  turquoise: '#4de8e8',
  blue: '#6f8fff',
  pink: '#ff7bd5'
} as const;

function attrStyle(attr: number): { fg: string; bg: string } {
  const group = (attr >> 3) & 0x03;
  const alt = (attr & 0x02) !== 0;
  const reverse = (attr & 0x01) !== 0;
  let fg: string;
  switch (group) {
    case 0: fg = alt ? PALETTE.white : PALETTE.green; break;
    case 1: fg = PALETTE.red; break;
    case 2: fg = alt ? PALETTE.yellow : PALETTE.turquoise; break;
    default: fg = alt ? PALETTE.blue : PALETTE.pink; break;
  }
  return reverse ? { fg: PALETTE.black, bg: fg } : { fg, bg: PALETTE.black };
}

export class Terminal {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private chars: string[] = [];
  private attrs: number[] = [];
  /** Input fields as [dataStartPos, dataCellCount, attr] - underlined. */
  private fields: number[][] = [];
  rows = 24;
  cols = 80;
  cursor: [number, number] = [1, 1]; // 1-based
  focused = true;
  private fontSize: number;
  private cellW = 9.6;
  private cellH = 18;
  private renderQueued = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.fontSize = Math.max(13, Math.min(20, Math.floor(window.innerHeight / 32)));
    this.resizeGrid(24, 80);
  }

  resizeGrid(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    const n = rows * cols;
    this.chars = new Array(n).fill(' ');
    this.attrs = new Array(n).fill(0x20);
    this.fields = [];
    this.measure();
    this.render();
  }

  setFields(fields: number[][]): void {
    this.fields = fields;
    this.queueRender();
  }

  private measure(): void {
    this.ctx.font = `${this.fontSize}px "IBM Plex Mono", monospace`;
    this.ctx.textAlign = 'center';
    const m = this.ctx.measureText('M');
    this.cellW = Math.ceil(m.width);
    this.cellH = Math.round(this.fontSize * 1.25);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.cellW * this.cols * dpr);
    this.canvas.height = Math.round(this.cellH * this.rows * dpr);
    this.canvas.style.width = `${this.cellW * this.cols}px`;
    this.canvas.style.height = `${this.cellH * this.rows}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    document.documentElement.style.setProperty('--termw', `${this.cellW * this.cols}px`);
  }

  get cssWidth(): number {
    return this.cellW * this.cols;
  }

  applyCells(cells: (number | string)[][]): void {
    const n = this.rows * this.cols;
    for (const cell of cells) {
      const pos = cell[0] as number;
      if (pos < 0 || pos >= n) continue;
      this.attrs[pos] = cell[1] as number;
      this.chars[pos] = String(cell[2] ?? ' ');
    }
    this.queueRender();
  }

  setCursor(r: number, c: number): void {
    this.cursor = [r, c];
    this.queueRender();
  }

  /** Convert a click to a 1-based row/col (or null when outside cells). */
  hitTest(x: number, y: number): [number, number] | null {
    const rect = this.canvas.getBoundingClientRect();
    const scale = (this.cellW * this.cols) / rect.width;
    const px = x * scale;
    const py = y * scale;
    const col = Math.floor(px / this.cellW) + 1;
    const row = Math.floor(py / this.cellH) + 1;
    if (row < 1 || row > this.rows || col < 1 || col > this.cols) return null;
    return [row, col];
  }

  /** Clicks place the cursor at the clicked position (server validates). */
  clickToMessage(x: number, y: number): { r: number; c: number } | null {
    const hit = this.hitTest(x, y);
    return hit ? { r: hit[0], c: hit[1] } : null;
  }

  text(): string {
    const out: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      let line = '';
      for (let c = 0; c < this.cols; c++) line += this.chars[r * this.cols + c];
      out.push(line.replace(/\s+$/, ''));
    }
    return out.join('\n');
  }

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    const { ctx, cellW, cellH, fontSize, rows, cols } = this;
    ctx.fillStyle = PALETTE.black;
    ctx.fillRect(0, 0, cellW * cols, cellH * rows);
    ctx.font = `${fontSize}px "IBM Plex Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const [curR, curC] = this.cursor;
    const cursorPos = (curR - 1) * cols + (curC - 1);

    // Input-field underlines (classic 5250 look). Non-display (password)
    // fields are underlined too; the cursor cell is skipped - the cursor
    // block takes its place.
    const underlineH = Math.max(2, Math.round(cellH / 9));
    for (const [start, len, attr] of this.fields) {
      const fg = attrStyle(attr).fg;
      for (let i = 0; i < len; i++) {
        const pos = start + i;
        if (pos >= rows * cols || pos === cursorPos) continue;
        const r = Math.floor(pos / cols);
        const c = pos % cols;
        ctx.fillStyle = fg;
        ctx.fillRect(c * cellW, (r + 1) * cellH - underlineH, cellW, underlineH);
      }
    }

    for (let pos = 0; pos < rows * cols; pos++) {
      const attr = this.attrs[pos];
      const r = Math.floor(pos / cols);
      const c = pos % cols;
      const x = c * cellW;
      const y = r * cellH;
      const { fg, bg } = attrStyle(attr);
      const ch = this.chars[pos] ?? ' ';

      // The cursor is drawn regardless of the non-display attribute: it
      // reveals only the position, never the hidden content.
      if (pos === cursorPos) {
        // cursor cell: filled block with contrasting glyph
        ctx.fillStyle = this.focused ? fg : PALETTE.green;
        ctx.globalAlpha = this.focused ? 1 : 0.55;
        ctx.fillRect(x, y, cellW, cellH);
        ctx.globalAlpha = 1;
        ctx.fillStyle = PALETTE.black;
        ctx.fillText(ch, x + cellW / 2, y + cellH / 2 + 1);
        continue;
      }
      if (isNonDisplay(attr)) continue; // hidden field: leave blank
      if (bg !== PALETTE.black) {
        ctx.fillStyle = bg;
        ctx.fillRect(x, y, cellW, cellH);
      }
      // Underscore attribute (bit 0x04): rule under the cell, in the
      // character colour. Visible attributes only — hidden ones are skipped
      // above, so the bit means exactly "underscore" here.
      if ((attr & 0x04) === 0x04) {
        ctx.fillStyle = bg !== PALETTE.black ? PALETTE.black : fg;
        ctx.fillRect(x, (r + 1) * cellH - underlineH, cellW, underlineH);
      }
      if (ch !== ' ') {
        ctx.fillStyle = fg;
        ctx.fillText(ch, x + cellW / 2, y + cellH / 2 + 1);
      }
    }
  }
}
