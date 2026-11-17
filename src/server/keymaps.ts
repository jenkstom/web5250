// Admin-managed keyboard maps (the Keymaps tab), persisted in the same
// SQLite file as the systems catalog so they survive restarts and ride the
// config export/import. A keymap is a set of overlay bindings applied on top
// of the emulator's built-in browser mapping (src/client/keyboard.ts):
// a binding names a physical key (browser KeyboardEvent.code) with one
// modifier state and the 5250 action it should send instead. Keymaps are
// assigned gateway-wide (the default) or per system; see systems.ts's
// keymap_id column. The gateway-wide default id lives in the settings table
// next to the sign-on PIN.
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** One key of a custom keymap: the physical key + one modifier state, and
 *  the gateway key name it sends. "browser" is the explicit unbind (the
 *  browser keeps the key); "char" sends a literal character in ch. */
export interface KeyBinding {
  code: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  action: string;
  ch?: string;
}

export interface KeymapRow {
  id: number;
  name: string;
  description: string;
  bindings: KeyBinding[];
  createdAt: string;
  updatedAt: string;
}

/** The 5250 actions a binding can send - exactly the vocabulary the gateway
 *  already understands (gateway.ts KEY_TO_AID / LOCK_SAFE_KEYS / localKey),
 *  including two the built-in browser map never reaches (clear, fieldplus).
 *  The pseudo-actions "char" and "browser" are handled alongside. */
export const KEY_ACTIONS: readonly string[] = [
  'enter', 'clear', 'rollup', 'rolldown',
  'pf1', 'pf2', 'pf3', 'pf4', 'pf5', 'pf6', 'pf7', 'pf8', 'pf9', 'pf10',
  'pf11', 'pf12', 'pf13', 'pf14', 'pf15', 'pf16', 'pf17', 'pf18', 'pf19',
  'pf20', 'pf21', 'pf22', 'pf23', 'pf24',
  'tab', 'btab', 'fieldexit', 'fieldplus', 'fieldminus',
  'backspace', 'bsdelete', 'delete', 'insert',
  'up', 'down', 'left', 'right', 'home', 'end',
  'sysreq', 'attn', 'reset', 'print', 'help'
];

export const isKeyAction = (a: string): boolean => KEY_ACTIONS.includes(a);

const MAX_BINDINGS = 512;
const CODE_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const DEFAULT_KEY = 'defaultKeymapId';

/** Validate a whole import list: every entry valid, names unique. Returns
 *  the validated entries so callers can pre-flight an import before any
 *  section of it is committed (the config-import route validates keymaps
 *  and systems together, then swaps). */
export function validateKeymapList(
  raw: unknown
): { ok: true; values: { name: string; description: string; bindings: KeyBinding[] }[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'keymaps must be a list' };
  const values: { name: string; description: string; bindings: KeyBinding[] }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const v = validateKeymapInput(raw[i]);
    if (!v.ok) return { ok: false, error: `Keymap ${i + 1}: ${v.error}` };
    if (seen.has(v.value.name)) {
      return { ok: false, error: `Keymap ${i + 1}: duplicate name "${v.value.name}"` };
    }
    seen.add(v.value.name);
    values.push(v.value);
  }
  return { ok: true, values };
}

export type KeymapValidation =
  | { ok: true; value: { name: string; description: string; bindings: KeyBinding[] } }
  | { ok: false; error: string };

/** Validate an admin payload ({name, description, bindings}) the way
 *  validateSystemInput does: lenient with scalar types, strict about the
 *  binding vocabulary, with a user-facing error string. */
export function validateKeymapInput(raw: unknown): KeymapValidation {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = String(r.name ?? '').trim().slice(0, 40);
  if (!name) return { ok: false, error: 'Name is required' };
  const description = String(r.description ?? '').trim().slice(0, 120);

  if (r.bindings === undefined || r.bindings === null) {
    return { ok: true, value: { name, description, bindings: [] } };
  }
  if (!Array.isArray(r.bindings)) {
    return { ok: false, error: 'Bindings must be a list' };
  }
  if (r.bindings.length > MAX_BINDINGS) {
    return { ok: false, error: `A keymap may hold at most ${MAX_BINDINGS} bindings` };
  }
  // Same physical key + modifier state must appear once; later entries win.
  const bySlot = new Map<string, KeyBinding>();
  for (let i = 0; i < r.bindings.length; i++) {
    const b = r.bindings[i] as Record<string, unknown>;
    const code = String(b?.code ?? '').trim();
    if (!CODE_RE.test(code)) {
      return { ok: false, error: `Binding ${i + 1}: not a physical key code` };
    }
    const shift = b.shift === true;
    const ctrl = b.ctrl === true;
    const alt = b.alt === true;
    const action = String(b?.action ?? '').trim();
    let binding: KeyBinding;
    if (action === 'char') {
      const ch = String(b?.ch ?? '');
      if ([...ch].length !== 1) {
        return { ok: false, error: `Binding ${i + 1}: "char" needs exactly one character` };
      }
      binding = { code, shift, ctrl, alt, action, ch };
    } else if (action === 'browser' || isKeyAction(action)) {
      binding = { code, shift, ctrl, alt, action };
    } else {
      return { ok: false, error: `Binding ${i + 1}: unknown action "${action.slice(0, 30)}"` };
    }
    bySlot.set(`${code}|${shift ? 1 : 0}${ctrl ? 1 : 0}${alt ? 1 : 0}`, binding);
  }
  return { ok: true, value: { name, description, bindings: [...bySlot.values()] } };
}

