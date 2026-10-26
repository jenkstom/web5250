// One session pane: a 5250 terminal with its own WebSocket, renderer, OIA
// strip and host-programmed UI, plus a slim header when the shell shows more
// than one pane. The shell (main.ts) owns the chrome - top bar, menu, keypad
// - and routes input to the focused pane; everything that belongs to a
// session lives here.
//
// pane.ts deliberately knows nothing about siblings: the shell decides
// layout, focus and what "Systems" means (which pane the shared system menu
// targets).
import { Terminal, type OiaState } from './term.ts';
import { displayName, loadMeta, type MenuSystem } from './menu.ts';

export interface SessionTarget {
  system?: MenuSystem;
  /** Re-attach token for a live gateway-side session (?attach=). */
  attach?: string;
  /** Share token for a read-only mirror (?view=). */
  view?: string;
}

/** Services the pane borrows from the shell (single instances up there). */
export interface PaneServices {
  /** A left press landed on this pane: it becomes the focused one. */
  onPaneClick(pane: SessionPane): void;
  /** Open the shared right-click menu for this pane. */
  openContextMenu(pane: SessionPane, e: MouseEvent): void;
  /** Open the shared system-selection menu targeting this pane. */
  openSystemMenu(pane: SessionPane): void;
  /** Split this pane in two ('h': side by side, 'v': top and bottom). */
  onSplitPane(pane: SessionPane, dir: 'h' | 'v'): void;
  /** Pop this pane's session out into its own browser window. */
  onPopOut(pane: SessionPane): void;
  /** Copy a view-only share link for this pane's session to the clipboard. */
  onShare(pane: SessionPane): void;
  /** Close (remove) this pane; its session detaches into the grace. */
  onClose(pane: SessionPane): void;
  /** A drag of this pane's header (or tab) started / ended. */
  onPaneDragStart(pane: SessionPane): void;
  onPaneDragEnd(): void;
  /** A dragged pane hovered / left / was dropped onto this pane. The event
   *  carries the position: a drop near an edge splits the pane instead of
   *  swapping (tabs drop without one - always a swap). */
  onPaneDragOver(pane: SessionPane, e?: DragEvent): void;
  onPaneDragLeave(pane: SessionPane): void;
  onPaneDrop(pane: SessionPane, e?: DragEvent): void;
  /** A completed mark (drag release / double-click) - shell copies it. */
  onSelectionCopied(pane: SessionPane): void;
  /** A host-programmed beep: shell keeps the single AudioContext. */
  beep(): void;
  /** Diagnostics text arrived ({t:'diag'}): shell puts it on the clipboard. */
  onDiagnostics(text: string): void;
  /** Session label arrived (hello): shell mirrors it into the top bar. */
  onLabel(pane: SessionPane): void;
  /** Connection state changed: shell mirrors it for the focused pane. */
  onStatus(pane: SessionPane): void;
  /** The pane's re-attach token arrived; the shell records grid state. */
  onToken(pane: SessionPane, token: string, systemId: number | null): void;
  /** A new screen size arrived: the shell refits (it owns the box math). */
  requestFit(pane: SessionPane): void;
  /** Recording state (hello / recstate): shell drives the REC indicator. */
  onRecordState(pane: SessionPane): void;
  /** Automated-launch lifecycle (?auto=1): notify the embedding page. */
  onAutoEnd(reason: string, detail: string): void;
  /** The pane's session is gone (socket closed with no status). */
  onSessionGone(pane: SessionPane): void;
  /** true for the ?auto=1 embedded launch (strict legacy contract). */
  autoLaunch: boolean;
}

interface HostPopup {
  window: [number, number, number, number] | null;
  field: [number, number];
  choices: [number, number, string, number][];
}

type OverlayAction = 'menu' | 'reconnect';

/** Small share glyph (three linked nodes) for the pane header button. */
const SHARE_ICON =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
  'stroke-width="2.6" stroke-linecap="round" aria-hidden="true">' +
  '<circle cx="18" cy="5" r="2.7"/><circle cx="6" cy="12" r="2.7"/><circle cx="18" cy="19" r="2.7"/>' +
  '<line x1="8.5" y1="10.7" x2="15.5" y2="6.6"/><line x1="8.5" y1="13.3" x2="15.5" y2="17.4"/></svg>';

/**
 * What a mirror calls the owner's key presses. Printable characters never
 * arrive as key events (they echo on the screen); everything else gets a
 * name a viewer can read at a glance.
 */
const KEY_LABELS: Record<string, string> = {
  enter: 'Enter',
  clear: 'Clear',
  rollup: 'Roll Up',
  rolldown: 'Roll Down',
  tab: 'Tab',
  btab: 'Backtab',
  fieldexit: 'Field Exit',
  fieldplus: 'Field +',
  fieldminus: 'Field −',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  up: '↑ Up',
  down: '↓ Down',
  left: '← Left',
  right: '→ Right',
  home: 'Home',
  end: 'End',
  sysreq: 'SysReq',
  attn: 'Attn',
  reset: 'Reset',
  print: 'Print',
  help: 'Help'
};
function keyLabel(k: string): string {
  const pf = /^pf(\d{1,2})$/.exec(k);
  if (pf) return `F${pf[1]}`;
  return KEY_LABELS[k] ?? k;
}

export const SESSION_KEY = 'web5250.session';

