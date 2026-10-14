// Browser entry point: system menu + WebSocket transport + UI glue.
//
// On first start the connection menu (menu.ts) lists the systems from the
// gateway's SQLite store; picking one opens a WebSocket session targeting
// that system (?system=<id>). Deep links keep working: ?system=<id> jumps
// straight into a session, and legacy ?host=... links (ALLOW_CUSTOM_HOST)
// connect with environment defaults.
import './styles.css';
import { Terminal, type OiaState } from './term.ts';
import { attachKeyboard, mapEvent, type SendKey } from './keyboard.ts';
import { buildKeypad } from './keypad.ts';
import { fetchSystems, hideMenu, initMenu, loadMeta, menuVisible, showMenu, displayName, type MenuSystem } from './menu.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const term = new Terminal($('screen-canvas'));
const mobileInput = $<HTMLInputElement>('mobile-input');

// Automated-launch mode (?auto=1): the gateway signs on with server-held
// credentials and this page is embedded in the caller's iframe. When the
// session ends the parent page is notified via postMessage so it can remove
// the iframe; parentorigin restricts the message target when set.
const launchParams = new URLSearchParams(window.location.search);
const autoLaunch = ['1', 'true'].includes(launchParams.get('auto') ?? '');
const parentOrigin = launchParams.get('parentorigin') || '*';

// GUI-discovery experiment: with ?mouseprobe=<hex> (e.g. ?mouseprobe=5c),
// right-click sends that AID byte to the host with the clicked cell
// attached, instead of opening the Copy/Paste menu. Used to identify which
// mouse/menu AID the host's 5250 GUI orders expect; not for daily use.
const mouseProbeAid = (() => {
  const v = Number.parseInt(launchParams.get('mouseprobe') ?? '', 16);
  return Number.isInteger(v) && v >= 0x01 && v <= 0xff ? v : null;
})();

// Split-view mode (?grid=1..6, optionally &systems=<id>,<id> preassigning
// panes): the page lays out that many independent session panes - same-origin
// iframes of this very app. The gateway gives every WebSocket its own 5250
// device (display names deduped server-side), so each pane is a full session
// with its own menu, zoom and keyboard focus.
const gridPanes = (() => {
  const n = Number.parseInt(launchParams.get('grid') ?? '', 10);
  return n >= 1 && n <= 6 ? n : null;
})();

// ---------------------------------------------------------------- transport
interface SessionTarget {
  system?: MenuSystem;
  /** Re-attach token for a live gateway-side session (?attach= / reloads). */
  attach?: string;
}
let target: SessionTarget = {};
let endingSession = false;

// The gateway hands every session an unguessable token (hello.sessionToken):
// ?attach=<token> re-binds a browser to the running host session. The single
// page keeps the last one in sessionStorage so a reload resumes instead of
// re-signing-on; the split-view parent collects them for its panes.
const SESSION_KEY = 'web5250.session';
let sessionGraceMs = 0;

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Derive the WS endpoint from the page URL so sub-path deployments
  // (https://host/as400/ -> service) resolve to .../as400/ws automatically.
  const path = window.location.pathname.replace(/[^/]*$/, '');
  const params = new URLSearchParams(window.location.search);
  if (target.system) params.set('system', String(target.system.id));
  else params.delete('system');
  if (target.attach) params.set('attach', target.attach);
  else params.delete('attach');
  // The browser's saved display name rides along; the gateway appends a
  // numeric suffix automatically when another live session already has it.
  const dev = displayName();
  if (dev) params.set('devname', dev);
  else params.delete('devname');
  const qs = params.toString();
  return `${proto}//${window.location.host}${path}ws${qs ? `?${qs}` : ''}`;
}

let ws: WebSocket | null = null;
// Set when a terminal status message (host error/closed) already showed the
// end overlay; the follow-up close event must not replace it with the
// generic message.
let sessionEndedByHost = false;
// True until a host screen other than the sign-on display arrives (so also
// while connecting, before any screen): leaving then costs the user nothing.
// Re-checked on every full-screen redraw; partial updates never move to a
// different host screen.
let onSignonScreen = true;

// One session-end notification per automated launch: the embedding page
// (Angular) listens for it and removes the iframe.
let signalledEnd = false;
function signalSessionEnd(reason: string, detail: string): void {
  if (!autoLaunch || signalledEnd) return;
  signalledEnd = true;
  window.parent.postMessage({ source: 'web5250', type: 'session-end', reason, detail }, parentOrigin);
}

// The split-view parent ends its panes' host sessions explicitly when the
// grid exits (a plain socket close would leave them in re-attach grace).
window.addEventListener('message', (e) => {
  const d = e.data as { source?: string; type?: string };
  if (d?.source !== 'web5250' || d?.type !== 'end-session') return;
  endingSession = true;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send('{"t":"end"}');
  ws?.close();
  sessionStorage.removeItem(SESSION_KEY);
});

function sendKey(k: string, ch?: string): void {
  term.clearSelection(); // typing abandons a marked region
  if (k === 'char' && ch !== undefined) {
    send({ t: 'key', k: 'char', ch });
    return;
  }
  send({ t: 'key', k });
}

function send(msg: Record<string, unknown>): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// App-level keepalive: proxies that only track data frames (and mishandle
// WS control frames) keep the tunnel open; the gateway also counts it as
// liveness for its ping loop. The timer must live in a Web Worker: Chrome
// coalesces main-thread timers to ~1/min for hidden tabs and under battery
// saver - even foreground - which outlives the gateway's grace window and
// kills healthy sessions (e.g. reading the keys help with the tab away).
const keepaliveWorker = new Worker(
  URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 25000)'], { type: 'text/javascript' }))
);
keepaliveWorker.onmessage = (): void => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send('{"t":"ping"}');
};

function connect(): void {
  // A reconnect must never orphan the previous socket server-side (e.g. the
  // dead session left open after a host error): detach and close it first.
  const old = ws;
  ws = null;
  old?.close();
  endingSession = false;
  sessionEndedByHost = false;

  const sock = new WebSocket(wsUrl());
  ws = sock;
  signalledEnd = false;
  onSignonScreen = true;

  sock.addEventListener('open', () => {
    setConnState('connecting');
    hideOverlay();
  });
  sock.addEventListener('message', (ev) => handleMessage(String(ev.data)));
  sock.addEventListener('close', () => {
    if (ws !== sock) return;
    ws = null;
    if (endingSession) {
      endingSession = false;
      return;
    }
    if (sessionEndedByHost) {
      sessionEndedByHost = false;
      return;
    }
    // Close without a preceding status message (e.g. the upgrade itself was
    // refused): still the end of the launch as far as the embedder cares.
    signalSessionEnd('closed', '');
    setConnState('closed');
    showOverlay('Session ended', 'The 5250 session closed.', ['menu', 'reconnect']);
  });
  sock.addEventListener('error', () => {
    if (ws !== sock) return;
    setConnState('error');
  });
}

