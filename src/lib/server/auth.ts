/**
 * Admin authentication: scrypt password hashing, server-side sessions, login rate limiting.
 *
 * - Passwords: scrypt (N=2^15, r=8, p=1, 64-byte key, 16-byte random salt), verified in constant time.
 * - Sessions: a random 32-byte token in an HttpOnly, SameSite=Strict cookie. Only its SHA-256
 *   hash is stored, so a leaked database cannot be used to hijack a session.
 *   Expire after 2 h idle or 12 h total; changing the password ends all sessions.
 * - Each session has its own CSRF token, required on every state-changing admin request.
 */
import { scryptSync, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { getDb, nowIso } from './db.ts';
import { SESSION, LOGIN_LIMIT } from './config.ts';

const SCRYPT = { N: 32768, r: 8, p: 1, keyLen: 64, maxmem: 128 * 1024 * 1024 };
export const PASSWORD_MIN_LENGTH = 12;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, r, p, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function validateNewPassword(password: string, username: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > 256) return 'Password is too long.';
  if (password.toLowerCase().includes(username.toLowerCase())) return 'Password must not contain the username.';
  return null;
}

export function validateUsername(username: string): string | null {
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) return 'Username must be 3–40 characters: letters, numbers, dot, dash or underscore.';
  return null;
}

// ---------------------------------------------------------------- users

export interface AdminUser {
  id: number;
  username: string;
}

export function adminCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM admin_users').get() as { c: number }).c;
}

