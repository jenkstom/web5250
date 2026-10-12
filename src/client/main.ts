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

// ---------------------------------------------------------------- transport
interface SessionTarget {
  system?: MenuSystem;
}
let target: SessionTarget = {};
let endingSession = false;

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Derive the WS endpoint from the page URL so sub-path deployments
  // (https://host/as400/ -> service) resolve to .../as400/ws automatically.
  const path = window.location.pathname.replace(/[^/]*$/, '');
  const params = new URLSearchParams(window.location.search);
  if (target.system) params.set('system', String(target.system.id));
  else params.delete('system');
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

function sendKey(k: string, ch?: string): void {
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
      break;
    }
    case 'status': {
      const status = String(msg.status);
      setConnState(status);
      if (status === 'connected') {
        hideOverlay();
      } else if (status === 'error' || status === 'closed') {
        sessionEndedByHost = true;
        signalSessionEnd(status, typeof msg.detail === 'string' ? msg.detail : '');
        showOverlay(
          status === 'error' ? 'Connection failed' : 'Session ended',
          typeof msg.detail === 'string' ? msg.detail : '',
          ['menu', 'reconnect']
        );
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
      if (Array.isArray(msg.fields)) term.setFields(msg.fields as number[][]);
      const cur = msg.cursor as number[];
      term.setCursor(cur[0], cur[1]);
      // Same marker the gateway's automation uses: QDSIGNON-family screens
      // keep their "Sign On" header until sign-on succeeds (and it returns
      // after a sign-off, where leaving is again free).
      onSignonScreen = term.text().toLowerCase().includes('sign on');
      break;
    }
    case 'update': {
      if (Array.isArray(msg.cells)) term.applyCells(msg.cells as (number | string)[][]);
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
// Embedded launches (?auto=1) are torn down by the parent page, so they stay
// out of this.
if (!autoLaunch) {
  window.addEventListener('beforeunload', (e) => {
    if (!sessionActive()) return;
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
  showOverlay('Connecting…', '', []);
  connect();
}

/** Close the current session (if any) and go back to the system menu. */
function endSession(): void {
  endingSession = true;
  ws?.close();
  mobileInput.blur(); // put the soft keyboard away before the menu shows
  hideOverlay();
  setConnState('idle');
  $('dev-info').textContent = '';
  term.resizeGrid(24, 80); // blank the canvas for the next session
  $('btn-systems').classList.add('hidden');
  void showMenu(startSession);
}

/** Landing logic: deep links jump straight into a session, everyone else gets the menu. */
function boot(): void {
  const params = new URLSearchParams(window.location.search);
  const sysId = Number.parseInt(params.get('system') ?? '', 10);
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
    showOverlay('Connecting…', '', []);
    connect();
    return;
  }
  void showMenu(startSession);
}

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
  if (availW > 0 && availH > 0) term.fit(availW, availH);
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
terminal.addEventListener('mousedown', (e) => {
  // Suppressing the default focus (the tap would focus #terminal itself,
  // closing a just-opened keyboard); focusTerminal() picks the right target.
  // preventDefault also stops middle-click autoscroll.
  e.preventDefault();
  // Left click places the cursor at the clicked cell (the gateway applies
  // the same freedom as arrow movement). Right-click opens the terminal's
  // own menu instead - see the contextmenu handler below.
  if (e.button === 0) {
    const rect = termHit(e);
    if (rect) send({ t: 'key', k: 'click', r: rect.r, c: rect.c });
  }
  focusTerminal();
});
function termHit(e: MouseEvent): { r: number; c: number } | null {
  const canvas = $('screen-canvas');
  const bounds = canvas.getBoundingClientRect();
  return term.clickToMessage(e.clientX - bounds.left, e.clientY - bounds.top);
}

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
  ctxMenu.classList.remove('hidden');
  // keep the menu fully inside the viewport
  const card = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.max(8, Math.min(e.clientX, window.innerWidth - card.width - 8))}px`;
  ctxMenu.style.top = `${Math.max(8, Math.min(e.clientY, window.innerHeight - card.height - 8))}px`;
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
