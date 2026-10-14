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

/**
 * Box-drawing characters (GUI window borders, DDS line drawing) are drawn
 * as canvas lines spanning the full cell so adjacent cells join seamlessly
 * - monospace fonts render these glyphs with gaps at every cell boundary,
 * which shreds a window's vertical borders into dashes (xterm.js does the
 * same custom-glyph trick). Bit masks: U+2500.. = ─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼.
 */
const BOX_LINES: Record<string, { up?: boolean; down?: boolean; left?: boolean; right?: boolean }> = {
  '\u2500': { left: true, right: true },
  '\u2502': { up: true, down: true },
  '\u250c': { right: true, down: true },
  '\u2510': { left: true, down: true },
  '\u2514': { right: true, up: true },
  '\u2518': { left: true, up: true },
  '\u251c': { right: true, up: true, down: true },
  '\u2524': { left: true, up: true, down: true },
  '\u252c': { left: true, right: true, down: true },
  '\u2534': { left: true, right: true, up: true },
  '\u253c': { left: true, right: true, up: true, down: true }
};

/**
 * A marked screen region: anchor and focus cell (1-based, in the order the
 * user marked them - normalize with selRange() before use). `rect` selects
 * a column-rectangle (Alt+drag) instead of the linear flow selection.
 */
interface Selection {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  rect: boolean;
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
  private selection: Selection | null = null;
  private focused_ = true;
  /** Blink phase for the reverse-video cursor underline (530 ms cadence). */
  private blinkOn = true;
  private blinkTimer: number | undefined;
  private fontSize: number;
  private cellW = 9.6;
  private cellH = 18;
  /** fit() scale factor applied to the backing store (>1 on big screens). */
  private renderScale = 1;
  /** devicePixelRatio × renderScale, from the last measure(). */
  private drawScale = 1;
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
    this.selection = null; // cell coordinates no longer mean anything
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
    this.drawScale = dpr;
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

  /** Like hitTest, but for drags: outside the grid clamps to the edge cell. */
  cellClamped(x: number, y: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const scale = (this.cellW * this.cols) / rect.width;
    const col = Math.floor((x * scale) / this.cellW) + 1;
    const row = Math.floor((y * scale) / this.cellH) + 1;
    return [Math.max(1, Math.min(this.rows, row)), Math.max(1, Math.min(this.cols, col))];
  }

  /** Clicks place the cursor at the clicked position (server validates). */
  clickToMessage(x: number, y: number): { r: number; c: number } | null {
    const hit = this.hitTest(x, y);
    return hit ? { r: hit[0], c: hit[1] } : null;
  }

