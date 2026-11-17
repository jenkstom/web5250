// System-selection menu + administrator editor.
//
// The menu is the app's landing screen: a retro 5250-style panel listing the
// systems from the gateway's SQLite store. Users pick one with the arrow
// keys / a number + Enter, or by tapping. The admin editor (PIN-gated on the
// server via ADMIN_PIN) manages that list: add, edit, delete, reorder.
import { recheckSpool } from './spool.ts';
import { openHelp } from './help/help.ts';
import { loadKeymaps, keyLabel, KEY_LABELS, type KeyBinding } from './keymaps.ts';
import { mapEvent } from './keyboard.ts';
export interface MenuSystem {
  /**
   * The system's menu id: a stored system's numeric catalog id, or a
   * directory host's "dir:<entry id>" string (those exist only while the
   * directory service is up, and are passed back opaquely on connect).
   */
  id: number | string;
  name: string;
  description: string;
  host: string;
  port: number;
  ssl: boolean;
  termType: string;
  codePage: string;
  devPrefix: string | null;
  /** True on the public list: this system connects through a SOCKS5 proxy. */
  viaProxy?: boolean;
  /** True on the public list: the gateway opens a printer session for this
   * system while display sessions target it (spool button + badge appear). */
  printerEnabled?: boolean;
  /** Present while a maintenance window blocks this system. */
  maintenance?: { on: boolean; message: string; deadlineAt: number | null } | null;
  /** True: sessions on this system are recorded for replay (admin flag). */
  recording?: boolean;
  /** Present only on the admin editor's (authenticated) copy of the row. */
  proxyHost?: string | null;
  proxyPort?: number | null;
  proxyUser?: string | null;
  proxyPass?: string | null;
  printerDeviceName?: string | null;
  printerMode?: 'text' | 'raw';
  /** True: this row is materialized from the directory service (it re-syncs). */
  directory?: boolean | null;
  /** True: the directory holds a sign-on credential (sessions sign on alone). */
  autoSignOn?: boolean;
  /** Admin-only copy: a stored sign-on pair (present on the authenticated rows). */
  signOnUser?: string | null;
  signOnPassword?: string | null;
  /** Custom keymap overlay: null = gateway default, 0 = built-in map, n = keymap. */
  keymapId?: number | null;
}

