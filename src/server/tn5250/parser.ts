// Parser for inbound 5250 records (the command stream after the RFC 1205
// GDS header). Dispatch semantics mirror tn5250j's tnvt.parseIncoming /
// writeToDisplay, which interoperate with real IBM i hosts.
import * as C from './constants.ts';
import type { Screen5250 } from './screen.ts';
import type { Telnet5250 } from './telnet.ts';
import type { Ebcdic } from './ebcdic.ts';

export class Parser5250 {
  private buf: Buffer = Buffer.alloc(0);
  private pos = 0;
  private end = 0;
  private pendingUnlock = false;
  beep = false;
  cursorChanged = false;

  private readonly screen: Screen5250;
  private readonly telnet: Telnet5250;
  private readonly ebcdic: Ebcdic;
  private readonly warn: (msg: string) => void;

  constructor(
    screen: Screen5250,
    telnet: Telnet5250,
    ebcdic: Ebcdic,
    warn: (msg: string) => void
  ) {
    this.screen = screen;
    this.telnet = telnet;
    this.ebcdic = ebcdic;
    this.warn = warn;
  }

  private hasNext(): boolean {
    return this.pos < this.end;
  }

  private next(): number {
    if (this.pos >= this.end) throw new Error('read past end of record');
    return this.buf[this.pos++] & 0xff;
  }

  private nextSigned(): number {
    // Java bytes are signed; tn5250j compares some values (rows) directly.
    const v = this.next();
    return v;
  }

  private peek(): number {
    return this.buf[this.pos] & 0xff;
  }

  /** 1-based cursor row/col pair for read replies. */
  private cursorBytes(): number[] {
    return [this.screen.rowOf(this.screen.cursorPos) & 0xff, this.screen.colOf(this.screen.cursorPos) & 0xff];
  }

  /** Parse one complete record (including the 2-byte length prefix). */
  parse(record: Buffer): void {
    this.beep = false;
    this.cursorChanged = false;
    if (record.length < 12) return; // too small to be a 5250 record
    const declared = (record[0] << 8) | record[1];
    if (declared + 2 !== record.length) {
      this.warn(`record length mismatch: declared ${declared}, got ${record.length - 2}`);
    }
    if (record[2] !== 0x12 || record[3] !== 0xa0) {
      this.warn(`unexpected record header ${record[2]?.toString(16)} ${record[3]?.toString(16)}`);
    }
    this.buf = record;
    this.end = Math.min(record.length, declared + 2);
    this.pos = 6 + (record[6] ?? 4); // usually 10, per Stream5250

    try {
      while (this.hasNext()) {
        this.parseCommand();
      }
    } catch (err) {
      this.warn(
        `record parse error: ${(err as Error).message}\n` +
          `  pos=${this.pos}/${this.end} cmdhex=${record.toString('hex')}`
      );
      this.negativeResponse(C.NR_REQUEST_ERROR, 0x03, 0x01, 0x01);
    }

    if (this.pendingUnlock && !this.screen.errorCodeActive) {
      this.screen.lock = 'none';
      this.pendingUnlock = false;
      this.cursorChanged = true;
    }
  }

