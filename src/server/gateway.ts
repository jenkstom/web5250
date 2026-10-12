// Bridges one browser WebSocket to one TN5250 client session.
//
// The gateway is deliberately thin: the server-side Screen5250 is the single
// source of truth. Browsers send logical key events ('enter', 'pf3', 'char',
// 'fieldexit', ...); local field editing happens server-side; screen diffs
// and OIA state flow back as compact JSON messages.
import type { WebSocket } from 'ws';
import * as C from './tn5250/constants.ts';
import { Tn5250Client } from './tn5250/client.ts';
import type { Config } from './config.ts';
import { makeDeviceName } from './config.ts';
import { devices } from './devices.ts';
import type { SystemRow } from './systems.ts';
import { Automation } from './automation.ts';

export interface SessionQuery {
  host?: string;
  port?: number;
  ssl?: boolean;
  termType?: string;
  codePage?: string;
  devName?: string;
  /** Menu selection (?system=<id>) resolved by the HTTP layer. */
  systemId?: number;
  /** ?auto=1 automated data-entry launch parameters. */
  auto?: AutoQuery;
}

export interface AutoQuery {
  input?: string;
  inputEnter: boolean;
  inputDelayMs: number;
}

const KEY_TO_AID: Record<string, number> = {
  enter: C.AID_ENTER,
  clear: C.AID_CLEAR,
  rollup: C.AID_ROLL_UP,
  rolldown: C.AID_ROLL_DOWN
};
for (let i = 1; i <= 24; i++) KEY_TO_AID[`pf${i}`] = C.aidForPF(i);

// Keys accepted while the keyboard is locked (X SYSTEM / X II).
const LOCK_SAFE_KEYS = new Set(['reset', 'sysreq', 'attn', 'print']);

export class GatewaySession {
  private client: Tn5250Client;
  private automation: Automation | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private lastSentCursor = -1;
  private lastSentOia = '';
  private beeped = false;
  readonly devName: string | null;
  private readonly ws: WebSocket;
  private readonly sessionInfo: { host: string; port: number; ssl: boolean; termType: string; codePage: string };
  private readonly systemName: string | undefined;

  constructor(ws: WebSocket, cfg: Config, query: SessionQuery, system?: SystemRow) {
    this.ws = ws;
    // Connection parameters resolve in order: explicit URL overrides
    // (ALLOW_CUSTOM_HOST) > menu-selected system (?system=<id> from the DB)
    // > the IBM_I_* environment defaults.
    const allowCustom = cfg.allowCustomHost;
    const host = allowCustom && query.host ? query.host : (system?.host ?? cfg.ibmHost);
    const port = allowCustom && query.port ? query.port : (system?.port ?? cfg.ibmPort);
    const ssl =
      allowCustom && typeof query.ssl === 'boolean' ? query.ssl : (system?.ssl ?? cfg.ibmSsl);
    const termType = allowCustom && query.termType ? query.termType.toUpperCase() : (system?.termType ?? cfg.termType);
    const codePage = allowCustom && query.codePage ? query.codePage.toLowerCase() : (system?.codePage ?? cfg.codePage);

    // Requested display names (and even random ones) are made unique across
    // live sessions: a taken name gets a numeric suffix (TOM -> TOM1).
    const requested = makeDeviceName(system?.devPrefix ?? cfg.devPrefix, query.devName);
    this.devName = devices.allocate(requested);
    if (requested && this.devName && requested !== this.devName) {
      console.log(`[ws] display name ${requested} in use, using ${this.devName}`);
    }
    this.sessionInfo = { host, port, ssl, termType, codePage };
    this.systemName = system?.name;

    this.client = new Tn5250Client({
      host,
      port,
      ssl,
      tlsRejectUnauthorized: cfg.tlsRejectUnauthorized,
      termType,
      deviceName: this.devName,
      codePage
    });
    // Terminal host state (connection failed, host dropped us): tear the
    // session down right away - release the display name and close the
    // browser socket after the status message is queued, so the client
    // learns why before the close event. Without this, a dead host session
    // lingers until page unload and leaks its name (TOM -> TOM1 -> ...).
    this.client.onStatus = (s, detail) => {
      this.sendStatus(s, detail);
      if (s === 'closed' || s === 'error') this.destroy();
    };
    // ?auto=1 launch: sign on with the configured assumed-identity account
    // and pre-fill the initial program's screen. The HTTP layer refuses
    // auto upgrades without AUTO_SIGNON_USER/AUTO_SIGNON_PASSWORD, so both
    // are present whenever query.auto is set.
    if (query.auto && cfg.autoSignOnUser && cfg.autoSignOnPassword) {
      this.automation = new Automation(
        this.client,
        {
          user: cfg.autoSignOnUser,
          password: cfg.autoSignOnPassword,
          input: query.auto.input,
          inputEnter: query.auto.inputEnter,
          inputDelayMs: query.auto.inputDelayMs
        },
        {
          onEnd: (reason, detail) => {
            this.send('auto', { phase: 'ended', reason, detail });
            this.destroy();
          },
          onChange: () => this.scheduleFlush()
        }
      );
      console.log(`[ws] auto-launch session (sign-on user ${cfg.autoSignOnUser})`);
    }
    this.client.onScreenChange = () => {
      this.automation?.onScreen();
      this.scheduleFlush();
    };
  }

