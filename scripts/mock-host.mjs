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

const AID_ENTER = 0xf1, AID_PF1 = 0x31, AID_PF3 = 0x33;

// ---------------------------------------------------------------- session
class HostSession {
  constructor(sock) {
    this.sock = sock;
    this.dev = 'QPADEV0001';
    this.termType = '';
    this.state = 'signon';
    this.fields = [];
    this.currentFields = [];
    this.lastReadCmd = CMD_RIF;
    this.gotTtype = false;
    this.gotDevname = false;
    this.started = false;
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
    const out = [(body.length >> 8) & 0xff, body.length & 0xff];
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
   * @param len number of DATA positions (the SF length word counts the
   *            attribute cell too, so we send len + 1).
   */
  field(row, col, attr, len) {
    const total = len + 1;
    return [ORDER_SBA, row, col, ORDER_SF, 0x40, 0x00, attr, (total >> 8) & 0xff, total & 0xff];
  }

  screen(definitions, cursor, readCmd = CMD_RIF) {
    const orders = definitions.flat();
    orders.push(ORDER_IC, cursor[0], cursor[1]);
    this.record(0x03, this.esc(CMD_CLEAR), this.wtd(0x20, orders), this.esc(readCmd, 0x00, 0x00));
    this.lastReadCmd = readCmd;
  }

  // ----------------------------------------------------------------- screens
  sendSignon() {
    this.state = 'signon';
    this.currentFields = [
      { row: 9, col: 44, len: 11 },
      { row: 10, col: 44, len: 11 },
      { row: 12, col: 44, len: 11 },
      { row: 14, col: 44, len: 11 },
      { row: 16, col: 44, len: 11 }
    ];
    this.screen(
      [
        this.text(2, 27, 0x22, 'AS/400 Sign On'),
        this.text(4, 27, null, 'System  . . . . . . :  MOCK400'),
        this.text(5, 27, null, 'Subsystem  . . . . :  QINTER'),
        this.text(6, 27, null, 'Display  . . . . . :  ' + this.dev),
        this.text(9, 27, null, 'User  . . . . . .'),
        this.field(9, 44, 0x20, 11),
        this.text(10, 27, null, 'Password . . . . .'),
        this.field(10, 44, 0x24, 11), // non-display
        this.text(12, 27, null, 'Program/procedure'),
        this.field(12, 44, 0x20, 11),
        this.text(14, 27, null, 'Menu  . . . . . .'),
        this.field(14, 44, 0x20, 11),
        this.text(16, 27, null, 'Current library'),
        this.field(16, 44, 0x20, 11),
        this.text(22, 25, null, '(c) Copyright Mock Corp. 2026')
      ],
      [9, 45]
    );
  }

  sendMain(user) {
    this.lastUser = user;
    this.state = 'main';
    this.currentFields = [{ row: 6, col: 25, len: 2 }, { row: 19, col: 25, len: 21 }];
    this.screen(
      [
        this.text(2, 33, 0x22, 'MAIN'),
        this.text(4, 29, 0x22, 'IBM i Main Menu'),
        this.text(6, 6, null, 'Selection . . . . .'),
        this.field(6, 25, 0x20, 2),
        this.text(8, 6, null, '  1. User tasks'),
        this.text(9, 6, null, '  2. Office tasks'),
        this.text(10, 6, null, '  3. General system tasks'),
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
    if (this.lastReadCmd === CMD_RIF) {
      // RIF: every input field, full width (attr cell excluded), in order.
      for (const f of this.currentFields) {
        const dataLen = f.len - 1;
        let s = '';
        for (let i = 0; i < dataLen && p < rec.length; i++, p++) s += E2A[rec[p]] ?? ' ';
        this.fields.push(s.trim());
      }
    } else {
      while (p + 3 <= rec.length && rec[p] === ORDER_SBA) {
        p += 3;
        let s = '';
        while (p < rec.length && rec[p] !== ORDER_SBA) {
          s += E2A[rec[p]] ?? ' ';
          p++;
        }
        this.fields.push(s.replace(/[ ]+$/, ''));
      }
    }

    this.log(`AID=0x${aid.toString(16)} cursor=${row},${col} fields=${JSON.stringify(this.fields)}`);
    this.onAid(aid);
  }

  onAid(aid) {
    const [user = '', password = ''] = this.state === 'signon' ? this.fields : [];

    switch (this.state) {
      case 'signon':
        if (aid === AID_ENTER) {
          if (!user || !password) {
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