// ------------------------------------------------------------------ messages
function handleMessage(data: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }
  switch (msg.t) {
    case 'diag': {
      const text = String(msg.text ?? '');
      // Also in the console: devtools is a copy path of its own, and it
      // survives even the fallback box below being dismissed too fast.
      console.info('[diag]', text);
      copyText(text, 'Diagnostics');
      break;
    }
    case 'hello': {
      const parts = [msg.systemName, msg.devName, msg.host, msg.termType].map((v) => String(v ?? ''));
      $('dev-info').textContent = parts.filter(Boolean).join(' · ');
      setConnState('connecting');
      // The re-attach token identifies this host session gateway-side: kept
      // for reloads (single page) and reported to a split-view parent so its
      // pane bar can pop the session out into a real browser window.
      sessionGraceMs = typeof msg.graceMs === 'number' ? msg.graceMs : 0;
      if (typeof msg.sessionToken === 'string' && msg.sessionToken) {
        sessionStorage.setItem(
          SESSION_KEY,
          JSON.stringify({ token: msg.sessionToken, systemId: msg.systemId ?? null })
        );
        if (window.parent !== window) {
          const label = [msg.systemName, msg.devName].map((v) => String(v ?? '')).filter(Boolean).join(' · ');
          window.parent.postMessage(
            {
              source: 'web5250',
              type: 'session-token',
              token: msg.sessionToken,
              systemId: typeof msg.systemId === 'number' ? msg.systemId : null,
              label
            },
            parentOrigin
          );
        }
      }
      // Name the window after the session: taskbars/docks then tell
      // split-view panes apart.
      const title = [msg.systemName, msg.devName].map((v) => String(v ?? '')).filter(Boolean).join(' · ');
      if (title) document.title = `${title} · web5250`;
      // Tell a split-view parent who this pane is, so its tab / pane bar can
      // show the system and device name instead of "Session N".
      if (window.parent !== window) {
        const label = [msg.systemName, msg.devName].map((v) => String(v ?? '')).filter(Boolean).join(' · ');
        window.parent.postMessage({ source: 'web5250', type: 'session-info', label }, parentOrigin);
      }
      break;
    }
    case 'status': {
      const status = String(msg.status);
      const detail = typeof msg.detail === 'string' ? msg.detail : '';
      setConnState(status);
      if (status === 'connected') {
        hideOverlay();
      } else if (status === 'detached') {
        // Exclusive takeover: another window (typically a popped-out pane)
        // now owns the session. The follow-up close must not overwrite this.
        sessionEndedByHost = true;
        sessionStorage.removeItem(SESSION_KEY);
        signalSessionEnd('detached', detail);
        showOverlay('Session opened elsewhere', detail, ['menu']);
      } else if (status === 'error' || status === 'closed') {
        sessionEndedByHost = true;
        sessionStorage.removeItem(SESSION_KEY);
        signalSessionEnd(status, detail);
        // A re-attach whose token has expired (grace ran out, session ended
        // elsewhere) falls back once to a fresh session on the same system.
        // Without a system to fall back to, show the failure honestly rather
        // than connecting to whatever the environment default is.
        if (status === 'error' && target.attach) {
          const system = target.system;
          target = { system };
          if (system) {
            connect();
            return;
          }
        }
        showOverlay(status === 'error' ? 'Connection failed' : 'Session ended', detail, ['menu', 'reconnect']);
      } else {
        showOverlay(status === 'negotiating' ? 'Negotiating with host…' : 'Connecting…', '', []);
      }
      break;
    }
    case 'auto': {
      // Launch automation lifecycle. `ended` precedes the teardown the
      // gateway performs itself (sign-on rejected / screen timeout), so the
      // generic close handler must not overwrite this overlay.
      if (msg.phase === 'ended') {
        sessionEndedByHost = true;
        const reason = String(msg.reason ?? '');
        signalSessionEnd(reason, typeof msg.detail === 'string' ? msg.detail : '');
        showOverlay(
          reason === 'signon-failed' ? 'Sign-on failed' : 'Session ended',
          typeof msg.detail === 'string' ? msg.detail : '',
          ['menu', 'reconnect']
        );
      }
      break;
    }
    case 'screen': {
      term.resizeGrid(msg.rows as number, msg.cols as number);
      fitCanvas(); // cell metrics / grid size may have changed -> new fit
      term.applyCells(msg.cells as (number | string)[][]);
      setHostMouse(msg.mouse);
      setHostPopup(msg.popup);
      if (Array.isArray(msg.fields)) term.setFields(msg.fields as number[][]);
      const cur = msg.cursor as number[];
      term.setCursor(cur[0], cur[1]);
      $('oia-pos').textContent = `${cur[0]},${cur[1]}`;
      // Same marker the gateway's automation uses: QDSIGNON-family screens
      // keep their "Sign On" header until sign-on succeeds (and it returns
      // after a sign-off, where leaving is again free).
      onSignonScreen = term.text().toLowerCase().includes('sign on');
      break;
    }
    case 'update': {
      if (msg.mouse && typeof msg.mouse === 'object') setHostMouse(msg.mouse);
      if ('popup' in msg) setHostPopup(msg.popup);
      if (Array.isArray(msg.cells)) {
        // A host-driven change invalidates a marked region (the text under
        // it moved); typing echoes arrive here too, which clears as well.
        if (term.hasSelection) term.clearSelection();
        term.applyCells(msg.cells as (number | string)[][]);
      }
      if (Array.isArray(msg.cursor)) term.setCursor((msg.cursor as number[])[0], (msg.cursor as number[])[1]);
      $('oia-pos').textContent = `${term.cursor[0]},${term.cursor[1]}`;
      if (msg.beep === true) flash();
      break;
    }
    case 'oia': {
      renderOia(msg as unknown as OiaState & { t: string });
      break;
    }
  }
}

// ---------------------------------------------------------------------- OIA
let flashTimer: number | undefined;
function flash(): void {
  const lock = $('oia-lock');
  lock.classList.add('busy');
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => lock.classList.remove('busy'), 220);
  beepAudio();
}

let audioCtx: AudioContext | null = null;
function beepAudio(): void {
  try {
    audioCtx ??= new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.04;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.09);
  } catch {
    /* autoplay policy: silent until first interaction */
  }
}