  private parseCommand(): void {
    const cmd = this.next();
    switch (cmd) {
      case C.CMD_NOP:
      case C.CMD_INVITE:
      case C.CMD_ESCAPE:
        break;

      case C.CMD_SAVE_SCREEN:
      case C.CMD_SAVE_PARTIAL_SCREEN:
        this.screen.saveScreen();
        break;

      case C.CMD_SIGNAL: // audible bell, 2 unused bytes follow
        this.beep = true;
        this.next();
        this.next();
        break;

      case C.CMD_WRITE_TO_DISPLAY:
        this.writeToDisplay(true);
        break;

      case C.CMD_RESTORE_SCREEN:
      case C.CMD_RESTORE_PARTIAL_SCREEN:
        this.screen.restoreScreen();
        this.cursorChanged = true;
        break;

      case C.CMD_CLEAR_UNIT_ALTERNATE: {
        const param = this.next();
        if (param !== 0) {
          this.negativeResponse(C.NR_REQUEST_ERROR, 0x03, 0x01, 0x05);
          return;
        }
        if (this.screen.rows !== 27) this.screen.setSize(27, 132);
        else this.screen.clearAll();
        this.cursorChanged = true;
        break;
      }

      case C.CMD_WRITE_ERROR_CODE:
        this.screen.beginErrorCode(1);
        this.writeToDisplay(false);
        break;

      case C.CMD_WRITE_ERROR_CODE_TO_WINDOW: {
        const fromCol = this.next();
        this.next(); // toCol
        this.screen.beginErrorCode(fromCol);
        this.writeToDisplay(false);
        break;
      }

      case C.CMD_ROLL: {
        const direction = this.next();
        const top = this.next();
        const bottom = this.next();
        this.screen.roll(direction, top, bottom);
        break;
      }

      case C.CMD_CLEAR_UNIT:
        if (this.screen.rows !== 24) this.screen.setSize(24, 80);
        else this.screen.clearAll();
        this.cursorChanged = true;
        break;

      case C.CMD_READ_INPUT_FIELDS:
      case C.CMD_READ_MDT_FIELDS:
      case C.CMD_READ_MDT_FIELDS_ALT: {
        this.next(); // control bytes
        this.next();
        this.screen.readType = cmd;
        this.screen.waitingForInput = true;
        this.pendingUnlock = true;
        this.screen.goHome();
        this.cursorChanged = true;
        break;
      }

      // Host wants the field data right away (no AID, no invite). The reply
      // still starts with [cursor row, cursor col, AID=0] per the 5494 FR.
      case C.CMD_READ_IMMEDIATE: {
        this.screen.readType = C.CMD_READ_INPUT_FIELDS; // full-width runs, no SBA
        this.screen.lockSystem();
        const body = this.screen.buildReadResponse();
        this.telnet.sendGds(0, 3, Buffer.from([...this.cursorBytes(), 0x00, ...body]));
        break;
      }
      case C.CMD_READ_IMMEDIATE_ALT: {
        this.screen.readType = C.CMD_READ_IMMEDIATE_ALT; // SBA + MDT fields
        this.screen.lockSystem();
        const body = this.screen.buildReadResponse();
        this.telnet.sendGds(0, 3, Buffer.from([...this.cursorBytes(), 0x00, ...body]));
        break;
      }

      case C.CMD_READ_SCREEN_IMMEDIATE:
      case C.CMD_READ_SCREEN_EXTENDED:
      case C.CMD_READ_SCREEN_TO_PRINT:
      case C.CMD_READ_SCREEN_PRINT_EXTENDED:
      case C.CMD_READ_SCREEN_PRINT_GRID:
      case C.CMD_READ_SCREEN_PRINT_EXT_GRID:
        this.telnet.sendGds(0, 0, this.screen.buildScreenDump());
        break;

      case C.CMD_CLEAR_FORMAT_TABLE:
        this.screen.clearFormatTable();
        break;

      case C.CMD_WRITE_STRUCTURED_FIELD:
        this.writeStructuredField();
        break;

      default:
        this.warn(`unknown command 0x${cmd.toString(16)}`);
        this.negativeResponse(C.NR_REQUEST_ERROR, 0x03, 0x01, 0x01);
        throw new Error('stop');
    }
  }

