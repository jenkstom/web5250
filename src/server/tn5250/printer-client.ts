// TN5250E printer session client (RFC 4777 section 11): one gateway-owned,
// always-on printer device per system. Speaks the same telnet negotiation
// as a display session but answers TERMINAL-TYPE with an SCS printer
// (IBM-3812-1), waits for the host's startup response record, then receives
// print records (SCS data, or host-print-transform output) and hands each
// complete job to the caller.
//
// Byte-level shape and sources: docs/printer-session-notes.md.
import * as net from 'node:net';
import * as C from './constants.ts';
import { Ebcdic } from './ebcdic.ts';
import { Telnet5250 } from './telnet.ts';
import { openHostSocket } from './transport.ts';
import type { SocksProxy } from './socks.ts';

export type PrinterStatus = 'connecting' | 'ready' | 'error';
export type PrinterMode = 'text' | 'raw';

export interface PrinterClientOptions {
  host: string;
  port: number;
  ssl: boolean;
  tlsRejectUnauthorized: boolean;
  /** Route the host TCP connection through this SOCKS5 proxy (per system). */
  proxy?: SocksProxy;
  /** Exact device name to claim - the host's output queue hangs off it, so
   * collisions are surfaced as errors, never auto-renamed. */
  deviceName: string;
  mode: PrinterMode;
  codePage: string;
  connectTimeoutMs?: number;
  /** Inbound records hex-dumped to the diagnostics (WEB5250_TRACE parity). */
  traceRecords?: number;
  /** Assembly cap for one job; bytes beyond it are dropped with a warning. */
  maxJobBytes?: number;
}

/** One complete print job, ready for the store. */
export interface PrintJobData {
  /** text mode: UTF-8 with \f page breaks; raw mode: bytes as received. */
  data: Buffer;
  /** Page count (text mode: form feeds + 1); null when unknown (raw). */
  pages: number | null;
  format: 'txt' | 'pdf' | 'pcl';
}

export class Printer5250Client {
  status: PrinterStatus = 'connecting';
  statusDetail: string | undefined;
  onStatus: (status: PrinterStatus, detail?: string) => void = () => {};
  onJob: (job: PrintJobData) => void = () => {};

  private readonly opts: PrinterClientOptions;
  private readonly ebcdic: Ebcdic;
  private readonly telnet: Telnet5250;
  private sock: net.Socket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private destroyed = false;
  /** Print-record payloads of the job currently coming down the wire. */
  private jobBuf: Buffer = Buffer.alloc(0);
  private jobTruncated = false;
  private rxLogged = 0;
  private readonly diagLines: string[] = [];

  constructor(opts: PrinterClientOptions) {
    this.opts = opts;
    this.ebcdic = new Ebcdic(opts.codePage);
    this.telnet = new Telnet5250(
      C.TERM_TYPE_SCS_PRINTER,
      opts.deviceName,
      {
        onRecord: (rec) => this.handleRecord(rec),
        onWarn: (msg) => this.warn(`telnet: ${msg}`),
        // A taken device name is an admin-visible error (the output queue is
        // per device) - not something to rename our way out of.
        onDeviceNameCollision: () =>
          this.fail(`device name ${opts.deviceName} is already in use on the host`)
      },
      { deviceNameRetry: false }
    );
  }

  connect(): void {
    if (this.destroyed) return;
    this.reconnectTimer = null;
    this.setStatus('connecting', this.statusDetail);
    const timeout = this.opts.connectTimeoutMs ?? 15000;
    this.connectTimer = setTimeout(() => {
      if (this.status === 'connecting') this.reconnect(`connect timeout after ${timeout}ms`);
    }, timeout);

    // Keepalive: the display heartbeat (IAC NOP) keeps an idle printer
    // session from being reaped the same way.
    this.heartbeatTimer ??= setInterval(() => {
      if (!this.destroyed) this.telnet.heartbeat();
    }, 45000);

    openHostSocket(
      { host: this.opts.host, port: this.opts.port, ssl: this.opts.ssl, proxy: this.opts.proxy },
      {
        tlsRejectUnauthorized: this.opts.tlsRejectUnauthorized,
        onSocket: (raw) => {
          if (this.destroyed) raw.destroy();
          else this.sock = raw;
        }
      }
    )
      .then(({ socket, preread, ready }) => {
        if (this.destroyed) {
          socket.destroy();
          return;
        }
        this.adopt(socket, ready);
        if (preread.length) this.telnet.receive(preread);
      })
      .catch((err: Error) => this.reconnect(err.message));
  }