  start(): void {
    this.send('hello', {
      ...this.sessionInfo,
      systemName: this.systemName,
      devName: this.devName,
      rows: this.client.screen.rows,
      cols: this.client.screen.cols
    });
    if (this.automation) {
      this.send('auto', { phase: 'started' });
      this.automation.start();
    }
    this.client.connect();
  }

  /** Client -> gateway message. */
  handleMessage(raw: unknown): void {
    if (this.closed) return;
    // Any traffic proves the browser (and whatever proxies sit between) is
    // alive: count it for the server-side reap loop, not just app pings.
    (this.ws as unknown as { alive?: boolean }).alive = true;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    const t = msg.t as string;

    if (t === 'key') {
      this.handleKey(msg.k as string, msg.ch as string | undefined, msg);
      return;
    }
    if (t === 'sysreq') {
      this.client.sendSystemRequest(typeof msg.text === 'string' ? msg.text : undefined);
      return;
    }
    if (t === 'ping') {
      // Client keepalive (liveness was already counted above).
      this.send('pong', {});
      return;
    }
    if (t === 'mouseprobe') {
      // GUI-discovery experiment (?mouseprobe=<hex>): forward a candidate
      // mouse/menu AID for the right-clicked cell; see client.sendMouseProbe.
      const aid = Number(msg.aid);
      const r = Number(msg.r);
      const c = Number(msg.c);
      if (Number.isInteger(aid) && Number.isInteger(r) && Number.isInteger(c)) {
        if (!this.client.sendMouseProbe(aid, r, c)) this.beeped = true;
        this.scheduleFlush();
      }
      return;
    }
    if (t === 'diag') {
      // One-click bug reports: raw records + parsed state for this session.
      this.send('diag', { text: this.client.getDiagnostics() });
      return;
    }
  }

  private handleKey(k: string | undefined, ch: string | undefined, msg: Record<string, unknown>): void {
    if (!k) return;
    const screen = this.client.screen;

    // While the launch automation is signing on / pre-filling, browser keys
    // could interleave with injected ones: ignore them (with a beep) until
    // the automation hands over control.
    if (this.automation?.suppressUserKeys) {
      this.beeped = true;
      this.scheduleFlush();
      return;
    }

    // Mouse click: place the cursor at the clicked cell (the screen model
    // applies the same freedom as arrow movement, incl. attribute-cell
    // stepping).
    if (k === 'click') {
      const r = Number(msg.r);
      const c = Number(msg.c);
      if (screen.lock === 'none' && Number.isInteger(r) && Number.isInteger(c)) {
        screen.clickTo(r, c);
      }
      this.scheduleFlush();
      return;
    }

    if (LOCK_SAFE_KEYS.has(k)) {
      if (k === 'reset') {
        this.client.localKey('reset');
      } else if (k === 'sysreq') {
        this.client.sendSystemRequest();
      } else if (k === 'attn') {
        this.client.sendAttention();
      } else if (k === 'print') {
        this.client.sendPrint();
      }
      this.scheduleFlush();
      return;
    }

    if (k === 'help') {
      if (screen.lock === 'none' && screen.waitingForInput) this.client.sendHelp();
      else this.beeped = true;
      this.scheduleFlush();
      return;
    }

    const aid = KEY_TO_AID[k];
    if (aid !== undefined) {
      const ok = this.client.sendAid(aid);
      if (!ok) this.beeped = true;
      this.scheduleFlush();
      return;
    }

    const reject = this.client.localKey(k, ch);
    if (reject) this.beeped = true;
    this.scheduleFlush();
  }

