// Allocation of unique 5250 display (device) names across live sessions.
//
// A browser can request a display name (stored per-browser, sent as
// ?devname=). When the name is already in use by a live session the
// allocator appends a numeric suffix - TOM -> TOM1 -> TOM2 - always inside
// the 10-character device-name limit. Randomly generated names pass through
// the same registry so even a collision is suffixed rather than reused.
// The IBM i side additionally enforces uniqueness (the telnet layer retries
// with a numbered name if the host rejects a collision).

export class DeviceRegistry {
  private readonly inUse = new Set<string>();

  /**
   * Reserve `requested` or its first free suffixed variant. Returns null
   * only for null/empty input. Names longer than 10 characters are not
   * suffixed further (they are already at the limit); the caller's
   * validation keeps them legal.
   */
  allocate(requested: string | null): string | null {
    if (!requested) return null;
    if (requested.length > 10) return null;
    if (!this.inUse.has(requested)) {
      this.inUse.add(requested);
      return requested;
    }
    for (let n = 1; n < 100000; n++) {
      const suffix = String(n);
      const name = requested.slice(0, 10 - suffix.length) + suffix;
      if (!this.inUse.has(name)) {
        this.inUse.add(name);
        return name;
      }
    }
    // Practically unreachable; fall back to a fresh random-style name.
    const fallback = `D${Date.now().toString(36).toUpperCase().slice(-9)}`.slice(0, 10);
    this.inUse.add(fallback);
    return fallback;
  }

  release(name: string | null): void {
    if (name) this.inUse.delete(name);
  }

  get size(): number {
    return this.inUse.size;
  }
}

export const devices = new DeviceRegistry();