function renderOia(oia: OiaState): void {
  const lockEl = $('oia-lock');
  const insertEl = $('oia-insert');
  const mwEl = $('oia-mw');
  const msgEl = $('oia-msg');

  const lockText: Record<string, string> = {
    system: 'X SYSTEM',
    ii: 'X II',
    prog: 'X PROG',
    comm: 'X COMM'
  };
  lockEl.textContent = lockText[oia.lock] ?? '';
  lockEl.classList.toggle('busy', oia.lock === 'system' || oia.lock === 'ii');
  insertEl.textContent = oia.insert ? '^' : '';
  mwEl.textContent = oia.messageWait ? 'MW' : '';
  msgEl.textContent = oia.errorCode ? 'Keyboard error - press Reset (Ctrl+R) to continue' : '';
  $('oia-pos').textContent = `${term.cursor[0]},${term.cursor[1]}`;
}

function setConnState(state: string): void {
  const el = $('conn-state');
  el.dataset.state = state;
  el.textContent =
    state === 'connected'
      ? 'connected'
      : state === 'negotiating'
        ? 'negotiating'
        : state === 'connecting'
          ? 'connecting…'
          : state === 'closed'
            ? 'disconnected'
            : state === 'idle'
              ? ''
              : 'error';
}

type OverlayAction = 'menu' | 'reconnect';

// Host-programmed mouse events for the current screen (gateway sends
// {rightdown: 132, leftdouble: 135, ...} - AIDs per the 5494 mouse SF).
let hostMouse: Record<string, number> = {};
function setHostMouse(mouse: unknown): void {
  hostMouse = {};
  if (mouse && typeof mouse === 'object') {
    for (const [k, v] of Object.entries(mouse as Record<string, unknown>)) {
      if (typeof v === 'number') hostMouse[k] = v;
    }
  }
}

// Host-drawn pull-down menu (DEFINE SELECTION FIELD in a CREATE WINDOW,
// both WDSF structured fields): {window: [row,col,depth,width]|null,
// field: [row,col], choices: [[row,col,text,state],...]}.
interface HostPopup {
  window: [number, number, number, number] | null;
  field: [number, number];
  choices: [number, number, string, number][];
}
let hostPopup: HostPopup | null = null;
const hostMenu = $('host-menu');
const hostPopupOpen = (): boolean => !hostMenu.classList.contains('hidden');

function setHostPopup(p: unknown): void {
  hostPopup =
    p && typeof p === 'object' && Array.isArray((p as HostPopup).choices) && (p as HostPopup).choices.length > 0
      ? (p as HostPopup)
      : null;
  renderHostMenu();
}

/**
 * The popup overlays the canvas at its 5250 position, items sized to the
 * cell grid so it reads as part of the screen. With a CREATE WINDOW frame
 * the server has already drawn the border into the cell buffer (5494 FR
 * 15-39), so the overlay is a transparent layer over the window's work
 * area and each choice sits exactly on its own cell; without a window the
 * overlay keeps its own card look, anchored at the field. Items send pick
 * N; it stays up while the host pages (F8/F9) - the gateway re-sends the
 * field and this re-renders.
 */
function renderHostMenu(): void {
  if (!hostPopup) {
    hostMenu.classList.add('hidden');
    hostMenu.replaceChildren();
    return;
  }
  const canvas = $('screen-canvas');
  const cw = canvas.clientWidth / term.cols;
  const chh = canvas.clientHeight / term.rows;
  const win = hostPopup.window;
  const framed = win !== null;
  hostMenu.classList.toggle('framed', framed);
  // Framed: the container covers the window work area
  // [row+1, col+3 .. col+width+2] (1-based, per the FR window layout);
  // each choice is placed on its own cell. Unframed: anchor at the field.
  const baseRow = win ? win[0] + 1 : hostPopup.field[0];
  const baseCol = win ? win[1] + 3 : hostPopup.field[1];
  hostMenu.style.left = `${canvas.offsetLeft + (baseCol - 1) * cw}px`;
  hostMenu.style.top = `${canvas.offsetTop + (baseRow - 1) * chh}px`;
  if (!framed) hostMenu.style.minWidth = '6ch';
  else hostMenu.style.minWidth = '0';
  hostMenu.style.fontSize = `${Math.max(10, chh * 0.92)}px`;
  hostMenu.style.lineHeight = `${chh}px`;

  hostMenu.replaceChildren(
    ...hostPopup.choices.map((c, i) => {
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
        send({ t: 'pick', choice: i + 1 });
      });
      return item;
    })
  );
  hostMenu.classList.remove('hidden');
}

function showOverlay(title: string, detail: string, actions: OverlayAction[]): void {
  // Embedded launches have no menu to go back to: reconnect is the only
  // meaningful action (it replays the automated sign-on).
  const acts = autoLaunch ? actions.filter((a) => a !== 'menu') : actions;
  $('overlay-title').textContent = title;
  $('overlay-detail').textContent = detail;
  $('overlay-actions').classList.toggle('hidden', acts.length === 0);
  $('overlay-menu').classList.toggle('hidden', !acts.includes('menu'));
  $('overlay-action').classList.toggle('hidden', !acts.includes('reconnect'));
  $('overlay').classList.remove('hidden');
}
function hideOverlay(): void {
  $('overlay').classList.add('hidden');
}

// Clipboard with a fallback for non-secure origins: the async clipboard
// API only exists on HTTPS (or localhost), and on plain HTTP the old
// `navigator.clipboard?.writeText(x).then(...)` shape threw silently -
// the optional chain guards the call, not the .then on its undefined
// result. Where the API is missing (or refuses), the text is offered in
// a selectable box instead.
function copyText(text: string, label: string): void {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(() => window.alert(`${label} (${text.length} chars) copied to clipboard.`))
      .catch(() => showCopyFallback(text, label));
    return;
  }
  showCopyFallback(text, label);
}
function showCopyFallback(text: string, label: string): void {
  $('copy-label').textContent = `${label} - select all and copy (the browser blocked clipboard access on this insecure origin):`;
  const box = $<HTMLTextAreaElement>('copy-text');
  box.value = text;
  $('copy-fallback').classList.remove('hidden');
  box.focus();
  box.select();
}
$('copy-close').addEventListener('click', () => $('copy-fallback').classList.add('hidden'));

// Drag-selection copies silently (a dialog per copy would be maddening);
// a brief toast confirms it. execCommand('copy') inside the mouseup gesture
// still works on plain-HTTP origins where the async clipboard API is
// missing or refuses - only when even that fails does the selectable
// fallback box above appear.
let toastTimer: number | undefined;
function showCopiedToast(chars: number): void {
  const toast = $('copy-toast');
  toast.textContent = `${chars} characters copied`;
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 1600);
}
function copySelection(): void {
  const text = term.selectionText();
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => showCopiedToast(text.length), () => copySelectionFallback(text));
    return;
  }
  copySelectionFallback(text);
}
function copySelectionFallback(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  if (ok) showCopiedToast(text.length);
  else showCopyFallback(text, 'Selected text');
}

// ------------------------------------------------------------ leave guard
/** True while leaving/restarting would kill a session the user signed on to. */
function sessionActive(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN && !onSignonScreen;
}

