/** Hosted contact-form enquiries: save first, then notify, never a false success. No network used. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitOnlineEnquiry, buildOnlineEnquiryEmail, firestoreDeps, newReference, type EnquiryDeps, type SavedEnquiry, type NotificationOutcome } from '../../src/lib/server/online-enquiries.ts';
import { parseMailConfig } from '../../src/lib/server/mail-config.ts';
import type { EnquiryValues } from '../../src/lib/enquiry.ts';

// Fictitious enquiry.
const values: EnquiryValues = {
  name: 'Test Person',
  phone: '9000000000',
  email: 'test@example.com',
  service: 'solar-panel-cleaning',
  region: 'rajasthan',
  location: 'Test town',
  message: 'Test message',
  consent: true,
} as EnquiryValues;
const saved: SavedEnquiry = { id: 'abcdefghij1234567890', reference: 'ENQ-20261021-ABC123', createdAt: '2026-10-21T10:00:00.000Z' };

function fakeDeps(over: Partial<EnquiryDeps> = {}) {
  const calls = { save: 0, notify: 0, recorded: [] as NotificationOutcome[] };
  const deps: EnquiryDeps = {
    save: async () => {
      calls.save++;
      return saved;
    },
    notify: async () => {
      calls.notify++;
      return { status: 'sent' };
    },
    record: async (_s, outcome) => {
      calls.recorded.push(outcome);
    },
    ...over,
  };
  return { deps, calls };
}

test('success: saved, notified, outcome recorded, reference returned', async () => {
  const { deps, calls } = fakeDeps();
  const r = await submitOnlineEnquiry(values, deps);
  assert.deepEqual(r, { ok: true, reference: saved.reference, notification: 'sent' });
  assert.equal(calls.save, 1);
  assert.equal(calls.notify, 1);
  assert.deepEqual(calls.recorded, [{ status: 'sent' }]);
});

test('database failure: never reports success and never sends an email', async () => {
  const { deps, calls } = fakeDeps({
    save: async () => {
      throw new Error('UNAVAILABLE');
    },
  });
  const r = await submitOnlineEnquiry(values, deps);
  assert.deepEqual(r, { ok: false, reason: 'store_failed' });
  assert.equal(calls.notify, 0);
  assert.equal(calls.recorded.length, 0);
});

test('email failure after saving: the enquiry is kept, success is reported, the failure is recorded', async () => {
  const { deps, calls } = fakeDeps({
    notify: async () => {
      throw Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 });
    },
  });
  const r = await submitOnlineEnquiry(values, deps);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.notification, 'failed');
  assert.equal(calls.recorded[0].status, 'failed');
  assert.match((calls.recorded[0] as { error: string }).error, /^[a-z_]+$/, 'only a short category, never the message');
});

test('recording the outcome failing does not turn a saved enquiry into a failure', async () => {
  const { deps } = fakeDeps({
    record: async () => {
      throw new Error('DEADLINE_EXCEEDED');
    },
  });
  assert.equal((await submitOnlineEnquiry(values, deps)).ok, true);
});

test('real notifier: disabled mail config sends nothing; a failing transport becomes a category', async () => {
  const off = firestoreDeps({ mail: parseMailConfig({}) });
  assert.deepEqual(await off.notify(values, saved), { status: 'disabled' });

  const mail = parseMailConfig({ MAIL_ENABLED: 'true', MAIL_TRANSPORT: 'smtp', MAIL_FROM: 'site@example.com', MAIL_TO: 'inbox@example.com', SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASS: 'p' });
  assert.equal(mail.status, 'ready');
  const sent: unknown[] = [];
  const ok = firestoreDeps({ mail, siteUrl: 'https://example.com', transport: { send: async (m) => void sent.push(m) } });
  assert.deepEqual(await ok.notify(values, saved), { status: 'sent' });
  assert.equal(sent.length, 1);
  const failing = firestoreDeps({ mail, siteUrl: 'https://example.com', transport: { send: async () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })) } });
  const out = await failing.notify(values, saved);
  assert.equal(out.status, 'failed');
});

test('notification email: no customer details unless MAIL_INCLUDE_DETAILS=true; links to the admin request', () => {
  const base = { MAIL_ENABLED: 'true', MAIL_FROM: 'site@example.com', MAIL_TO: 'inbox@example.com', SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASS: 'p' };
  const plain = buildOnlineEnquiryEmail(values, saved, parseMailConfig(base), 'https://vksolars.vercel.app');
  assert.equal(plain.subject, `New website enquiry ${saved.reference}`);
  assert.ok(plain.text.includes(`https://vksolars.vercel.app/admin/requests/${saved.id}`));
  for (const secret of ['Test Person', '9000000000', 'test@example.com', 'Test town', 'Test message']) assert.ok(!plain.text.includes(secret), secret);
  const detailed = buildOnlineEnquiryEmail(values, saved, parseMailConfig({ ...base, MAIL_INCLUDE_DETAILS: 'true' }), 'https://vksolars.vercel.app');
  assert.ok(detailed.text.includes('Test Person') && detailed.text.includes('9000000000'));
  assert.ok(!detailed.subject.includes('Test Person'), 'customer data never in the subject');
});

test('references are well-formed and random', () => {
  const a = newReference();
  assert.match(a, /^ENQ-\d{8}-[0-9A-F]{6}$/);
  assert.notEqual(a, newReference());
});
