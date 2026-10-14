// Browser entry point: one app shell managing 1..N session panes.
//
// The app is a single chrome - top bar, system menu, keypad - over a layout
// tree of session panes (pane.ts). Every pane carries its own controls
// (split side-by-side / stacked, pick a system, pop out, close), so splitting
// is always one click away: it divides the focused pane in two, nesting
// splits into a binary tree whose divider lines are draggable. Sessions live
// server-side, so a pane can be popped out into a real browser window and a
// reloaded page reattaches to its running sessions.
import './styles.css';
import { SessionPane, SESSION_KEY, type SessionTarget, type PaneServices } from './pane.ts';
import { attachKeyboard, mapEvent, type SendKey } from './keyboard.ts';
import { buildKeypad } from './keypad.ts';
import {
  closePanePickers,
  fetchSystems,
  hideMenu,
  initMenu,
  loadMeta,
  menuVisible,
  openPanePicker,
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

// View-only mirror (?view=<share token>): this page renders one session it
// may watch but never drive. The link was copied by the session's owner
// (the pane-header share button) and works from any browser that can reach
// this origin - remotely included.
const shareViewToken = launchParams.get('view');
const shareView = !!shareViewToken;

// Deep link (?grid=1..6, optionally &systems=<id>,<id> preassigning panes):
// the page boots that many session panes in a balanced default tree. The
// same layout is reachable interactively (splitting panes, + Pane).
const urlGridPanes = (() => {
  const n = Number.parseInt(launchParams.get('grid') ?? '', 10);
  return n >= 1 && n <= 6 ? n : null;
})();

// ------------------------------------------------------------------ layout
// The pane layout is a binary tree: a leaf is a SessionPane, an inner node
// splits its box between two children side by side ('h') or stacked ('v'),
// with a draggable divider. Splitting a pane replaces the leaf with a node;
// closing one collapses its parent onto the sibling.
const panes: SessionPane[] = []; // tree-traversal order (data-pane order)
let activePane: SessionPane | null = null;
let tabsMode = false;
let menuTarget: SessionPane | null = null; // pane the shared system menu fills
let dragPane: SessionPane | null = null; // pane whose header/tab is being dragged

interface SplitNode {
  dir: 'h' | 'v';
  a: LayoutNode;
  b: LayoutNode;
  /** a's share of the box (b gets the rest). */
  frac: number;
}
type LayoutNode = SplitNode | SessionPane;

let layout: LayoutNode | null = null;

const GRID_STATE_KEY = 'web5250.gridstate';
const GRID_VIEW_KEY = 'web5250.gridview';
const TREE_KEY = 'web5250.tree';
const MAX_PANES = 6;
const MIN_FRAC = 0.12; // a dragged divider can never starve a pane

const isSplitNode = (n: LayoutNode): n is SplitNode => !(n instanceof SessionPane);

function leavesOf(n: LayoutNode | null): SessionPane[] {
  if (!n) return [];
  if (n instanceof SessionPane) return [n];
  return [...leavesOf(n.a), ...leavesOf(n.b)];
}

/** Structural edit: the leaf holding `target` becomes `repl`. */
function replaceLeaf(n: LayoutNode, target: SessionPane, repl: LayoutNode): LayoutNode {
  if (n === target) return repl;
  if (n instanceof SessionPane) return n;
  return { ...n, a: replaceLeaf(n.a, target, repl), b: replaceLeaf(n.b, target, repl) };
}

/** Structural edit: drop the leaf; a one-child node collapses to the child. */
function removeLeaf(n: LayoutNode, target: SessionPane): LayoutNode | null {
  if (n === target) return null;
  if (n instanceof SessionPane) return n;
  const a = removeLeaf(n.a, target);
  const b = removeLeaf(n.b, target);
  if (a && b) return { ...n, a, b };
  return a ?? b;
}

/** Structural edit: two panes trade leaves (a dragged pane dropped on one). */
function swapLeaves(n: LayoutNode, x: SessionPane, y: SessionPane): LayoutNode {
  if (n === x) return y;
  if (n === y) return x;
  if (n instanceof SessionPane) return n;
  return { ...n, a: swapLeaves(n.a, x, y), b: swapLeaves(n.b, x, y) };
}

/**
 * Structural edit: a dragged pane dropped at an edge of another pane. The
 * target's slot becomes an oriented pair - the dragged pane takes the
 * dropped side of it, the target keeps the other half.
 */
function insertAtEdge(
  root: LayoutNode,
  src: SessionPane,
  dst: SessionPane,
  side: 'left' | 'right' | 'top' | 'bottom'
): LayoutNode {
  let t = removeLeaf(root, src);
  if (!t) t = dst; // src was the root (paranoia - a drop needs two panes)
  const dir: 'h' | 'v' = side === 'left' || side === 'right' ? 'h' : 'v';
  const srcFirst = side === 'left' || side === 'top';
  const pair: SplitNode = srcFirst
    ? { dir, a: src, b: dst, frac: 0.5 }
    : { dir, a: dst, b: src, frac: 0.5 };
  return replaceLeaf(t, dst, pair);
}

/** Where a drag point sits in a pane: an edge zone or the middle (swap). */
type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';
function dropZone(r: DOMRect, x: number, y: number): DropZone {
  const near = Math.min(36, r.width / 4); // x-axis threshold
  const nearY = Math.min(36, r.height / 4);
  const edges: [DropZone, number, number][] = [
    ['left', x - r.left, near],
    ['right', r.right - x, near],
    ['top', y - r.top, nearY],
    ['bottom', r.bottom - y, nearY]
  ];
  edges.sort((p, q) => p[1] - q[1]);
  return edges[0][1] <= edges[0][2] ? edges[0][0] : 'center';
}

/** The panes list and data-pane indexes follow the tree's traversal order. */
function syncPanesFromLayout(): void {
  panes.length = 0;
  panes.push(...leavesOf(layout));
  panes.forEach((p, idx) => {
    p.el.dataset.pane = String(idx);
  });
  if (activePane && !panes.includes(activePane)) {
    activePane = null; // let setActive run its full path
    setActive(panes[0] ?? null);
  }
}

// -- tree persistence (reload keeps the arrangement and divider positions) --
interface TreeSave {
  d: 'h' | 'v';
  f: number;
  a: TreeSave | null; // null = leaf (a pane, in traversal order)
  b: TreeSave | null;
}
function saveTreeState(): void {
  const ser = (n: LayoutNode): TreeSave | null =>
    n instanceof SessionPane ? null : { d: n.dir, f: n.frac, a: ser(n.a), b: ser(n.b) };
  if (!layout || layout instanceof SessionPane) localStorage.removeItem(TREE_KEY);
  else localStorage.setItem(TREE_KEY, JSON.stringify(ser(layout)));
}
function loadTreeState(count: number): LayoutNode | null {
  let raw: TreeSave | null = null;
  try {
    raw = JSON.parse(localStorage.getItem(TREE_KEY) ?? 'null') as TreeSave | null;
  } catch {
    return null;
  }
  if (!raw) return null;
  let leaf = 0;
  const deser = (s: TreeSave | null): LayoutNode | null => {
    if (!s) return panes[leaf++] ?? null;
    const a = deser(s.a);
    const b = deser(s.b);
    if (!a || !b) return null;
    const f = Number.isFinite(s.f) ? Math.min(1 - MIN_FRAC, Math.max(MIN_FRAC, s.f)) : 0.5;
    return { dir: s.d === 'v' ? 'v' : 'h', a, b, frac: f };
  };
  const tree = deser(raw);
  // The saved tree must account for exactly the live panes, else discard it.
  return leaf === count && tree ? tree : null;
}
/** Balanced default tree for a deep link's N panes (2: pair, 4: quad...). */
function defaultTree(rootDir: 'h' | 'v'): LayoutNode | null {
  const build = (lo: number, hi: number, dir: 'h' | 'v'): LayoutNode | null => {
    if (lo >= hi) return null;
    if (hi - lo === 1) return panes[lo];
    const inner: 'h' | 'v' = dir === 'h' ? 'v' : 'h';
    const mid = lo + Math.ceil((hi - lo) / 2);
    const a = build(lo, mid, inner);
    const b = build(mid, hi, inner);
    if (!a || !b) return a ?? b;
    return { dir, a, b, frac: (mid - lo) / (hi - lo) };
  };
  return build(0, panes.length, rootDir);
}

/**
 * Rebuild #panes' DOM from the layout tree. Panes are plain elements that
 * are re-parented, never recreated - sessions and canvases survive. In Tabs
 * mode (or with a single pane) only the focused pane is on stage; the rest
 * stay detached but connected.
 */
function renderLayout(): void {
  const wrap = $('panes');
  const solo = layout === null || layout instanceof SessionPane || (tabsMode && panes.length > 1);
  const shown = solo ? (activePane ?? panes[0]) : null;
  wrap.replaceChildren();
  if (shown) {
    // A pane leaving a split keeps its inline flex share (grow 0.5 as a
    // lone flex item means HALF the box, not all of it) - back to the
    // stylesheet's fill.
    clearFlex(shown.el);
    wrap.append(shown.el);
  } else if (layout) {
    wrap.append(buildNode(layout));
  }
  wrap.dataset.panes = String(panes.length);
  // split controls exist only while there is something to manage
  $('split-group').classList.toggle('hidden', panes.length < 2);
  $<HTMLButtonElement>('btn-addpane').disabled = panes.length >= MAX_PANES;
  $('grid-view-tiles').classList.toggle('active', !tabsMode);
  $('grid-view-tabs').classList.toggle('active', tabsMode);
  renderTabbar();
  fitPanes();
  syncGridUrl();
  saveTreeState();
  // Re-parenting the element that held focus (a picker input) can blur it.
  if (!coarsePointer && document.activeElement === document.body) {
    (activePane?.screenEl.querySelector('.sys-menu input') as HTMLElement | null)?.focus();
  }
}

function applyFlex(el: HTMLElement, frac: number): void {
  el.style.flexGrow = String(frac);
  el.style.flexShrink = '0';
  el.style.flexBasis = '0';
}

function clearFlex(el: HTMLElement): void {
  el.style.flexGrow = '';
  el.style.flexShrink = '';
  el.style.flexBasis = '';
}

function buildNode(n: LayoutNode): HTMLElement {
  if (n instanceof SessionPane) return n.el;
  const el = document.createElement('div');
  el.className = `split split-${n.dir}`;
  const a = buildNode(n.a);
  const b = buildNode(n.b);
  applyFlex(a, n.frac);
  applyFlex(b, 1 - n.frac);
  el.append(a, makeSplitter(n, el), b);
  return el;
}

/** The draggable divider of one split node (double-click resets it). */
function makeSplitter(node: SplitNode, containerEl: HTMLElement): HTMLElement {
  const sp = document.createElement('div');
  sp.className = 'splitter';
  sp.title = 'Drag to resize - double-click to reset';
  let raf = 0;
  const setFrac = (f: number): void => {
    node.frac = f;
    const first = containerEl.firstElementChild as HTMLElement | null;
    const last = containerEl.lastElementChild as HTMLElement | null;
    if (first && last) {
      applyFlex(first, f);
      applyFlex(last, 1 - f);
    }
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        fitPanes();
      });
    }
  };
  let dragging = false;
  sp.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    sp.setPointerCapture(e.pointerId);
    sp.classList.add('dragging');
    e.preventDefault();
  });
  sp.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = containerEl.getBoundingClientRect();
    const f =
      node.dir === 'h' ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
    setFrac(Math.min(1 - MIN_FRAC, Math.max(MIN_FRAC, f)));
  });
  const end = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    sp.classList.remove('dragging');
    sp.releasePointerCapture(e.pointerId);
    setFrac(node.frac); // settle the final fit
    saveTreeState();
  };
  sp.addEventListener('pointerup', end);
  sp.addEventListener('pointercancel', end);
  sp.addEventListener('dblclick', () => setFrac(0.5));
  return sp;
}

