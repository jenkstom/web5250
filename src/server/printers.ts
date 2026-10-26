// Gateway-owned printer sessions and the spool job store.
//
// One Printer5250Client per system with printerEnabled: started at boot,
// reconciled whenever the admin edits the system list (edits apply live),
// reconnected with backoff by the client itself. Completed jobs go to a
// bounded store on the data volume next to the SQLite DB:
//   <data>/printjobs/<systemId>/<token>.<ext>
// keyed by an unguessable per-job token (the same trust model as the
// session tokens) and enforced by retention knobs - newest N jobs, total
// bytes per system, and a TTL sweep - mirroring the bounded-diag approach
// everywhere else in the gateway.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from './config.ts';
import type { Systems, SystemRow } from './systems.ts';
import {
  Printer5250Client,
  type PrinterMode,
  type PrinterStatus,
  type PrintJobData
} from './tn5250/printer-client.ts';

export interface PrintJob {
  /** Unguessable download key (bearer credential for this job's bytes). */
  token: string;
  systemId: number;
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
  systemId: number;
  /** Configuration signature; a change restarts the session. */
  signature: string;
  jobSeq: number;
}

export interface PrinterStateView {
  systemId: number;
  systemName: string;
  device: string;
  mode: PrinterMode;
  state: PrinterStatus;
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
  private readonly systems: Systems;
  private readonly root: string;
  private readonly running = new Map<number, RunningPrinter>();
  /** token -> job; jobs of a system kept newest-last for drop-oldest. */
  private readonly jobs = new Map<string, PrintJob>();
  private nextSeq = 1;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(cfg: Config, systems: Systems) {
    this.cfg = cfg;
    this.systems = systems;
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

  /** Reconcile running printers with the systems list (admin edits apply live). */
  sync(): void {
    const desired = new Map<number, { system: SystemRow; signature: string }>();
    for (const system of this.systems.list()) {
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

    // Stop printers whose system vanished, was disabled, or changed shape.
    for (const [id, run] of this.running) {
      const want = desired.get(id);
      if (want && want.signature === run.signature) continue;
      run.client.destroy();
      this.running.delete(id);
      console.log(`[printer] session for system ${id} stopped (${want ? 'configuration changed' : 'removed or disabled'})`);
    }

    for (const [id, { system, signature }] of desired) {
      if (this.running.has(id)) continue;
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
        maxJobBytes: Math.max(this.cfg.printjobsMaxBytes, 1024 * 1024)
      });
      const run: RunningPrinter = { client, systemId: id, signature, jobSeq: 0 };
      this.running.set(id, run);
      client.onStatus = (state, detail) => this.logStatus(run, device, state, detail);
      client.onJob = (job) => this.store(run, system, job);
      client.connect();
      console.log(
        `[printer ${device}] session starting -> ${system.host}:${system.port}` +
          ` (${system.ssl ? 'TLS' : 'telnet'}, ${system.printerMode})`
      );
    }
  }

  stopAll(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const run of this.running.values()) run.client.destroy();
    this.running.clear();
  }

  /** Per-system printer states for the UI badge / button gating. */
  status(): PrinterStateView[] {
    const out: PrinterStateView[] = [];
    for (const system of this.systems.list()) {
      if (!system.printerEnabled) continue;
      const run = this.running.get(system.id);
      out.push({
        systemId: system.id,
        systemName: system.name,
        device: system.printerDeviceName ?? this.cfg.ibmPrinterDeviceName,
        mode: system.printerMode,
        state: run?.client.status ?? 'connecting',
        detail: run?.client.statusDetail
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

  private store(run: RunningPrinter, system: SystemRow, job: PrintJobData): void {
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
  private enforceRetention(systemId: number): void {
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
    let systems: Map<number, SystemRow>;
    try {
      systems = new Map(this.systems.list().map((s) => [s.id, s]));
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
      const systemId = Number(sysDir.name);
      if (!Number.isInteger(systemId)) continue;
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
