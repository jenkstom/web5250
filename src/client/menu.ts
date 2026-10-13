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
    sub.textContent = `${s.host}:${s.port} · ${s.ssl ? 'TLS' : 'telnet'} · ${s.termType} · ${s.codePage}`;
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

  $('menu-go').addEventListener('click', () => connectTo(selected));
  $('menu-admin-btn').addEventListener('click', openAdmin);

  // Split view: reload this page with ?grid=N. Each pane is an independent
  // session (one 5250 device per WebSocket); the stale ?system= of a deep
  // link is dropped so the panes start at the menu, not mid-session.
  const splitTo = (n: 2 | 4): void => {
    const u = new URL(window.location.href);
    u.searchParams.delete('system');
    u.searchParams.set('grid', String(n));
    window.location.href = u.href;
  };
  $('menu-split2').addEventListener('click', () => splitTo(2));
  $('menu-split4').addEventListener('click', () => splitTo(4));

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
  const list = $('admin-list');
  list.innerHTML = '';
  systems.forEach((s, i) => {
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
      upDownButton('↓', 'Move down', i === systems.length - 1, () => void moveSystem(s.id, 'down')),
      edit,
      del
    );
    list.appendChild(li);
  });
  $('admin-count').textContent = `${systems.length} system(s)`;
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
    devPrefix: $<HTMLInputElement>('f-prefix').value
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
