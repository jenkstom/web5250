// TN5250 client session: socket lifecycle + telnet + screen + parser, plus
// the outbound (AID) side of the protocol.
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as C from './constants.ts';
import { Ebcdic } from './ebcdic.ts';
import { Screen5250 } from './screen.ts';
import { Parser5250 } from './parser.ts';
import { Telnet5250 } from './telnet.ts';

export type SessionStatus = 'connecting' | 'negotiating' | 'connected' | 'closed' | 'error';

export interface Tn5250ClientOptions {
  host: string;
  port: number;
  ssl: boolean;
  tlsRejectUnauthorized: boolean;
  termType: string;
  deviceName: string | null;
  codePage: string;
  connectTimeoutMs?: number;
  /** Claim pointer-device capability in the query reply (IBM_I_MOUSE_GUI=1). */
  queryMouseGui?: boolean;
  /** Inbound records captured per session for Diag (IBM_I_TRACE_RECORDS). */
  traceRecords?: number;
}

export class Tn5250Client {
  readonly screen: Screen5250;
  private readonly telnet: Telnet5250;
  private readonly parser: Parser5250;
  private readonly ebcdic: Ebcdic;
  private sock: net.Socket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private recordsSeen = 0;
  /** Bounded protocol capture for the server logs (first records of a session). */
  private rxLogged = 0;
  private lastFieldLog = '';

  status: SessionStatus = 'connecting';
  onStatus: (status: SessionStatus, detail?: string) => void = () => {};
  onScreenChange: () => void = () => {};

  private readonly opts: Tn5250ClientOptions;

  constructor(opts: Tn5250ClientOptions) {
    this.opts = opts;
    this.ebcdic = new Ebcdic(opts.codePage);
    this.screen = new Screen5250(this.ebcdic);
    this.telnet = new Telnet5250(opts.termType, opts.deviceName, {
      onRecord: (rec) => this.handleRecord(rec),
      onNegotiated: () => this.setStatus('negotiating'),
      onWarn: (msg) => this.warn(`telnet: ${msg}`)
    });
    this.parser = new Parser5250(
      this.screen,
      this.telnet,
      this.ebcdic,
      (m) => this.warn(`parser: ${m}`),
      opts.queryMouseGui ?? false
    );
    this.parser.log = (m) =>
      this.diag(`[tn5250 ${this.opts.deviceName ?? '-'}] ${m}`);
  }

  private warn(msg: string): void {
    console.warn(`[tn5250 ${this.opts.deviceName ?? '-'}] ${msg}`);
    // Keep warnings in the diagnostic export too - they mark exactly where
    // the host's stream surprised the parser.
    this.diagLines.push(`[tn5250 ${this.opts.deviceName ?? '-'}] WARN ${msg}`);
  }

  /**
   * Session protocol capture in the server logs: raw hex of the first
   * records (the sign-on screens), the parsed field table whenever it
   * changes, and every outgoing AID payload. Enough to diagnose a real
   * host's data-stream dialect from `docker logs` alone. The same lines are
   * kept in a bounded buffer so a browser can export them (diagnostics
   * button) without container access.
   */
  private readonly diagLines: string[] = [];

  private diag(line: string): void {
    this.diagLines.push(line);
    if (this.diagLines.length > 300) this.diagLines.splice(0, this.diagLines.length - 300);
    console.log(line);
  }

  getDiagnostics(): string {
    return this.diagLines.join('\n');
  }

  private capture(rx: Buffer): void {
    if (this.rxLogged < (this.opts.traceRecords ?? 8)) {
      this.rxLogged++;
      this.diag(`[tn5250 ${this.opts.deviceName ?? '-'}] rx#${this.rxLogged} ${rx.toString('hex')}`);
    }
    const s = this.screen;
    const line = s.fields
      .map(
        (f) =>
          `${s.rowOf(f.startPos)},${s.colOf(f.startPos)}:a${f.attr.toString(16).padStart(2, '0')}/n${f.length}${f.isBypass ? '!' : ''}`
      )
      .join(' ');
    if (line !== this.lastFieldLog) {
      this.lastFieldLog = line;
      this.diag(
        `[tn5250 ${this.opts.deviceName ?? '-'}] fields ${s.rows}x${s.cols}: ${line || '(none)'} ` +
          `cursor=${s.rowOf(s.cursorPos)},${s.colOf(s.cursorPos)} waiting=${s.waitingForInput}`
      );
    }
  }

