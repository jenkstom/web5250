// Directory service client: menu entries + sign-on credentials served by a
// small microservice that fronts an existing database of hosts and accounts
// (see docs/directory-service.md and docs/directory-service-openapi.yaml).
//
// The gateway never touches the database itself. Two calls are all it uses:
//
//   GET /v1/entries                     -> the menu list (no credentials)
//   GET /v1/entries/{id}/credentials    -> username/password, at session start
//
// The list is materialized into the systems catalog on a timer: every entry
// becomes a menu row whose connection settings come from the DIRECTORY_TEMPLATE_*
// environment (proxy, code page, terminal model, printer, ...) with the entry
// supplying identity and reachability. Rows keep their id across syncs, so
// live sessions, printer devices and deep links survive; entries that
// disappear from the directory are removed. Manual (admin-created) rows are
// never touched and always list before the directory rows.
//
// Credentials are never persisted: they are fetched when a session starts,
// held in memory for the sign-on automation, and typed straight into the
// host's QDSIGNON screen through the same path ?auto=1 uses. Nothing reaches
// the browser (non-display fields are blanked server-side, as always).
import * as http from 'node:http';
import * as https from 'node:https';
import type { Config } from './config.ts';
import type { Systems, SystemInput } from './systems.ts';
import { validateSystemInput } from './systems.ts';
import type { Audit } from './audit.ts';

/** One row of GET /v1/entries - everything except the credential. */
export interface DirectoryEntry {
  id: string;
  name: string;
  description: string;
  host: string;
  port: number | null;
  ssl: boolean | null;
  /** True when the directory holds a sign-on credential for this entry. */
  autoSignOn: boolean;
}

export interface DirectoryCredentials {
  username: string;
  password: string;
}

const REF_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const NAME_SUB = /\{(name|host|description)\}/gi;

export interface DirectoryHooks {
  audit?: Audit;
  /** Fires after a sync changed the systems list (printer reconciliation). */
  onSystemsChanged: () => void;
}

export class Directory {
  private timer: NodeJS.Timeout | null = null;
  private syncing = false;
  /** State of the last sync (console/API surface; never credentials). */
  lastSyncAt: number | null = null;
  lastError: string | null = null;
  lastCounts: { added: number; updated: number; removed: number; total: number } | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly systems: Systems,
    private readonly hooks: DirectoryHooks
  ) {}

  get enabled(): boolean {
    return this.cfg.directoryUrl !== null;
  }

  /** Console/API view of the directory integration (no secrets). */
  statusView(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      url: this.cfg.directoryUrl,
      syncIntervalMs: this.cfg.directorySyncMs,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      lastCounts: this.lastCounts
    };
  }

  /** First sync (best effort) + the re-sync timer. No-op when unconfigured. */
  start(): void {
    if (!this.enabled || this.timer) return;
    void this.syncNow();
    this.timer = setInterval(() => void this.syncNow(), this.cfg.directorySyncMs);
    this.timer.unref();
    console.log(
      `[directory] enabled: ${this.cfg.directoryUrl} (sync every ${Math.round(this.cfg.directorySyncMs / 1000)}s)`
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One reconciliation pass; failures are logged/audited, never thrown. */
  async syncNow(): Promise<void> {
    if (!this.enabled || this.syncing) return;
    this.syncing = true;
    try {
      const list = await this.getList();
      const inputs: { ref: string; autoSignOn: boolean; input: SystemInput }[] = [];
      const skipped: string[] = [];
      for (const entry of list) {
        const input = materialize(entry, this.cfg);
        if (!input) {
          skipped.push(entry.id || '(no id)');
          continue;
        }
        inputs.push({ ref: entry.id, autoSignOn: entry.autoSignOn, input });
      }
      const changed = this.systems.syncDirectory(inputs);
      this.lastSyncAt = Date.now();
      this.lastError = null;
      this.lastCounts = { ...changed, total: inputs.length };
      if (changed.added || changed.updated || changed.removed) {
        this.hooks.onSystemsChanged();
        const summary = `+${changed.added} ~${changed.updated} -${changed.removed} of ${inputs.length}`;
        console.log(`[directory] sync: ${summary} system(s)`);
        this.hooks.audit?.log('directory', 'directory.sync', hostOf(this.cfg.directoryUrl!), summary);
      }
      if (skipped.length > 0) {
        const detail = `invalid entries skipped: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '…' : ''}`;
        console.warn(`[directory] ${detail}`);
        this.hooks.audit?.log('directory', 'directory.error', '', detail);
      }
    } catch (e) {
      const detail = String((e as Error).message ?? e);
      this.lastSyncAt = Date.now();
      this.lastError = detail;
      console.warn(`[directory] sync failed: ${detail}`);
      this.hooks.audit?.log('directory', 'directory.error', '', `sync failed: ${detail}`);
    } finally {
      this.syncing = false;
    }
  }

  /**
   * The sign-on credential for one entry, fetched at session start. Returns
   * null when the directory definitively holds no credential for the entry
   * (404/204): the session then opens on the manual sign-on screen. Network
   * and server errors throw - the caller decides how to surface them.
   */
  async credentials(ref: string): Promise<DirectoryCredentials | null> {
    const body = await this.getJson(`/v1/entries/${encodeURIComponent(ref)}/credentials`);
    if (body === null) return null;
    const username = String((body as { username?: unknown })?.username ?? '').trim();
    const password = String((body as { password?: unknown })?.password ?? '');
    if (!username || !password) {
      throw new Error(`credentials for "${ref}" are missing username or password`);
    }
    // IBM i user profiles are 10 chars; passwords cap at 128 in the sign-on
    // field. Longer values can only be directory-side mistakes.
    if (username.length > 10) {
      throw new Error(`username for "${ref}" exceeds 10 characters`);
    }
    return { username: username.toUpperCase(), password: password.slice(0, 128) };
  }

  // ------------------------------------------------------------- internals
  private async getList(): Promise<DirectoryEntry[]> {
    const body = await this.getJson('/v1/entries');
    const arr = (body as { entries?: unknown })?.entries;
    if (!Array.isArray(arr)) throw new Error('response is not { entries: [...] }');
    const out: DirectoryEntry[] = [];
    for (const raw of arr) {
      const entry = parseEntry(raw);
      if (entry) out.push(entry);
    }
    return out;
  }

  /** GET one JSON document from the directory service (null on 404/204). */
  private async getJson(path: string): Promise<unknown | null> {
    const base = this.cfg.directoryUrl!;
    const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
    return new Promise((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(
        url,
        {
          method: 'GET',
          timeout: this.cfg.directoryTimeoutMs,
          headers: {
            accept: 'application/json',
            ...(this.cfg.directoryToken ? { authorization: `Bearer ${this.cfg.directoryToken}` } : {})
          },
          ...(url.protocol === 'https:' && !this.cfg.directoryTlsRejectUnauthorized
            ? { rejectUnauthorized: false }
            : {})
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status === 404 || status === 204) {
            res.resume();
            resolve(null);
            return;
          }
          if (status !== 200) {
            res.resume();
            reject(new Error(`HTTP ${status} from the directory service`));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > 4 * 1024 * 1024) {
              req.destroy();
              reject(new Error('directory response too large'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
              reject(new Error('directory response is not valid JSON'));
            }
          });
          res.on('error', (e) => reject(e));
        }
      );
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`directory request timed out (${this.cfg.directoryTimeoutMs} ms)`));
      });
      req.on('error', (e) => reject(e));
      req.end();
    });
  }
}