  /**
   * The visible text of the whole screen grid. Non-display (password) cells
   * read as blanks - their stored characters are what the user typed, and a
   * screen dump must never carry them into the clipboard.
   */
  text(): string {
    const out: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      let line = '';
      for (let c = 0; c < this.cols; c++) {
        const pos = r * this.cols + c;
        line += isNonDisplay(this.attrs[pos]) ? ' ' : this.chars[pos];
      }
      out.push(line.replace(/\s+$/, ''));
    }
    return out.join('\n');
  }

  // ---------------------------------------------------------------- selection
  get hasSelection(): boolean {
    return this.selection !== null;
  }

  /** Start (or restart) a mark at the given cell; nothing is highlighted yet. */
  beginSelection(row: number, col: number, rect: boolean): void {
    this.selection = { r1: row, c1: col, r2: row, c2: col, rect };
  }

  /** Drag the mark to another cell; cells outside the grid are clamped in. */
  extendSelection(row: number, col: number): void {
    if (!this.selection) return;
    this.selection.r2 = Math.max(1, Math.min(this.rows, row));
    this.selection.c2 = Math.max(1, Math.min(this.cols, col));
    this.queueRender();
  }

  clearSelection(): void {
    if (!this.selection) return;
    this.selection = null;
    this.queueRender();
  }

  /** Double-click helper: mark the run of non-space characters around the cell. */
  selectWord(row: number, col: number): void {
    row = Math.max(1, Math.min(this.rows, row));
    col = Math.max(1, Math.min(this.cols, col));
    const at = (c: number): string => this.chars[(row - 1) * this.cols + c - 1] ?? ' ';
    const inWord = (c: number): boolean => at(c) !== ' ' && !isNonDisplay(this.attrs[(row - 1) * this.cols + c - 1]);
    let start = col;
    let end = col;
    if (inWord(col)) {
      while (start > 1 && inWord(start - 1)) start--;
      while (end < this.cols && inWord(end + 1)) end++;
    } else {
      // blank (or hidden) cell: mark the run of blanks it sits in
      while (end < this.cols && at(end + 1) === ' ') end++;
    }
    this.selection = { r1: row, c1: start, r2: row, c2: end, rect: false };
    this.queueRender();
  }

  /** Anchor..focus in reading order, per the current shape. */
  private selRange(): { r1: number; c1: number; r2: number; c2: number; rect: boolean } {
    const s = this.selection!;
    const r1 = Math.min(s.r1, s.r2);
    const r2 = Math.max(s.r1, s.r2);
    if (s.rect) {
      return { r1, r2, c1: Math.min(s.c1, s.c2), c2: Math.max(s.c1, s.c2), rect: true };
    }
    // Linear: the anchor's position orders the range.
    const p1 = (s.r1 - 1) * this.cols + (s.c1 - 1);
    const p2 = (s.r2 - 1) * this.cols + (s.c2 - 1);
    return p1 <= p2
      ? { r1: s.r1, c1: s.c1, r2: s.r2, c2: s.c2, rect: false }
      : { r1: s.r2, c1: s.c2, r2: s.r1, c2: s.c1, rect: false };
  }

  /**
   * The characters under the selection, rows joined with newlines like a
   * terminal copy: the first row runs to end-of-line, the last starts at the
   * column, each line trimmed of trailing blanks. Hidden (non-display) cells
   * come out as blanks, exactly as they render.
   */
  selectionText(): string {
    if (!this.selection) return '';
    const { r1, c1, r2, c2, rect } = this.selRange();
    const lines: string[] = [];
    for (let r = r1; r <= r2; r++) {
      const c0 = rect || r === r1 ? c1 : 1;
      const cEnd = rect || r === r2 ? c2 : this.cols;
      let line = '';
      for (let c = c0; c <= cEnd; c++) {
        const pos = (r - 1) * this.cols + c - 1;
        line += isNonDisplay(this.attrs[pos]) ? ' ' : this.chars[pos];
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines.join('\n');
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

    // Backgrounds are filled one rect per run of same-attribute cells, with
    // every edge snapped to a whole device pixel. A rect per cell at a
    // fractional fit() scale leaves an antialiased hairline at each cell
    // boundary, so a solid reverse-video title bar reads as sliced into
    // blocks (a real 5250 / tn5250j renders it seamless). Snapped edges are
    // shared exactly between neighbouring runs, so same-colour areas join.
    const snap = (v: number) => Math.round(v * this.drawScale) / this.drawScale;
    const fillRun = (
      r: number,
      c0: number,
      c1: number,
      top: number,
      bottom: number,
      color: string
    ): void => {
      const x0 = snap(c0 * cellW);
      const y0 = snap(r * cellH + top);
      ctx.fillStyle = color;
      ctx.fillRect(x0, y0, snap((c1 + 1) * cellW) - x0, snap(r * cellH + bottom) - y0);
    };

    // Input-field underlines (classic 5250 look). Non-display (password)
    // fields are underlined too; the cursor cell is skipped - the cursor
    // (block or blinking underline) takes its place.
    const underlineH = Math.max(2, Math.round(cellH / 9));
    const cursorH = Math.max(3, underlineH + 1); // chunkier than the field rule
    for (const [start, len, attr] of this.fields) {
      const fg = attrStyle(attr).fg;
      const end = Math.min(len, rows * cols - start); // fields stay on-screen
      let i = 0;
      while (i < end) {
        if (start + i === cursorPos) {
          i++;
          continue;
        }
        const r = Math.floor((start + i) / cols); // runs never cross a row
        let j = i;
        while (j < end && start + j !== cursorPos && Math.floor((start + j) / cols) === r) j++;
        fillRun(r, start + i - r * cols, start + j - 1 - r * cols, cellH - underlineH, cellH, fg);
        i = j;
      }
    }

    // Background runs. The underscore attribute (bit 0x04) draws its rule
    // under the whole run, in the character colour (black over a coloured
    // background). Hidden non-display cells and the cursor cell break runs:
    // both are drawn as plain blanks here, the cursor on top further down.
    let runR = -1;
    let runC0 = 0;
    let runC1 = -1;
    let runAttr = 0;
    const flushRun = (): void => {
      if (runR < 0) return;
      const { fg, bg } = attrStyle(runAttr);
      if (bg !== PALETTE.black) fillRun(runR, runC0, runC1, 0, cellH, bg);
      if ((runAttr & 0x04) === 0x04) {
        fillRun(
          runR,
          runC0,
          runC1,
          cellH - underlineH,
          cellH,
          bg !== PALETTE.black ? PALETTE.black : fg
        );
      }
      runR = -1;
    };
    for (let pos = 0; pos < rows * cols; pos++) {
      const attr = this.attrs[pos];
      if (pos === cursorPos || isNonDisplay(attr)) {
        flushRun();
        continue;
      }
      const r = Math.floor(pos / cols);
      const c = pos % cols;
      if (r === runR && attr === runAttr) runC1 = c;
      else {
        flushRun();
        runR = r;
        runC0 = c;
        runC1 = c;
        runAttr = attr;
      }
    }
    flushRun();

    // Glyphs on top of the runs.
    for (let pos = 0; pos < rows * cols; pos++) {
      if (pos === cursorPos) continue;
      const attr = this.attrs[pos];
      if (isNonDisplay(attr)) continue; // hidden field: leave blank
      const ch = this.chars[pos] ?? ' ';
      if (ch === ' ') continue;
      const fg = attrStyle(attr).fg;
      const lines = BOX_LINES[ch];
      if (lines) {
        // Full-cell line drawing: centre strokes snap to the device-pixel
        // grid (+ half a device pixel) so hairlines stay crisp at any
        // fit() scale, and strokes reach the cell edges so neighbouring
        // border cells join into one continuous rule.
        const r = Math.floor(pos / cols);
        const c = pos % cols;
        const x0 = c * cellW;
        const y0 = r * cellH;
        const px = 0.5 / this.drawScale; // half a device pixel
        const midX = Math.round((x0 + cellW / 2) * this.drawScale) / this.drawScale + px;
        const midY = Math.round((y0 + cellH / 2) * this.drawScale) / this.drawScale + px;
        ctx.strokeStyle = fg;
        ctx.lineWidth = Math.max(1 / this.drawScale, cellH / 16);
        ctx.beginPath();
        if (lines.left) { ctx.moveTo(x0, midY); ctx.lineTo(midX, midY); }
        if (lines.right) { ctx.moveTo(midX, midY); ctx.lineTo(x0 + cellW, midY); }
        if (lines.up) { ctx.moveTo(midX, y0); ctx.lineTo(midX, midY); }
        if (lines.down) { ctx.moveTo(midX, midY); ctx.lineTo(midX, y0 + cellH); }
        ctx.stroke();
        continue;
      }
      ctx.fillStyle = fg;
      ctx.fillText(
        ch,
        (pos % cols) * cellW + cellW / 2,
        Math.floor(pos / cols) * cellH + cellH / 2 + 1
      );
    }

    // Selection highlight: a translucent light wash over the marked cells,
    // drawn on top of the glyphs so they stay readable. A linear selection
    // flows like text (first row runs to the end of the line, last one ends
    // at the mark); a rectangular one marks the same columns on every row.
    if (this.selection) {
      const { r1, c1, r2, c2, rect } = this.selRange();
      const wash = 'rgba(238, 243, 238, 0.35)';
      for (let r = r1; r <= r2; r++) {
        const c0 = rect || r === r1 ? c1 : 1;
        const cEnd = rect || r === r2 ? c2 : cols;
        fillRun(r - 1, c0 - 1, cEnd - 1, 0, cellH, wash);
      }
    }

    if (cursorPos >= 0 && cursorPos < rows * cols) {
      const attr = this.attrs[cursorPos];
      const { fg, bg } = attrStyle(attr);
      const r = Math.floor(cursorPos / cols);
      const c = cursorPos % cols;
      const ch = this.chars[cursorPos] ?? ' ';
      if (cursorReverse) {
        // Draw the cell as it normally renders...
        if (!isNonDisplay(attr)) {
          if (bg !== PALETTE.black) fillRun(r, c, c, 0, cellH, bg);
          if (ch !== ' ') {
            ctx.fillStyle = fg;
            ctx.fillText(ch, c * cellW + cellW / 2, r * cellH + cellH / 2 + 1);
          }
        }
        // ...and mark it with the underline cursor: black over the coloured
        // reverse background, the field colour over a (black) hidden cell.
        // Steady when unfocused, blinking while typing focus is on.
        if (this.blinkOn || !this.focused_) {
          fillRun(r, c, c, cellH - cursorH, cellH, isNonDisplay(attr) ? bg : PALETTE.black);
        }
      } else {
        // cursor cell: filled block with contrasting glyph
        ctx.globalAlpha = this.focused_ ? 1 : 0.55;
        fillRun(r, c, c, 0, cellH, this.focused_ ? fg : PALETTE.green);
        ctx.globalAlpha = 1;
        ctx.fillStyle = PALETTE.black;
        ctx.fillText(ch, c * cellW + cellW / 2, r * cellH + cellH / 2 + 1);
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
