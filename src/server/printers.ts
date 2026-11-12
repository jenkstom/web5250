// Gateway-owned printer sessions and the spool job store.
//
// One Printer5250Client per system with printerEnabled, demand-driven: the
// session starts when a display session opens to the system and stops after
// PRINTER_IDLE_MS with none (0 = always-on), reconciled on every systems-list
// or session-registry change, reconnected with backoff by the client itself
// while demand lasts. Completed jobs go to a bounded store on the data volume
// next to the SQLite DB:
//   <data>/printjobs/<systemId>/<token>.<ext>
// keyed by an unguessable per-job token (the same trust model as the
// session tokens) and enforced by retention knobs - newest N jobs, total
// bytes per system, and a TTL sweep - mirroring the bounded-diag approach
// everywhere else in the gateway. Directory hosts join like any other
// system (their "dir:<id>" keys are path-safe); their printers stop when a
// failed directory sync drops them from the list. A printer dropped by the
// idle tail frees the device: spool files the host releases while it is
// down stay there until the next session opens.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from './config.ts';
import type { DirectorySystem } from './directory.ts';
import { allSessions } from './sessions.ts';
import type { SystemId, SystemRow } from './systems.ts';
import {
  Printer5250Client,
  type PrinterMode,
  type PrinterStatus,
  type PrintJobData
} from './tn5250/printer-client.ts';

export interface PrintJob {
  /** Unguessable download key (bearer credential for this job's bytes). */
  token: string;
  systemId: SystemId;
  device: string;
  mode: PrinterMode;
  format: 'txt' | 'pdf' | 'pcl';
  bytes: number;
  pages: number | null;
  /** Epoch ms (file mtime for jobs recovered after a restart). */
  createdAt: number;
  /** Store-order sequence: several jobs can land in the same millisecond,
   * and retention/list order must follow arrival, not the clock. */
  seq: number;
}

interface RunningPrinter {
  client: Printer5250Client;
  systemId: SystemId;
  /** Device name, kept for log lines after the starting context is gone. */
  device: string;
  /** Configuration signature; a change restarts the session. */
  signature: string;
  jobSeq: number;
}

/** The client's live states, plus the not-running (waiting for demand) view. */
export type PrinterSessionState = PrinterStatus | 'idle';

export interface PrinterStateView {
  systemId: SystemId;
  systemName: string;
  device: string;
  mode: PrinterMode;
  state: PrinterSessionState;
  detail?: string;
}

const EXT_BY_FORMAT: Record<PrintJob['format'], string> = { txt: 'txt', pdf: 'pdf', pcl: 'pcl' };
const CONTENT_TYPE_BY_FORMAT: Record<PrintJob['format'], string> = {
  txt: 'text/plain; charset=utf-8',
  pdf: 'application/pdf',
  pcl: 'application/octet-stream'
};

export class Printers {
  private readonly cfg: Config;
  private readonly listSystems: () => (SystemRow | DirectorySystem)[];
  private readonly root: string;
  private readonly running = new Map<SystemId, RunningPrinter>();
  /** Armed while a system's last display session is gone (printerIdleMs). */
  private readonly idleTimers = new Map<SystemId, NodeJS.Timeout>();
  /** token -> job; jobs of a system kept newest-last for drop-oldest. */
  private readonly jobs = new Map<string, PrintJob>();
  private nextSeq = 1;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(cfg: Config, listSystems: () => (SystemRow | DirectorySystem)[]) {
    this.cfg = cfg;
    this.listSystems = listSystems;
    // Bounded storage lives on the data volume next to the SQLite DB.
    this.root = path.join(path.dirname(cfg.dbPath === ':memory:' ? 'data/x' : cfg.dbPath), 'printjobs');
  }

  /** Boot: recover surviving job files, start configured printers, arm the sweep. */
  start(): void {
    this.recoverJobs();
    this.sync();
    // Recovered files age out now, not on the first 15-minute tick.
    this.sweepExpired();
    this.sweepTimer = setInterval(() => this.sweepExpired(), 15 * 60 * 1000);
    this.sweepTimer.unref();
  }