export class SessionPane {
  readonly el: HTMLDivElement;
  readonly screenEl: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly term: Terminal;
  target: SessionTarget = {};
  token: string | null = null;
  /** Share token: builds the ?view= mirror link anyone can open read-only. */
  shareToken: string | null = null;
  systemId: number | null = null;
  graceMs = 0;
  /** A read-only mirror (?view=): renders the stream, never sends input. */
  viewOnly = false;
  /** Last connection state, mirrored into the top bar while focused. */
  connState = 'idle';
  /** A session beyond the sign-on screen: leaving it would cost something. */
  onSignonScreen = true;

  private readonly labelEl: HTMLElement;
  private readonly barEl: HTMLDivElement;
  private readonly popBtn: HTMLButtonElement;
  private readonly shareBtn: HTMLButtonElement;
  private readonly hostMenuEl: HTMLDivElement;
  private readonly overlayEl: HTMLDivElement;
  private readonly keyEl: HTMLElement;
  private readonly lockEl: HTMLElement;
  private readonly insertEl: HTMLElement;
  private readonly mwEl: HTMLElement;
  private readonly msgEl: HTMLElement;
  private readonly posEl: HTMLElement;

  private ws: WebSocket | null = null;
  private ended = false; // this pane closed its socket deliberately
  private endedByHost = false; // a status message already showed the end overlay
  private signalledEnd = false;
  private hostMouse: Record<string, number> = {};
  private hostPopup: HostPopup | null = null;
  private flashTimer: number | undefined;
  private keyTimer: number | undefined;

  // Remote assist: this socket's lease state and UI. A mirror with
  // ctrlGranted drives the session like the owner (server-enforced).
  ctrlGranted = false;
  private ctrlExpiresAt = 0;
  private ctrlCountdown: number | undefined;
  private assistTimer: number | undefined;
  private assistEl: HTMLDivElement;
  private assistTextEl: HTMLSpanElement;
  private assistBtnEl: HTMLButtonElement;
  private assistAskEl: HTMLDivElement | null = null;
  /** This browser's edge identity (hello 'you'), for naming key events. */
  myIdentity: string | null = null;
  /** Recording: active now / available to start (system opt-in). */
  recording = false;
  recAvailable = false;
  /** Server-side banners (maintenance, assist): stacked, dismissible. */
  private noticeEl: HTMLDivElement;

  // drag-selection state
  private selPressing = false;
  private selAnchor: { r: number; c: number } | null = null;
  private selMarked = false;
  private selRect = false;

