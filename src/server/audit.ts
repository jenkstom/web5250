// Append-only audit log for actions that exercise power over sessions:
// admin console operations (mirror, signal, end, maintenance), remote-assist
// lifecycle (request/grant/deny/revoke/break-glass), and replay-link minting.
// The point is accountability: the admin can already do everything the edge
// lets it - the audit trail is what makes each use answerable after the fact.
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';

export interface AuditEntry {
  id: number;
  ts: number;
  actor: string;
  action: string;
  target: string;
  detail: string;
}

/** Rows kept before inserts prune the oldest (bounded, evidence-sized). */
const MAX_ROWS = 5000;

export class Audit {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const file = dbPath === ':memory:' ? ':memory:' : dbPath;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    // No journal_mode pragma here: Systems opens the same file first and
    // owns its WAL mode - re-execing it needs an exclusive lock two gateway
    // processes (or three connections) can collide on.
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        ts     INTEGER NOT NULL,
        actor  TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT ''
      )
    `);
  }

  log(actor: string, action: string, target = '', detail = ''): void {
    this.db
      .prepare('INSERT INTO audit (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), actor.slice(0, 120), action.slice(0, 80), target.slice(0, 120), detail.slice(0, 400));
    // Bounded by id: prune whenever the high-water mark crosses a threshold.
    const row = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM audit').get() as unknown as { m: number };
    if (Number(row.m) % 500 === 0 && Number(row.m) > MAX_ROWS) {
      this.db.prepare('DELETE FROM audit WHERE id <= ?').run(Number(row.m) - MAX_ROWS);
    }
  }

  list(opts: { limit?: number; action?: string; target?: string } = {}): AuditEntry[] {
    const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
    const where: string[] = [];
    const args: (number | string)[] = [];
    if (opts.action) {
      where.push('action = ?');
      args.push(opts.action);
    }
    if (opts.target) {
      where.push('target = ?');
      args.push(opts.target);
    }
    const sql =
      `SELECT id, ts, actor, action, target, detail FROM audit` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, limit) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      ts: Number(r.ts),
      actor: String(r.actor),
      action: String(r.action),
      target: String(r.target),
      detail: String(r.detail)
    }));
  }
}
