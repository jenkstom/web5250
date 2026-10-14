// Bridges browser WebSockets to TN5250 client sessions.
//
// The gateway is deliberately thin: the server-side Screen5250 is the single
// source of truth. Browsers send logical key events ('enter', 'pf3', 'char',
// 'fieldexit', ...); local field editing happens server-side; screen diffs
// and OIA state flow back as compact JSON messages.
//
// A session is two pieces: the HostSession core owns the tn5250 client, its
// display-name lease and the launch automation - everything that must
// outlive a browser. GatewaySession is the per-WebSocket front-end that
// attaches to a core and streams it. Detaching (tab close, reload, moving a
// split-view pane into its own window) keeps the core alive for the grace
// period, re-attachable by its token via ?attach=...; a second attach takes
// the session over exclusively from the first front-end. Separately, any
// number of *viewers* can attach read-only via the session's share token
// (?view=...): they receive the same screen stream but no input of theirs is
// accepted, and they neither evict anyone nor keep the session alive.
import type { WebSocket } from 'ws';
import * as C from './tn5250/constants.ts';
import { Tn5250Client } from './tn5250/client.ts';
import type { Config } from './config.ts';
import { makeDeviceName } from './config.ts';
import { devices } from './devices.ts';
import type { SystemRow } from './systems.ts';
import { Automation } from './automation.ts';
import { newSessionToken, registerSession, removeSession } from './sessions.ts';

export interface SessionQuery {
  host?: string;
  port?: number;
  ssl?: boolean;
  termType?: string;
  codePage?: string;
  devName?: string;
  /** Menu selection (?system=<id>) resolved by the HTTP layer. */
  systemId?: number;
  /** Re-attach token (?attach=<token>) for an existing host session. */
  attach?: string;
  /** Share token (?view=<token>): attach as a read-only mirror. */
  view?: string;
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

// ---------------------------------------------------------------- the core
/**
 * The host side of a session: one tn5250 client, its device-name lease and
 * (for ?auto=1 launches) the sign-on automation. Identified by an unguessable
 * token that ?attach= can re-bind to a fresh browser socket. Zero or one
 * front-ends are attached at a time (exclusive); with none attached the
 * session lives for the grace period and is then torn down.
 */
export class HostSession {
  readonly token = newSessionToken();
  /** Read-only mirror key (?view=): grants watching, never control. */
  readonly shareToken = newSessionToken();
  readonly devName: string | null;
  readonly sessionInfo: { host: string; port: number; ssl: boolean; termType: string; codePage: string };
  readonly systemName: string | undefined;
  readonly systemId: number | undefined;
  /**
   * How long the session survives with no front-end attached. Automated
   * launches keep the strict close-equals-teardown contract their embedders
   * rely on, whatever the configured grace. Viewers never extend it.
   */
  readonly graceMs: number;
  readonly client: Tn5250Client;
  readonly automation: Automation | null = null;
  /** Last host-facing status, replayed to a re-attaching front-end. */
  lastStatus = 'connecting';
  lastStatusDetail: string | undefined;
  private frontends: GatewaySession[] = [];
  private viewers: GatewaySession[] = [];
  private started = false; // client.connect() called exactly once
  private destroyed = false;
  private graceTimer: NodeJS.Timeout | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;

