// JSON HTTP API for the connection menu, its admin editor, and the spool.
//
//   GET    /api/meta                      admin enabled?, form options/defaults
//   GET    /api/systems                   menu list (public: the menu needs it)
//   GET    /api/printer-status            per-system printer session states
//   GET    /api/printjobs                 spool jobs, newest first (public)
//   GET    /api/printjobs/<token>         job download (unguessable token)
//   DELETE /api/printjobs/<token>         delete job            (Bearer token)
//   POST   /api/admin/auth                {pin} -> {token}
//   GET    /api/admin/systems             full rows incl. proxy (Bearer token)
//   POST   /api/admin/systems             create          (Bearer token)
//   PUT    /api/admin/systems/<id>        update          (Bearer token)
//   DELETE /api/admin/systems/<id>        delete          (Bearer token)
//   POST   /api/admin/systems/<id>/move   {dir: up|down}  (Bearer token)
//
// Routes match by path suffix so the app keeps working behind a reverse proxy
// path-based rules (/as400/api/... etc), mirroring /healthz handling.
// Admin tokens are random, kept in memory, and expire after 8 hours; PIN
// attempts are hashed and compared in constant time, with a temporary
// lockout after repeated failures. Identity itself is enforced by Pangolin
// at the edge — this PIN only gates host-list administration.
//
// Proxy credentials (and the proxy's location - internal infrastructure)
// appear only on the authenticated admin routes; the public menu list gets
// a `viaProxy` flag and nothing more. The printer device name follows the
// same policy on system rows; print jobs themselves are keyed by unguessable
// per-job tokens (the session-token trust model) and never contain
// credentials.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TERM_TYPES } from './tn5250/constants.ts';
import { Ebcdic } from './tn5250/ebcdic.ts';
import type { Config } from './config.ts';
import type { Systems, SystemRow } from './systems.ts';
import type { Printers } from './printers.ts';

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 32 * 1024;
const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MS = 60_000;

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
  /** Fires after any admin mutation that changed the systems list. */
  onSystemsChanged: () => void;
}

export function createApiHandler(cfg: Config, systems: Systems, deps: ApiDeps): ApiHandler {
  // In-memory admin sessions + PIN rate limiting (single-process gateway).
  const tokens = new Map<string, number>();
  let pinFailures = 0;
  let pinLockedUntil = 0;

  const sha = (s: string): Buffer => crypto.createHash('sha256').update(s, 'utf8').digest();
  const pinDigest = cfg.adminPin ? sha(cfg.adminPin) : null;

  const authorized = (req: IncomingMessage): boolean => {
    const header = String(req.headers.authorization ?? '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return false;
    const expiry = tokens.get(token);
    if (!expiry || expiry < Date.now()) {
      tokens.delete(token);
      return false;
    }
    return true;
  };

  /** Menu-safe projection: no proxy or printer-infrastructure details. */
  const publicSystem = (s: SystemRow): Record<string, unknown> => {
    const {
      proxyHost, proxyPort, proxyUser, proxyPass, printerDeviceName, ...pub
    } = s;
    return { ...pub, viaProxy: Boolean(proxyHost) };
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
      auth: true,
      run: ({ res, deps, match }) => {
        json(res, deps.printers.deleteJob(match[1]) ? 200 : 404, { ok: true });
      }
    },
    {
      method: 'POST',
      re: /(?:^|\/)api\/admin\/auth\/?$/,
      auth: false,
      run: ({ res, body }) => {
        if (!cfg.adminPin) {
          json(res, 403, { error: 'Administration is disabled (set ADMIN_PIN to enable)' });
          return;
        }
        const now = Date.now();
        if (now < pinLockedUntil) {
          const secs = Math.ceil((pinLockedUntil - now) / 1000);
          json(res, 429, { error: `Too many attempts - locked for ${secs}s` });
          return;
        }
        const pin = String((body as { pin?: unknown })?.pin ?? '');
        if (!pin || !crypto.timingSafeEqual(sha(pin), pinDigest!)) {
          pinFailures++;
          if (pinFailures >= PIN_MAX_FAILURES) {
            pinLockedUntil = now + PIN_LOCK_MS;
            pinFailures = 0;
          }
          json(res, 401, { error: 'PIN is not valid' });
          return;
        }
        pinFailures = 0;
        const token = crypto.randomBytes(32).toString('hex');
        for (const [t, exp] of tokens) if (exp < now) tokens.delete(t);
        tokens.set(token, now + TOKEN_TTL_MS);
        json(res, 200, { token, expiresInMs: TOKEN_TTL_MS });
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
    }
  ];

  return (req, res, pathname) => {
    const method = req.method ?? 'GET';
    if (!/(?:^|\/)api(?:\/|$)/.test(pathname)) return false;

    // /api/* never falls through to the SPA: unknown API paths 404 as JSON.
    if (method !== 'GET' && method !== 'HEAD') {
      readBody(req)
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
  req: IncomingMessage
): Promise<{ ok: true; data: unknown } | { ok: false; error: string; status: number }> {
  return new Promise((resolve) => {
    const declared = Number.parseInt(String(req.headers['content-length'] ?? ''), 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      resolve({ ok: false, error: 'request too large', status: 413 });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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