  private setStatus(s: SessionStatus, detail?: string): void {
    this.status = s;
    this.onStatus(s, detail);
  }

  connect(): void {
    if (this.destroyed) return;
    const { host, port, ssl } = this.opts;
    const timeout = this.opts.connectTimeoutMs ?? 15000;

    const socket: net.Socket = ssl
      ? tls.connect({ host, port, rejectUnauthorized: this.opts.tlsRejectUnauthorized })
      : net.connect({ host, port });

    this.sock = socket;
    this.telnet.attach(socket);
    socket.setNoDelay(true);
    socket.on('error', (err) => {
      if (this.destroyed) return;
      this.setStatus('error', err.message);
      this.destroy();
    });
    socket.on('close', () => {
      if (this.destroyed) return;
      this.setStatus('closed');
      this.destroy();
    });
    socket.on('connect', () => {
      this.clearConnectTimer();
      this.setStatus('negotiating');
    });
    socket.on('data', (chunk: Buffer) => this.telnet.receive(chunk));

    this.connectTimer = setTimeout(() => {
      if (this.status === 'connecting') {
        this.setStatus('error', `connect timeout after ${timeout}ms`);
        this.destroy();
      }
    }, timeout);

    // Keepalive: raw telnet NOP keeps idle sessions from being reaped.
    this.heartbeatTimer = setInterval(() => {
      if (!this.destroyed) this.telnet.heartbeat();
    }, 45000);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private handleRecord(rec: Buffer): void {
    try {
      this.parser.parse(rec);
      this.capture(rec);
      if (this.parser.beep) this.onScreenChange(); // gateway also polls beep flag
      this.recordsSeen++;
      if (this.status !== 'connected') this.setStatus('connected');
      this.onScreenChange();
    } catch (err) {
      this.warn(`unhandled record error: ${(err as Error).message}`);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearConnectTimer();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.sock?.destroy();
    if (this.status !== 'error' && this.status !== 'closed') this.setStatus('closed');
  }

  get everConnected(): boolean {
    return this.recordsSeen > 0;
  }

  // ------------------------------------------------------------- AID keys
  private cursorBytes(): number[] {
    return [this.screen.rowOf(this.screen.cursorPos) & 0xff, this.screen.colOf(this.screen.cursorPos) & 0xff];
  }

  /** PF keys only transmit data when the host's SOH order allows it. */
  private dataIncludedFor(aid: number): boolean {
    if (aid >= C.AID_PF1 && aid <= C.AID_PF1 + 11) {
      return this.screen.dataIncluded[aid - C.AID_PF1];
    }
    if (aid >= 0xb1 && aid <= 0xbc) {
      return this.screen.dataIncluded[aid - 0xb1 + 12];
    }
    return true;
  }

  /**
   * Send an AID-generating key. Returns false when the keyboard is not in a
   * state that accepts AIDs (locked / not invited).
   */
  sendAid(aid: number): boolean {
    if (this.screen.lock !== 'none' || !this.screen.waitingForInput) return false;
    if (this.screen.errorCodeActive) return false;

    const payload: number[] = [...this.cursorBytes(), aid];
    const body = this.dataIncludedFor(aid) ? this.screen.buildReadResponse() : Buffer.alloc(0);
    this.diag(
      `[tn5250 ${this.opts.deviceName ?? '-'}] aid 0x${aid.toString(16)} ` +
        `cursor=${this.screen.rowOf(this.screen.cursorPos)},${this.screen.colOf(this.screen.cursorPos)} ` +
        `read=0x${this.screen.readType.toString(16)} body=${body.toString('hex')}`
    );

    this.screen.waitingForInput = false;
    this.screen.lockSystem();
    this.telnet.sendGds(0, 3, Buffer.concat([Buffer.from(payload), body]));
    this.onScreenChange();
    return true;
  }

  /** HELP - AID 0xF3, no field data. */
  sendHelp(): void {
    this.telnet.sendGds(0, 3, Buffer.from([...this.cursorBytes(), C.AID_HELP]));
    this.screen.lockSystem();
    this.screen.waitingForInput = false;
    this.onScreenChange();
  }

  /**
   * GUI-discovery probe (experiment): send a candidate mouse/menu AID for a
   * right-click at (r1,c1). The reply is shaped exactly like a normal AID,
   * but the cursor position bytes report the CLICKED cell instead of the
   * screen cursor - that is where ACS-type emulators most plausibly carry
   * the mouse position. Used with ?mouseprobe=<hex> to identify which AID
   * the host's 5250 GUI orders expect; not part of normal operation.
   */
  sendMouseProbe(aid: number, r1: number, c1: number): boolean {
    if (r1 < 1 || r1 > this.screen.rows || c1 < 1 || c1 > this.screen.cols) return false;
    if (this.screen.lock !== 'none' || !this.screen.waitingForInput) return false;
    if (this.screen.errorCodeActive) return false;

    const body = this.dataIncludedFor(aid) ? this.screen.buildReadResponse() : Buffer.alloc(0);
    this.diag(
      `[tn5250 ${this.opts.deviceName ?? '-'}] MOUSE PROBE aid 0x${aid.toString(16)} ` +
        `click=${r1},${c1} cursor=${this.screen.rowOf(this.screen.cursorPos)},${this.screen.colOf(this.screen.cursorPos)} ` +
        `read=0x${this.screen.readType.toString(16)} body=${body.toString('hex')}`
    );

    this.screen.waitingForInput = false;
    this.screen.lockSystem();
    this.telnet.sendGds(
      0,
      3,
      Buffer.concat([Buffer.from([r1 & 0xff, c1 & 0xff, aid & 0xff]), body])
    );
    this.onScreenChange();
    return true;
  }

  /** PRINT - AID 0xF6, no field data. */
  sendPrint(): void {
    this.telnet.sendGds(0, 3, Buffer.from([...this.cursorBytes(), C.AID_PRINT]));
    this.screen.lockSystem();
    this.onScreenChange();
  }

  /** ATTN - GDS flags 0x40, no opcode/payload. Works while locked. */
  sendAttention(): void {
    this.telnet.sendGds(C.GDS_FLAG_ATN, 0);
    this.onScreenChange();
  }

  /** SYSREQ - GDS flags 0x04, optional EBCDIC option text. Works while locked. */
  sendSystemRequest(text?: string): void {
    const payload = text ? Buffer.from([...text].map((ch) => this.ebcdic.uni2ebcdic(ch))) : undefined;
    this.telnet.sendGds(C.GDS_FLAG_SRQ, 0, payload);
    this.onScreenChange();
  }

  /** Local (non-AID) key handling. Returns a beep-worthy rejection reason or null. */
  localKey(key: string, ch?: string): string | null {
    const s = this.screen;
    if (key === 'reset') {
      s.reset();
      return null;
    }
    if (key === 'sysreq' || key === 'attn') return null; // handled by gateway

    if (s.lock !== 'none') return 'locked';
    if (!s.waitingForInput) return 'notinvited';

    switch (key) {
      case 'tab':
        if (!s.gotoField(1)) return 'nofield';
        return null;
      case 'btab':
        if (!s.gotoField(-1)) return 'nofield';
        return null;
      case 'fieldexit':
      case 'fieldplus':
        if (!s.currentField()) return 'nofield';
        s.fieldExit();
        return null;
      case 'fieldminus':
        if (!s.currentField()) return 'nofield';
        s.fieldMinus();
        return null;
      case 'backspace':
        s.backspace();
        return null;
      case 'delete':
        if (!s.currentField()) return 'nofield';
        s.deleteKey();
        return null;
      case 'insert':
        s.insertMode = !s.insertMode;
        return null;
      case 'up':
        s.arrow(-1, 0);
        return null;
      case 'down':
        s.arrow(1, 0);
        return null;
      case 'left':
        s.arrow(0, -1);
        return null;
      case 'right':
        s.arrow(0, 1);
        return null;
      case 'home':
        s.home();
        return null;
      case 'end':
        s.endOfField();
        return null;
      case 'char': {
        if (!ch) return 'nochar';
        const res = s.typeChar(ch);
        if (!res.ok) return 'rejected';
        if (res.autoEnter && !this.sendAid(C.AID_ENTER)) return null;
        return null;
      }
      default:
        return null;
    }
  }
}