/** ?grid= tracks the live pane count for reloads; single-pane clears it. */
function syncGridUrl(): void {
  const u = new URL(window.location.href);
  if (panes.length > 1) {
    // Split supersedes the single-session deep links (?system=/?attach=).
    u.searchParams.delete('system');
    u.searchParams.delete('attach');
    u.searchParams.set('grid', String(panes.length));
  } else {
    u.searchParams.delete('grid');
    u.searchParams.delete('systems');
  }
  u.searchParams.delete('split');
  history.replaceState(null, '', u.href);
}

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
    if (!pane.viewOnly) focusTerminal();
    // Typing belongs to the newly focused pane: drop focus that a picker
    // input of another pane is still holding (its mousedown was prevented).
    const ae = document.activeElement as HTMLElement | null;
    if (ae?.closest('.sys-menu') && !pane.screenEl.contains(ae)) ae.blur();
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
    // A view-only mirror can copy but never paste into the host.
    $('ctx-paste').classList.toggle('hidden', pane.viewOnly);
  },
  openSystemMenu(pane) {
    openMenuFor(pane);
  },
  onSplitPane(pane, dir) {
    splitPane(pane, dir);
  },
  onPopOut(pane) {
    popOut(pane);
  },
  onShare(pane) {
    copyShareLink(pane);
  },
  onClose(pane) {
    if (!pane.confirmLeave()) return;
    closePane(pane, true); // the confirm said "End the current session?"
  },
  onPaneDragStart(pane) {
    dragPane = pane;
    pane.el.classList.add('drag-source');
  },
  onPaneDragEnd() {
    dragPane = null;
    for (const p of panes) {
      p.el.classList.remove('drag-source', 'drop-target', 'drop-target-left', 'drop-target-right', 'drop-target-top', 'drop-target-bottom');
      tabOf(p)?.classList.remove('drop-target');
    }
  },
  onPaneDragOver(pane, e) {
    if (!dragPane || dragPane === pane) return;
    const zone = e ? dropZone(pane.el.getBoundingClientRect(), e.clientX, e.clientY) : 'center';
    const cls = zone === 'center' ? 'drop-target' : `drop-target-${zone}`;
    if (!pane.el.classList.contains(cls)) {
      paneServices.onPaneDragLeave(pane);
      pane.el.classList.add(cls);
    }
  },
  onPaneDragLeave(pane) {
    pane.el.classList.remove('drop-target', 'drop-target-left', 'drop-target-right', 'drop-target-top', 'drop-target-bottom');
    tabOf(pane)?.classList.remove('drop-target');
  },
  onPaneDrop(pane, e) {
    const src = dragPane;
    const zone = e ? dropZone(pane.el.getBoundingClientRect(), e.clientX, e.clientY) : 'center';
    paneServices.onPaneDragEnd();
    if (!src || src === pane) return;
    if (zone === 'center') {
      layout = swapLeaves(layout ?? src, src, pane);
    } else {
      layout = insertAtEdge(layout ?? src, src, pane, zone);
    }
    syncPanesFromLayout();
    renderLayout();
    saveGridState();
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

/**
 * Split one pane in two: the pane keeps its session in its half, a fresh
 * pane takes the other and picks its system.
 */
function splitPane(target: SessionPane, dir: 'h' | 'v'): void {
  if (panes.length >= MAX_PANES) return;
  hideMenu();
  const pane = createPane();
  layout = replaceLeaf(layout ?? target, target, { dir, a: target, b: pane, frac: 0.5 });
  syncPanesFromLayout();
  renderLayout();
  saveGridState();
  // A target that never picked a system needs its picker in the new half.
  if (target.systemId === null && !target.target.attach) {
    openPanePicker(
      target.screenEl,
      (s) => {
        target.connect({ system: s });
        focusTerminal();
      },
      { focus: false }
    );
  }
  openMenuFor(pane);
}

function createPane(init: { system?: number | null; attach?: string; connectNow?: boolean } = {}): SessionPane {
  const pane = new SessionPane(panes.length, paneServices);
  pane.setZoom(zoom ?? 1);
  pane.systemId = init.system ?? null; // hello confirms/matches it later
  panes.push(pane);
  layout ??= pane; // the tree grows by splitting this leaf later

  // ?attach= reattaches to the previous session after a reload; ?system= is
  // the fallback (and the deep-link assignment) when it no longer exists.
  const target: SessionTarget = {};
  if (init.attach) target.attach = init.attach;
  if (init.system) {
    void fetchSystems()
      .then((rows) => {
        target.system = rows.find((r) => r.id === init.system);
        if (init.connectNow !== false) pane.connect(target);
      })
      .catch(() => {
        if (init.connectNow !== false) pane.connect(target);
      });
  } else if (init.connectNow !== false && (init.attach || init.connectNow)) {
    pane.connect(target);
  }
  return pane;
}

/** Drop a pane from the tree (its element goes with it). */
function removeFromTree(pane: SessionPane): void {
  layout = layout ? removeLeaf(layout, pane) : null;
  pane.el.remove();
  syncPanesFromLayout();
}

/**
 * Close a pane. `end` (the × button after its confirm) ends the host session
 * outright - the device name and the user's message queue free up on the
 * host immediately; without it (pop-out) the session detaches into the
 * grace, which is what keeps it transferable.
 */
function closePane(pane: SessionPane, end = false): void {
  const wasMulti = panes.length > 1;
  if (end) pane.end();
  else pane.detach();
  removeFromTree(pane);
  if (panes.length === 0) {
    exitSplit(false);
    createPane();
    renderLayout();
    void showMenuFor();
    return;
  }
  if (wasMulti && panes.length === 1) exitSplit(true);
  else {
    saveGridState();
    renderLayout();
  }
}

/** Pop a pane's session out into a real browser window (and drop the pane). */
function popOut(pane: SessionPane): void {
  if (!pane.token) return;
  const u = new URL(window.location.href);
  u.searchParams.delete('grid');
  u.searchParams.delete('systems');
  u.searchParams.delete('split');
  if (pane.systemId !== null) u.searchParams.set('system', String(pane.systemId));
  else u.searchParams.delete('system');
  u.searchParams.set('attach', pane.token);
  // window.open must run inside the click gesture or the popup blocker eats
  // it. The session itself is safe either way: the new window attaches to
  // the same token, detaching this pane's front-end server-side.
  // The window name is per session: a constant name would make the second
  // pop-out navigate (and silently end) the first one's window.
  const win = window.open(u.href, `web5250-${pane.token}`, 'popup=yes,width=1000,height=680');
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
    // A pane whose system picker is open has no session to type into - the
    // keyboard stays with the picker (its input handles arrows/Enter/Esc).
    if (!coarsePointer) {
      (activePane.screenEl.querySelector('.sys-menu input') as HTMLElement | null)?.focus();
    }
  }
  if (tabsMode && panes.length > 1) renderLayout();
}

