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
//
// On top of that stream sit three cross-cutting features:
//  - Notices: server-side banners ('notice') rendered by the chrome, never
//    painted into the 5250 cell buffer (maintenance windows, assist events).
//  - Remote assist: a viewer can *request control*; the owner consents and
//    the granted viewer gains the owner's input message set for a bounded
//    lease (one controller at a time, owner never loses control, every key
//    origin-tagged so both sides see who is typing).
//  - Recording: when the session's system has recording enabled, a Recorder
//    pseudo-front-end serializes the same outbound stream (already
//    password-blanked) to a JSONL file for later replay.
import type { WebSocket } from 'ws';
import * as C from './tn5250/constants.ts';
import { Tn5250Client } from './tn5250/client.ts';
import type { SocksProxy } from './tn5250/socks.ts';
import type { Config } from './config.ts';
import { makeDeviceName } from './config.ts';
import { devices } from './devices.ts';
import type { SystemRow } from './systems.ts';
import { Automation } from './automation.ts';
import { newSessionToken, registerSession, removeSession } from './sessions.ts';
import type { Audit } from './audit.ts';
import type { Recordings, Recorder } from './recordings.ts';
import type { AdminAuth } from './admin-auth.ts';

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

/** Edge-provided identity + shared services handed to every new session. */
export interface SessionServices {
  /** TRUSTED_USER_HEADER value for the owning browser (Pangolin-injected). */
  identity?: string | null;
  clientIp?: string | null;
  audit?: Audit;
  recordings?: Recordings;
  adminAuth?: AdminAuth;
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

// The owner's input message set - exactly what a control lease grants a
// viewer. 'end' is deliberately absent: an assistant may drive the screen
// but never end the session.
const CONTROL_INPUT = new Set(['key', 'sysreq', 'mouseevent', 'mouseprobe', 'pick']);

// How long an unanswered control request keeps the owner's prompt up.
const ASSIST_REQUEST_TTL_MS = 60_000;
// "Deny + block" cooling-off after an owner refuses control.
const ASSIST_BLOCK_MS = 60 * 60 * 1000;

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
  /** Internal id for admin-console API paths - never a credential. */
  readonly adminId = newSessionToken();
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
  /** Session recorder (system recording enabled); null otherwise. The
   * console can stop it (recording removed by the administrator). */
  recorder: Recorder | null = null;
  /** IBM i user profile, captured from the sign-on screen's Enter. */
  signedOnUser: string | null = null;
  /** Edge identity of the current owning front-end (TRUSTED_USER_HEADER). */
  identity: string | null = null;
  readonly clientIp: string | null;
  readonly startedAt = Date.now();
  lastActivityAt = Date.now();
  /** Last host-facing status, replayed to a re-attaching front-end. */
  lastStatus = 'connecting';
  lastStatusDetail: string | undefined;
  private readonly cfg: Config;
  private readonly audit: Audit | undefined;
  private readonly adminAuth: AdminAuth | undefined;
  private frontends: GatewaySession[] = [];
  private viewers: GatewaySession[] = [];
  private started = false; // client.connect() called exactly once
  private destroyed = false;
  private graceTimer: NodeJS.Timeout | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;
  // Recorder-side stream dedup (mirror of what each front-end tracks).
  private recLastMouse = '';
  private recLastPopup = '';
  /** When the grace period, if armed, runs out (0 = not detached). */
  private graceEndsAt = 0;

  // Remote assist: at most one controller lease, plus one pending request.
  controller: GatewaySession | null = null;
  private controllerName: string | null = null;
  private ctrlExpiresAt = 0;
  private ctrlTimer: NodeJS.Timeout | null = null;
  private ctrlIdleTimer: NodeJS.Timeout | null = null;
  private pendingAssist: { viewer: GatewaySession; name: string; timer: NodeJS.Timeout } | null = null;
  private assistBlockedUntil = 0;

