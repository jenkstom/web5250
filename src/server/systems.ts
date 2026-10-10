// SQLite-backed catalog of the remote systems offered on the connection menu.
//
// Uses Node's built-in node:sqlite module (no runtime npm dependency; needs
// Node >= 22.13). The database lives in a single file — mount its directory
// as a volume to keep admin edits across restarts. On first boot the table is
// seeded from the legacy IBM_I_* environment so pre-menu single-host
// deployments upgrade seamlessly.
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Ebcdic } from './tn5250/ebcdic.ts';
import { TERM_TYPES } from './tn5250/constants.ts';
import type { Config } from './config.ts';

export interface SystemRow {
  id: number;
  name: string;
  description: string;
  host: string;
  port: number;
  ssl: boolean;
  termType: string;
  codePage: string;
  devPrefix: string | null;
  position: number;
}

export type SystemInput = Omit<SystemRow, 'id' | 'position'>;

export type MutationResult = { ok: true; row: SystemRow } | { ok: false; error: string };
export type ValidationResult = { ok: true; value: SystemInput } | { ok: false; error: string };

const HOST_RE = /^[A-Za-z0-9._:-]{1,253}$/;
const PREFIX_RE = /^[A-Za-z0-9#$@_]{1,10}$/;

/**
 * Lenient validation of a JSON payload into a SystemInput: strings may arrive
 * from HTML forms as text, so numbers are coerced. Returns a user-facing
 * error string on failure.
 */
export function validateSystemInput(raw: unknown, cfg: Config): ValidationResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);

  const name = str(r.name, 40);
  if (!name) return { ok: false, error: 'Name is required' };

  const host = str(r.host, 253);
  if (!HOST_RE.test(host)) {
    return { ok: false, error: 'Host must be a hostname or IP (letters, digits, . _ : -)' };
  }

  const portNum = Number.parseInt(String(r.port ?? 23), 10);
  const port = r.port === undefined || r.port === null || r.port === '' ? 23 : portNum;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'Port must be between 1 and 65535' };
  }

  const ssl = r.ssl === true || r.ssl === 'true' || r.ssl === 1 || r.ssl === '1';

  const termType = str(r.termType, 20) || cfg.termType;
  if (!(TERM_TYPES as readonly string[]).includes(termType.toUpperCase())) {
    return { ok: false, error: `Terminal model not supported (use one of ${TERM_TYPES.join(', ')})` };
  }

  const codePage = (str(r.codePage, 10) || cfg.codePage).toLowerCase();
  if (!Ebcdic.availablePages().includes(codePage)) {
    return { ok: false, error: `Code page not supported (use one of ${Ebcdic.availablePages().join(', ')})` };
  }

  const devPrefixRaw = str(r.devPrefix, 10);
  if (devPrefixRaw && !PREFIX_RE.test(devPrefixRaw)) {
    return { ok: false, error: 'Device prefix may only contain A-Z 0-9 # $ @ _ (max 10 chars)' };
  }

  return {
    ok: true,
    value: {
      name,
      description: str(r.description, 120),
      host,
      port,
      ssl,
      termType: termType.toUpperCase(),
      codePage,
      devPrefix: devPrefixRaw ? devPrefixRaw.toUpperCase() : null
    }
  };
}

interface Row {
  id: number;
  name: string;
  description: string;
  host: string;
  port: number;
  ssl: number;
  term_type: string;
  code_page: string;
  dev_prefix: string | null;
  position: number;
}

const mapRow = (r: Row): SystemRow => ({
  id: Number(r.id),
  name: r.name,
  description: r.description ?? '',
  host: r.host,
  port: Number(r.port),
  ssl: Number(r.ssl) !== 0,
  termType: r.term_type,
  codePage: r.code_page,
  devPrefix: r.dev_prefix ?? null,
  position: Number(r.position)
});

export class Systems {
  private readonly db: DatabaseSync;

  constructor(dbPath: string, cfg: Config) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS systems (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        host        TEXT NOT NULL,
        port        INTEGER NOT NULL DEFAULT 23,
        ssl         INTEGER NOT NULL DEFAULT 0,
        term_type   TEXT NOT NULL,
        code_page   TEXT NOT NULL,
        dev_prefix  TEXT,
        position    INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    if (this.list().length === 0) {
      const seed = validateSystemInput(
        {
          name: 'IBM i',
          description: 'Default system (from environment)',
          host: cfg.ibmHost,
          port: cfg.ibmPort,
          ssl: cfg.ibmSsl,
          termType: cfg.termType,
          codePage: cfg.codePage,
          devPrefix: cfg.devPrefix ?? ''
        },
        cfg
      );
      if (seed.ok) this.insert(seed.value!);
    }
  }

  list(): SystemRow[] {
    const rows = this.db.prepare('SELECT * FROM systems ORDER BY position, id').all() as unknown as Row[];
    return rows.map(mapRow);
  }

  get(id: number): SystemRow | undefined {
    const row = this.db.prepare('SELECT * FROM systems WHERE id = ?').get(id) as unknown as Row | undefined;
    return row ? mapRow(row) : undefined;
  }

  create(raw: unknown, cfg: Config): MutationResult {
    const v = validateSystemInput(raw, cfg);
    if (!v.ok) return { ok: false, error: v.error };
    return { ok: true, row: this.insert(v.value!) };
  }

  update(id: number, raw: unknown, cfg: Config): MutationResult {
    const v = validateSystemInput(raw, cfg);
    if (!v.ok) return { ok: false, error: v.error };
    const existing = this.get(id);
    if (!existing) return { ok: false, error: 'System not found' };
    const input = v.value!;
    this.db
      .prepare(
        `UPDATE systems SET name = ?, description = ?, host = ?, port = ?, ssl = ?,
         term_type = ?, code_page = ?, dev_prefix = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(
        input.name,
        input.description,
        input.host,
        input.port,
        input.ssl ? 1 : 0,
        input.termType,
        input.codePage,
        input.devPrefix,
        id
      );
    return { ok: true, row: this.get(id)! };
  }

  remove(id: number): boolean {
    const res = this.db.prepare('DELETE FROM systems WHERE id = ?').run(id);
    if (Number(res.changes) === 0) return false;
    this.renumber();
    return true;
  }

  /** Swap a system with its neighbour in menu order (dir: 'up' | 'down'). */
  move(id: number, dir: string): boolean {
    if (dir !== 'up' && dir !== 'down') return false;
    const rows = this.list();
    const i = rows.findIndex((r) => r.id === id);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (i === -1 || j < 0 || j >= rows.length) return false;
    const swapped = [...rows];
    [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
    this.applyOrder(swapped);
    return true;
  }

  private insert(input: SystemInput): SystemRow {
    const max = this.db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM systems').get() as unknown as {
      m: number;
    };
    const res = this.db
      .prepare(
        `INSERT INTO systems (name, description, host, port, ssl, term_type, code_page, dev_prefix, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.name,
        input.description,
        input.host,
        input.port,
        input.ssl ? 1 : 0,
        input.termType,
        input.codePage,
        input.devPrefix,
        Number(max.m) + 1
      );
    return this.get(Number(res.lastInsertRowid))!;
  }

  /** Rewrite positions as 1..n following the given order. */
  private applyOrder(rows: SystemRow[]): void {
    const stmt = this.db.prepare('UPDATE systems SET position = ? WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      rows.forEach((r, i) => stmt.run(i + 1, r.id));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private renumber(): void {
    this.applyOrder(this.list());
  }
}