/** Gate for buttons that tear the session down; no-op once it already ended. */
function confirmLeave(): boolean {
  return !sessionActive() || window.confirm('End the current session?');
}

// Closing the tab or navigating away drops the host session with no sign-off;
// the browser renders the prevented unload as its own leave/stay prompt.
// With a gateway grace period the session survives the drop and is offered
// again on reload, so leaving costs nothing and must not nag. Embedded
// launches (?auto=1) are torn down by the parent page, so they stay out of
// this either way.
if (!autoLaunch) {
  window.addEventListener('beforeunload', (e) => {
    if (!sessionActive() || sessionGraceMs > 0) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

// ------------------------------------------------------------ session flow
function startSession(system: MenuSystem): void {
  target = { system };
  endingSession = false;
  hideMenu();
  // Embedded data-entry launches stay locked into their session: there is
  // no menu to return to behind the iframe.
  if (!autoLaunch) $('btn-systems').classList.remove('hidden');
  setZoomButtonsVisible(!autoLaunch);
  showOverlay('Connecting…', '', []);
  connect();
}

/** Close the current session (if any) and go back to the system menu. */
function endSession(): void {
  endingSession = true;
  // Deliberate exit ends the host session outright - {t:'end'} skips the
  // re-attach grace the socket close alone would get.
  if (ws && ws.readyState === WebSocket.OPEN) ws.send('{"t":"end"}');
  ws?.close();
  mobileInput.blur(); // put the soft keyboard away before the menu shows
  sessionStorage.removeItem(SESSION_KEY);
  hideOverlay();
  setConnState('idle');
  $('dev-info').textContent = '';
  term.resizeGrid(24, 80); // blank the canvas for the next session
  hostPopup = null;
  renderHostMenu();
  $('btn-systems').classList.add('hidden');
  setZoomButtonsVisible(false);
  void showMenu(startSession);
}

/** Landing logic: deep links jump straight into a session, everyone else gets the menu. */
function boot(): void {
  if (gridPanes) {
    bootGrid(gridPanes);
    return;
  }
  const params = new URLSearchParams(window.location.search);
  const sysId = Number.parseInt(params.get('system') ?? '', 10);
  const attachToken = params.get('attach');
  if (attachToken) {
    // ?attach=<token>[&system=<id>]: re-bind to the running gateway-side
    // session (pop-out window, reloaded page). If the token has expired the
    // status-error handler falls back once to a fresh session on the system.
    const begin = (): void => {
      if (!autoLaunch) $('btn-systems').classList.remove('hidden');
      setZoomButtonsVisible(!autoLaunch);
      showOverlay('Reconnecting…', '', []);
      connect();
    };
    if (Number.isInteger(sysId) && sysId > 0) {
      fetchSystems()
        .then((rows) => {
          const row = rows.find((r) => r.id === sysId);
          target = { system: row, attach: attachToken };
          begin();
        })
        .catch(() => {
          target = { attach: attachToken };
          begin();
        });
    } else {
      target = { attach: attachToken };
      begin();
    }
    return;
  }
  if (Number.isInteger(sysId) && sysId > 0) {
    fetchSystems()
      .then((rows) => {
        const row = rows.find((r) => r.id === sysId);
        if (row) startSession(row);
        else void showMenu(startSession);
      })
      .catch(() => void showMenu(startSession));
    return;
  }
  if (params.has('host') || autoLaunch) {
    // Legacy custom-host deep link (?host=...&port=... with ALLOW_CUSTOM_HOST),
    // or an automated launch (?auto=1) without a ?system= selection: connect
    // straight to the environment-default host - a menu has no role embedded.
    target = {};
    if (!autoLaunch) $('btn-systems').classList.remove('hidden');
    setZoomButtonsVisible(!autoLaunch);
    showOverlay('Connecting…', '', []);
    connect();
    return;
  }
  // No deep link: a page reload of a plain session resumes the previous one
  // (sessionStorage token) instead of dropping the user at the menu.
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as {
      token?: string;
      systemId?: number | null;
    } | null;
    if (saved?.token) {
      const begin = (system?: MenuSystem): void => {
        target = { system, attach: saved.token };
        if (!autoLaunch) $('btn-systems').classList.remove('hidden');
        setZoomButtonsVisible(!autoLaunch);
        showOverlay('Reconnecting…', '', []);
        connect();
      };
      if (saved.systemId) {
        fetchSystems()
          .then((rows) => begin(rows.find((r) => r.id === saved.systemId)))
          .catch(() => begin());
      } else begin();
      return;
    }
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
  }
  void showMenu(startSession);
}

// ---------------------------------------------------------------- split view
/** The page URL without the split-view params (pane URLs / exit target). */
function urlWithoutGrid(system?: number): string {
  const u = new URL(window.location.href);
  u.searchParams.delete('grid');
  u.searchParams.delete('systems');
  if (system !== undefined) u.searchParams.set('system', String(system));
  else u.searchParams.delete('system');
  return u.href;
}

interface GridPane {
  wrap: HTMLDivElement;
  title: HTMLElement;
  tab: HTMLButtonElement;
  frame: HTMLIFrameElement;
  /** Gateway re-attach token, reported by the pane once its session is up. */
  token: string | null;
  /** Menu system the pane was (re)assigned to, for pop-out URLs / grid state. */
  systemId: number | null;
  popBtn: HTMLButtonElement;
}
/** Built once per split-view page; empty outside ?grid= mode. */
const gridPaneList: GridPane[] = [];
/**
 * Visual sequence of panes. The panes themselves never move in the DOM -
 * re-inserting an iframe reloads it and kills its session - so rearranging
 * rewrites CSS `order` on the fixed wrappers (tiles layout) and re-appends
 * the tab buttons (tab strip), and tabs view merely toggles `display`, which
 * pauses an iframe's painting but not its WebSocket.
 */
let gridOrder: GridPane[] = [];
let gridTabsMode = false;
let gridActivePane: GridPane | null = null;
let dragPane: GridPane | null = null;

const GRID_VIEW_KEY = 'web5250.gridview';
const GRID_TAB_KEY = 'web5250.gridtab';
/**
 * Pane layout + live session tokens, so a reload of the grid page reattaches
 * every pane to its still-running gateway-side session instead of starting
 * over (and the pop-out buttons have their tokens right after a reload).
 */
const GRID_STATE_KEY = 'web5250.gridstate';
const MAX_PANES = 6;

function saveGridState(): void {
  localStorage.setItem(
    GRID_STATE_KEY,
    JSON.stringify(gridPaneList.map((p) => ({ system: p.systemId, token: p.token })))
  );
}

function loadGridState(): { system: number | null; token: string | null }[] {
  try {
    const raw = JSON.parse(localStorage.getItem(GRID_STATE_KEY) ?? '[]') as {
      system?: number | null;
      token?: string | null;
    }[];
    if (!Array.isArray(raw)) return [];
    return raw.map((p) => ({
      system: typeof p.system === 'number' ? p.system : null,
      token: typeof p.token === 'string' && p.token ? p.token : null
    }));
  } catch {
    return [];
  }
}

/**
 * Replace the single-session UI with N independent panes. Each pane is this
 * same app in an iframe (without the split params - a pane must never spawn
 * its own grid): `?systems=<id>,<id>` deep links the matching pane, a saved
 * grid state reattaches them to their old sessions, the rest boot into the
 * system menu for a per-pane pick. One WebSocket and one 5250 device per
 * pane; the gateway dedupes the shared display name (TOM → TOM1).
 */
function bootGrid(n: number): void {
  $('app').classList.add('hidden');
  $('grid').classList.remove('hidden');
  const preassigned = launchParams
    .get('systems')
    ?.split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((v) => Number.isInteger(v) && v > 0);
  const saved = loadGridState();
  for (let i = 0; i < n; i++) {
    // Explicit ?systems= preassignment wins over the saved state (a shared
    // deep link should not resurrect someone else's panes).
    const system = preassigned?.[i] ?? saved[i]?.system ?? null;
    createPane({ system, attach: preassigned ? undefined : saved[i]?.token ?? undefined });
  }

  // Pane labels and session tokens arrive from the panes themselves: the
  // hello handler posts them up to the parent.
  window.addEventListener('message', (e) => {
    const d = e.data as { source?: string; type?: string; label?: string; token?: unknown; systemId?: unknown };
    if (d?.source !== 'web5250') return;
    const pane = gridPaneList.find((p) => p.frame.contentWindow === e.source);
    if (!pane) return;
    if (d.type === 'session-info' && typeof d.label === 'string') {
      pane.title.textContent = d.label;
      pane.tab.textContent = d.label;
    } else if (d.type === 'session-token' && typeof d.token === 'string' && d.token) {
      pane.token = d.token;
      if (typeof d.systemId === 'number') pane.systemId = d.systemId;
      pane.popBtn.disabled = false;
      saveGridState();
    }
  });

  gridTabsMode = localStorage.getItem(GRID_VIEW_KEY) === 'tabs';
  const savedTab = Number.parseInt(localStorage.getItem(GRID_TAB_KEY) ?? '', 10);
  gridActivePane = gridPaneList[Number.isInteger(savedTab) && savedTab >= 0 && savedTab < gridPaneList.length ? savedTab : 0] ?? null;
  $('grid-view-tiles').addEventListener('click', () => setGridView(false));
  $('grid-view-tabs').addEventListener('click', () => setGridView(true));
  $('grid-view-tiles').classList.toggle('active', !gridTabsMode);
  $('grid-view-tabs').classList.toggle('active', gridTabsMode);
  $('grid-add').addEventListener('click', () => {
    if (gridPaneList.length < MAX_PANES) createPane();
  });
  updateAddButton();
  applyGridOrder();
  applyGridView();

  $('grid-exit').addEventListener('click', () => {
    // Exiting split view is deliberate: end every pane's host session now
    // ({t:'end'} skips the detach grace) instead of leaving them to expire.
    for (const p of gridPaneList) {
      p.frame.contentWindow?.postMessage({ source: 'web5250', type: 'end-session' }, '*');
    }
    localStorage.removeItem(GRID_STATE_KEY);
    window.setTimeout(() => {
      window.location.href = urlWithoutGrid();
    }, 200);
  });
}

/** One pane: bar (title, move, pop-out, close) + the session iframe + a tab. */
function createPane(init: { system?: number | null; attach?: string } = {}): void {
  const panes = $('grid-panes');
  const tabbar = $('grid-tabbar');
  const index = gridPaneList.length;
  const pane: GridPane = {
    wrap: document.createElement('div'),
    title: document.createElement('span'),
    tab: document.createElement('button'),
    frame: document.createElement('iframe'),
    token: null,
    systemId: init.system ?? null,
    popBtn: document.createElement('button')
  };
  pane.wrap.className = 'grid-pane';
  const bar = document.createElement('div');
  bar.className = 'grid-pane-bar';
  bar.title = 'Drag to move this session';
  bar.draggable = true;
  pane.title.className = 'gp-title';
  pane.title.textContent = `Session ${index + 1}`;
  const paneBtn = (label: string, tip: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = tip;
    b.addEventListener('click', fn);
    return b;
  };
  pane.popBtn = paneBtn('↗', 'Move this session out to its own window', () => popOut(pane));
  pane.popBtn.disabled = true; // enabled when the pane reports its token
  bar.append(
    pane.title,
    paneBtn('◀', 'Move this session left', () => movePane(pane, -1)),
    paneBtn('▶', 'Move this session right', () => movePane(pane, 1)),
    pane.popBtn,
    paneBtn('×', 'Close this pane (the session stays available for a while)', () => closePane(pane))
  );
  // ?attach= reattaches to the previous session after a reload; ?system=
  // is the fallback (and the deep-link assignment) when it no longer exists.
  const url = new URL(urlWithoutGrid(init.system ?? undefined));
  if (init.attach) url.searchParams.set('attach', init.attach);
  pane.frame.src = url.href;
  pane.frame.title = `5250 session ${index + 1}`;
  // Copy screen / Paste inside each pane need the clipboard permission
  // granted to iframes explicitly.
  pane.frame.setAttribute('allow', 'clipboard-read; clipboard-write');
  pane.wrap.append(bar, pane.frame);
  panes.appendChild(pane.wrap);
  pane.tab.type = 'button';
  pane.tab.className = 'grid-tab';
  pane.tab.textContent = pane.title.textContent;
  pane.tab.title = 'Show this session';
  pane.tab.draggable = true;
  pane.tab.addEventListener('click', () => showTab(pane));
  tabbar.appendChild(pane.tab);
  gridPaneList.push(pane);
  gridOrder.push(pane);
  panes.dataset.panes = String(gridPaneList.length);
  wirePaneDrag(pane);
  updateAddButton();
  saveGridState();
  applyGridOrder();
}

function updateAddButton(): void {
  const add = $<HTMLButtonElement>('grid-add');
  add.disabled = gridPaneList.length >= MAX_PANES;
  add.title = gridPaneList.length >= MAX_PANES ? `At most ${MAX_PANES} panes` : 'Add a session pane';
}

/** Move a pane one slot left/right in the visual sequence. */
function movePane(pane: GridPane, dir: -1 | 1): void {
  const from = gridOrder.indexOf(pane);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= gridOrder.length) return;
  gridOrder.splice(from, 1);
  gridOrder.splice(to, 0, pane);
  applyGridOrder();
}

/** Drop a dragged pane onto another pane's slot (insert-at-position). */
function reorderPane(src: GridPane, dst: GridPane): void {
  if (src === dst) return;
  const from = gridOrder.indexOf(src);
  const to = gridOrder.indexOf(dst);
  if (from < 0 || to < 0) return;
  gridOrder.splice(from, 1);
  gridOrder.splice(to, 0, src);
  applyGridOrder();
}

/** Move a pane's session out to a real browser window (and drop the pane). */
function popOut(pane: GridPane): void {
  if (!pane.token) return;
  const url = new URL(urlWithoutGrid(pane.systemId ?? undefined));
  url.searchParams.set('attach', pane.token);
  // window.open must run inside the click gesture or the popup blocker eats
  // it; the grid parent (not the pane) opens, so a blocked popup is caught.
  const win = window.open(url.href, 'web5250', 'popup=yes,width=1000,height=680');
  if (!win) {
    window.alert('The browser blocked the pop-up window. Allow pop-ups for this site and try again.');
    return;
  }
  // The session itself is safe: the new window attaches to the same token,
  // which detaches (and then closes) this pane's front-end server-side.
  closePane(pane);
}

/** Remove a pane; its session detaches and stays re-attachable in grace. */
function closePane(pane: GridPane): void {
  const i = gridPaneList.indexOf(pane);
  if (i < 0) return;
  gridPaneList.splice(i, 1);
  const o = gridOrder.indexOf(pane);
  if (o >= 0) gridOrder.splice(o, 1);
  if (gridActivePane === pane) {
    gridActivePane = gridPaneList[o] ?? gridPaneList[gridPaneList.length - 1] ?? null;
    if (gridActivePane) localStorage.setItem(GRID_TAB_KEY, String(gridPaneList.indexOf(gridActivePane)));
  }
  pane.frame.src = 'about:blank'; // stops the pane without reloading others
  pane.wrap.remove();
  pane.tab.remove();
  $('grid-panes').dataset.panes = String(gridPaneList.length);
  if (gridPaneList.length === 0) {
    localStorage.removeItem(GRID_STATE_KEY);
    window.location.href = urlWithoutGrid();
    return;
  }
  updateAddButton();
  saveGridState();
  applyGridOrder();
  applyGridView();
}

function applyGridOrder(): void {
  const tabbar = $('grid-tabbar');
  gridOrder.forEach((pane, pos) => {
    pane.wrap.style.order = String(pos);
    tabbar.appendChild(pane.tab); // re-append = strip order
  });
}

function showTab(pane: GridPane): void {
  gridActivePane = pane;
  localStorage.setItem(GRID_TAB_KEY, String(gridPaneList.indexOf(pane)));
  applyGridView();
  // Hand the keyboard straight to the newly shown session.
  pane.frame.contentWindow?.focus();
}

function setGridView(tabs: boolean): void {
  gridTabsMode = tabs;
  if (tabs) localStorage.setItem(GRID_VIEW_KEY, 'tabs');
  else localStorage.removeItem(GRID_VIEW_KEY);
  $('grid-view-tiles').classList.toggle('active', !tabs);
  $('grid-view-tabs').classList.toggle('active', tabs);
  applyGridView();
}

function applyGridView(): void {
  $('grid-tabbar').classList.toggle('hidden', !gridTabsMode);
  $('grid-panes').classList.toggle('tabs', gridTabsMode);
  for (const p of gridPaneList) {
    p.tab.classList.toggle('active', gridTabsMode && p === gridActivePane);
    p.wrap.style.display = gridTabsMode && p !== gridActivePane ? 'none' : '';
  }
}

/** Drag & drop for both the pane bars (tiles) and the tabs; same swap. */
function wirePaneDrag(pane: GridPane): void {
  const start = (e: DragEvent): void => {
    dragPane = pane;
    if (e.dataTransfer) {
      e.dataTransfer.setData('text/plain', String(gridPaneList.indexOf(pane)));
      e.dataTransfer.effectAllowed = 'move';
    }
    $('grid-panes').classList.add('dragging');
  };
  const end = (): void => {
    dragPane = null;
    $('grid-panes').classList.remove('dragging');
    for (const p of gridPaneList) {
      p.wrap.classList.remove('drop-target');
      p.tab.classList.remove('drop-target');
    }
  };
  const target = (el: HTMLElement): void => {
    el.addEventListener('dragover', (e) => {
      if (dragPane === null || dragPane === pane) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop-target');
      if (dragPane !== null) reorderPane(dragPane, pane);
    });
  };
  pane.wrap.addEventListener('dragstart', start); // fired by the bar, bubbles
  pane.tab.addEventListener('dragstart', start);
  pane.wrap.addEventListener('dragend', end);
  pane.tab.addEventListener('dragend', end);
  target(pane.wrap);
  target(pane.tab);
}

// ------------------------------------------------------------------- zoom
// Terminal zoom for large pages: Fit fills the stage, ½ / ¼ show the fitted
// terminal at half / quarter linear size (the stage centers it). The choice
// persists, so a preferred working size survives reloads and split panes.
// Declared before the viewport section: fit() below consumes it.
const ZOOM_KEY = 'web5250.zoom';
const ZOOM_STEPS = [
  { id: 'btn-fit', v: null },
  { id: 'btn-half', v: 0.5 },
  { id: 'btn-quarter', v: 0.25 }
] as const;
let zoom: number | null = (() => {
  const v = Number.parseFloat(localStorage.getItem(ZOOM_KEY) ?? '');
  return v === 0.5 || v === 0.25 ? v : null;
})();
function setZoom(v: number | null): void {
  zoom = v;
  if (v === null) localStorage.removeItem(ZOOM_KEY);
  else localStorage.setItem(ZOOM_KEY, String(v));
  renderZoomButtons();
  fitCanvas();
}
function renderZoomButtons(): void {
  for (const step of ZOOM_STEPS) $(step.id).classList.toggle('active', zoom === step.v);
}
/** Zoom controls only mean something while a terminal is on screen. */
function setZoomButtonsVisible(visible: boolean): void {
  $('zoom-group').classList.toggle('hidden', !visible);
}
for (const step of ZOOM_STEPS) $(step.id).addEventListener('click', () => setZoom(step.v));
renderZoomButtons();

// ------------------------------------------------------------------ viewport
// The app's height tracks the *visual* viewport: when a mobile soft keyboard
// opens, iOS (and others) shrink the visual viewport without resizing the
// layout viewport, so 100dvh alone leaves the terminal hidden behind the
// keyboard. Following it here lets the whole UI - and the canvas with it -
// shrink while typing and expand again when the keyboard closes.
function applyViewport(): void {
  const h = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty('--vvh', `${Math.round(h)}px`);
}
window.visualViewport?.addEventListener('resize', applyViewport);
window.visualViewport?.addEventListener('scroll', () => {
  // iOS can scroll the page behind an open keyboard; pin it back so the
  // shrunk app stays flush with the top of the visual viewport.
  applyViewport();
  window.scrollTo(0, 0);
});
window.addEventListener('resize', applyViewport);
window.addEventListener('orientationchange', applyViewport);
applyViewport();

// The canvas is sized in JS rather than with CSS max-* constraints (engines
// don't apply those aspect-preservingly to an explicitly sized canvas):
// whenever the space available to the terminal changes - window resize, soft
// keyboard opening/closing through --vvh, keypad toggles - scale it to fit.
function fitCanvas(): void {
  const stage = $('stage');
  const termEl = $('terminal');
  const s = getComputedStyle(stage);
  const t = getComputedStyle(termEl);
  const availW =
    stage.clientWidth -
    parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) -
    parseFloat(t.borderLeftWidth) - parseFloat(t.borderRightWidth);
  const availH =
    stage.clientHeight -
    parseFloat(s.paddingTop) - parseFloat(s.paddingBottom) -
    parseFloat(s.rowGap) - $('oia').offsetHeight -
    parseFloat(t.borderTopWidth) - parseFloat(t.borderBottomWidth);
  if (availW > 0 && availH > 0) term.fit(availW * (zoom ?? 1), availH * (zoom ?? 1));
}
new ResizeObserver(fitCanvas).observe($('stage'));
fitCanvas();
// The canvas boots with the fallback font; when IBM Plex Mono arrives the
// cell metrics change, so re-measure and refit once webfonts settle.
document.fonts?.ready.then(() => {
  term.remeasure();
  fitCanvas();
});

