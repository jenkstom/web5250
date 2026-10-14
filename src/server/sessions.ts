// Live host-session registry.
//
// A host session (the tn5250 client + its device name + launch automation) is
// keyed by an unguessable re-attach token, so a browser can detach - tab
// close, reload, or moving a split-view pane into its own window - and a
// browser in another window/tab can attach to the same running session via
// ?attach=<token>. A second, independent share token keys the read-only
// mirror (?view=<token>): it grants watching, never control. Entries remove
// themselves when the core is destroyed; the maps are in-memory by design
// (session lifetime is this process's lifetime).
import { randomBytes } from 'node:crypto';
import type { HostSession } from './gateway.ts';

const registry = new Map<string, HostSession>();
const shares = new Map<string, HostSession>();

export function registerSession(session: HostSession): void {
  registry.set(session.token, session);
  shares.set(session.shareToken, session);
}

export function getSession(token: string): HostSession | undefined {
  return registry.get(token);
}

/** The session a read-only mirror may watch (?view=<share token>). */
export function getSessionByShare(token: string): HostSession | undefined {
  return shares.get(token);
}

export function removeSession(token: string): void {
  const session = registry.get(token);
  registry.delete(token);
  if (session) shares.delete(session.shareToken);
}

export function allSessions(): HostSession[] {
  return [...registry.values()];
}

/** 128 bits of entropy: the token is a bearer credential for the session. */
export function newSessionToken(): string {
  return randomBytes(16).toString('hex');
}
