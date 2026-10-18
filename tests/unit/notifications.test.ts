/**
 * Outbox + enquiry integration against a disposable database. Uses an in-memory mock transport;
 * never sends real email.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const storage = mkdtempSync(join(tmpdir(), 'vk-unit-test-notify-'));
process.env.STORAGE_DIR = storage;
process.env.MAIL_ENABLED = 'true';
process.env.MAIL_TRANSPORT = 'mock';
process.env.MAIL_FROM = 'website@example.com';
process.env.MAIL_TO = 'owner@example.com';

const { getDb, closeDb } = await import('../../src/lib/server/db.ts');
const { createEnquiry, deleteEnquiry } = await import('../../src/lib/server/enquiries.ts');
const { processOutbox, buildEnquiryEmail, MAX_ATTEMPTS, RETRY_DELAYS_MS, enqueueEnquiryNotification, setOutboxAutoRun } = await import(
  '../../src/lib/server/notifications.ts'
);
setOutboxAutoRun(false); // the tests drive processOutbox() themselves
const { parseMailConfig } = await import('../../src/lib/server/mail-config.ts');
const { MailSendError, categorizeMailError } = await import('../../src/lib/server/mailer.ts');
type Msg = import('../../src/lib/server/mailer.ts').MailMessage;

const config = parseMailConfig(process.env);

/** Records messages; optionally throws a given error. */
function mockTransport(error?: unknown) {
  const sent: Msg[] = [];
  return { sent, send: async (m: Msg) => (error ? Promise.reject(error) : void sent.push(m)) };
}

const enquiry = (name = 'Asha Verma') => ({
  name,
  phone: '9876543210',
  email: 'asha@example.com',
  service: 'ac-service',
  region: 'goa',
  location: 'Panaji',
  message: 'Inverter fault since Monday',
  consent: true,
});

const outboxRow = (enquiryId: number) =>
  getDb().prepare('SELECT status, attempts, last_error AS lastError, next_attempt_at AS next FROM notification_outbox WHERE enquiry_id = ?').get(enquiryId) as
    | { status: string; attempts: number; lastError: string | null; next: number }
    | undefined;

before(() => {
  assert.equal(config.status, 'ready', config.problems.join('; '));
  getDb();
});

