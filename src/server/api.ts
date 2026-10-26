// JSON HTTP API for the connection menu, its admin editor, the spool, the
// session console and the recording store.
//
//   GET    /api/meta                        admin enabled?, form options/defaults
//   GET    /api/systems                     menu list (public: the menu needs it)
//   GET    /api/printer-status              per-system printer session states
//   GET    /api/printjobs                   spool jobs, newest first (public)
//   GET    /api/printjobs/<token>           job download (unguessable token)
//   DELETE /api/printjobs/<token>           delete job (public, audited)
//   POST   /api/admin/auth                  {pin} -> {token}
//   GET    /api/admin/systems               full rows incl. proxy (Bearer token)
//   POST   /api/admin/systems               create          (Bearer token)
//   PUT    /api/admin/systems/<id>          update           (Bearer token)
//   DELETE /api/admin/systems/<id>          delete           (Bearer token)
//   POST   /api/admin/systems/<id>/move     {dir: up|down}   (Bearer token)
//   GET    /api/admin/config                export all systems as a JSON file
//   PUT    /api/admin/config                import a JSON file, replacing all
//   GET    /api/admin/sessions              live session list  (Bearer token)
//   POST   /api/admin/sessions/<id>/view    mint a mirror link (Bearer token)
//   POST   /api/admin/sessions/<id>/signal  banner to a session (Bearer token)
//   POST   /api/admin/sessions/<id>/end     end a session now (Bearer token)
//   POST   /api/admin/systems/<id>/maintenance  window on/off  (Bearer token)
//   POST   /api/admin/maintenance           gateway-wide window (Bearer token)
//   GET    /api/admin/maintenance           current windows    (Bearer token)
//   GET    /api/admin/audit                 recent audit trail (Bearer token)
//   GET    /api/admin/recordings            recording metadata (Bearer token)
//   GET    /api/admin/recordings/<id>/download  JSONL download (Bearer token)
//   POST   /api/admin/recordings/<id>/link  mint a replay link (Bearer token)
//   DELETE /api/admin/recordings/<id>       delete a recording (Bearer token)
//   DELETE /api/admin/replay/<token>        revoke a replay link (Bearer token)
//   GET    /api/recordings/mine             own recordings (TRUSTED_USER_HEADER)
//   POST   /api/replay/mint                 mint own replay link (same header)
//   GET    /api/replay/<token>              one recording + its frames (token)
//
// Routes match by path suffix so the app keeps working behind a reverse proxy
// path-based rules (/as400/api/... etc), mirroring /healthz handling. Admin
// tokens are random, kept in memory, and expire after 8 hours; PIN attempts
// are hashed and compared in constant time, with a temporary lockout after
// repeated failures. Identity itself is enforced by Pangolin at the edge —
// this PIN gates host-list administration and the console.
//
// Proxy credentials (and the proxy's location - internal infrastructure)
// appear only on the authenticated admin routes; the public menu list gets a
// `viaProxy` flag and nothing more. The printer device name follows the same
// policy on system rows; print jobs and replays themselves are keyed by
// unguessable per-object tokens (the session-token trust model) and never
// contain credentials.
import * as fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TERM_TYPES } from './tn5250/constants.ts';
import { Ebcdic } from './tn5250/ebcdic.ts';
import type { Config } from './config.ts';
import type { Systems, SystemRow } from './systems.ts';
import type { Printers } from './printers.ts';
import type { Audit } from './audit.ts';
import type { Maintenance } from './maintenance.ts';
import type { Recordings } from './recordings.ts';
import type { AdminAuth } from './admin-auth.ts';
import { allSessions, getSessionByConsoleId } from './sessions.ts';

const MAX_BODY_BYTES = 32 * 1024;
/** Import uploads carry every system row; 512 KB is ~1000 of them. */
const MAX_IMPORT_BYTES = 512 * 1024;

