// Browser entry point: one app shell managing 1..N session panes.
//
// The app is a single chrome - top bar, system menu, keypad - over any number
// of session panes (pane.ts). A lone pane looks exactly like the classic
// single-session terminal; adding panes (Split from the menu, + Pane) lays
// them out as tiles/tabs of the same page. Sessions live server-side, so a
// pane can be popped out into a real browser window (?) and a reloaded page
// reattaches to its running sessions.
import './styles.css';
import { SessionPane, SESSION_KEY, type SessionTarget, type PaneServices } from './pane.ts';
import { attachKeyboard, mapEvent, type SendKey } from './keyboard.ts';
import { buildKeypad } from './keypad.ts';
import {
  fetchSystems,
  hideMenu,
  initMenu,
  loadMeta,
  menuVisible,
  setSplitHandler,
  showMenu,
  type MenuSystem
} from './menu.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

// Automated-launch mode (?auto=1): the gateway signs on with server-held
// credentials and this page is embedded in the caller's iframe. When the
// session ends the parent page is notified via postMessage so it can remove
// the iframe; parentorigin restricts the message target when set. Embedded
// launches are always single-pane and keep the strict session contract.
const launchParams = new URLSearchParams(window.location.search);
const autoLaunch = ['1', 'true'].includes(launchParams.get('auto') ?? '');

// Split mode (?grid=1..6, optionally &systems=<id>,<id> preassigning panes):
// the page lays out that many session panes. Deep links preassign; the same
// layout is reachable interactively (Split on the menu, + Pane up top).
const urlGridPanes = (() => {
  const n = Number.parseInt(launchParams.get('grid') ?? '', 10);
  return n >= 1 && n <= 6 ? n : null;
})();

// ------------------------------------------------------------------ panes
const panes: SessionPane[] = [];
let activePane: SessionPane | null = null;
let gridMode = urlGridPanes !== null;
let tabsMode = false;
let menuTarget: SessionPane | null = null; // pane the shared system menu fills

const GRID_STATE_KEY = 'web5250.gridstate';
const GRID_VIEW_KEY = 'web5250.gridview';
const GRID_TAB_KEY = 'web5250.gridtab';
const MAX_PANES = 6;