after(() => {
  closeDb();
  rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('a stored enquiry gets exactly one pending notification in the same transaction', () => {
  const { id } = createEnquiry(enquiry());
  const row = outboxRow(id);
  assert.equal(row?.status, 'pending');
  assert.equal(row?.attempts, 0);
});

test('successful send marks the notification sent', async () => {
  const { id } = createEnquiry(enquiry());
  const t = mockTransport();
  const r = await processOutbox({ config, transport: t, now: Date.now() + 1 });
  assert.ok(r.sent >= 1);
  assert.equal(outboxRow(id)?.status, 'sent');
  assert.ok(t.sent.some((m) => m.to.includes('owner@example.com')));
});

test('a mail failure never loses the enquiry: it stays stored and the send is retried with backoff', async () => {
  const { id } = createEnquiry(enquiry('Retry Person'));
  const now = Date.now() + 1;
  const err = Object.assign(new Error('535 5.7.8 Username and Password not accepted for sender@example.com pw=S3cret'), { code: 'EAUTH' });
  const r = await processOutbox({ config, transport: mockTransport(err), now });
  assert.ok(r.retried >= 1);
  const row = outboxRow(id)!;
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.equal(row.lastError, 'auth_failed');
  assert.equal(row.next, now + RETRY_DELAYS_MS[0]);
  // The enquiry itself is untouched.
  const stored = getDb().prepare('SELECT name, status FROM enquiries WHERE id = ?').get(id) as { name: string; status: string };
  assert.deepEqual({ ...stored }, { name: 'Retry Person', status: 'new' });
  // The raw SMTP error (which can contain addresses or secrets) is not stored anywhere.
  const dump = JSON.stringify(getDb().prepare('SELECT * FROM notification_outbox').all());
  assert.ok(!dump.includes('Password not accepted') && !dump.includes('S3cret') && !dump.includes('sender@example.com'));
});

test(`after ${MAX_ATTEMPTS} failed attempts the notification is marked failed (and stops retrying)`, async () => {
  const { id } = createEnquiry(enquiry('Give Up'));
  let now = Date.now() + 1;
  const failing = mockTransport(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await processOutbox({ config, transport: failing, now });
    now += 7 * 60 * 60 * 1000; // jump past any backoff
  }
  const row = outboxRow(id)!;
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, MAX_ATTEMPTS);
  assert.equal(row.lastError, 'connection_failed');
  await processOutbox({ config, transport: failing, now });
  assert.equal(outboxRow(id)!.attempts, MAX_ATTEMPTS);
});

test('a notification whose enquiry was deleted is cancelled, not sent', async () => {
  const { id } = createEnquiry(enquiry('Deleted Before Send'));
  const outboxId = (getDb().prepare('SELECT id FROM notification_outbox WHERE enquiry_id = ?').get(id) as { id: number }).id;
  deleteEnquiry(id, null as unknown as number); // no admin user in this test database
  const t = mockTransport();
  await processOutbox({ config, transport: t, now: Date.now() + 1 });
  const row = getDb().prepare('SELECT status, enquiry_id AS e FROM notification_outbox WHERE id = ?').get(outboxId) as { status: string; e: number | null };
  assert.equal(row.status, 'cancelled');
  assert.equal(row.e, null);
  assert.ok(!t.sent.some((m) => m.text.includes('Deleted Before Send')));
});

test('misconfigured mail fails the notification without retrying and without touching the enquiry', async () => {
  const bad = parseMailConfig({ ...process.env, SMTP_HOST: '', MAIL_TRANSPORT: 'smtp' });
  assert.equal(bad.status, 'misconfigured');
  const { id } = createEnquiry(enquiry('Bad Config'));
  await processOutbox({ config: bad, now: Date.now() + 1 });
  assert.deepEqual({ status: outboxRow(id)!.status, lastError: outboxRow(id)!.lastError }, { status: 'failed', lastError: 'config_invalid' });
  assert.ok(getDb().prepare('SELECT 1 FROM enquiries WHERE id = ?').get(id));
});

test('with email disabled, enquiries are stored and nothing is queued', () => {
  const off = parseMailConfig({});
  const before = (getDb().prepare('SELECT COUNT(*) AS n FROM notification_outbox').get() as { n: number }).n;
  enqueueEnquiryNotification(999999, off);
  const after = (getDb().prepare('SELECT COUNT(*) AS n FROM notification_outbox').get() as { n: number }).n;
  assert.equal(after, before);
});

test('by default the email contains no personal data; details only when enabled', () => {
  const e = { id: 7, reference: 'ENQ-20261018-ABCDEF', createdAt: new Date().toISOString(), name: 'Asha Verma', phone: '9876543210', email: 'asha@example.com', service: 'ac-service', regionName: 'Goa', location: 'Panaji', message: 'Private message' };
  const minimal = buildEnquiryEmail(e, config);
  for (const pii of ['Asha Verma', '9876543210', 'asha@example.com', 'Panaji', 'Private message']) {
    assert.ok(!minimal.text.includes(pii) && !minimal.subject.includes(pii), pii);
  }
  assert.ok(minimal.text.includes('ENQ-20261018-ABCDEF') && minimal.text.includes('/admin/enquiries/7'));
  const detailed = buildEnquiryEmail(e, { ...config, includeDetails: true });
  assert.ok(detailed.text.includes('Asha Verma') && detailed.text.includes('Private message'));
  assert.ok(!detailed.subject.includes('Asha Verma'), 'customer data never goes in a header');
});

test('subject can never carry header injection, whatever the data', async () => {
  const e = { id: 8, reference: 'ENQ-20261018-ABCDEF\r\nBcc: attacker@example.com', createdAt: new Date().toISOString(), name: 'x', phone: '1', email: '', service: 's', regionName: null, location: 'l', message: '' };
  const { createTransport } = await import('../../src/lib/server/mailer.ts');
  const transport = createTransport(config); // mock: writes to <test storage>/mail-outbox
  await transport.send(buildEnquiryEmail(e, config));
  const dir = join(storage, 'mail-outbox');
  assert.ok(existsSync(dir));
  const files = readdirSync(dir);
  const written = JSON.parse(readFileSync(join(dir, files[files.length - 1]), 'utf8'));
  assert.ok(!/[\r\n]/.test(written.subject));
});

test('transport errors are reduced to short categories', () => {
  assert.equal(categorizeMailError(Object.assign(new Error('x'), { code: 'EAUTH' })), 'auth_failed');
  assert.equal(categorizeMailError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), 'connection_failed');
  assert.equal(categorizeMailError(Object.assign(new Error('x'), { responseCode: 550 })), 'rejected');
  assert.equal(categorizeMailError(Object.assign(new Error('x'), { responseCode: 451 })), 'temporary_failure');
  assert.equal(categorizeMailError(new MailSendError('mock_failure')), 'mock_failure');
  assert.equal(categorizeMailError(new Error('anything else, including user@example.com')), 'send_failed');
});
