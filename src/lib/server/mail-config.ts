/**
 * Email notification configuration, from environment variables. Server-only.
 *
 * Email is OFF unless MAIL_ENABLED=true. When enabled, the configuration is validated; any
 * problem leaves sending disabled and is reported as a list of PROBLEM DESCRIPTIONS ONLY —
 * never the configured values (so a password can't leak into a page, a log or the database).
 *
 * parseMailConfig() is pure (takes an env object) so it can be unit-tested.
 */
import { basename } from 'node:path';

export type MailTransportKind = 'smtp' | 'mock';

export interface MailConfig {
  enabled: boolean;
  /** 'disabled' (MAIL_ENABLED not true), 'ready', or 'misconfigured' (see problems). */
  status: 'disabled' | 'ready' | 'misconfigured';
  problems: string[];
  transport: MailTransportKind;
  from: string;
  to: string[];
  /** Include name, phone, email, location and message in the email (off by default). */
  includeDetails: boolean;
  /** Base URL used for the "open in admin" link, e.g. http://127.0.0.1:4321 */
  adminBaseUrl: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
  mock: {
    dir: string;
    fail: boolean;
  };
}

type Env = Record<string, string | undefined>;

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

const bool = (v: string | undefined) => (v ?? '').trim().toLowerCase() === 'true';

export function parseMailConfig(env: Env): MailConfig {
  const problems: string[] = [];
  const enabled = bool(env.MAIL_ENABLED);
  const storageDir = env.STORAGE_DIR || 'storage';

  const transportRaw = (env.MAIL_TRANSPORT || 'smtp').trim().toLowerCase();
  const transport: MailTransportKind = transportRaw === 'mock' ? 'mock' : 'smtp';
  if (transportRaw !== 'smtp' && transportRaw !== 'mock') problems.push('MAIL_TRANSPORT must be "smtp" or "mock".');

  const from = (env.MAIL_FROM ?? '').trim();
  if (!from) problems.push('MAIL_FROM is missing.');
  else if (!EMAIL_RE.test(from)) problems.push('MAIL_FROM is not a valid email address.');

  const to = (env.MAIL_TO ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (to.length === 0) problems.push('MAIL_TO is missing.');
  else if (to.length > 5) problems.push('MAIL_TO lists more than 5 recipients.');
  else if (to.some((a) => !EMAIL_RE.test(a))) problems.push('MAIL_TO contains an invalid email address.');

  const host = (env.SMTP_HOST ?? '').trim();
  const portRaw = (env.SMTP_PORT ?? '').trim();
  const port = portRaw === '' ? 587 : Number(portRaw);
  const user = env.SMTP_USER ?? '';
  const pass = env.SMTP_PASS ?? '';
  const secure = env.SMTP_SECURE === undefined || env.SMTP_SECURE === '' ? port === 465 : bool(env.SMTP_SECURE);

  if (transport === 'smtp') {
    if (!host) problems.push('SMTP_HOST is missing.');
    else if (!HOST_RE.test(host) && !LOOPBACK.has(host)) problems.push('SMTP_HOST is not a valid host name.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('SMTP_PORT must be a whole number between 1 and 65535.');
    if (Boolean(user) !== Boolean(pass)) problems.push('SMTP_USER and SMTP_PASS must both be set, or both be empty.');
    if (!user && host && !LOOPBACK.has(host)) problems.push('SMTP_USER and SMTP_PASS are required for a non-local SMTP server.');
    if (!secure && port === 465) problems.push('Port 465 requires SMTP_SECURE=true (implicit TLS).');
  }

  // The mock transport writes messages to disk: allowed only in disposable test storage.
  if (transport === 'mock' && !/test|tmp|temp/i.test(basename(storageDir))) {
    problems.push('MAIL_TRANSPORT=mock is only allowed with a test STORAGE_DIR.');
  }

  const port0 = Number(env.PORT) || 4321;
  const adminBaseUrl = (env.ADMIN_BASE_URL || `http://127.0.0.1:${port0}`).replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+$/i.test(adminBaseUrl)) problems.push('ADMIN_BASE_URL must look like http://host:port (no path).');

  const status: MailConfig['status'] = !enabled ? 'disabled' : problems.length ? 'misconfigured' : 'ready';
  return {
    enabled,
    status,
    problems: enabled ? problems : [],
    transport,
    from,
    to,
    includeDetails: bool(env.MAIL_INCLUDE_DETAILS),
    adminBaseUrl,
    smtp: { host, port, secure, user, pass },
    mock: { dir: `${storageDir}/mail-outbox`, fail: bool(env.MAIL_MOCK_FAIL) },
  };
}

let cached: MailConfig | null = null;

export function getMailConfig(): MailConfig {
  cached ??= parseMailConfig(process.env);
  return cached;
}

/** Reset the cached configuration (tests). */
export function resetMailConfig() {
  cached = null;
}

/**
 * What the admin may see: status, problems, transport and recipients. NEVER the SMTP user,
 * password, or anything else secret.
 */
export function publicMailStatus(config = getMailConfig()) {
  return {
    status: config.status,
    problems: config.problems,
    transport: config.transport,
    recipients: config.status === 'disabled' ? [] : config.to,
    includeDetails: config.includeDetails,
    smtpHost: config.transport === 'smtp' && config.status !== 'disabled' ? config.smtp.host : null,
  };
}