export type ApiHandler = (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean;

interface Route {
  method: string;
  re: RegExp;
  auth: boolean;
  run: (ctx: {
    cfg: Config;
    systems: Systems;
    deps: ApiDeps;
    req: IncomingMessage;
    res: ServerResponse;
    match: RegExpMatchArray;
    body: unknown;
  }) => void;
}

export interface ApiDeps {
  printers: Printers;
  audit: Audit;
  maintenance: Maintenance;
  recordings: Recordings;
  adminAuth: AdminAuth;
  /** Fires after any admin mutation that changed the systems list. */
  onSystemsChanged: () => void;
}

export function createApiHandler(cfg: Config, systems: Systems, deps: ApiDeps): ApiHandler {
  const authorized = (req: IncomingMessage): boolean =>
    deps.adminAuth.authorized(req.headers.authorization as string | undefined);

  /** Edge-injected identity (TRUSTED_USER_HEADER), when configured. */
  const identityOf = (req: IncomingMessage): string | null => {
    if (!cfg.trustedUserHeader) return null;
    const v = req.headers[cfg.trustedUserHeader];
    const s = Array.isArray(v) ? v[0] : v;
    const clean = String(s ?? '').trim().slice(0, 80);
    return clean || null;
  };
  /** Audit actor for an admin-route call: the console user's edge identity. */
  const actor = (req: IncomingMessage): string => identityOf(req) ?? 'admin';

  /** Menu-safe projection: no proxy or printer-infrastructure details. */
  const publicSystem = (s: SystemRow): Record<string, unknown> => {
    const {
      proxyHost, proxyPort, proxyUser, proxyPass, printerDeviceName, ...pub
    } = s;
    return { ...pub, viaProxy: Boolean(proxyHost), maintenance: deps.maintenance.maintenanceOf(s.id) };
  };

  /** System id/name pairs for stamping job rows (jobs keep arriving after
   * their system row is gone, so fall back to the stored device). */
  const systemNames = (): Map<number, string> =>
    new Map(systems.list().map((s) => [s.id, s.name]));

  const routes: Route[] = [
    {
      method: 'GET',
      re: /(?:^|\/)api\/meta\/?$/,
      auth: false,
      run: ({ res }) => {
        json(res, 200, {
          adminEnabled: cfg.adminPin !== null,
          allowCustomHost: cfg.allowCustomHost,
          showDiagButton: cfg.showDiagButton,
          assistEnabled: cfg.assistEnabled,
          breakglass: cfg.adminAssistBreakglass,
          identityHeader: cfg.trustedUserHeader !== null,
          termTypes: TERM_TYPES,
          codePages: Ebcdic.availablePages(),
          defaults: {
            port: 23,
            ssl: cfg.ibmSsl,
            termType: cfg.termType,
            codePage: cfg.codePage,
            devPrefix: cfg.devPrefix ?? ''
          }
        });
      }
    },
    {
      method: 'GET',
      re: /(?:^|\/)api\/systems\/?$/,
      auth: false,
      run: ({ systems, res }) =>
        json(res, 200, { systems: systems.list().map(publicSystem) })
    },
    {
      method: 'GET',
      re: /(?:^|\/)api\/printer-status\/?$/,
      auth: false,
      run: ({ res, deps }) => json(res, 200, { printers: deps.printers.status() })
    },
    {
      method: 'GET',
      re: /(?:^|\/)api\/printjobs\/?$/,
      auth: false,
      run: ({ res, deps }) => {
        const names = systemNames();
        json(res, 200, {
          jobs: deps.printers.listJobs().map((j) => ({
            ...j,
            systemName: names.get(j.systemId) ?? null
          }))
        });
      }
    },
    {
      method: 'GET',
      re: /(?:^|\/)api\/printjobs\/([0-9a-f]{32})\/?$/,
      auth: false,
      run: ({ res, deps, match }) => {
        const found = deps.printers.jobFile(match[1]);
        if (!found) {
          json(res, 404, { error: 'no such print job (it may have been cleaned up)' });
          return;
        }
        const { job, file, contentType } = found;
        const stamp = new Date(job.createdAt);
        const p2 = (n: number): string => String(n).padStart(2, '0');
        const name =
          `spool-${job.device}-${stamp.getFullYear()}${p2(stamp.getMonth() + 1)}${p2(stamp.getDate())}` +
          `-${p2(stamp.getHours())}${p2(stamp.getMinutes())}${p2(stamp.getSeconds())}.${job.format}`;
        res.writeHead(200, {
          'content-type': contentType,
          'content-length': String(job.bytes),
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="${name}"`
        });
        fs.createReadStream(file).pipe(res);
      }
    },
    {
      method: 'DELETE',
      re: /(?:^|\/)api\/printjobs\/([0-9a-f]{32})\/?$/,
      auth: false,
      run: ({ res, req, deps, match }) => {
        // Removal is a spool-viewer action: the list (and every job on it)
        // is already readable by every gateway user, so delete follows the
        // same visibility. Logged so console users can see who removed what.
        const found = deps.printers.jobFile(match[1]);
        if (!found || !deps.printers.deleteJob(match[1])) {
          json(res, 404, { error: 'no such job' });
          return;
        }
        deps.audit.log(
          identityOf(req) ?? 'user',
          'spool.delete',
          found.job.device,
          `${found.job.bytes} bytes · ${found.job.format}`
        );
        json(res, 200, { ok: true });
      }
    },
    {
      method: 'POST',
      re: /(?:^|\/)api\/admin\/auth\/?$/,
      auth: false,
      run: ({ res, body, deps }) => {
        const pin = String((body as { pin?: unknown })?.pin ?? '');
        const result = deps.adminAuth.signIn(pin);
        if (!result.ok) {
          json(res, result.error.startsWith('Too many') ? 429 : 401, { error: result.error });
          return;
        }
        json(res, 200, { token: result.token, expiresInMs: result.expiresInMs });
      }
    },
    {
      method: 'GET',
      re: /(?:^|\/)api\/admin\/systems\/?$/,
      auth: true,
      run: ({ systems, res }) => json(res, 200, { systems: systems.list() })
    },
    {
      method: 'POST',
      re: /(?:^|\/)api\/admin\/systems\/?$/,
      auth: true,
      run: ({ systems, cfg, deps, res, body }) => {
        const result = systems.create(body, cfg);
        if (!result.ok) json(res, 400, { error: result.error });
        else {
          deps.onSystemsChanged();
          json(res, 201, { system: publicSystem(result.row) });
        }
      }
    },
    {
      method: 'PUT',
      re: /(?:^|\/)api\/admin\/systems\/(\d+)\/?$/,
      auth: true,
      run: ({ systems, cfg, deps, res, match, body }) => {
        const result = systems.update(Number(match[1]), body, cfg);
        if (!result.ok) json(res, result.error === 'System not found' ? 404 : 400, { error: result.error });
        else {
          deps.onSystemsChanged();
          json(res, 200, { system: publicSystem(result.row) });
        }
      }
    },
    {
      method: 'DELETE',
      re: /(?:^|\/)api\/admin\/systems\/(\d+)\/?$/,
      auth: true,
      run: ({ systems, deps, res, match }) => {
        const ok = systems.remove(Number(match[1]));
        if (ok) deps.onSystemsChanged();
        json(res, ok ? 200 : 404, { ok: true });
      }
    },
    {
      method: 'POST',
      re: /(?:^|\/)api\/admin\/systems\/(\d+)\/move\/?$/,
      auth: true,
      run: ({ systems, res, match, body }) => {
        const dir = String((body as { dir?: unknown })?.dir ?? '');
        json(res, systems.move(Number(match[1]), dir) ? 200 : 404, { ok: true });
      }
    },
    {
      // Export: the full catalog as a download document (ids/positions are
      // re-assigned on import; the array order is the menu order).
      method: 'GET',
      re: /(?:^|\/)api\/admin\/config\/?$/,
      auth: true,
      run: ({ systems, res }) => {
        const stamp = new Date();
        const p2 = (n: number): string => String(n).padStart(2, '0');
        const name =
          `web5250-systems-${stamp.getFullYear()}${p2(stamp.getMonth() + 1)}${p2(stamp.getDate())}` +
          `-${p2(stamp.getHours())}${p2(stamp.getMinutes())}${p2(stamp.getSeconds())}.json`;
        res.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="${name}"`
        });
        res.end(
          JSON.stringify(
            {
              kind: 'web5250-systems',
              version: 1,
              exportedAt: stamp.toISOString(),
              systems: systems.list().map(({ id: _id, position: _pos, ...system }) => system)
            },
            null,
            2
          )
        );
      }
    },
    {
      // Import: replace the whole catalog (auth-gated like every mutation).
      method: 'PUT',
      re: /(?:^|\/)api\/admin\/config\/?$/,
      auth: true,
      run: ({ systems, cfg, deps, res, body }) => {
        const result = systems.replaceAll(body, cfg);
        if (!result.ok) {
          json(res, 400, { error: result.error });
          return;
        }
        deps.onSystemsChanged();
        json(res, 200, {
          ok: true,
          count: result.rows.length,
          systems: result.rows.map(publicSystem)
        });
      }
    },
    {
      // ------------------------------------------------ session console
      method: 'GET',
      re: /(?:^|\/)api\/admin\/sessions\/?$/,
      auth: true,
      run: ({ res }) => {
        json(res, 200, { sessions: allSessions().map((s) => s.consoleView()) });
      }
    },
    {
      // Mint a mirror link for the admin's browser. The share token is
      // issued per action, never listed - the console sees sessions without
      // holding their credentials by default.
      method: 'POST',
      re: /(?:^|\/)api\/admin\/sessions\/([0-9a-f]+)\/view\/?$/,
      auth: true,
      run: ({ res, req, deps, match }) => {
        const core = getSessionByConsoleId(match[1]);
        if (!core || core.isDestroyed) {
          json(res, 404, { error: 'no such session' });
          return;
        }
        deps.audit.log(actor(req), 'session.view', core.devName ?? '', core.identity ?? '');
        json(res, 200, { shareToken: core.shareToken, systemId: core.systemId ?? null });
      }
    },
    {
      method: 'POST',
      re: /(?:^|\/)api\/admin\/sessions\/([0-9a-f]+)\/signal\/?$/,
      auth: true,
      run: ({ res, req, deps, match, body }) => {
        const core = getSessionByConsoleId(match[1]);
        if (!core || core.isDestroyed) {
          json(res, 404, { error: 'no such session' });
          return;
        }
        const message = String((body as { message?: unknown })?.message ?? '').slice(0, 300).trim();
        if (!message) {
          json(res, 400, { error: 'message is required' });
          return;
        }
        const level = String((body as { level?: unknown })?.level ?? 'info');
        core.notifyAll(level === 'warn' || level === 'urgent' ? level : 'info', message);
        deps.audit.log(actor(req), 'session.signal', core.devName ?? '', message);
        json(res, 200, { ok: true });
      }
    },
    {
      // Hard end: same path as the pane × button - releases the device and
      // the user's message queue immediately. An optional notice is shown
      // for a moment first when the caller asks for it.
      method: 'POST',
      re: /(?:^|\/)api\/admin\/sessions\/([0-9a-f]+)\/end\/?$/,
      auth: true,
      run: ({ res, req, deps, match, body }) => {
        const core = getSessionByConsoleId(match[1]);
        if (!core || core.isDestroyed) {
          json(res, 404, { error: 'no such session' });
          return;
        }
        const notice = String((body as { notice?: unknown })?.notice ?? '').slice(0, 300).trim();
        deps.audit.log(
          actor(req),
          'session.end',
          core.devName ?? '',
          `${core.identity ?? core.signedOnUser ?? ''}${notice ? ` — ${notice}` : ''}`.trim()
        );
        if (notice) {
          core.notifyAll('urgent', notice);
          setTimeout(() => core.end(), 1500);
        } else {
          core.end();
        }
        json(res, 200, { ok: true });
      }
    },
    {
      method: 'POST',
      re: /(?:^|\/)api\/admin\/systems\/(\d+)\/maintenance\/?$/,
      auth: true,
      run: ({ res, req, deps, match, body }) => {
        const b = body as { on?: unknown; message?: unknown; deadlineMs?: unknown };
        const view = deps.maintenance.set(
          Number(match[1]),
          b.on === true,
          String(b.message ?? '').slice(0, 200).trim(),
          Number.isFinite(Number(b.deadlineMs)) && Number(b.deadlineMs) > 0 ? Number(b.deadlineMs) : null
        );
        json(res, 200, { maintenance: view });
      }
    },
    {
      method: 'POST',
      re: /(?:^|\/)api\/admin\/maintenance\/?$/,
      auth: true,
      run: ({ res, req, deps, body }) => {
        const b = body as { on?: unknown; message?: unknown; deadlineMs?: unknown };
        const view = deps.maintenance.set(
          null,
          b.on === true,
          String(b.message ?? '').slice(0, 200).trim(),
          Number.isFinite(Number(b.deadlineMs)) && Number(b.deadlineMs) > 0 ? Number(b.deadlineMs) : null
        );
        json(res, 200, { maintenance: view });
      }
    },
    {
      method: 'GET',
      re: /(?:^|\/)api\/admin\/maintenance\/?$/,
      auth: true,
      run: ({ res, deps }) => json(res, 200, deps.maintenance.status())
    },
    {
      method: 'GET',
      re: /(?:^|\/)api\/admin\/audit\/?$/,
      auth: true,
      run: ({ res, req, deps }) => {
        const url = new URL(req.url ?? '/', 'http://internal');
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
        const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);
        json(res, 200, {
          entries: deps.audit.list({
            limit: Number.isFinite(limit) ? limit : 100,
            offset: Number.isFinite(offset) ? offset : 0
          }),
          total: deps.audit.count()
        });
      }
    },
    {
      // ------------------------------------------------------ recordings
      method: 'GET',
      re: /(?:^|\/)api\/admin\/recordings\/?$/,
      auth: true,
      run: ({ res, deps }) => json(res, 200, { recordings: deps.recordings.list() })
    },
    {
      method: 'GET',
      re: /(?:^|\/)api\/admin\/recordings\/([0-9a-f]+)\/download\/?$/,
      auth: true,
      run: ({ res, req, deps, match }) => {
        const meta = deps.recordings.get(match[1]);
        if (!meta) {
          json(res, 404, { error: 'no such recording' });
          return;
        }
        const file = deps.recordings.framesOf(meta.id);
        if (file === null) {
          json(res, 404, { error: 'recording file is missing (retention may have removed it)' });
          return;
        }
        deps.audit.log(actor(req), 'recording.download', meta.id.slice(0, 8), meta.devName ?? '');
        const stamp = new Date(meta.startedAt);
        const p2 = (n: number): string => String(n).padStart(2, '0');
        const name =
          `recording-${meta.devName ?? 'session'}-${stamp.getFullYear()}${p2(stamp.getMonth() + 1)}${p2(stamp.getDate())}` +
          `-${p2(stamp.getHours())}${p2(stamp.getMinutes())}${p2(stamp.getSeconds())}.jsonl`;
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="${name}"`
        });
        res.end(file);
      }
    },
    {
      method: 'POST',
      re: /(?:^|\/)api\/admin\/recordings\/([0-9a-f]+)\/link\/?$/,
      auth: true,
      run: ({ res, req, deps, match }) => {
        const token = deps.recordings.mintToken(match[1], actor(req));
        if (!token) {
          json(res, 404, { error: 'no such recording' });
          return;
        }
        deps.audit.log(actor(req), 'replay.link', match[1].slice(0, 8));
        json(res, 200, { token });
      }
    },
    {
      method: 'DELETE',
      re: /(?:^|\/)api\/admin\/recordings\/([0-9a-f]+)\/?$/,
      auth: true,
      run: ({ res, req, deps, match }) => {
        // A live recording is stopped at its session first: the writer lets
        // go of the file and the owner's REC indicator clears.
        const live = allSessions().find((s) => s.recorder?.recordingId === match[1]);
        if (live) live.stopRecording();
        const meta = deps.recordings.delete(match[1]);
        if (!meta) {
          json(res, 404, { error: 'no such recording' });
          return;
        }
        deps.audit.log(
          actor(req),
          'recording.delete',
          match[1].slice(0, 8),
          `${meta.systemName}/${meta.devName ?? 'device'} · ${meta.bytes} bytes · ${meta.frames} frames` +
            (meta.endedAt === null ? ' · was live' : '')
        );
        json(res, 200, { ok: true });
      }
    },
    {
      method: 'DELETE',
      re: /(?:^|\/)api\/admin\/replay\/([0-9a-f]+)\/?$/,
      auth: true,
      run: ({ res, req, deps, match }) => {
        const ok = deps.recordings.revokeToken(match[1]);
        if (ok) deps.audit.log(actor(req), 'replay.revoke', match[1].slice(0, 8));
        json(res, ok ? 200 : 404, { ok: true });
      }
    },
    {
      // Own recordings: requires the edge identity header (the same trust
      // model as everything else - without it there is no "own" to filter by).
      method: 'GET',
      re: /(?:^|\/)api\/recordings\/mine\/?$/,
      auth: false,
      run: ({ res, req, deps, cfg }) => {
        const me = identityOf(req);
        if (!cfg.trustedUserHeader) {
          json(res, 403, { error: 'History needs TRUSTED_USER_HEADER on the gateway' });
          return;
        }
        if (!me) {
          json(res, 401, { error: 'no identity on this request' });
          return;
        }
        json(res, 200, {
          recordings: deps.recordings.list().filter((r) => r.identity === me)
        });
      }
    },
    {
      method: 'POST',
      re: /(?:^|\/)api\/replay\/mint\/?$/,
      auth: false,
      run: ({ res, req, deps, cfg, body }) => {
        const me = identityOf(req);
        if (!cfg.trustedUserHeader || !me) {
          json(res, 403, { error: 'History needs TRUSTED_USER_HEADER on the gateway' });
          return;
        }
        const id = String((body as { id?: unknown })?.id ?? '');
        const meta = deps.recordings.get(id);
        // Owners mint links for their own recordings only.
        if (!meta || meta.identity !== me) {
          json(res, 404, { error: 'no such recording' });
          return;
        }
        const token = deps.recordings.mintToken(id, me);
        deps.audit.log(me, 'replay.link', id.slice(0, 8), 'owner');
        json(res, 200, { token });
      }
    },
    {
      // The replay itself: one unguessable bearer token, like ?view= and
      // the print-job downloads. Frames are the recorded wire stream -
      // password fields were blanked before capture.
      method: 'GET',
      re: /(?:^|\/)api\/replay\/([0-9a-f]{32})\/?$/,
      auth: false,
      run: ({ res, deps, match }) => {
        const meta = deps.recordings.resolveToken(match[1]);
        if (!meta) {
          json(res, 404, { error: 'no such replay (the link may have been revoked)' });
          return;
        }
        const frames = deps.recordings.framesOf(meta.id);
        if (frames === null) {
          json(res, 404, { error: 'recording file is missing' });
          return;
        }
        json(res, 200, { recording: meta, frames });
      }
    }
  ];

  return (req, res, pathname) => {
    const method = req.method ?? 'GET';
    if (!/(?:^|\/)api(?:\/|$)/.test(pathname)) return false;

    // /api/* never falls through to the SPA: unknown API paths 404 as JSON.
    if (method !== 'GET' && method !== 'HEAD') {
      const limit = /(?:^|\/)api\/admin\/config\/?$/.test(pathname) ? MAX_IMPORT_BYTES : MAX_BODY_BYTES;
      readBody(req, limit)
        .then((body) => {
          if (!body.ok) {
            json(res, body.status, { error: body.error });
            return;
          }
          dispatch(method, pathname, req, res, body.data);
        })
        .catch(() => res.destroy());
      return true;
    }
    dispatch(method, pathname, req, res, undefined);
    return true;
  };

  function dispatch(
    method: string,
    pathname: string,
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown
  ): void {
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = pathname.match(route.re);
      if (!match) continue;
      if (route.auth && !authorized(req)) {
        json(res, 401, { error: 'Administrator sign-on required' });
        return;
      }
      route.run({ cfg, systems, deps, req, res, match, body });
      return;
    }
    json(res, 404, { error: 'not found' });
  }
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(
  req: IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES
): Promise<{ ok: true; data: unknown } | { ok: false; error: string; status: number }> {
  return new Promise((resolve) => {
    const declared = Number.parseInt(String(req.headers['content-length'] ?? ''), 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      resolve({ ok: false, error: 'request too large', status: 413 });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        resolve({ ok: false, error: 'request too large', status: 413 });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({ ok: true, data: {} });
        return;
      }
      try {
        resolve({ ok: true, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        resolve({ ok: false, error: 'invalid JSON body', status: 400 });
      }
    });
    req.on('error', () => resolve({ ok: false, error: 'read error', status: 400 }));
  });
}