  constructor(cfg: Config, query: SessionQuery, system?: SystemRow) {
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
    this.graceMs = query.auto ? 0 : cfg.sessionGraceMs;

    // Requested display names (and even random ones) are made unique across
    // live sessions: a taken name gets a numeric suffix (TOM -> TOM1). The
    // lease is held until the core is destroyed - a detached session keeps
    // its device so the re-attach lands on the same host device.
    const requested = makeDeviceName(system?.devPrefix ?? cfg.devPrefix, query.devName);
    this.devName = devices.allocate(requested);
    if (requested && this.devName && requested !== this.devName) {
      console.log(`[ws] display name ${requested} in use, using ${this.devName}`);
    }
    this.sessionInfo = { host, port, ssl, termType, codePage };
    this.systemName = system?.name;
    this.systemId = system?.id;

    this.client = new Tn5250Client({
      host,
      port,
      ssl,
      tlsRejectUnauthorized: cfg.tlsRejectUnauthorized,
      termType,
      deviceName: this.devName,
      queryMouseGui: cfg.mouseGui,
      traceRecords: cfg.traceRecords,
      codePage
    });
    // Terminal host state (connection failed, host dropped us): tear the
    // session down right away - release the display name and close any
    // browser socket after the status message is queued, so the client
    // learns why before the close event. Without this, a dead host session
    // lingers until page unload and leaks its name (TOM -> TOM1 -> ...).
    this.client.onStatus = (s, detail) => {
      this.lastStatus = s;
      this.lastStatusDetail = detail;
      for (const f of this.frontends) f.sendStatus(s, detail);
      for (const v of this.viewers) v.sendStatus(s, detail);
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
            for (const f of this.frontends) f.sendAuto('ended', reason, detail);
            this.destroy();
          },
          onChange: () => this.onScreenChange()
        }
      );
      console.log(`[ws] auto-launch session (sign-on user ${cfg.autoSignOnUser})`);
    }
    this.client.onScreenChange = () => this.onScreenChange();
    registerSession(this);
  }

  get screen(): Tn5250Client['screen'] {
    return this.client.screen;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** True while the launch automation is signing on / pre-filling. */
  get suppressKeys(): boolean {
    return this.automation?.suppressUserKeys ?? false;
  }

  /** Bind a browser socket to this session (exclusive - evicts the previous). */
  attach(ws: WebSocket): GatewaySession {
    this.cancelGrace();
    const frontend = new GatewaySession(this, ws);
    this.frontends.push(frontend);
    for (const other of [...this.frontends]) {
      if (other !== frontend) other.evict();
    }
    return frontend;
  }

  /**
   * Bind a read-only mirror socket (?view=<share token>). Any number may be
   * attached at once; none of them can drive the session, evict the
   * controlling front-end or extend the grace period.
   */
  attachViewer(ws: WebSocket): GatewaySession {
    const viewer = new GatewaySession(this, ws, true);
    this.viewers.push(viewer);
    return viewer;
  }

  /** A viewer socket went away: nothing else changes. */
  viewerClosed(viewer: GatewaySession): void {
    this.viewers = this.viewers.filter((v) => v !== viewer);
  }

  /** The browser socket went away (close/error): detach, arm the grace. */
  frontendClosed(frontend: GatewaySession): void {
    this.removeFrontend(frontend);
    // Viewers deliberately do not count: a mirror with nobody able to type
    // must not keep a signed-on host session (and its device) alive.
    if (this.frontends.length > 0 || this.destroyed) return;
    if (this.graceMs === 0) {
      this.destroy();
      return;
    }
    const secs = Math.round(this.graceMs / 1000);
    console.log(`[ws] session ${this.devName ?? ''} detached; keeping it for ${secs}s (token ${this.token.slice(0, 8)}…)`);
    this.graceTimer = setTimeout(() => {
      console.log(`[ws] session ${this.devName ?? ''} expired: not re-attached within grace`);
      this.destroy();
    }, this.graceMs);
  }

  /** Explicit end ({t:'end'} or shutdown): no grace, tear down now. */
  end(): void {
    this.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelGrace();
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    removeSession(this.token);
    this.automation?.destroy();
    devices.release(this.devName);
    this.client.destroy();
    // Server-initiated teardown (host death, expiry, explicit end): close any
    // attached browser socket too, so no controller-side connection is left
    // dangling. No-op when the browser or the shutdown path closed it first.
    for (const f of [...this.frontends]) f.sessionDestroyed();
    for (const v of [...this.viewers]) v.sessionDestroyed();
    this.frontends = [];
    this.viewers = [];
  }

  /** First attach drives connect(); later ones replay instead. */
  markStarted(): boolean {
    const first = !this.started;
    this.started = true;
    return first;
  }

  private onScreenChange(): void {
    this.automation?.onScreen();
    this.scheduleBroadcast();
  }

  /**
   * One pending flush for the whole session: the controlling front-end and
   * every viewer watch the same screen, so the diff is computed once and
   * delivered to all of them. (Per-front-end dedup state - cursor, OIA,
   * mouse/popup maps - stays inside each GatewaySession.)
   */
  scheduleBroadcast(): void {
    if (this.broadcastTimer || this.destroyed) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcast();
    }, 16);
  }

  private broadcast(): void {
    const s = this.screen;
    const all = [...this.frontends, ...this.viewers];
    if (s.structureDirty) {
      for (const f of all) f.sendSnapshot();
      s.structureDirty = false;
      s.dirty.clear();
      return;
    }
    const mouse = mouseJson(s);
    const popup = popupJson(s);
    let cells: (number | string)[][] | null = null;
    if (s.dirty.size > 0) {
      cells = encodeDirty(s);
      s.dirty.clear();
    }
    for (const f of all) f.deliver(mouse, popup, cells);
  }

  private removeFrontend(frontend: GatewaySession): void {
    this.frontends = this.frontends.filter((f) => f !== frontend);
  }

  private cancelGrace(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }
}

