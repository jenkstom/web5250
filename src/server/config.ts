// Environment-driven configuration (see README for the full variable table).
import { Ebcdic } from './tn5250/ebcdic.ts';
import { TERM_TYPES } from './tn5250/constants.ts';

export interface Config {
  port: number;
  host: string;
  ibmHost: string;
  ibmPort: number;
  ibmSsl: boolean;
  /** SOCKS5 proxy for the first-boot seed system (IBM_I_PROXY_HOST etc). */
  ibmProxyHost: string | null;
  ibmProxyPort: number;
  ibmProxyUser: string | null;
  ibmProxyPassword: string | null;
  tlsRejectUnauthorized: boolean;
  codePage: string;
  termType: string;
  /** Claim mouse capability in the 5250 query reply (GUI discovery). */
  mouseGui: boolean;
  /** How many inbound records to capture per session for Diag (IBM_I_TRACE_RECORDS). */
  traceRecords: number;
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
  /**
   * How long (ms) a host session with no attached browser stays alive,
   * re-attachable via its session token. 0 = strict legacy behaviour
   * (closing the socket tears the session down immediately).
   */
  sessionGraceMs: number;
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

/** Integer clamped to [min, max] - for knobs with a sane operating range. */
const clampInt = (v: string | undefined, min: number, max: number, def: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : def;
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
    ibmProxyHost: env.IBM_I_PROXY_HOST?.trim() || null,
    ibmProxyPort: int(env.IBM_I_PROXY_PORT, 1080),
    ibmProxyUser: env.IBM_I_PROXY_USER?.trim() || null,
    ibmProxyPassword: env.IBM_I_PROXY_PASSWORD ?? null,
    tlsRejectUnauthorized: bool(env.IBM_I_TLS_REJECT_UNAUTHORIZED, false),
    codePage,
    termType,
    mouseGui: ['1', 'true'].includes((env.IBM_I_MOUSE_GUI ?? '').toLowerCase()),
    // 8 records is not enough to diagnose a stuck screen after sign-on
    // flows - default to a few hundred (bounded, ~1 KB per record).
    traceRecords: clampInt(env.IBM_I_TRACE_RECORDS, 8, 5000, 200),
    devPrefix: devPrefix === undefined || devPrefix === '' ? null : devPrefix.toUpperCase(),
    allowCustomHost: bool(env.ALLOW_CUSTOM_HOST, false),
    adminPin,
    dbPath: env.WEB5250_DB ?? 'data/web5250.db',
    wsPingIntervalMs: int(env.WS_PING_INTERVAL_MS, 30000),
    // Grace = interval x misses (default 2 min): wide enough that a browser
    // whose keepalive timers slipped (throttled tab, slow proxy) survives;
    // a vanished browser still frees its iSeries session promptly.
    wsPingMaxMisses: int(env.WS_PING_MAX_MISSES, 4),
    // Five minutes covers a refresh, a lost Wi-Fi link or moving a split-view
    // pane into its own window; 0 restores the strict close-equals-teardown
    // model (and the E2E suites run that way to keep their assumptions).
    sessionGraceMs: clampInt(env.SESSION_GRACE_MS, 0, 24 * 60 * 60 * 1000, 300000),
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
