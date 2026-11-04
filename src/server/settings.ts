// Gateway-wide settings (the admin console's Settings tab), persisted in the
// same SQLite file as the systems catalog so admin edits survive restarts.
//
// First tenant: the sign-on protection PIN — an optional, system-wide gate on
// automatic sign-on. When set, a session only signs on automatically if the
// user proved the PIN first; a missing or wrong proof still connects, just to
// the normal sign-on screen. The PIN itself is stored as a SHA-256 digest and
// compared in constant time (the ADMIN_PIN trust model from admin-auth.ts);
// the browser never sends the raw PIN across a URL — it exchanges it for a
// single-use, 60 s ticket that rides the WebSocket query instead, the same
// capability-token model the share/replay/print links use.
import { DatabaseSync } from 'node:sqlite';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PIN_KEY = 'signOnPin';
const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MS = 60_000;
const TICKET_TTL_MS = 60_000;

export class Settings {
  private readonly db: DatabaseSync;
  private pinFailures = 0;
  private pinLockedUntil = 0;
  private readonly tickets = new Map<string, number>();

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    // No journal_mode pragma here: Systems opens the same file first and owns
    // its WAL mode (see Audit for the locking reasons).
    this.db = new DatabaseSync(dbPath);
    this.db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  /** True when the admin armed the gate (a protection PIN is stored). */
  signOnPinSet(): boolean {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(PIN_KEY) as unknown as { value: string } | undefined;
    return Boolean(row?.value);
  }

  /**
   * Store (or, with null/empty, clear) the protection PIN. Only the digest is
   * persisted; a change also drops any lockout and pending tickets so the
   * new PIN takes effect immediately.
   */
  setSignOnPin(pin: string | null): void {
    const digest = pin ? sha256(pin).toString('hex') : '';
    if (digest) {
      this.db
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(PIN_KEY, digest);
    } else {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(PIN_KEY);
    }
    this.pinFailures = 0;
    this.pinLockedUntil = 0;
  }

  /**
   * Verify the PIN and hand out a fresh sign-on ticket. Same shape (and the
   * same lockout cadence) as AdminAuth.signIn, but the result is deliberately
   * short-lived and single-use: it authorizes one automatic sign-on, nothing
   * else.
   */
  exchangeSignOnPin(
    pin: string
  ): { ok: true; ticket: string; expiresInMs: number } | { ok: false; error: string; lockedForS?: number } {
    const stored = this.storedDigest();
    if (!stored) return { ok: false, error: 'No protection PIN is configured' };
    const now = Date.now();
    if (now < this.pinLockedUntil) {
      return {
        ok: false,
        error: `Too many attempts - locked for ${Math.ceil((this.pinLockedUntil - now) / 1000)}s`,
        lockedForS: Math.ceil((this.pinLockedUntil - now) / 1000)
      };
    }
    const digest = sha256(pin);
    if (!pin || !crypto.timingSafeEqual(digest, stored)) {
      this.pinFailures++;
      if (this.pinFailures >= PIN_MAX_FAILURES) {
        this.pinLockedUntil = now + PIN_LOCK_MS;
        this.pinFailures = 0;
      }
      return { ok: false, error: 'PIN is not valid' };
    }
    this.pinFailures = 0;
    return { ok: true, ticket: this.issueTicket(), expiresInMs: TICKET_TTL_MS };
  }

  /**
   * Burn one ticket: true exactly once inside its TTL. Called from the WS
   * upgrade path when a session wants to sign on automatically.
   */
  consumeSignOnTicket(ticket: string | undefined): boolean {
    if (!ticket) return false;
    const expiry = this.tickets.get(ticket);
    this.tickets.delete(ticket); // single-use, success or not
    return expiry !== undefined && expiry >= Date.now();
  }

  private storedDigest(): Buffer | null {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(PIN_KEY) as unknown as { value: string } | undefined;
    return row?.value ? Buffer.from(row.value, 'hex') : null;
  }

  private issueTicket(): string {
    const ticket = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    for (const [t, exp] of this.tickets) if (exp < now) this.tickets.delete(t);
    this.tickets.set(ticket, now + TICKET_TTL_MS);
    return ticket;
  }
}

const sha256 = (v: string): Buffer => crypto.createHash('sha256').update(v, 'utf8').digest();
