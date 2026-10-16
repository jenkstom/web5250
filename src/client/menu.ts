// System-selection menu + administrator editor.
//
// The menu is the app's landing screen: a retro 5250-style panel listing the
// systems from the gateway's SQLite store. Users pick one with the arrow
// keys / a number + Enter, or by tapping. The admin editor (PIN-gated on the
// server via ADMIN_PIN) manages that list: add, edit, delete, reorder.
export interface MenuSystem {
  id: number;
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
  /** Present only on the admin editor's (authenticated) copy of the row. */
  proxyHost?: string | null;
  proxyPort?: number | null;
  proxyUser?: string | null;
  proxyPass?: string | null;
}

interface Meta {
  adminEnabled: boolean;
  allowCustomHost: boolean;
  showDiagButton?: boolean;
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
let systems: MenuSystem[] = [];
let meta: Meta | null = null;
let selected = 0;
let onSelect: ((s: MenuSystem) => void) | null = null;
let booted = false;

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

/** The editor's copy of the list: full rows, proxy credentials included. */
async function fetchAdminSystems(): Promise<MenuSystem[]> {
  const res = await adminCall('GET', 'api/admin/systems');
  if (!res.ok) throw new Error(`admin systems list failed (${res.status})`);
  const data = (await res.json()) as { systems: MenuSystem[] };
  return data.systems ?? [];
}

let metaPromise: Promise<Meta | null> | null = null;

/** /api/meta, fetched once per page load (null when the gateway is unreachable). */
export function loadMeta(): Promise<Meta | null> {
  metaPromise ??= fetchMeta().catch(() => null);
  return metaPromise;
}

/** Show the menu and (re)load its data. Called on first start and whenever a session ends. */
export async function showMenu(callback: (s: MenuSystem) => void): Promise<void> {
  onSelect = callback;
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
  selected = Math.min(selected, Math.max(systems.length - 1, 0));
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
function render(): void {
  const list = $('menu-list');
  list.innerHTML = '';
  systems.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'menu-row' + (i === selected ? ' sel' : '');

    const num = document.createElement('span');
    num.className = 'row-num';
    num.textContent = `${i + 1}.`;

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
    sub.textContent = `${s.host}:${s.port} · ${s.ssl ? 'TLS' : 'telnet'} · ${s.termType} · ${s.codePage}${s.viaProxy ? ' · SOCKS5' : ''}`;
    main.appendChild(sub);

    li.append(num, main);
    li.addEventListener('click', () => (selected === i ? connectTo(i) : select(i)));
    list.appendChild(li);
  });

  const empty = $('menu-empty');
  if (systems.length === 0 && $('menu-error').classList.contains('hidden')) {
    empty.textContent = 'No systems configured.\nSelect Admin below to add one.';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
  }

  $<HTMLInputElement>('menu-option').value = systems.length ? String(selected + 1) : '';
}

function select(i: number): void {
  selected = Math.max(0, Math.min(i, systems.length - 1));
  render();
}