  /** Permanent teardown (system removed / printer disabled / shutdown). */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearConnectTimer();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.sock?.destroy();
  }

  getDiagnostics(): string {
    return this.diagLines.join('\n');
  }

  // ------------------------------------------------------------ record flow
  private handleRecord(rec: Buffer): void {
    this.capture(rec);
    if (rec.length < 10) return;
    const flow = (rec[4] << 8) | rec[5];
    if (flow === C.FLOW_STARTUP_RESPONSE) {
      this.handleStartup(rec);
      return;
    }
    // 0x0011 is the classic-tn5250 spelling of the print-data flow (hosts
    // accept both directions of the numbering; tolerate it on receive).
    if (flow === C.FLOW_PRINT_DATA || flow === 0x0011) {
      this.handlePrint(rec);
      return;
    }
    this.warn(`unexpected record flow 0x${flow.toString(16).padStart(4, '0')} (${rec.length} bytes)`);
  }

  /** Startup response (flow 9000): 4-char EBCDIC code at offset 16. */
  private handleStartup(rec: Buffer): void {
    let code = '';
    for (let i = 0; i < 4 && C.PRINT_STARTUP_CODE_OFFSET + i < rec.length; i++) {
      code += this.ebcdic.ebcdic2uni(rec[C.PRINT_STARTUP_CODE_OFFSET + i]);
    }
    this.diag(`startup response ${code}`);
    if (C.PRINT_STARTUP_OK.has(code)) {
      this.reconnectAttempts = 0;
      this.setStatus('ready');
      return;
    }
    const text = C.PRINT_STARTUP_MESSAGES[code] ?? `host refused the printer session (${code})`;
    this.fail(`${text} [${code}]`);
  }

  private handlePrint(rec: Buffer): void {
    const ll = rec[6];
    // Chain/error flags are byte 7 alone (record.h reads data[7]); the RFC
    // examples write them as the 16-bit word 1800/0800 - high byte first.
    const flags = rec[7];
    const opcode = rec[9];

    if (opcode === C.PRINT_OPCODE_CLEAR) {
      // Clear Print Buffers: never ACKed; the half-assembled job is dropped.
      if (this.jobBuf.length > 0) this.diag('clear print buffers: partial job dropped');
      this.jobBuf = Buffer.alloc(0);
      this.jobTruncated = false;
      return;
    }

    // Print-complete ACK (RFC 4777 section 11): 000A 12A0 0102 04 0000 01.
    this.telnet.sendGds(0x00, C.PRINT_OPCODE_PRINT, undefined, 0, C.FLOW_PRINT_RESPONSE);

    // Print data starts right after the LL-counted header (byte 6+LL) - the
    // arithmetic printsession.c uses (o = 6 + rec[6]) and both RFC examples.
    const data = rec.subarray(Math.min(6 + ll, rec.length));
    // End of job = the null record: last-of-chain WITHOUT first-of-chain,
    // no data beyond the optional trailing zero byte the RFC allows.
    const endOfJob =
      (flags & C.PRINT_FLAG_LAST_OF_CHAIN) !== 0 &&
      (flags & C.PRINT_FLAG_FIRST_OF_CHAIN) === 0 &&
      (data.length === 0 || (rec.length <= 0x11 && data.every((b) => b === 0)));
    if (endOfJob) {
      this.flushJob();
      return;
    }
    const cap = this.opts.maxJobBytes ?? 32 * 1024 * 1024;
    const room = Math.max(0, cap - this.jobBuf.length);
    if (room < data.length) {
      if (!this.jobTruncated) {
        this.jobTruncated = true;
        this.warn(`job exceeds ${cap} bytes; keeping the first ${cap}`);
      }
    }
    this.jobBuf = Buffer.concat([this.jobBuf, data.subarray(0, room)]);
  }

  private flushJob(): void {
    const buf = this.jobBuf;
    const truncated = this.jobTruncated;
    this.jobBuf = Buffer.alloc(0);
    this.jobTruncated = false;
    if (buf.length === 0) return;
    if (this.opts.mode === 'text') {
      const { text, pages } = scsExtractText(buf, this.ebcdic);
      this.diag(`job complete: ${buf.length} SCS bytes -> ${text.length} chars, ${pages} page(s)${truncated ? ' (truncated)' : ''}`);
      this.onJob({ data: Buffer.from(text, 'utf8'), pages, format: 'txt' });
      return;
    }
    const format = sniffFormat(buf);
    this.diag(`job complete: ${buf.length} raw bytes, ${format}${truncated ? ' (truncated)' : ''}`);
    this.onJob({ data: buf, pages: null, format });
  }

  // ------------------------------------------------------------- lifecycle
  private adopt(socket: net.Socket, ready: 'connect' | 'secureConnect' | null): void {
    this.sock = socket;
    this.telnet.attach(socket);
    socket.setNoDelay(true);
    socket.on('error', (err) => this.reconnect(err.message));
    socket.on('close', () => this.reconnect('host closed the connection'));
    socket.on('data', (chunk: Buffer) => this.telnet.receive(chunk));
    if (ready === null) this.clearConnectTimer();
    else socket.on(ready, () => this.clearConnectTimer());
  }

  /** Tear down and come back with capped exponential backoff. */
  private reconnect(detail: string): void {
    if (this.destroyed || this.reconnectTimer) return;
    this.clearConnectTimer();
    this.sock?.destroy();
    this.sock = null;
    this.setStatus('error', detail);
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 60000);
    this.reconnectAttempts++;
    this.diag(`reconnecting in ${delay}ms (${detail})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Fatal for this attempt; the reconnect loop keeps trying in the background. */
  private fail(detail: string): void {
    this.warn(detail);
    this.reconnect(detail);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private setStatus(s: PrinterStatus, detail?: string): void {
    this.status = s;
    this.statusDetail = detail;
    this.onStatus(s, detail);
  }

  // ------------------------------------------------------------ diagnostics
  private warn(msg: string): void {
    console.warn(`[printer ${this.opts.deviceName}] ${msg}`);
    this.diagLines.push(`[printer ${this.opts.deviceName}] WARN ${msg}`);
    if (this.diagLines.length > 300) this.diagLines.splice(0, this.diagLines.length - 300);
  }

  private diag(line: string): void {
    this.diagLines.push(line);
    if (this.diagLines.length > 300) this.diagLines.splice(0, this.diagLines.length - 300);
    console.log(line);
  }

  /** Hex of the first records per session, like Tn5250Client.capture. */
  private capture(rec: Buffer): void {
    if (this.rxLogged < (this.opts.traceRecords ?? 8)) {
      this.rxLogged++;
      this.diag(`[printer ${this.opts.deviceName}] rx#${this.rxLogged} ${rec.toString('hex')}`);
    }
  }
}

