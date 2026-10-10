// Realistic IBM i QDSIGNON host, byte-shaped from a live capture:
//   - SOH order (len 7) opens the WTD; no IC order (the terminal must home
//     to the first enterable field by format-table position)
//   - User field attr 0x26 (non-display), Password 0x27; the optional
//     fields carry FFW1=0x60 (bypass) so Tab skips them - the live layout
//   - READ MDT FIELDS (0x52) invite; SBA-prefixed runs in the response
//   - on success: a "Job ... started" message screen whose WTD opens with
//     SOH len 16 (beyond the classic 1..7 range - regression guard)
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

const CMD_CLEAR = 0x40, CMD_WTD = 0x11, CMD_RMD = 0x52, CMD_ERRCODE = 0x21;
const ORDER_SBA = 0x11, ORDER_SF = 0x1d, ORDER_SOH = 0x01;

// Five signon fields at rows 6..10, data col 53..62, exactly like the
// capture: user 0x26 hidden, password 0x27 hidden, options bypassed.
const FIELDS = [
  { row: 6, label: 'User', attr: 0x26, bypass: false },
  { row: 7, label: 'Password', attr: 0x27, bypass: false },
  { row: 8, label: 'Procedure', attr: 0x27, bypass: true },
  { row: 9, label: 'Menu', attr: 0x27, bypass: true },
  { row: 10, label: 'Current library', attr: 0x27, bypass: true }
];

class Session {
  constructor(sock) {
    this.sock = sock;
    this.dev = 'PANG_TEST01';
    this.mode = 'data';
    this.iacCmd = 0;
    this.recbits = [];
    this.sub = [];
    this.started = false;
    this.gotTtype = false;
    this.confirmed = new Set();
    this.values = {};
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
    const total = body.length + 2; // RFC 1205: length counts itself
    const out = [(total >> 8) & 0xff, total & 0xff];
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

  /** SF with FFW pair (0x40/0x60 first byte), attr, 10 data cells. */
  field(row, attr, bypass) {
    return [ORDER_SBA, row, 52, ORDER_SF, bypass ? 0x60 : 0x40, 0x20, attr, 0x00, 0x0a];
  }

  sendSignon() {
    const orders = [
      [ORDER_SOH, 0x07, 0x00, 0x00, 0x00, 0x19, 0x00, 0x00, 0x00],
      this.text(1, 22, 0x22, 'SIGN ON'),
      this.text(2, 19, null, 'System  . . . . . :'),
      this.text(2, 45, null, 'DEMOSYS01'),
      this.text(3, 19, null, 'Subsystem . . . . :  QINTER'),
      this.text(4, 19, null, 'Display  . . . . . :  ' + this.dev.replace('_', '=')),
      ...FIELDS.map((f) => [
        this.text(f.row, 16, null, (f.label + ' ').padEnd(29, '.')),
        this.field(f.row, f.attr, f.bypass)
      ])
    ].flat(2);
    // No IC order - the terminal must home to the first enterable field.
    this.record(
      this.esc(CMD_CLEAR),
      this.esc(CMD_WTD, 0x00, 0x18, ...orders),
      this.esc(CMD_RMD, 0x00, 0x00)
    );
  }

  /** Post-signon message screen: WTD opening with SOH len 16 (live shape). */
  sendJobStarted(user) {
    const msg = `Job 014572/${user.padEnd(10).slice(0, 10)}/${this.dev} started on 010/2026.`;
    const orders = [
      [ORDER_SOH, 0x10, 0x30, 0x12, 0x2d, 0x19, 0x68, 0x24,
       0x0f, 0x0f, 0x1f, 0x4f, 0x5f, 0x7f, 0x26, 0x1e, 0x3d, 0x6d],
      this.text(3, 1, 0x20, msg),
      this.text(5, 1, null, 'Press Enter to continue.'),
      [ORDER_SBA, 23, 1, 0x20, ...e('F3=Exit')]
    ].flat();
    this.record(
      this.esc(CMD_CLEAR),
      this.esc(CMD_WTD, 0x00, 0x20, ...orders)
    );
    this.record(this.esc(CMD_RMD, 0x00, 0x00));
  }

  sendError(msg) {
    this.record([
      0x04, CMD_ERRCODE,
      ORDER_SBA, 24, 1, 0x28, ...e(msg),
      0x04, CMD_RMD, 0x00, 0x00
    ]);
  }

  // ---- inbound telnet/record framing ----
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
    console.log('[real-signon] starting, sending QDSIGNON (live dialect)');
    setTimeout(() => this.sendSignon(), 30);
  }

  onRecord(rec) {
    if (rec.length < 10) return;
    let p = 10;
    if (p + 3 > rec.length) return;
    const row = rec[p], col = rec[p + 1], aid = rec[p + 2];
    p += 3;
    // RMD response: SBA-prefixed runs; assign by proximity to field rows.
    while (p + 3 <= rec.length && rec[p] === ORDER_SBA) {
      const r = rec[p + 1], c = rec[p + 2];
      p += 3;
      let s = '';
      while (p < rec.length && rec[p] !== ORDER_SBA) {
        s += E2A[rec[p]] ?? ' ';
        p++;
      }
      const f = FIELDS.find((x) => x.row === r);
      if (f) this.values[f.label] = s.replace(/ +$/, '');
    }
    console.log(`[real-signon] AID=0x${aid.toString(16)} cursor=${row},${col} values=${JSON.stringify(this.values)}`);
    if (aid === 0xf1) {
      const user = this.values['User'] ?? '';
      const pw = this.values['Password'] ?? '';
      if (user && pw) {
        this.sendJobStarted(user);
      } else {
        this.failures++;
        if (this.failures >= 2) {
          console.log('[real-signon] host would drop; ending');
          this.sock.end();
          return;
        }
        this.sendError('CPF1296 Sign-on information required.');
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