interface Row {
  id: number;
  name: string;
  description: string;
  bindings: string;
  created_at: string;
  updated_at: string;
}

const mapRow = (r: Row): KeymapRow => ({
  id: r.id,
  name: r.name,
  description: r.description,
  bindings: JSON.parse(r.bindings) as KeyBinding[],
  createdAt: r.created_at,
  updatedAt: r.updated_at
});

export class Keymaps {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    // Same trust model as Settings: Systems owns the file's WAL mode.
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS keymaps (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        bindings    TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  list(): KeymapRow[] {
    return (
      this.db.prepare('SELECT * FROM keymaps ORDER BY name') as unknown as { all: () => unknown[] }
    )
      .all()
      .map((r) => mapRow(r as Row));
  }

  get(id: number): KeymapRow | undefined {
    const row = this.db.prepare('SELECT * FROM keymaps WHERE id = ?').get(id) as unknown as Row | undefined;
    return row ? mapRow(row) : undefined;
  }

  /** Id of the keymap applied to every host without one of its own. */
  defaultKeymapId(): number | null {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(DEFAULT_KEY) as unknown as { value: string } | undefined;
    const id = row ? Number(row.value) : null;
    return id && this.get(id) ? id : null;
  }

  setDefaultKeymapId(id: number | null): boolean {
    if (id !== null && !this.get(id)) return false;
    if (id === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(DEFAULT_KEY);
    } else {
      this.db
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(DEFAULT_KEY, String(id));
    }
    return true;
  }

  create(raw: unknown): { ok: true; row: KeymapRow } | { ok: false; error: string } {
    const v = validateKeymapInput(raw);
    if (!v.ok) return v;
    if (this.nameTaken(v.value.name)) return { ok: false, error: `A keymap named "${v.value.name}" already exists` };
    const info = this.db
      .prepare('INSERT INTO keymaps (name, description, bindings) VALUES (?, ?, ?)')
      .run(v.value.name, v.value.description, JSON.stringify(v.value.bindings));
    return { ok: true, row: this.get(Number(info.lastInsertRowid))! };
  }

  update(id: number, raw: unknown): { ok: true; row: KeymapRow } | { ok: false; error: string } {
    const v = validateKeymapInput(raw);
    if (!v.ok) return v;
    if (!this.get(id)) return { ok: false, error: 'Keymap not found' };
    const clash = this.db
      .prepare('SELECT id FROM keymaps WHERE name = ? AND id != ?')
      .get(v.value.name, id) as unknown as { id: number } | undefined;
    if (clash) return { ok: false, error: `A keymap named "${v.value.name}" already exists` };
    this.db
      .prepare('UPDATE keymaps SET name = ?, description = ?, bindings = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(v.value.name, v.value.description, JSON.stringify(v.value.bindings), id);
    return { ok: true, row: this.get(id)! };
  }

  /** Delete a keymap: hosts assigned to it fall back to the default (their
   *  keymap_id is nulled), and the default itself is cleared if it was this
   *  one - never a dangling reference either way. */
  remove(id: number): boolean {
    const res = this.db.prepare('DELETE FROM keymaps WHERE id = ?').run(id);
    if (Number(res.changes) === 0) return false;
    this.db.prepare('UPDATE systems SET keymap_id = NULL WHERE keymap_id = ?').run(id);
    if (this.defaultKeymapId() === id) this.setDefaultKeymapId(null);
    return true;
  }

  /** Stored systems currently assigned to this keymap (for the admin list). */
  usedBy(id: number): { id: number; name: string }[] {
    return (
      this.db
        .prepare('SELECT id, name FROM systems WHERE keymap_id = ? ORDER BY position, id')
        .all(id) as unknown as { id: number; name: string }[]
    );
  }

  /** Replace every keymap in one transaction (config import). All rows
   *  validate before anything changes; a bad document leaves the stored
   *  keymaps untouched. Host assignments and the default are re-pointed by
   *  the caller (systems import resolves keymaps by name). */
  replaceAll(raw: unknown): { ok: true; rows: KeymapRow[] } | { ok: false; error: string } {
    const validated = validateKeymapList(raw);
    if (!validated.ok) return validated;
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM keymaps');
      for (const km of validated.values) {
        this.db
          .prepare('INSERT INTO keymaps (name, description, bindings) VALUES (?, ?, ?)')
          .run(km.name, km.description, JSON.stringify(km.bindings));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      return { ok: false, error: `import failed: ${(e as Error).message}` };
    }
    return { ok: true, rows: this.list() };
  }

  private nameTaken(name: string): boolean {
    return Boolean(
      this.db.prepare('SELECT id FROM keymaps WHERE name = ?').get(name) as unknown as { id: number } | undefined
    );
  }
}
