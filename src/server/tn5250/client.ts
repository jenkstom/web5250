// TN5250 client session: socket lifecycle + telnet + screen + parser, plus
// the outbound (AID) side of the protocol.
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as C from './constants.ts';
import { Ebcdic } from './ebcdic.ts';
import { Screen5250 } from './screen.ts';
import { Parser5250 } from './parser.ts';
import { Telnet5250 } from './telnet.ts';
import { socks5Connect, type SocksProxy } from './socks.ts';

export type SessionStatus = 'connecting' | 'negotiating' | 'connected' | 'closed' | 'error';

export interface Tn5250ClientOptions {
  host: string;
  port: number;
  ssl: boolean;
  tlsRejectUnauthorized: boolean;
  termType: string;
  deviceName: string | null;
  codePage: string;
  /** Route the host TCP connection through this SOCKS5 proxy (per system). */
  proxy?: SocksProxy;
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
  /** STRPCCMD from the host (URIs etc); see ORDER_PC_CMD. Never painted. */
  onPcCommand: (command: string, wait: boolean) => void = () => {};

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
    const { host, port, ssl, proxy } = this.opts;
    const timeout = this.opts.connectTimeoutMs ?? 15000;

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

    if (proxy) {
      // Tunnel first (SOCKS5 CONNECT, username/password auth), then wire
      // telnet to whatever came out - optionally TLS layered over it.
      this.connectThroughProxy(proxy, host, port, ssl);
      return;
    }

