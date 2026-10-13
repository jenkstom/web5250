// Parser for inbound 5250 records (the command stream after the RFC 1205
// GDS header). Dispatch semantics mirror tn5250j's tnvt.parseIncoming /
// writeToDisplay, which interoperate with real IBM i hosts.
import * as zlib from 'node:zlib';
import * as C from './constants.ts';
import { GUI_BORDER_CHARS, PLAIN_BORDER_CHARS } from './screen.ts';
import type { Screen5250, SelectionChoice, WindowTitle } from './screen.ts';
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
  /** Informational diagnostics (defaults to warn until the client overrides). */
  log: (msg: string) => void;
  /** Claim pointer-device capability in the query reply (IBM_I_MOUSE_GUI=1). */
  private readonly mouseGui: boolean;

  constructor(
    screen: Screen5250,
    telnet: Telnet5250,
    ebcdic: Ebcdic,
    warn: (msg: string) => void,
    mouseGui = false
  ) {
    this.screen = screen;
    this.telnet = telnet;
    this.ebcdic = ebcdic;
    this.warn = warn;
    this.log = warn;
    this.mouseGui = mouseGui;
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
    if (record.length < 10) return; // smaller than the GDS header itself
    const declared = (record[0] << 8) | record[1];
    // RFC 1205: the length word counts itself and the record still carries
    // it, so declared must equal the total length.
    if (declared !== record.length) {
      this.warn(`record length mismatch: declared ${declared}, got ${record.length}`);
    }
    if (record[2] !== 0x12 || record[3] !== 0xa0) {
      this.warn(`unexpected record header ${record[2]?.toString(16)} ${record[3]?.toString(16)}`);
    }
    this.buf = record;
    this.end = Math.min(record.length, declared);
    this.pos = 6 + (record[6] ?? 4); // usually 10, per Stream5250

    // RFC 1205 session-level opcodes ride the GDS header itself (the opcode
    // is byte 9) and carry no 5250 command stream - the command loop below
    // starts after the header and would never see them. tn5250j handles the
    // same set in its outer opcode switch.
    if (this.end > 9) {
      switch (record[9]) {
        case 0x06: // Read Immediate: reply cursor + AID 0, no field data
          this.telnet.sendGds(0, 3, Buffer.from([...this.cursorBytes(), 0x00]));
          return;
        case 0x08: // Read Screen Operation: reply with the screen image
          this.telnet.sendGds(0, 0, this.screen.buildScreenDump());
          return;
        case 0x09: // reserved
          return;
        case 0x0a: {
          // Cancel Invite Operation (RFC 1205 4.3): the host cancels the
          // outstanding read - inhibit the keyboard (X SYSTEM) and answer
          // with our own cancel-invite record, as tn5250j does.
          this.screen.waitingForInput = false;
          this.screen.lockSystem();
          this.cursorChanged = true;
          this.telnet.sendGds(0, 0x0a);
          return;
        }
        case 0x0b: // message light on
          this.screen.messageWait = true;
          return;
        case 0x0c: // message light off
          this.screen.messageWait = false;
          return;
      }
    }

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
      case C.CMD_SAVE_PARTIAL_SCREEN: {
        this.screen.saveScreen();
        // GDS opcode 0x04 marks this host's image-save dialect: after a
        // host-programmed mouse AID it writes nothing more (no menu) until
        // the device hands its screen image back. Captured from ACS: the
        // reply is X'04' X'12' <compressed cookie> with GDS opcode 04 and
        // header byte 8 = X'80'.
        if (this.buf[6] === 4 && this.buf[9] === 0x04) this.sendSaveImage();
        break;
      }

      case C.CMD_RESTORE_SCREEN:
      case C.CMD_RESTORE_PARTIAL_SCREEN: {
        // GDS opcode 0x05 replays the device's own save cookie after the
        // X'12' (the cookie runs to the end of the record); classic restores
        // carry nothing and pop the local snapshot stack.
        const replay =
          this.buf[6] === 4 && this.buf[9] === 0x05 && this.hasNext()
            ? this.buf.subarray(this.pos, this.end)
            : null;
        if (replay) {
          this.pos = this.end;
          if (!this.screen.restoreSavedImage(replay)) this.screen.restoreScreen();
        } else {
          this.screen.restoreScreen();
        }
        this.cursorChanged = true;
        break;
      }

      case C.CMD_SIGNAL: // audible bell, 2 unused bytes follow
        this.beep = true;
        this.next();
        this.next();
        break;

      case C.CMD_WRITE_TO_DISPLAY:
        this.writeToDisplay(true);
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

      // GUI hosts deliver exactly one structured field this way (e.g. the
      // sign-on flow for a device that claimed mouse/GUI capability).
      case C.CMD_WRITE_SINGLE_STRUCTURED_FIELD:
        this.readOneSF();
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
            // Note: MC does NOT cancel pending-insert homing here. tn5250j
            // clears it (setPendingInsert(false, x, y)), but against at least
            // one live IBM i QDSIGNON the IC position must win for the cursor
            // to land in the User field - the host's MC appears to be for
            // layout, not cursor placement.
            this.cursorChanged = true;
          } else {
            this.negativeResponse(C.NR_REQUEST_ERROR, 0x05, 0x01, 0x22);
          }
          break;
        }

        case C.ORDER_WTDSF: {
          // Write to Display Structured Field order: one structured field
          // (mouse-button programming arrives here per the 5494 FR).
          this.readOneSF();
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

  /**
   * SOH order - S/36 EE support; carries error line + PF data-included bits.
   * Live hosts send length words beyond the classic 1..7 (16 observed on
   * IBM i message screens); the length counts the bytes that follow it.
   * Bytes beyond the seventh are reserved and consumed verbatim - failing
   * to consume them desyncs the whole write.
   */
  private processStartOfHeader(): void {
    const len = this.next();
    if (len <= 0 || len > 32) {
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
    for (let i = 5; i <= len; i++) {
      if (!this.hasNext()) return;
      const b = this.next();
      if (i === 5) {
        for (let k = 0; k < 8; k++) d[16 + k] = (b & (0x80 >> k)) !== 0;
      } else if (i === 6) {
        for (let k = 0; k < 8; k++) d[8 + k] = (b & (0x80 >> k)) !== 0;
      } else if (i === 7) {
        for (let k = 0; k < 8; k++) d[k] = (b & (0x80 >> k)) !== 0;
      }
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
  /**
   * Read one structured field (2-byte length, class, type, payload) and
   * dispatch the known D9 types. Shared by the WSF command (X'F3', a chain
   * of fields), WRITE SINGLE STRUCTURED FIELD (X'F4', exactly one field)
   * and the Write-to-Display-Structured-Field order (X'15') - GUI-capable
   * hosts use all three, e.g. the PROGRAMMABLE MOUSE BUTTONS field rides
   * the X'15' order inside a Write to Display.
   */
  private readOneSF(): void {
    const len = (this.next() << 8) | this.next();
    if (len < 4) {
      this.warn(`WSF: implausible length ${len}`);
      return;
    }
    const sfClass = this.next();
    const sfType = this.next();
    const rest: number[] = [];
    for (let i = 0; i < len - 4 && this.hasNext(); i++) rest.push(this.next());
    if (sfClass === 0xd9 && sfType === 0x70) {
      this.sendQueryResponse(); // 5250 Query
    } else if (sfClass === 0xd9 && sfType === 0x55) {
      this.decodeMouseButtons(rest);
    } else if (sfClass === 0xd9 && sfType === 0x51) {
      this.decodeCreateWindow(rest); // CREATE WINDOW (5494 FR Table 15-12)
    } else if (sfClass === 0xd9 && sfType === 0x50) {
      this.decodeSelectionField(rest); // DEFINE SELECTION FIELD (15-18/19)
    } else if (sfClass === 0xd9 && sfType === 0x58) {
      this.screen.setSelection(null); // REMOVE GUI SELECTION FIELD
    } else if (sfClass === 0xd9 && sfType === 0x59) {
      this.screen.clearGui(); // REMOVE GUI WINDOW (drops fields inside it)
    } else if (sfClass === 0xd9 && sfType === 0x5f) {
      this.screen.clearGui(); // REMOVE ALL GUI CONSTRUCTS
    } else if (sfClass === 0xd9) {
      this.log(`WSF: class D9 type ${sfType.toString(16)} (${rest.length} bytes) skipped`);
    }
  }

  private writeStructuredField(): void {
    while (this.hasNext()) this.readOneSF();
  }

  /**
   * PROGRAMMABLE MOUSE BUTTONS structured field (5494 FR Table 15-28/15-29):
   * the host maps mouse events to application AIDs (X'70'-X'7F' or a defined
   * AID - the live app maps right-down to PF4 and left-double to PF7/PF2 per
   * screen). Payload after length/class/type is 3 reserved bytes plus 4-byte
   * event definitions: [flags, first event, second event, AID]. The table is
   * stored on the screen model (replacing any previous one - the host
   * resends it with each screen format); flag bits use the manual's
   * convention of bit 0 = X'80'.
   */
  private decodeMouseButtons(rest: number[]): void {
    const EVENT: Record<number, string> = {
      0x01: 'left-down', 0x02: 'left-up', 0x03: 'left-double',
      0x04: 'right-down', 0x05: 'right-up', 0x06: 'right-double',
      0x07: 'middle-down', 0x08: 'middle-up', 0x09: 'middle-double',
      0x0a: 'shift-left-down', 0x0b: 'shift-left-up', 0x0c: 'shift-left-double',
      0x0d: 'shift-right-down', 0x0e: 'shift-right-up', 0x0f: 'shift-right-double',
      0x10: 'shift-middle-down', 0x11: 'shift-middle-up', 0x12: 'shift-middle-double'
    };
    const defs = rest.slice(3); // 3 reserved bytes, then 4-byte definitions
    const table: { event: number; aid: number; moveCursor: boolean; queued: boolean }[] = [];
    for (let i = 0; i + 3 < defs.length; i += 4) {
      const flags = defs[i];
      const first = EVENT[defs[i + 1]] ?? `event-${defs[i + 1].toString(16)}`;
      const aid = defs[i + 3];
      const twoEvent = (flags & 0x80) !== 0;
      const moveCursor = (flags & 0x40) !== 0;
      const queued = (flags & 0x20) !== 0;
      const second = twoEvent ? ` + ${(EVENT[defs[i + 2]] ?? `event-${defs[i + 2].toString(16)}`)}` : '';
      const bits = [
        twoEvent ? 'two-event' : 'single',
        moveCursor ? 'move-cursor' : '',
        queued ? 'queued' : '',
        (flags & 0x10) !== 0 ? 'marker' : ''
      ].filter(Boolean).join(',');
      this.log(`MOUSE BUTTONS: ${first}${second} -> AID 0x${aid.toString(16)} (${bits}, flags=0x${flags.toString(16)})`);
      // Two-event defs (flags X'80', e.g. right down+up as one completed
      // click) are registered under their FIRST event: a browser reports a
      // contextmenu/dblclick only once the pair is done.
      table.push({ event: defs[i + 1], aid, moveCursor, queued });
    }
    this.screen.setMouseButtons(table);
    if (defs.length === 0) this.log('MOUSE BUTTONS: table reset (no definitions)');
  }

  /**
   * CREATE WINDOW (5494 FR Table 15-12): the host's popup frame, anchored
   * at the display address the preceding SBA order set (the top border
   * row's left corner attribute). Depth and width count the rows/columns
   * INSIDE the window. Minor structures: border presentation (type X'01',
   * Table 15-13) and window title/footer (type X'10', Table 15-14). The
   * frame itself is drawn by the screen model (setGuiWindow), like the
   * 5494's "creates the window borders / clears the window area".
   */
  private decodeCreateWindow(rest: number[]): void {
    if (rest.length < 5) {
      this.warn(`CREATE WINDOW: implausible payload ${rest.length}`);
      return;
    }
    let borderAttr = 0x3a; // FR default: blue on colour displays
    let chars = { ...GUI_BORDER_CHARS }; // GUI-capable display: box border
    let hostChars = false;
    let title: WindowTitle | null = null;
    let footer: WindowTitle | null = null;
    let i = 5;
    while (i + 1 < rest.length) {
      const mlen = rest[i];
      const mtype = rest[i + 1];
      if (mlen < 2 || i + mlen > rest.length) break;
      if (mtype === 0x01 && mlen >= 4) {
        // [len][X'01'][flags][mono attr][colour attr][8 border chars]
        const mono = rest[i + 3];
        const color = mlen >= 5 ? rest[i + 4] : 0;
        const attr = color >= 0x20 && color <= 0x3f ? color : mono;
        if (attr >= 0x20 && attr <= 0x3f) borderAttr = attr;
        if (mlen > 5) {
          // Host-specified border characters (X'00' = default). We are a
          // GUI-capable display, so the FR lets us draw GUI borders instead
          // - but explicit characters are honoured (tn5250j does the same).
          hostChars = true;
          const at = (k: number, fallback: string): string => {
            const v = rest[i + k];
            return v >= 0x01 && v <= 0xfe ? this.ebcdic.ebcdic2uni(v) : fallback;
          };
          chars = {
            ul: at(5, PLAIN_BORDER_CHARS.ul),
            top: at(6, PLAIN_BORDER_CHARS.top),
            ur: at(7, PLAIN_BORDER_CHARS.ur),
            left: at(8, PLAIN_BORDER_CHARS.left),
            right: at(9, PLAIN_BORDER_CHARS.right),
            ll: at(10, PLAIN_BORDER_CHARS.ll),
            bottom: at(11, PLAIN_BORDER_CHARS.bottom),
            lr: at(12, PLAIN_BORDER_CHARS.lr)
          };
        } else {
          // No characters specified: draw the GUI box (ACS conventions).
          chars = { ...GUI_BORDER_CHARS };
        }
      } else if (mtype === 0x10 && mlen >= 6) {
        // [len][X'10'][flags][mono attr][colour attr][reserved][text]
        // Flags: bits 0-1 orientation (00 centred, 01 right, 10 left),
        // bit 2 = footer. Title text is ignored for pull-down windows.
        const flags = rest[i + 2];
        const footerFlag = (flags & 0x20) !== 0;
        if (!footerFlag && (rest[0] & 0x40) !== 0) {
          this.log('CREATE WINDOW: pull-down title ignored');
        } else {
          const mono = rest[i + 3];
          const color = rest[i + 4];
          const attr =
            color >= 0x20 && color <= 0x3f ? color : mono >= 0x20 && mono <= 0x3f ? mono : 0;
          let text = '';
          for (let b = i + 6; b < i + mlen; b++) {
            const byte = rest[b];
            text += byte >= 0x40 && byte < 0xff ? this.ebcdic.ebcdic2uni(byte) : ' ';
          }
          const t: WindowTitle = {
            text: text.replace(/[ \u0000]+$/, ''),
            footer: footerFlag,
            justify: (flags & 0xc0) === 0x40 ? 'right' : (flags & 0xc0) === 0x80 ? 'left' : 'center',
            attr
          };
          if (footerFlag) footer = t;
          else title = t;
        }
      }
      i += mlen;
    }
    this.screen.setGuiWindow({
      row: this.screen.rowOf(this.screen.writePos),
      col: this.screen.colOf(this.screen.writePos),
      depth: rest[3],
      width: rest[4],
      pullDown: (rest[0] & 0x40) !== 0,
      restrictCursor: (rest[0] & 0x80) !== 0,
      borderAttr,
      chars,
      title,
      footer
    });
    this.log(
      `CREATE WINDOW: ${rest[3]}x${rest[4]} at ${this.screen.rowOf(this.screen.writePos)},${this.screen.colOf(this.screen.writePos)} border=${borderAttr.toString(16)} gui=${!hostChars}` +
        (title ? ` title="${title.text}"` : '') +
        (footer ? ` footer="${footer.text}"` : '')
    );
  }

  /**
   * DEFINE SELECTION FIELD (5494 FR Tables 15-18/15-19): the host's
   * pull-down choice list. Major structure bytes 10-16 carry textSize,
   * rows, columns, padding, separators and the pull-down cancel AID; the
   * choices are Choice Text minor structures ([len][X'10'][3 flag bytes]
   * [text]). Picks return an Enter AID with the cursor on the choice and
   * [SBA(field+1)][2-byte choice number] as the field's inbound data.
   *
   * Some hosts park a few private bytes between the major structure and
   * the choice chain (the live menu host sends 19), so the chain start is
   * found by scanning for the offset whose length chain tiles the rest of
   * the field with at least one choice.
   */
  private decodeSelectionField(rest: number[]): void {
    if (rest.length < 16) {
      this.warn(`DEFINE SELECTION FIELD: implausible payload ${rest.length}`);
      return;
    }
    const flag1 = rest[0];
    const rows = rest[10] || 1;
    const cols = rest[11] || 1;
    const textSize = rest[9] || 32;
    const padding = rest[12];
    const row = this.screen.rowOf(this.screen.writePos);
    const col = this.screen.colOf(this.screen.writePos);

    let start = 16;
    for (; start + 1 < rest.length; start++) {
      let i = start;
      let choices = 0;
      let ok = true;
      while (i + 1 < rest.length) {
        const mlen = rest[i];
        const mtype = rest[i + 1];
        if (mlen < 2 || i + mlen > rest.length || (mtype === 0x10 && mlen < 5)) {
          ok = false;
          break;
        }
        if (mtype === 0x10) choices++;
        i += mlen;
      }
      if (ok && choices > 0) break;
    }

    const table: SelectionChoice[] = [];
    let i = start;
    while (i + 1 < rest.length) {
      const mlen = rest[i];
      const mtype = rest[i + 1];
      if (mlen < 2 || i + mlen > rest.length) break;
      if (mtype === 0x10) {
        let text = '';
        for (let b = i + 5; b < i + mlen; b++) {
          const byte = rest[b];
          text += byte >= 0x40 && byte < 0xff ? this.ebcdic.ebcdic2uni(byte) : ' ';
        }
        const idx = table.length;
        table.push({
          row: row + (idx % rows),
          col: col + 1 + Math.floor(idx / rows) * (textSize + padding),
          text: text.replace(/[ \u0000]+$/, ''),
          state: rest[i + 2] & 0xc0
        });
      }
      i += mlen;
    }
    this.screen.setSelection({
      row,
      col,
      rows,
      cols,
      textSize,
      autoSelect: (flag1 & 0x02) !== 0,
      autoEnter: (flag1 & 0x18) !== 0,
      cancelAid: rest[15],
      choices: table
    });
    this.log(
      `SELECTION FIELD: ${table.length} choices at ${row},${col} (type=${rest[3].toString(16)}, ${rows}x${cols}, textSize=${textSize})`
    );
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
    // Device-capability bytes per 5494 FR Table 15-48 (IBM bit order: bit 0
    // = X'80'). Byte 4 (b[53]) bit 4 = X'10' announces a pointer device;
    // byte 5 (b[54]) bit 0 = X'80' claims UI level 2, which covers the
    // Programmable Mouse Buttons structured field. With IBM_I_MOUSE_GUI=1
    // the host programs the mouse buttons (right-click / double-click AIDs)
    // instead of treating the display as mouseless.
    if (this.mouseGui) {
      b[53] |= 0x10;
      b[54] |= 0x80;
      this.log(`query reply claims pointer device (b53=${b[53].toString(16)} b54=${b[54].toString(16)})`);
    }
    // 55-63 reserved (0)
    this.telnet.sendGds(0, 0, Buffer.from(b));
  }

  private negativeResponse(cat: number, modifier: number, u1: number, u2: number): void {
    this.telnet.sendGds(C.GDS_FLAG_ERR, 0, Buffer.from([cat, modifier, u1, u2]));
  }

  /**
   * Answer the host's image-save request (GDS opcode 04 SAVE SCREEN) with
   * the current screen as an opaque compressed cookie in RESTORE SCREEN
   * framing. Without this reply the host stalls after a host-programmed
   * mouse AID: it writes the acknowledgement (cursor at the click, no read
   * invite), asks for the image, then waits - ACS menus never appear. The
   * host stores the cookie verbatim and replays it in the opcode-05
   * RESTORE SCREEN that closes the menu exchange.
   */
  private sendSaveImage(): void {
    const cookie = zlib.deflateSync(this.screen.serializeSave());
    this.log(`save-image reply: ${cookie.length} byte cookie (GDS opcode 04)`);
    this.telnet.sendGds(
      0,
      0x04,
      Buffer.concat([Buffer.from([C.CMD_ESCAPE, C.CMD_RESTORE_SCREEN]), cookie]),
      0x80
    );
  }
}
