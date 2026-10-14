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
import { displayName, type MenuSystem } from './menu.ts';

export interface SessionTarget {
  system?: MenuSystem;
  /** Re-attach token for a live gateway-side session (?attach=). */
  attach?: string;
}

/** Services the pane borrows from the shell (single instances up there). */
export interface PaneServices {
  /** A left press landed on this pane: it becomes the focused one. */
  onPaneClick(pane: SessionPane): void;
  /** Open the shared right-click menu for this pane. */
  openContextMenu(pane: SessionPane, e: MouseEvent): void;
  /** Open the shared system-selection menu targeting this pane. */
  openSystemMenu(pane: SessionPane): void;
  /** Pop this pane's session out into its own browser window. */
  onPopOut(pane: SessionPane): void;
  /** Move this pane one slot left/right in the layout. */
  onMove(pane: SessionPane, dir: -1 | 1): void;
  /** Close (remove) this pane; its session detaches into the grace. */
  onClose(pane: SessionPane): void;
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

export const SESSION_KEY = 'web5250.session';

export class SessionPane {
  readonly el: HTMLDivElement;
  readonly screenEl: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly term: Terminal;
  target: SessionTarget = {};
  token: string | null = null;
  systemId: number | null = null;
  graceMs = 0;
  /** Last connection state, mirrored into the top bar while focused. */
  connState = 'idle';
  /** A session beyond the sign-on screen: leaving it would cost something. */
  onSignonScreen = true;

  private readonly labelEl: HTMLElement;
  private readonly barEl: HTMLDivElement;
  private readonly popBtn: HTMLButtonElement;
  private readonly hostMenuEl: HTMLDivElement;
  private readonly overlayEl: HTMLDivElement;
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
  private zoom = 1;
  private flashTimer: number | undefined;

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
    this.barEl.className = 'pane-bar hidden';
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
    this.barEl.append(
      this.labelEl,
      btn('pane-movebtn', '◀', 'Move this session left', () => services.onMove(this, -1)),
      btn('pane-movebtn', '▶', 'Move this session right', () => services.onMove(this, 1)),
      btn('pane-menubtn', '☰', 'Pick a system for this pane', () => services.openSystemMenu(this)),
      this.popBtn,
      btn('pane-closebtn', '×', 'Close this pane (the session stays available for a while)', () =>
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
    this.screenEl.append(this.canvas, this.hostMenuEl, this.overlayEl);

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
    this.posEl = document.createElement('span');
    this.posEl.className = 'oia-pos';
    if (index === 0) this.posEl.id = 'oia-pos';
    right.append(this.posEl);
    oia.append(left, this.msgEl, right);

    this.el.append(this.barEl, this.screenEl, oia);
    this.term = new Terminal(this.canvas);
    this.wireMouse();
  }

  // ------------------------------------------------------------- shell API
  get label(): string {
    return this.labelEl.textContent ?? '';
  }

  setLabel(label: string): void {
    this.labelEl.textContent = label;
  }

  /** Pane header (and its per-session buttons) only exists in split mode. */
  setShowBar(show: boolean): void {
    this.barEl.classList.toggle('hidden', !show);
  }

  /** Apply the shell's zoom factor (the next fit uses it). */
  setZoom(zoom: number): void {
    this.zoom = zoom;
  }

  /** Fit the terminal into a shell-measured box (stage or grid cell). */
  fitInto(w: number, h: number): void {
    this.term.fit(w * this.zoom, h * this.zoom);
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

  confirmLeave(): boolean {
    return !this.sessionActive() || this.graceMs > 0 || window.confirm('End the current session?');
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
    this.hostPopup = null;
    this.renderHostMenu();
    this.term.resizeGrid(24, 80);
    this.setConnState('idle');
    this.token = null;
    this.systemId = null; // the pane is unassigned again (menu target etc.)
    this.setLabel(`Session ${this.index + 1}`);
    this.popBtn.disabled = true;
  }

  send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendKey(k: string, ch?: string): void {
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
        const parts = [msg.systemName, msg.devName, msg.host, msg.termType].map((v) => String(v ?? ''));
        this.setLabel(parts.filter(Boolean).join(' · '));
        this.setConnState('connecting');
        this.graceMs = typeof msg.graceMs === 'number' ? msg.graceMs : 0;
        if (typeof msg.systemId === 'number') this.systemId = msg.systemId;
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
    }
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
          if (state === 0x80) return;
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
    const acts = this.services.autoLaunch ? actions.filter((a) => a !== 'menu') : actions;
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
      // Suppressing the default focus (the tap would close a just-opened
      // soft keyboard on touch); the shell picks the focus target.
      // preventDefault also stops middle-click autoscroll.
      e.preventDefault();
      if (e.button === 0) {
        if (this.hostPopupOpen()) {
          this.send({ t: 'pick', choice: 0 }); // click dismisses the host pull-down
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
      // applies the same freedom as arrow movement).
      if (anchor) this.send({ t: 'key', k: 'click', r: anchor.r, c: anchor.c });
    });
    // A drag that ends outside the window never sees the mouseup.
    window.addEventListener('blur', () => {
      this.selPressing = false;
      this.selAnchor = null;
    });

    // Host-programmed double click (e.g. the app's zoom function) fires the
    // programmed AID; otherwise the double click marks the word (and copies
    // it, like any completed mark).
    this.screenEl.addEventListener('dblclick', (e) => {
      const clicked = hit(e);
      if (!clicked) return;
      if (this.hostMouse.leftdouble === undefined) {
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
      if (this.hostMouse.rightdown !== undefined && !e.shiftKey) {
        const clicked = hit(e);
        if (clicked) this.send({ t: 'mouseevent', ev: 'rightdown', r: clicked.r, c: clicked.c });
        return;
      }
      this.services.openContextMenu(this, e);
    });
  }
}
