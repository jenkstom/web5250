// Maintenance windows: per-system or gateway-wide. While on, new sessions
// for the affected systems are refused (the upgrade is answered with the
// message, the menu shows the system disabled), and existing sessions get
// banner notices - at switch-on and, with a deadline, at T-10m / T-5m / T-1m
// - before every affected session is ended at the deadline. State is
// runtime-only by design: a maintenance window is an operator gesture, and a
// gateway restart clearing it is the safe failure direction.
import { allSessions } from './sessions.ts';
import type { HostSession } from './gateway.ts';
import type { Audit } from './audit.ts';

export interface MaintView {
  on: boolean;
  message: string;
  /** Epoch ms when affected sessions are ended (null = no deadline). */
  deadlineAt: number | null;
}

interface MaintRuntime extends MaintView {
  timers: NodeJS.Timeout[];
}

/** Banner cadence before the deadline: [offset from deadline, level]. */
const WARNINGS: [number, string][] = [
  [10 * 60 * 1000, 'warn'],
  [5 * 60 * 1000, 'warn'],
  [60 * 1000, 'urgent']
];

export class Maintenance {
  private readonly systems = new Map<number, MaintRuntime>();
  private global: MaintRuntime | null = null;

  constructor(private readonly audit: Audit) {}

  /**
   * Turn maintenance on/off for one system (null = every system, sessions
   * with no menu system included). `deadlineMs` is epoch ms; when given,
   * affected sessions are ended then (not before).
   */
  set(systemId: number | null, on: boolean, message: string, deadlineMs: number | null): MaintView | null {
    if (!on) {
      const prev = systemId === null ? this.global : this.systems.get(systemId);
      if (!prev) return null;
      for (const t of prev.timers) clearTimeout(t);
      if (systemId === null) this.global = null;
      else this.systems.delete(systemId);
      this.notifyScope(systemId, 'info', `Maintenance is over — ${message || 'thank you for your patience.'}`);
      this.audit.log('admin', 'maintenance.off', this.targetOf(systemId));
      return null;
    }
    const deadlineAt = deadlineMs && deadlineMs > Date.now() ? deadlineMs : null;
    const runtime: MaintRuntime = {
      on: true,
      message: message || 'Host maintenance',
      deadlineAt,
      timers: []
    };
    if (systemId === null) this.global = runtime;
    else this.systems.set(systemId, runtime);

    const target = this.targetOf(systemId);
    this.audit.log(
      'admin',
      'maintenance.on',
      target,
      deadlineAt ? `sessions end at ${new Date(deadlineAt).toISOString()}` : 'no deadline'
    );
    this.notifyScope(
      systemId,
      'warn',
      deadlineAt
        ? `${runtime.message} — sessions on this system end at ${fmtTime(deadlineAt)}. Please sign off before then.`
        : `${runtime.message} — new sessions are blocked until further notice.`
    );
    if (deadlineAt) {
      const until = deadlineAt - Date.now();
      for (const [offset, level] of WARNINGS) {
        const delay = until - offset;
        if (delay > 0) {
          runtime.timers.push(
            setTimeout(() => {
              this.notifyScope(systemId, level, `${runtime.message} — sessions end in ${offset / 60000} min.`);
            }, delay)
          );
        }
      }
      runtime.timers.push(
        setTimeout(() => {
          const doomed = this.scope(systemId);
          this.notifyScope(systemId, 'urgent', `${runtime.message} — ending sessions now.`);
          for (const s of doomed) s.end();
          this.audit.log('admin', 'maintenance.drain', this.targetOf(systemId), `${doomed.length} session(s) ended`);
        }, until)
      );
      for (const t of runtime.timers) t.unref();
    }
    return viewOf(runtime);
  }

  /** Refusal for new sessions: null when the target system is unaffected. */
  blocked(systemId: number | undefined): { message: string; deadlineAt: number | null } | null {
    if (this.global) return { message: this.global.message, deadlineAt: this.global.deadlineAt };
    if (systemId !== undefined) {
      const m = this.systems.get(systemId);
      if (m) return { message: m.message, deadlineAt: m.deadlineAt };
    }
    return null;
  }

  /** Public status for the menu (per blocked system: message + deadline). */
  status(): { global: MaintView | null; systems: Record<string, MaintView> } {
    const systems: Record<string, MaintView> = {};
    for (const [id, m] of this.systems) systems[String(id)] = viewOf(m);
    return { global: this.global ? viewOf(this.global) : null, systems };
  }

  maintenanceOf(systemId: number): MaintView | null {
    const m = this.systems.get(systemId);
    return m ? viewOf(m) : this.global ? viewOf(this.global) : null;
  }

  private scope(systemId: number | null): HostSession[] {
    return allSessions().filter((s) => (systemId === null ? true : s.systemId === systemId));
  }

  private notifyScope(systemId: number | null, level: string, message: string): void {
    for (const s of this.scope(systemId)) s.notifyAll(level, message);
  }

  private targetOf(systemId: number | null): string {
    return systemId === null ? 'global' : `system:${systemId}`;
  }
}

function viewOf(m: MaintRuntime): MaintView {
  return { on: m.on, message: m.message, deadlineAt: m.deadlineAt };
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