// ---------------------------------------------------------------------- UI
// Touch devices type through the hidden input: tapping the screen focuses it
// (focus() inside the tap gesture is what makes iOS/Android raise the
// keyboard), and the Kbd button toggles it explicitly.
const coarsePointer = window.matchMedia('(pointer: coarse)').matches;

function focusTerminal(): void {
  if (coarsePointer) mobileInput.focus({ preventScroll: true });
  else terminal.focus();
}

// While a UI surface covers the terminal (system menu, keyboard-mapping
// help, right-click menu), its keys belong to that surface - not to the host.
const ctxOpen = (): boolean => !$('ctx-menu').classList.contains('hidden');
const copyFallbackOpen = (): boolean => !$('copy-fallback').classList.contains('hidden');
const uiSurfaceOpen = (): boolean =>
  menuVisible() || ctxOpen() || copyFallbackOpen() || !$('keys-modal').classList.contains('hidden');
attachKeyboard(sendKey, () => !uiSurfaceOpen());
buildKeypad(sendKey);
initMenu();

$('overlay-action').addEventListener('click', () => {
  if (confirmLeave()) connect();
});
$('overlay-menu').addEventListener('click', () => {
  if (confirmLeave()) endSession();
});
$('btn-systems').addEventListener('click', () => {
  if (confirmLeave()) endSession();
});