  // ------------------------------------------------------------ WTD handling
  private writeToDisplay(controlsExist: boolean): void {
    let control1 = 0;
    if (controlsExist) {
      const control0 = this.next();
      control1 = this.next();
      this.processWcc0(control0);
    }

    let done = false;
    while (this.hasNext() && !done) {
      const b = this.next();
      switch (b) {
        case C.ORDER_SOH:
          this.processStartOfHeader();
          break;

        case C.ORDER_RA: {
          const fromRow = this.screen.rowOf(this.screen.writePos);
          const fromCol = this.screen.colOf(this.screen.writePos);
          const toRow = this.nextSigned();
          const toCol = this.next();
          // Errors abort only this order - never the whole WTD. A host order
          // we reject must not desync the remaining orders (lib5250 skips
          // the order and keeps parsing).
          const raInvalid =
            toRow < 1 || toRow > this.screen.rows || toCol < 1 || toCol > this.screen.cols;
          if (raInvalid || toRow < fromRow) {
            const repeatChar = this.next();
            this.warn(`RA order skipped (target ${toRow},${toCol} from ${fromRow},${fromCol})`);
            this.negativeResponse(C.NR_REQUEST_ERROR, 0x05, 0x01, 0x23);
            break;
          }
          const repeatChar = this.next();
          const to = this.screen.posOf(toRow, toCol);
          const from = this.screen.posOf(fromRow, fromCol);
          const ch =
            repeatChar === 0
              ? ' '
              : repeatChar >= 0x40 && repeatChar < 0xff
                ? this.ebcdic.ebcdic2uni(repeatChar)
                : String.fromCharCode(repeatChar);
          for (let p = from; p <= to && p < this.screen.size; p++) this.screen.writeChar(ch);
          break;
        }

        case C.ORDER_EA: {
          const fromRow = this.screen.rowOf(this.screen.writePos);
          const fromCol = this.screen.colOf(this.screen.writePos);
          const toRow = this.nextSigned();
          const toCol = this.next();
          const skipLen = this.next();
          for (let i = 1; i < skipLen; i++) this.next(); // erase attributes
          const from = this.screen.posOf(fromRow, fromCol);
          const to = this.screen.posOf(toRow, toCol);
          for (let p = from; p <= to; p++) this.screen.writeChar(' ');
          break;
        }

        case C.CMD_ESCAPE: // end of this WTD; next command follows
          done = true;
          break;

        case C.ORDER_TD: {
          // Transparent data: 2-byte length then raw bytes.
          const len = (this.next() << 8) | this.next();
          for (let i = 0; i < len && this.hasNext(); i++) {
            this.screen.writeChar(String.fromCharCode(this.next() & 0xff));
          }
          break;
        }

        case C.ORDER_SBA: {
          const row = this.nextSigned();
          const col = this.next();
          if (!this.screen.setWritePos(Math.max(row, 1), Math.max(col, 1))) {
            this.negativeResponse(C.NR_REQUEST_ERROR, 0x05, 0x01, 0x22);
            return;
          }
          break;
        }

        case C.ORDER_WEA: // extended attribute - ignored
          this.next();
          this.next();
          break;

        case C.ORDER_IC: {
          const row = this.nextSigned();
          const col = this.next();
          if (row >= 1 && row <= this.screen.rows && col >= 1 && col <= this.screen.cols) {
            this.screen.pendingInsert = true;
            this.screen.homePos = this.screen.posOf(row, col);
            this.screen.cursorPos = this.screen.homePos;
            this.cursorChanged = true;
          } else {
            this.negativeResponse(C.NR_REQUEST_ERROR, 0x05, 0x01, 0x22);
          }
          break;
        }

        case C.ORDER_MC: {
          const row = this.nextSigned();
          const col = this.next();
          if (row >= 1 && row <= this.screen.rows && col >= 1 && col <= this.screen.cols) {
            this.screen.cursorPos = this.screen.posOf(row, col);
            // MC cancels pending-insert homing: the cursor stays where the
            // host put it instead of jumping to the IC/home position at the
            // next read invite (tn5250j setPendingInsert(false, x, y)).
            this.screen.pendingInsert = false;
            this.cursorChanged = true;
          } else {
            this.negativeResponse(C.NR_REQUEST_ERROR, 0x05, 0x01, 0x22);
          }
          break;
        }

        case C.ORDER_WTDSF: {
          // GUI structured field segment: 2-byte length + data; skipped.
          const len = (this.next() << 8) | this.next();
          for (let i = 0; i < len && this.hasNext(); i++) this.next();
          break;
        }

        case C.ORDER_SF:
          this.processStartOfField();
          break;

        default:
          // Data byte: attribute markers (0x20-0x3F) vs EBCDIC text.
          if (C.isAttributeByte(b)) this.screen.writeAttribute(b);
          else this.screen.writeEbcdicByte(b);
      }
    }

    this.processWcc1(control1);
  }

