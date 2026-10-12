// 5250 screen buffer: cell planes, field table, OIA status and local
// (client-side) keyboard behaviour, mirroring the semantics tn5250j uses
// against real IBM i hosts.
import * as C from './constants.ts';
import type { Ebcdic } from './ebcdic.ts';

export type LockState = 'none' | 'system' | 'ii' | 'prog' | 'comm';

export interface Field {
  attr: number;
  startPos: number; // cell holding the attribute byte
  dataStart: number;
  length: number; // DATA cells only (the attribute cell is not counted)
  endPos: number; // last data cell
  ffw0: number;
  ffw1: number;
  fcw1: number;
  fcw2: number;
  mdt: boolean;
  fieldId: number;
  isBypass: boolean;
  shift: number; // FFW1 & 0x07
  autoEnter: boolean;
  toUpper: boolean;
  numeric: boolean; // shift 3
  signedNumeric: boolean; // shift 7
}

export interface OiaState {
  lock: LockState;
  insert: boolean;
  messageWait: boolean;
  errorCode: boolean;
}

interface ScreenSnapshot {
  rows: number;
  cols: number;
  chars: string[];
  attrs: number[];
  attrPlace: boolean[];
  fields: Field[];
  cursorPos: number;
  homePos: number;
  lastAttr: number;
}

let fieldIdSeq = 1;

export class Screen5250 {
  rows = 24;
  cols = 80;
  chars: string[] = [];
  attrs: number[] = [];
  attrPlace: boolean[] = [];
  fields: Field[] = [];

  /** Stream write position (where WTD orders place data). */
  writePos = 0;
  lastAttr = 0x20;

  /** Visible cursor. */
  cursorPos = 0;
  homePos = 0;
  pendingInsert = false;

  insertMode = false;
  messageWait = false;
  lock: LockState = 'none';
  errorCodeActive = false;
  errorLineRow = 24; // 1-based row the host uses for error text
  private savedErrorRow: { chars: string[]; attrs: number[] } | null = null;

  waitingForInput = false;
  readType: number = C.CMD_READ_MDT_FIELDS;
  masterMDT = false;
  /** PF1..PF24: does pressing this key transmit field data? (SOH order) */
  dataIncluded = new Array<boolean>(24).fill(true);

  dirty = new Set<number>();
  structureDirty = true;

  private snapshots: ScreenSnapshot[] = [];
  private readonly ebcdic: Ebcdic;

  constructor(ebcdic: Ebcdic) {
    this.ebcdic = ebcdic;
    this.setSize(24, 80);
  }

  // ------------------------------------------------------------------ basics
  get size(): number {
    return this.rows * this.cols;
  }

  rowOf(pos: number): number {
    return Math.floor(pos / this.cols) + 1;
  } // 1-based
  colOf(pos: number): number {
    return (pos % this.cols) + 1;
  } // 1-based
  posOf(row1: number, col1: number): number {
    return (row1 - 1) * this.cols + (col1 - 1);
  }

  markDirty(pos: number): void {
    this.dirty.add(pos);
  }