/** The tab strip for tabs mode: one button per pane, click (or drag) to focus. */
function renderTabbar(): void {
  const bar = $('tabbar');
  const show = panes.length > 1 && tabsMode;
  bar.classList.toggle('hidden', !show);
  if (!show) return;
  bar.replaceChildren(
    ...panes.map((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab' + (p === activePane ? ' active' : '');
      b.textContent = p.label || `Session ${p.index + 1}`;
      b.title = 'Show this session (drag onto another tab to swap)';
      b.addEventListener('click', () => {
        setActive(p);
        focusTerminal();
      });
      // Tabs drag with the same swap semantics as pane headers.
      b.draggable = true;
      b.addEventListener('dragstart', () => paneServices.onPaneDragStart(p));
      b.addEventListener('dragend', () => paneServices.onPaneDragEnd());
      b.addEventListener('dragover', (e) => {
        e.preventDefault();
        paneServices.onPaneDragOver(p);
      });
      b.addEventListener('dragleave', () => paneServices.onPaneDragLeave(p));
      b.addEventListener('drop', (e) => {
        e.preventDefault();
        paneServices.onPaneDrop(p);
      });
      return b;
    })
  );
}

/** The tab button showing this pane (tabs mode only). */
function tabOf(p: SessionPane): HTMLElement | null {
  if (!(panes.length > 1 && tabsMode)) return null;
  return $('tabbar').children[panes.indexOf(p)] as HTMLElement | null;
}