  constructor(
    readonly index: number,
    private readonly services: PaneServices
  ) {
    this.el = document.createElement('div');
    this.el.className = 'pane';
    this.el.dataset.pane = String(index);

    this.barEl = document.createElement('div');
    this.barEl.className = 'pane-bar';
    const btn = (cls: string, label: string, tip: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = label;
      b.title = tip;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      // A button press must not steal focus from the typing input on touch.
      b.addEventListener('mousedown', (e) => e.preventDefault());
      return b;
    };
    this.labelEl = document.createElement('span');
    this.labelEl.className = 'pane-label';
    this.labelEl.textContent = `Session ${index + 1}`;
    this.popBtn = btn('pane-popbtn', '↗', 'Move this session out to its own window', () =>
      services.onPopOut(this)
    );
    this.popBtn.disabled = true;
    this.shareBtn = btn('pane-sharebtn', '', 'Copy a link that mirrors this session in a view-only window (anyone with it can watch, not type)', () =>
      services.onShare(this)
    );
    this.shareBtn.innerHTML = SHARE_ICON;
    this.shareBtn.disabled = true;
    this.barEl.append(
      this.labelEl,
      btn('pane-splitbtn-h', '↔', 'Split this pane side by side (left and right)', () =>
        services.onSplitPane(this, 'h')
      ),
      btn('pane-splitbtn-v', '↕', 'Split this pane into top and bottom', () =>
        services.onSplitPane(this, 'v')
      ),
      btn('pane-menubtn', '☰', 'Pick a system for this pane', () => services.openSystemMenu(this)),
      this.shareBtn,
      this.popBtn,
      btn('pane-closebtn', '×', 'Close this pane (an active session is asked for and then ended)', () =>
        services.onClose(this)
      )
    );

    this.screenEl = document.createElement('div');
    this.screenEl.className = 'pane-screen';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'screen-canvas';
    if (index === 0) this.canvas.id = 'screen-canvas'; // single-pane automation hook
    this.hostMenuEl = document.createElement('div');
    this.hostMenuEl.className = 'host-menu hidden';
    if (index === 0) this.hostMenuEl.id = 'host-menu'; // single-pane automation hook
    this.hostMenuEl.setAttribute('aria-label', 'Host menu');
    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'pane-overlay hidden';

    // Remote assist chrome: a slim bar (state + Revoke/Release/Request) and
    // a banner host for server notices. Both are overlays - never painted
    // into the 5250 cell buffer.
    this.assistEl = document.createElement('div');
    this.assistEl.className = 'assist-bar hidden';
    this.assistTextEl = document.createElement('span');
    this.assistTextEl.className = 'assist-text';
    this.assistBtnEl = document.createElement('button');
    this.assistBtnEl.type = 'button';
    this.assistBtnEl.className = 'assist-btn';
    this.assistBtnEl.addEventListener('mousedown', (e) => e.preventDefault());
    this.assistBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.assistAction();
    });
    this.assistEl.append(this.assistTextEl, this.assistBtnEl);
    this.noticeEl = document.createElement('div');
    this.noticeEl.className = 'pane-notices';
    this.screenEl.append(this.canvas, this.hostMenuEl, this.noticeEl, this.assistEl, this.overlayEl);

    const oia = document.createElement('div');
    oia.className = 'oia';
    oia.setAttribute('aria-live', 'polite');
    const left = document.createElement('span');
    left.className = 'oia-left';
    this.lockEl = document.createElement('span');
    this.lockEl.className = 'oia-lock';
    this.insertEl = document.createElement('span');
    this.insertEl.className = 'oia-insert';
    this.mwEl = document.createElement('span');
    this.mwEl.className = 'oia-mw';
    left.append(this.lockEl, this.insertEl, this.mwEl);
    this.msgEl = document.createElement('span');
    this.msgEl.className = 'oia-msg';
    if (index === 0) this.msgEl.id = 'oia-msg';
    const right = document.createElement('span');
    right.className = 'oia-right';
    this.keyEl = document.createElement('span');
    this.keyEl.className = 'oia-key';
    this.posEl = document.createElement('span');
    this.posEl.className = 'oia-pos';
    if (index === 0) this.posEl.id = 'oia-pos';
    right.append(this.keyEl, this.posEl);
    oia.append(left, this.msgEl, right);

    this.el.append(this.barEl, this.screenEl, oia);
    this.term = new Terminal(this.canvas);
    this.wireMouse();
    this.wireDrag();
  }

  /**
   * Drag the pane by its header (or its tab): dropping it on another pane's
   * middle swaps the two, on one of its edges splits that pane's slot with
   * the dragged pane taking that side.
   */
  private wireDrag(): void {
    const { services } = this;
    this.labelEl.title = 'Drag onto a pane to swap, or onto its edge to split';
    this.barEl.draggable = true;
    this.barEl.addEventListener('dragstart', (e) => {
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', String(this.index));
        e.dataTransfer.effectAllowed = 'move';
      }
      services.onPaneDragStart(this);
    });
    this.el.addEventListener('dragend', () => services.onPaneDragEnd());
    this.el.addEventListener('dragover', (e) => {
      e.preventDefault(); // without it the drop never fires
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      services.onPaneDragOver(this, e);
    });
    this.el.addEventListener('dragleave', () => services.onPaneDragLeave(this));
    this.el.addEventListener('drop', (e) => {
      e.preventDefault();
      services.onPaneDrop(this, e);
    });
  }

  // ------------------------------------------------------------- shell API
  get label(): string {
    return this.labelEl.textContent ?? '';
  }

  /** This socket may send host input: the owner, or a viewer holding an assist lease. */
  get canDrive(): boolean {
    return !this.viewOnly || this.ctrlGranted;
  }

  setLabel(label: string): void {
    this.labelEl.textContent = label;
  }

  /** Fit the terminal into a shell-measured box (stage or grid cell). */
  fitInto(w: number, h: number): void {
    this.term.fit(w, h);
  }

  setFocused(focused: boolean): void {
    this.term.focused = focused;
  }

  hasSocket(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  sessionActive(): boolean {
    return this.hasSocket() && !this.onSignonScreen;
  }

  /**
   * Closing this pane must be confirmed once a session is past the sign-on
   * screen - the pane's token dies with it, so even with a gateway grace
   * period the session is gone for good. The sign-on screen (and anything
   * before/after a live session: connecting, ended, never assigned) is free
   * to leave. A view-only mirror never ends anything, so it is always free.
   */
  confirmLeave(): boolean {
    return this.viewOnly || !this.sessionActive() || window.confirm('End the current session?');
  }

  // -------------------------------------------------------------- connect
  connect(target: SessionTarget): void {
    // A reconnect must never orphan the previous socket server-side: detach
    // and close it first.
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.ended = false;
    this.endedByHost = false;
    this.target = target;
    this.viewOnly = !!target.view;
    // A mirror window is chrome-free: the pane header's split/pick/pop/close
    // controls make no sense for a session this page cannot drive.
    this.barEl.classList.toggle('hidden', this.viewOnly);

    const sock = new WebSocket(this.wsUrl());
    this.ws = sock;
    sock.addEventListener('open', () => {
      this.setConnState('connecting');
      this.hideOverlay();
    });
    sock.addEventListener('message', (ev) => this.handleMessage(String(ev.data)));
    sock.addEventListener('close', () => {
      if (this.ws !== sock) return;
      this.ws = null;
      if (this.ended || this.endedByHost) {
        this.ended = false;
        this.endedByHost = false;
        return;
      }
      // Close without a preceding status message (e.g. the upgrade itself
      // was refused): still the end of the launch as far as the embedder
      // cares.
      this.signalSessionEnd('closed', '');
      this.setConnState('closed');
      this.showOverlay('Session ended', 'The 5250 session closed.', ['menu', 'reconnect']);
      this.services.onSessionGone(this);
    });
    sock.addEventListener('error', () => {
      if (this.ws !== sock) return;
      this.setConnState('error');
    });
  }

  /** Reconnect: rebind to the same target (token first, per the gateway). */
  reconnect(): void {
    if (!this.confirmLeave()) return;
    this.connect(this.target);
  }

  /** End the host session outright ({t:'end'} skips the detach grace). */
  end(): void {
    // A mirror never owns the session: leaving it just drops the socket.
    if (this.viewOnly) {
      this.detach();
      return;
    }
    this.ended = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send('{"t":"end"}');
    this.ws?.close();
    this.localCleanup();
  }

  /** Drop the socket without ending the host session (detach + grace). */
  detach(): void {
    this.ended = true; // no end overlay while the pane goes away
    this.ws?.close();
    this.localCleanup();
  }

  private localCleanup(): void {
    sessionStorage.removeItem(SESSION_KEY);
    this.target = {}; // the pane is unassigned again (menu target etc.)
    this.ws = null;
    this.onSignonScreen = true;
    this.viewOnly = false;
    this.shareToken = null;
    this.barEl.classList.remove('hidden');
    window.clearTimeout(this.keyTimer);
    this.keyTimer = undefined;
    this.keyEl.textContent = '';
    window.clearTimeout(this.ctrlCountdown);
    this.ctrlCountdown = undefined;
    window.clearTimeout(this.assistTimer);
    this.assistTimer = undefined;
    this.ctrlGranted = false;
    this.ctrlExpiresAt = 0;
    this.assistEl.classList.add('hidden');
    this.assistAskEl?.remove();
    this.assistAskEl = null;
    this.noticeEl.replaceChildren();
    this.recording = false;
    this.recAvailable = false;
    this.services.onRecordState(this);
    this.hostPopup = null;
    this.renderHostMenu();
    this.term.resizeGrid(24, 80);
    this.setConnState('idle');
    this.token = null;
    this.shareBtn.disabled = true;
    this.systemId = null; // the pane is unassigned again (menu target etc.)
    this.setLabel(`Session ${this.index + 1}`);
    this.popBtn.disabled = true;
  }

  send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendKey(k: string, ch?: string): void {
    if (!this.canDrive) return; // a mirror's keyboard is decorative
    this.term.clearSelection(); // typing abandons a marked region
    if (k === 'char' && ch !== undefined) {
      this.send({ t: 'key', k: 'char', ch });
      return;
    }
    this.send({ t: 'key', k });
  }

  private wsUrl(): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Derive the WS endpoint from the page URL so sub-path deployments
    // (https://host/as400/ -> service) resolve to .../as400/ws automatically.
    const path = window.location.pathname.replace(/[^/]*$/, '');
    const params = new URLSearchParams(window.location.search);
    if (this.target.system) params.set('system', String(this.target.system.id));
    else params.delete('system');
    if (this.target.attach) params.set('attach', this.target.attach);
    else params.delete('attach');
    if (this.target.view) params.set('view', this.target.view);
    else params.delete('view');
    // The browser's saved display name rides along; the gateway appends a
    // numeric suffix automatically when another live session already has it.
    const dev = displayName();
    if (dev) params.set('devname', dev);
    else params.delete('devname');
    const qs = params.toString();
    return `${proto}//${window.location.host}${path}ws${qs ? `?${qs}` : ''}`;
  }

  // ------------------------------------------------------------ messages
  private handleMessage(data: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'diag': {
        const text = String(msg.text ?? '');
        // Also in the console: devtools is a copy path of its own.
        console.info('[diag]', text);
        this.services.onDiagnostics(text);
        break;
      }
      case 'hello': {
        if (msg.viewOnly === true) this.viewOnly = true;
        const parts = [msg.systemName, msg.devName, msg.host, msg.termType].map((v) => String(v ?? ''));
        if (this.viewOnly) parts.push('view-only');
        this.setLabel(parts.filter(Boolean).join(' · '));
        this.setConnState('connecting');
        this.graceMs = typeof msg.graceMs === 'number' ? msg.graceMs : 0;
        if (typeof msg.systemId === 'number') this.systemId = msg.systemId;
        this.myIdentity = typeof msg.you === 'string' && msg.you ? msg.you : null;
        this.recording = msg.recording === true;
        this.recAvailable = msg.recordingAllowed === true;
        this.services.onRecordState(this);
        const assist = msg.assist as { holder?: unknown; expiresAt?: unknown } | null | undefined;
        this.ctrlGranted = false;
        this.ctrlExpiresAt = typeof assist?.expiresAt === 'number' ? assist.expiresAt : 0;
        this.renderAssistBar(typeof assist?.holder === 'string' ? assist.holder : null);
        if (typeof msg.shareToken === 'string' && msg.shareToken) {
          this.shareToken = msg.shareToken;
          this.shareBtn.disabled = false;
        }
        if (typeof msg.sessionToken === 'string' && msg.sessionToken) {
          this.token = msg.sessionToken;
          this.popBtn.disabled = false;
          sessionStorage.setItem(
            SESSION_KEY,
            JSON.stringify({ token: msg.sessionToken, systemId: this.systemId })
          );
          this.services.onToken(this, msg.sessionToken, this.systemId);
        }
        this.services.onLabel(this);
        break;
      }
      case 'status': {
        const status = String(msg.status);
        const detail = typeof msg.detail === 'string' ? msg.detail : '';
        this.setConnState(status);
        if (status === 'connected') {
          this.hideOverlay();
        } else if (status === 'detached') {
          // Exclusive takeover: another window (typically a popped-out pane)
          // now owns the session. The follow-up close must not overwrite.
          this.endedByHost = true;
          sessionStorage.removeItem(SESSION_KEY);
          this.signalSessionEnd('detached', detail);
          this.showOverlay('Session opened elsewhere', detail, ['menu']);
        } else if (status === 'error' || status === 'closed') {
          this.endedByHost = true;
          sessionStorage.removeItem(SESSION_KEY);
          this.signalSessionEnd(status, detail);
          // A re-attach whose token has expired (grace ran out, session ended
          // elsewhere) falls back once to a fresh session on the same system.
          // Without a system to fall back to, show the failure honestly.
          if (status === 'error' && this.target.attach) {
            const system = this.target.system;
            this.target = { system };
            if (system) {
              this.connect(this.target);
              return;
            }
          }
          this.showOverlay(status === 'error' ? 'Connection failed' : 'Session ended', detail, [
            'menu',
            'reconnect'
          ]);
        } else {
          this.showOverlay(status === 'negotiating' ? 'Negotiating with host…' : 'Connecting…', '', []);
        }
        break;
      }
      case 'auto': {
        // Launch automation lifecycle. `ended` precedes the teardown the
        // gateway performs itself (sign-on rejected / screen timeout).
        if (msg.phase === 'ended') {
          this.endedByHost = true;
          const reason = String(msg.reason ?? '');
          const detail = typeof msg.detail === 'string' ? msg.detail : '';
          this.signalSessionEnd(reason, detail);
          this.showOverlay(reason === 'signon-failed' ? 'Sign-on failed' : 'Session ended', detail, [
            'menu',
            'reconnect'
          ]);
        }
        break;
      }
      case 'screen': {
        // The grid may have changed size (24x80 <-> 27x132): the shell refits
        // the CSS box (it derives it from the stage/grid cell, not from the
        // canvas, which is about to be resized).
        this.term.resizeGrid(msg.rows as number, msg.cols as number);
        this.services.requestFit(this);
        this.term.applyCells(msg.cells as (number | string)[][]);
        this.setHostMouse(msg.mouse);
        this.setHostPopup(msg.popup);
        if (Array.isArray(msg.fields)) this.term.setFields(msg.fields as number[][]);
        const cur = msg.cursor as number[];
        this.term.setCursor(cur[0], cur[1]);
        this.posEl.textContent = `${cur[0]},${cur[1]}`;
        // Same marker the gateway's automation uses: QDSIGNON-family screens
        // keep their "Sign On" header until sign-on succeeds (and it returns
        // after a sign-off, where leaving is again free).
        this.onSignonScreen = this.term.text().toLowerCase().includes('sign on');
        break;
      }
      case 'update': {
        if (msg.mouse && typeof msg.mouse === 'object') this.setHostMouse(msg.mouse);
        if ('popup' in msg) this.setHostPopup(msg.popup);
        if (Array.isArray(msg.cells)) {
          // A host-driven change invalidates a marked region (the text under
          // it moved); typing echoes arrive here too, which clears as well.
          if (this.term.hasSelection) this.term.clearSelection();
          this.term.applyCells(msg.cells as (number | string)[][]);
        }
        if (Array.isArray(msg.cursor))
          this.term.setCursor((msg.cursor as number[])[0], (msg.cursor as number[])[1]);
        this.posEl.textContent = `${this.term.cursor[0]},${this.term.cursor[1]}`;
        if (msg.beep === true) {
          this.flash();
          this.services.beep();
        }
        break;
      }
      case 'oia': {
        this.renderOia(msg as unknown as OiaState & { t: string });
        break;
      }
      case 'keyevent': {
        // A non-printing key from the session's other side - the owner for a
        // mirror, or (with a byline) the assist controller for the owner.
        // Printable characters echo on the screen and never arrive here.
        const k = String(msg.k ?? '');
        const by = typeof msg.by === 'string' ? msg.by : '';
        this.showKeyPressed(by ? `${keyLabel(k)} · ${by}` : keyLabel(k));
        break;
      }
      case 'notice': {
        // Server-side banner (maintenance, assist, console signal): chrome
        // overlay, never painted into the 5250 buffer.
        this.showNotice(String(msg.level ?? 'info'), String(msg.message ?? ''));
        break;
      }
      case 'ctrlask': {
        // The owner side of an assist request: consent modal.
        this.showAssistAsk(String(msg.from ?? 'someone'), typeof msg.expiresInMs === 'number' ? msg.expiresInMs : 60000);
        break;
      }
      case 'ctrlreply': {
        // The requester side: granted (bar flips to "you have control") or
        // refused with a reason worth showing.
        if (msg.ok === true) {
          this.ctrlGranted = true;
          this.ctrlExpiresAt = typeof msg.expiresAt === 'number' ? msg.expiresAt : 0;
          this.renderAssistBar(null, 'granted');
        } else {
          this.assistRefused(String(msg.reason ?? 'refused'));
        }
        break;
      }
      case 'ctrlstate': {
        // Lease state for everyone: holder name (or null), expiry, whether
        // this socket is the holder.
        const holder = typeof msg.holder === 'string' && msg.holder ? msg.holder : null;
        this.ctrlExpiresAt = typeof msg.expiresAt === 'number' ? msg.expiresAt : 0;
        if (msg.mine === true) this.ctrlGranted = true;
        else if (!holder) this.ctrlGranted = false;
        this.renderAssistBar(holder, String(msg.reason ?? ''));
        break;
      }
      case 'recstate': {
        // Owner start/stop, or the console removing a live recording.
        this.recording = msg.recording === true;
        this.services.onRecordState(this);
        break;
      }
      case 'openurl': {
        // STRPCCMD from the host asked to open a URI. No prompt of our
        // own: window.open goes through the browser's popup management,
        // which warns the user and lets them allow or block it - exactly
        // the consent path a host-pushed window should take.
        const uri = String(msg.uri ?? '');
        if (/^https?:\/\//i.test(uri)) {
          const win = window.open(uri, '_blank', 'noopener');
          if (!win) console.info('[openurl] blocked by the browser:', uri);
        }
        break;
      }
    }
  }

  // ------------------------------------------------------ viewer key readout
  /** Name the key in the status bar for 2 s - or until the next one. */
  private showKeyPressed(label: string): void {
    if (!label) return;
    this.keyEl.textContent = label;
    window.clearTimeout(this.keyTimer);
    this.keyTimer = window.setTimeout(() => {
      this.keyTimer = undefined;
      this.keyEl.textContent = '';
    }, 2000);
  }

  // ------------------------------------------------------------ notices
  /** Dismissible server banners: info 15 s, warn 45 s, urgent 90 s. */
  private showNotice(level: string, message: string): void {
    if (!message) return;
    const banner = document.createElement('div');
    banner.className = `pane-notice ${level === 'warn' || level === 'urgent' ? level : 'info'}`;
    const text = document.createElement('span');
    text.textContent = message;
    const x = document.createElement('button');
    x.type = 'button';
    x.title = 'Dismiss';
    x.textContent = '×';
    x.addEventListener('click', () => banner.remove());
    banner.append(text, x);
    this.noticeEl.append(banner);
    const ttl = level === 'urgent' ? 90000 : level === 'warn' ? 45000 : 15000;
    window.setTimeout(() => banner.remove(), ttl);
  }

  // ------------------------------------------------------- remote assist
  /** The assist bar's single action button, by role and state. */
  private assistAction(): void {
    if (this.ctrlGranted) {
      this.send({ t: 'ctrlrelease' });
      return;
    }
    if (this.viewOnly) {
      this.send({ t: 'ctrlrequest' });
      this.assistTextEl.textContent = 'Requesting control…';
      this.assistBtnEl.disabled = true;
      return;
    }
    this.send({ t: 'ctrlrevoke' });
  }

  /** Draw the assist bar for whoever this pane is right now. */
  private renderAssistBar(holder: string | null, reason = ''): void {
    window.clearTimeout(this.ctrlCountdown);
    this.ctrlCountdown = undefined;
    this.assistBtnEl.disabled = false;
    const show = (text: string, btn: string, cls = ''): void => {
      this.assistTextEl.textContent = text;
      this.assistBtnEl.textContent = btn;
      this.assistBtnEl.className = `assist-btn ${cls}`.trim();
      this.assistEl.classList.remove('hidden');
    };
    if (this.ctrlGranted) {
      show('', 'Release');
      this.startCtrlCountdown('You have control');
      return;
    }
    if (this.viewOnly) {
      // Idle mirror: offer the request when the gateway allows assist.
      void loadMeta().then((meta) => {
        if (!meta?.assistEnabled || this.ctrlGranted) return;
        show('View-only', 'Request control');
      });
      return;
    }
    if (holder) {
      show(`Control shared with ${holder}`, 'Revoke', 'danger');
      this.startCtrlCountdown(`Control shared with ${holder}`);
      return;
    }
    this.assistEl.classList.add('hidden');
  }

  /** "… mm:ss" countdown until the lease expires (bar text). */
  private startCtrlCountdown(prefix: string): void {
    const tick = (): void => {
      const left = Math.max(0, this.ctrlExpiresAt - Date.now());
      if (left === 0) return; // expiry's ctrlstate clears the bar
      const s = Math.ceil(left / 1000);
      this.assistTextEl.textContent = `${prefix} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      this.ctrlCountdown = window.setTimeout(tick, 1000);
    };
    tick();
  }

  /** The request was refused - name the reason for two seconds. */
  private assistRefused(reason: string): void {
    this.assistEl.classList.remove('hidden');
    this.assistTextEl.textContent =
      reason === 'busy'
        ? 'Someone else already has control'
        : reason === 'no-owner'
          ? 'The session owner is not present'
          : reason === 'blocked'
            ? 'The owner declined and blocked further requests'
            : reason === 'denied'
              ? 'The owner declined'
              : reason === 'pending'
                ? 'Another request is waiting for the owner'
                : reason === 'timeout'
                  ? 'The owner did not answer'
                  : `Control refused (${reason})`;
    this.assistBtnEl.textContent = 'Request control';
    this.assistBtnEl.className = 'assist-btn';
    window.clearTimeout(this.assistTimer);
    this.assistTimer = window.setTimeout(() => this.renderAssistBar(null), 4000);
  }

  /** Owner-side consent modal for an incoming control request. */
  private showAssistAsk(from: string, ttlMs: number): void {
    this.assistAskEl?.remove();
    const card = document.createElement('div');
    card.className = 'assist-ask';
    const p = document.createElement('p');
    p.textContent = `${from} requests control of this session.`;
    const small = document.createElement('small');
    small.textContent = 'They will be able to type on this screen. You keep control and can revoke at any time.';
    const row = document.createElement('div');
    row.className = 'assist-ask-actions';
    const mk = (label: string, cls: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.className = cls;
      b.addEventListener('click', fn);
      return b;
    };
    const done = (): void => {
      card.remove();
      this.assistAskEl = null;
    };
    row.append(
      mk('Grant', 'primary', () => {
        this.send({ t: 'assistreply', accept: true });
        done();
      }),
      mk('Deny', 'ghost', () => {
        this.send({ t: 'assistreply', accept: false });
        done();
      }),
      mk('Deny + block 1h', 'ghost', () => {
        this.send({ t: 'assistreply', accept: false, block: true });
        done();
      })
    );
    card.append(p, small, row);
    this.screenEl.append(card);
    this.assistAskEl = card;
    window.setTimeout(() => {
      if (this.assistAskEl === card) done();
    }, Math.max(5000, Math.min(ttlMs, 60000)));
  }

  /** Owner gesture: start / stop this session's recording. */
  toggleRecording(): void {
    if (this.recording) this.send({ t: 'recstop' });
    else if (this.recAvailable) this.send({ t: 'recstart' });
  }

  // ----------------------------------------------------------------- OIA
  /** The lock indicator flashes while the host beeps. */
  private flash(): void {
    this.lockEl.classList.add('busy');
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => this.lockEl.classList.remove('busy'), 220);
  }

  private renderOia(oia: OiaState): void {
    const lockText: Record<string, string> = {
      system: 'X SYSTEM',
      ii: 'X II',
      prog: 'X PROG',
      comm: 'X COMM'
    };
    this.lockEl.textContent = lockText[oia.lock] ?? '';
    this.lockEl.classList.toggle('busy', oia.lock === 'system' || oia.lock === 'ii');
    this.insertEl.textContent = oia.insert ? '^' : '';
    this.mwEl.textContent = oia.messageWait ? 'MW' : '';
    this.msgEl.textContent = oia.errorCode ? 'Keyboard error - press Reset (Ctrl+R) to continue' : '';
    this.posEl.textContent = `${this.term.cursor[0]},${this.term.cursor[1]}`;
  }

  private setConnState(state: string): void {
    this.connState = state;
    this.services.onStatus(this);
  }

  // ----------------------------------------------- host-programmed mouse
  private setHostMouse(mouse: unknown): void {
    this.hostMouse = {};
    if (mouse && typeof mouse === 'object') {
      for (const [k, v] of Object.entries(mouse as Record<string, unknown>)) {
        if (typeof v === 'number') this.hostMouse[k] = v;
      }
    }
  }

  hostPopupOpen(): boolean {
    return !this.hostMenuEl.classList.contains('hidden');
  }

  /**
   * The host-drawn pull-down menu (DEFINE SELECTION FIELD in a CREATE
   * WINDOW): positioned over this pane's own canvas at its 5250 row/col.
   * With a window frame the server has already drawn the border into the
   * cell buffer, so the overlay is a transparent layer over the work area;
   * without one it keeps a card look anchored at the field.
   */
  private setHostPopup(p: unknown): void {
    this.hostPopup =
      p && typeof p === 'object' && Array.isArray((p as HostPopup).choices) && (p as HostPopup).choices.length > 0
        ? (p as HostPopup)
        : null;
    this.renderHostMenu();
  }

  private renderHostMenu(): void {
    if (!this.hostPopup) {
      this.hostMenuEl.classList.add('hidden');
      this.hostMenuEl.replaceChildren();
      return;
    }
    const cw = this.canvas.clientWidth / this.term.cols;
    const chh = this.canvas.clientHeight / this.term.rows;
    const win = this.hostPopup.window;
    const framed = win !== null;
    this.hostMenuEl.classList.toggle('framed', framed);
    // Framed: the container covers the window work area
    // [row+1, col+3 .. col+width+2] (1-based, per the FR window layout);
    // each choice sits exactly on its own cell. Unframed: anchor at field.
    const baseRow = win ? win[0] + 1 : this.hostPopup.field[0];
    const baseCol = win ? win[1] + 3 : this.hostPopup.field[1];
    this.hostMenuEl.style.left = `${this.canvas.offsetLeft + (baseCol - 1) * cw}px`;
    this.hostMenuEl.style.top = `${this.canvas.offsetTop + (baseRow - 1) * chh}px`;
    if (!framed) this.hostMenuEl.style.minWidth = '6ch';
    else this.hostMenuEl.style.minWidth = '0';
    this.hostMenuEl.style.fontSize = `${Math.max(10, chh * 0.92)}px`;
    this.hostMenuEl.style.lineHeight = `${chh}px`;

    this.hostMenuEl.replaceChildren(
      ...this.hostPopup.choices.map((c, i) => {
        const item = document.createElement('div');
        const state = c[3] & 0xc0;
        item.className = 'host-menu-item';
        if (state === 0x80) item.classList.add('unavailable'); // not selectable
        if (state === 0x40) item.classList.add('selected'); // default selection
        item.textContent = c[2];
        item.title = c[2];
        if (framed && win) {
          item.style.position = 'absolute';
          item.style.left = `${(c[1] - baseCol) * cw}px`;
          item.style.top = `${(c[0] - baseRow) * chh}px`;
          // Highlight up to the interior's right border character.
          item.style.minWidth = `${(win[1] + win[3] + 2 - c[1] + 1) * cw}px`;
        }
        item.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          e.preventDefault();
        });
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          if (state === 0x80 || !this.canDrive) return;
          this.send({ t: 'pick', choice: i + 1 });
        });
        return item;
      })
    );
    this.hostMenuEl.classList.remove('hidden');
  }

  // ------------------------------------------------------------- overlay
  /** Pane-scoped status overlay (connecting / ended / failed). */
  showOverlay(title: string, detail: string, actions: OverlayAction[]): void {
    // Embedded launches have no Systems button to return to; a view-only
    // mirror additionally has no session of its own - Reconnect re-views.
    const acts = this.services.autoLaunch || this.viewOnly ? actions.filter((a) => a !== 'menu') : actions;
    this.overlayEl.replaceChildren();
    const card = document.createElement('div');
    card.className = 'pane-overlay-card';
    const h = document.createElement('h3');
    h.textContent = title;
    const p = document.createElement('p');
    p.className = 'pane-overlay-detail';
    p.textContent = detail;
    card.append(h, p);
    if (acts.length > 0) {
      const row = document.createElement('div');
      row.className = 'pane-overlay-actions';
      for (const a of acts) {
        const b = document.createElement('button');
        b.type = 'button';
        if (a === 'menu') {
          b.textContent = 'Systems';
          b.addEventListener('click', () => this.services.openSystemMenu(this));
        } else {
          b.textContent = 'Reconnect';
          b.addEventListener('click', () => this.reconnect());
        }
        row.append(b);
      }
      card.append(row);
    }
    this.overlayEl.append(card);
    this.overlayEl.classList.remove('hidden');
  }

  hideOverlay(): void {
    this.overlayEl.classList.add('hidden');
  }

  /**
   * One session-end notification per automated launch: the embedding page
   * (Angular) listens for it and removes the iframe. Interactive panes only
   * reach this for the strict ?auto=1 contract.
   */
  private signalSessionEnd(reason: string, detail: string): void {
    if (!this.services.autoLaunch || this.signalledEnd) return;
    this.signalledEnd = true;
    const parentOrigin = new URLSearchParams(window.location.search).get('parentorigin') || '*';
    window.parent.postMessage({ source: 'web5250', type: 'session-end', reason, detail }, parentOrigin);
    this.services.onAutoEnd(reason, detail);
  }

  // --------------------------------------------------------------- mouse
  private wireMouse(): void {
    const hit = (e: MouseEvent): { r: number; c: number } | null => {
      const bounds = this.canvas.getBoundingClientRect();
      return this.term.clickToMessage(e.clientX - bounds.left, e.clientY - bounds.top);
    };
    const hitClamped = (e: MouseEvent): [number, number] => {
      const bounds = this.canvas.getBoundingClientRect();
      return this.term.cellClamped(e.clientX - bounds.left, e.clientY - bounds.top);
    };

    this.screenEl.addEventListener('mousedown', (e) => {
      // The pane's own system picker (split view) manages its inputs and
      // focus itself; a press there only makes this pane the focused one.
      if ((e.target as HTMLElement).closest('.sys-menu')) {
        this.services.onPaneClick(this);
        return;
      }
      // Suppressing the default focus (the tap would close a just-opened
      // soft keyboard on touch); the shell picks the focus target.
      // preventDefault also stops middle-click autoscroll.
      e.preventDefault();
      if (e.button === 0) {
        if (this.hostPopupOpen()) {
          // click dismisses the host pull-down (a mirror keeps watching it)
          if (this.canDrive) this.send({ t: 'pick', choice: 0 });
        } else {
          // Start a possible mark; the previous one (if any) goes away. The
          // click itself is deferred to mouseup, where click-vs-drag is
          // told apart.
          this.selAnchor = hit(e);
          this.selPressing = this.selAnchor !== null;
          this.selMarked = false;
          this.selRect = e.altKey;
          this.term.clearSelection();
        }
      }
      this.services.onPaneClick(this);
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.selPressing || !this.selAnchor) return;
      const [r, c] = hitClamped(e);
      if (!this.selMarked && r === this.selAnchor.r && c === this.selAnchor.c) return;
      if (!this.selMarked) {
        this.selMarked = true;
        this.term.beginSelection(this.selAnchor.r, this.selAnchor.c, this.selRect);
      }
      this.term.extendSelection(r, c);
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button !== 0 || !this.selPressing) return;
      this.selPressing = false;
      const anchor = this.selAnchor;
      this.selAnchor = null;
      if (this.selMarked) {
        this.selMarked = false;
        this.services.onSelectionCopied(this);
        return;
      }
      // Plain click: place the host cursor at the clicked cell (the gateway
      // applies the same freedom as arrow movement). A mirror keeps the
      // click local - its screen is driven by the session's owner.
      if (anchor && this.canDrive) this.send({ t: 'key', k: 'click', r: anchor.r, c: anchor.c });
    });
    // A drag that ends outside the window never sees the mouseup.
    window.addEventListener('blur', () => {
      this.selPressing = false;
      this.selAnchor = null;
    });

    // Host-programmed double click (e.g. the app's zoom function) fires the
    // programmed AID; otherwise the double click marks the word (and copies
    // it, like any completed mark). A mirror never fires host events, so its
    // double click is always the local word mark.
    this.screenEl.addEventListener('dblclick', (e) => {
      const clicked = hit(e);
      if (!clicked) return;
      if (!this.canDrive || this.hostMouse.leftdouble === undefined) {
        this.term.selectWord(clicked.r, clicked.c);
        this.services.onSelectionCopied(this);
        return;
      }
      this.send({ t: 'mouseevent', ev: 'leftdouble', r: clicked.r, c: clicked.c });
    });

    // Right-click: the shell's shared Copy/Paste menu - unless the host
    // programmed this screen's right button (5494 mouse support), where the
    // click is the application's, like on ACS. Shift+right-click keeps the
    // local menu reachable; ?mouseprobe= sends the experiment AID instead.
    this.screenEl.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.sys-menu')) return; // picker has its own
      e.preventDefault();
      const probe = new URLSearchParams(window.location.search).get('mouseprobe');
      const probeAid = (() => {
        const v = Number.parseInt(probe ?? '', 16);
        return Number.isInteger(v) && v >= 0x01 && v <= 0xff ? v : null;
      })();
      if (probeAid !== null) {
        const clicked = hit(e);
        if (clicked) {
          this.send({ t: 'mouseprobe', aid: probeAid, r: clicked.r, c: clicked.c });
          console.info(`[mouseprobe] sent aid 0x${probeAid.toString(16)} at ${clicked.r},${clicked.c}`);
        }
        return;
      }
      if (this.hostMouse.rightdown !== undefined && !e.shiftKey && this.canDrive) {
        const clicked = hit(e);
        if (clicked) this.send({ t: 'mouseevent', ev: 'rightdown', r: clicked.r, c: clicked.c });
        return;
      }
      this.services.openContextMenu(this, e);
    });
  }
}