// ------------------------------------------------------------- the front-end
/** One attached browser socket: diff state + the client->session messages. */
export class GatewaySession {
  private closed = false;
  private lastSentCursor = -1;
  private lastSentOia = '';
  private lastSentMouse = '';
  private lastSentPopup = '';
  private beeped = false;

  constructor(
    private readonly core: HostSession,
    private readonly ws: WebSocket,
    /** Read-only mirror (?view=): streams out, nothing but pings accepted in. */
    private readonly viewOnly = false
  ) {}

  start(): void {
    if (this.viewOnly) {
      // A mirror never drives the session: no connect(), no automation, and
      // crucially no session/share token - the attach token is the session's
      // full-control credential and must not reach a viewer.
      this.send('hello', {
        ...this.core.sessionInfo,
        systemName: this.core.systemName,
        systemId: this.core.systemId,
        devName: this.core.devName,
        viewOnly: true,
        rows: this.core.screen.rows,
        cols: this.core.screen.cols
      });
      this.sendStatus(this.core.lastStatus, this.core.lastStatusDetail);
      this.sendSnapshot();
      return;
    }
    this.send('hello', {
      ...this.core.sessionInfo,
      systemName: this.core.systemName,
      systemId: this.core.systemId,
      devName: this.core.devName,
      sessionToken: this.core.token,
      shareToken: this.core.shareToken,
      graceMs: this.core.graceMs,
      rows: this.core.screen.rows,
      cols: this.core.screen.cols
    });
    if (this.core.markStarted()) {
      if (this.core.automation) {
        this.send('auto', { phase: 'started' });
        this.core.automation.start();
      }
      this.core.client.connect();
    } else {
      // Re-attach to a live session: replay where the host connection stands
      // (no status event will fire for an already-connected client) and the
      // current screen as a full snapshot. The pending diff flags stay put:
      // they are the broadcast's to consume for every other front-end.
      this.sendStatus(this.core.lastStatus, this.core.lastStatusDetail);
      this.sendSnapshot();
    }
  }

  /** Another front-end took the session over: hand it over and hang up. */
  evict(): void {
    if (this.closed) return;
    this.closed = true;
    this.send('status', { status: 'detached', detail: 'The session was opened in another window.' });
    if (this.ws.readyState === 1) this.ws.close(1000, 'detached');
    this.core.frontendClosed(this); // removes only; attach already re-armed
  }

  /** The core died (host, expiry, explicit end): follow it down. */
  sessionDestroyed(): void {
    this.closed = true;
    if (this.ws.readyState === 1) this.ws.close(1000, 'session ended');
  }

  /** Socket close/error from the server side: detach from the core. */
  socketClosed(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.viewOnly) this.core.viewerClosed(this);
    else this.core.frontendClosed(this);
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

    // A mirror only ever keeps the connection alive; every other message is
    // control of a session this socket does not own.
    if (this.viewOnly && t !== 'ping') return;