function setTabsMode(tabs: boolean): void {
  tabsMode = tabs;
  if (tabs) localStorage.setItem(GRID_VIEW_KEY, 'tabs');
  else localStorage.removeItem(GRID_VIEW_KEY);
  renderLayout();
}

/** Leave split view; extra panes end (deliberate exit skips the grace). */
function exitSplit(keepFirst: boolean): void {
  tabsMode = false;
  localStorage.removeItem(GRID_VIEW_KEY);
  localStorage.removeItem(GRID_STATE_KEY);
  localStorage.removeItem(TREE_KEY);
  const keep = keepFirst ? panes[0] : null;
  for (const p of panes) if (p !== keep) p.end();
  panes.length = 0;
  layout = keep;
  if (keep) panes.push(keep);
  if (activePane && activePane !== keep) {
    activePane = null;
    setActive(keep);
  }
  renderLayout();
}

/**
 * Open system selection for a pane: an in-pane picker while other panes are
 * on stage (the full-window menu would cover them), the classic full-screen
 * menu for the single-pane / landing states.
 */
function openMenuFor(pane: SessionPane): void {
  menuTarget = pane;
  setActive(pane);
  const pick = (s: MenuSystem): void => {
    menuTarget?.connect({ system: s });
    menuTarget = null;
  };
  if (panes.length > 1) {
    hideMenu();
    openPanePicker(pane.screenEl, (s) => {
      pick(s);
      focusTerminal();
    });
    return;
  }
  void showMenu((s) => {
    hideMenu();
    pick(s);
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
  // landing state); embedded launches never get it, and a view-only mirror
  // has no system of its own to switch. Zoom is pure client-side sizing, so
  // the mirror keeps it.
  const anySocket = panes.some((p) => p.hasSocket());
  $('btn-systems').classList.toggle('hidden', autoLaunch || shareView || !anySocket);
  $('zoom-group').classList.toggle('hidden', autoLaunch || (!shareView && !anySocket));
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
function showToast(text: string): void {
  const toast = $('copy-toast');
  toast.textContent = text;
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 1600);
}
function showCopiedToast(chars: number): void {
  showToast(`${chars} characters copied`);
}

/** Synchronous copy attempt that works on insecure origins (inside a user gesture). */
function execCopy(text: string): boolean {
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
  return ok;
}

// The view-only share link: one URL that mirrors this pane's session in any
// other window - locally or on a remote machine that can reach this origin.
// Built from the page URL so sub-path deployments (Pangolin rules without
// rewrite) produce working links; every parameter of this page is dropped -
// the link carries only the share token.
function copyShareLink(pane: SessionPane): void {
  const token = pane.shareToken;
  if (!token) return;
  const u = new URL(window.location.href);
  for (const key of [...u.searchParams.keys()]) u.searchParams.delete(key);
  u.searchParams.set('view', token);
  const link = u.href;
  const done = () => showToast('Share link copied — opens a view-only mirror');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(link).then(done, () => {
      if (!execCopy(link)) showCopyFallback(link, 'Share link');
      else done();
    });
    return;
  }
  if (execCopy(link)) done();
  else showCopyFallback(link, 'Share link');
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
  if (execCopy(text)) showCopiedToast(text.length);
  else showCopyFallback(text, 'Selected text');
}

// ------------------------------------------------------------ leave guard
// Closing the tab or navigating away drops the sockets; with a gateway grace
// period the sessions survive that and are offered again on reload, so
// leaving costs nothing and must not nag. Embedded launches (?auto=1) are
// torn down by the parent page, so they stay out of this either way - and a
// view-only mirror never ends anything it watches.
if (!autoLaunch && !shareView) {
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

  if (shareViewToken) {
    // ?view=<share token>: a chrome-light read-only mirror of one running
    // session (see copyShareLink). It reconnects on reload with the same
    // token and ends quietly when the shared session does.
    const pane = createPane({ connectNow: false });
    renderLayout();
    setActive(pane);
    pane.connect({ view: shareViewToken });
    return;
  }

  if (urlGridPanes !== null) {
    // ?split=h|v only picks the deep link's root direction (legacy param).
    const rootDir = params.get('split') === 'v' ? 'v' : 'h';
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
    // The saved tree (with divider positions) matches only the same pane
    // count; anything else gets the balanced default.
    layout = loadTreeState(panes.length) ?? defaultTree(rootDir);
    syncPanesFromLayout();
    renderLayout();
    setActive(panes[0] ?? null);
    // Panes with no target at all each offer their own in-pane picker (a
    // pane reattaching via its saved token is mid-connect here, not empty).
    const empties = panes.filter((p) => p.systemId === null && !p.target.attach);
    for (const p of empties) {
      openPanePicker(
        p.screenEl,
        (s) => {
          p.connect({ system: s });
          focusTerminal();
        },
        { focus: p === (empties[0] ?? panes[0]) }
      );
    }
    return;
  }

  if (attachToken) {
    // ?attach=<token>[&system=<id>]: re-bind to the running gateway-side
    // session (pop-out window, reloaded page). If the token has expired the
    // status-error handler falls back once to a fresh session on the system.
    const begin = (system?: MenuSystem): void => {
      const pane = createPane({ connectNow: false });
      renderLayout();
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
        renderLayout();
        setActive(pane);
        if (row) pane.connect({ system: row });
        else void showMenuFor();
      })
      .catch(() => {
        createPane();
        renderLayout();
        void showMenuFor();
      });
    return;
  }

  if (params.has('host') || autoLaunch) {
    // Legacy custom-host deep link (?host=...&port=... with ALLOW_CUSTOM_HOST),
    // or an automated launch (?auto=1) without a ?system= selection: connect
    // straight to the environment-default host - a menu has no role embedded.
    const pane = createPane({ connectNow: false });
    renderLayout();
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
        renderLayout();
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
  renderLayout();
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

/**
 * Refit every on-stage pane's terminal into its box (a layout slot whose
 * size the splitter drag or a stage resize just changed).
 */
function fitPanes(): void {
  for (const p of panes) {
    if (!p.el.isConnected) continue;
    const availW = p.el.clientWidth - 2; // safety against rounding overflow
    const availH = p.el.clientHeight - 2 - barHeight(p) - oiaHeight(p);
    if (availW > 0 && availH > 0) {
      p.setZoom(zoom ?? 1);
      p.fitInto(availW, availH);
    }
  }
}
function barHeight(p: SessionPane): number {
  return (p.el.querySelector('.pane-bar') as HTMLElement)?.offsetHeight ?? 0;
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
  if (coarsePointer && !shareView) mobileInput.focus({ preventScroll: true });
  // With a mouse there is nothing to focus: key events are captured at
  // window level and routed to the focused pane. A mirror drops them in the
  // pane, and focusing the hidden input would only raise a keyboard that
  // cannot type anywhere.
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
// Escape dismisses open pane pickers before the terminal mapping can turn it
// into SysReq. This capture listener is registered before attachKeyboard's,
// so it sees the key first; when focus is already inside a picker (or the
// landing menu) their own handlers deal with it.
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape') return;
    if (e.target instanceof HTMLElement && e.target.closest('.sys-menu, #menu')) return;
    if (closePanePickers()) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  { capture: true }
);
attachKeyboard(sendKey, () => !uiSurfaceOpen());
buildKeypad(sendKey);
initMenu();
// The landing menu's split buttons split the focused pane like the per-pane
// ones do (at the landing state that is the single pane).
setSplitHandler((dir) => splitPane(activePane ?? panes[0], dir));

$('btn-systems').addEventListener('click', () => {
  const pane = activePane ?? panes[0];
  if (!pane) return;
  if (pane.confirmLeave()) {
    pane.end();
    openMenuFor(pane);
  }
});
$('btn-addpane').addEventListener('click', () => {
  // + Pane splits the roomiest pane (a wide one side by side, a tall one
  // stacked) - it is the same operation as a pane's own split buttons.
  if (panes.length >= MAX_PANES) return;
  let target = panes[0];
  let best = -1;
  for (const p of panes) {
    const area = (p.el.clientWidth || 0) * (p.el.clientHeight || 0);
    if (area > best) {
      best = area;
      target = p;
    }
  }
  splitPane(target, (target.el.clientWidth || 1) >= (target.el.clientHeight || 1) ? 'h' : 'v');
});
$('grid-view-tiles').addEventListener('click', () => setTabsMode(false));
$('grid-view-tabs').addEventListener('click', () => setTabsMode(true));
$('btn-exitsplit').addEventListener('click', () => {
  // Deliberate exit: the extra sessions end now (skipping the grace) - the
  // same confirm a single pane's × would ask for each of them.
  const active = panes.slice(1).filter((p) => p.sessionActive());
  const what = active.length === 1 ? 'the extra session' : `the ${active.length} extra sessions`;
  if (active.length > 0 && !window.confirm(`End ${what}?`)) return;
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
if (coarsePointer && !shareView) {
  keypad.classList.remove('hidden');
  $('btn-kbd').classList.remove('hidden');
}
// A view-only mirror cannot type: the key-mapping help and the on-screen /
// soft keyboard toggles would only describe input that goes nowhere.
if (shareView) {
  $('btn-keys').classList.add('hidden');
  $('btn-keypad').classList.add('hidden');
}
// These toggles must not steal focus from the typing input - the focus
// loss would close the soft keyboard on a touch device.
for (const id of ['btn-keypad', 'btn-kbd']) {
  $(id).addEventListener('mousedown', (e) => e.preventDefault());
}
$('btn-keypad').addEventListener('click', () => {
  delete keypad.dataset.autoHidden; // a manual toggle always wins
  keypad.classList.toggle('hidden');
  fitPanes();
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
    fitPanes();
  }
});
mobileInput.addEventListener('focusout', () => {
  if (keypad.dataset.autoHidden === '1') {
    delete keypad.dataset.autoHidden;
    keypad.classList.remove('hidden');
    fitPanes();
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
