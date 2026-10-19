/** Account self-service: password change, lockout, session rotation and listing. Disposable storage. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const storage = mkdtempSync(join(tmpdir(), 'vk-unit-test-account-'));
process.env.STORAGE_DIR = storage;
const { getDb, closeDb } = await import('../../src/lib/server/db.ts');
const A = await import('../../src/lib/server/auth.ts');
const { LOGIN_LIMIT } = await import('../../src/lib/server/config.ts');

after(() => {
  closeDb();
  rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Fictitious test credentials, generated per run; never real.
const OLD = `old-${Math.random().toString(36).slice(2)}-passphrase`;
const NEW = `new-${Math.random().toString(36).slice(2)}-passphrase`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function makeAdmin(name: string) {
  return A.createAdmin(name, OLD);
}

test('wrong current password is refused, counted toward the account lockout, and changes nothing', () => {
  const u = makeAdmin('acct-wrong');
  const s = A.createSession(u.id, UA);
  const hashBefore = (getDb().prepare('SELECT password_hash AS h FROM admin_users WHERE id = ?').get(u.id) as { h: string }).h;

  const r = A.changePassword(u.id, { current: 'not-the-password', next: NEW, confirm: NEW }, UA);
  assert.deepEqual(r.ok ? null : r.reason, 'wrong_current');
  assert.ok(A.readSession(s.token), 'session kept');
  assert.equal((getDb().prepare('SELECT password_hash AS h FROM admin_users WHERE id = ?').get(u.id) as { h: string }).h, hashBefore);

  // Only the account key is used (all admins share 127.0.0.1, so an IP lock would lock everyone).
  const keys = (getDb().prepare('SELECT key FROM login_attempts').all() as { key: string }[]).map((k) => k.key);
  assert.deepEqual(keys, ['user:acct-wrong']);
});

test('repeated wrong attempts lock both password change and sign-in for that account', () => {
  const u = makeAdmin('acct-lock');
  const now = Date.now();
  for (let i = 0; i < LOGIN_LIMIT.maxFailures; i++) A.changePassword(u.id, { current: 'wrong', next: NEW, confirm: NEW }, UA, now);
  const locked = A.changePassword(u.id, { current: OLD, next: NEW, confirm: NEW }, UA, now);
  assert.equal(locked.ok ? null : locked.reason, 'locked', 'even the right password is refused while locked');
  assert.ok(A.loginLockedUntil(['ip:127.0.0.1', 'user:acct-lock'], now), 'sign-in for this account is locked too');
  assert.equal(A.loginLockedUntil(['ip:127.0.0.1', 'user:someone-else'], now), null, 'other accounts and the local IP are not locked');
  const later = now + LOGIN_LIMIT.lockMs + 1000;
  assert.equal(A.changePassword(u.id, { current: OLD, next: NEW, confirm: NEW }, UA, later).ok, true, 'works again after the lock');
});

test('policy, confirmation and same-password checks', () => {
  const u = makeAdmin('acct-policy');
  const reason = (next: string, confirm = next) => {
    const r = A.changePassword(u.id, { current: OLD, next, confirm }, UA);
    return r.ok ? 'ok' : r.reason;
  };
  assert.equal(reason('short'), 'policy');
  assert.equal(reason('x-acct-policy-xxxxxxxx'), 'policy', 'must not contain the username');
  assert.equal(reason(NEW, `${NEW}x`), 'mismatch');
  assert.equal(reason(OLD), 'same');
  assert.equal(A.loginLockedUntil(['user:acct-policy']), null, 'policy mistakes are not lockout failures');
});

test('success: new password works, every other session ends, current continues on a fresh token and CSRF token', () => {
  const u = makeAdmin('acct-ok');
  const current = A.createSession(u.id, UA);
  const other = A.createSession(u.id, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1');
  const otherUser = makeAdmin('acct-bystander');
  const bystander = A.createSession(otherUser.id, UA);
  A.recordLoginFailure(['user:acct-ok']);

  const r = A.changePassword(u.id, { current: OLD, next: NEW, confirm: NEW }, UA);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(A.readSession(current.token), null, 'old token no longer valid');
  assert.equal(A.readSession(other.token), null, 'other session ended');
  const fresh = A.readSession(r.token);
  assert.ok(fresh, 'fresh session valid');
  assert.equal(fresh!.user.id, u.id);
  assert.equal(fresh!.csrfToken, r.csrfToken);
  assert.notEqual(r.csrfToken, current.csrfToken, 'CSRF token rotated');
  assert.ok(A.readSession(bystander.token), 'other administrators are unaffected');
  assert.equal(A.checkCredentials('acct-ok', OLD), null);
  assert.ok(A.checkCredentials('acct-ok', NEW));
  assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE key = 'user:acct-ok'").get() as { n: number }).n, 0, 'failures cleared');
});

test('session list shows only this account, marks the current one, and exposes no secrets', () => {
  const u = makeAdmin('acct-list');
  const a = A.createSession(u.id, UA);
  A.createSession(u.id, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15');
  A.createSession(makeAdmin('acct-list-other').id, UA);
  const list = A.listOwnSessions(u.id, a.token);
  assert.equal(list.length, 2);
  assert.equal(list.filter((s) => s.current).length, 1);
  assert.deepEqual(list.map((s) => s.device).sort(), ['Chrome on Windows', 'Safari on macOS']);
  const json = JSON.stringify(list);
  assert.ok(!json.includes(a.token) && !json.includes(a.csrfToken), 'no tokens');
  for (const s of list) assert.deepEqual(Object.keys(s).sort(), ['createdAt', 'current', 'device', 'expiresAt', 'lastSeenAt']);
});

test('revoking other sessions keeps the current one and never touches other accounts', () => {
  const u = makeAdmin('acct-revoke');
  const keep = A.createSession(u.id, UA);
  const drop1 = A.createSession(u.id, UA);
  const drop2 = A.createSession(u.id, UA);
  const bystander = A.createSession(makeAdmin('acct-revoke-other').id, UA);
  assert.equal(A.revokeOtherSessions(u.id, keep.token), 2);
  assert.ok(A.readSession(keep.token));
  assert.equal(A.readSession(drop1.token), null);
  assert.equal(A.readSession(drop2.token), null);
  assert.ok(A.readSession(bystander.token));
  assert.equal(A.revokeOtherSessions(u.id, undefined), 0, 'without a current token nothing is revoked');
});

test('user-agent descriptions are short and generic', () => {
  assert.equal(A.describeUserAgent(null), 'Unknown browser');
  assert.equal(A.describeUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0'), 'Edge on Windows');
  assert.equal(A.describeUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'), 'Firefox on Linux');
  assert.equal(A.describeUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'), 'Chrome on Android');
  assert.equal(A.describeUserAgent('curl/8.4.0'), 'Script or tool');
  assert.ok(A.describeUserAgent('x'.repeat(5000)).length < 40);
});