// ---------------------------------------------------------------- extraction
/**
 * Text-mode SCS extractor: EBCDIC text with control codes mapped per
 * docs/printer-session-notes.md section 4. FF/RFF become form feeds (the
 * page count is form feeds + 1); line advances (NL/RNL/LF/IRS) become
 * newlines; CR is dropped (it is a column reset that real generators pair
 * with NL - emitting it would double-space); presentation codes are
 * skipped with their parameter bytes; anything unrecognized falls through
 * as text, scs.c-style, so an unknown code costs one odd glyph instead of
 * desynchronizing the stream.
 */
export function scsExtractText(
  data: Buffer,
  ebcdic: Ebcdic
): { text: string; pages: number } {
  let out = '';
  let pages = 1;
  let i = 0;
  while (i < data.length) {
    const b = data[i++];
    switch (b) {
      case C.SCS_TRANSPARENT: {
        if (i >= data.length) break;
        const len = data[i++];
        const end = Math.min(i + len, data.length);
        out += data.subarray(i, end).toString('latin1');
        i = end;
        break;
      }
      case C.SCS_HT:
        out += '\t';
        break;
      case C.SCS_RNL:
      case C.SCS_NL:
      case C.SCS_LF:
      case C.SCS_IRS:
        out += '\n';
        break;
      case C.SCS_FF:
      case C.SCS_RFF:
        out += '\f';
        pages++;
        break;
      case C.SCS_RPT: {
        if (i + 1 >= data.length) break;
        const count = data[i++];
        const ch = data[i++];
        if (ch >= 0x40) out += ebcdic.ebcdic2uni(ch).repeat(Math.min(count, 32768));
        break;
      }
      case C.SCS_SSA: {
        // Sub-coded presentation blocks: C1 SHF / C2 SVF carry a length
        // byte; other sub-codes carry no text either - skip the sub-code.
        if (i >= data.length) break;
        const sub = data[i++];
        if (sub === 0xc1 || sub === 0xc2) {
          if (i < data.length) i += 1 + data[i]; // length byte + that many
        }
        break;
      }
      case C.SCS_PP:
      case C.SCS_AHPP:
      case C.SCS_AVPP:
      case C.SCS_RRPP:
        i += 2;
        break;
      case C.SCS_NOOP:
      case C.SCS_CR:
      case C.SCS_BEL:
      case C.SCS_SPS:
      case C.SCS_SBS:
        break;
      default:
        out += ebcdic.ebcdic2uni(b);
    }
  }
  return { text: out, pages };
}

/** raw-mode format sniff: %PDF -> pdf, ESC/PJL -> pcl, else txt. */
export function sniffFormat(data: Buffer): 'pdf' | 'pcl' | 'txt' {
  if (data.length >= 4 && data[0] === 0x25 && data.subarray(1, 4).toString('latin1') === 'PDF') {
    return 'pdf';
  }
  if (data.length > 0 && data[0] === 0x1b) return 'pcl';
  if (data.length >= 9 && data.subarray(0, 9).toString('latin1') === '%-12345-X') return 'pcl';
  return 'txt';
}