  // ------------------------------------------------------------- outbound
  private send(t: string, body: Record<string, unknown>): void {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t, ...body }));
  }

  private sendStatus(status: string, detail?: string): void {
    this.send('status', { status, detail });
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 16);
  }

  private flush(): void {
    if (this.closed) return;
    const s = this.client.screen;

    if (s.structureDirty) {
      s.structureDirty = false;
      s.dirty.clear();
      this.lastSentCursor = -1;
      this.send('screen', {
        rows: s.rows,
        cols: s.cols,
        cursor: [s.rowOf(s.cursorPos), s.colOf(s.cursorPos)],
        cells: this.encodeCells(0, s.size),
        // Input-field layout so browsers can underline enterable areas.
        // [dataStart, dataCellCount, attr]; bypass fields are not enterable.
        fields: s.fields
          .filter((f) => !f.isBypass)
          .map((f) => [f.dataStart, f.length, f.attr])
      });
      this.sendOia(true);
      this.beeped = false;
      return;
    }

    if (s.dirty.size > 0) {
      const cells = this.encodeDirty();
      s.dirty.clear();
      this.send('update', { cells });
    }

    const cursor = s.cursorPos;
    if (cursor !== this.lastSentCursor) {
      this.lastSentCursor = cursor;
      this.send('update', { cursor: [s.rowOf(cursor), s.colOf(cursor)] });
    }
    this.sendOia(false);

    if (this.beeped) {
      this.beeped = false;
      this.send('update', { beep: true });
    }
  }

  private sendOia(force: boolean): void {
    const s = this.client.screen;
    const oia = s.oia();
    const key = JSON.stringify(oia);
    if (!force && key === this.lastSentOia) return;
    this.lastSentOia = key;
    this.send('oia', { ...oia });
  }

  private encodeDirty(): (number | string)[][] {
    const s = this.client.screen;
    const out: (number | string)[][] = [];
    const sorted = [...s.dirty].sort((a, b) => a - b);
    for (const pos of sorted) out.push(...this.encodeCells(pos, pos + 1));
    return out;
  }

  /**
   * Cells as [pos, attr, ch] triples. Non-display cells (password fields:
   * attrs X'27'/X'2F'/X'37'/X'3F' per 5494 Table 15-10) are blanked before
   * leaving the server so secrets never reach the browser. Underscore attrs
   * (bit 0x04, e.g. 0x25/0x26 prompt fields) are ordinary visible fields.
   * Attribute positions are sent as plain blanks: a real display shows the
   * attribute byte as an unadorned blank, never with the field's video —
   * otherwise a reverse/underscore field appears to start one cell left of
   * the cursor.
   */
  private encodeCells(from: number, to: number): (number | string)[][] {
    const s = this.client.screen;
    const out: (number | string)[][] = [];
    for (let p = from; p < to && p < s.size; p++) {
      const attr = s.attrPlace[p] ? 0x20 : s.attrs[p];
      const ch = C.isNonDisplayAttr(s.attrs[p]) ? ' ' : s.chars[p] === '\u0000' ? ' ' : s.chars[p];
      out.push([p, attr, ch]);
    }
    return out;
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.automation?.destroy();
    devices.release(this.devName);
    this.client.destroy();
    // Server-initiated teardown (host death): close the browser socket too,
    // so no controller-side connection is left dangling. No-op when the
    // browser or the shutdown path closed it first.
    if (this.ws.readyState === 1) this.ws.close(1000, 'session ended');
  }
}
