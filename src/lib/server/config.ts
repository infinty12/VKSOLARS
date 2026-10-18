/**
 * Server-side runtime configuration, read from environment variables.
 * Server-only: never import this from client scripts.
 *
 * Plain TypeScript with erasable syntax only, so Node can also run it directly from the
 * CLI scripts in /scripts (Node 24 strips types natively).
 */
import { resolve } from 'node:path';

const env = process.env;

const flag = (name: string) => (env[name] ?? '').trim().toLowerCase() === 'true';

export const config = {
  /** Directory for the SQLite database, secret key and backups. Excluded from Git. */
  storageDir: resolve(env.STORAGE_DIR || 'storage'),

  /**
   * Master switch for public enquiry submissions. Submissions are accepted only when this is
   * "true" AND the admin setting "Accept enquiries" is on. Defaults to off.
   */
  enquiriesEnabled: flag('ENQUIRIES_ENABLED'),

  /** Allow /admin from non-loopback addresses. Leave unset for local-only access. */
  adminAllowRemote: flag('ADMIN_ALLOW_REMOTE'),

  /** Force Secure cookies even on plain HTTP (set when served behind HTTPS). */
  cookieSecure: flag('COOKIE_SECURE'),

  /** Secret used to sign form tokens. If unset, a random key is created in storageDir. */
  appSecret: env.APP_SECRET || '',
};

export const SESSION = {
  cookieName: 'vk_admin_session',
  loginCsrfCookie: 'vk_login_csrf',
  idleMs: 2 * 60 * 60 * 1000, // 2 hours without activity
  absoluteMs: 12 * 60 * 60 * 1000, // 12 hours maximum
};

export const LOGIN_LIMIT = {
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000,
};

/** Positive integer from an environment variable, or the default. */
const intEnv = (name: string, fallback: number) => {
  const n = Number(env[name]);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

export const ENQUIRY_LIMIT = {
  /** Submissions allowed per client address per window (ENQUIRY_RATE_LIMIT_PER_IP). */
  perIpMax: intEnv('ENQUIRY_RATE_LIMIT_PER_IP', 5),
  perIpWindowMs: 10 * 60 * 1000,
  /** Submissions allowed site-wide per window (ENQUIRY_RATE_LIMIT_GLOBAL). */
  globalMax: intEnv('ENQUIRY_RATE_LIMIT_GLOBAL', 100),
  globalWindowMs: 60 * 60 * 1000,
  /** Reject forms submitted faster than a person could fill them in (ENQUIRY_MIN_FILL_MS). */
  minFillMs: intEnv('ENQUIRY_MIN_FILL_MS', 3000),
  /** Reject form tokens older than this. */
  maxAgeMs: 24 * 60 * 60 * 1000,
  /** Reject request bodies larger than this (bytes). */
  maxBodyBytes: 16 * 1024,
};