  setSize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    this.clearAll();
  }

  /** CLEAR UNIT / CLEAR UNIT ALTERNATE: wipe cells, fields and OIA state. */
  clearAll(): void {
    const n = this.size;
    this.chars = new Array(n).fill(' ');
    this.attrs = new Array(n).fill(0x20);
    this.attrPlace = new Array(n).fill(false);
    this.fields = [];
    this.writePos = 0;
    this.cursorPos = 0;
    this.homePos = 0;
    this.pendingInsert = false;
    this.lastAttr = 0x20;
    this.masterMDT = false;
    this.waitingForInput = false;
    this.errorCodeActive = false;
    this.savedErrorRow = null;
    this.structureDirty = true;
  }

  /** CLEAR FORMAT TABLE: drop fields but keep text. */
  clearFormatTable(): void {
    this.fields = [];
    this.structureDirty = true;
  }

  // ------------------------------------------------------- stream write ops
  setWritePos(row1: number, col1: number): boolean {
    if (row1 < 1 || row1 > this.rows || col1 < 1 || col1 > this.cols) return false;
    this.writePos = this.posOf(row1, col1);
    return true;
  }

  advanceWrite(n = 1): void {
    this.writePos = (this.writePos + n) % this.size;
  }

  /** Plain character write at the current write position. Characters never
   *  touch the attribute plane: an SF field's attribute covers exactly its
   *  own cells (set in addField) and bare attribute bytes propagate on
   *  their own - a label written right after a non-display field must stay
   *  visible (tn5250j keeps char and attribute planes separate). */
  writeChar(ch: string): void {
    const pos = this.writePos;
    if (!this.attrPlace[pos]) {
      this.chars[pos] = ch;
      this.markDirty(pos);
    }
    this.advanceWrite();
  }

  /**
   * Attribute byte write (0x20-0x3F arrives as data): occupies one cell,
   * sets the running attribute and propagates over following cells until
   * the next attribute cell (mirrors tn5250j setAttr).
   */
  writeAttribute(attr: number): void {
    this.lastAttr = attr;
    const start = this.writePos;
    this.attrPlace[start] = true;
    this.chars[start] = ' ';
    this.attrs[start] = attr;
    this.markDirty(start);
    this.advanceWrite();
    let pos = this.writePos;
    let guard = 0;
    while (pos < this.size && !this.attrPlace[pos] && this.attrs[pos] !== attr && guard++ < this.size) {
      this.attrs[pos] = attr;
      this.markDirty(pos);
      pos++;
    }
    this.writePos = start + 1 < this.size ? start + 1 : 0;
  }

  /** EBCDIC text byte from the host stream. */
  writeEbcdicByte(byte: number): void {
    if (byte === 0) {
      this.writeChar(' ');
    } else if (byte >= 0x40 && byte < 0xff) {
      this.writeChar(this.ebcdic.ebcdic2uni(byte));
    } else {
      // Control-range bytes are stored raw (dup char 0x1C etc).
      this.writeChar(String.fromCharCode(byte));
    }
  }

  /**
   * START FIELD order. `length` counts DATA cells only (5494 Functions
   * Reference; tn5250j/lib5250 agree) - the attribute byte occupies its own
   * cell at startPos ahead of them.
   */
  addField(attr: number, length: number, ffw0: number, ffw1: number, fcw1: number, fcw2: number): void {
    const startPos = this.writePos;
    const endPos = Math.min(startPos + length, this.size - 1);
    // A repeated SF at the same position redefines the existing field
    // (tn5250j existsAtPos) instead of stacking a stale duplicate.
    const existing = this.fields.find((f) => f.startPos === startPos);
    if (existing) {
      existing.attr = attr;
      existing.length = length;
      existing.endPos = endPos;
      existing.ffw0 = ffw0;
      existing.ffw1 = ffw1;
      existing.fcw1 = fcw1;
      existing.fcw2 = fcw2;
      existing.mdt = (ffw0 & C.FFW1_MDT) === C.FFW1_MDT;
      existing.isBypass = (ffw0 & C.FFW1_BYPASS) === C.FFW1_BYPASS;
      existing.shift = ffw0 & C.FFW1_SHIFT_MASK;
      existing.autoEnter = (ffw1 & C.FFW2_AUTO_ENTER) === C.FFW2_AUTO_ENTER;
      existing.toUpper = (ffw1 & C.FFW2_TO_UPPER) === C.FFW2_TO_UPPER;
      existing.numeric = (ffw0 & C.FFW1_SHIFT_MASK) === 3;
      existing.signedNumeric = (ffw0 & C.FFW1_SHIFT_MASK) === 7;
    }
    const field: Field =
      existing ??
      {
        attr,
        startPos,
        dataStart: startPos + 1,
        length,
        endPos,
        ffw0,
        ffw1,
        fcw1,
        fcw2,
        mdt: (ffw0 & C.FFW1_MDT) === C.FFW1_MDT,
        fieldId: fieldIdSeq++,
        isBypass: (ffw0 & C.FFW1_BYPASS) === C.FFW1_BYPASS,
        shift: ffw0 & C.FFW1_SHIFT_MASK,
        autoEnter: (ffw1 & C.FFW2_AUTO_ENTER) === C.FFW2_AUTO_ENTER,
        toUpper: (ffw1 & C.FFW2_TO_UPPER) === C.FFW2_TO_UPPER,
        numeric: (ffw0 & C.FFW1_SHIFT_MASK) === 3,
        signedNumeric: (ffw0 & C.FFW1_SHIFT_MASK) === 7
      };
    if (!existing) this.fields.push(field);
    if (field.mdt) this.masterMDT = true;

    // The SF attribute covers EXACTLY the attribute cell plus the field's
    // data cells; the cell after the field reverts to the default
    // attribute (tn5250j addField walks the field then setEndingAttr).
    // Propagating the attribute further would hide everything after a
    // non-display (password) field.
    const start = this.writePos;
    this.lastAttr = attr;
    this.attrPlace[start] = true;
    this.chars[start] = ' ';
    this.attrs[start] = attr;
    this.markDirty(start);
    for (let p = field.dataStart; p <= field.endPos && p < this.size; p++) {
      if (this.chars[p] === '\u0000') this.chars[p] = ' ';
      this.attrs[p] = attr;
      this.markDirty(p);
    }
    const after = field.endPos + 1;
    if (after < this.size && !this.attrPlace[after] && this.attrs[after] !== 0x20) {
      this.attrs[after] = 0x20; // initAttr default
      this.markDirty(after);
    }
    this.writePos = field.dataStart;
    this.structureDirty = true;
  }

  /** ROLL command (0x23): scroll a region of the screen. */
  roll(direction: number, topLine1: number, bottomLine1: number): void {
    const updown = direction & 0x80;
    const lines = direction & 0x7f;
    if (lines === 0) return;
    const { cols } = this;
    const start = this.posOf(topLine1, 1);
    const end = Math.min(this.posOf(bottomLine1, cols), this.size - 1);
    const shift = lines * cols;
    if (updown === 0) {
      for (let p = start; p <= end; p++) {
        const src = p + shift;
        if (src > end) {
          this.chars[p] = ' ';
        } else {
          this.chars[p] = this.chars[src];
          this.attrs[p] = this.attrs[src];
          this.attrPlace[p] = this.attrPlace[src];
        }
        this.markDirty(p);
      }
    } else {
      for (let p = end; p >= start; p--) {
        const src = p - shift;
        if (src < start) {
          this.chars[p] = ' ';
        } else {
          this.chars[p] = this.chars[src];
          this.attrs[p] = this.attrs[src];
          this.attrPlace[p] = this.attrPlace[src];
        }
        this.markDirty(p);
      }
    }
  }

  // ------------------------------------------------------------- save/restore
  saveScreen(): void {
    this.snapshots.push({
      rows: this.rows,
      cols: this.cols,
      chars: [...this.chars],
      attrs: [...this.attrs],
      attrPlace: [...this.attrPlace],
      fields: this.fields.map((f) => ({ ...f })),
      cursorPos: this.cursorPos,
      homePos: this.homePos,
      lastAttr: this.lastAttr
    });
    if (this.snapshots.length > 4) this.snapshots.shift();
  }

  restoreScreen(): void {
    const snap = this.snapshots.pop();
    if (!snap) return;
    this.rows = snap.rows;
    this.cols = snap.cols;
    this.chars = snap.chars;
    this.attrs = snap.attrs;
    this.attrPlace = snap.attrPlace;
    this.fields = snap.fields;
    this.cursorPos = snap.cursorPos;
    this.homePos = snap.homePos;
    this.lastAttr = snap.lastAttr;
    this.structureDirty = true;
  }

  // ------------------------------------------------------------------ fields
  fieldAt(pos: number): Field | null {
    for (const f of this.fields) {
      if (pos >= f.dataStart && pos <= f.endPos) return f;
    }
    return null;
  }

  firstInputField(): Field | null {
    return this.fields.find((f) => !f.isBypass) ?? null;
  }

  /** Move cursor to the next (dir=1) / previous (dir=-1) non-bypass field. */
  gotoField(dir: 1 | -1): boolean {
    const list = this.fields.filter((f) => !f.isBypass);
    if (list.length === 0) return false;
    // order by screen position starting from current cursor
    const sorted = [...list].sort((a, b) => a.startPos - b.startPos);
    let next: Field | undefined;
    if (dir === 1) {
      next = sorted.find((f) => f.startPos > this.cursorPos) ?? sorted[0];
    } else {
      // Backtab must skip the field the cursor is in: compare against the
      // field END (the current field's own start is always before the
      // cursor, which would re-home it onto itself). No earlier field means
      // wrap-around to the last one.
      const rev = [...sorted].reverse();
      next = rev.find((f) => f.endPos < this.cursorPos) ?? rev[0];
    }
    if (!next) return false;
    this.cursorPos = next.dataStart;
    return true;
  }

  fieldText(f: Field): string {
    let out = '';
    for (let p = f.dataStart; p <= f.endPos && p < this.size; p++) {
      out += this.chars[p] === ' ' || this.chars[p] === '\u0000' ? ' ' : this.chars[p];
    }
    return out;
  }

  private setFieldMDT(f: Field): void {
    f.mdt = true;
    this.masterMDT = true;
  }

  // ------------------------------------------------------------------ OIA
  oia(): OiaState {
    return {
      lock: this.lock,
      insert: this.insertMode,
      messageWait: this.messageWait,
      errorCode: this.errorCodeActive
    };
  }

  lockSystem(): void {
    this.lock = 'system';
  }

  unlock(): void {
    this.lock = 'none';
    this.errorCodeActive = false;
    if (this.savedErrorRow) {
      this.restoreErrorRow();
    }
  }

  /** Host WRITE ERROR CODE (0x21/0x22): keyboard inhibited until Reset. */
  beginErrorCode(fromCol1: number): void {
    if (!this.savedErrorRow) {
      const s = this.posOf(this.errorLineRow, 1);
      this.savedErrorRow = {
        chars: this.chars.slice(s, s + this.cols),
        attrs: this.attrs.slice(s, s + this.cols)
      };
    }
    this.errorCodeActive = true;
    this.lock = 'ii';
    this.writePos = this.posOf(this.errorLineRow, fromCol1);
    this.structureDirty = true;
  }

  private restoreErrorRow(): void {
    const saved = this.savedErrorRow;
    if (!saved) return;
    const s = this.posOf(this.errorLineRow, 1);
    for (let i = 0; i < this.cols; i++) {
      this.chars[s + i] = saved.chars[i];
      this.attrs[s + i] = saved.attrs[i];
      this.markDirty(s + i);
    }
    this.savedErrorRow = null;
  }

  /** RESET key: clear keyboard errors / inhibit. */
  reset(): void {
    if (this.errorCodeActive || this.lock === 'ii') {
      this.errorCodeActive = false;
      this.lock = 'none';
      this.restoreErrorRow();
    } else if (this.lock === 'system') {
      // X SYSTEM cannot be reset locally - waiting on host.
    } else {
      this.lock = 'none';
    }
  }

  // -------------------------------------------------------- cursor placement
  /** Attribute cells are never cursor-addressable; step off them. */
  normalizeCursor(): void {
    if (this.attrPlace[this.cursorPos]) {
      const next = this.cursorPos + 1;
      if (next < this.size) this.cursorPos = next;
    }
  }

  /** After WTD: place cursor per CC1 bits + IC/MC orders (5250 spec 14.6). */
  placeCursorAfterWrite(cc1NoMove: boolean): void {
    if (!cc1NoMove && this.pendingInsert && this.homePos >= 0) {
      this.cursorPos = this.homePos;
    } else if (!cc1NoMove) {
      this.cursorPos = this.firstInputField()?.dataStart ?? 0;
      this.homePos = this.cursorPos;
    }
    // cc1NoMove: keep cursor wherever the last IC/MC order put it.
    this.normalizeCursor();
  }

  /**
   * Read invite arrived: home the cursor per spec. The first input field is
   * selected ABSOLUTELY (not relative to the cursor): when the cursor
   * already sits in the first field - e.g. placed there by CC1 cursor
   * homing - a cursor-relative "next field" search would wrongly advance to
   * the second field (live QDSIGNONs send no IC order and start the cursor
   * in the PASSWORD field this way).
   */
  goHome(): void {
    if (this.pendingInsert && this.homePos > 0) {
      this.cursorPos = this.homePos;
    } else {
      const first = this.fields.find((f) => !f.isBypass);
      if (first) {
        this.cursorPos = first.dataStart;
        this.homePos = this.cursorPos;
      } else {
        this.cursorPos = 0;
        this.homePos = 0;
      }
    }
    this.normalizeCursor();
  }

  // ------------------------------------------------------------- mouse table
  /**
   * Host-programmed mouse events (5494 FR Programmable Mouse Buttons):
   * which AID to return for a mouse event on the current screen, and
   * whether the text cursor moves to the click first. Replaced wholesale
   * whenever the host resends the structured field (it does per format).
   */
  mouseButtons: { event: number; aid: number; moveCursor: boolean; queued: boolean }[] = [];

  setMouseButtons(table: { event: number; aid: number; moveCursor: boolean; queued: boolean }[]): void {
    this.mouseButtons = table;
    this.structureDirty = true; // browsers decide right-click vs local menu on it
  }

  mouseButtonFor(event: number): { aid: number; moveCursor: boolean; queued: boolean } | null {
    return this.mouseButtons.find((d) => d.event === event) ?? null;
  }

  // ---------------------------------------------------------- local key ops
  /** Returns false (with optional beep reason) when input is rejected. */
  canAcceptKeys(): boolean {
    return this.lock === 'none' && this.waitingForInput;
  }

  currentField(): Field | null {
    return this.fieldAt(this.cursorPos);
  }

  typeChar(ch: string): { ok: boolean; autoEnter: boolean } {
    const f = this.currentField();
    if (!f) return { ok: false, autoEnter: false };
    if (this.attrPlace[this.cursorPos]) return { ok: false, autoEnter: false };
    if (f.toUpper) ch = ch.toUpperCase();

    if (f.numeric || f.signedNumeric) {
      if (!/^[0-9.,+\- ]$/.test(ch)) return { ok: false, autoEnter: false };
    }

    const pos = this.cursorPos;
    if (this.insertMode) {
      // shift right within the field; refuse when the last cell is used
      if (this.chars[f.endPos] !== ' ' && this.chars[f.endPos] !== '\u0000') {
        return { ok: false, autoEnter: false };
      }
      for (let p = f.endPos; p > pos; p--) {
        this.chars[p] = this.chars[p - 1];
        this.attrs[p] = this.attrs[p - 1];
        this.markDirty(p);
      }
    }
    this.chars[pos] = ch;
    this.attrs[pos] = f.attr;
    this.markDirty(pos);
    this.setFieldMDT(f);

    const wasAtEnd = pos >= f.endPos;
    if (pos < f.endPos) this.cursorPos = pos + 1;

    // AUTO ENTER: filling the last position performs Field Exit + Enter.
    if (wasAtEnd && f.autoEnter) return { ok: true, autoEnter: true };
    return { ok: true, autoEnter: false };
  }

  fieldExit(): void {
    const f = this.currentField();
    if (!f) return;
    for (let p = this.cursorPos; p <= f.endPos; p++) {
      this.chars[p] = ' ';
      this.markDirty(p);
    }
    this.setFieldMDT(f);
    this.gotoField(1);
  }

  /** FIELD-: previous field when empty at start, else destructive backspace. */
  fieldMinus(): void {
    const f = this.currentField();
    if (!f) return;
    if (this.cursorPos === f.dataStart && this.fieldText(f).trim() === '') {
      this.gotoField(-1);
      return;
    }
    this.deleteBackward();
  }

  deleteBackward(): void {
    const f = this.currentField();
    if (!f) return;
    if (this.cursorPos <= f.dataStart) return;
    const pos = this.cursorPos - 1;
    for (let p = pos; p < f.endPos; p++) {
      this.chars[p] = this.chars[p + 1];
      this.markDirty(p);
    }
    this.chars[f.endPos] = ' ';
    this.markDirty(f.endPos);
    this.cursorPos = pos;
    this.setFieldMDT(f);
  }

  deleteKey(): void {
    const f = this.currentField();
    if (!f) return;
    for (let p = this.cursorPos; p < f.endPos; p++) {
      this.chars[p] = this.chars[p + 1];
      this.markDirty(p);
    }
    this.chars[f.endPos] = ' ';
    this.markDirty(f.endPos);
    this.setFieldMDT(f);
  }

  backspace(): void {
    const f = this.currentField();
    if (!f) return;
    if (this.cursorPos > f.dataStart) this.cursorPos--;
  }

  arrow(dr: number, dc: number): void {
    const r = this.rowOf(this.cursorPos) - 1 + dr;
    const c = this.colOf(this.cursorPos) - 1 + dc;
    if (r < 0 || r >= this.rows || c < 0 || c >= this.cols) return;
    const rowStart = this.posOf(r + 1, 1);
    const rowEnd = rowStart + this.cols - 1;
    // The cursor moves freely (real 5250s do not clamp it to the current
    // field - option-column lists are walked line by line with Up/Down).
    // Attribute cells are the only exception: step right onto the next
    // addressable cell of that row instead of landing on them.
    let target = this.posOf(r + 1, c + 1);
    while (target <= rowEnd && this.attrPlace[target]) target++;
    if (target > rowEnd) return;
    this.cursorPos = target;
  }

  /**
   * Mouse click: park the cursor at the clicked cell, tn5250j-style - the
   * same freedom the arrow keys have (any field of the screen, not just the
   * current one; a 5250 keyboard cannot jump fields, the mouse can).
   * Attribute cells are stepped past exactly like arrow movement.
   */
  clickTo(row1: number, col1: number): boolean {
    if (row1 < 1 || row1 > this.rows || col1 < 1 || col1 > this.cols) return false;
    const rowEnd = this.posOf(row1, this.cols);
    let target = this.posOf(row1, col1);
    while (target <= rowEnd && this.attrPlace[target]) target++;
    if (target > rowEnd) return false;
    this.cursorPos = target;
    return true;
  }

  home(): void {
    this.cursorPos = this.homePos;
  }

  endOfField(): void {
    const f = this.currentField();
    if (!f) return;
    this.cursorPos = f.endPos;
  }

  // ------------------------------------------------------ read response body
  /**
   * Build the field-data portion of an AID / read response
   * (mirrors tn5250j ScreenFields.readFormatTable).
   *
   * - READ INPUT FIELDS (0x42): every non-empty input field, full text,
   *   no SBA prefixes.
   * - READ MDT FIELDS (0x52/0x83): only MDT fields, trailing blanks
   *   stripped, each prefixed with SBA + 1-based row/col.
   */
  buildReadResponse(): Buffer {
    const out: number[] = [];
    const isMdtRead =
      this.readType === C.CMD_READ_MDT_FIELDS ||
      this.readType === C.CMD_READ_MDT_FIELDS_ALT ||
      this.readType === C.CMD_READ_IMMEDIATE_ALT;

    if (this.masterMDT) {
      for (const f of this.fields) {
        if (!(f.mdt || this.readType === C.CMD_READ_INPUT_FIELDS)) continue;

        let text = this.fieldText(f);
        if (isMdtRead) {
          text = text.replace(/[ \u0000]+$/, '');
        }

        let signed = false;
        if (f.signedNumeric && text.endsWith('-')) {
          signed = true;
          text = text.slice(0, -1);
        }

        // READ INPUT FIELDS transmits EVERY input field at full width, in
        // format-table order - empty fields included - because the host maps
        // the runs positionally (lib5250 send_fields). Truncating empty
        // fields would shift every following run into the wrong field.
        if (text.length > 0 || isMdtRead) {
          if (isMdtRead) {
            // SBA addresses the first DATA cell (tn5250j readFormatTable,
            // lib5250 field_data) - not the attribute cell.
            out.push(C.ORDER_SBA, this.rowOf(f.dataStart) & 0xff, this.colOf(f.dataStart) & 0xff);
          }
          for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            const cp = ch.codePointAt(0) ?? 0x40;
            if (signed && i === text.length - 1 && cp >= 0x30 && cp <= 0x39) {
              out.push(0xd0 | (cp & 0x0f)); // overpunch sign digit
            } else if (cp < 0x20) {
              out.push(cp); // dup char & friends pass through raw
            } else {
              out.push(this.ebcdic.uni2ebcdic(ch));
            }
          }
        } else {
          for (let i = 0; i < f.length; i++) out.push(0x40); // blank run
        }
      }
    }
    return Buffer.from(out);
  }

  /** READ SCREEN IMMEDIATE / TO PRINT: dump the whole buffer. */
  buildScreenDump(): Buffer {
    const out: number[] = [];
    let lastAttr = 0x20;
    for (let p = 0; p < this.size; p++) {
      if (this.attrPlace[p]) {
        lastAttr = this.attrs[p];
        out.push(lastAttr);
      } else {
        if (this.attrs[p] !== lastAttr) {
          lastAttr = this.attrs[p];
          out.push(lastAttr);
        }
        const ch = this.chars[p];
        const cp = ch.codePointAt(0) ?? 0x20;
        if (cp >= 0x20) out.push(this.ebcdic.uni2ebcdic(ch));
        else out.push(cp);
      }
    }
    return Buffer.from(out);
  }

  /** Mark all fields' MDT per WTD CC0 reset/null bits. */
  applyWccMdt(resetMDT: boolean, resetAll: boolean, nullMDT: boolean, nullAll: boolean): void {
    for (const f of this.fields) {
      if ((nullMDT && f.mdt) || nullAll) {
        for (let p = f.dataStart; p <= f.endPos; p++) {
          this.chars[p] = ' ';
          this.markDirty(p);
        }
      }
      if (resetAll || (resetMDT && !f.isBypass)) f.mdt = false;
    }
    if (resetAll || resetMDT) {
      this.masterMDT = this.fields.some((f) => f.mdt);
    }
  }

  /** Take a full copy of visible state (for the gateway's screen pushes). */
  snapshotCells(): { chars: string[]; attrs: number[] } {
    return { chars: [...this.chars], attrs: [...this.attrs] };
  }
}