    const socket: net.Socket = ssl
      ? tls.connect({ host, port, rejectUnauthorized: this.opts.tlsRejectUnauthorized })
      : net.connect({ host, port });
    this.adopt(socket, 'connect');
  }

  private connectThroughProxy(proxy: SocksProxy, host: string, port: number, ssl: boolean): void {
    socks5Connect(proxy, { host, port }, (raw) => {
      // Keep the in-flight tunnel reachable by destroy() (connect timeout,
      // host-side teardown) while the handshake is still running.
      if (this.destroyed) raw.destroy();
      else this.sock = raw;
    })
      .then(({ socket: raw, preread }) => {
        if (this.destroyed) {
          raw.destroy();
          return;
        }
        if (!ssl) {
          this.adopt(raw, null);
          if (preread.length) this.telnet.receive(preread);
          return;
        }
        // TLS rides inside the tunnel, so bytes that arrived with the proxy
        // reply are the start of the TLS handshake: push them back into the
        // socket for the TLS layer to parse, not into telnet.
        if (preread.length) raw.unshift(preread);
        const secure = tls.connect({
          socket: raw,
          servername: net.isIP(host) ? undefined : host,
          rejectUnauthorized: this.opts.tlsRejectUnauthorized
        });
        this.adopt(secure, 'secureConnect');
      })
      .catch((err: Error) => {
        if (this.destroyed) return;
        this.setStatus('error', err.message);
        this.destroy();
      });
  }

  /**
   * Hand a socket to the telnet layer and arm the error/close teardown.
   * `ready` names the event that marks the transport established - 'connect'
   * for direct sockets, 'secureConnect' for TLS layered over a proxy tunnel,
   * null when the socket is already talking (plain tunnel).
   */
  private adopt(socket: net.Socket, ready: 'connect' | 'secureConnect' | null): void {
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
    socket.on('data', (chunk: Buffer) => this.telnet.receive(chunk));
    if (ready === null) {
      this.clearConnectTimer();
      this.setStatus('negotiating');
    } else {
      socket.on(ready, () => {
        this.clearConnectTimer();
        this.setStatus('negotiating');
      });
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private handleRecord(rec: Buffer): void {
    try {
      const pc = this.parser.parse(rec);
      this.capture(rec);
      this.recordsSeen++;
      if (this.status !== 'connected') this.setStatus('connected');
      if (pc) {
        // STRPCCMD: the parser already erased the carrier block from the
        // buffer and no screen change is broadcast - the command text must
        // never reach a display. The gateway decides what to do with it.
        this.diag(
          `[tn5250 ${this.opts.deviceName ?? '-'}] pccmd wait=${pc.wait} '${pc.command}'`
        );
        this.onPcCommand(pc.command, pc.wait);
        this.replyPcCommand();
        return;
      }
      if (this.parser.beep) this.onScreenChange(); // gateway also polls beep flag
      this.onScreenChange();
    } catch (err) {
      this.warn(`unhandled record error: ${(err as Error).message}`);
    }
  }

  /**
   * STRPCCMD completion: tn5250j sends Enter unconditionally after running
   * the command - with a read invited it completes the read (releasing a
   * WAIT(*YES) caller), and the host buffers an AID sent without one.
   */
  private replyPcCommand(): void {
    if (!this.sendAid(C.AID_ENTER)) {
      this.telnet.sendGds(0, 3, Buffer.from([...this.cursorBytes(), C.AID_ENTER]));
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

  /**
   * HELP - AID 0xF3, and PRINT - AID 0xF6 (the AS/400 answers with the
   * COPY-TO-PRINTER flow). Both complete the outstanding read like any AID
   * reply: an AID transmitted while a read is invited must carry the field
   * data that read calls for (READ INPUT FIELDS: every field at full width;
   * READ MDT FIELDS: the modified runs). Sending the bare AID truncates the
   * inbound record and the host rejects it with a Write Error Code - the
   * "keyboard error" that used to come back for Alt+H / Alt+P.
   */
  sendHelp(): void {
    this.sendAidReply(C.AID_HELP);
  }

  sendPrint(): void {
    this.sendAidReply(C.AID_PRINT);
  }

  /** AID-only reply that still satisfies the outstanding read's format. */
  private sendAidReply(aid: number): void {
    const wasWaiting = this.screen.waitingForInput;
    const body = wasWaiting ? this.screen.buildReadResponse() : Buffer.alloc(0);
    this.diag(
      `[tn5250 ${this.opts.deviceName ?? '-'}] aid 0x${aid.toString(16)} ` +
        `cursor=${this.screen.rowOf(this.screen.cursorPos)},${this.screen.colOf(this.screen.cursorPos)} ` +
        `read=0x${this.screen.readType.toString(16)} body=${body.toString('hex')}`
    );
    if (wasWaiting) {
      this.screen.waitingForInput = false;
      this.screen.lockSystem();
    }
    this.telnet.sendGds(0, 3, Buffer.concat([Buffer.from([...this.cursorBytes(), aid]), body]));
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

  /**
   * Host-programmed mouse AID without the waiting/lock gates. A real 5250
   * latches an AID generated while no read is pending and delivers it with
   * the next read; over telnet, sending the record at once is equivalent
   * (the host buffers it). Live menu flows hold the session with no read
   * invite and still expect the next mouse event.
   */
  sendMouseAid(aid: number): boolean {
    if (this.screen.errorCodeActive) return false;
    const wasWaiting = this.screen.waitingForInput;
    const body = wasWaiting && this.dataIncludedFor(aid) ? this.screen.buildReadResponse() : Buffer.alloc(0);
    this.diag(
      `[tn5250 ${this.opts.deviceName ?? '-'}] mouse aid 0x${aid.toString(16)} ` +
        `cursor=${this.screen.rowOf(this.screen.cursorPos)},${this.screen.colOf(this.screen.cursorPos)} ` +
        `waiting=${wasWaiting} read=0x${this.screen.readType.toString(16)} body=${body.toString('hex')}`
    );
    if (wasWaiting) {
      this.screen.waitingForInput = false;
      this.screen.lockSystem();
    }
    this.telnet.sendGds(0, 3, Buffer.concat([Buffer.from([...this.cursorBytes(), aid]), body]));
    this.onScreenChange();
    return true;
  }

  /**
   * Selection-field pick (5494 FR): the host's pull-down menus are DEFINE
   * SELECTION FIELD constructs. Picking a choice returns an Enter AID with
   * the cursor on the chosen choice and, as the field's inbound data, SBA at
   * the field anchor + 1 followed by the 2-byte selected choice number
   * (0 = dismissed without a selection) - the exact shape ACS returns.
   */
  sendSelectionPick(choice: number): boolean {
    const sel = this.screen.selection;
    if (!sel || this.screen.errorCodeActive) return false;
    const pick = choice >= 1 && choice <= sel.choices.length ? sel.choices[choice - 1] : sel.choices[0];
    const cursor = pick ? [pick.row, pick.col] : [sel.row, Math.min(sel.col + 1, this.screen.cols)];
    const fieldCol = Math.min(sel.col + 1, this.screen.cols);
    const body = [C.ORDER_SBA, sel.row & 0xff, fieldCol & 0xff, (choice >> 8) & 0xff, choice & 0xff];
    this.diag(
      `[tn5250 ${this.opts.deviceName ?? '-'}] selection pick #${choice} ` +
        `cursor=${cursor[0]},${cursor[1]} field=${sel.row},${fieldCol}`
    );
    this.screen.waitingForInput = false;
    this.screen.lockSystem();
    this.screen.clearGui(); // the pick closes the menu locally
    this.telnet.sendGds(0, 3, Buffer.from([...cursor, C.AID_ENTER, ...body]));
    this.onScreenChange();
    return true;
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