export function createAdmin(username: string, password: string): AdminUser {
  const now = nowIso();
  const res = getDb()
    .prepare('INSERT INTO admin_users (username, password_hash, created_at, updated_at, password_changed_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, hashPassword(password), now, now, now);
  return { id: Number(res.lastInsertRowid), username };
}

export function setAdminPassword(username: string, password: string): boolean {
  const now = nowIso();
  const res = getDb()
    .prepare('UPDATE admin_users SET password_hash = ?, updated_at = ?, password_changed_at = ? WHERE username = ?')
    .run(hashPassword(password), now, now, username);
  if (res.changes === 0) return false;
  // Changing the password ends every existing session for that account.
  getDb().prepare('DELETE FROM admin_sessions WHERE user_id = (SELECT id FROM admin_users WHERE username = ?)').run(username);
  return true;
}

// Used so unknown usernames take as long to reject as wrong passwords. Created lazily
// (scrypt is deliberately slow) so importing this module costs nothing.
let dummyHash: string | null = null;

export function checkCredentials(username: string, password: string): AdminUser | null {
  const row = getDb().prepare('SELECT id, username, password_hash FROM admin_users WHERE username = ?').get(username) as
    | { id: number; username: string; password_hash: string }
    | undefined;
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  const ok = verifyPassword(password, row?.password_hash ?? dummyHash);
  if (!row || !ok) return null;
  getDb().prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?').run(nowIso(), row.id);
  return { id: row.id, username: row.username };
}

// ---------------------------------------------------------------- login rate limiting

/** Returns the lock expiry (epoch ms) if any of the keys is currently locked. */
export function loginLockedUntil(keys: string[], now = Date.now()): number | null {
  let until: number | null = null;
  for (const key of keys) {
    const row = getDb().prepare('SELECT locked_until FROM login_attempts WHERE key = ?').get(key) as { locked_until: number | null } | undefined;
    if (row?.locked_until && row.locked_until > now) until = Math.max(until ?? 0, row.locked_until);
  }
  return until;
}

export function recordLoginFailure(keys: string[], now = Date.now()) {
  const db = getDb();
  for (const key of keys) {
    const row = db.prepare('SELECT failures, window_start FROM login_attempts WHERE key = ?').get(key) as
      | { failures: number; window_start: number }
      | undefined;
    const fresh = !row || now - row.window_start > LOGIN_LIMIT.windowMs;
    const failures = fresh ? 1 : row.failures + 1;
    const lockedUntil = failures >= LOGIN_LIMIT.maxFailures ? now + LOGIN_LIMIT.lockMs : null;
    db.prepare(
      `INSERT INTO login_attempts (key, failures, window_start, locked_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, window_start = excluded.window_start, locked_until = excluded.locked_until`,
    ).run(key, failures, fresh ? now : row.window_start, lockedUntil);
  }
}

export function clearLoginFailures(keys: string[]) {
  for (const key of keys) getDb().prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
}

// ---------------------------------------------------------------- sessions

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface Session {
  user: AdminUser;
  csrfToken: string;
  expiresAt: number;
}

export function createSession(userId: number, userAgent: string | null, now = Date.now()): { token: string; csrfToken: string } {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  getDb()
    .prepare(
      `INSERT INTO admin_sessions (id, user_id, csrf_token, created_at, last_seen_at, absolute_expires_at, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sha256(token), userId, csrfToken, now, now, now + SESSION.absoluteMs, userAgent?.slice(0, 200) ?? null);
  return { token, csrfToken };
}

/** Validate a session token; slides the idle window. Expired sessions are deleted. */
export function readSession(token: string | undefined, now = Date.now()): Session | null {
  if (!token || token.length > 100) return null;
  const db = getDb();
  const id = sha256(token);
  const row = db
    .prepare(
      `SELECT s.csrf_token, s.last_seen_at, s.absolute_expires_at, u.id AS user_id, u.username
       FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .get(id) as { csrf_token: string; last_seen_at: number; absolute_expires_at: number; user_id: number; username: string } | undefined;
  if (!row) return null;
  if (now - row.last_seen_at > SESSION.idleMs || now > row.absolute_expires_at) {
    db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(id);
    return null;
  }
  db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?').run(now, id);
  return {
    user: { id: row.user_id, username: row.username },
    csrfToken: row.csrf_token,
    expiresAt: Math.min(now + SESSION.idleMs, row.absolute_expires_at),
  };
}

// ---------------------------------------------------------------- self-service (Admin → Account)

/** Lockout keys for wrong current-password attempts: the account only (every admin is on 127.0.0.1). */
export const accountLockKeys = (username: string) => [`user:${username.toLowerCase()}`];

export type ChangePasswordResult =
  | { ok: true; token: string; csrfToken: string }
  | { ok: false; reason: 'locked' | 'wrong_current' | 'policy' | 'mismatch' | 'same' | 'not_found'; message: string };

/**
 * Change the signed-in administrator's password. The current password is required; wrong
 * attempts count toward the account's sign-in lockout. On success, ALL of the account's sessions
 * end and a fresh one (new token, new CSRF token) is returned for the caller to set as its cookie.
 */
export function changePassword(
  userId: number,
  input: { current: string; next: string; confirm: string },
  userAgent: string | null,
  now = Date.now(),
): ChangePasswordResult {
  const row = getDb().prepare('SELECT username, password_hash FROM admin_users WHERE id = ?').get(userId) as
    | { username: string; password_hash: string }
    | undefined;
  if (!row) return { ok: false, reason: 'not_found', message: 'Account not found.' };
  const keys = accountLockKeys(row.username);
  if (loginLockedUntil(keys, now)) {
    return { ok: false, reason: 'locked', message: `Too many incorrect attempts. Try again in ${Math.round(LOGIN_LIMIT.lockMs / 60000)} minutes.` };
  }
  if (!input.current || !verifyPassword(input.current, row.password_hash)) {
    recordLoginFailure(keys, now);
    return { ok: false, reason: 'wrong_current', message: 'Your current password is incorrect.' };
  }
  if (input.next !== input.confirm) return { ok: false, reason: 'mismatch', message: 'The new passwords do not match.' };
  const policy = validateNewPassword(input.next, row.username);
  if (policy) return { ok: false, reason: 'policy', message: policy };
  if (verifyPassword(input.next, row.password_hash)) return { ok: false, reason: 'same', message: 'Choose a password different from your current one.' };

  clearLoginFailures(keys);
  const hash = hashPassword(input.next);
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const ts = nowIso();
    db.prepare('UPDATE admin_users SET password_hash = ?, updated_at = ?, password_changed_at = ? WHERE id = ?').run(hash, ts, ts, userId);
    db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(userId);
    const fresh = createSession(userId, userAgent, now);
    db.exec('COMMIT');
    return { ok: true, ...fresh };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** End every session of this account except the one with `currentToken`. Returns how many ended. */
export function revokeOtherSessions(userId: number, currentToken: string | undefined): number {
  if (!currentToken) return 0;
  return Number(getDb().prepare('DELETE FROM admin_sessions WHERE user_id = ? AND id <> ?').run(userId, sha256(currentToken)).changes);
}

export interface OwnSession {
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  device: string;
}

/** A short, non-identifying description of a browser user-agent, e.g. "Chrome on Windows". */
export function describeUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown browser';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\/|Chromium\/|HeadlessChrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /curl|node|undici|python|wget/i.test(ua)
              ? 'Script or tool'
              : 'Unknown browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iPod/.test(ua)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

/** This account's active sessions, newest activity first. Never includes token hashes or CSRF tokens. */
export function listOwnSessions(userId: number, currentToken: string | undefined, now = Date.now()): OwnSession[] {
  purgeExpiredSessions(now);
  const currentId = currentToken ? sha256(currentToken) : '';
  const rows = getDb()
    .prepare('SELECT id, created_at, last_seen_at, absolute_expires_at, user_agent FROM admin_sessions WHERE user_id = ? ORDER BY last_seen_at DESC')
    .all(userId) as { id: string; created_at: number; last_seen_at: number; absolute_expires_at: number; user_agent: string | null }[];
  return rows.map((r) => ({
    current: r.id === currentId,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: Math.min(r.last_seen_at + SESSION.idleMs, r.absolute_expires_at),
    device: describeUserAgent(r.user_agent),
  }));
}

export function deleteSession(token: string | undefined) {
  if (token) getDb().prepare('DELETE FROM admin_sessions WHERE id = ?').run(sha256(token));
}

export function purgeExpiredSessions(now = Date.now()) {
  getDb()
    .prepare('DELETE FROM admin_sessions WHERE last_seen_at < ? OR absolute_expires_at < ?')
    .run(now - SESSION.idleMs, now);
}
