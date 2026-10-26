// Session recording store: JSONL event logs on the data volume plus SQLite
// metadata and revocable replay tokens.
//
// A recording captures exactly the wire stream a view-only mirror would have
// received - full 'screen' snapshots (which double as seek points, one per
// structure change, i.e. roughly one per host screen) followed by batched
// cell diffs, OIA states, named keys with their origin, statuses and assist
// lifecycle. Non-display (password) cells are blanked by the wire encoder
// *before* the recorder sees them, so a replay never contains a secret.
//
// Retention mirrors the print-job store: newest N recordings, total bytes,
// and a TTL, drop-oldest, swept periodically. Live recordings (no endedAt
// yet) are never swept - their writer still owns the file.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from './config.ts';

export interface RecordingMeta {
  id: string;
  systemId: number;
  systemName: string;
  devName: string | null;
  identity: string | null;
  signedOnUser: string | null;
  startedAt: number;
  endedAt: number | null;
  bytes: number;
  frames: number;
}

interface RecRow {
  id: string;
  system_id: number;
  system_name: string;
  dev_name: string | null;
  identity: string | null;
  signed_on_user: string | null;
  started_at: number;
  ended_at: number | null;
  bytes: number;
  frames: number;
  seq: number;
}

const mapRow = (r: RecRow): RecordingMeta => ({
  id: r.id,
  systemId: Number(r.system_id),
  systemName: r.system_name,
  devName: r.dev_name ?? null,
  identity: r.identity ?? null,
  signedOnUser: r.signed_on_user ?? null,
  startedAt: Number(r.started_at),
  endedAt: r.ended_at === null || r.ended_at === undefined ? null : Number(r.ended_at),
  bytes: Number(r.bytes),
  frames: Number(r.frames)
});

export class Recordings {
  private readonly db: DatabaseSync;
  private readonly root: string;
  private readonly cfg: Config;
  private sweepTimer: NodeJS.Timeout | null = null;
  private nextSeq = 1;

