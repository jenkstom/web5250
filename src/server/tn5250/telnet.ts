// Telnet negotiation (RFC 854/855/1091/885/1572) plus RFC 1205 GDS record
// framing for the 5250 Telnet interface.
//
// Negotiation mirrors tn5250j, which interoperates with real IBM i hosts:
//   server DO TERMINAL-TYPE   -> WILL TERMINAL-TYPE
//   server DO END-OF-RECORD   -> WILL END-OF-RECORD
//   server DO TRANSMIT-BINARY -> WILL TRANSMIT-BINARY
//   server DO TIMING-MARK     -> WONT (keeps device-name negotiation alive)
//   server DO NEW-ENVIRON     -> WILL NEW-ENVIRON
//   server WILL EOR/BINARY    -> DO EOR/BINARY
//   server SB TTYPE SEND      -> SB TTYPE IS <term type>
//   server SB NEW-ENVIRON SEND-> SB NEW-ENVIRON IS USERVAR DEVNAME <name>
import * as C from './constants.ts';
import type { Socket } from 'node:net';

export interface TelnetCallbacks {
  /** A complete 5250 record (payload between framing, IAC-undoubled). */
  onRecord: (record: Buffer) => void;
  /** Negotiation is finished and binary/EOR are active. */
  onNegotiated?: () => void;
  /** Non-fatal protocol surprise (logged upstream). */
  onWarn?: (msg: string) => void;
  /**
   * The host asked for DEVNAME again after we already sent one - the
   * RFC 2877 name-collision signal (it re-asks until the client offers an
   * unused name). Only fires when deviceNameRetry is disabled.
   */
  onDeviceNameCollision?: () => void;
}

export interface TelnetOptions {
  /**
   * Answer repeated NEW-ENVIRON DEVNAME requests with a numbered name
   * (TOM -> TOM1), the RFC 2877 display behaviour. Printer sessions set
   * this false: their output queue lives on the exact device name, so a
   * collision must surface as an error, not a silent rename.
   */
  deviceNameRetry?: boolean;
}

export class Telnet5250 {
  private sock: Socket | null = null;
  private readonly cb: TelnetCallbacks;
  private readonly termType: string;
  private deviceName: string | null;
  private devSeq = -1;

  // WEB5250_TRACE=1 dumps raw tx/rx hex - handy against real hosts.
  private readonly trace = process.env.WEB5250_TRACE === '1';

  // inbound assembly
  private record = Buffer.alloc(0); // current record, IAC-undoubled
  private lastWasIAC = false;

  // negotiation state (RFC 854: never re-answer a command that only
  // confirms the current state)
  private weWilled = new Set<number>();
  private weDid = new Set<number>();
  private ttypeSent = false;
  private devNameSent = false;
  negotiated = false;

  constructor(
    termType: string,
    deviceName: string | null,
    cb: TelnetCallbacks,
    opts: TelnetOptions = {}
  ) {
    this.cb = cb;
    this.termType = termType;
    this.deviceName = deviceName;
    this.deviceNameRetry = opts.deviceNameRetry ?? true;
  }

  private readonly deviceNameRetry: boolean;

  /** Bind the live socket (called once connected/TLS-established). */
  attach(sock: Socket): void {
    this.sock = sock;
  }

  /** Feed raw socket data. */
  receive(chunk: Buffer): void {
    if (this.trace) console.log('[tn5250 rx]', chunk.toString('hex'));
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];

      if (this.lastWasIAC) {
        this.lastWasIAC = false;
        if (b === C.IAC) {
          this.record = Buffer.concat([this.record, Buffer.from([C.IAC])]);
          continue;
        }
        if (b === C.EOR) {
          const rec = this.record;
          this.record = Buffer.alloc(0);
          if (!this.negotiated) {
            this.negotiated = true;
            this.cb.onNegotiated?.();
          }
          if (rec.length > 0) this.cb.onRecord(rec);
          continue;
        }
        this.handleCommand(b, chunk, i);
        // handleCommand consumed further bytes (option / sub-negotiation);
        // -1 because the for-loop increments i again.
        if (this.skipAhead > i) i = this.skipAhead - 1;
        continue;
      }

