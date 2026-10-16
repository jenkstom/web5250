// Mock IBM i / AS/400 TN5250 server for local testing and demos.
//
// Implements the server side of the 5250 telnet interface (RFC 1205/2877
// negotiation, GDS record framing) and serves a small state machine:
//   QDSIGNON-like screen -> MAIN menu -> help window / SysReq window /
//   sign-off, including an error-code write (X II) for invalid sign-on and
// a non-display (password) field.
//
// Usage: node scripts/mock-host.mjs [port]     (default 8023)
import net from 'node:net';

const PORT = Number.parseInt(process.argv[2] ?? '8023', 10);

// ---------------------------------------------------------------- EBCDIC 037
const ASCII_TO_EBCDIC = {};
{
  // EBCDIC letters are NOT contiguous: A-I C1-C9, J-R D1-D9, S-Z E2-E9
  // (lowercase 81-89, 91-99, A2-A9).
  const add = (s, b1, b2, b3) => {
    for (let i = 0; i < s.length; i++) {
      const b = i < 9 ? b1 + i : i < 18 ? b2 + (i - 9) : b3 + (i - 18);
      ASCII_TO_EBCDIC[s[i]] = b;
    }
  };
  add('abcdefghijklmnopqrstuvwxyz', 0x81, 0x91, 0xa2);
  add('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 0xc1, 0xd1, 0xe2);
  for (let i = 0; i < 10; i++) ASCII_TO_EBCDIC[String(i)] = 0xf0 + i;
  const punct = {
    ' ': 0x40, '.': 0x4b, '<': 0x4c, '(': 0x4d, '+': 0x4e, '|': 0x4f,
    '&': 0x50, '!': 0x5a, '$': 0x5b, '*': 0x5c, ')': 0x5d, ';': 0x5e,
    '^': 0x5f, '-': 0x60, '/': 0x61, ',': 0x6b, '%': 0x6c, '_': 0x6d,
    '>': 0x6e, '?': 0x6f, ':': 0x7a, '@': 0x7c, "'": 0x7d, '=': 0x7e,
    '"': 0x7f, '#': 0x7b, '[': 0xad, ']': 0xbd
  };
  Object.assign(ASCII_TO_EBCDIC, punct);
}
const e = (s) => [...s].map((ch) => ASCII_TO_EBCDIC[ch] ?? 0x40);
const E2A = {};
for (const [ch, b] of Object.entries(ASCII_TO_EBCDIC)) E2A[b] = ch;

// ---------------------------------------------------------------- constants
const IAC = 0xff, DO = 0xfd, WILL = 0xfb, SB = 0xfa, SE = 0xf0, EOR = 0xef;
const OPT_BINARY = 0, OPT_TTYPE = 24, OPT_EOR = 25, OPT_NEWENV = 39;

const CMD_WTD = 0x11, CMD_CLEAR = 0x40, CMD_ERRCODE = 0x21;
const CMD_RIF = 0x42, CMD_RMD = 0x52;
const ORDER_SBA = 0x11, ORDER_IC = 0x13, ORDER_SF = 0x1d;

const AID_ENTER = 0xf1, AID_PF1 = 0x31, AID_PF3 = 0x33, AID_PF4 = 0x34, AID_PF6 = 0x36, AID_PF9 = 0x39, AID_PF12 = 0x3c;

// ---------------------------------------------------------------- session
class HostSession {
  constructor(sock) {
    this.sock = sock;
    this.dev = 'QPADEV0001';
    this.termType = '';
    this.state = 'signon';
    this.fields = [];
    this.fieldPos = []; // [row, col] per parsed MDT run (parallel to fields)
    this.currentFields = [];
    this.lastReadCmd = CMD_RIF;
    this.savedCookie = null; // device screen-image cookie (save/restore dialect)
    this.gotTtype = false;
    this.gotDevname = false;
    this.started = false;
    // MOCK_SIGNON_REJECT=1: refuse every sign-on like a real host does
    // (full QDSIGNON redraw with the error line, keyboard unlocked).
    this.rejectSignon = process.env.MOCK_SIGNON_REJECT === '1';
    // Printer-session swap (see onSubnegotiation / the server wrapper).
    this.printerDetected = false;
    this.handoff = [];
    // inbound state machine
    this.mode = 'data'; // data | iac | iac2 | sb | sbiac
    this.iacCmd = 0;
    this.recbits = [];
    this.sub = [];
  }

  log(...a) {
    console.log(`[mock-host ${this.dev}]`, ...a);
  }

  sendRaw(bytes) {
    if (!this.sock.destroyed) this.sock.write(Buffer.from(bytes));
  }

  telnet(seq) {
    this.sendRaw([IAC, ...seq]);
  }

  /** Build + send one GDS record carrying the given command streams. */
  record(opcode, ...streams) {
    const commands = streams.flat();
    const body = [0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, opcode, ...commands];
    const out = [((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff]; // RFC 1205: length counts itself
    for (const b of body) {
      if (b === IAC) out.push(IAC);
      out.push(b);
    }
    out.push(IAC, EOR);
    this.sendRaw(out);
  }

  esc(cmd, ...rest) {
    return [0x04, cmd, ...rest];
  }

  // -------------------------------------------------------- screen building
  wtd(cc1, orders) {
    return this.esc(CMD_WTD, 0x00, cc1, ...orders); // CC0=0: do not lock
  }

  text(row, col, attr, str) {
    const out = [ORDER_SBA, row, col];
    if (attr !== null) out.push(attr);
    out.push(...e(str));
    return out;
  }

  /**
   * @param len number of DATA positions (the SF length word counts data
   *            cells only; the attribute byte occupies its own cell).
   */
  field(row, col, attr, len) {
    return [ORDER_SBA, row, col, ORDER_SF, 0x40, 0x00, attr, (len >> 8) & 0xff, len & 0xff];
  }

  screen(definitions, cursor, readCmd = CMD_RIF) {
    const orders = definitions.flat();
    orders.push(ORDER_IC, cursor[0], cursor[1]);
    this.record(0x03, this.esc(CMD_CLEAR), this.wtd(0x20, orders), this.esc(readCmd, 0x00, 0x00));
    this.lastReadCmd = readCmd;
  }

  // ----------------------------------------------------------------- screens
  sendSignon(errorText) {
    this.state = 'signon';
    this.currentFields = [
      { row: 9, col: 44, len: 11 },
      { row: 10, col: 44, len: 11 },
      { row: 12, col: 44, len: 11 },
      { row: 14, col: 44, len: 11 },
      { row: 16, col: 44, len: 11 }
    ];
    const defs = [
      this.text(2, 27, 0x22, 'AS/400 Sign On'),
      this.text(4, 27, null, 'System  . . . . . . :  MOCK400'),
      this.text(5, 27, null, 'Subsystem  . . . . :  QINTER'),
      this.text(6, 27, null, 'Display  . . . . . :  ' + this.dev),
      this.text(9, 27, null, 'User  . . . . . .'),
      this.field(9, 44, 0x26, 11), // white/underscore (visible) — as the live QDSIGNON
      this.text(10, 27, null, 'Password . . . . .'),
      this.field(10, 44, 0x27, 11), // non-display (5494: X'27' is a true hidden attr)
      this.text(12, 27, null, 'Program/procedure'),
      this.field(12, 44, 0x20, 11),
      this.text(14, 27, null, 'Menu  . . . . . .'),
      this.field(14, 44, 0x20, 11),
      this.text(16, 27, null, 'Current library'),
      this.field(16, 44, 0x20, 11),
      this.text(22, 25, null, '(c) Copyright Mock Corp. 2026')
    ];
    if (errorText) defs.push(this.text(24, 1, 0x28, errorText));
    this.screen(defs, [9, 45]);
  }

  sendMain(user) {
    this.lastUser = user;
    this.state = 'main';
    this.currentFields = [{ row: 6, col: 25, len: 2 }, { row: 19, col: 25, len: 21 }];
    this.screen(
      [
        // Long reverse-video title bar, as on real IBM i menus: a wide
        // same-attribute run (the rendering case for seamless fills).
        this.text(1, 5, 0x21, 'Add On Systems Multi Vendor Messages'.padEnd(58, ' ')),
        this.text(2, 33, 0x22, 'MAIN'),
        // Reset the mouse-button table: programming is per screen on real
        // hosts (length 7 = table reset per the 5494 FR).
        [0x15, 0x00, 0x07, 0xd9, 0x55, 0x00, 0x00, 0x00],
        this.text(4, 29, 0x22, 'IBM i Main Menu'),
        this.text(6, 6, null, 'Selection . . . . .'),
        this.field(6, 25, 0x21, 2), // reverse video - exercises the underline cursor
        this.text(8, 6, null, '  1. User tasks'),
        this.text(9, 6, null, '  2. Office tasks'),
        this.text(10, 6, null, '  3. General system tasks'),
        this.text(11, 6, null, '  4. Work with demo items'),
        this.text(12, 6, null, '90. Sign off'),
        this.text(13, 6, null, '96. Open a web page on the PC (STRPCCMD)'),
        this.text(14, 6, null, '97. STRPCCMD with no URL'),
        this.text(15, 6, 0x28, 'CAUTION: mock host, no real IBM i behind this'),
        this.text(17, 6, null, 'Command line:'),
        this.field(19, 25, 0x20, 21),
        this.text(19, 47, null, '(unused)'),
        this.text(23, 4, 0x3a, 'F1=Help  F3=Exit  F4=Prompt'),
        this.text(24, 4, 0x22, `Signed on as ${user}`)
      ],
      [6, 26],
      CMD_RMD
    );
  }

  /**
   * STRPCCMD carrier, laid out the way tn5250j reads it back: the X'80'
   * order + 9-byte "PCO" magic (consumed as an order, then rewritten as
   * characters), filler up to plane offset 10, the wait flag at 11 ('a' =
   * WAIT(*NO)), the command at 12..134 (padded to 123 chars, the pre-V7R2
   * PCCMD limit). A read invite follows so the emulator's Enter completion
   * has a read to complete.
   */
  sendPcCommand(command, wait = true) {
    this.state = 'pccmd';
    this.currentFields = [];
    const PCO = [0xfc, 0xd7, 0xc3, 0xd6, 0x40, 0x83, 0x80, 0xa1, 0x80];
    const body = (wait ? 'b' : 'a') + command.padEnd(123, ' ');
    this.record(
      0x03,
      this.wtd(0x20, [
        ORDER_SBA, 1, 1,
        0x80, ...PCO,
        0x40, 0x40, // filler: flag lands on plane offset 11
        ...e(body),
        ORDER_IC, 1, 1
      ]),
      this.esc(CMD_RIF, 0x00, 0x00)
    );
    this.lastReadCmd = CMD_RIF;
  }

  /** WRK-style option list: one input field per line, walked with Up/Down. */
  sendList(status = '') {
    this.state = 'list';
    this.currentFields = [];
    // 5250 GUI mouse programming (5494 FR): flags 0x50 = move text cursor
    // to the click + marker bit, exactly as the live host programs its
    // screens. Right-down sends PF4 - the app's menu-open key; double-click
    // acts as F3.
    const MOUSE_SF = [
      0x15, 0x00, 0x0f, 0xd9, 0x55, 0x00, 0x00, 0x00,
      0x50, 0x04, 0x00, AID_PF4,
      0x50, 0x03, 0x00, AID_PF3
    ];
    const defs = [
      this.text(1, 30, 0x22, 'WORK WITH DEMO ITEMS'),
      this.text(3, 6, null, 'Type an option next to an item, press Enter.'),
      this.text(4, 6, 0x3a, '  2=Edit   5=Display'),
      this.text(6, 6, null, 'Opt  Item')
    ];
    for (let i = 0; i < 10; i++) {
      defs.push(this.field(7 + i, 7, 0x21, 2), this.text(7 + i, 12, null, `Demo item ${i + 1}`));
      this.currentFields.push({ row: 7 + i, col: 8, len: 2 });
    }
    defs.push(MOUSE_SF);
    defs.push(
      this.text(22, 6, 0x28, status),
      this.text(23, 6, 0x3a, 'F3=Exit  F6=Test window')
    );
    this.screen(defs, [7, 8], CMD_RMD);
  }

  /**
   * A window-only GUI popup (CREATE WINDOW without a DEFINE SELECTION
   * FIELD - the F4-prompt / confirmation-dialog case). The controller is
   * expected to draw the border and clear the work area (5494 FR 15-39):
   * the list behind must survive in the underlying screen and come back
   * when the window is removed (REMOVE GUI WINDOW only - no CLEAR).
   */
  sendPopupWindow() {
    this.state = 'window';
    this.currentFields = [{ row: 8, col: 24, len: 10 }];
    const WIN_SF = [
      0x15, 0x00, 0x41, 0xd9, 0x51,
      0x80, 0x00, 0x00, 5, 30, // restrict cursor, depth 5, width 30
      // border presentation: GUI characters, white; title left-justified,
      // footer centred (minor length = 6 + text length)
      0x05, 0x01, 0x80, 0x22, 0x22,
      0x14, 0x10, 0x80, 0x00, 0x00, 0x00, ...e('Confirm Delete'),
      0x1f, 0x10, 0x20, 0x00, 0x00, 0x00, ...e('Enter=Confirm  F12=Cancel')
    ];
    this.record(
      0x03,
      this.wtd(0x20, [
        ORDER_SBA, 5, 20, ...WIN_SF,
        ...this.text(6, 23, 0x28, 'Delete Demo item 1?'),
        ...this.text(7, 23, null, 'Type Y or N.'),
        ...this.field(8, 23, 0x21, 10),
        ORDER_IC, 8, 24
      ]),
      this.esc(CMD_RMD, 0x00, 0x00)
    );
    this.lastReadCmd = CMD_RMD;
  }

  /** Close the test window: REMOVE GUI WINDOW, status line, re-invite. */
  closePopupWindow(note) {
    this.state = 'list';
    this.currentFields = [];
    for (let i = 0; i < 10; i++) this.currentFields.push({ row: 7 + i, col: 8, len: 2 });
    this.log(`closing window: ${note}`);
    this.record(
      0x03,
      // REMOVE GUI WINDOW (5494 FR Table 15-16: length 7, flag + reserved)
      this.wtd(0x20, [0x15, 0x00, 0x07, 0xd9, 0x59, 0x00, 0x00, 0x00]),
      this.text(22, 6, 0x28, note),
      this.esc(CMD_RMD, 0x00, 0x00)
    );
    this.lastReadCmd = CMD_RMD;
  }

  /**
   * The live host's right-click menu dialect, captured from an ACS session:
   * acknowledge the mouse AID with a no-read WTD that inserts the cursor at
   * the click, then SAVE SCREEN with GDS opcode 04 - and wait. Nothing more
   * is written (no menu) until the device replies with its screen image
   * (opcode 04 record, X'04' X'12' <compressed cookie>).
   */
  beginMenuFlow(row, col) {
    this.state = 'await-image';
    this.menuPage = 0;
    this.pick = null;
    this.record(0x03, this.wtd(0x28, [ORDER_IC, row, col]));
    this.record(0x04, this.esc(0x02)); // save screen + image request
  }

  /**
   * The menu itself, drawn exactly like the live host (5494 FR): CREATE
   * WINDOW frame (WDSF D9/51) + "Select Option" title + DEFINE SELECTION
   * FIELD choice list (WDSF D9/50) + mouse programming + read invite.
   * F9 pages (the host re-sends the window and field); picks return as
   * Enter + [SBA(field+1)][2-byte choice number].
   */
  sendMenu(page = 0) {
    this.state = 'menu';
    this.menuPage = page;
    this.pick = null;
    this.currentFields = [];
    const items =
      page === 0
        ? ['1=Select item', '2=Update item', '3=Delete item', '4=Cancel item']
        : ['5=Tag item', '6=Untag item', '7=Export item', '8=Import item'];
    const textSize = 18;
    const winRow = 6;
    const winCol = 19;
    const fieldRow = winRow + 3; // live host: window (6,19), field (9,23)
    const fieldCol = winCol + 4;
    const MOUSE_SF = [
      0x15, 0x00, 0x0f, 0xd9, 0x55, 0x00, 0x00, 0x00,
      0x50, 0x03, 0x00, AID_ENTER, // left-double -> Enter (pick)
      0x50, 0x04, 0x00, AID_PF4
    ];
    const WIN_SF = [
      0x15, 0x00, 0x0e, 0xd9, 0x51,
      0x80, 0x00, 0x00, items.length + 2, textSize + 2,
      0x05, 0x01, 0x80, 0x22, 0x22 // border presentation minor: white
    ];
    const minors = [];
    for (const it of items) {
      minors.push(textSize + 5, 0x10, 0x00, 0x00, 0xe0, ...e(it.padEnd(textSize, ' ')));
    }
    const dsfBody = [
      0x02, 0x44, 0x00, 0x21, 0x01, 0x01, 0x02, 0x00, 0x00,
      textSize, items.length, 1, 0, 0x00, 0x00, 0x00,
      ...minors
    ];
    const dsfLen = dsfBody.length + 4;
    const DSF_SF = [0x15, (dsfLen >> 8) & 0xff, dsfLen & 0xff, 0xd9, 0x50, ...dsfBody];
    this.record(
      0x03,
      this.wtd(0x20, [
        ...MOUSE_SF,
        ORDER_SBA, winRow, winCol, ...WIN_SF,
        ORDER_SBA, winRow + 1, winCol + 2, 0x22, ...e('Select Option'),
        ORDER_SBA, fieldRow, fieldCol, ...DSF_SF,
        ORDER_SBA, 24, 6, 0x3a, ...e(page === 0 ? 'F9=Next page  F12=Cancel' : 'F9=Prev page  F12=Cancel')
      ]),
      this.esc(CMD_RMD, 0x00, 0x00)
    );
    this.lastReadCmd = CMD_RMD;
  }

  /** Menu done: replay the device's cookie (GDS opcode 05) and re-invite. */
  endMenuFlow(note) {
    this.state = 'list';
    this.currentFields = [];
    for (let i = 0; i < 10; i++) this.currentFields.push({ row: 7 + i, col: 8, len: 2 });
    if (this.savedCookie) {
      this.record(0x05, [0x04, 0x12, ...this.savedCookie]);
    } else {
      this.record(0x03, this.esc(0x12)); // classic restore, no cookie seen
    }
    this.record(
      0x03,
      this.wtd(0x20, [ORDER_SBA, 22, 6, 0x28, ...e(note ?? '')]),
      this.esc(CMD_RMD, 0x00, 0x00)
    );
    this.lastReadCmd = CMD_RMD;
  }

  sendHelp() {
    this.state = 'help';
    this.currentFields = [];
    this.screen(
      [
        this.text(8, 30, 0x22, 'Help'),
        this.text(10, 20, null, 'This is a mock help panel.'),
        this.text(11, 20, null, 'Press F3 (or any AID) to return.'),
        this.text(23, 4, 0x3a, 'F3=Return')
      ],
      [1, 1]
    );
  }

  sendSignoff(user) {
    this.state = 'signoff';
    this.currentFields = [];
    this.screen(
      [
        this.text(10, 25, 0x22, 'Sign off completed.'),
        this.text(12, 25, null, `Session for ${user} ended.`),
        this.text(14, 25, null, 'The mock host will disconnect shortly.')
      ],
      [1, 1]
    );
    setTimeout(() => this.sock.end(), 1500);
  }

  sendSystemRequest() {
    this.state = 'sysreq';
    this.currentFields = [];
    this.record(
      0x03,
      this.esc(0x02), // save screen
      this.wtd(0x20, [
        ORDER_SBA, 10, 25,
        0x22, ...e('System Request'),
        ORDER_SBA, 12, 25, ...e(' 1. Transfer to interactive job'),
        ORDER_SBA, 13, 25, ...e(' 2. End interactive job'),
        ORDER_SBA, 14, 25, ...e(' 3. Display system request menu'),
        ORDER_SBA, 15, 25, ...e(' 6. System request level 2'),
        ORDER_SBA, 17, 25, ...e(' Option:'),
        ORDER_SBA, 23, 20, 0x3a, ...e('F3=Exit without action')
      ]),
      this.esc(CMD_RMD, 0x00, 0x00)
    );
    this.lastReadCmd = CMD_RMD;
  }

  sendRestore() {
    this.state = 'main';
    this.currentFields = [{ row: 6, col: 25, len: 2 }, { row: 19, col: 25, len: 21 }];
    this.record(0x03, this.esc(0x12), this.esc(CMD_RMD, 0x00, 0x00)); // restore screen
    this.lastReadCmd = CMD_RMD;
  }

  sendError(text, readCmd = CMD_RIF) {
    // WRITE ERROR CODE: orders follow the command directly (no separate
    // WTD command / control bytes), matching tn5250j's reader.
    this.record(0x03, [
      0x04, CMD_ERRCODE,
      ORDER_SBA, 24, 1, 0x28, ...e(text),
      0x04, readCmd, 0x00, 0x00
    ]);
    this.lastReadCmd = readCmd;
  }

  // ------------------------------------------------------------- inbound FSM
  ingest(chunk) {
    for (const raw of chunk) {
      const b = raw & 0xff;
      // After a printer terminal type is seen, remaining bytes belong to the
      // printer session the wrapper swaps in; park them for the handoff.
      if (this.printerDetected) {
        this.handoff.push(b);
        continue;
      }
      switch (this.mode) {
        case 'data':
          if (b === IAC) this.mode = 'iac';
          else this.recbits.push(b);
          break;
        case 'iac':
          if (b === IAC) {
            this.recbits.push(IAC);
            this.mode = 'data';
          } else if (b === EOR) {
            const rec = Buffer.from(this.recbits);
            this.recbits = [];
            this.mode = 'data';
            this.onRecord(rec);
          } else if (b === SB) {
            this.sub = [];
            this.mode = 'sb';
          } else if (b === DO || b === 0xfc /*WONT*/ || b === 0xfe /*DONT*/) {
            this.iacCmd = b;
            this.mode = 'iac2';
          } else if (b === WILL) {
            this.iacCmd = b;
            this.mode = 'iac2';
          } else {
            this.mode = 'data'; // NOP/GA/etc
          }
          break;
        case 'iac2':
          this.onWill(this.iacCmd, b);
          this.mode = 'data';
          break;
        case 'sb':
          if (b === IAC) this.mode = 'sbiac';
          else this.sub.push(b);
          break;
        case 'sbiac':
          if (b === IAC) {
            this.sub.push(IAC);
            this.mode = 'sb';
          } else if (b === SE) {
            this.onSubnegotiation(Buffer.from(this.sub));
            this.mode = 'data';
          } else {
            this.mode = 'sb';
          }
          break;
      }
    }
  }

  confirmed = new Set();

  onWill(cmd, opt) {
    if (cmd !== WILL) return;
    if (this.confirmed.has(opt)) return; // already enabled; don't echo (RFC 854)
    if (opt === OPT_TTYPE || opt === OPT_EOR || opt === OPT_BINARY || opt === OPT_NEWENV) {
      this.confirmed.add(opt);
      this.telnet([DO, opt]);
    }
    if (opt === OPT_TTYPE) {
      this.telnet([SB, OPT_TTYPE, 1, IAC, SE]); // ask for TERMINAL-TYPE IS
    }
    if (opt === OPT_NEWENV) {
      this.telnet([SB, OPT_NEWENV, 1, IAC, SE]); // ask for DEVNAME
    }
    this.maybeStart();
  }

  onSubnegotiation(payload) {
    if (payload.length < 2) return;
    if (payload[0] === OPT_TTYPE && payload[1] === 0) {
      this.termType = payload.subarray(2).toString('ascii');
      this.gotTtype = true;
      // A printer terminal type swaps this connection to a printer session
      // (the host creates a *SCS printer device instead of a display).
      if (/^IBM-(3812|5553)/.test(this.termType)) {
        this.printerDetected = true;
        this.onPrinter?.();
        return;
      }
      this.maybeStart();
    }
    if (payload[0] === OPT_NEWENV && payload[1] === 0) {
      const ascii = payload.toString('ascii');
      const m = /DEVNAME\x01([A-Z0-9#$@_]+)/.exec(ascii);
      if (m) this.dev = m[1];
      this.gotDevname = true;
      this.maybeStart();
    }
  }

  maybeStart() {
    if (this.started || !this.gotTtype) return;
    this.started = true;
    this.log(`terminal=${this.termType} devname=${this.dev}`);
    setTimeout(() => {
      // WSF query, then the sign-on screen.
      this.record(0x03, this.esc(0xf3, 0x00, 0x05, 0xd9, 0x70, 0x00));
      this.sendSignon();
    }, 30);
  }

  onRecord(rec) {
    if (rec.length < 10) return;
    const opcode = rec[9];
    if (opcode === 4) {
      // Device screen-image reply (save/restore dialect): X'04' X'12' <cookie>.
      if (rec[10] === 0x04 && rec[11] === 0x12) {
        this.savedCookie = rec.subarray(12);
        this.log(`save-image cookie: ${this.savedCookie.length} bytes, head ${this.savedCookie.subarray(0, 2).toString('hex')}`);
        if (this.state === 'await-image') this.sendMenu();
      } else {
        this.log(`unexpected opcode-04 record: ${rec.subarray(10, 16).toString('hex')}`);
      }
      return;
    }
    if (opcode !== 3) return;
    const flags = rec[7];
    let p = 10;
    if (p + 3 > rec.length) return;
    const row = rec[p], col = rec[p + 1], aid = rec[p + 2];
    p += 3;

    if (flags & 0x04) {
      this.log('client pressed SysReq');
      if (this.state === 'signon') this.sendError('System request not allowed at sign on');
      else this.sendSystemRequest();
      return;
    }
    if (flags & 0x40) {
      this.log('client pressed Attn');
      this.sendError('Attention received by mock host');
      return;
    }

    this.fields = [];
    this.pick = null;
    // Selection-field pick (5494 FR): [SBA][field row][field col + 1]
    // followed by the 2-byte choice number (0 = dismissed, no choice) -
    // and nothing else; a regular Enter carries ordinary field data.
    if (
      this.state === 'menu' &&
      aid === AID_ENTER &&
      rec[p] === ORDER_SBA &&
      p + 5 === rec.length
    ) {
      const pr = rec[p + 1];
      const pc = rec[p + 2];
      this.pick = (rec[p + 3] << 8) | rec[p + 4];
      this.log(`selection pick: choice=${this.pick} field=${pr},${pc} cursor=${row},${col}`);
      p += 5;
    }
    if (this.lastReadCmd === CMD_RIF) {
      // RIF: every input field, full width (attr cell excluded), in order.
      for (const f of this.currentFields) {
        let s = '';
        for (let i = 0; i < f.len && p < rec.length; i++, p++) s += E2A[rec[p]] ?? ' ';
        this.fields.push(s.trim());
      }
    } else {
      this.fieldPos = [];
      while (p + 3 <= rec.length && rec[p] === ORDER_SBA) {
        const fr = rec[p + 1];
        const fc = rec[p + 2];
        p += 3;
        let s = '';
        while (p < rec.length && rec[p] !== ORDER_SBA) {
          s += E2A[rec[p]] ?? ' ';
          p++;
        }
        this.fields.push(s.replace(/[ ]+$/, ''));
        this.fieldPos.push([fr, fc]);
      }
    }

    this.log(`AID=0x${aid.toString(16)} cursor=${row},${col} fields=${JSON.stringify(this.fields)}`);
    this.onAid(aid, row, col);
  }

  onAid(aid, row, col) {
    const [user = '', password = ''] = this.state === 'signon' ? this.fields : [];

    switch (this.state) {
      case 'signon':
        if (aid === AID_ENTER) {
          if (this.rejectSignon) {
            this.sendSignon('Sign on information not valid; try again.');
          } else if (!user || !password) {
            this.sendError('Sign on information not valid; try again.');
          } else {
            this.sendMain(user);
          }
        } else {
          this.sendError(`Function key not valid on sign on (AID 0x${aid.toString(16)}).`);
        }
        break;

      case 'main': {
        const [sel = '', cmd = ''] = this.fields;
        if (aid === AID_PF3 || sel.trim() === '90') {
          this.sendSignoff(user || 'USER');
        } else if (aid === AID_PF1) {
          this.sendHelp();
        } else if (sel.trim() === '4') {
          this.sendList();
        } else if (sel.trim() === '96') {
          this.sendPcCommand('start http://mock.example/report?from=menu', true);
        } else if (sel.trim() === '97') {
          this.sendPcCommand('rundll32 url.dll,FileProtocolHandler notepad.exe', false);
        } else if (cmd) {
          this.sendError(`Command ${cmd} not known to mock host`, CMD_RMD);
          this.sendMain(user);
        } else {
          this.sendMain(user);
        }
        break;
      }

      case 'pccmd':
        // The emulator's Enter completion (WAIT(*YES)) lands here.
        this.sendMain(this.lastUser);
        break;

      case 'help':
        this.sendMain(this.lastUser);
        break;

      case 'list': {
        if (aid === AID_PF4) {
          // Host-programmed right-click: open the menu dialect flow.
          this.beginMenuFlow(row, col);
          break;
        }
        if (aid === AID_PF6) {
          this.sendPopupWindow();
          break;
        }
        if (aid === AID_PF3) {
          this.sendMain(this.lastUser);
          break;
        }
        const idx = this.fields.findIndex((v) => v.trim() !== '');
        if (aid === AID_ENTER && idx >= 0) {
          const line = (this.fieldPos[idx]?.[0] ?? 7) - 6;
          this.sendList(`Option ${this.fields[idx].trim()} entered on line ${line}.`);
        } else {
          this.sendList();
        }
        break;
      }

      case 'window': {
        // Any AID closes the test window; the typed text shows the field
        // made it through the popup read.
        const answer = this.fields[0]?.trim() ?? '';
        this.closePopupWindow(
          `Window closed (answer "${answer || 'none'}").`
        );
        break;
      }

      case 'menu': {
        // F9 pages the choice list (host re-sends window + field, exactly
        // like the live host's paginated menus).
        if (aid === AID_PF9) {
          this.sendMenu(1 - (this.menuPage ?? 0));
          break;
        }
        // Any committing key ends the menu; Enter carries the pick number.
        this.endMenuFlow(
          aid === AID_ENTER
            ? `Menu pick ${this.pick ?? 0} processed.`
            : 'Menu cancelled.'
        );
        break;
      }

      case 'sysreq':
        this.sendRestore();
        break;

      default:
        break;
    }
  }
}

// ------------------------------------------------------------------ server
const server = net.createServer((sock) => {
  const display = new HostSession(sock);
  let session = display;
  // IBM-3812-1 terminal type: the connection becomes a printer session.
  // The swap happens mid-chunk (right after TTYPE IS), so bytes the display
  // session parked after the detection point are handed over once its
  // ingest() returns.
  display.onPrinter = () => {
    console.log('[mock-host] printer session (terminal ' + display.termType + ')');
    // The display phase may already have consumed NEW-ENVIRON IS (DEVNAME)
    // - the host asks NEW-ENVIRON before TERMINAL-TYPE - so carry it over.
    session = new PrinterHostSession(sock, display.termType, display.dev, display.gotDevname);
  };
  console.log('[mock-host] client connected');
  sock.on('data', (chunk) => {
    session.ingest(chunk);
    if (session !== display && display.handoff.length) {
      session.ingest(Buffer.from(display.handoff));
      display.handoff = [];
    }
  });
  sock.on('close', () => console.log('[mock-host] client disconnected'));
  sock.on('error', (err) => console.log('[mock-host] socket error:', err.message));

  // RFC 2877 opening: NEW-ENVIRON + TERMINAL-TYPE, plus EOR/BINARY.
  display.telnet([DO, OPT_NEWENV, IAC, DO, OPT_TTYPE, IAC, DO, OPT_EOR, IAC, DO, OPT_BINARY]);
  display.telnet([WILL, OPT_EOR, IAC, WILL, OPT_BINARY]);
});

// ------------------------------------------------------------- printer host
// Server side of a TN5250E printer session (RFC 4777 section 11): startup
// response record, then canned SCS jobs that exercise the client - record
// ACKs, jobs split across records and TCP segments, the null end-of-job
// record (with and without the optional trailing zero), Clear Print
// Buffers, a name collision, and raw (host-print-transform) output.
//
// Env knobs: MOCK_PRINT_JOBS (count, default 2), MOCK_PRINT_MODE
// (text|raw, default text), MOCK_PRINT_STARTUP (response code, default
// I902), MOCK_PRINT_DEV_INUSE=1 (re-ask DEVNAME = collision),
// MOCK_PRINT_CLEAR=1 (clear the first job's buffers mid-stream).
class PrinterHostSession {
  constructor(sock, termType, dev = 'WEB5250P', gotDevname = false) {
    this.sock = sock;
    this.termType = termType;
    this.dev = dev;
    this.gotDevname = gotDevname;
    this.reaskedDevname = false;
    this.confirmed = new Set();
    this.started = false;
    this.jobs = Math.max(0, Number.parseInt(process.env.MOCK_PRINT_JOBS ?? '2', 10) || 0);
    this.rawMode = process.env.MOCK_PRINT_MODE === 'raw';
    this.startupCode = process.env.MOCK_PRINT_STARTUP ?? 'I902';
    this.devInUse = process.env.MOCK_PRINT_DEV_INUSE === '1';
    this.clearMidJob = process.env.MOCK_PRINT_CLEAR === '1';
    this.outQueue = []; // record-fns pieces awaiting their turn (ACK-driven)
    // inbound FSM (same shape as the display session's)
    this.fsm = 'data';
    this.iacCmd = 0;
    this.recbits = [];
    this.sub = [];
    // DEVNAME may already have been collected by the display phase.
    if (this.gotDevname) setTimeout(() => this.maybeStart(), 0);
  }

  log(...a) {
    console.log(`[mock-print ${this.dev}]`, ...a);
  }

  sendRaw(bytes) {
    if (!this.sock.destroyed) this.sock.write(Buffer.from(bytes));
  }

  telnet(seq) {
    this.sendRaw([IAC, ...seq]);
  }

  /** One GDS record with an explicit flow / LL / flags / opcode / diag+data. */
  buildGds(flowHi, flowLo, ll, flags, opcode, data = []) {
    const header = [0x12, 0xa0, flowHi, flowLo, ll, (flags >> 8) & 0xff, flags & 0xff, opcode];
    const diag = new Array(Math.max(0, ll - 4)).fill(0); // bytes 10..6+LL-1
    const body = [...header, ...diag, ...data];
    const out = [((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff];
    for (const b of body) {
      if (b === IAC) out.push(IAC);
      out.push(b);
    }
    out.push(IAC, EOR);
    return out;
  }

  gds(flowHi, flowLo, ll, flags, opcode, data) {
    this.sendRaw(this.buildGds(flowHi, flowLo, ll, flags, opcode, data));
  }

  /** Same record, delivered as two TCP segments 40 ms apart (framing stress). */
  gdsSegmented(ll, flags, opcode, data) {
    const out = this.buildGds(0x01, 0x01, ll, flags, opcode, data);
    const half = Math.ceil(out.length / 2);
    this.sock.write(Buffer.from(out.slice(0, half)));
    setTimeout(() => this.sendRaw(out.slice(half)), 40);
  }

  /** Startup response (RFC 4777 section 4 example shape, length 0x49). */
  sendStartup(code) {
    const sysname = e('MOCK400').concat(new Array(8).fill(0x40)).slice(0, 8);
    const objname = e('PCPRINTER').concat(new Array(10).fill(0x40)).slice(0, 10);
    const body = [
      0x12, 0xa0, 0x90, 0x00, 0x05, 0x60, 0x06, 0x00, 0x20, 0xc0, 0x00, 0x3d, 0x00, 0x00,
      ...e(code), ...sysname, ...objname,
      ...new Array(73 - 16 - 4 - 8 - 10).fill(0)
    ];
    const out = [((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff];
    for (const b of body) {
      if (b === IAC) out.push(IAC);
      out.push(b);
    }
    out.push(IAC, EOR);
    this.sendRaw(out);
    this.log(`startup response ${code}`);
  }

  // ------------------------------------------------------------- job bytes
  textJob(i) {
    const NL = 0x25, FF = 0x0c;
    const line = (s) => e(s).concat([NL]);
    return [
      ...line(`MOCK400 SPOOL REPORT ${String(i + 1).padStart(3, '0')}`),
      ...line('Printed by the web5250 mock host'),
      ...line('Line three has some words to extract'),
      ...e('Column A').concat(e(' '.repeat(4))).concat(e('Column B')).concat([NL]),
      FF,
      ...line(`REPORT ${i + 1} PAGE 2`),
      ...line('Second page content'),
      NL
    ];
  }

  rawJob(i) {
    return [
      ...Buffer.from(`%PDF-1.4\n% mock-host job ${i + 1}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\ntrailer<<>>\n%%EOF\n`, 'latin1')
    ];
  }

  /**
   * Enqueue one job: split into records exercising the framing rules, then
   * the null end-of-job record. Records are sent one at a time, each only
   * after the client's print-complete ACK (the RFC's end-to-end rhythm).
   */
  enqueueJob(i) {
    const bytes = this.rawMode ? this.rawJob(i) : this.textJob(i);
    const mid = Math.floor(bytes.length / 2);
    // Job 0 = single-record job (first+last of chain); later jobs arrive as
    // two records (first-of-chain, last-of-chain) - and job 1's last record
    // is additionally split across TCP segments.
    const chunks = i === 0 ? [bytes] : [bytes.slice(0, mid), bytes.slice(mid)];
    chunks.forEach((chunk, idx) => {
      let flags = 0x0000;
      if (chunks.length === 1) flags = 0x1800;
      else if (idx === 0) flags = 0x1000;
      else flags = 0x0800;
      const segmented = i === 1 && idx === chunks.length - 1;
      this.outQueue.push(() => {
        if (segmented) this.gdsSegmented(0x0a, flags, 0x01, chunk);
        else this.gds(0x01, 0x01, 0x0a, flags, 0x01, chunk);
        if (this.clearMidJob && i === 0 && idx === 0) {
          // Clear Print Buffers right after the first record: the client
          // must drop the partial job and not ACK this record.
          this.log('sending Clear Print Buffers mid-job');
          this.gds(0x01, 0x01, 0x0a, 0x1800, 0x02, []);
        }
      });
    });
    // Null end-of-job record; alternate the optional trailing zero byte.
    const trailing = i % 2 === 0 ? [0x00] : [];
    this.outQueue.push(() => {
      this.gds(0x01, 0x01, 0x0a, 0x0800, 0x01, trailing);
      this.log(`job ${i + 1}: null end-of-job record (${trailing.length ? 'with' : 'without'} trailing 00)`);
    });
  }

  sendNext() {
    const next = this.outQueue.shift();
    if (!next) return;
    next();
  }

  // ------------------------------------------------------------- negotiation
  ingest(chunk) {
    for (const raw of chunk) {
      const b = raw & 0xff;
      switch (this.fsm) {
        case 'data':
          if (b === IAC) this.fsm = 'iac';
          else this.recbits.push(b);
          break;
        case 'iac':
          if (b === IAC) {
            this.recbits.push(IAC);
            this.fsm = 'data';
          } else if (b === EOR) {
            const rec = Buffer.from(this.recbits);
            this.recbits = [];
            this.fsm = 'data';
            this.onRecord(rec);
          } else if (b === SB) {
            this.sub = [];
            this.fsm = 'sb';
          } else if (b === DO || b === 0xfc || b === 0xfe || b === WILL) {
            this.iacCmd = b;
            this.fsm = 'iac2';
          } else {
            this.fsm = 'data';
          }
          break;
        case 'iac2':
          if (this.iacCmd === WILL && !this.confirmed.has(b) &&
              (b === OPT_TTYPE || b === OPT_EOR || b === OPT_BINARY || b === OPT_NEWENV)) {
            this.confirmed.add(b);
            this.telnet([DO, b]);
          }
          this.fsm = 'data';
          break;
        case 'sb':
          if (b === IAC) this.fsm = 'sbiac';
          else this.sub.push(b);
          break;
        case 'sbiac':
          if (b === IAC) {
            this.sub.push(IAC);
            this.fsm = 'sb';
          } else if (b === SE) {
            this.onSubnegotiation(Buffer.from(this.sub));
            this.fsm = 'data';
          } else {
            this.fsm = 'sb';
          }
          break;
      }
    }
  }

  onSubnegotiation(payload) {
    if (payload.length < 2) return;
    if (payload[0] === OPT_NEWENV && payload[1] === 0) {
      const m = /DEVNAME\x01([A-Z0-9#$@_]+)/.exec(payload.toString('ascii'));
      if (m) this.dev = m[1];
      this.gotDevname = true;
      this.maybeStart();
    }
  }

  maybeStart() {
    if (this.started || !this.gotDevname) return;
    this.started = true;
    this.log(`printer session devname=${this.dev} mode=${this.rawMode ? 'raw' : 'text'} jobs=${this.jobs}`);
    // Name collision: the host re-asks DEVNAME (RFC 2877). A printer client
    // must NOT auto-rename, so it stays silent and reports the collision.
    if (this.devInUse && !this.reaskedDevname) {
      this.reaskedDevname = true;
      this.log('DEVNAME in use: re-asking (collision path)');
      this.telnet([SB, OPT_NEWENV, 1, IAC, SE]);
      return;
    }
    setTimeout(() => {
      this.sendStartup(this.startupCode);
      if (!/^[I]9(01|02|06)$/.test(this.startupCode)) {
        this.log('startup refused: no jobs will flow');
        return;
      }
      for (let i = 0; i < this.jobs; i++) this.enqueueJob(i);
      setTimeout(() => this.sendNext(), 100);
    }, 50);
  }

  onRecord(rec) {
    if (rec.length < 10) return;
    const flow = (rec[4] << 8) | rec[5];
    // Print-complete ACK: 0102 (RFC 4777) or 0012 (classic tn5250).
    if (flow === 0x0102 || flow === 0x0012) {
      this.log(`print-complete ACK (flow ${flow.toString(16)})`);
      setTimeout(() => this.sendNext(), 30);
      return;
    }
    this.log(`unexpected record: ${rec.subarray(0, 12).toString('hex')}`);
  }
}

const BIND = process.env.MOCK_BIND ?? '127.0.0.1';
server.listen(PORT, BIND, () => {
  console.log(`[mock-host] listening on ${BIND}:${PORT}`);
});
