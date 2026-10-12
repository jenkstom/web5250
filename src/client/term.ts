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
  private focused_ = true;
  /** Blink phase for the reverse-video cursor underline (530 ms cadence). */
  private blinkOn = true;
  private blinkTimer: number | undefined;
  private fontSize: number;
  private cellW = 9.6;
  private cellH = 18;
  /** fit() scale factor applied to the backing store (>1 on big screens). */
  private renderScale = 1;
  private renderQueued = false;

  /** Focus drives cursor styling - repaint when it changes. */
  get focused(): boolean {
    return this.focused_;
  }
  set focused(v: boolean) {
    if (v !== this.focused_) {
      this.focused_ = v;
      this.queueRender();
    }
  }

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

  /** Re-measure cell metrics (e.g. after the webfont loads) and redraw. */
  remeasure(): void {
    this.measure();
    this.queueRender();
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
    // The backing store renders at the fitted scale (times the device pixel
    // ratio): upscaling only the CSS box would blur, so big screens get a
    // proportionally larger canvas instead. Cell metrics stay measured at
    // the base font - the drawing transform carries the scale.
    const dpr = (window.devicePixelRatio || 1) * this.renderScale;
    const w = Math.max(1, Math.round(this.cellW * this.cols * dpr));
    const h = Math.max(1, Math.round(this.cellH * this.rows * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    document.documentElement.style.setProperty(
      '--termw',
      `${Math.round(this.cellW * this.cols * this.renderScale)}px`
    );
  }

  /** The canvas' preferred size at 1:1 CSS pixels (no downscaling). */
  get naturalWidth(): number {
    return this.cellW * this.cols;
  }
  get naturalHeight(): number {
    return this.cellH * this.rows;
  }

  /**
   * Scale the CSS box to fit inside availW×availH, preserving the screen
   * aspect ratio (called by main.ts whenever the available space changes).
   * Scaling up is allowed: the backing store re-rasterizes at the larger
   * size, so a big browser window gets a big, crisp terminal instead of a
   * 1:1 island with margins.
   */
  fit(availW: number, availH: number): void {
    const scale = Math.max(
      0.1,
      Math.min(availW / this.naturalWidth, availH / this.naturalHeight)
    );
    if (scale !== this.renderScale) {
      this.renderScale = scale;
      this.measure();
    }
    this.canvas.style.width = `${Math.round(this.naturalWidth * scale)}px`;
    this.canvas.style.height = `${Math.round(this.naturalHeight * scale)}px`;
    this.queueRender();
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
    // Reverse-video cells (and every non-display cell - those attribute
    // bytes carry the reverse bit too) draw their glyph in black over a
    // coloured background, so the usual block cursor (fg fill + black
    // glyph) would collapse into a black-on-black blank. There the cursor
    // is a blinking underline instead.
    const cursorReverse =
      cursorPos >= 0 && cursorPos < rows * cols && (this.attrs[cursorPos] & 0x01) !== 0;

    // Input-field underlines (classic 5250 look). Non-display (password)
    // fields are underlined too; the cursor cell is skipped - the cursor
    // (block or blinking underline) takes its place.
    const underlineH = Math.max(2, Math.round(cellH / 9));
    const cursorH = Math.max(3, underlineH + 1); // chunkier than the field rule
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
      if (pos === cursorPos && cursorReverse) {
        // Draw the cell as it normally renders...
        if (!isNonDisplay(attr)) {
          if (bg !== PALETTE.black) {
            ctx.fillStyle = bg;
            ctx.fillRect(x, y, cellW, cellH);
          }
          if (ch !== ' ') {
            ctx.fillStyle = fg;
            ctx.fillText(ch, x + cellW / 2, y + cellH / 2 + 1);
          }
        }
        // ...and mark it with the underline cursor: black over the coloured
        // reverse background, the field colour over a (black) hidden cell.
        // Steady when unfocused, blinking while typing focus is on.
        if (this.blinkOn || !this.focused_) {
          ctx.fillStyle = isNonDisplay(attr) ? bg : PALETTE.black;
          ctx.fillRect(x, (r + 1) * cellH - cursorH, cellW, cursorH);
        }
        continue;
      }
      if (pos === cursorPos) {
        // cursor cell: filled block with contrasting glyph
        ctx.fillStyle = this.focused_ ? fg : PALETTE.green;
        ctx.globalAlpha = this.focused_ ? 1 : 0.55;
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

    // Run the blink cycle only while a blinking cursor is actually shown;
    // the queued repaint after the reset clears a stale "off" frame.
    const blink = cursorReverse && this.focused_;
    if (blink && this.blinkTimer === undefined) {
      this.blinkTimer = window.setInterval(() => {
        this.blinkOn = !this.blinkOn;
        this.queueRender();
      }, 530);
    } else if (!blink && this.blinkTimer !== undefined) {
      window.clearInterval(this.blinkTimer);
      this.blinkTimer = undefined;
      if (!this.blinkOn) {
        this.blinkOn = true;
        this.queueRender();
      }
    }
  }
}