function saveGridState(): void {
  localStorage.setItem(
    GRID_STATE_KEY,
    JSON.stringify(panes.map((p) => ({ system: p.systemId, token: p.token })))
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

const paneServices: PaneServices = {
  autoLaunch,
  onPaneClick(pane) {
    setActive(pane);
    focusTerminal();
  },
  openContextMenu(pane, e) {
    menuPane = pane;
    const ctxMenu = $('ctx-menu');
    ctxMenu.classList.remove('hidden');
    // keep the menu fully inside the viewport
    const card = ctxMenu.getBoundingClientRect();
    ctxMenu.style.left = `${Math.max(8, Math.min(e.clientX, window.innerWidth - card.width - 8))}px`;
    ctxMenu.style.top = `${Math.max(8, Math.min(e.clientY, window.innerHeight - card.height - 8))}px`;
    $<HTMLButtonElement>('ctx-copysel').disabled = !pane.term.hasSelection;
  },
  openSystemMenu(pane) {
    openMenuFor(pane);
  },
  onPopOut(pane) {
    popOut(pane);
  },
  onMove(pane, dir) {
    movePane(pane, dir);
  },
  onClose(pane) {
    if (!pane.confirmLeave()) return;
    closePane(pane);
  },
  onSelectionCopied(pane) {
    copySelection(pane);
  },
  beep() {
    beepAudio();
  },
  onDiagnostics(text) {
    copyText(text, 'Diagnostics');
  },
  onLabel(pane) {
    if (pane === activePane) {
      $('dev-info').textContent = pane.label;
      if (pane.label) document.title = `${pane.label} · web5250`;
    }
  },
  onStatus(pane) {
    if (pane === activePane) setConnState(pane.connState);
  },
  onToken() {
    saveGridState();
  },
  requestFit() {
    fitPanes();
  },
  onAutoEnd(reason, detail) {
    signalSessionEnd(reason, detail);
  },
  onSessionGone(pane) {
    void pane;
  }
};

function createPane(init: { system?: number | null; attach?: string; connectNow?: boolean } = {}): SessionPane {
  const pane = new SessionPane(panes.length, paneServices);
  pane.setShowBar(gridMode);
  pane.setZoom(zoom ?? 1);
  pane.systemId = init.system ?? null; // hello confirms/matches it later
  $('panes').appendChild(pane.el);
  panes.push(pane);

  // ?attach= reattaches to the previous session after a reload; ?system= is
  // the fallback (and the deep-link assignment) when it no longer exists.
  const target: SessionTarget = {};
  if (init.attach) target.attach = init.attach;
  if (init.system) {
    void fetchSystems()
      .then((rows) => {
        target.system = rows.find((r) => r.id === init.system);
        if (init.connectNow !== false) pane.connect(target);
        layoutPanes();
      })
      .catch(() => {
        if (init.connectNow !== false) pane.connect(target);
        layoutPanes();
      });
  } else if (init.connectNow !== false && (init.attach || init.connectNow)) {
    pane.connect(target);
  }
  layoutPanes();
  return pane;
}

function removePaneEl(pane: SessionPane): void {
  const i = panes.indexOf(pane);
  if (i >= 0) panes.splice(i, 1);
  pane.el.remove();
  if (activePane === pane) {
    setActive(panes[Math.max(0, i - 1)] ?? panes[0] ?? null);
  }
  // Keep data-pane indexes equal to list positions (tests aim at them).
  panes.forEach((p, idx) => {
    p.el.dataset.pane = String(idx);
  });
}

/** Move a pane one slot left/right (plain DOM order - nothing reloads). */
function movePane(pane: SessionPane, dir: -1 | 1): void {
  const wrap = $('panes');
  const el = pane.el;
  if (dir < 0 && el.previousElementSibling) {
    wrap.insertBefore(el, el.previousElementSibling);
  } else if (dir > 0 && el.nextElementSibling) {
    wrap.insertBefore(el.nextElementSibling, el);
  } else return;
  if (gridMode && tabsMode) layoutPanes();
  fitPanes();
}

/** Close a pane; its session detaches and stays re-attachable in grace. */
function closePane(pane: SessionPane): void {
  const wasGrid = gridMode;
  pane.detach();
  removePaneEl(pane);
  if (panes.length === 0) {
    exitSplit(false);
    createPane();
    void showMenuFor();
    return;
  }
  if (wasGrid && panes.length === 1) exitSplit(true);
  else {
    saveGridState();
    layoutPanes();
  }
}

/** Pop a pane's session out into a real browser window (and drop the pane). */
function popOut(pane: SessionPane): void {
  if (!pane.token) return;
  const u = new URL(window.location.href);
  u.searchParams.delete('grid');
  u.searchParams.delete('systems');
  if (pane.systemId !== null) u.searchParams.set('system', String(pane.systemId));
  else u.searchParams.delete('system');
  u.searchParams.set('attach', pane.token);
  // window.open must run inside the click gesture or the popup blocker eats
  // it. The session itself is safe either way: the new window attaches to
  // the same token, detaching this pane's front-end server-side.
  const win = window.open(u.href, 'web5250', 'popup=yes,width=1000,height=680');
  if (!win) {
    window.alert('The browser blocked the pop-up window. Allow pop-ups for this site and try again.');
    return;
  }
  closePane(pane);
}

function setActive(pane: SessionPane | null): void {
  if (activePane === pane) return;
  activePane?.setFocused(false);
  activePane?.el.classList.remove('active-pane');
  activePane = pane;
  activePane?.setFocused(true);
  activePane?.el.classList.add('active-pane');
  if (activePane) {
    setConnState(activePane.connState);
    $('dev-info').textContent = activePane.label;
    document.title = activePane.label ? `${activePane.label} · web5250` : 'IBM i 5250 Terminal';
  }
  if (gridMode && tabsMode) layoutPanes();
}

// ----------------------------------------------------------------- layout
/** Lay the panes out (single / tiles / tabs) and refit every terminal. */
function layoutPanes(): void {
  const wrap = $('panes');
  const count = panes.length;
  gridMode = gridMode && count > 0;
  wrap.classList.toggle('split', gridMode && count > 1);
  wrap.classList.toggle('tabs', gridMode && count > 1 && tabsMode);
  wrap.dataset.panes = String(count);
  for (const p of panes) p.setShowBar(gridMode && count > 1);
  // split controls exist only while there is something to manage
  $('split-group').classList.toggle('hidden', !gridMode && count < 2);
  $<HTMLButtonElement>('btn-addpane').disabled = count >= MAX_PANES;
  $('grid-view-tiles').classList.toggle('active', !tabsMode);
  $('grid-view-tabs').classList.toggle('active', tabsMode);
  if (gridMode && count > 1 && tabsMode && activePane) {
    for (const p of panes) p.el.style.display = p === activePane ? '' : 'none';
  } else {
    for (const p of panes) p.el.style.display = '';
  }
  renderTabbar();
  fitPanes();
}

/** The tab strip for tabs mode: one button per pane, click to focus. */
function renderTabbar(): void {
  const bar = $('tabbar');
  const show = gridMode && panes.length > 1 && tabsMode;
  bar.classList.toggle('hidden', !show);
  if (!show) return;
  bar.replaceChildren(
    ...panes.map((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab' + (p === activePane ? ' active' : '');
      b.textContent = p.label || `Session ${p.index + 1}`;
      b.title = 'Show this session';
      b.addEventListener('click', () => {
        setActive(p);
        layoutPanes();
        focusTerminal();
      });
      return b;
    })
  );
}

function setTabsMode(tabs: boolean): void {
  tabsMode = tabs;
  if (tabs) localStorage.setItem(GRID_VIEW_KEY, 'tabs');
  else localStorage.removeItem(GRID_VIEW_KEY);
  layoutPanes();
}

/** Leave split mode; extra panes end (deliberate exit skips the grace). */
function exitSplit(keepFirst: boolean): void {
  gridMode = false;
  tabsMode = false;
  localStorage.removeItem(GRID_VIEW_KEY);
  localStorage.removeItem(GRID_STATE_KEY);
  while (panes.length > (keepFirst ? 1 : 0)) {
    const p = panes[panes.length - 1];
    p.end();
    removePaneEl(p);
  }
  const u = new URL(window.location.href);
  u.searchParams.delete('grid');
  u.searchParams.delete('systems');
  history.replaceState(null, '', u.href);
  layoutPanes();
}

/** Enter split mode with n panes, reusing the existing ones in place. */
function startSplit(n: number): void {
  gridMode = true;
  hideMenu();
  const u = new URL(window.location.href);
  u.searchParams.delete('system');
  u.searchParams.set('grid', String(n));
  history.replaceState(null, '', u.href);
  while (panes.length < n) createPane();
  while (panes.length > n) {
    const p = panes[panes.length - 1];
    p.end();
    removePaneEl(p);
  }
  saveGridState();
  layoutPanes();
  // A pane without a target needs the shared menu.
  const empty = panes.find((p) => p.systemId === null && !p.target.attach);
  if (empty) openMenuFor(empty);
}

/** Open the shared system menu; a pick fills the given pane. */
function openMenuFor(pane: SessionPane): void {
  menuTarget = pane;
  setActive(pane);
  void showMenu((s) => {
    hideMenu();
    menuTarget?.connect({ system: s });
    menuTarget = null;
  });
}

// --------------------------------------------------------------- top bar
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
  // Systems makes sense only while a session is up (the menu itself is the
  // landing state); embedded launches never get it. Zoom applies to real
  // sessions for the same reason.
  const anySocket = panes.some((p) => p.hasSocket());
  $('btn-systems').classList.toggle('hidden', autoLaunch || !anySocket);
  $('zoom-group').classList.toggle('hidden', autoLaunch || !anySocket);
}

/** Automated-launch lifecycle: exactly one postMessage per ended launch. */
let signalledEnd = false;
function signalSessionEnd(reason: string, detail: string): void {
  if (!autoLaunch || signalledEnd) return;
  signalledEnd = true;
  const parentOrigin = launchParams.get('parentorigin') || '*';
  window.parent.postMessage({ source: 'web5250', type: 'session-end', reason, detail }, parentOrigin);
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
  for (const p of panes) {
    if (p.hasSocket()) p.send({ t: 'ping' });
  }
};

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
let audioCtx: AudioContext | null = null;

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
function copySelection(pane: SessionPane): void {
  const text = pane.term.selectionText();
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
// Closing the tab or navigating away drops the sockets; with a gateway grace
// period the sessions survive that and are offered again on reload, so
// leaving costs nothing and must not nag. Embedded launches (?auto=1) are
// torn down by the parent page, so they stay out of this either way.
if (!autoLaunch) {
  window.addEventListener('beforeunload', (e) => {
    if (!panes.some((p) => p.sessionActive() && p.graceMs === 0)) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

/** Landing logic: deep links map onto 1..N panes; everyone else gets the menu. */
function boot(): void {
  tabsMode = localStorage.getItem(GRID_VIEW_KEY) === 'tabs';
  const params = launchParams;
  const sysId = Number.parseInt(params.get('system') ?? '', 10);
  const attachToken = params.get('attach');

  if (urlGridPanes !== null) {
    const preassigned = params
      .get('systems')
      ?.split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((v) => Number.isInteger(v) && v > 0);
    const saved = loadGridState();
    for (let i = 0; i < urlGridPanes; i++) {
      // Explicit ?systems= preassignment wins over the saved state (a shared
      // deep link should not resurrect someone else's panes).
      const system = preassigned?.[i] ?? saved[i]?.system ?? null;
      createPane({
        system,
        attach: preassigned ? undefined : saved[i]?.token ?? undefined,
        connectNow: system !== null || !!saved[i]?.token
      });
    }
    setActive(panes[0] ?? null);
    // Open the shared menu only for panes with no target at all - a pane
    // reattaching via its saved token is mid-connect here, not empty.
    const empty = panes.find((p) => p.systemId === null && !p.target.attach);
    if (empty) openMenuFor(empty);
    return;
  }

  if (attachToken) {
    // ?attach=<token>[&system=<id>]: re-bind to the running gateway-side
    // session (pop-out window, reloaded page). If the token has expired the
    // status-error handler falls back once to a fresh session on the system.
    const begin = (system?: MenuSystem): void => {
      const pane = createPane({ connectNow: false });
      setActive(pane);
      pane.connect({ system, attach: attachToken });
    };
    if (Number.isInteger(sysId) && sysId > 0) {
      fetchSystems()
        .then((rows) => begin(rows.find((r) => r.id === sysId)))
        .catch(() => begin());
    } else begin();
    return;
  }

  if (Number.isInteger(sysId) && sysId > 0) {
    fetchSystems()
      .then((rows) => {
        const row = rows.find((r) => r.id === sysId);
        const pane = createPane({ connectNow: false });
        setActive(pane);
        if (row) pane.connect({ system: row });
        else void showMenuFor();
      })
      .catch(() => {
        createPane();
        void showMenuFor();
      });
    return;
  }

  if (params.has('host') || autoLaunch) {
    // Legacy custom-host deep link (?host=...&port=... with ALLOW_CUSTOM_HOST),
    // or an automated launch (?auto=1) without a ?system= selection: connect
    // straight to the environment-default host - a menu has no role embedded.
    const pane = createPane({ connectNow: false });
    setActive(pane);
    pane.connect({});
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
        const pane = createPane({ connectNow: false });
        setActive(pane);
        pane.connect({ system, attach: saved.token });
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
  createPane();
  void showMenuFor();
}

/** Open the shared menu for the (only) pane - the landing state. */
function showMenuFor(): void {
  const pane = menuTarget ?? activePane ?? panes[0];
  if (pane) openMenuFor(pane);
  else void showMenu(() => {});
}

// ------------------------------------------------------------------- zoom
// Terminal zoom: Fit fills the pane, ½ / ¼ show it at half / quarter linear
// size. The choice persists and applies to every pane (the focused one is
// the reference).
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
  for (const p of panes) p.setZoom(v ?? 1);
  fitPanes();
}
function renderZoomButtons(): void {
  for (const step of ZOOM_STEPS) $(step.id).classList.toggle('active', zoom === step.v);
}
for (const step of ZOOM_STEPS) $(step.id).addEventListener('click', () => setZoom(step.v));
renderZoomButtons();

// ------------------------------------------------------------------ viewport
// The app's height tracks the *visual* viewport: when a mobile soft keyboard
// opens, iOS (and others) shrink the visual viewport without resizing the
// layout viewport, so 100dvh alone leaves the terminal hidden behind the
// keyboard. Following it here lets the whole UI - and the panes with it -
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

/** Refit every pane's terminal into its box (grid cells / stage change). */
function fitPanes(): void {
  const stage = $('stage');
  const s = getComputedStyle(stage);
  for (const p of panes) {
    if (p.el.style.display === 'none') continue;
    let availW: number;
    let availH: number;
    if (gridMode && panes.length > 1) {
      // Grid cell: the pane element is cell-sized; subtract its chrome.
      availW = p.el.clientWidth - 2; // pane-screen borders
      availH = p.el.clientHeight - 2 - barHeight(p) - oiaHeight(p);
    } else {
      // Single pane: the classic stage-derived fit (the pane shrink-wraps
      // its canvas, so the stage is the only stable measure).
      const t = getComputedStyle(panes[0].screenEl);
      availW =
        stage.clientWidth -
        parseFloat(s.paddingLeft) -
        parseFloat(s.paddingRight) -
        parseFloat(t.borderLeftWidth) -
        parseFloat(t.borderRightWidth);
      availH =
        stage.clientHeight -
        parseFloat(s.paddingTop) -
        parseFloat(s.paddingBottom) -
        parseFloat(s.rowGap) -
        oiaHeight(p) -
        parseFloat(t.borderTopWidth) -
        parseFloat(t.borderBottomWidth);
    }
    if (availW > 0 && availH > 0) {
      p.setZoom(zoom ?? 1);
      p.fitInto(availW, availH);
    }
  }
}
function barHeight(p: SessionPane): number {
  return gridMode && panes.length > 1 ? (p.el.querySelector('.pane-bar') as HTMLElement)?.offsetHeight ?? 0 : 0;
}
function oiaHeight(p: SessionPane): number {
  return (p.el.querySelector('.oia') as HTMLElement)?.offsetHeight ?? 0;
}
new ResizeObserver(fitPanes).observe($('stage'));
window.addEventListener('resize', fitPanes);
// The canvas boots with the fallback font; when IBM Plex Mono arrives the
// cell metrics change, so re-measure and refit once webfonts settle.
document.fonts?.ready.then(() => {
  for (const p of panes) p.term.remeasure();
  fitPanes();
});

// ---------------------------------------------------------------------- UI
// Touch devices type through the hidden input: tapping the screen focuses it
// (focus() inside the tap gesture is what makes iOS/Android raise the
// keyboard), and the Kbd button toggles it explicitly.
const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
const mobileInput = $<HTMLInputElement>('mobile-input');

function focusTerminal(): void {
  if (coarsePointer) mobileInput.focus({ preventScroll: true });
  // With a mouse there is nothing to focus: key events are captured at
  // window level and routed to the focused pane.
}

// While a UI surface covers the terminal (system menu, keyboard-mapping
// help, right-click menu), its keys belong to that surface - not to the host.
const ctxOpen = (): boolean => !$('ctx-menu').classList.contains('hidden');
const copyFallbackOpen = (): boolean => !$('copy-fallback').classList.contains('hidden');
const uiSurfaceOpen = (): boolean =>
  menuVisible() || ctxOpen() || copyFallbackOpen() || !$('keys-modal').classList.contains('hidden');

const sendKey: SendKey = (k, ch) => {
  activePane?.sendKey(k, ch);
};
attachKeyboard(sendKey, () => !uiSurfaceOpen());
buildKeypad(sendKey);
initMenu();
setSplitHandler((n) => startSplit(n));

$('btn-systems').addEventListener('click', () => {
  const pane = activePane ?? panes[0];
  if (!pane) return;
  if (pane.confirmLeave()) {
    pane.end();
    openMenuFor(pane);
  }
});
$('btn-addpane').addEventListener('click', () => {
  if (panes.length < MAX_PANES) {
    const pane = createPane();
    setActive(pane);
  }
});
$('grid-view-tiles').addEventListener('click', () => setTabsMode(false));
$('grid-view-tabs').addEventListener('click', () => setTabsMode(true));
$('btn-exitsplit').addEventListener('click', () => {
  // Deliberate exit: the extra sessions end now (skipping the grace).
  exitSplit(true);
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
$('btn-diag').addEventListener('click', () => activePane?.send({ t: 'diag' }));
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
  layoutPanes();
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
    layoutPanes();
  }
});
mobileInput.addEventListener('focusout', () => {
  if (keypad.dataset.autoHidden === '1') {
    delete keypad.dataset.autoHidden;
    keypad.classList.remove('hidden');
    layoutPanes();
  }
});

// Right-click menu over the terminal: Copy selection / Copy screen / Paste
// for the pane that opened it.
function hideCtxMenu(): void {
  $('ctx-menu').classList.add('hidden');
}
let menuPane: SessionPane | null = null;
// any press outside the menu dismisses it
window.addEventListener(
  'pointerdown',
  (e) => {
    if (ctxOpen() && !$('ctx-menu').contains(e.target as Node)) hideCtxMenu();
  },
  true
);
window.addEventListener('blur', hideCtxMenu);

// Ctrl+C / Cmd+C copies the focused pane's marked region. Without a mark
// the key stays with the browser (nothing to interrupt); typing surfaces
// keep their native copy.
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.code !== 'KeyC') return;
  if (!activePane?.term.hasSelection || uiSurfaceOpen()) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  e.preventDefault();
  copySelection(activePane);
});

// Copy the marked region (the menu item is disabled without a mark); the
// toast is copySelection's own feedback.
$('ctx-copysel').addEventListener('click', () => {
  if (menuPane) copySelection(menuPane);
  hideCtxMenu();
  focusTerminal();
});
// Copy screen: the visible text of the pane's whole screen grid. The brief
// label swap is the only feedback (the menu closes right after anyway).
$('ctx-copy').addEventListener('click', (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  if (menuPane) copyText(menuPane.term.text(), 'Screen text');
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
        const pane = menuPane ?? activePane;
        if (!pane) return;
        for (const ch of text) {
          if (ch === '\t') pane.sendKey('tab');
          else if (ch !== '\r' && ch !== '\n') pane.sendKey('char', ch);
        }
      })
      .catch(() => window.alert('Paste is unavailable: the browser blocked clipboard access.'));
  }
  hideCtxMenu();
  focusTerminal();
});

// Keep the cursor styling honest when the window itself loses focus.
window.addEventListener('blur', () => activePane?.setFocused(false));
window.addEventListener('focus', () => activePane?.setFocused(true));

mobileInput.addEventListener('input', () => {
  // Soft keyboards deliver whole runs of text here.
  for (const ch of mobileInput.value) activePane?.sendKey('char', ch);
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
    activePane?.sendKey(mapped.k, mapped.ch);
  }
});

document.addEventListener('click', () => {
  audioCtx?.resume().catch(() => {});
});

boot();