  constructor(cfg: Config, query: SessionQuery, system?: SystemRow, svcs?: SessionServices) {
    this.cfg = cfg;
    this.audit = svcs?.audit;
    this.adminAuth = svcs?.adminAuth;
    this.identity = svcs?.identity ?? null;
    this.clientIp = svcs?.clientIp ?? null;
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

    // The proxy is a property of the system entry (its network position),
    // never of the browser: URL overrides change the host, not the egress.
    const proxy: SocksProxy | undefined = system?.proxyHost
      ? {
          host: system.proxyHost,
          port: system.proxyPort ?? 1080,
          username: system.proxyUser ?? undefined,
          password: system.proxyPass ?? undefined
        }
      : undefined;

    this.client = new Tn5250Client({
      host,
      port,
      ssl,
      proxy,
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
      this.recorder?.event('status', { status: s, detail: detail ?? '' });
      if (s === 'closed' || s === 'error') this.destroy();
    };
    // STRPCCMD: a host application asked the emulator to open something.
    // Policy: only http(s) URIs are ever forwarded (a browser cannot and
    // should not run PC commands), and only to controlling front-ends -
    // read-only mirrors never get windows opened on them.
    this.client.onPcCommand = (command) => this.handlePcCommand(command);
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

    // Recording is a property of the system entry (like the printer session):
    // opt-in per system in the admin editor. Sessions without a menu system
    // (custom hosts) are never recorded.
    this.recorder =
      system?.recording && svcs?.recordings
        ? svcs.recordings.createRecorder({
            systemId: system.id,
            systemName: system.name,
            devName: this.devName,
            identity: this.identity
          })
        : null;
    if (this.recorder) console.log(`[ws] recording session ${this.devName ?? ''} (system ${system!.name})`);

    registerSession(this);
  }

  get screen(): Tn5250Client['screen'] {
    return this.client.screen;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Human name for the owning side of key-event readouts. */
  ownerName(): string {
    return this.identity ?? this.devName ?? 'owner';
  }

  /** The admin console's session row (no tokens - the ids are internal). */
  consoleView(): Record<string, unknown> {
    const grace = this.frontends.length === 0 && this.graceEndsAt > Date.now() ? this.graceEndsAt : null;
    return {
      id: this.adminId,
      system: this.systemName ?? null,
      systemId: this.systemId ?? null,
      devName: this.devName,
      identity: this.identity,
      signedOnUser: this.signedOnUser,
      state: grace ? 'grace' : this.frontends.length > 0 ? 'active' : 'connecting',
      status: this.lastStatus,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      viewers: this.viewers.length,
      assist: this.controllerView,
      recording: Boolean(this.recorder),
      ip: this.clientIp,
      graceEndsAt: grace
    };
  }

  /** STRPCCMD arrived: extract an http(s) URI, forward it to the front-ends. */
  private handlePcCommand(command: string): void {
    const uri = uriFromPcCommand(command);
    if (!uri) {
      console.log(`[ws] pccmd ignored (no http(s) URI): ${command.slice(0, 80)}`);
      return;
    }
    if (!this.cfg.allowHostUrlOpen) {
      console.log(`[ws] pccmd URI suppressed (ALLOW_HOST_URL_OPEN=false): ${uri}`);
      return;
    }
    console.log(`[ws] pccmd open ${uri} -> ${this.frontends.length} front-end(s)`);
    for (const f of this.frontends) f.sendOpenUrl(uri);
  }

  /** True while the launch automation is signing on / pre-filling. */
  get suppressKeys(): boolean {
    return this.automation?.suppressUserKeys ?? false;
  }

  /** Bind a browser socket to this session (exclusive - evicts the previous). */
  attach(ws: WebSocket, identity?: string | null): GatewaySession {
    this.cancelGrace();
    this.graceEndsAt = 0;
    if (identity) this.identity = identity; // the current driver's identity
    const frontend = new GatewaySession(this, ws, false, identity ?? null);
    this.frontends.push(frontend);
    for (const other of [...this.frontends]) {
      if (other !== frontend) other.evict();
    }
    return frontend;
  }

  /**
   * Bind a read-only mirror socket (?view=<share token>). Any number may be
   * attached at once; none of them can drive the session, evict the
   * controlling front-end or extend the grace period - unless the owner
   * granted one a remote-assist control lease.
   */
  attachViewer(ws: WebSocket, identity?: string | null): GatewaySession {
    const viewer = new GatewaySession(this, ws, true, identity ?? null);
    this.viewers.push(viewer);
    return viewer;
  }

  /** A viewer socket went away: nothing else changes. */
  viewerClosed(viewer: GatewaySession): void {
    this.viewers = this.viewers.filter((v) => v !== viewer);
    if (viewer === this.controller) this.releaseControl('left');
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
    this.graceEndsAt = Date.now() + this.graceMs;
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
    this.clearAssistTimers();
    this.controller = null;
    this.controllerName = null;
    this.recorder?.close();
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

  // ---------------------------------------------------------------- notices
  /** Chrome-level banner to owner and every viewer (never painted on 5250). */
  notifyAll(level: string, message: string): void {
    for (const f of this.frontends) f.sendNotice(level, message);
    for (const v of this.viewers) v.sendNotice(level, message);
    this.recorder?.event('notice', { level, message });
  }

  /**
   * The console removed this session's recording: stop the writer and clear
   * every client's REC indicator. The finalization UPDATE races with the
   * row's deletion and must be harmless in either order (the store treats
   * an UPDATE on a deleted row as a no-op).
   */
  stopRecording(): void {
    if (!this.recorder) return;
    const rec = this.recorder;
    this.recorder = null;
    rec.close();
    console.log(`[ws] recording stopped by the console (session ${this.devName ?? ''})`);
    for (const f of this.frontends) f.send('recstate', { recording: false });
    for (const v of this.viewers) v.send('recstate', { recording: false });
  }

  // ---------------------------------------------------------- remote assist
  /**
   * A viewer asked for control. The owner's front-ends get a consent prompt
   * (ctrlask); an admin break-glass token grants immediately instead (audited
   * loudly - consent bypass is an emergency tool, not a convenience).
   */
  requestControl(viewer: GatewaySession, adminToken?: string): void {
    const reply = (ok: boolean, reason: string, extra: Record<string, unknown> = {}): void =>
      viewer.send('ctrlreply', { ok, reason, ...extra });
    if (!this.cfg.assistEnabled) {
      reply(false, 'assist-disabled');
      return;
    }
    if (adminToken !== undefined) {
      if (!this.cfg.adminAssistBreakglass || !this.adminAuth?.authorized(adminToken)) {
        reply(false, 'not-authorized');
        return;
      }
      const name = viewer.identity ?? 'administrator';
      this.audit?.log(name, 'assist.breakglass', this.devName ?? '', 'control granted without owner consent');
      console.log(`[ws] break-glass control of ${this.devName ?? ''} granted to ${name}`);
      this.grantControl(viewer, name);
      return;
    }
    if (this.controller) {
      reply(false, 'busy', { holder: this.controllerName });
      return;
    }
    if (Date.now() < this.assistBlockedUntil) {
      reply(false, 'blocked');
      return;
    }
    if (this.frontends.length === 0) {
      reply(false, 'no-owner');
      return;
    }
    if (this.pendingAssist) {
      reply(false, 'pending');
      return;
    }
    const name = viewer.identity ?? 'a viewer';
    const timer = setTimeout(() => {
      if (this.pendingAssist?.viewer === viewer) {
        this.pendingAssist = null;
        reply(false, 'timeout');
      }
    }, ASSIST_REQUEST_TTL_MS);
    timer.unref();
    this.pendingAssist = { viewer, name, timer };
    this.audit?.log(name, 'assist.request', this.devName ?? '');
    for (const f of this.frontends) f.send('ctrlask', { from: name, expiresInMs: this.cfg.assistMaxMs });
  }

  /** The owner answered the consent prompt (assistreply). */
  assistReply(frontend: GatewaySession, accept: boolean, block: boolean): void {
    if (this.viewers.includes(frontend)) return; // only the owner consents
    const pending = this.pendingAssist;
    if (!pending) return;
    this.pendingAssist = null;
    clearTimeout(pending.timer);
    if (accept) {
      this.audit?.log(pending.name, 'assist.grant', this.devName ?? '', `by ${this.ownerName()}`);
      this.grantControl(pending.viewer, pending.name);
      return;
    }
    pending.viewer.send('ctrlreply', { ok: false, reason: block ? 'blocked' : 'denied' });
    if (block) this.assistBlockedUntil = Date.now() + ASSIST_BLOCK_MS;
    this.audit?.log(pending.name, block ? 'assist.block' : 'assist.deny', this.devName ?? '', `by ${this.ownerName()}`);
  }

  private grantControl(viewer: GatewaySession, name: string): void {
    this.controller = viewer;
    this.controllerName = name;
    this.ctrlExpiresAt = Date.now() + this.cfg.assistMaxMs;
    this.armCtrlIdle();
    this.ctrlTimer = setTimeout(() => this.releaseControl('expired'), this.cfg.assistMaxMs);
    this.ctrlTimer.unref();
    viewer.send('ctrlreply', { ok: true, expiresAt: this.ctrlExpiresAt });
    this.broadcastCtrlState('granted');
    console.log(`[ws] assist: ${name} controls ${this.devName ?? ''} until ${new Date(this.ctrlExpiresAt).toISOString()}`);
  }

  /** End the lease (revoked by owner, released by helper, expired, idle, left). */
  releaseControl(reason: string): void {
    if (!this.controller) return;
    const name = this.controllerName ?? 'helper';
    this.clearAssistTimers();
    this.controller = null;
    this.controllerName = null;
    this.audit?.log(name, `assist.${reason}`, this.devName ?? '');
    this.broadcastCtrlState(reason);
  }

  /** Owner-side revoke ({t:'ctrlrevoke'}): ends the lease immediately. */
  revokeControl(frontend: GatewaySession): void {
    if (this.viewers.includes(frontend) || !this.controller) return;
    this.releaseControl('revoked');
  }

  get controllerView(): { holder: string; expiresAt: number } | null {
    return this.controller ? { holder: this.controllerName ?? 'helper', expiresAt: this.ctrlExpiresAt } : null;
  }

  /** Controller keystroke: push the idle auto-release horizon out again. */
  touchControllerActivity(): void {
    if (this.controller) this.armCtrlIdle();
  }

  private armCtrlIdle(): void {
    if (this.ctrlIdleTimer) clearTimeout(this.ctrlIdleTimer);
    this.ctrlIdleTimer = setTimeout(() => this.releaseControl('idle'), this.cfg.assistIdleMs);
    this.ctrlIdleTimer.unref();
  }

  private clearAssistTimers(): void {
    if (this.ctrlTimer) clearTimeout(this.ctrlTimer);
    if (this.ctrlIdleTimer) clearTimeout(this.ctrlIdleTimer);
    if (this.pendingAssist) {
      clearTimeout(this.pendingAssist.timer);
      this.pendingAssist = null;
    }
    this.ctrlTimer = null;
    this.ctrlIdleTimer = null;
  }

  private broadcastCtrlState(reason: string): void {
    const view = this.controllerView;
    for (const f of this.frontends) f.sendCtrlState(view, false, reason);
    for (const v of this.viewers) v.sendCtrlState(view, v === this.controller, reason);
    this.recorder?.event('ctrl', { holder: view?.holder ?? null, expiresAt: view?.expiresAt ?? null, reason });
  }

  // --------------------------------------------------------- sign-on capture
  /**
   * Capture the IBM i user profile from the sign-on screen as it is
   * submitted: a screen that carries a non-display (password) field and the
   * "Sign On" marker is QDSIGNON-shaped, and its first enterable field holds
   * the user. Heuristic by design - the value names a session in the console
   * and on recordings, nothing more.
   */
  maybeCaptureSignOn(): void {
    if (this.signedOnUser) return;
    const s = this.screen;
    if (!s.fields.some((f) => C.isNonDisplayAttr(f.attr))) return;
    let text = '';
    for (let p = 0; p < s.size; p++) text += s.chars[p];
    if (!text.toLowerCase().includes('sign on')) return;
    const first = s.fields.find((f) => !f.isBypass);
    if (!first) return;
    const user = s.chars
      .slice(first.dataStart, first.dataStart + first.length)
      .join('')
      .trim()
      .toUpperCase()
      .slice(0, 10);
    if (user && /^[A-Z0-9#$@_]+$/.test(user)) {
      this.signedOnUser = user;
      this.recorder?.setSignedOnUser(user);
      console.log(`[ws] session ${this.devName ?? ''} signed on as ${user}`);
    }
  }

  private onScreenChange(): void {
    this.automation?.onScreen();
    this.scheduleBroadcast();
  }

  /**
   * One pending flush for the whole session: the controlling front-end and
   * every viewer watch the same screen, so the diff is computed once and
   * delivered to all of them. (Per-front-end dedup state - cursor, OIA,
   * mouse/popup maps - stays inside each GatewaySession.) The recorder is a
   * pseudo-front-end of the same broadcast: it sees the owner's stream,
   * password-blanked, exactly as a mirror would.
   */
  scheduleBroadcast(): void {
    if (this.broadcastTimer || this.destroyed) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcast();
    }, 16);
  }

  /**
   * Name a key for everyone except its originator: the origin's own browser
   * already knows what it pressed. The origin tag rides along only when an
   * assist controller typed - that is the case a watching owner must know
   * about ("Tab · HELPDESK"); the owner's own keys need no byline (mirrors
   * already watched exactly this stream before assist existed).
   */
  notifyKey(k: string, origin: GatewaySession): void {
    const by = origin === this.controller ? (this.controllerName ?? 'helper') : null;
    for (const f of this.frontends) if (f !== origin) f.sendKeyEvent(k, by);
    for (const v of this.viewers) if (v !== origin) v.sendKeyEvent(k, by);
    // The recording keeps the full attribution either way - evidence, not UI.
    this.recorder?.event('key', { k, by: by ?? this.ownerName() });
  }

  private broadcast(): void {
    const s = this.screen;
    const all = [...this.frontends, ...this.viewers];
    if (s.structureDirty) {
      for (const f of all) f.sendSnapshot();
      if (this.recorder) {
        const payload = screenPayload(s);
        this.recLastMouse = JSON.stringify(payload.mouse ?? {});
        this.recLastPopup = payload.popup ? JSON.stringify(payload.popup) : '';
        this.recorder.snapshot(payload);
      }
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
    if (this.recorder) {
      const payload: Record<string, unknown> = {};
      if (cells) payload.cells = cells;
      if (mouse !== this.recLastMouse) {
        this.recLastMouse = mouse;
        payload.mouse = JSON.parse(mouse);
      }
      if (popup !== this.recLastPopup) {
        this.recLastPopup = popup;
        payload.popup = popup ? JSON.parse(popup) : null;
      }
      this.recorder.delta(payload, [s.rowOf(s.cursorPos), s.colOf(s.cursorPos)]);
      this.recorder.oia(s.oia() as unknown as Record<string, unknown>);
    }
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
    private readonly viewOnly = false,
    /** Edge identity of this socket's browser (TRUSTED_USER_HEADER). */
    readonly identity: string | null = null
  ) {}

  /** True while this socket holds the session's assist control lease. */
  get hasControl(): boolean {
    return this.core.controller === this;
  }

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
        you: this.identity,
        assist: this.core.controllerView,
        rows: this.core.screen.rows,
        cols: this.core.screen.cols
      });
      this.sendStatus(this.core.lastStatus, this.core.lastStatusDetail);
      this.sendCtrlState(this.core.controllerView, this.hasControl, 'hello');
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
      you: this.identity,
      recording: Boolean(this.core.recorder),
      assist: this.core.controllerView,
      signedOnUser: this.core.signedOnUser,
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
      this.sendCtrlState(this.core.controllerView, false, 'hello');
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
    this.core.lastActivityAt = Date.now();

    // A mirror keeps the connection alive and may drive the session *only*
    // through the assist machinery: request control, release it, or - while
    // it holds the lease - the owner's input set minus session-ending
    // messages. Everything else is control of a session this socket does
    // not own.
    if (this.viewOnly) {
      if (t === 'ping') {
        this.send('pong', {});
        return;
      }
      if (t === 'ctrlrequest') {
        this.core.requestControl(this, typeof msg.adminToken === 'string' ? msg.adminToken : undefined);
        return;
      }
      if (t === 'ctrlrelease' && this.hasControl) {
        this.core.releaseControl('released');
        return;
      }
      if (this.hasControl && CONTROL_INPUT.has(t)) {
        if (t === 'sysreq') {
          this.core.touchControllerActivity();
          this.core.client.sendSystemRequest(typeof msg.text === 'string' ? msg.text : undefined);
          this.core.notifyKey('sysreq', this);
          this.core.scheduleBroadcast();
          return;
        }
        this.handleKey(msg.k as string, msg.ch as string | undefined, msg);
        return;
      }
      return;
    }

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
      this.core.notifyKey('sysreq', this);
      return;
    }
    if (t === 'assistreply') {
      this.core.assistReply(this, msg.accept === true, msg.block === true);
      return;
    }
    if (t === 'ctrlrevoke') {
      this.core.revokeControl(this);
      return;
    }
    if (t === 'recpause') {
      // Recording indicator / pause belongs to the owner alone.
      if (this.core.recorder) this.core.recorder.setPaused(msg.on === true);
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
    if (this.hasControl) this.core.touchControllerActivity();

    // While the launch automation is signing on / pre-filling, browser keys
    // could interleave with injected ones: ignore them (with a beep) until
    // the automation hands over control.
    if (this.core.suppressKeys) {
      this.beeped = true;
      this.core.scheduleBroadcast();
      return;
    }

    // Name the key for everyone else: everything that does not echo as text
    // on the screen (Enter, PF keys, Tab, SysReq, ...) helps a viewer - or
    // the other side of an assist pair - keep up; printable characters and
    // cursor-placement clicks are visible already. Broadcast even when the
    // key is about to be rejected - a locked-keyboard attempt is exactly
    // what a watcher wants explained.
    if (k !== 'char' && k !== 'click') this.core.notifyKey(k, this);

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
      // The submit that leaves the sign-on screen names the session's user
      // profile (console lists, recordings) - capture it before it flies.
      if (aid === C.AID_ENTER) this.core.maybeCaptureSignOn();
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
  send(t: string, body: Record<string, unknown>): void {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t, ...body }));
  }

  sendStatus(status: string, detail?: string): void {
    this.send('status', { status, detail });
  }

  /** Chrome-level banner (maintenance, assist): never painted into 5250 cells. */
  sendNotice(level: string, message: string): void {
    this.send('notice', { level, message });
  }

  /** Current assist lease, so late joiners and re-attachments render it. */
  sendCtrlState(view: { holder: string; expiresAt: number } | null, mine: boolean, reason: string): void {
    this.send('ctrlstate', {
      holder: view?.holder ?? null,
      expiresAt: view?.expiresAt ?? null,
      mine,
      reason
    });
  }

  /** STRPCCMD URI: the browser opens it under its own popup management. */
  sendOpenUrl(uri: string): void {
    this.send('openurl', { uri });
  }

  /** Automation lifecycle for the embedding page (?auto=1 contract). */
  sendAuto(phase: 'ended', reason: string, detail: string): void {
    this.send('auto', { phase, reason, detail });
  }

  /** A non-printing key was pressed - name it (with a controller byline) on screen. */
  sendKeyEvent(k: string, by: string | null): void {
    this.send('keyevent', by ? { k, by } : { k });
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
    const payload = screenPayload(s);
    this.lastSentMouse = JSON.stringify(payload.mouse ?? {});
    this.lastSentPopup = payload.popup ? JSON.stringify(payload.popup) : '';
    this.send('screen', payload);
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

/** The full 'screen' wire payload - shared by snapshots and the recorder. */
function screenPayload(s: Screen): Record<string, unknown> {
  return {
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
    mouse: JSON.parse(mouseJson(s)),
    // Host-drawn popup menu (DEFINE SELECTION FIELD), if one is up.
    popup: popupJson(s) ? JSON.parse(popupJson(s)) : null
  };
}

/**
 * The first http(s) URI in a STRPCCMD PCCMD string, or null when the command
 * opens anything else (paths, executables). Hosts wrap the URL in shell
 * incantations - `start <url>`, `explorer <url>`,
 * `rundll32 url.dll,FileProtocolHandler <url>` - but every variant still
 * contains the bare URL, so scanning for it covers them all.
 */
export function uriFromPcCommand(command: string): string | null {
  const m = /\bhttps?:\/\/[^\s"'<>]+/i.exec(command);
  if (!m) return null;
  const uri = m[0].replace(/[),.;:'"]+$/, '');
  return uri.length > 0 && uri.length <= 2048 ? uri : null;
}

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
 * leaving the server so secrets never reach the browser - mirrors and the
 * recorder included. Underscore attrs (bit 0x04, e.g. 0x25/0x26 prompt
 * fields) are ordinary visible fields. Attribute positions are sent as
 * plain blanks: a real display shows the attribute byte as an unadorned
 * blank, never with the field's video - otherwise a reverse/underscore
 * field appears to start one cell left of the cursor.
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