interface Meta {
  adminEnabled: boolean;
  allowCustomHost: boolean;
  showDiagButton?: boolean;
  assistEnabled?: boolean;
  /** Admin break-glass takeover available (ADMIN_ASSIST_BREAKGLASS). */
  breakglass?: boolean;
  identityHeader?: boolean;
  /** Directory service integration configured (DIRECTORY_URL). */
  directory?: boolean;
  /** The sign-on protection PIN is armed (prompt before automatic sign-on). */
  signOnPin?: boolean;
  termTypes: string[];
  codePages: string[];
  defaults: { port: number; ssl: boolean; termType: string; codePage: string; devPrefix: string };
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

/** API base derives from the page path (sub-path deploy tolerant), like wsUrl(). */
const api = (name: string): string =>
  window.location.origin + window.location.pathname.replace(/[^/]*$/, '') + name;

// ------------------------------------------------------------------ state
/** Rows per menu page: the landing menu is a centered dialog, and ten
 *  two-line rows (plus its chrome) fit a laptop screen without scrolling.
 *  The pane picker paginates too, with its own smaller page. */
const MENU_PAGE_SIZE = 10;
let systems: MenuSystem[] = [];
let meta: Meta | null = null;
let selected = 0;
let page = 0;
/**
 * Quick-search text from the Option/Filter field ('' = none). The field is
 * dual-mode: digits-only keeps the classic number jump; any other text is a
 * live filter (case-insensitive; every whitespace-separated term must occur
 * in the row's name, description or host). It survives show/hide so the
 * menu reopens on the same narrowed list.
 */
let filterText = '';
let onSelect: ((s: MenuSystem) => void) | null = null;
let booted = false;

/** The list as currently filtered - the whole catalog when no filter runs.
 *  Everything that numbers or picks rows (render, select, pager, connect)
 *  addresses this view, so filtered rows renumber 1..N on screen. */
function viewSystems(): MenuSystem[] {
  if (!filterText) return systems;
  const terms = filterText.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return systems;
  const hay = (s: MenuSystem): string =>
    `${s.name} ${s.description} ${s.host}`.toLowerCase();
  return systems.filter((s) => terms.every((t) => hay(s).includes(t)));
}

// ------------------------------------------------------------- display name
const DEVNAME_KEY = 'web5250.displayName';

/** Legal 5250 device-name characters, uppercased, 10 chars max. */
function cleanDisplayName(v: string): string {
  return v.trim().toUpperCase().replace(/[^A-Z0-9#$@_]/g, '').slice(0, 10);
}

/** The browser's saved display name (or null) - sent as ?devname=. */
export function displayName(): string | null {
  return cleanDisplayName(localStorage.getItem(DEVNAME_KEY) ?? '') || null;
}

export function menuVisible(): boolean {
  return !$('menu').classList.contains('hidden');
}

export async function fetchSystems(): Promise<MenuSystem[]> {
  const res = await fetch(api('api/systems'), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`systems list failed (${res.status})`);
  const data = (await res.json()) as { systems: MenuSystem[] };
  return data.systems ?? [];
}

async function fetchMeta(): Promise<Meta> {
  const res = await fetch(api('api/meta'), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`meta failed (${res.status})`);
  return (await res.json()) as Meta;
}

/** The editor's row: the admin list carries stored systems only, so its ids
 *  are always numeric (directory hosts never reach this editor). */
type AdminSystem = MenuSystem & { id: number };

/** The editor's copy of the list: full rows, proxy credentials included. */
async function fetchAdminSystems(): Promise<AdminSystem[]> {
  const res = await adminCall('GET', 'api/admin/systems');
  if (!res.ok) throw new Error(`admin systems list failed (${res.status})`);
  const data = (await res.json()) as { systems: AdminSystem[] };
  return data.systems ?? [];
}

let metaPromise: Promise<Meta | null> | null = null;

/** /api/meta, fetched once per page load (null when the gateway is unreachable). */
export function loadMeta(): Promise<Meta | null> {
  metaPromise ??= fetchMeta().catch(() => null);
  return metaPromise;
}

/**
 * Whether the sign-on protection PIN is armed, read fresh from /api/meta -
 * the page-lifetime cache in loadMeta() can predate an admin arming or
 * clearing the PIN (another browser, or this page's own admin console), and
 * the connect-time gate must not act on a stale answer.
 */
export async function signOnPinArmed(): Promise<boolean> {
  try {
    return (await fetchMeta()).signOnPin === true;
  } catch {
    return false; // unreachable gateway: the connect itself will say so
  }
}

/** Show the menu and (re)load its data. Called on first start and whenever a session ends. */
export async function showMenu(callback: (s: MenuSystem) => void): Promise<void> {
  onSelect = callback;
  // Keymap overlays ride along (admin edits land the next time the menu
  // appears; a failed fetch quietly keeps the last good catalog).
  void loadKeymaps();
  const menu = $('menu');
  menu.classList.remove('hidden');
  if (!booted) {
    booted = true;
    menu.classList.add('boot');
    window.setTimeout(() => menu.classList.remove('boot'), 600);
  }
  meta ??= await loadMeta();
  try {
    systems = await fetchSystems();
    $('menu-error').classList.add('hidden');
  } catch (e) {
    systems = [];
    const err = $('menu-error');
    err.textContent = `Could not load the system list — ${String((e as Error).message ?? e)}`;
    err.classList.remove('hidden');
  }
  const view = viewSystems();
  selected = Math.min(selected, Math.max(view.length - 1, 0));
  page = Math.floor(selected / MENU_PAGE_SIZE);
  render();
  $('menu-option').focus();
}

export function hideMenu(): void {
  $('menu').classList.add('hidden');
  closeAdmin();
}

/** The shell's in-place split handler (installed at startup). */
let onSplit: ((dir: 'h' | 'v') => void) | null = null;
export function setSplitHandler(fn: (dir: 'h' | 'v') => void): void {
  onSplit = fn;
}

// -------------------------------------------------------------- rendering
/** Maintenance suffix for a blocked system's menu row. */
function maintLabel(s: MenuSystem): string {
  const m = s.maintenance;
  if (!m?.on) return '';
  return m.deadlineAt ? ` · MAINTENANCE until ${new Date(m.deadlineAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ' · MAINTENANCE';
}

/** Suffix flags a system row carries on its sub-line (menu + pane picker). */
function rowFlags(s: MenuSystem): string {
  let out = '';
  if (s.viaProxy) out += ' · SOCKS5';
  if (s.printerEnabled) out += ' · printer';
  if (s.directory) out += ' · directory';
  if (s.autoSignOn) out += ' · auto sign-on';
  return out;
}

function render(): void {
  const list = $('menu-list');
  list.innerHTML = '';
  // One page of rows at a time; the row numbers address the whole catalog
  // (or, while filtering, the matching subset - the visible set renumbers,
  // so Option/Filter digits and typed numbers stay consistent with the
  // screen whichever mode is active).
  const view = viewSystems();
  const pages = Math.max(1, Math.ceil(view.length / MENU_PAGE_SIZE));
  page = Math.min(page, pages - 1);
  const start = page * MENU_PAGE_SIZE;
  view.slice(start, start + MENU_PAGE_SIZE).forEach((s, i) => {
    const idx = start + i;
    const li = document.createElement('li');
    li.className = 'menu-row' + (idx === selected ? ' sel' : '') + (s.maintenance?.on ? ' maint' : '');

    const num = document.createElement('span');
    num.className = 'row-num';
    num.textContent = `${idx + 1}.`;

    const main = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = s.name;
    main.appendChild(name);
    if (s.description) {
      const desc = document.createElement('span');
      desc.className = 'row-desc';
      desc.textContent = ` — ${s.description}`;
      main.appendChild(desc);
    }
    const sub = document.createElement('span');
    sub.className = 'row-sub';
    sub.textContent =
      `${s.host}:${s.port} · ${s.ssl ? 'TLS' : 'telnet'} · ${s.termType} · ${s.codePage}` +
      rowFlags(s) + maintLabel(s);
    main.appendChild(sub);

    li.append(num, main);
    li.addEventListener('click', () => (selected === idx ? connectTo(idx) : select(idx)));
    list.appendChild(li);
  });

  // The pager only exists when the visible set cannot fit one page.
  const pager = $('menu-pager');
  if (view.length > MENU_PAGE_SIZE) {
    pager.classList.remove('hidden');
    $<HTMLButtonElement>('menu-prev').disabled = page === 0;
    $<HTMLButtonElement>('menu-next').disabled = page === pages - 1;
    $('menu-page-label').textContent = `Page ${page + 1} / ${pages}`;
  } else {
    pager.classList.add('hidden');
  }

  // Match count while filtering ("21 of 120") - hidden with no filter.
  const count = $('menu-count');
  if (filterText) {
    count.textContent = `${view.length} of ${systems.length}`;
    count.classList.remove('hidden');
  } else {
    count.classList.add('hidden');
  }

  const empty = $('menu-empty');
  if (view.length === 0 && $('menu-error').classList.contains('hidden')) {
    empty.textContent = filterText
      ? `No systems match "${filterText}".\nEsc clears the filter.`
      : 'No systems configured.\nSelect Admin below to add one.';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
  }
  // Keep the selection cursor on screen when even a single page outgrows the
  // panel (a short viewport). Nearest-edge only: an already-visible selection
  // never scrolls.
  list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });

  // In filter mode the field is showing the filter text itself - never
  // clobber it mid-typing. Otherwise it mirrors the selection's number.
  $<HTMLInputElement>('menu-option').value = filterText || (view.length ? String(selected + 1) : '');
}

function select(i: number): void {
  selected = Math.max(0, Math.min(i, viewSystems().length - 1));
  page = Math.floor(selected / MENU_PAGE_SIZE);
  render();
}

/** Page turn (PgUp/PgDn, pager buttons): the selection lands on the first
 *  row of the page turned onto (the last row when paging back). */
function turnPage(delta: 1 | -1): void {
  const view = viewSystems();
  const pages = Math.max(1, Math.ceil(view.length / MENU_PAGE_SIZE));
  const next = Math.min(pages - 1, Math.max(0, page + delta));
  if (next === page) return;
  page = next;
  const start = page * MENU_PAGE_SIZE;
  selected =
    delta > 0 ? start : Math.min(start + MENU_PAGE_SIZE - 1, view.length - 1);
  render();
}

function connectTo(i: number): void {
  const s = viewSystems()[i];
  if (s?.maintenance?.on) {
    const err = $('menu-error');
    err.textContent = `${s.name} is in maintenance — ${s.maintenance.message}`;
    err.classList.remove('hidden');
    return;
  }
  if (s && onSelect) {
    const cb = onSelect;
    onSelect = null;
    cb(s);
  }
}

// ---------------------------------------------------------- menu keyboard
/** Wire static DOM events once at startup (call from main.ts). */
export function initMenu(): void {
  const option = $<HTMLInputElement>('menu-option');
  option.addEventListener('keydown', (e) => {
    // A letter typed over the echoed selection number starts a fresh filter
    // (classic 5250 overtype): without this, "prod" over "1" would filter
    // on "1prod". Digits keep today's append/replace behavior, and '?'
    // stays the help shortcut (it never inserts).
    const overtypes =
      e.key.length === 1 &&
      e.key !== '?' &&
      /\S/.test(e.key) &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      /[^\d]/.test(e.key) &&
      /^\d+$/.test(option.value);
    if (overtypes) option.value = '';
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      select(selected - 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      select(selected + 1);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      turnPage(1);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      turnPage(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const view = viewSystems();
      const typed = Number.parseInt(option.value, 10);
      // Number+Enter stays classic - but only when the field is not a
      // filter ("prod5" must connect the selection, not row 5).
      const idx =
        !filterText && Number.isInteger(typed) && typed >= 1 && typed <= view.length
          ? typed - 1
          : selected;
      connectTo(idx);
    }
    // (No 'a' shortcut here: letters typed in this field are filter text,
    // and a filter may start with 'a' ("as400"). 'a' still works anywhere
    // outside the field, and as the Admin button. '?' stays a shortcut -
    // it cannot start a realistic filter.)
    else if (e.key === '?') {
      e.preventDefault();
      openHelp('user');
    } else if (e.key === 'Escape') {
      if (filterText) {
        // First Esc drops the filter; a second one resets the field.
        filterText = '';
        selected = Math.min(selected, Math.max(systems.length - 1, 0));
        page = Math.floor(selected / MENU_PAGE_SIZE);
        render();
      } else {
        option.value = systems.length ? String(selected + 1) : '';
      }
    }
  });
  option.addEventListener('input', () => {
    const v = option.value;
    if (/^\d*$/.test(v)) {
      // Digits-only (or empty): classic number jump. Clearing a filter this
      // way (backspacing its letters away) restores the full list.
      const hadFilter = filterText !== '';
      filterText = '';
      const view = viewSystems();
      const typed = Number.parseInt(v, 10);
      if (Number.isInteger(typed) && typed >= 1 && typed <= view.length) select(typed - 1);
      else if (hadFilter) {
        selected = Math.min(selected, Math.max(view.length - 1, 0));
        page = Math.floor(selected / MENU_PAGE_SIZE);
        render();
      }
    } else {
      // Any letter switches the field to a live filter; the cursor lands on
      // the first match and paging restarts.
      filterText = v;
      selected = 0;
      page = 0;
      render();
    }
  });

  // Menu-level keys, so Enter/arrows work no matter what inside the menu
  // holds focus (the option input handles its own keys; showMenu focuses it
  // only after its fetches settle - a quick Enter must not be lost). Keys
  // typed into the menu's own widgets belong to those widgets: Enter
  // submitting the admin PIN must not also connect to the selected system,
  // 'a' in the display-name field must not open admin, and Enter on a
  // focused button must click the button.
  $('menu').addEventListener('keydown', (e) => {
    if (e.target === option) return;
    if ((e.target as HTMLElement).closest('#admin-modal, input, select, textarea, button')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      connectTo(selected);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      select(selected - 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      select(selected + 1);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      turnPage(1);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      turnPage(-1);
    } else if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      openAdmin();
    } else if (e.key === '?') {
      e.preventDefault();
      openHelp('user');
    } else if (e.key === 'Escape') {
      hideMenu();
    }
  });

  $('menu-go').addEventListener('click', () => connectTo(selected));
  $('menu-help-btn').addEventListener('click', () => openHelp('user'));
  $('menu-admin-btn').addEventListener('click', openAdmin);
  $('menu-prev').addEventListener('click', () => turnPage(-1));
  $('menu-next').addEventListener('click', () => turnPage(1));

  // Split view: the shell lays the current page out into split panes in
  // place (no navigation) and keeps ?grid= in the URL for reloads/deep
  // links. Horizontal = side by side, vertical = stacked.
  $('menu-splith').addEventListener('click', () => onSplit?.('h'));
  $('menu-splitv').addEventListener('click', () => onSplit?.('v'));

  // Display name: persisted per-browser; cleaned while typing. Empty means
  // the gateway picks a name from the configured device prefix.
  const dev = $<HTMLInputElement>('menu-devname');
  dev.value = displayName() ?? '';
  dev.addEventListener('input', () => {
    const cleaned = cleanDisplayName(dev.value);
    if (cleaned !== dev.value) dev.value = cleaned;
    if (cleaned) localStorage.setItem(DEVNAME_KEY, cleaned);
    else localStorage.removeItem(DEVNAME_KEY);
  });

  initAdmin();
  initSignOnPinPrompt();
}

// ---------------------------------------------------------- pane pickers
// In split view the system selection happens *inside* the pane that needs a
// system: the landing menu above is a full-window overlay, exactly right as
// the app's entry point but wrong when it would cover the other live panes.
// A PanePicker is that menu shrunk into one pane - same rows, same keys,
// no admin/split/display chrome (those belong to the landing menu).
const pickers: PanePicker[] = [];

function prunePickers(): void {
  for (let i = pickers.length - 1; i >= 0; i--) {
    if (!pickers[i].el.isConnected) pickers.splice(i, 1);
  }
}

/** One picker per mount: reopening replaces instead of stacking. */
export function openPanePicker(
  mount: HTMLElement,
  onPick: (s: MenuSystem) => void,
  opts: { focus?: boolean } = {}
): void {
  prunePickers();
  const existing = pickers.find((p) => p.el.parentElement === mount);
  existing?.close();
  const picker = new PanePicker(mount, onPick, opts.focus ?? true);
  pickers.push(picker);
}

/** Dismiss every open pane picker (Escape). Returns true if any closed. */
export function closePanePickers(): boolean {
  prunePickers();
  const open = [...pickers];
  for (const p of open) p.close();
  return open.length > 0;
}

class PanePicker {
  /** Rows per page inside one split pane (panes are short; six fit). */
  private static readonly PAGE_SIZE = 6;
  readonly el: HTMLDivElement;
  private readonly listEl: HTMLUListElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly pageLabel: HTMLElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly emptyEl: HTMLElement;
  private readonly errEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly option: HTMLInputElement;
  private rows: MenuSystem[] = [];
  private selected = 0;
  private page = 0;
  /** Same dual-mode field as the landing menu ('' = classic number jump). */
  private filterText = '';

  constructor(
    mount: HTMLElement,
    private readonly onPick: (s: MenuSystem) => void,
    focus: boolean
  ) {
    const el = document.createElement('div');
    el.className = 'sys-menu';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Select a system for this pane');
    const frame = document.createElement('div');
    frame.className = 'sys-menu-frame';
    const title = document.createElement('div');
    title.className = 'sys-menu-title';
    title.textContent = 'SYSTEM SELECTION';
    const sub = document.createElement('p');
    sub.className = 'sys-menu-sub';
    sub.textContent = 'Select the system for this pane';
    this.listEl = document.createElement('ul');
    this.listEl.className = 'sys-menu-list';
    // The pager appears only when the list cannot fit one pane page.
    const pager = document.createElement('div');
    pager.className = 'pager hidden';
    this.prevBtn = document.createElement('button');
    this.prevBtn.type = 'button';
    this.prevBtn.textContent = '‹ Prev';
    this.prevBtn.addEventListener('click', () => this.turnPage(-1));
    this.pageLabel = document.createElement('span');
    this.nextBtn = document.createElement('button');
    this.nextBtn.type = 'button';
    this.nextBtn.textContent = 'Next ›';
    this.nextBtn.addEventListener('click', () => this.turnPage(1));
    pager.append(this.prevBtn, this.pageLabel, this.nextBtn);
    this.emptyEl = document.createElement('p');
    this.emptyEl.className = 'sys-menu-empty hidden';
    this.errEl = document.createElement('p');
    this.errEl.className = 'sys-menu-error hidden';
    const cmd = document.createElement('div');
    cmd.className = 'sys-menu-cmd';
    const label = document.createElement('label');
    label.textContent = 'Option/Filter ==>';
    this.option = document.createElement('input');
    this.option.autocomplete = 'off';
    this.option.autocapitalize = 'off';
    this.option.spellcheck = false;
    this.option.maxLength = 25;
    this.option.setAttribute('aria-label', 'System number or filter');
    label.append(this.option);
    this.countEl = document.createElement('span');
    this.countEl.className = 'menu-count hidden';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'primary';
    go.textContent = 'Connect';
    go.addEventListener('click', () => this.connectSelected());
    cmd.append(label, this.countEl, go);
    const foot = document.createElement('div');
    foot.className = 'sys-menu-foot';
    foot.append(
      (() => {
        const s = document.createElement('span');
        s.textContent = '↑↓ Select';
        return s;
      })(),
      (() => {
        const s = document.createElement('span');
        s.textContent = 'PgUp/PgDn Page';
        return s;
      })(),
      (() => {
        const s = document.createElement('span');
        s.textContent = 'Enter Connect';
        return s;
      })(),
      (() => {
        const s = document.createElement('span');
        s.className = 'spacer';
        return s;
      })(),
      (() => {
        const s = document.createElement('span');
        s.textContent = 'Esc Cancel';
        return s;
      })()
    );
    frame.append(title, sub, this.listEl, pager, this.emptyEl, this.errEl, cmd, foot);
    el.append(frame);
    this.el = el;

    // Same keyboard contract as the landing menu: arrows / typed number
    // select, PageUp/PageDown turn pages, Enter connects, Escape drops a
    // running filter first and cancels the picker second - from anywhere.
    el.addEventListener('keydown', (e) => {
      // A letter typed over the echoed number starts a fresh filter (the
      // landing menu's overtype rule, for its delegated listener).
      if (
        e.target === this.option &&
        e.key.length === 1 &&
        e.key !== '?' &&
        /\S/.test(e.key) &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        /[^\d]/.test(e.key) &&
        /^\d+$/.test(this.option.value)
      ) {
        this.option.value = '';
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.select(this.selected - 1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.select(this.selected + 1);
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        this.turnPage(1);
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        this.turnPage(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.connectSelected();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (this.filterText) this.clearFilter();
        else this.close();
      }
    });
    this.option.addEventListener('input', () => {
      const v = this.option.value;
      if (/^\d*$/.test(v)) {
        const hadFilter = this.filterText !== '';
        this.filterText = '';
        const view = this.view();
        const typed = Number.parseInt(v, 10);
        if (Number.isInteger(typed) && typed >= 1 && typed <= view.length) this.select(typed - 1);
        else if (hadFilter) {
          this.selected = Math.min(this.selected, Math.max(view.length - 1, 0));
          this.page = Math.floor(this.selected / PanePicker.PAGE_SIZE);
          this.render();
        }
      } else {
        this.filterText = v;
        this.selected = 0;
        this.page = 0;
        this.render();
      }
    });

    mount.append(el);
    if (focus) this.option.focus();
    void this.refresh();
  }

  /** The list as filtered by the picker's own field (same rules as the
   *  landing menu: every whitespace-separated term in name/description/host). */
  private view(): MenuSystem[] {
    if (!this.filterText) return this.rows;
    const terms = this.filterText.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return this.rows;
    const hay = (s: MenuSystem): string =>
      `${s.name} ${s.description} ${s.host}`.toLowerCase();
    return this.rows.filter((s) => terms.every((t) => hay(s).includes(t)));
  }

  /** Drop the filter and resettle the selection on the full list. */
  private clearFilter(): void {
    this.filterText = '';
    this.selected = Math.min(this.selected, Math.max(this.rows.length - 1, 0));
    this.page = Math.floor(this.selected / PanePicker.PAGE_SIZE);
    this.render();
  }

  private async refresh(): Promise<void> {
    try {
      this.rows = await fetchSystems();
      this.errEl.classList.add('hidden');
    } catch (e) {
      this.rows = [];
      this.errEl.textContent = `Could not load the system list — ${String((e as Error).message ?? e)}`;
      this.errEl.classList.remove('hidden');
    }
    const view = this.view();
    this.selected = Math.min(this.selected, Math.max(view.length - 1, 0));
    this.page = Math.floor(this.selected / PanePicker.PAGE_SIZE);
    this.render();
  }

  private render(): void {
    const view = this.view();
    const pages = Math.max(1, Math.ceil(view.length / PanePicker.PAGE_SIZE));
    this.page = Math.min(this.page, pages - 1);
    const start = this.page * PanePicker.PAGE_SIZE;
    this.listEl.replaceChildren(
      ...view.slice(start, start + PanePicker.PAGE_SIZE).map((s, i) => {
        const idx = start + i;
        const li = document.createElement('li');
        li.className = 'menu-row' + (idx === this.selected ? ' sel' : '');
        const num = document.createElement('span');
        num.className = 'row-num';
        num.textContent = `${idx + 1}.`;
        const main = document.createElement('span');
        const name = document.createElement('span');
        name.className = 'row-name';
        name.textContent = s.name;
        main.appendChild(name);
        if (s.description) {
          const desc = document.createElement('span');
          desc.className = 'row-desc';
          desc.textContent = ` — ${s.description}`;
          main.appendChild(desc);
        }
        const sub = document.createElement('span');
        sub.className = 'row-sub';
        sub.textContent =
          `${s.host}:${s.port} · ${s.ssl ? 'TLS' : 'telnet'}${rowFlags(s)}`;
        main.appendChild(sub);
        li.append(num, main);
        li.addEventListener('click', () =>
          this.selected === idx ? this.connectTo(idx) : this.select(idx)
        );
        return li;
      })
    );
    // Same pager as the landing menu (hidden while one page holds the list).
    const pagerEl = this.pageLabel.parentElement!;
    if (view.length > PanePicker.PAGE_SIZE) {
      pagerEl.classList.remove('hidden');
      this.prevBtn.disabled = this.page === 0;
      this.nextBtn.disabled = this.page === pages - 1;
      this.pageLabel.textContent = `Page ${this.page + 1} / ${pages}`;
    } else {
      pagerEl.classList.add('hidden');
    }
    if (this.filterText) {
      this.countEl.textContent = `${view.length} of ${this.rows.length}`;
      this.countEl.classList.remove('hidden');
    } else {
      this.countEl.classList.add('hidden');
    }
    if (view.length === 0 && this.errEl.classList.contains('hidden')) {
      this.emptyEl.textContent = this.filterText
        ? `No systems match "${this.filterText}".\nEsc clears the filter.`
        : 'No systems configured.\nLeave split view and add one under Admin.';
      this.emptyEl.classList.remove('hidden');
    } else {
      this.emptyEl.classList.add('hidden');
    }
    // Same scroll-follow as the landing menu: the cursor stays visible when
    // even one page outgrows the pane.
    this.listEl.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    this.option.value = this.filterText || (view.length ? String(this.selected + 1) : '');
  }

  private select(i: number): void {
    this.selected = Math.max(0, Math.min(i, this.view().length - 1));
    this.page = Math.floor(this.selected / PanePicker.PAGE_SIZE);
    this.render();
  }

  private turnPage(delta: 1 | -1): void {
    const view = this.view();
    const pages = Math.max(1, Math.ceil(view.length / PanePicker.PAGE_SIZE));
    const next = Math.min(pages - 1, Math.max(0, this.page + delta));
    if (next === this.page) return;
    this.page = next;
    const start = this.page * PanePicker.PAGE_SIZE;
    this.selected =
      delta > 0 ? start : Math.min(start + PanePicker.PAGE_SIZE - 1, view.length - 1);
    this.render();
  }

  private connectSelected(): void {
    const view = this.view();
    const typed = Number.parseInt(this.option.value, 10);
    const idx =
      !this.filterText && Number.isInteger(typed) && typed >= 1 && typed <= view.length
        ? typed - 1
        : this.selected;
    this.connectTo(idx);
  }

  private connectTo(i: number): void {
    const s = this.view()[i];
    if (!s) return;
    if (s.maintenance?.on) {
      this.errEl.textContent = `${s.name} is in maintenance — ${s.maintenance.message}`;
      this.errEl.classList.remove('hidden');
      return;
    }
    this.close();
    this.onPick(s);
  }

  close(): void {
    this.el.remove();
    const i = pickers.indexOf(this);
    if (i >= 0) pickers.splice(i, 1);
  }
}

// ------------------------------------------------------------------ admin
/**
 * The admin token lives in localStorage (not sessionStorage) so a takeover
 * mirror opened from the console - a separate tab - can present it for
 * break-glass control. Server-side it expires after 8 hours.
 */
export const ADMIN_TOKEN_KEY = 'web5250.adminToken';
let adminToken: string | null = localStorage.getItem(ADMIN_TOKEN_KEY);
let editingId: number | null = null; // null = adding a new system

async function adminCall(method: string, name: string, body?: unknown): Promise<Response> {
  const res = await fetch(api(name), {
    method,
    headers: { 'content-type': 'application/json', ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.status === 401 && adminToken) {
    adminToken = null;
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    showPinPane();
  }
  return res;
}

function openAdmin(): void {
  $('admin-modal').classList.remove('hidden');
  if (adminToken) showEditorPane();
  else showPinPane();
}

function closeAdmin(): void {
  $('admin-modal').classList.add('hidden');
  $('admin-form').classList.add('hidden');
  $('admin-list-actions').classList.remove('hidden');
  $('admin-card').classList.remove('wide'); // keymap editor closed with it
  // Keymap edits and host assignments made in here take effect now - the
  // catalog re-fetch is cheap and the menu (still open behind the console)
  // is the natural "admin is done" moment.
  void loadKeymaps();
  hideFormError();
  transferNote(null);
  keymapNote(null);
  stopConsolePoll();
  $('menu-option').focus();
}

function showPinPane(): void {
  $('admin-editor').classList.add('hidden');
  $('admin-pin').classList.remove('hidden');
  $('admin-pin-error').textContent = '';
  $<HTMLInputElement>('admin-pin-input').value = '';
  // Hidden when the server reports ADMIN_PIN is unset.
  $('admin-pin-note').classList.toggle('hidden', meta?.adminEnabled !== false);
  transferNote(null);
  stopConsolePoll();
  window.setTimeout(() => $('admin-pin-input').focus(), 0);
}

function showEditorPane(): void {
  $('admin-pin').classList.add('hidden');
  $('admin-editor').classList.remove('hidden');
  // Directory controls appear only when the integration is configured.
  $('admin-dirsync').classList.toggle('hidden', meta?.directory !== true);
  switchAdminTab('systems');
  void refreshAdminList();
  void refreshKeymaps(); // the system form's Keymap select works from this list
}

function upDownButton(label: string, title: string, disabled: boolean, fn: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.title = title;
  btn.disabled = disabled;
  btn.addEventListener('click', fn);
  return btn;
}

async function refreshAdminList(): Promise<void> {
  try {
    systems = await fetchSystems();
    render(); // keep the menu behind the overlay in sync
    recheckSpool(); // enabling the first printer reveals the Spool button
  } catch {
    /* menu refresh is cosmetic here */
  }
  // The editor works from the authenticated copy: it carries the proxy
  // fields the public list never sees. If that fetch fails, show no rows
  // rather than the public ones - editing a public row would blank its
  // proxy credentials on save (a 401 has already flipped to the PIN pane).
  let rows: AdminSystem[] = [];
  let listError = false;
  try {
    rows = await fetchAdminSystems();
  } catch {
    rows = [];
    listError = true;
  }
  const list = $('admin-list');
  list.innerHTML = '';
  rows.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'admin-row';

    const pos = document.createElement('span');
    pos.className = 'pos';
    pos.textContent = String(i + 1);

    const nm = document.createElement('span');
    nm.className = 'nm';
    const b = document.createElement('b');
    b.textContent = s.name;
    const small = document.createElement('small');
    small.textContent =
      `${s.host}:${s.port}${s.ssl ? ' · TLS' : ''} · ${s.termType} · ${s.codePage}` +
      (s.viaProxy || s.proxyHost ? ' · SOCKS5' : '') +
      (s.printerEnabled || s.printerDeviceName ? ' · printer' : '') +
      (s.devPrefix ? ` · ${s.devPrefix}` : '') +
      (s.signOnUser || s.autoSignOn ? ' · auto sign-on' : '');
    nm.append(b, small);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.title = `Edit ${s.name}`;
    edit.addEventListener('click', () => editSystem(s));

    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Del';
    del.title = `Delete ${s.name}`;
    del.className = 'danger';
    del.addEventListener('click', () => void deleteSystem(s, del));

    li.append(
      pos,
      nm,
      upDownButton('↑', 'Move up', i === 0, () => void moveSystem(s.id, 'up')),
      upDownButton('↓', 'Move down', i === rows.length - 1, () => void moveSystem(s.id, 'down')),
      edit,
      del
    );
    list.appendChild(li);
  });
  $('admin-count').textContent = listError ? 'system list unavailable — reopen Admin' : `${rows.length} system(s)`;
}

async function moveSystem(id: number, dir: 'up' | 'down'): Promise<void> {
  await adminCall('POST', `api/admin/systems/${id}/move`, { dir });
  await refreshAdminList();
}

async function deleteSystem(s: AdminSystem, btn: HTMLButtonElement): Promise<void> {
  // Two-step confirm without a native dialog: the button arms for 3 s.
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = 'Sure?';
    window.setTimeout(() => {
      btn.dataset.armed = '';
      btn.textContent = 'Del';
    }, 3000);
    return;
  }
  btn.disabled = true;
  const res = await adminCall('DELETE', `api/admin/systems/${s.id}`);
  if (!res.ok && res.status !== 401) {
    btn.disabled = false;
    btn.dataset.armed = '';
    btn.textContent = 'Del';
  }
  await refreshAdminList();
}

/** Pull the entry list from the directory service now (admin button). */
async function syncDirectoryNow(): Promise<void> {
  const btn = $<HTMLButtonElement>('admin-dirsync');
  btn.disabled = true;
  try {
    const res = await adminCall('POST', 'api/admin/directory/sync');
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as {
      directory?: {
        lastCounts?: { added: number; updated: number; removed: number; total: number };
      };
    };
    const c = data.directory?.lastCounts;
    transferNote(
      c ? `Directory synced — +${c.added} added, ~${c.updated} updated, -${c.removed} removed (${c.total} entries).` : 'Directory synced.'
    );
    await refreshAdminList();
  } catch {
    transferNote('Directory sync failed — see the gateway log (or the Audit tab).');
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------- console: tabs & sessions
// Systems (the editor above), Sessions (live session table + maintenance
// windows), Recordings and Audit share the admin PIN's bearer token. The
// sessions table polls every 5 s while its tab is visible.

let sessionsTimer: number | undefined;

function stopConsolePoll(): void {
  window.clearInterval(sessionsTimer);
  sessionsTimer = undefined;
}

// ---------------------------------------------------------- settings tab
// Gateway-wide settings. Today: the sign-on protection PIN, the optional
// shared gate in front of automatic sign-on (promptSignOnPin is the user
// side of the same setting).

async function refreshSettings(): Promise<void> {
  const status = $('settings-signonpin-status');
  const input = $<HTMLInputElement>('f-signonpin');
  try {
    const res = await adminCall('GET', 'api/admin/settings');
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { signOnPin?: boolean };
    if (data.signOnPin) {
      // The field is write-only (the gateway keeps a hash, never the PIN),
      // so this line is the state's only display - and the placeholder must
      // not read like "no PIN configured" while one is.
      status.textContent =
        'A protection PIN IS set — users are asked for it once per page before an ' +
        'automatic sign-on. The field never shows it (stored hashed): type a new ' +
        'PIN and Save to change it, or leave it empty and Save (or Clear ' +
        'protection) to turn it off.';
      input.placeholder = '(a PIN is set — type a new one to change it)';
    } else {
      status.textContent =
        'No protection PIN — every system with a sign-on account signs on ' +
        'automatically, without asking anyone.';
      input.placeholder = '(not set)';
    }
  } catch {
    status.textContent = 'settings unavailable — close and reopen the Admin console';
  }
}

async function saveSettingsPin(): Promise<void> {
  const errEl = $('settings-error');
  errEl.textContent = '';
  // House convention (the system editor's sign-on fields): an empty field
  // plus Save clears the setting - the Clear protection button is just a
  // shortcut for the same thing.
  const pin = $<HTMLInputElement>('f-signonpin').value.trim();
  const res = await adminCall('PUT', 'api/admin/settings', pin ? { signOnPin: pin } : { signOnPin: null });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    errEl.textContent = err.error ?? `save failed (${res.status})`;
    return;
  }
  $<HTMLInputElement>('f-signonpin').value = '';
  // The rest of this page may have cached an unarmed /api/meta (loadMeta is
  // per-page-lifetime) - drop it so the gate and the chrome re-read.
  meta = null;
  metaPromise = null;
  await refreshSettings();
}

function switchAdminTab(tab: string): void {
  stopConsolePoll();
  for (const b of $('admin-tabs').querySelectorAll('button')) {
    b.classList.toggle('active', (b as HTMLElement).dataset.tab === tab);
  }
  for (const t of ['systems', 'sessions', 'recordings', 'audit', 'settings', 'keymaps']) {
    $(`admin-tab-${t}`).classList.toggle('hidden', t !== tab);
  }
  if (tab === 'sessions') {
    void refreshSessions();
    void refreshMaint();
    sessionsTimer = window.setInterval(() => void refreshSessions(), 5000);
  } else if (tab === 'recordings') {
    void refreshRecordings();
  } else if (tab === 'audit') {
    void refreshAudit();
  } else if (tab === 'settings') {
    void refreshSettings();
  } else if (tab === 'keymaps') {
    void refreshKeymaps();
  }
}

interface SessionRow {
  id: string;
  system: string | null;
  devName: string | null;
  identity: string | null;
  signedOnUser: string | null;
  state: string;
  startedAt: number;
  lastActivityAt: number;
  viewers: number;
  assist: { holder: string; expiresAt: number } | null;
  recording: boolean;
  ip: string | null;
  graceEndsAt: number | null;
}

const fmtAgo = (ts: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

async function refreshSessions(): Promise<void> {
  let rows: SessionRow[] = [];
  try {
    const res = await adminCall('GET', 'api/admin/sessions');
    if (!res.ok) throw new Error(String(res.status));
    rows = ((await res.json()) as { sessions: SessionRow[] }).sessions ?? [];
  } catch {
    return; // keep the last good table; the next poll retries
  }
  const list = $('sessions-list');
  list.replaceChildren(
    ...rows.map((s) => {
      const li = document.createElement('li');
      li.className = 'admin-row session-row';
      const nm = document.createElement('span');
      nm.className = 'nm';
      const b = document.createElement('b');
      b.textContent = `${s.devName ?? '(device pending)'}${s.signedOnUser ? ` · ${s.signedOnUser}` : ''}`;
      const small = document.createElement('small');
      const who = s.identity ?? s.ip ?? 'unknown origin';
      const state =
        s.state === 'grace'
          ? `detached (grace ${Math.max(0, Math.round(((s.graceEndsAt ?? 0) - Date.now()) / 1000))}s)`
          : s.state;
      small.textContent =
        `${s.system ?? 'no system'} · ${who} · ${state} · started ${fmtAgo(s.startedAt)} · active ${fmtAgo(s.lastActivityAt)}` +
        `${s.viewers > 0 ? ` · ${s.viewers} viewer(s)` : ''}` +
        `${s.assist ? ` · assist: ${s.assist.holder}` : ''}${s.recording ? ' · REC' : ''}`;
      nm.append(b, small);

      const mirror = document.createElement('button');
      mirror.type = 'button';
      mirror.textContent = 'Mirror';
      mirror.title = 'Open a view-only window of this session (control can be requested from there)';
      mirror.addEventListener('click', () => void mirrorSession(s, mirror));

      const signal = document.createElement('button');
      signal.type = 'button';
      signal.textContent = 'Signal';
      signal.title = 'Show a banner on this session';
      signal.addEventListener('click', () => void signalSession(s));

      const end = document.createElement('button');
      end.type = 'button';
      end.textContent = 'End';
      end.className = 'danger';
      end.title = 'End the host session now (releases the device and the user message queue)';
      end.addEventListener('click', () => void endSession(s, end));

      li.append(nm, mirror, signal, end);
      return li;
    })
  );
  const empty = $('sessions-empty');
  if (rows.length === 0) {
    empty.textContent = 'No live sessions.';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
  }
}

/** Open a view-only mirror of a console session in a new tab. */
async function mirrorSession(s: SessionRow, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const res = await adminCall('POST', `api/admin/sessions/${s.id}/view`);
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { shareToken: string };
    const u = new URL(window.location.href);
    for (const key of [...u.searchParams.keys()]) u.searchParams.delete(key);
    u.searchParams.set('view', data.shareToken);
    window.open(u.href, '_blank', 'noopener');
  } catch {
    window.alert('Could not open the mirror (the session may have ended).');
  } finally {
    btn.disabled = false;
  }
}

async function signalSession(s: SessionRow): Promise<void> {
  const message = window.prompt(`Banner text for ${s.devName ?? 'this session'}:`, '');
  if (!message) return;
  await adminCall('POST', `api/admin/sessions/${s.id}/signal`, { message, level: 'warn' });
}

async function endSession(s: SessionRow, btn: HTMLButtonElement): Promise<void> {
  // Two-step confirm (same pattern as Del): the first click arms for 3 s.
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = 'Sure?';
    window.setTimeout(() => {
      btn.dataset.armed = '';
      btn.textContent = 'End';
    }, 3000);
    return;
  }
  btn.disabled = true;
  await adminCall('POST', `api/admin/sessions/${s.id}/end`, { notice: 'Ended by the administrator.' });
  await refreshSessions();
}

// ------------------------------------------------------ maintenance windows
interface MaintView {
  on: boolean;
  message: string;
  deadlineAt: number | null;
}

async function refreshMaint(): Promise<void> {
  let views: { global: MaintView | null; systems: Record<string, MaintView> };
  let rows: AdminSystem[];
  try {
    const [mRes, sRes] = await Promise.all([
      adminCall('GET', 'api/admin/maintenance'),
      adminCall('GET', 'api/admin/systems')
    ]);
    if (!mRes.ok || !sRes.ok) throw new Error('unavailable');
    views = (await mRes.json()) as typeof views;
    rows = ((await sRes.json()) as { systems: AdminSystem[] }).systems ?? [];
  } catch {
    $('maint-list').replaceChildren();
    return;
  }
  const list = $('maint-list');
  const row = (name: string, view: MaintView | null, systemId: number | null): HTMLElement => {
    const li = document.createElement('li');
    li.className = 'admin-row maint-row';
    const nm = document.createElement('span');
    nm.className = 'nm';
    const b = document.createElement('b');
    b.textContent = name;
    const small = document.createElement('small');
    small.textContent = view?.on
      ? `ON — ${view.message}${view.deadlineAt ? ` · sessions end ${new Date(view.deadlineAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ' · no deadline'}`
      : 'off — new sessions allowed';
    nm.append(b, small);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = view?.on ? 'Stop' : 'Start';
    btn.addEventListener('click', () => void setMaint(systemId, !view?.on));
    li.append(nm, btn);
    return li;
  };
  list.replaceChildren(
    row('All systems (gateway-wide)', views.global, null),
    ...rows.map((s) => row(s.name, views.systems[String(s.id)] ?? null, s.id))
  );
}

async function setMaint(systemId: number | null, on: boolean): Promise<void> {
  let message = 'Host maintenance';
  let deadlineMs: number | null = null;
  if (on) {
    const typed = window.prompt('Message shown to users:', message);
    if (typed === null) return;
    message = typed.trim() || message;
    const minsRaw = window.prompt('End existing sessions in how many minutes? (empty = block new sessions only)', '');
    if (minsRaw !== null && minsRaw.trim() !== '') {
      const mins = Number.parseFloat(minsRaw);
      if (Number.isFinite(mins) && mins > 0) deadlineMs = Date.now() + mins * 60 * 1000;
    }
  }
  const path = systemId === null ? 'api/admin/maintenance' : `api/admin/systems/${systemId}/maintenance`;
  await adminCall('POST', path, { on, message, deadlineMs });
  await refreshMaint();
}

// ------------------------------------------------------------- recordings
interface RecMeta {
  id: string;
  systemName: string;
  devName: string | null;
  identity: string | null;
  signedOnUser: string | null;
  startedAt: number;
  endedAt: number | null;
  bytes: number;
  frames: number;
}

const fmtSize = (bytes: number): string =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const fmtDur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 3600
    ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    : `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};

async function refreshRecordings(): Promise<void> {
  let rows: RecMeta[] = [];
  try {
    const res = await adminCall('GET', 'api/admin/recordings');
    if (!res.ok) throw new Error(String(res.status));
    rows = ((await res.json()) as { recordings: RecMeta[] }).recordings ?? [];
  } catch {
    return;
  }
  $('recordings-list').replaceChildren(
    ...rows.map((r) => {
      const li = document.createElement('li');
      li.className = 'admin-row';
      const nm = document.createElement('span');
      nm.className = 'nm';
      const b = document.createElement('b');
      b.textContent = `${r.systemName} · ${r.devName ?? 'device'}`;
      const small = document.createElement('small');
      small.textContent =
        `${new Date(r.startedAt).toLocaleString([], { hour12: false })} · ` +
        `${r.endedAt ? fmtDur(r.endedAt - r.startedAt) : 'live'} · ${fmtSize(r.bytes)} · ${r.frames} frames` +
        `${r.identity ? ` · ${r.identity}` : ''}${r.signedOnUser ? ` · as ${r.signedOnUser}` : ''}`;
      nm.append(b, small);

      const play = document.createElement('button');
      play.type = 'button';
      play.textContent = 'Play';
      play.disabled = !r.endedAt;
      play.title = r.endedAt ? 'Open the replay player' : 'Still recording';
      play.addEventListener('click', () => void playRecording(r.id, play));

      const dl = document.createElement('button');
      dl.type = 'button';
      dl.textContent = 'Download';
      dl.addEventListener('click', () => void downloadRecording(r.id));

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'danger';
      rm.textContent = 'Remove';
      rm.title = 'Delete this recording and its file';
      rm.addEventListener('click', () => void removeRecording(r, rm));
      li.append(nm, play, dl, rm);
      return li;
    })
  );
}

async function playRecording(id: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const res = await adminCall('POST', `api/admin/recordings/${id}/link`);
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { token: string };
    const u = new URL(window.location.href);
    for (const key of [...u.searchParams.keys()]) u.searchParams.delete(key);
    u.searchParams.set('replay', data.token);
    window.open(u.href, '_blank', 'noopener');
  } catch {
    window.alert('Could not open the replay.');
  } finally {
    btn.disabled = false;
  }
}

async function downloadRecording(id: string): Promise<void> {
  const res = await adminCall('GET', `api/admin/recordings/${id}/download`);
  if (!res.ok) {
    window.alert('Could not download the recording (retention may have removed it).');
    return;
  }
  const blob = new Blob([await res.text()], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `recording-${id.slice(0, 8)}.jsonl`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Console removal of one recording (a live one is stopped first). */
async function removeRecording(r: RecMeta, btn: HTMLButtonElement): Promise<void> {
  const live = r.endedAt === null;
  if (
    !window.confirm(
      live
        ? 'Stop this recording and delete everything captured so far?'
        : 'Delete this recording? Its file and any replay links are removed.'
    )
  )
    return;
  btn.disabled = true;
  try {
    const res = await adminCall('DELETE', `api/admin/recordings/${r.id}`);
    if (!res.ok && res.status !== 404) throw new Error(String(res.status));
  } catch {
    btn.disabled = false;
    window.alert('The recording could not be removed.');
    return;
  }
  void refreshRecordings();
}

// ------------------------------------------------------------------ audit
interface AuditRow {
  ts: number;
  actor: string;
  action: string;
  target: string;
  detail: string;
}

const AUDIT_PAGE_SIZE = 100;
let auditPage = 0; // 0-based; clamped to the fetched total on every render

async function refreshAudit(): Promise<void> {
  let rows: AuditRow[] = [];
  let total = 0;
  try {
    const res = await adminCall(
      'GET',
      `api/admin/audit?limit=${AUDIT_PAGE_SIZE}&offset=${auditPage * AUDIT_PAGE_SIZE}`
    );
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { entries?: AuditRow[]; total?: number };
    rows = body.entries ?? [];
    total = body.total ?? rows.length;
  } catch {
    return;
  }
  // Rows can be pruned between fetches; land on the last page that exists.
  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
  if (auditPage > pages - 1) {
    auditPage = pages - 1;
    void refreshAudit();
    return;
  }
  $('audit-list').replaceChildren(
    ...rows.map((r) => {
      const li = document.createElement('li');
      li.className = 'audit-row';
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = new Date(r.ts).toLocaleString([], { hour12: false });
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = r.actor;
      const act = document.createElement('span');
      act.className = 'act';
      act.textContent = r.action;
      const tgt = document.createElement('span');
      tgt.className = 'tgt';
      tgt.textContent = [r.target, r.detail].filter(Boolean).join(' — ');
      li.append(ts, who, act, tgt);
      return li;
    })
  );
  const pager = $('audit-pager');
  pager.classList.toggle('hidden', total <= AUDIT_PAGE_SIZE);
  if (total > AUDIT_PAGE_SIZE) {
    ($('audit-page-label') as HTMLElement).textContent =
      `Page ${auditPage + 1} of ${pages} · ${total} entries`;
    ($('audit-prev') as HTMLButtonElement).disabled = auditPage === 0;
    ($('audit-next') as HTMLButtonElement).disabled = auditPage >= pages - 1;
  }
}

// -------------------------------------------------- export / import config
function transferNote(msg: string | null): void {
  const el = $('admin-transfer-note');
  el.textContent = msg ?? '';
  el.classList.toggle('hidden', !msg);
}

/** Download the whole system list as a JSON file (admin export). */
async function exportConfig(): Promise<void> {
  const res = await adminCall('GET', 'api/admin/config');
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    transferNote(`Export failed — ${err.error ?? res.status}`);
    return;
  }
  const blob = new Blob([await res.text()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // Same-origin responses carry the header; anything between may strip it.
  a.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1]
    ?? 'web5250-config.json';
  a.click();
  URL.revokeObjectURL(url);
  transferNote('Configuration exported (systems, keymaps, default keymap) — check your downloads.');
}

/** Arm-then-open the file picker: import replaces the whole list. */
function pickImportFile(): void {
  const btn = $<HTMLButtonElement>('admin-import');
  // Two-step confirm without a native dialog (same pattern as Del): the
  // first click arms for 3 s, the second opens the file picker.
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = 'Replace?';
    window.setTimeout(() => {
      btn.dataset.armed = '';
      btn.textContent = 'Import';
    }, 3000);
    return;
  }
  btn.dataset.armed = '';
  btn.textContent = 'Import';
  $<HTMLInputElement>('admin-import-file').click();
}

/** Upload an export file: the server replaces the whole system list. */
async function importConfigFile(file: File): Promise<void> {
  let doc: unknown;
  try {
    doc = JSON.parse(await file.text());
  } catch {
    transferNote('Import failed — that file is not valid JSON.');
    return;
  }
  const res = await adminCall('PUT', 'api/admin/config', doc);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    transferNote(`Import failed — ${err.error ?? res.status}`);
    return;
  }
  const data = (await res.json()) as { count?: number };
  transferNote(`Imported ${data.count ?? 0} system(s) — the previous list was replaced.`);
  await refreshAdminList();
}

function fillForm(s: AdminSystem | null): void {
  const d = meta?.defaults;
  const termSel = $<HTMLSelectElement>('f-term');
  const cpSel = $<HTMLSelectElement>('f-cp');
  if (termSel.options.length === 0) {
    for (const t of meta?.termTypes ?? []) termSel.add(new Option(t, t));
    for (const c of meta?.codePages ?? []) cpSel.add(new Option(c, c));
  }
  $<HTMLInputElement>('f-name').value = s?.name ?? '';
  $<HTMLInputElement>('f-desc').value = s?.description ?? '';
  $<HTMLInputElement>('f-host').value = s?.host ?? '';
  $<HTMLInputElement>('f-port').value = String(s?.port ?? d?.port ?? 23);
  $<HTMLInputElement>('f-ssl').checked = s ? s.ssl : (d?.ssl ?? false);
  $<HTMLInputElement>('f-prefix').value = s?.devPrefix ?? d?.devPrefix ?? '';
  termSel.value = s?.termType ?? d?.termType ?? 'IBM-3477-FC';
  cpSel.value = s?.codePage ?? d?.codePage ?? 'cp037';
  // Proxy fields exist only on the admin (authenticated) copy of the row;
  // the masked password round-trips through the form like any field.
  $<HTMLInputElement>('f-proxyhost').value = s?.proxyHost ?? '';
  $<HTMLInputElement>('f-proxyport').value = s?.proxyPort != null ? String(s.proxyPort) : '';
  $<HTMLInputElement>('f-proxyuser').value = s?.proxyUser ?? '';
  $<HTMLInputElement>('f-proxypass').value = s?.proxyPass ?? '';
  // Printer session fields (same authenticated-copy rule). A new system
  // defaults the device name to the gateway's default (WEB5250P).
  $<HTMLInputElement>('f-printer').checked = s ? Boolean(s.printerEnabled) : false;
  $<HTMLInputElement>('f-printerdev').value = s?.printerDeviceName ?? 'WEB5250P';
  $<HTMLSelectElement>('f-printermode').value = s?.printerMode ?? 'text';
  $<HTMLInputElement>('f-recording').checked = s ? Boolean(s.recording) : false;
  // Stored sign-on account (same authenticated-copy rule as the proxy
  // fields): the masked password round-trips through the form like any field.
  $<HTMLInputElement>('f-signuser').value = s?.signOnUser ?? '';
  $<HTMLInputElement>('f-signpass').value = s?.signOnPassword ?? '';
  // Custom keymap overlay (options come from the last keymap-list fetch; a
  // missing list leaves "gateway default", the pre-feature behavior).
  keymapOptions(s?.keymapId ?? null);
}

function editSystem(s: AdminSystem): void {
  editingId = s.id;
  fillForm(s);
  $('admin-form').classList.remove('hidden');
  $('admin-list-actions').classList.add('hidden');
  hideFormError();
  $<HTMLInputElement>('f-name').focus();
}

function formPayload(): Record<string, unknown> {
  return {
    name: $<HTMLInputElement>('f-name').value,
    description: $<HTMLInputElement>('f-desc').value,
    host: $<HTMLInputElement>('f-host').value,
    port: $<HTMLInputElement>('f-port').value,
    ssl: $<HTMLInputElement>('f-ssl').checked,
    termType: $<HTMLSelectElement>('f-term').value,
    codePage: $<HTMLSelectElement>('f-cp').value,
    devPrefix: $<HTMLInputElement>('f-prefix').value,
    proxyHost: $<HTMLInputElement>('f-proxyhost').value,
    proxyPort: $<HTMLInputElement>('f-proxyport').value,
    proxyUser: $<HTMLInputElement>('f-proxyuser').value,
    proxyPass: $<HTMLInputElement>('f-proxypass').value,
    printerEnabled: $<HTMLInputElement>('f-printer').checked,
    printerDeviceName: $<HTMLInputElement>('f-printerdev').value,
    printerMode: $<HTMLSelectElement>('f-printermode').value,
    recording: $<HTMLInputElement>('f-recording').checked,
    signOnUser: $<HTMLInputElement>('f-signuser').value,
    signOnPassword: $<HTMLInputElement>('f-signpass').value,
    keymapId: $<HTMLSelectElement>('f-keymap').value
  };
}

function hideFormError(): void {
  $('admin-form-error').textContent = '';
}

async function saveForm(e: Event): Promise<void> {
  e.preventDefault();
  const res = await adminCall(
    editingId === null ? 'POST' : 'PUT',
    editingId === null ? 'api/admin/systems' : `api/admin/systems/${editingId}`,
    formPayload()
  );
  if (res.ok) {
    $('admin-form').classList.add('hidden');
    $('admin-list-actions').classList.remove('hidden');
    await refreshAdminList();
  } else {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    $('admin-form-error').textContent = err.error ?? `save failed (${res.status})`;
  }
}

// -------------------------------------------------------------- keymaps tab
// Admin-managed keyboard maps. The list handles upload (.kmp files from
// IBM i Access / PCOMM), download, default and delete; the editor is a
// visual keyboard - click a keycap (or pick a key), set what its four
// modifier states send. Bindings overlay the built-in browser mapping:
// "(default)" falls through to it, "(browser)" hands the key back.
interface AdminKeymap {
  id: number;
  name: string;
  description: string;
  bindings: KeyBinding[];
  usedBy?: string[];
}

let keymapRows: AdminKeymap[] = [];
let defaultKeymapId: number | null = null;
let editingKeymapId: number | null = null;
/** Working copy of the edited keymap's bindings (saved on submit). */
let editBindings: KeyBinding[] = [];
/** Physical key currently selected in the editor (grid cap or Key picker). */
let gridSel: string | null = null;

const STATES: { label: string; shift: boolean; ctrl: boolean; alt: boolean }[] = [
  { label: 'Plain', shift: false, ctrl: false, alt: false },
  { label: 'Shift', shift: true, ctrl: false, alt: false },
  { label: 'Ctrl', shift: false, ctrl: true, alt: false },
  { label: 'Alt', shift: false, ctrl: false, alt: true }
];

/** Action menu groups (values are the gateway's logical key names). */
const ACTION_GROUPS: { label: string; actions: string[] }[] = [
  { label: 'AID keys', actions: ['enter', 'clear', 'rollup', 'rolldown', 'help'] },
  {
    label: 'Function keys',
    actions: Array.from({ length: 24 }, (_, i) => `pf${i + 1}`)
  },
  {
    label: 'Field editing',
    actions: [
      'tab', 'btab', 'fieldexit', 'fieldplus', 'fieldminus', 'backspace',
      'bsdelete', 'delete', 'insert', 'up', 'down', 'left', 'right', 'home', 'end'
    ]
  },
  { label: 'Keys while locked', actions: ['reset', 'sysreq', 'attn', 'print'] }
];

interface KeycapDef {
  code: string;
  label: string;
  /** Flex grow - wider caps (Backspace, Space) keep the rows readable. */
  w?: number;
}

const cap = (code: string, label: string, w?: number): KeycapDef => ({ code, label, w });

/** The editor's keyboard: physical codes that cover the built-in mapping. */
const KEYGRID_ROWS: KeycapDef[][] = [
  [
    cap('Escape', 'Esc'),
    ...Array.from({ length: 12 }, (_, i) => cap(`F${i + 1}`, `F${i + 1}`))
  ],
  [
    cap('Backquote', '` ~'), cap('Digit1', '1'), cap('Digit2', '2'), cap('Digit3', '3'),
    cap('Digit4', '4'), cap('Digit5', '5'), cap('Digit6', '6'), cap('Digit7', '7'),
    cap('Digit8', '8'), cap('Digit9', '9'), cap('Digit0', '0'),
    cap('Minus', '- _'), cap('Equal', '= +'), cap('Backspace', 'Backsp', 2)
  ],
  [
    cap('Tab', 'Tab', 1.5), cap('KeyQ', 'Q'), cap('KeyW', 'W'), cap('KeyE', 'E'),
    cap('KeyR', 'R'), cap('KeyT', 'T'), cap('KeyY', 'Y'), cap('KeyU', 'U'),
    cap('KeyI', 'I'), cap('KeyO', 'O'), cap('KeyP', 'P'),
    cap('BracketLeft', '[ {'), cap('BracketRight', '] }'), cap('Backslash', '\\ |', 1.5)
  ],
  [
    cap('KeyA', 'A'), cap('KeyS', 'S'), cap('KeyD', 'D'), cap('KeyF', 'F'),
    cap('KeyG', 'G'), cap('KeyH', 'H'), cap('KeyJ', 'J'), cap('KeyK', 'K'),
    cap('KeyL', 'L'), cap('Semicolon', '; :'), cap('Quote', "' \""), cap('Enter', 'Enter', 2)
  ],
  [
    cap('KeyZ', 'Z'), cap('KeyX', 'X'), cap('KeyC', 'C'), cap('KeyV', 'V'),
    cap('KeyB', 'B'), cap('KeyN', 'N'), cap('KeyM', 'M'),
    cap('Comma', ', <'), cap('Period', '. >'), cap('Slash', '/ ?')
  ],
  [
    cap('Space', 'Space', 5),
    cap('PageUp', 'PgUp'), cap('PageDown', 'PgDn'),
    cap('Home', 'Home'), cap('End', 'End'),
    cap('Insert', 'Ins'), cap('Delete', 'Del'),
    cap('ArrowUp', '↑'), cap('ArrowLeft', '←'), cap('ArrowDown', '↓'), cap('ArrowRight', '→')
  ],
  [
    cap('NumpadEnter', 'NumEnt'), cap('NumpadAdd', 'Num +'), cap('NumpadSubtract', 'Num −'),
    cap('NumpadMultiply', 'Num *'), cap('NumpadDivide', 'Num /'), cap('NumpadDecimal', 'Num .')
  ]
];

const GRID_CODES = new Set(KEYGRID_ROWS.flat().map((c) => c.code));

/** Codes without a keycap (off-grid function keys, numpad digits) - the Key
 *  picker offers them so imported bindings stay editable. */
const PICK_GROUPS: { label: string; codes: string[] }[] = [
  { label: 'Function keys', codes: Array.from({ length: 24 }, (_, i) => `F${i + 1}`) },
  { label: 'Letters', codes: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`) },
  { label: 'Number row', codes: '1234567890'.split('').map((d) => `Digit${d}`) },
  {
    label: 'Navigation',
    codes: [
      'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Escape', 'Space',
      'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'
    ]
  },
  {
    label: 'Numeric keypad',
    codes: [
      ...'0123456789'.split('').map((d) => `Numpad${d}`),
      'NumpadEnter', 'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal'
    ]
  },
  {
    label: 'Punctuation',
    codes: ['Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash']
  }
];

/** Human name for a physical code ("KeyQ" -> "Q", "Numpad7" -> "Num 7"). */
function codeLabel(code: string): string {
  const grid = KEYGRID_ROWS.flat().find((c) => c.code === code);
  if (grid) return grid.label;
  const m = /^(Key|Digit|Numpad)([A-Za-z0-9])$/.exec(code);
  if (m) return m[1] === 'Numpad' ? `Num ${m[2]}` : m[2];
  return code;
}

/** Modifier prefix for labels and tooltips ("Ctrl+Shift+F9"). */
const modLabel = (shift: boolean, ctrl: boolean, alt: boolean): string =>
  `${ctrl ? 'Ctrl+' : ''}${alt ? 'Alt+' : ''}${shift ? 'Shift+' : ''}`;

const actionLabel = (b: KeyBinding): string =>
  b.action === 'char'
    ? `type '${b.ch === ' ' ? 'space' : b.ch}'`
    : b.action === 'browser'
      ? '(browser)'
      : keyLabel(b.action);

/** The keycap's second legend line: the same actions, compressed to fit a
 *  cap (the tooltip keeps the full wording). */
const COMPACT_LABELS: Record<string, string> = {
  fieldexit: 'FldExit',
  fieldplus: 'Fld +',
  fieldminus: 'Fld −',
  backspace: 'Bksp',
  bsdelete: 'Dest Bksp',
  rollup: 'RollUp',
  rolldown: 'RollDn',
  sysreq: 'SysRq'
};
const compactAction = (b: KeyBinding): string =>
  b.action === 'char'
    ? `'${b.ch === ' ' ? 'spc' : b.ch}'`
    : b.action === 'browser'
      ? 'browser'
      : COMPACT_LABELS[b.action] ?? keyLabel(b.action);

/** The built-in mapping's behavior for a key state, for the editor's hints
 *  (mapEvent reads only these fields, so a synthetic event is safe). */
const SYNTH_KEY: Record<string, string> = {
  Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Escape: 'Escape', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Space: ' ', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  NumpadEnter: 'Enter', NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*',
  NumpadDivide: '/', NumpadDecimal: '.'
};
const synthKeyFor = (code: string): string => {
  if (SYNTH_KEY[code] !== undefined) return SYNTH_KEY[code];
  const m = /^(?:Key|Digit|Numpad)([A-Za-z0-9])$/.exec(code);
  if (m) return m[1].toLowerCase();
  return code; // unknown: nothing in the built-in map matches it
};
function builtInLabel(code: string, st: { shift: boolean; ctrl: boolean; alt: boolean }): string {
  const mapped = mapEvent({
    code,
    key: synthKeyFor(code),
    shiftKey: st.shift,
    ctrlKey: st.ctrl,
    altKey: st.alt,
    metaKey: false
  } as unknown as KeyboardEvent);
  if (!mapped) return 'browser';
  if (mapped.k === 'char') return mapped.ch === ' ' ? 'space' : `'${mapped.ch}'`;
  return keyLabel(mapped.k);
}

const findBinding = (
  code: string,
  st: { shift: boolean; ctrl: boolean; alt: boolean }
): KeyBinding | undefined =>
  editBindings.find(
    (b) => b.code === code && b.shift === st.shift && b.ctrl === st.ctrl && b.alt === st.alt
  );

/** Set (or, with null action, remove) one key state in the working copy. */
function setBinding(
  code: string,
  st: { shift: boolean; ctrl: boolean; alt: boolean },
  action: string | null,
  ch?: string
): void {
  editBindings = editBindings.filter(
    (b) => !(b.code === code && b.shift === st.shift && b.ctrl === st.ctrl && b.alt === st.alt)
  );
  if (action === 'char' && ch !== undefined && [...ch].length === 1) {
    editBindings.push({ code, shift: st.shift, ctrl: st.ctrl, alt: st.alt, action, ch });
  } else if (action && action !== 'char') {
    editBindings.push({ code, shift: st.shift, ctrl: st.ctrl, alt: st.alt, action });
  }
  renderKeyGrid();
  renderKeyStates();
  renderKeyExtra();
  updateKmCount();
}

function keymapNote(msg: string | null): void {
  const el = $('keymap-note');
  el.textContent = msg ?? '';
  el.classList.toggle('hidden', !msg);
}

async function refreshKeymaps(): Promise<void> {
  try {
    const res = await adminCall('GET', 'api/admin/keymaps');
    if (!res.ok) return;
    const data = (await res.json()) as { keymaps?: AdminKeymap[]; defaultKeymapId?: number | null };
    keymapRows = data.keymaps ?? [];
    defaultKeymapId = data.defaultKeymapId ?? null;
  } catch {
    return; // keep the last good list; the next tab open retries
  }
  renderKeymapList();
}

function renderKeymapList(): void {
  const list = $('keymap-list');
  const editorOpen = !$('keymap-editor').classList.contains('hidden');
  list.replaceChildren(
    ...keymapRows.map((km) => {
      const li = document.createElement('li');
      li.className = 'admin-row keymap-row';

      const nm = document.createElement('span');
      nm.className = 'nm';
      const b = document.createElement('b');
      b.textContent = km.name;
      const small = document.createElement('small');
      const used = km.usedBy ?? [];
      small.textContent =
        `${km.bindings.length} binding(s)` +
        (used.length > 0 ? ` · on ${used.join(', ')}` : ' · not assigned') +
        (km.description ? ` · ${km.description}` : '');
      nm.append(b, small);
      if (km.id === defaultKeymapId) {
        const chip = document.createElement('span');
        chip.className = 'km-badge';
        chip.textContent = 'DEFAULT';
        chip.title = 'Applied to every host that has no keymap of its own';
        b.append(chip); // on the name line, like a real keycap legend
      }

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = 'Edit';
      edit.title = `Edit ${km.name}`;
      edit.addEventListener('click', () => editKeymap(km));

      const dl = document.createElement('button');
      dl.type = 'button';
      dl.textContent = '.kmp';
      dl.title = 'Download as a .kmp keyboard file (opens in IBM i Access / PCOMM)';
      dl.addEventListener('click', () => void downloadKeymap(km));

      const def = document.createElement('button');
      def.type = 'button';
      if (km.id === defaultKeymapId) {
        def.textContent = 'Unset default';
        def.title = 'Stop applying this keymap to hosts without their own';
        def.addEventListener('click', () => void setKeymapDefault(null));
      } else {
        def.textContent = 'Default';
        def.title = 'Apply this keymap to every host that has no keymap of its own';
        def.addEventListener('click', () => void setKeymapDefault(km.id));
      }

      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'Del';
      del.title = `Delete ${km.name}`;
      del.className = 'danger';
      del.addEventListener('click', () => void deleteKeymap(km, del));

      li.append(nm, edit, dl, def, del);
      return li;
    })
  );
  const empty = $('keymap-empty');
  if (keymapRows.length === 0 && !editorOpen) {
    empty.textContent =
      'No keymaps yet. Upload the .kmp file IBM i Access exports (Keyboard Remap), or build one by hand.';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
  }
}

async function setKeymapDefault(id: number | null): Promise<void> {
  const res = await adminCall('PUT', 'api/admin/keymaps/default', { id });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    keymapNote(`Could not set the default — ${err.error ?? res.status}`);
    return;
  }
  await refreshKeymaps();
  keymapNote(id === null ? 'Default keymap cleared — hosts without their own use the built-in map.' : 'Default keymap set.');
}

async function deleteKeymap(km: AdminKeymap, btn: HTMLButtonElement): Promise<void> {
  // Two-step confirm without a native dialog (the Del pattern above).
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = 'Sure?';
    window.setTimeout(() => {
      btn.dataset.armed = '';
      btn.textContent = 'Del';
    }, 3000);
    return;
  }
  const res = await adminCall('DELETE', `api/admin/keymaps/${km.id}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    keymapNote(`Could not delete — ${err.error ?? res.status}`);
    return;
  }
  keymapNote(`Deleted ${km.name} — its hosts fall back to the default keymap.`);
  await refreshKeymaps();
}

async function downloadKeymap(km: AdminKeymap): Promise<void> {
  const res = await adminCall('GET', `api/admin/keymaps/${km.id}/download`);
  if (!res.ok) {
    keymapNote(`Download failed (${res.status}).`);
    return;
  }
  const blob = new Blob([await res.text()], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
    `${km.name.replace(/[^A-Za-z0-9_-]+/g, '-').toLowerCase() || 'keymap'}.kmp`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Arm-free upload (it only adds a keymap, never replaces anything). */
function pickKeymapFile(): void {
  $<HTMLInputElement>('keymap-file').click();
}

async function importKeymapFile(file: File): Promise<void> {
  const fallback = file.name.replace(/\.kmp$/i, '').trim().slice(0, 40) || 'Imported';
  const res = await adminCall('POST', 'api/admin/keymaps/import', {
    name: fallback,
    kmp: await file.text()
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    keymapNote(`Upload failed — ${err.error ?? res.status}`);
    return;
  }
  const data = (await res.json()) as { keymap: AdminKeymap; skipped?: string[] };
  await refreshKeymaps();
  const skipped = data.skipped ?? [];
  const detail =
    skipped.length === 0
      ? ''
      : ` — ${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} not translatable (${skipped
          .slice(0, 3)
          .map((s) => s.split('(')[0].trim())
          .join('; ')}${skipped.length > 3 ? '…' : ''})`;
  keymapNote(`Imported ${data.keymap.name} (${data.keymap.bindings.length} bindings)${detail}.`);
  editKeymap(data.keymap); // straight into the editor for a look
}

function editKeymap(km: AdminKeymap | null): void {
  editingKeymapId = km?.id ?? null;
  editBindings = structuredClone(km?.bindings ?? []);
  gridSel = null;
  $<HTMLInputElement>('km-name').value = km?.name ?? '';
  $<HTMLInputElement>('km-desc').value = km?.description ?? '';
  $('km-error').textContent = '';
  $('keymap-editor').classList.remove('hidden');
  $('keymap-list-actions').classList.add('hidden');
  $('keymap-list').classList.add('hidden');
  $('keymap-empty').classList.add('hidden');
  $('admin-card').classList.add('wide'); // the keyboard wants the room
  renderKeyGrid();
  renderKeyStates();
  renderKeyExtra();
  updateKmCount();
}

function closeKeymapEditor(): void {
  $('keymap-editor').classList.add('hidden');
  $('keymap-list-actions').classList.remove('hidden');
  $('keymap-list').classList.remove('hidden');
  $('admin-card').classList.remove('wide');
  renderKeymapList(); // restores the list/empty state honestly
}

function updateKmCount(): void {
  $('km-count').textContent = `${editBindings.length} binding(s)`;
}

/** The visual keyboard: a cap per key, glowing when customized, its current
 *  action as a second legend line (real keycaps work that way). */
function renderKeyGrid(): void {
  const grid = $('keymap-grid');
  grid.replaceChildren(
    ...KEYGRID_ROWS.map((row) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'keyrow';
      for (const c of row) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'keycap';
        b.style.flexGrow = String(c.w ?? 1);
        b.dataset.code = c.code;
        const mine = editBindings.filter((x) => x.code === c.code);
        b.classList.toggle('bound', mine.length > 0);
        b.classList.toggle('sel', gridSel === c.code);
        const main = document.createElement('span');
        main.className = 'cap-label';
        main.textContent = c.label;
        const sub = document.createElement('span');
        sub.className = 'cap-sub';
        if (mine.length > 0) {
          sub.textContent =
            mine.length === 1 ? compactAction(mine[0]) : `${compactAction(mine[0])} +${mine.length - 1}`;
        }
        b.title =
          mine.length === 0
            ? `${c.code} — not customized (click to bind)`
            : mine
                .map((x) => `${modLabel(x.shift, x.ctrl, x.alt)}${codeLabel(x.code)} → ${actionLabel(x)}`)
                .join('\n');
        b.append(main, sub);
        b.addEventListener('click', () => {
          gridSel = c.code;
          $<HTMLSelectElement>('km-add-code').value = c.code;
          renderKeyGrid();
          renderKeyStates();
        });
        rowEl.appendChild(b);
      }
      return rowEl;
    })
  );
}

/** Side panel: the four modifier states of the selected key. */
function renderKeyStates(): void {
  const title = $('km-key-title');
  const wrap = $('km-states');
  const picker = $<HTMLSelectElement>('km-add-code');
  const code = gridSel;
  if (!code) {
    title.textContent = 'SELECT A KEY';
    wrap.replaceChildren();
    picker.value = '';
    return;
  }
  title.textContent = `KEY: ${codeLabel(code).toUpperCase()}`;
  wrap.replaceChildren(
    ...STATES.map((st) => {
      const row = document.createElement('div');
      row.className = 'km-state';

      const name = document.createElement('span');
      name.className = 'km-state-name';
      name.textContent = st.label;

      const sel = document.createElement('select');
      sel.className = 'km-state-action';
      const current = findBinding(code, st);
      // Short labels: the built-in hint line right under the select says what
      // "default" does, so the option text can stay narrow enough to read.
      sel.add(new Option('— default —', ''));
      sel.add(new Option('(browser)', 'browser'));
      sel.add(new Option('character…', 'char'));
      for (const g of ACTION_GROUPS) {
        const og = document.createElement('optgroup');
        og.label = g.label;
        for (const a of g.actions) og.append(new Option(keyLabel(a), a));
        sel.append(og);
      }
      sel.value = current ? current.action : '';

      const chInput = document.createElement('input');
      chInput.className = 'km-char';
      chInput.type = 'text';
      chInput.maxLength = 2;
      chInput.value = current?.action === 'char' ? (current.ch ?? '') : '';
      chInput.placeholder = 'ch';
      chInput.title = 'The character this key types';
      const showChar = (): void => {
        chInput.classList.toggle('hidden', sel.value !== 'char');
      };
      showChar();
      chInput.addEventListener('input', () => {
        setBinding(code, st, 'char', chInput.value);
      });
      sel.addEventListener('change', () => {
        if (sel.value === 'char') {
          // Wait for the character before rebuilding the panel: the binding
          // lands on the input event, so the field must stay usable now.
          editBindings = editBindings.filter(
            (b) => !(b.code === code && b.shift === st.shift && b.ctrl === st.ctrl && b.alt === st.alt)
          );
          chInput.classList.remove('hidden');
          chInput.value = '';
          chInput.focus();
          renderKeyGrid();
          renderKeyExtra();
          updateKmCount();
          return;
        }
        setBinding(code, st, sel.value, chInput.value);
      });

      const hint = document.createElement('small');
      hint.className = 'km-builtin';
      hint.textContent = `built-in: ${builtInLabel(code, st)}`;

      row.append(name, sel, chInput, hint);
      return row;
    })
  );
}

/** Bindings on keys the grid has no cap for (numpad digits, F13+...). */
function renderKeyExtra(): void {
  const wrap = $('keymap-extra');
  const section = $('keymap-extra-wrap');
  const extras = editBindings.filter((b) => !GRID_CODES.has(b.code));
  section.classList.toggle('hidden', extras.length === 0);
  wrap.replaceChildren(
    ...extras.map((b) => {
      const li = document.createElement('li');
      li.className = 'km-extra-row';
      const label = document.createElement('span');
      label.textContent = `${modLabel(b.shift, b.ctrl, b.alt)}${codeLabel(b.code)} → ${actionLabel(b)}`;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '✕';
      rm.title = 'Remove this binding';
      rm.addEventListener('click', () => setBinding(b.code, b, null));
      li.append(label, rm);
      return li;
    })
  );
}

/** Fill the Key picker once (grouped physical codes). */
function buildKeyPicker(): void {
  const sel = $<HTMLSelectElement>('km-add-code');
  if (sel.options.length > 0) return;
  sel.add(new Option('— pick a key —', ''));
  for (const g of PICK_GROUPS) {
    const og = document.createElement('optgroup');
    og.label = g.label;
    for (const c of g.codes) og.append(new Option(codeLabel(c), c));
    sel.append(og);
  }
  sel.addEventListener('change', () => {
    gridSel = sel.value || null;
    renderKeyGrid();
    renderKeyStates();
  });
}

async function saveKeymap(e: Event): Promise<void> {
  e.preventDefault();
  const payload = {
    name: $<HTMLInputElement>('km-name').value,
    description: $<HTMLInputElement>('km-desc').value,
    bindings: editBindings
  };
  const res = await adminCall(
    editingKeymapId === null ? 'POST' : 'PUT',
    editingKeymapId === null ? 'api/admin/keymaps' : `api/admin/keymaps/${editingKeymapId}`,
    payload
  );
  if (res.ok) {
    const saved = editingKeymapId === null ? 'created' : 'saved';
    closeKeymapEditor();
    await refreshKeymaps();
    keymapNote(`Keymap ${saved}. Open sessions pick it up the next time the menu appears.`);
  } else {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    $('km-error').textContent = err.error ?? `save failed (${res.status})`;
  }
}

/** Options for the system form's Keymap select (called by fillForm). */
function keymapOptions(selected: number | null | undefined): void {
  const sel = $<HTMLSelectElement>('f-keymap');
  sel.replaceChildren(
    new Option('(gateway default)', ''),
    new Option('(built-in map)', '0'),
    ...keymapRows.map((k) => new Option(k.name, String(k.id)))
  );
  sel.value = selected === undefined || selected === null ? '' : String(selected);
}

async function submitPin(): Promise<void> {
  const input = $<HTMLInputElement>('admin-pin-input');
  const errEl = $('admin-pin-error');
  errEl.textContent = '';
  try {
    const res = await fetch(api('api/admin/auth'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: input.value })
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      errEl.textContent = err.error ?? `sign-on failed (${res.status})`;
      input.select();
      return;
    }
    const data = (await res.json()) as { token: string };
    adminToken = data.token;
    localStorage.setItem(ADMIN_TOKEN_KEY, adminToken);
    input.value = '';
    showEditorPane();
  } catch {
    errEl.textContent = 'network error - is the gateway reachable?';
  }
}

function initAdmin(): void {
  $('admin-cancel').addEventListener('click', closeAdmin);
  $('admin-close').addEventListener('click', closeAdmin);
  $('admin-help').addEventListener('click', () => openHelp('admin'));
  $('admin-logout').addEventListener('click', () => {
    adminToken = null;
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    showPinPane();
  });

  const pinInput = $<HTMLInputElement>('admin-pin-input');
  $('admin-pin-ok').addEventListener('click', () => void submitPin());
  pinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submitPin();
    }
  });

  $('admin-add').addEventListener('click', () => {
    editingId = null;
    fillForm(null);
    $('admin-form').classList.remove('hidden');
    $('admin-list-actions').classList.add('hidden');
    hideFormError();
    $<HTMLInputElement>('f-name').focus();
  });
  $('admin-cancel-edit').addEventListener('click', () => {
    $('admin-form').classList.add('hidden');
    $('admin-list-actions').classList.remove('hidden');
    hideFormError();
  });
  $('admin-form').addEventListener('submit', (e) => void saveForm(e));

  // Config transfer: export downloads every system as JSON; import uploads a
  // file and replaces the whole list (armed first — it is destructive).
  $('admin-export').addEventListener('click', () => void exportConfig());
  $('admin-import').addEventListener('click', pickImportFile);
  $('admin-dirsync').addEventListener('click', () => void syncDirectoryNow());
  $('admin-import-file').addEventListener('change', () => {
    const input = $<HTMLInputElement>('admin-import-file');
    const f = input.files?.[0];
    input.value = ''; // picking the same file twice must still fire change
    if (f) void importConfigFile(f);
  });

  // Console tabs: Systems (the editor above) / Keymaps / Sessions / Recordings / Audit.
  for (const b of $('admin-tabs').querySelectorAll('button')) {
    b.addEventListener('click', () => switchAdminTab((b as HTMLElement).dataset.tab ?? 'systems'));
  }

  // Keymaps tab: upload opens the picker directly (it only ever adds);
  // the editor's grid/picker/extra list rebuild from the working copy.
  buildKeyPicker();
  $('keymap-add').addEventListener('click', () => editKeymap(null));
  $('km-cancel').addEventListener('click', closeKeymapEditor);
  $('keymap-editor').addEventListener('submit', (e) => void saveKeymap(e));
  $('keymap-upload').addEventListener('click', pickKeymapFile);
  $('keymap-file').addEventListener('change', () => {
    const input = $<HTMLInputElement>('keymap-file');
    const f = input.files?.[0];
    input.value = ''; // picking the same file twice must still fire change
    if (f) void importKeymapFile(f);
  });
  $('recordings-refresh').addEventListener('click', () => void refreshRecordings());
  // Settings tab: arm or disarm the automatic sign-on protection PIN.
  $('settings-save').addEventListener('click', () => void saveSettingsPin());
  $('settings-clear').addEventListener('click', () => {
    $<HTMLInputElement>('f-signonpin').value = '';
    void saveSettingsPin();
  });
  // Refresh shows the newest page again; Prev/Next walk the fetched total.
  $('audit-refresh').addEventListener('click', () => {
    auditPage = 0;
    void refreshAudit();
  });
  $('audit-prev').addEventListener('click', () => {
    if (auditPage > 0) {
      auditPage--;
      void refreshAudit();
    }
  });
  $('audit-next').addEventListener('click', () => {
    auditPage++; // an overshoot is clamped (and re-fetched) by refreshAudit
    void refreshAudit();
  });

  // Escape closes the admin overlay from anywhere: focus often stays outside
  // it (on the ADMIN button that opened it, or on the page body), so a
  // listener on the overlay itself never fires. Capture phase at document
  // level, and swallow the event so the menu's own Escape (which would hide
  // the whole menu underneath) doesn't act at the same time.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || $('admin-modal').classList.contains('hidden')) return;
      e.stopPropagation();
      closeAdmin();
    },
    true
  );
}