$('btn-keys').addEventListener('click', () => {
  const m = $('keys-modal');
  m.classList.toggle('hidden');
  // Focus the card so the scroll keys (arrows, PgUp/PgDn) page the help
  // instead of rolling the 5250 screen behind it.
  if (!m.classList.contains('hidden')) $('keys-card').focus();
});
$('keys-close').addEventListener('click', () => $('keys-modal').classList.add('hidden'));
// Escape dismisses the help - without this it would fall through to the
// terminal mapping and send SysReq to the host. Same for the right-click
// menu (uiSurfaceOpen keeps its keys off the host while it is up).
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (ctxOpen()) {
    e.preventDefault();
    $('ctx-menu').classList.add('hidden');
  } else if (copyFallbackOpen()) {
    e.preventDefault();
    $('copy-fallback').classList.add('hidden');
  } else if (!$('keys-modal').classList.contains('hidden')) {
    e.preventDefault();
    $('keys-modal').classList.add('hidden');
  }
});
// One-click diagnostics: raw 5250 records + parsed field tables + AID
// payloads for this session, straight from the gateway to the clipboard.
// Hidden unless the gateway is built with SHOW_DIAG_BUTTON=1.
$('btn-diag').addEventListener('click', () => send({ t: 'diag' }));
void loadMeta().then((meta) => {
  if (meta?.showDiagButton) $('btn-diag').classList.remove('hidden');
});