/** Lenient parse of one list row; null when the entry is unusable. */
function parseEntry(raw: unknown): DirectoryEntry | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = String(r.id ?? '').trim();
  if (!REF_RE.test(id)) return null;
  const host = String(r.host ?? '').trim().slice(0, 253);
  if (!host) return null;
  const name = String(r.name ?? '').trim().slice(0, 40) || host;
  const description = String(r.description ?? '').trim().slice(0, 120);
  const port =
    r.port === undefined || r.port === null || r.port === ''
      ? null
      : Number.parseInt(String(r.port), 10);
  const ssl =
    r.ssl === undefined || r.ssl === null || r.ssl === ''
      ? null
      : r.ssl === true || r.ssl === 'true' || r.ssl === 1 || r.ssl === '1';
  return {
    id,
    name,
    description,
    host,
    port: port !== null && Number.isFinite(port) && port >= 1 && port <= 65535 ? port : null,
    ssl,
    autoSignOn: r.autoSignOn === true || r.autoSignOn === 'true' || r.autoSignOn === 1
  };
}

/**
 * Template + entry -> a validated SystemInput, or null when the combination
 * fails validation (the sync skips such entries and says so). {name}, {host}
 * and {description} in the name/description patterns substitute the entry's
 * values; an empty description pattern falls back to the entry's own.
 */
export function materialize(entry: DirectoryEntry, cfg: Config): SystemInput | null {
  const t = cfg.directoryTemplate;
  const sub = (pattern: string): string =>
    pattern.replace(NAME_SUB, (m) => {
      const key = m.toLowerCase();
      if (key === '{host}') return entry.host;
      if (key === '{description}') return entry.description;
      return entry.name;
    });
  const v = validateSystemInput(
    {
      name: sub(t.name),
      description: sub(t.description) || entry.description,
      host: entry.host,
      port: entry.port ?? t.port,
      ssl: entry.ssl ?? t.ssl,
      termType: t.termType,
      codePage: t.codePage,
      devPrefix: t.devPrefix ?? '',
      proxyHost: t.proxyHost ?? '',
      proxyPort: t.proxyPort,
      proxyUser: t.proxyUser ?? '',
      proxyPass: t.proxyPass ?? '',
      printerEnabled: t.printerEnabled,
      printerDeviceName: t.printerEnabled ? (t.printerDeviceName ?? '') : '',
      printerMode: t.printerMode,
      recording: t.recording
    },
    cfg
  );
  return v.ok ? v.value! : null;
}

/** Host part of a URL, for audit lines (never the token - it is not in it). */
function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url;
  }
}
