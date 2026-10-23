// Admin PIN auth, shared by the HTTP API and the WebSocket break-glass path:
// one in-memory token store (random, 8 h expiry, constant-time PIN compare,
// lockout after repeated failures). Split out of api.ts so a viewer socket
// can prove administrator-hood for ADMIN_ASSIST_BREAKGLASS the same way the
// console's fetches do.
import * as crypto from 'node:crypto';
import type { Config } from './config.ts';

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MS = 60_000;

export class AdminAuth {
  private readonly tokens = new Map<string, number>();
  private pinFailures = 0;
  private pinLockedUntil = 0;
  private readonly pinDigest: Buffer | null;

  constructor(private readonly cfg: Config) {
    this.pinDigest = cfg.adminPin ? crypto.createHash('sha256').update(cfg.adminPin, 'utf8').digest() : null;
  }

  /** Verify the PIN; on success issue a fresh bearer token. */
  signIn(pin: string): { ok: true; token: string; expiresInMs: number } | { ok: false; error: string; lockedForS?: number } {
    if (!this.cfg.adminPin) {
      return { ok: false, error: 'Administration is disabled (set ADMIN_PIN to enable)' };
    }
    const now = Date.now();
    if (now < this.pinLockedUntil) {
      return { ok: false, error: `Too many attempts - locked for ${Math.ceil((this.pinLockedUntil - now) / 1000)}s` };
    }
    const digest = crypto.createHash('sha256').update(pin, 'utf8').digest();
    if (!pin || !crypto.timingSafeEqual(digest, this.pinDigest!)) {
      this.pinFailures++;
      if (this.pinFailures >= PIN_MAX_FAILURES) {
        this.pinLockedUntil = now + PIN_LOCK_MS;
        this.pinFailures = 0;
      }
      return { ok: false, error: 'PIN is not valid' };
    }
    this.pinFailures = 0;
    return { ok: true, token: this.issue(), expiresInMs: TOKEN_TTL_MS };
  }

  issue(): string {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    for (const [t, exp] of this.tokens) if (exp < now) this.tokens.delete(t);
    this.tokens.set(token, now + TOKEN_TTL_MS);
    return token;
  }

  /** Accepts a raw token or an `Authorization: Bearer <token>` header value. */
  authorized(raw: string | undefined | null): boolean {
    if (!raw) return false;
    const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw.trim();
    if (!token) return false;
    const expiry = this.tokens.get(token);
    if (!expiry || expiry < Date.now()) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }
}
