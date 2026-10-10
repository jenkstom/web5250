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
  devPrefix: string | null;
  allowCustomHost: boolean;
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
  return {
    port: int(env.PORT, 8080),
    host: env.HOST ?? '0.0.0.0',
    ibmHost: env.IBM_I_HOST ?? '127.0.0.1',
    ibmPort: int(env.IBM_I_PORT, 23),
    ibmSsl: bool(env.IBM_I_SSL, false),
    tlsRejectUnauthorized: bool(env.IBM_I_TLS_REJECT_UNAUTHORIZED, false),
    codePage,
    termType,
    devPrefix: devPrefix === undefined || devPrefix === '' ? null : devPrefix.toUpperCase(),
    allowCustomHost: bool(env.ALLOW_CUSTOM_HOST, false)
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