      if (b === C.IAC) {
        this.lastWasIAC = true;
        continue;
      }
      this.record = Buffer.concat([this.record, Buffer.from([b])]);
    }
  }

  private skipAhead = 0;

  /**
   * Handle a telnet command byte that followed IAC. Sets this.skipAhead to
   * the chunk index where the outer loop must resume (it subtracts 1 for
   * the loop's own i++), consuming option bytes / sub-negotiations.
   */
  private handleCommand(cmd: number, chunk: Buffer, i: number): void {
    const at = i + 1; // index of the option byte / SB payload start
    switch (cmd) {
      case C.DO: {
        const opt = chunk[at];
        this.skipAhead = at + 1;
        if (opt === undefined) return;
        switch (opt) {
          case C.OPT_TERMINAL_TYPE:
          case C.OPT_END_OF_RECORD:
          case C.OPT_TRANSMIT_BINARY:
          case C.OPT_NEW_ENVIRONMENT:
            if (!this.weWilled.has(opt)) {
              this.weWilled.add(opt);
              this.send([C.IAC, C.WILL, opt]);
            }
            break;
          case C.OPT_TIMING_MARK:
            this.send([C.IAC, C.WONT, opt]);
            break;
          default:
            this.send([C.IAC, C.WONT, opt]);
        }
        return;
      }
      case C.WILL: {
        const opt = chunk[at];
        this.skipAhead = at + 1;
        if (opt === undefined) return;
        if (opt === C.OPT_END_OF_RECORD || opt === C.OPT_TRANSMIT_BINARY) {
          if (!this.weDid.has(opt)) {
            this.weDid.add(opt);
            this.send([C.IAC, C.DO, opt]);
          }
        } else {
          this.send([C.IAC, C.DONT, opt]);
        }
        return;
      }
      case C.WONT:
      case C.DONT:
        this.skipAhead = at + 1; // consume the option byte
        return;
      case C.SB: {
        const { bytes, end } = this.readSubnegotiation(chunk, at);
        this.skipAhead = end + 1; // end points at the SE byte; resume after it
        if (bytes) this.handleSubnegotiation(bytes);
        return;
      }
      default:
        // NOP, GA, DM, AYT...: parameterless; resume at the next byte.
        this.skipAhead = at;
    }
  }

  /** Returns SB payload (without IAC SE) and the chunk index of the IAC. */
  private readSubnegotiation(chunk: Buffer, from: number): { bytes: Buffer | null; end: number } {
    const raw: number[] = [];
    let i = from;
    for (; i < chunk.length; i++) {
      const b = chunk[i];
      if (b === C.IAC) {
        if (chunk[i + 1] === C.IAC) {
          raw.push(C.IAC);
          i++;
          continue;
        }
        return { bytes: Buffer.from(raw), end: i + 1 }; // +1: past SE
      }
      raw.push(b);
    }
    // Sub-negotiation split across TCP segments: re-inject isn't supported;
    // in practice IBM i sends them whole. Skip gracefully.
    this.cb.onWarn?.('sub-negotiation split across segments; ignored');
    return { bytes: null, end: chunk.length };
  }

  private handleSubnegotiation(bytes: Buffer): void {
    if (bytes.length < 2) return;
    const opt = bytes[0];
    const qual = bytes[1];

    if (opt === C.OPT_TERMINAL_TYPE && qual === C.TTYPE_SEND && !this.ttypeSent) {
      this.ttypeSent = true;
      const t = Buffer.from(this.termType, 'ascii');
      this.send(Buffer.concat([Buffer.from([C.IAC, C.SB, C.OPT_TERMINAL_TYPE, C.TTYPE_IS]), t, Buffer.from([C.IAC, C.SE])]));
      return;
    }

    if (opt === C.OPT_NEW_ENVIRONMENT && qual === C.NEWENV_SEND) {
      // Respond with DEVNAME. When the host asks again it means a name
      // collision: offer a fresh numbered name (RFC 2877) - unless the
      // caller disabled renaming (printer sessions: the output queue is
      // per device name, so a collision must fail loudly instead).
      if (!this.deviceName) return;
      if (!this.deviceNameRetry && this.devNameSent) {
        this.cb.onDeviceNameCollision?.();
        return;
      }
      let name: string;
      if (this.devSeq === -1) {
        name = this.deviceName;
      } else {
        let seq = this.devSeq;
        name = this.deviceName;
        let trim = 1;
        while ((name + seq).length > 10) {
          name = this.deviceName.slice(0, this.deviceName.length - trim++);
        }
        name += seq;
      }
      this.devSeq++;
      const varName = Buffer.from('DEVNAME', 'ascii');
      const val = Buffer.from(name, 'ascii');
      this.send(
        Buffer.concat([
          Buffer.from([C.IAC, C.SB, C.OPT_NEW_ENVIRONMENT, C.NEWENV_IS, C.NEWENV_USERVAR]),
          varName,
          Buffer.from([C.NEWENV_VALUE]),
          val,
          Buffer.from([C.IAC, C.SE])
        ])
      );
      this.devNameSent = true;
    }
  }

  get devNameWasSent(): boolean {
    return this.devNameSent;
  }

  private send(data: Buffer | number[]): void {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (this.trace) console.log('[tn5250 tx]', buf.toString('hex'));
    if (this.sock && !this.sock.destroyed) {
      this.sock.write(buf);
    }
  }

  /** Raw telnet heartbeat (IAC NOP) - keeps idle sessions alive. */
  heartbeat(): void {
    this.send([C.IAC, C.NOP]);
  }

  /**
   * Send one RFC 1205 GDS record:
   *   <len:2> 12 A0 <flow:2> 04 <flags> <b8> <opcode> <payload> <IAC EOR>
   * The length word counts itself and every byte after it, computed before
   * IAC doubling of 0xFF bytes and excluding the trailing IAC EOR - the form
   * live hosts and ACS both use. `b8` is the header byte between flags and
   * opcode: hosts send 0x00, ACS sets 0x80 on device records, so the
   * screen-image reply matches that. `flow` fills bytes 4-5: 0x0000 on
   * display records; printer sessions carry their flow types there
   * (RFC 4777 section 11 - print-complete ACKs, see printer-client.ts).
   */
  sendGds(flags: number, opcode: number, payload?: Buffer, b8 = 0, flow = 0): void {
    const header = Buffer.from([
      (C.GDS_ID >> 8) & 0xff,
      C.GDS_ID & 0xff,
      (flow >> 8) & 0xff,
      flow & 0xff,
      0x04,
      flags & 0xff,
      b8 & 0xff,
      opcode & 0xff
    ]);
    const raw = Buffer.concat([header, payload ?? Buffer.alloc(0)]);
    const len = raw.length + 2;
    const out: number[] = [(len >> 8) & 0xff, len & 0xff];
    for (const b of raw) {
      if (b === C.IAC) out.push(C.IAC); // double 0xFF inside the record
      out.push(b);
    }
    out.push(C.IAC, C.EOR);
    this.send(out);
  }
}
