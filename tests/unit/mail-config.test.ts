import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMailConfig, publicMailStatus } from '../../src/lib/server/mail-config.ts';

const SECRET = 'S3cr3t-App-Passw0rd';
const valid = {
  MAIL_ENABLED: 'true',
  MAIL_TRANSPORT: 'smtp',
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_USER: 'sender@example.com',
  SMTP_PASS: SECRET,
  MAIL_FROM: 'sender@example.com',
  MAIL_TO: 'owner@example.com',
};

test('email is disabled by default (no variables set)', () => {
  const c = parseMailConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.status, 'disabled');
  assert.deepEqual(c.problems, []);
});

test('MAIL_ENABLED must be exactly "true" to enable', () => {
  for (const v of ['1', 'yes', 'TRUE ', 'on', '']) {
    const c = parseMailConfig({ ...valid, MAIL_ENABLED: v });
    assert.equal(c.enabled, v.trim().toLowerCase() === 'true', `MAIL_ENABLED=${JSON.stringify(v)}`);
  }
});

test('a complete SMTP configuration is ready, with STARTTLS on 587 and implicit TLS on 465', () => {
  const c = parseMailConfig(valid);
  assert.equal(c.status, 'ready', c.problems.join('; '));
  assert.equal(c.smtp.secure, false);
  const c465 = parseMailConfig({ ...valid, SMTP_PORT: '465' });
  assert.equal(c465.status, 'ready');
  assert.equal(c465.smtp.secure, true);
});

test('missing or invalid settings make the config misconfigured, with descriptive problems', () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ SMTP_HOST: '' }, /SMTP_HOST is missing/],
    [{ SMTP_HOST: 'bad host!' }, /SMTP_HOST is not a valid host name/],
    [{ SMTP_PORT: '70000' }, /SMTP_PORT must be/],
    [{ SMTP_PORT: 'abc' }, /SMTP_PORT must be/],
    [{ SMTP_PASS: '' }, /SMTP_USER and SMTP_PASS must both be set/],
    [{ SMTP_USER: '', SMTP_PASS: '' }, /required for a non-local SMTP server/],
    [{ MAIL_FROM: '' }, /MAIL_FROM is missing/],
    [{ MAIL_FROM: 'not-an-email' }, /MAIL_FROM is not a valid/],
    [{ MAIL_TO: '' }, /MAIL_TO is missing/],
    [{ MAIL_TO: 'a@example.com, nope' }, /MAIL_TO contains an invalid/],
    [{ MAIL_TO: 'a@x.io,b@x.io,c@x.io,d@x.io,e@x.io,f@x.io' }, /more than 5/],
    [{ MAIL_TRANSPORT: 'sendmail' }, /MAIL_TRANSPORT must be/],
    [{ SMTP_PORT: '465', SMTP_SECURE: 'false' }, /Port 465 requires SMTP_SECURE=true/],
    [{ ADMIN_BASE_URL: 'javascript:alert(1)' }, /ADMIN_BASE_URL/],
  ];
  for (const [override, expected] of cases) {
    const c = parseMailConfig({ ...valid, ...override });
    assert.equal(c.status, 'misconfigured', JSON.stringify(override));
    assert.ok(c.problems.some((p) => expected.test(p)), `${JSON.stringify(override)} → ${c.problems.join('; ')}`);
  }
});

test('problems never echo configured values (e.g. the password or a bad host)', () => {
  const c = parseMailConfig({ ...valid, SMTP_HOST: 'evil<script>host', MAIL_TO: 'x@@y', SMTP_PORT: '99999' });
  const text = c.problems.join(' ');
  assert.ok(!text.includes(SECRET));
  assert.ok(!text.includes('evil<script>host'));
  assert.ok(!text.includes('x@@y'));
});

test('local SMTP relay without credentials is allowed', () => {
  const c = parseMailConfig({ ...valid, SMTP_HOST: 'localhost', SMTP_PORT: '25', SMTP_USER: '', SMTP_PASS: '' });
  assert.equal(c.status, 'ready', c.problems.join('; '));
});

test('mock transport is refused outside a test storage folder', () => {
  const real = parseMailConfig({ ...valid, MAIL_TRANSPORT: 'mock', STORAGE_DIR: 'storage' });
  assert.equal(real.status, 'misconfigured');
  assert.ok(real.problems.some((p) => /only allowed with a test STORAGE_DIR/.test(p)));
  const testDir = parseMailConfig({ ...valid, MAIL_TRANSPORT: 'mock', STORAGE_DIR: 'unit-test-storage' });
  assert.equal(testDir.status, 'ready');
});

test('the admin-facing status never contains the SMTP user or password', () => {
  for (const env of [valid, { ...valid, SMTP_HOST: '' }, { ...valid, MAIL_ENABLED: '' }]) {
    const json = JSON.stringify(publicMailStatus(parseMailConfig(env)));
    assert.ok(!json.includes(SECRET), json);
    assert.ok(!json.includes('sender@example.com') || !json.includes('"user"'), json);
    assert.ok(!/pass/i.test(json), json);
  }
});

test('customer details are excluded from emails unless explicitly enabled', () => {
  assert.equal(parseMailConfig(valid).includeDetails, false);
  assert.equal(parseMailConfig({ ...valid, MAIL_INCLUDE_DETAILS: 'true' }).includeDetails, true);
});