const keypad = $('keypad');
if (coarsePointer) {
  keypad.classList.remove('hidden');
  $('btn-kbd').classList.remove('hidden');
}
// These toggles must not steal focus from the typing input - the focus
// loss would close the soft keyboard on a touch device.
for (const id of ['btn-keypad', 'btn-kbd']) {
  $(id).addEventListener('mousedown', (e) => e.preventDefault());
}
$('btn-keypad').addEventListener('click', () => {
  delete keypad.dataset.autoHidden; // a manual toggle always wins
  keypad.classList.toggle('hidden');
});
$('btn-kbd').addEventListener('click', () => {
  if (document.activeElement === mobileInput) mobileInput.blur();
  else focusTerminal();
});
// While the device keyboard is up, the 5250 keypad is dead weight and
// pinches the terminal to unreadable; collapse it and bring it back when
// the keyboard closes (unless Pad was toggled manually in between).
mobileInput.addEventListener('focusin', () => {
  if (!keypad.classList.contains('hidden')) {
    keypad.dataset.autoHidden = '1';
    keypad.classList.add('hidden');
  }
});
mobileInput.addEventListener('focusout', () => {
  if (keypad.dataset.autoHidden === '1') {
    delete keypad.dataset.autoHidden;
    keypad.classList.remove('hidden');
  }
});

const terminal = $('terminal');
// --- drag selection --------------------------------------------------------
// Left-drag marks a screen region and copies it on release (like PuTTY);
// plain drag marks a text-flow selection, Alt+drag a column rectangle. A
// press without movement stays a plain click and places the host cursor as
// before - the click is deferred to mouseup, where the two are told apart.
let selPressing = false;
let selAnchor: { r: number; c: number } | null = null;
let selMarked = false;
let selRect = false;

