// Realistic IBM i QDSIGNON host: byte-shape faithful to what a real IBM i
// sends (unlike mock-host.mjs, which speaks a simplified dialect):
//   - WTD CC0=0x40 (keyboard lock + reset MDT) — real hosts lock on write
//   - SF orders WITHOUT field format words: <attr> <lenHi> <lenLo>
//     (attr bytes 0x20-0x3F never carry 0x40, the FFW "extended" bit)
//   - attribute bytes re-asserted before text runs (color banding)
//   - password field attr 0x24 (non-display) written mid-screen, with
//     plain text (logo/warning) written AFTER it
//   - IC at first input cell, then READ INPUT FIELDS invite
//   - on AID with field data: replies WRITE ERROR CODE (CPF-style row 24)
// Usage: node scripts/real-signon-host.mjs [port]
import net from 'node:net';

const PORT = Number.parseInt(process.argv[2] ?? '18033', 10);

// EBCDIC 037 (same table as mock-host)
const A2E = {};
{
  const add = (s, b1, b2, b3) => {
    for (let i = 0; i < s.length; i++) {
      const b = i < 9 ? b1 + i : i < 18 ? b2 + (i - 9) : b3 + (i - 18);
      A2E[s[i]] = b;
    }
  };
  add('abcdefghijklmnopqrstuvwxyz', 0x81, 0x91, 0xa2);
  add('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 0xc1, 0xd1, 0xe2);
  for (let i = 0; i < 10; i++) A2E[String(i)] = 0xf0 + i;
  const punct = {
    ' ': 0x40, '.': 0x4b, '<': 0x4c, '(': 0x4d, '+': 0x4e, '|': 0x4f,
    '&': 0x50, '!': 0x5a, '$': 0x5b, '*': 0x5c, ')': 0x5d, ';': 0x5e,
    '^': 0x5f, '-': 0x60, '/': 0x61, ',': 0x6b, '%': 0x6c, '_': 0x6d,
    '>': 0x6e, '?': 0x6f, ':': 0x7a, '@': 0x7c, "'": 0x7d, '=': 0x7e,
    '"': 0x7f, '#': 0x7b, '[': 0xad, ']': 0xbd
  };
  Object.assign(A2E, punct);
}
const e = (s) => [...s].map((ch) => A2E[ch] ?? 0x40);
const E2A = {};
for (const [ch, b] of Object.entries(A2E)) E2A[b] = ch;

const IAC = 0xff, DO = 0xfd, WILL = 0xfb, SB = 0xfa, SE = 0xf0, EOR = 0xef;
const OPT_BINARY = 0, OPT_TTYPE = 24, OPT_EOR = 25, OPT_NEWENV = 39;

const CMD_CLEAR = 0x40, CMD_WTD = 0x11, CMD_RIF = 0x42, CMD_ERRCODE = 0x21;
const ORDER_SBA = 0x11, ORDER_IC = 0x13, ORDER_SF = 0x1d;

const LOGO = [
  '          **          *******     ********  ',
  '        ****        **//////**   **//////** ',
  '       **//**      **      //**  **     ////',
  '      **  //**     /**         /**         ',
  '     **********    /**         /**   *********',
  '    /**///////**   //**    **  /**   ///////**',
  '    /**     /**     //******   /**         /**',
  '    //      //       //////    ////////  //////'
];

class Session {
  constructor(sock) {
    this.sock = sock;
    this.dev = 'PANG_CZS2I';
    this.mode = 'data';
    this.iacCmd = 0;
    this.recbits = [];
    this.sub = [];
    this.started = false;
    this.gotTtype = false;
    this.confirmed = new Set();
    this.failures = 0;
  }

  sendRaw(bytes) {
    if (!this.sock.destroyed) this.sock.write(Buffer.from(bytes));
  }
  telnet(seq) {
    this.sendRaw([IAC, ...seq]);
  }
  record(...streams) {
    const commands = streams.flat();
    const body = [0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, 0x03, ...commands];
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

  text(row, col, attr, str) {
    const out = [ORDER_SBA, row, col];
    if (attr !== null) out.push(attr);
    out.push(...e(str));
    return out;
  }

  /** Real hosts: SBA, SF, attr, lenHi, lenLo (no FFW bytes). len = data cells. */
  field(row, col, attr, dataLen) {
    return [ORDER_SBA, row, col, ORDER_SF, attr, (dataLen >> 8) & 0xff, dataLen & 0xff];
  }

  sendSignon() {
    const orders = [
      this.text(2, 36, 0x22, 'SIGN ON'),
      this.text(4, 30, 0x20, 'SYSTEM   . . . . . . :  DEMOCLOUD'),
      this.text(5, 30, null, 'SUBSYSTEM . . . . :  QINTER'),
      this.text(6, 30, null, 'DISPLAY . . . . . :  ' + this.dev),
      this.text(7, 30, null, 'User'),
      this.field(7, 52, 0x20, 10),
      this.text(8, 30, null, 'Password'),
      this.field(8, 52, 0x24, 10), // non-display
      ...LOGO.map((l, i) => this.text(11 + i, 12, i < 1 ? 0x28 : null, l)),
      this.text(19, 50, 0x3c, 'DEMO CLOUD'),
      this.text(21, 7, 0x28, 'WARNING - ACCESS TO THIS COMPUTER MUST BE GRANTED BY ADD ON SYSTEMS.'),
      this.text(22, 7, null, 'UNAUTHORIZED ACCESS IS A CRIMINAL OFFENSE AND WILL BE PROSECUTED TO THE'),
      this.text(23, 7, null, 'FULLEST EXTENT THAT THE LAW ALLOWS.'),
      this.text(23, 60, 0x20, '(C) COPYRIGHT IBM CORP.')
    ].flat();
    orders.push(ORDER_IC, 7, 53);
    // One record: CLEAR UNIT | WTD(cc0=0x40 lock+resetMDT, cc1) | RIF invite
    this.record(
      this.esc(CMD_CLEAR),
      this.esc(CMD_WTD, 0x40, 0x20, ...orders),
      this.esc(CMD_RIF, 0x00, 0x00)
    );
  }

  sendError(msg) {
    this.record([
      0x04, CMD_ERRCODE,
      ORDER_SBA, 24, 1, 0x28, ...e(msg),
      0x04, CMD_RIF, 0x00, 0x00
    ]);
  }

  // ---- inbound telnet/record framing (same FSM as mock-host) ----
  ingest(chunk) {
    for (const raw of chunk) {
      const b = raw & 0xff;
      switch (this.mode) {
        case 'data':
          if (b === IAC) this.mode = 'iac';
          else this.recbits.push(b);
          break;
        case 'iac':
          if (b === IAC) { this.recbits.push(IAC); this.mode = 'data'; }
          else if (b === EOR) {
            const rec = Buffer.from(this.recbits);
            this.recbits = [];
            this.mode = 'data';
            this.onRecord(rec);
          } else if (b === SB) { this.sub = []; this.mode = 'sb'; }
          else if (b === DO || b === WILL || b === 0xfc || b === 0xfe) {
            this.iacCmd = b; this.mode = 'iac2';
          } else this.mode = 'data';
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
          if (b === IAC) { this.sub.push(IAC); this.mode = 'sb'; }
          else if (b === SE) { this.onSub(Buffer.from(this.sub)); this.mode = 'data'; }
          else this.mode = 'sb';
          break;
      }
    }
  }

  onWill(cmd, opt) {
    if (cmd !== WILL) return;
    if (this.confirmed.has(opt)) return;
    if ([OPT_TTYPE, OPT_EOR, OPT_BINARY, OPT_NEWENV].includes(opt)) {
      this.confirmed.add(opt);
      this.telnet([DO, opt]);
    }
    if (opt === OPT_TTYPE) this.telnet([SB, OPT_TTYPE, 1, IAC, SE]);
    if (opt === OPT_NEWENV) this.telnet([SB, OPT_NEWENV, 1, IAC, SE]);
    this.maybeStart();
  }

  onSub(payload) {
    if (payload.length < 2) return;
    if (payload[0] === OPT_TTYPE && payload[1] === 0) {
      this.gotTtype = true;
      this.maybeStart();
    }
  }

  maybeStart() {
    if (this.started || !this.gotTtype) return;
    this.started = true;
    console.log('[real-signon] starting, sending QDSIGNON');
    setTimeout(() => this.sendSignon(), 30);
  }

  onRecord(rec) {
    if (rec.length < 10) return;
    const flags = rec[7];
    let p = 10;
    if (p + 3 > rec.length) return;
    const row = rec[p], col = rec[p + 1], aid = rec[p + 2];
    p += 3;
    const fields = [];
    // RIF response: every field full width, attr excluded, in order
    for (let i = 0; i < 2; i++) {
      let s = '';
      for (let k = 0; k < 10 && p < rec.length; k++, p++) s += E2A[rec[p]] ?? ' ';
      fields.push(s.trimEnd());
    }
    console.log(`[real-signon] AID=0x${aid.toString(16)} cursor=${row},${col} fields=${JSON.stringify(fields)}`);
    if (aid === 0xf1) {
      const [user, pw] = fields;
      if (!user || !pw) {
        this.failures++;
        if (this.failures >= 2) {
          console.log('[real-signon] host would CPF1296 + drop; ending');
          this.sock.end();
          return;
        }
        this.sendError('CPF1296 Sign-on information required.');
      } else {
        this.sendError('CPF1120 User ID or password incorrect (mock).');
      }
    }
  }
}

const server = net.createServer((sock) => {
  const s = new Session(sock);
  console.log('[real-signon] client connected');
  sock.on('data', (c) => s.ingest(c));
  sock.on('close', () => console.log('[real-signon] disconnected'));
  sock.on('error', (e) => console.log('[real-signon] error:', e.message));
  s.telnet([DO, OPT_NEWENV, IAC, DO, OPT_TTYPE, IAC, DO, OPT_EOR, IAC, DO, OPT_BINARY]);
  s.telnet([WILL, OPT_EOR, IAC, WILL, OPT_BINARY]);
});

const BIND = process.env.MOCK_BIND ?? '127.0.0.1';
server.listen(PORT, BIND, () => console.log(`[real-signon] listening on ${BIND}:${PORT}`));
