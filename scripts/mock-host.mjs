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
        this.text(14, 6, 0x28, 'CAUTION: mock host, no real IBM i behind this'),
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
        } else if (cmd) {
          this.sendError(`Command ${cmd} not known to mock host`, CMD_RMD);
          this.sendMain(user);
        } else {
          this.sendMain(user);
        }
        break;
      }

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
  const s = new HostSession(sock);
  console.log('[mock-host] client connected');
  sock.on('data', (chunk) => s.ingest(chunk));
  sock.on('close', () => console.log('[mock-host] client disconnected'));
  sock.on('error', (err) => console.log('[mock-host] socket error:', err.message));

  // RFC 2877 opening: NEW-ENVIRON + TERMINAL-TYPE, plus EOR/BINARY.
  s.telnet([DO, OPT_NEWENV, IAC, DO, OPT_TTYPE, IAC, DO, OPT_EOR, IAC, DO, OPT_BINARY]);
  s.telnet([WILL, OPT_EOR, IAC, WILL, OPT_BINARY]);
});

const BIND = process.env.MOCK_BIND ?? '127.0.0.1';
server.listen(PORT, BIND, () => {
  console.log(`[mock-host] listening on ${BIND}:${PORT}`);
});