  /**
   * SF order. Three legal stream shapes (5494 Functions Reference;
   * mirrors tn5250j + lib5250 interop against real hosts):
   *
   *   1D <FFW1> <FFW2> [FCW pairs...] <attr> <lenHi> <lenLo>   FFW1 bit 0x40 set
   *   1D <FFW1> <FFW2> [FCW pairs...] <attr> <lenHi> <lenLo>   FFW1 < 0x20 (lib5250 form)
   *   1D <attr> <lenHi> <lenLo>                                 no format words
   *
   * The length word counts DATA cells only; the attribute byte occupies its
   * own cell ahead of them. Never confuse an attribute byte (0x20-0x3F) with
   * FFW1: every attribute byte carries bit 0x20 (bypass), 0x08 (MDT) etc.,
   * which silently poisons the field table.
   */
  private processStartOfField(): void {
    let fcw1 = 0;
    let fcw2 = 0;
    let ffw1 = 0;
    let ffw0 = this.next();

    let attr: number;
    if ((ffw0 & C.FFW1_EXTEND) === C.FFW1_EXTEND || !C.isAttributeByte(ffw0)) {
      ffw1 = this.next();
      fcw1 = this.next();
      if (fcw1 === C.FCW_CONTINUED) {
        this.next();
        fcw1 = this.next();
      }
      if (!C.isAttributeByte(fcw1)) {
        fcw2 = this.next();
        attr = this.next();
        let guard = 0;
        while (!C.isAttributeByte(attr)) {
          if (guard++ > 16 || !this.hasNext()) {
            this.warn('SF: attribute scan ran off');
            return;
          }
          attr = this.next();
        }
      } else {
        attr = fcw1;
        fcw1 = 0;
      }
    } else {
      // No field format words: the first byte is the attribute itself.
      attr = ffw0;
      ffw0 = 0;
    }
    const length = (this.next() << 8) | this.next();
    this.screen.addField(attr, length, ffw0, ffw1, fcw1, fcw2);
  }

  /** SOH order - S/36 EE support; carries error line + PF data-included bits. */
  private processStartOfHeader(): void {
    const len = this.next();
    if (len <= 0 || len > 7) {
      this.negativeResponse(C.NR_REQUEST_ERROR, 0x05, 0x01, 0x2b);
      return;
    }
    this.next(); // flag byte
    this.next(); // reserved
    this.next(); // resequence fields
    this.screen.clearFormatTable();
    if (len <= 3) return;
    this.screen.errorLineRow = this.next();
    const d = this.screen.dataIncluded;
    if (len >= 5) {
      const b = this.next();
      for (let i = 0; i < 8; i++) d[16 + i] = (b & (0x80 >> i)) !== 0;
    }
    if (len >= 6) {
      const b = this.next();
      for (let i = 0; i < 8; i++) d[8 + i] = (b & (0x80 >> i)) !== 0;
    }
    if (len >= 7) {
      const b = this.next();
      for (let i = 0; i < 8; i++) d[i] = (b & (0x80 >> i)) !== 0;
    }
  }