terminal.addEventListener('mousedown', (e) => {
  // Suppressing the default focus (the tap would focus #terminal itself,
  // closing a just-opened keyboard); focusTerminal() picks the right target.
  // preventDefault also stops middle-click autoscroll.
  e.preventDefault();
  // Left click: with the host's pull-down menu up it dismisses the
  // selection (returned to the host as choice 0, exactly like ACS);
  // otherwise it starts a possible mark, dropping any previous one.
  if (e.button === 0) {
    if (hostPopupOpen()) {
      send({ t: 'pick', choice: 0 });
    } else {
      selAnchor = termHit(e);
      selPressing = selAnchor !== null;
      selMarked = false;
      selRect = e.altKey;
      term.clearSelection();
    }
  }
  focusTerminal();
});
/** Cell under a mouse event, clamped into the grid (drags leave the canvas). */
function termCellClamped(e: MouseEvent): [number, number] {
  const canvas = $('screen-canvas');
  const bounds = canvas.getBoundingClientRect();
  return term.cellClamped(e.clientX - bounds.left, e.clientY - bounds.top);
}
window.addEventListener('mousemove', (e) => {
  if (!selPressing || !selAnchor) return;
  const [r, c] = termCellClamped(e);
  if (!selMarked && r === selAnchor.r && c === selAnchor.c) return;
  if (!selMarked) {
    selMarked = true;
    term.beginSelection(selAnchor.r, selAnchor.c, selRect);
  }
  term.extendSelection(r, c);
});
window.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || !selPressing) return;
  selPressing = false;
  const anchor = selAnchor;
  selAnchor = null;
  if (selMarked) {
    selMarked = false;
    copySelection();
    return;
  }
  // Plain click: place the host cursor at the clicked cell (the gateway
  // applies the same freedom as arrow movement).
  if (anchor) send({ t: 'key', k: 'click', r: anchor.r, c: anchor.c });
});
// A drag that ends outside the window never sees the mouseup.
window.addEventListener('blur', () => {
  selPressing = false;
  selAnchor = null;
});
function termHit(e: MouseEvent): { r: number; c: number } | null {
  const canvas = $('screen-canvas');
  const bounds = canvas.getBoundingClientRect();
  return term.clickToMessage(e.clientX - bounds.left, e.clientY - bounds.top);
}
// Host-programmed double click (e.g. the app's zoom function): the two
// single clicks have already parked the cursor on the cell; the second
// click additionally fires the programmed AID. Without a programmed
// action the double click marks the word under the mouse (and copies it,
// like any completed mark).
terminal.addEventListener('dblclick', (e) => {
  const hit = termHit(e);
  if (!hit) return;
  if (hostMouse.leftdouble === undefined) {
    term.selectWord(hit.r, hit.c);
    copySelection();
    return;
  }
  send({ t: 'mouseevent', ev: 'leftdouble', r: hit.r, c: hit.c });
});

// Right-click over the terminal: the browser's own menu (save image,
// inspect...) is noise over a 5250 screen; tn5250j opens Copy/Paste
// actions instead. Long-press on touch devices arrives here too.
const ctxMenu = $('ctx-menu');
terminal.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // Probe mode (?mouseprobe=): the right-click becomes the experiment -
  // send the candidate AID at the clicked cell, no local menu.
  if (mouseProbeAid !== null) {
    const hit = termHit(e);
    if (hit) {
      send({ t: 'mouseprobe', aid: mouseProbeAid, r: hit.r, c: hit.c });
      console.info(`[mouseprobe] sent aid 0x${mouseProbeAid.toString(16)} at ${hit.r},${hit.c}`);
    }
    return;
  }
  // The host programmed this screen's right button (5494 mouse support):
  // the click is the application's, like on ACS. Shift+right-click keeps
  // the local Copy/Paste menu reachable.
  if (hostMouse.rightdown !== undefined && !e.shiftKey) {
    const hit = termHit(e);
    if (hit) send({ t: 'mouseevent', ev: 'rightdown', r: hit.r, c: hit.c });
    return;
  }
  ctxMenu.classList.remove('hidden');
  // keep the menu fully inside the viewport
  const card = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.max(8, Math.min(e.clientX, window.innerWidth - card.width - 8))}px`;
  ctxMenu.style.top = `${Math.max(8, Math.min(e.clientY, window.innerHeight - card.height - 8))}px`;
  $<HTMLButtonElement>('ctx-copysel').disabled = !term.hasSelection;
});
// Ctrl+C / Cmd+C copies the marked region. Without a mark the key stays
// with the browser (nothing to interrupt); typing surfaces keep their
// native copy.
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.code !== 'KeyC') return;
  if (!term.hasSelection || uiSurfaceOpen()) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  e.preventDefault();
  copySelection();
});
function hideCtxMenu(): void {
  ctxMenu.classList.add('hidden');
}
// any press outside the menu dismisses it
window.addEventListener(
  'pointerdown',
  (e) => {
    if (ctxOpen() && !ctxMenu.contains(e.target as Node)) hideCtxMenu();
  },
  true
);
window.addEventListener('blur', hideCtxMenu);

// Copy the marked region (the menu item is disabled without a mark); the
// toast is copySelection's own feedback.
$('ctx-copysel').addEventListener('click', () => {
  copySelection();
  hideCtxMenu();
  focusTerminal();
});
// Copy screen: the visible text of the whole screen grid. The brief label
// swap is the only feedback (the menu closes right after anyway).
$('ctx-copy').addEventListener('click', (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  copyText(term.text(), 'Screen text');
  btn.textContent = 'Copied';
  window.setTimeout(() => (btn.textContent = 'Copy screen'), 900);
  hideCtxMenu();
  focusTerminal();
});
// Paste at the cursor, typed character by character. Tabs advance to the
// next field (a spreadsheet row fills successive prompt fields); line
// breaks are dropped - auto-submitting a half-filled screen on a stray
// newline is never what the user meant.
$('ctx-paste').addEventListener('click', () => {
  const clip = navigator.clipboard;
  if (!clip?.readText) {
    window.alert('Paste needs a secure origin (HTTPS) for clipboard access.');
  } else {
    clip
      .readText()
      .then((text) => {
        for (const ch of text) {
          if (ch === '\t') sendKey('tab');
          else if (ch !== '\r' && ch !== '\n') sendKey('char', ch);
        }
      })
      .catch(() => window.alert('Paste is unavailable: the browser blocked clipboard access.'));
  }
  hideCtxMenu();
  focusTerminal();
});

// Keep focus on the terminal so keyboard events flow; the hidden input is
// what mobile soft keyboards type into. Focus moving between the terminal
// div and that input still counts as "the session has focus".
terminal.addEventListener('focusout', (e) => {
  if (!(e.relatedTarget instanceof Node) || !terminal.contains(e.relatedTarget)) term.focused = false;
});
terminal.addEventListener('focusin', () => {
  term.focused = true;
});
mobileInput.addEventListener('input', () => {
  // Soft keyboards deliver whole runs of text here.
  for (const ch of mobileInput.value) sendKey('char', ch);
  mobileInput.value = '';
});
mobileInput.addEventListener('keydown', (e) => {
  // While the hidden input holds focus (soft keyboard open, or a hardware
  // keyboard on a touch device), every mappable key comes through here.
  // Mapped keys are suppressed so they are never also delivered as text
  // by the input event above.
  if (e.isComposing) return;
  const mapped = mapEvent(e);
  if (mapped) {
    e.preventDefault();
    sendKey(mapped.k, mapped.ch);
  }
});

document.addEventListener('click', () => {
  audioCtx?.resume().catch(() => {});
});

boot();
