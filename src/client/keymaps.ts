// Custom keymap overlays (the admin console's Keymaps tab). The gateway
// serves the catalog publicly - a session needs its bindings before its
// first keypress, and session users never sign in to the gateway itself -
// and this module resolves which overlay applies to a system: the host's
// assigned keymap wins over the gateway default, and a host pinned to the
// built-in map (keymapId 0) ignores the default entirely. The overlay match
// itself runs inside keyboard.ts's mapEvent, before the built-in mapping.
export interface KeyBinding {
  code: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  action: string;
  ch?: string;
}

export interface KeymapEntry {
  id: number;
  name: string;
  bindings: KeyBinding[];
}

/**
 * Display names for every logical key the gateway accepts - shared by the
 * pane key readout (pane.ts) and the keymap editor's action menus. Lives here
 * (not in pane.ts) so the admin editor can use it without an import cycle.
 */
export const KEY_LABELS: Record<string, string> = {
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
  bsdelete: 'Destructive Bksp',
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
  help: 'Help',
  paste: 'Paste',
  browser: '(browser)'
};

/** PF keys render as F1..F24; everything else by its label. */
export function keyLabel(k: string): string {
  const pf = /^pf(\d{1,2})$/.exec(k);
  if (pf) return `F${pf[1]}`;
  return KEY_LABELS[k] ?? k;
}

interface Catalog {
  keymaps: KeymapEntry[];
  defaultKeymapId: number | null;
  /** Keymap id per stored-system id (0 = pinned to the built-in map). */
  bySystem: Map<string, number>;
}

let catalog: Catalog = { keymaps: [], defaultKeymapId: null, bySystem: new Map() };

/** API base derives from the page path (sub-path deploy tolerant), like menu.ts. */
const api = (name: string): string =>
  window.location.origin + window.location.pathname.replace(/[^/]*$/, '') + name;

/**
 * (Re)load the catalog. Called when the menu (re)appears so keymap edits and
 * per-host assignments land in open sessions too: panes keep whatever map
 * resolves at each keypress, and a failed fetch keeps the last good catalog
 * (a cold unreachable gateway just means the built-in mapping only).
 */
export async function loadKeymaps(): Promise<void> {
  try {
    const [kmRes, sysRes] = await Promise.all([
      fetch(api('api/keymaps'), { headers: { accept: 'application/json' } }),
      fetch(api('api/systems'), { headers: { accept: 'application/json' } })
    ]);
    if (!kmRes.ok || !sysRes.ok) return;
    const km = (await kmRes.json()) as { keymaps?: KeymapEntry[]; defaultKeymapId?: number | null };
    const sys = (await sysRes.json()) as { systems?: { id: number | string; keymapId?: number | null }[] };
    const bySystem = new Map<string, number>();
    for (const s of sys.systems ?? []) {
      // keymapId 0 (pin to built-in) must survive the trip too; null/missing
      // rows simply never enter the map and fall back to the default.
      if (typeof s.keymapId === 'number') bySystem.set(String(s.id), s.keymapId);
    }
    catalog = {
      keymaps: (km.keymaps ?? []).map((k) => ({ id: k.id, name: k.name, bindings: k.bindings ?? [] })),
      defaultKeymapId: km.defaultKeymapId ?? null,
      bySystem
    };
  } catch {
    // keep the last good catalog
  }
}

/** The overlay a session on this system should use, null for built-in only. */
export function bindingsFor(systemId: number | string | null): KeyBinding[] | null {
  const assigned = systemId === null ? undefined : catalog.bySystem.get(String(systemId));
  if (assigned === 0) return null; // host pinned to the built-in map
  const byId = (id: number | undefined): KeymapEntry | undefined =>
    id === undefined || id === null ? undefined : catalog.keymaps.find((k) => k.id === id);
  // Directory hosts ("dir:…") have no stored row: the gateway default applies.
  const map = byId(assigned) ?? byId(catalog.defaultKeymapId ?? undefined);
  return map && map.bindings.length > 0 ? map.bindings : null;
}

/**
 * Overlay match for one keydown: the first binding for this physical key in
 * exactly this modifier state. Meta/OS combos always stay with the browser.
 * Returns the logical key, 'browser' (explicit unbind), or null (no binding).
 */
export function matchBinding(
  e: KeyboardEvent,
  bindings: KeyBinding[]
): { k: string; ch?: string } | 'browser' | null {
  if (e.metaKey) return null;
  for (const b of bindings) {
    if (b.code !== e.code) continue;
    if (b.shift !== e.shiftKey || b.ctrl !== e.ctrlKey || b.alt !== e.altKey) continue;
    if (b.action === 'browser') return 'browser';
    if (b.action === 'char') return { k: 'char', ch: b.ch ?? '' };
    return { k: b.action };
  }
  return null;
}