  /** Write Control Character 0: keyboard lock + MDT reset/null actions. */
  private processWcc0(cc0: number): void {
    const lock = (cc0 & 0xe0) !== 0x00;
    const resetMDT = (cc0 & 0xe0) === 0x40 || (cc0 & 0xe0) === 0xa0 || (cc0 & 0xe0) === 0xc0;
    const resetAll = (cc0 & 0xe0) === 0x60 || (cc0 & 0xe0) === 0xe0;
    const nullMDT = (cc0 & 0xe0) === 0x80 || (cc0 & 0xe0) === 0xc0;
    const nullAll = (cc0 & 0xe0) === 0xa0 || (cc0 & 0xe0) === 0xe0;

    if (lock) {
      this.screen.lockSystem();
      this.pendingUnlock = false;
    }
    if (resetMDT || resetAll || nullMDT || nullAll) {
      this.screen.applyWccMdt(resetMDT, resetAll, nullMDT, nullAll);
    }
  }

  /** Write Control Character 1: bell, message light, cursor placement. */
  private processWcc1(cc1: number): void {
    if ((cc1 & 0x04) === 0x04) this.beep = true;
    if ((cc1 & 0x02) === 0x02) this.screen.messageWait = false;
    if ((cc1 & 0x01) === 0x01) this.screen.messageWait = true;

    const noMove = (cc1 & 0x20) === 0x20 && (cc1 & 0x08) === 0x00;
    this.screen.placeCursorAfterWrite(noMove);
    this.cursorChanged = true;
  }

  // ------------------------------------------------------------------- WSF
  private writeStructuredField(): void {
    while (this.hasNext()) {
      // Structured-field length counts itself (2 bytes) + payload.
      const len = (this.next() << 8) | this.next();
      if (len < 4) {
        this.warn(`WSF: implausible length ${len}`);
        return;
      }
      const sfClass = this.next();
      const sfType = this.next();
      const rest = len - 4;
      for (let i = 0; i < rest && this.hasNext(); i++) this.next();
      if (sfClass === 0xd9 && sfType === 0x70) {
        this.sendQueryResponse(); // 5250 Query
      }
    }
  }

  /** 64-byte 5250 Query Reply, byte-for-byte as tn5250j sends it. */
  private sendQueryResponse(): void {
    const e = (ch: string) => this.ebcdic.uni2ebcdic(ch);
    const b = new Array<number>(64).fill(0);
    b[0] = 0; // cursor row
    b[1] = 0; // cursor column
    b[2] = 0x88; // inbound WSF AID
    b[3] = 0; // query response length (0x0040)
    b[4] = 64;
    b[5] = 0xd9; // command class
    b[6] = 0x70; // command type: query
    b[7] = 0x80; // flag byte
    b[8] = 6; // controller hardware class: other WSF / 5250 emulator
    b[9] = 0;
    b[10] = 1; // controller code level 1.1.0
    b[11] = 1;
    b[12] = 0;
    // 13-28 reserved (0)
    b[29] = 1; // device type: 5250 emulator
    b[30] = e('5'); // device type characters: 5251011
    b[31] = e('2');
    b[32] = e('5');
    b[33] = e('1');
    b[34] = e('0');
    b[35] = e('1');
    b[36] = e('1');
    b[37] = 2; // keyboard id: standard
    b[38] = 0;
    b[39] = 0;
    b[40] = 0; // display serial number
    b[41] = 36;
    b[42] = 36;
    b[43] = 0;
    b[44] = 1; // max display fields: 256
    b[45] = 0;
    b[49] = 1; // controller display capability
    b[50] = 17;
    b[51] = 0;
    b[52] = 0;
    b[53] = 0x07; // enhanced mode options
    b[54] = 8; // enhanced user interface level 3
    // 55-63 reserved (0)
    this.telnet.sendGds(0, 0, Buffer.from(b));
  }

  private negativeResponse(cat: number, modifier: number, u1: number, u2: number): void {
    this.telnet.sendGds(C.GDS_FLAG_ERR, 0, Buffer.from([cat, modifier, u1, u2]));
  }
}