  /**
   * Reconcile running printers with the systems list and session demand
   * (admin edits, directory syncs and session connect/disconnect apply live).
   * A system's printer runs while at least one display session targets it;
   * after the last one ends it stays up for printerIdleMs, then stops.
   */
  sync(): void {
    const desired = new Map<SystemId, { system: SystemRow | DirectorySystem; signature: string }>();
    for (const system of this.listSystems()) {
      if (!system.printerEnabled) continue;
      const signature = [
        system.host,
        system.port,
        system.ssl,
        system.proxyHost,
        system.proxyPort,
        system.proxyUser,
        system.printerDeviceName,
        system.printerMode,
        system.codePage
      ].join('|');
      desired.set(system.id, { system, signature });
    }

    // Demand = systems with a live display session. A session in its
    // post-detach grace period still counts (the browser may come back),
    // so a refresh never flaps the printer. Raw ?host= sessions carry no
    // system id and cannot be attributed to a printer.
    const demand = new Set<SystemId>();
    for (const session of allSessions()) {
      if (!session.isDestroyed && session.systemId !== undefined) demand.add(session.systemId);
    }

    // Stop printers whose system vanished, was disabled, or changed shape.
    for (const [id, run] of this.running) {
      const want = desired.get(id);
      if (want && want.signature === run.signature) continue;
      this.clearIdleTimer(id);
      run.client.destroy();
      this.running.delete(id);
      console.log(`[printer] session for system ${id} stopped (${want ? 'configuration changed' : 'removed or disabled'})`);
    }

    for (const [id, { system, signature }] of desired) {
      const run = this.running.get(id);
      if (this.cfg.printerIdleMs === 0) {
        // Always-on: demand plays no role (the pre-demand model).
        this.clearIdleTimer(id);
      } else if (demand.has(id)) {
        this.clearIdleTimer(id);
      } else if (run) {
        // Last display session is gone: arm the idle tail once (repeated
        // syncs must not keep postponing it). The printer stays connected
        // meanwhile - a job released right after the last user left still
        // lands.
        if (!this.idleTimers.has(id)) {
          const timer = setTimeout(() => this.idleStop(id), this.cfg.printerIdleMs);
          timer.unref();
          this.idleTimers.set(id, timer);
        }
      } else {
        // Demand-driven and nothing runs: wait for a session to open.
        continue;
      }
      if (run) continue;
      const device = system.printerDeviceName ?? this.cfg.ibmPrinterDeviceName;
      const client = new Printer5250Client({
        host: system.host,
        port: system.port,
        ssl: system.ssl,
        proxy: system.proxyHost
          ? {
              host: system.proxyHost,
              port: system.proxyPort ?? 1080,
              username: system.proxyUser ?? undefined,
              password: system.proxyPass ?? undefined
            }
          : undefined,
        tlsRejectUnauthorized: this.cfg.tlsRejectUnauthorized,
        deviceName: device,
        mode: system.printerMode,
        codePage: system.codePage,
        traceRecords: this.cfg.traceRecords,
        consoleDiag: this.cfg.traceConsole,
        negotiateTimeoutMs: this.cfg.negotiateTimeoutMs,
        maxJobBytes: Math.max(this.cfg.printjobsMaxBytes, 1024 * 1024)
      });
      const started: RunningPrinter = { client, systemId: id, device, signature, jobSeq: 0 };
      this.running.set(id, started);
      client.onStatus = (state, detail) => this.logStatus(started, device, state, detail);
      client.onJob = (job) => this.store(started, system, job);
      client.connect();
      console.log(
        `[printer ${device}] session starting -> ${system.host}:${system.port}` +
          ` (${system.ssl ? 'TLS' : 'telnet'}, ${system.printerMode})`
      );
    }
  }

  /** The idle tail ran out: drop the session so the host frees the device. */
  private idleStop(id: SystemId): void {
    this.idleTimers.delete(id);
    const run = this.running.get(id);
    if (!run) return;
    run.client.destroy();
    this.running.delete(id);
    console.log(`[printer ${run.device}] idle timeout - no display sessions, session stopped`);
  }

  private clearIdleTimer(id: SystemId): void {
    const timer = this.idleTimers.get(id);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(id);
  }

  stopAll(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    for (const run of this.running.values()) run.client.destroy();
    this.running.clear();
  }

  /** Per-system printer states for the UI badge / button gating. */
  status(): PrinterStateView[] {
    const out: PrinterStateView[] = [];
    for (const system of this.listSystems()) {
      if (!system.printerEnabled) continue;
      const run = this.running.get(system.id);
      out.push({
        systemId: system.id,
        systemName: system.name,
        device: system.printerDeviceName ?? this.cfg.ibmPrinterDeviceName,
        mode: system.printerMode,
        state: run?.client.status ?? 'idle',
        detail: run ? run.client.statusDetail : 'starts when a user opens a session'
      });
    }
    return out;
  }

  /** Every stored job, newest first (metadata only - bytes stay on disk). */
  listJobs(): PrintJob[] {
    return [...this.jobs.values()].sort((a, b) => b.seq - a.seq || (a.token < b.token ? -1 : 1));
  }

  /** The job's file path, or null for unknown/expired tokens. */
  jobFile(token: string): { job: PrintJob; file: string; contentType: string } | null {
    const job = this.jobs.get(token);
    if (!job) return null;
    const file = path.join(this.root, String(job.systemId), `${job.token}.${EXT_BY_FORMAT[job.format]}`);
    if (!fs.existsSync(file)) return null;
    return { job, file, contentType: CONTENT_TYPE_BY_FORMAT[job.format] };
  }

