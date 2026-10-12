// Environment-driven configuration (see README for the full variable table).
import { Ebcdic } from './tn5250/ebcdic.ts';
import { TERM_TYPES } from './tn5250/constants.ts';

export interface Config {
  port: number;
  host: string;
  ibmHost: string;
  ibmPort: number;
  ibmSsl: boolean;
  tlsRejectUnauthorized: boolean;
  codePage: string;
  termType: string;
  /** Claim mouse capability in the 5250 query reply (GUI discovery). */
  mouseGui: boolean;
  devPrefix: string | null;
  allowCustomHost: boolean;
  /** PIN guarding host-list administration; null disables the admin UI. */
  adminPin: string | null;
  /** SQLite file holding the connection-menu systems (mount as a volume). */
  dbPath: string;
  /** Browser-liveness ping cadence (ms) for reaping dead front-ends. */
  wsPingIntervalMs: number;
  /** Missed pongs tolerated before a dead browser's host session is torn down. */
  wsPingMaxMisses: number;
  /** Shared assumed-identity account for ?auto=1 launches (server-held). */
  autoSignOnUser: string | null;
  autoSignOnPassword: string | null;
  /** When set, HTML responses carry `Content-Security-Policy: frame-ancestors …`. */
  frameAncestors: string | null;
  /** Show the Diag top-bar button in the browser UI (session diagnostics). */
  showDiagButton: boolean;
}

const bool = (v: string | undefined, def: boolean): boolean => {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

const int = (v: string | undefined, def: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const codePage = (env.IBM_I_CODEPAGE ?? 'cp037').toLowerCase();
  if (!Ebcdic.availablePages().includes(codePage)) {
    throw new Error(
      `IBM_I_CODEPAGE=${codePage} is not supported. Available: ${Ebcdic.availablePages().join(', ')}`
    );
  }
  const termType = (env.IBM_I_TERM_TYPE ?? 'IBM-3477-FC').toUpperCase();
  if (!(TERM_TYPES as readonly string[]).includes(termType)) {
    throw new Error(
      `IBM_I_TERM_TYPE=${termType} is not supported. Available: ${TERM_TYPES.join(', ')}`
    );
  }

  const devPrefix = env.IBM_I_DEV_PREFIX;
  const adminPin = env.ADMIN_PIN?.trim() || null;
  if (adminPin !== null && adminPin.length < 4) {
    throw new Error('ADMIN_PIN must be at least 4 characters (or empty to disable administration)');
  }
  return {
    port: int(env.PORT, 8080),
    host: env.HOST ?? '0.0.0.0',
    ibmHost: env.IBM_I_HOST ?? '127.0.0.1',
    ibmPort: int(env.IBM_I_PORT, 23),
    ibmSsl: bool(env.IBM_I_SSL, false),
    tlsRejectUnauthorized: bool(env.IBM_I_TLS_REJECT_UNAUTHORIZED, false),
    codePage,
    termType,
    mouseGui: ['1', 'true'].includes((env.IBM_I_MOUSE_GUI ?? '').toLowerCase()),
    devPrefix: devPrefix === undefined || devPrefix === '' ? null : devPrefix.toUpperCase(),
    allowCustomHost: bool(env.ALLOW_CUSTOM_HOST, false),
    adminPin,
    dbPath: env.WEB5250_DB ?? 'data/web5250.db',
    wsPingIntervalMs: int(env.WS_PING_INTERVAL_MS, 30000),
    // Grace = interval x misses (default 2 min): wide enough that a browser
    // whose keepalive timers slipped (throttled tab, slow proxy) survives;
    // a vanished browser still frees its iSeries session promptly.
    wsPingMaxMisses: int(env.WS_PING_MAX_MISSES, 4),
    autoSignOnUser: env.AUTO_SIGNON_USER?.trim() || null,
    autoSignOnPassword: env.AUTO_SIGNON_PASSWORD ?? null,
    frameAncestors: env.FRAME_ANCESTORS?.trim() || null,
    showDiagButton: bool(env.SHOW_DIAG_BUTTON, false)
  };
}

const DEV_CHARS = /^[A-Z0-9#$@_]+$/;

/** Build a device name from the configured prefix, staying within 10 chars. */
export function makeDeviceName(prefix: string | null, explicit?: string | null): string | null {
  const candidate = (explicit ?? '').trim().toUpperCase();
  if (candidate) {
    if (candidate.length > 10 || !DEV_CHARS.test(candidate)) return null;
    return candidate;
  }
  if (!prefix) return null;
  const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
  return (prefix + rnd).slice(0, 10);
}