function connectTo(i: number): void {
  const s = systems[i];
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
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      select(selected - 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      select(selected + 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const typed = Number.parseInt(option.value, 10);
      const idx = Number.isInteger(typed) && typed >= 1 && typed <= systems.length ? typed - 1 : selected;
      connectTo(idx);
    } else if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      openAdmin();
    } else if (e.key === 'Escape') {
      option.value = systems.length ? String(selected + 1) : '';
    }
  });
  option.addEventListener('input', () => {
    const typed = Number.parseInt(option.value, 10);
    if (Number.isInteger(typed) && typed >= 1 && typed <= systems.length) select(typed - 1);
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
    } else if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      openAdmin();
    } else if (e.key === 'Escape') {
      hideMenu();
    }
  });

  $('menu-go').addEventListener('click', () => connectTo(selected));
  $('menu-admin-btn').addEventListener('click', openAdmin);

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
  readonly el: HTMLDivElement;
  private readonly listEl: HTMLUListElement;
  private readonly emptyEl: HTMLElement;
  private readonly errEl: HTMLElement;
  private readonly option: HTMLInputElement;
  private rows: MenuSystem[] = [];
  private selected = 0;

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
    this.emptyEl = document.createElement('p');
    this.emptyEl.className = 'sys-menu-empty hidden';
    this.errEl = document.createElement('p');
    this.errEl.className = 'sys-menu-error hidden';
    const cmd = document.createElement('div');
    cmd.className = 'sys-menu-cmd';
    const label = document.createElement('label');
    label.textContent = 'Option ==>';
    this.option = document.createElement('input');
    this.option.autocomplete = 'off';
    this.option.autocapitalize = 'off';
    this.option.spellcheck = false;
    this.option.inputMode = 'numeric';
    this.option.maxLength = 2;
    this.option.setAttribute('aria-label', 'System number');
    label.append(this.option);
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'primary';
    go.textContent = 'Connect';
    go.addEventListener('click', () => this.connectSelected());
    cmd.append(label, go);
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
    frame.append(title, sub, this.listEl, this.emptyEl, this.errEl, cmd, foot);
    el.append(frame);
    this.el = el;

    // Same keyboard contract as the landing menu: arrows / typed number
    // select, Enter connects, Escape cancels - from anywhere in the picker.
    el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.select(this.selected - 1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.select(this.selected + 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.connectSelected();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    this.option.addEventListener('input', () => {
      const typed = Number.parseInt(this.option.value, 10);
      if (Number.isInteger(typed) && typed >= 1 && typed <= this.rows.length) this.select(typed - 1);
    });

    mount.append(el);
    if (focus) this.option.focus();
    void this.refresh();
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
    this.selected = Math.min(this.selected, Math.max(this.rows.length - 1, 0));
    this.render();
  }

  private render(): void {
    this.listEl.replaceChildren(
      ...this.rows.map((s, i) => {
        const li = document.createElement('li');
        li.className = 'menu-row' + (i === this.selected ? ' sel' : '');
        const num = document.createElement('span');
        num.className = 'row-num';
        num.textContent = `${i + 1}.`;
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
        sub.textContent = `${s.host}:${s.port} · ${s.ssl ? 'TLS' : 'telnet'}${s.viaProxy ? ' · SOCKS5' : ''}`;
        main.appendChild(sub);
        li.append(num, main);
        li.addEventListener('click', () => (this.selected === i ? this.connectTo(i) : this.select(i)));
        return li;
      })
    );
    if (this.rows.length === 0 && this.errEl.classList.contains('hidden')) {
      this.emptyEl.textContent = 'No systems configured.\nLeave split view and add one under Admin.';
      this.emptyEl.classList.remove('hidden');
    } else {
      this.emptyEl.classList.add('hidden');
    }
    this.option.value = this.rows.length ? String(this.selected + 1) : '';
  }

  private select(i: number): void {
    this.selected = Math.max(0, Math.min(i, this.rows.length - 1));
    this.render();
  }

  private connectSelected(): void {
    const typed = Number.parseInt(this.option.value, 10);
    const idx =
      Number.isInteger(typed) && typed >= 1 && typed <= this.rows.length ? typed - 1 : this.selected;
    this.connectTo(idx);
  }

  private connectTo(i: number): void {
    const s = this.rows[i];
    if (!s) return;
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
const TOKEN_KEY = 'web5250.adminToken';
let adminToken: string | null = sessionStorage.getItem(TOKEN_KEY);
let editingId: number | null = null; // null = adding a new system

async function adminCall(method: string, name: string, body?: unknown): Promise<Response> {
  const res = await fetch(api(name), {
    method,
    headers: { 'content-type': 'application/json', ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.status === 401 && adminToken) {
    adminToken = null;
    sessionStorage.removeItem(TOKEN_KEY);
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
  hideFormError();
  $('menu-option').focus();
}

function showPinPane(): void {
  $('admin-editor').classList.add('hidden');
  $('admin-pin').classList.remove('hidden');
  $('admin-pin-error').textContent = '';
  $<HTMLInputElement>('admin-pin-input').value = '';
  // Hidden when the server reports ADMIN_PIN is unset.
  $('admin-pin-note').classList.toggle('hidden', meta?.adminEnabled !== false);
  window.setTimeout(() => $('admin-pin-input').focus(), 0);
}

function showEditorPane(): void {
  $('admin-pin').classList.add('hidden');
  $('admin-editor').classList.remove('hidden');
  void refreshAdminList();
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
  } catch {
    /* menu refresh is cosmetic here */
  }
  // The editor works from the authenticated copy: it carries the proxy
  // fields the public list never sees. If that fetch fails, show no rows
  // rather than the public ones - editing a public row would blank its
  // proxy credentials on save (a 401 has already flipped to the PIN pane).
  let rows: MenuSystem[] = [];
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
      (s.devPrefix ? ` · ${s.devPrefix}` : '');
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

async function deleteSystem(s: MenuSystem, btn: HTMLButtonElement): Promise<void> {
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

function fillForm(s: MenuSystem | null): void {
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
}

function editSystem(s: MenuSystem): void {
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
    proxyPass: $<HTMLInputElement>('f-proxypass').value
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
    sessionStorage.setItem(TOKEN_KEY, adminToken);
    input.value = '';
    showEditorPane();
  } catch {
    errEl.textContent = 'network error - is the gateway reachable?';
  }
}

function initAdmin(): void {
  $('admin-cancel').addEventListener('click', closeAdmin);
  $('admin-close').addEventListener('click', closeAdmin);
  $('admin-logout').addEventListener('click', () => {
    adminToken = null;
    sessionStorage.removeItem(TOKEN_KEY);
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

  // Escape closes the admin overlay from anywhere inside it.
  $('admin-modal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAdmin();
  });
}