  /** Admin-initiated removal; the retention sweep uses the same path. */
  deleteJob(token: string): boolean {
    const job = this.jobs.get(token);
    if (!job) return false;
    const file = path.join(this.root, String(job.systemId), `${job.token}.${EXT_BY_FORMAT[job.format]}`);
    fs.rmSync(file, { force: true });
    this.jobs.delete(token);
    return true;
  }

  // ------------------------------------------------------------- internals
  private logStatus(
    run: RunningPrinter,
    device: string,
    state: PrinterStatus,
    detail?: string
  ): void {
    if (state === 'error') console.warn(`[printer ${device}] ${state}: ${detail ?? ''}`);
    else console.log(`[printer ${device}] ${state}${detail ? ` (${detail})` : ''}`);
  }

  private store(run: RunningPrinter, system: SystemRow | DirectorySystem, job: PrintJobData): void {
    const device = system.printerDeviceName ?? this.cfg.ibmPrinterDeviceName;
    const token = crypto.randomBytes(16).toString('hex');
    const format = job.format;
    const dir = path.join(this.root, String(system.id));
    const file = path.join(dir, `${token}.${EXT_BY_FORMAT[format]}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, job.data);
    } catch (err) {
      console.warn(`[printer ${device}] job could not be stored: ${(err as Error).message}`);
      return;
    }
    run.jobSeq++;
    this.jobs.set(token, {
      token,
      systemId: system.id,
      device,
      mode: system.printerMode,
      format,
      bytes: job.data.length,
      pages: job.pages,
      createdAt: Date.now(),
      seq: this.nextSeq++
    });
    console.log(
      `[printer ${device}] job ${String(run.jobSeq).padStart(4, '0')} stored: ` +
        `${job.data.length} bytes${job.pages ? `, ${job.pages} page(s)` : ''} (${format})`
    );
    this.enforceRetention(system.id);
  }

  /** Drop-oldest until the system's jobs fit count and byte budgets. */
  private enforceRetention(systemId: SystemId): void {
    const mine = this.listJobs().filter((j) => j.systemId === systemId).reverse(); // oldest first
    let count = mine.length;
    let bytes = mine.reduce((sum, j) => sum + j.bytes, 0);
    for (const job of mine) {
      if (count <= this.cfg.printjobsMaxCount && bytes <= this.cfg.printjobsMaxBytes) break;
      count--;
      bytes -= job.bytes;
      console.log(`[printer] retention: dropping job ${job.token.slice(0, 8)}… (${job.bytes} bytes, ${new Date(job.createdAt).toISOString()})`);
      this.deleteJob(job.token);
    }
  }

  private sweepExpired(): void {
    const cutoff = Date.now() - this.cfg.printjobsTtlMs;
    for (const job of this.listJobs()) {
      if (job.createdAt < cutoff) this.deleteJob(job.token);
    }
  }

  /**
   * Rebuild the index from surviving files after a restart: token and format
   * from the file name, size/mtime from stat(), device/mode from the current
   * system row (one printer per system, so they match how the job arrived).
   */
  private recoverJobs(): void {
    let systems: Map<SystemId, SystemRow | DirectorySystem>;
    try {
      systems = new Map(this.listSystems().map((s) => [s.id, s]));
    } catch {
      return; // no catalog yet - nothing to attribute files to
    }
    let root: fs.Dirent[];
    try {
      root = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return; // no jobs have ever been stored
    }
    for (const sysDir of root) {
      if (!sysDir.isDirectory()) continue;
      // Stored systems' jobs live under their numeric id, directory hosts'
      // under "dir:<entry id>". The directory has not synced yet at boot, so
      // a directory host's jobs recover with the default device/mode - being
      // indexed (and therefore swept) matters more than the metadata.
      const asNumber = Number(sysDir.name);
      const systemId: SystemId | null = sysDir.name.startsWith('dir:')
        ? sysDir.name
        : Number.isInteger(asNumber) && asNumber > 0
          ? asNumber
          : null;
      if (systemId === null) continue;
      const system = systems.get(systemId);
      let files: fs.Dirent[];
      try {
        files = fs.readdirSync(path.join(this.root, sysDir.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of files) {
        const m = /^([0-9a-f]{32})\.(txt|pdf|pcl)$/.exec(f.name);
        if (!m || !f.isFile()) continue;
        const file = path.join(this.root, sysDir.name, f.name);
        try {
          const stat = fs.statSync(file);
          // Recovered jobs predate everything stored this boot: seq 0 sorts
          // them oldest under the newest-first list ordering.
          this.jobs.set(m[1], {
            token: m[1],
            systemId,
            device: system?.printerDeviceName ?? this.cfg.ibmPrinterDeviceName,
            mode: system?.printerMode ?? 'text',
            format: m[2] as PrintJob['format'],
            bytes: stat.size,
            pages: null,
            createdAt: stat.mtimeMs,
            seq: 0
          });
        } catch {
          /* file vanished between readdir and stat - skip */
        }
      }
    }
    if (this.jobs.size > 0) console.log(`[printer] recovered ${this.jobs.size} spool job(s) from ${this.root}`);
  }
}