    if (t === 'end') {
      // Deliberate exit (Systems button, split-view teardown): end the host
      // session now instead of leaving it to the grace period.
      this.core.end();
      return;
    }
    if (t === 'key') {
      this.handleKey(msg.k as string, msg.ch as string | undefined, msg);
      return;
    }
    if (t === 'sysreq') {
      this.core.client.sendSystemRequest(typeof msg.text === 'string' ? msg.text : undefined);
      return;
    }
    if (t === 'ping') {
      // Client keepalive (liveness was already counted above).
      this.send('pong', {});
      return;
    }
    if (t === 'mouseevent') {
      // Host-programmed mouse action (5494 FR): look up the event in the
      // table the host sent; honour the move-cursor flag, then send the
      // programmed AID exactly like the corresponding key press. When no
      // read is pending, a real 5250 latches the AID until one arrives -
      // so send it regardless of the local waiting state (the app's menu
      // flow counts on this: it holds the session without a read invite
      // and expects the next mouse event anyway).
      const EV: Record<string, number> = {
        leftdown: 0x01, leftdouble: 0x03, rightdown: 0x04, rightdouble: 0x06
      };
      const code = EV[String(msg.ev)];
      if (code !== undefined) {
        const screen = this.core.screen;
        const def = screen.mouseButtonFor(code);
        const r = Number(msg.r);
        const c = Number(msg.c);
        if (def && Number.isInteger(r) && Number.isInteger(c)) {
          if (def.moveCursor) screen.clickTo(r, c);
          if (!this.core.client.sendMouseAid(def.aid)) this.beeped = true;
        } else {
          this.beeped = true;
        }
        this.core.scheduleBroadcast();
      }
      return;
    }
    if (t === 'mouseprobe') {
      // GUI-discovery experiment (?mouseprobe=<hex>): forward a candidate
      // mouse/menu AID for the right-clicked cell; see client.sendMouseProbe.
      const aid = Number(msg.aid);
      const r = Number(msg.r);
      const c = Number(msg.c);
      if (Number.isInteger(aid) && Number.isInteger(r) && Number.isInteger(c)) {
        if (!this.core.client.sendMouseProbe(aid, r, c)) this.beeped = true;
        this.core.scheduleBroadcast();
      }
      return;
    }
    if (t === 'pick') {
      // Selection-field pick (host pull-down menu): choice number, 0 when
      // the user dismissed the menu without selecting.
      const choice = Number(msg.choice);
      if (Number.isInteger(choice)) {
        if (!this.core.client.sendSelectionPick(choice)) this.beeped = true;
        this.core.scheduleBroadcast();
      }
      return;
    }
    if (t === 'diag') {
      // One-click bug reports: raw records + parsed state for this session.
      this.send('diag', { text: this.core.client.getDiagnostics() });
      return;
    }
  }

  private handleKey(k: string | undefined, ch: string | undefined, msg: Record<string, unknown>): void {
    if (!k) return;
    const screen = this.core.screen;

    // While the launch automation is signing on / pre-filling, browser keys
    // could interleave with injected ones: ignore them (with a beep) until
    // the automation hands over control.
    if (this.core.suppressKeys) {
      this.beeped = true;
      this.core.scheduleBroadcast();
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
      this.core.scheduleBroadcast();
      return;
    }

    if (LOCK_SAFE_KEYS.has(k)) {
      if (k === 'reset') {
        this.core.client.localKey('reset');
      } else if (k === 'sysreq') {
        this.core.client.sendSystemRequest();
      } else if (k === 'attn') {
        this.core.client.sendAttention();
      } else if (k === 'print') {
        this.core.client.sendPrint();
      }
      this.core.scheduleBroadcast();
      return;
    }

    if (k === 'help') {
      if (screen.lock === 'none' && screen.waitingForInput) this.core.client.sendHelp();
      else this.beeped = true;
      this.core.scheduleBroadcast();
      return;
    }

    const aid = KEY_TO_AID[k];
    if (aid !== undefined) {
      const ok = this.core.client.sendAid(aid);
      if (!ok) this.beeped = true;
      this.core.scheduleBroadcast();
      return;
    }

    const reject = this.core.client.localKey(k, ch);
    if (reject) this.beeped = true;
    this.core.scheduleBroadcast();
  }

  // ------------------------------------------------------------- outbound
  private send(t: string, body: Record<string, unknown>): void {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t, ...body }));
  }

  sendStatus(status: string, detail?: string): void {
    this.send('status', { status, detail });
  }

  /** Automation lifecycle for the embedding page (?auto=1 contract). */
  sendAuto(phase: 'ended', reason: string, detail: string): void {
    this.send('auto', { phase, reason, detail });
  }

  /**
   * The shared broadcast payload (computed once by the core): per-frontend
   * dedup + the parts that are inherently per-frontend (cursor, OIA, beep).
   */
  deliver(mouse: string, popup: string, cells: (number | string)[][] | null): void {
    if (this.closed) return;
    const s = this.core.screen;

    if (mouse !== this.lastSentMouse) {
      this.lastSentMouse = mouse;
      this.send('update', { mouse: JSON.parse(mouse) });
    }

    if (popup !== this.lastSentPopup) {
      this.lastSentPopup = popup;
      this.send('update', { popup: popup ? JSON.parse(popup) : null });
    }

    if (cells && cells.length > 0) {
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

  /**
   * Full screen + OIA: first contact, a re-attach replay, or a structure
   * change the broadcast is flushing. Reads only - the shared pending-diff
   * flags belong to the core's broadcast loop.
   */
  sendSnapshot(): void {
    const s = this.core.screen;
    this.lastSentCursor = -1;
    const mouse = mouseJson(s);
    this.lastSentMouse = mouse;
    const popup = popupJson(s);
    this.lastSentPopup = popup;
    this.send('screen', {
      rows: s.rows,
      cols: s.cols,
      cursor: [s.rowOf(s.cursorPos), s.colOf(s.cursorPos)],
      cells: encodeCells(s, 0, s.size),
      // Input-field layout so browsers can underline enterable areas.
      // [dataStart, dataCellCount, attr]; bypass fields are not enterable.
      fields: s.fields
        .filter((f) => !f.isBypass)
        .map((f) => [f.dataStart, f.length, f.attr]),
      // Host-programmed mouse events: right-click / double-click bindings
      // the browser acts on (local menu otherwise).
      mouse: JSON.parse(mouse),
      // Host-drawn popup menu (DEFINE SELECTION FIELD), if one is up.
      popup: popup ? JSON.parse(popup) : null
    });
    this.sendOia(true);
    this.beeped = false;
  }

  private sendOia(force: boolean): void {
    const s = this.core.screen;
    const oia = s.oia();
    const key = JSON.stringify(oia);
    if (!force && key === this.lastSentOia) return;
    this.lastSentOia = key;
    this.send('oia', { ...oia });
  }
}

// ------------------------------------------------------------ wire encoding
/** The screen type of a tn5250 client, named for the helpers below. */
type Screen = Tn5250Client['screen'];

/** Compact host mouse bindings for the browser: {rightdown: 132, ...}. */
function mouseJson(s: Screen): string {
  const out: Record<string, number> = {};
  const NAME: Record<number, string> = { 0x01: 'leftdown', 0x03: 'leftdouble', 0x04: 'rightdown', 0x06: 'rightdouble' };
  for (const d of s.mouseButtons) {
    const n = NAME[d.event];
    if (n) out[n] = d.aid;
  }
  return JSON.stringify(out);
}

/**
 * Compact GUI popup state for the browser: the DEFINE SELECTION FIELD
 * choice list (with the CREATE WINDOW frame when the host drew one).
 * Empty string when no menu is up; the host re-sends both when paging.
 */
function popupJson(s: Screen): string {
  const sel = s.selection;
  if (!sel) return '';
  const win = s.guiWindow;
  return JSON.stringify({
    window: win ? [win.row, win.col, win.depth, win.width] : null,
    field: [sel.row, sel.col],
    choices: sel.choices.map((c) => [c.row, c.col, c.text, c.state])
  });
}

function encodeDirty(s: Screen): (number | string)[][] {
  const out: (number | string)[][] = [];
  const sorted = [...s.dirty].sort((a, b) => a - b);
  for (const pos of sorted) out.push(...encodeCells(s, pos, pos + 1));
  return out;
}

/**
 * Cells as [pos, attr, ch] triples. Non-display cells (password fields:
 * attrs X'27'/X'2F'/X'37'/X'3F' per 5494 Table 15-10) are blanked before
 * leaving the server so secrets never reach the browser - mirrors included.
 * Underscore attrs (bit 0x04, e.g. 0x25/0x26 prompt fields) are ordinary
 * visible fields. Attribute positions are sent as plain blanks: a real
 * display shows the attribute byte as an unadorned blank, never with the
 * field's video - otherwise a reverse/underscore field appears to start one
 * cell left of the cursor.
 */
function encodeCells(s: Screen, from: number, to: number): (number | string)[][] {
  const out: (number | string)[][] = [];
  for (let p = from; p < to && p < s.size; p++) {
    const attr = s.attrPlace[p] ? 0x20 : s.attrs[p];
    const ch = C.isNonDisplayAttr(s.attrs[p]) ? ' ' : s.chars[p] === '\u0000' ? ' ' : s.chars[p];
    out.push([p, attr, ch]);
  }
  return out;
}