// ------------------------------------------------- sign-on PIN prompt ----
// The user side of the sign-on protection PIN (the admin Settings tab arms
// it). A connection that would sign on automatically asks first: prove the
// PIN, sign on yourself, or cancel. A proven PIN is kept in memory for this
// page only (never sessionStorage/localStorage) so later panes and
// reconnects don't nag again; the proof travels as a single-use ticket on
// the WebSocket URL - the PIN itself never rides a URL.

/** A PIN proven this page load; null until the user enters a correct one. */
let signOnPinVerified: string | null = null;
let signOnPinPrompt: Promise<string | null | undefined> | null = null;
let signOnPinResolve: ((v: string | null | undefined) => void) | null = null;

/**
 * Exchange the protection PIN for a single-use sign-on ticket. On rejection
 * returns the gateway's reason ("PIN is not valid", "Too many attempts -
 * locked for Ns", ...) verbatim - callers show it instead of guessing, so a
 * lockout never masquerades as a wrong PIN.
 */
export async function signOnTicketFor(
  pin: string
): Promise<{ ticket: string } | { error: string }> {
  try {
    const res = await fetch(api('api/signon-ticket'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    const data = (await res.json().catch(() => ({}))) as { ticket?: string; error?: string };
    if (res.ok && data.ticket) return { ticket: data.ticket };
    return { error: data.error ?? `PIN check failed (${res.status})` };
  } catch {
    return { error: 'network error - is the gateway reachable?' };
  }
}

/**
 * Ask for the sign-on protection PIN. Resolves with the verified PIN,
 * null for "sign on myself" (connect, but no automatic sign-on), or
 * undefined when cancelled (abort the connection). Concurrent callers
 * (a grid page booting several panes) share one dialog.
 */
export function promptSignOnPin(): Promise<string | null | undefined> {
  if (signOnPinVerified !== null) return Promise.resolve(signOnPinVerified);
  signOnPinPrompt ??= new Promise((resolve) => {
    signOnPinResolve = resolve;
    const input = $<HTMLInputElement>('signon-pin-input');
    input.value = '';
    $('signon-pin-error').textContent = '';
    $('signon-pin-modal').classList.remove('hidden');
    window.setTimeout(() => input.focus(), 0);
  });
  return signOnPinPrompt;
}

function settleSignOnPin(value: string | null | undefined): void {
  if (!signOnPinResolve) return;
  $('signon-pin-modal').classList.add('hidden');
  if (typeof value === 'string') signOnPinVerified = value;
  signOnPinPrompt = null; // a later "sign on myself" asks again
  const resolve = signOnPinResolve;
  signOnPinResolve = null;
  resolve(value);
}

async function submitSignOnPin(): Promise<void> {
  const input = $<HTMLInputElement>('signon-pin-input');
  const errEl = $('signon-pin-error');
  // Trimmed like the Settings tab's Save, so the two compare the same string.
  const pin = input.value.trim();
  if (!pin) {
    errEl.textContent = 'Enter the protection PIN, or choose Sign on myself.';
    return;
  }
  const result = await signOnTicketFor(pin);
  if (!('ticket' in result)) {
    // The gateway's own words: "PIN is not valid" vs "Too many attempts -
    // locked for Ns" (a lockout refuses even the right PIN - wait it out).
    errEl.textContent = result.error;
    input.select();
    return;
  }
  input.value = '';
  settleSignOnPin(pin);
}

function initSignOnPinPrompt(): void {
  $('signon-pin-ok').addEventListener('click', () => void submitSignOnPin());
  $('signon-pin-skip').addEventListener('click', () => settleSignOnPin(null));
  $('signon-pin-cancel').addEventListener('click', () => settleSignOnPin(undefined));
  const input = $<HTMLInputElement>('signon-pin-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submitSignOnPin();
    }
  });
  // Escape cancels the pending connection question (capture phase, swallowed
  // so nothing underneath - menu or pane - reacts to the same press).
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || $('signon-pin-modal').classList.contains('hidden')) return;
      e.stopPropagation();
      settleSignOnPin(undefined);
    },
    true
  );
}