  constructor(cfg: Config) {
    this.cfg = cfg;
    const dir = path.dirname(cfg.dbPath === ':memory:' ? 'data/x' : cfg.dbPath);
    this.root = path.join(dir, 'recordings');
    fs.mkdirSync(this.root, { recursive: true });
    this.db = new DatabaseSync(cfg.dbPath === ':memory:' ? ':memory:' : cfg.dbPath);
    // No journal_mode pragma here (see Audit): Systems owns the WAL mode.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recordings (
        id              TEXT PRIMARY KEY,
        system_id       INTEGER NOT NULL,
        system_name     TEXT NOT NULL,
        dev_name        TEXT,
        identity        TEXT,
        signed_on_user  TEXT,
        started_at      INTEGER NOT NULL,
        ended_at        INTEGER,
        bytes           INTEGER NOT NULL DEFAULT 0,
        frames          INTEGER NOT NULL DEFAULT 0,
        seq             INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS replay_tokens (
        token        TEXT PRIMARY KEY,
        recording_id TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        by           TEXT NOT NULL
      )
    `);
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM recordings').get() as unknown as {
      m: number;
    };
    this.nextSeq = Number(row.m) + 1;
  }

  start(): void {
    this.sweepTimer = setInterval(() => this.sweep(), 15 * 60 * 1000);
    this.sweepTimer.unref();
  }

  fileFor(id: string): string {
    return path.join(this.root, `${id}.jsonl`);
  }

  /** Open a live recording; the Recorder finalizes it on session end. */
  createRecorder(meta: {
    systemId: number;
    systemName: string;
    devName: string | null;
    identity: string | null;
  }): Recorder {
    const id = randomBytes(16).toString('hex');
    const seq = this.nextSeq++;
    this.db
      .prepare(
        `INSERT INTO recordings (id, system_id, system_name, dev_name, identity, signed_on_user,
         started_at, ended_at, bytes, frames, seq) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, 0, 0, ?)`
      )
      .run(id, meta.systemId, meta.systemName, meta.devName, meta.identity, Date.now(), seq);
    return new Recorder(this, id, this.fileFor(id));
  }

  /** Writer accounting: bytes/frames as the file grows (throttled by caller). */
  noteProgress(id: string, bytes: number, frames: number): void {
    this.db.prepare('UPDATE recordings SET bytes = ?, frames = ? WHERE id = ?').run(bytes, frames, id);
  }

  /** Live metadata patch: the IBM i user profile, captured after sign-on. */
  noteSignedOnUser(id: string, user: string): void {
    this.db
      .prepare('UPDATE recordings SET signed_on_user = ? WHERE id = ? AND ended_at IS NULL')
      .run(user, id);
  }

  finish(id: string, bytes: number, frames: number): void {
    this.db
      .prepare('UPDATE recordings SET ended_at = ?, bytes = ?, frames = ? WHERE id = ?')
      .run(Date.now(), bytes, frames, id);
  }

  get(id: string): RecordingMeta | null {
    const row = this.db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as unknown as RecRow | undefined;
    return row ? mapRow(row) : null;
  }

  list(): RecordingMeta[] {
    const rows = this.db
      .prepare('SELECT * FROM recordings ORDER BY seq DESC, started_at DESC')
      .all() as unknown as RecRow[];
    return rows.map(mapRow);
  }

  /** Read a finished (or crashed-then-swept-in) recording's frames as text. */
  framesOf(id: string): string | null {
    try {
      return fs.readFileSync(this.fileFor(id), 'utf8');
    } catch {
      return null;
    }
  }

  /** Mint an unguessable bearer token for watching one recording's replay. */
  mintToken(id: string, by: string): string | null {
    if (!this.get(id)) return null;
    const token = randomBytes(16).toString('hex');
    this.db
      .prepare('INSERT INTO replay_tokens (token, recording_id, created_at, by) VALUES (?, ?, ?, ?)')
      .run(token, id, Date.now(), by.slice(0, 120));
    return token;
  }

  resolveToken(token: string): RecordingMeta | null {
    const row = this.db
      .prepare('SELECT recording_id FROM replay_tokens WHERE token = ?')
      .get(token) as unknown as { recording_id: string } | undefined;
    if (!row) return null;
    const meta = this.get(row.recording_id);
    // A token outliving its retention-swept recording is worthless; drop it.
    if (!meta) {
      this.revokeToken(token);
      return null;
    }
    return meta;
  }

  revokeToken(token: string): boolean {
    const res = this.db.prepare('DELETE FROM replay_tokens WHERE token = ?').run(token);
    return Number(res.changes) > 0;
  }

  /**
   * Console removal: file, metadata row and every replay token die together.
   * A still-live recording must be stopped at its session first (see
   * HostSession.stopRecording) so the writer lets go before the file does.
   */
  delete(id: string): RecordingMeta | null {
    const meta = this.get(id);
    if (!meta) return null;
    try {
      fs.rmSync(this.fileFor(id), { force: true });
    } catch {
      /* a missing file is already gone */
    }
    this.db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM replay_tokens WHERE recording_id = ?').run(id);
    return meta;
  }

  /** Drop-oldest retention: count, bytes, TTL. Live recordings are exempt. */
  private sweep(): void {
    const rows = this.db
      .prepare('SELECT * FROM recordings WHERE ended_at IS NOT NULL ORDER BY seq DESC')
      .all() as unknown as RecRow[];
    let total = 0;
    const doomed = new Set<string>();
    const ttlCutoff = Date.now() - this.cfg.recordingsTtlMs;
    rows.forEach((r, idx) => {
      total += Number(r.bytes);
      const expired =
        idx >= this.cfg.recordingsMaxCount || total > this.cfg.recordingsMaxBytes || Number(r.ended_at) < ttlCutoff;
      if (expired) {
        doomed.add(r.id);
        total -= Number(r.bytes);
      }
    });
    for (const id of doomed) this.delete(id);
    if (doomed.size > 0) console.log(`[recording] retention sweep removed ${doomed.size} recording(s)`);
  }
}

/**
 * The pseudo-front-end: everything the broadcast loop would send a viewer is
 * serialized here instead, one JSON frame per line. A recording starts and
 * ends with the owner's REC control (or console removal); every frame it
 * writes is real captured traffic.
 */
export class Recorder {
  private closed = false;
  private frames = 0;
  private bytes = 0;
  private lastCursorKey = '[]';
  private lastOia = '';
  private readonly stream: fs.WriteStream;

  constructor(
    private readonly store: Recordings,
    private readonly id: string,
    file: string
  ) {
    this.stream = fs.createWriteStream(file, { flags: 'ax' });
    this.stream.on('error', (e) => console.error(`[recording] write failed: ${String(e)}`));
  }

  /** The metadata row this writer feeds — lets the console find its session. */
  get recordingId(): string {
    return this.id;
  }

  setSignedOnUser(user: string): void {
    this.store.noteSignedOnUser(this.id, user);
  }

  /** Full screen state - the frame a player can seek to. */
  snapshot(payload: Record<string, unknown>): void {
    if (this.closed) return;
    this.lastCursorKey = JSON.stringify(payload.cursor ?? null); // snapshots carry the cursor
    this.write({ t: 'screen', ...payload });
  }

  delta(payload: Record<string, unknown>, cursor: [number, number] | null): void {
    if (this.closed) return;
    const key = JSON.stringify(cursor);
    if (key !== this.lastCursorKey) {
      this.lastCursorKey = key;
      (payload as { cursor?: unknown }).cursor = cursor;
    }
    this.write({ t: 'update', ...payload });
  }

  oia(oia: Record<string, unknown>): void {
    if (this.closed) return;
    const key = JSON.stringify(oia);
    if (key === this.lastOia) return;
    this.lastOia = key;
    this.write({ t: 'oia', ...oia });
  }

  /** status | key | notice | ctrl lifecycle events. */
  event(kind: string, body: Record<string, unknown>): void {
    if (this.closed) return;
    this.write({ t: kind, ...body });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream.end(() => this.store.finish(this.id, this.bytes, this.frames));
  }

  private write(frame: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: Date.now(), ...frame }) + '\n';
    this.frames++;
    this.bytes += Buffer.byteLength(line);
    this.stream.write(line);
    // Metadata follows the file lazily - a hard crash loses at most a minute
    // of accounting, and the sweep recomputes nothing it does not need.
    if (this.frames % 200 === 0) this.store.noteProgress(this.id, this.bytes, this.frames);
  }
}
