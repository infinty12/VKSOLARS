/** Business details: validation, draft/publish isolation, revisions — against disposable storage. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const storage = mkdtempSync(join(tmpdir(), 'vk-unit-test-content-'));
process.env.STORAGE_DIR = storage;
const { getDb, closeDb } = await import('../../src/lib/server/db.ts');
const C = await import('../../src/lib/server/site-content.ts');
const { defaultBusiness } = await import('../../src/config/site.ts');

after(() => {
  closeDb();
  rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const valid = (input: Record<string, string>) => {
  const r = C.validateBusiness(input);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  return r.ok ? r.value : (null as never);
};
const invalid = (input: Record<string, string>, field: string) => {
  const r = C.validateBusiness(input);
  assert.equal(r.ok, false, `${JSON.stringify(input)} should be rejected`);
  if (!r.ok) assert.ok(field in r.errors, `expected an error on ${field}: ${JSON.stringify(r.errors)}`);
};

test('empty input is valid and means "hide everything"', () => {
  const v = valid({});
  assert.deepEqual(v.contact, { phone: null, phoneDisplay: null, whatsapp: null, email: null, address: null, hours: null });
  assert.deepEqual(v.social, { linkedin: null, instagram: null, facebook: null, youtube: null });
  assert.equal(v.founded, null);
  assert.deepEqual(valid({ phone: '   ', email: '\n' }).contact.phone, null);
});

test('phone, display form and WhatsApp are normalised and checked', () => {
  const v = valid({ phone: '+91 98765-43210', phoneDisplay: '+91 98765 43210', whatsapp: '+91 (98765) 43210' });
  assert.equal(v.contact.phone, '+919876543210');
  assert.equal(v.contact.phoneDisplay, '+91 98765 43210');
  assert.equal(v.contact.whatsapp, '919876543210');
  invalid({ phone: '98765 43210' }, 'phone'); // no country code
  invalid({ phone: '+91 98765 abc' }, 'phone');
  invalid({ phone: 'tel:+919876543210' }, 'phone');
  invalid({ phoneDisplay: '+91 98765 43210' }, 'phoneDisplay'); // display without a number
  invalid({ phone: '+919876543210', phoneDisplay: '+91 11111 11111' }, 'phoneDisplay'); // different number
  invalid({ phone: '+919876543210', phoneDisplay: '<b>+91</b> 9876543210' }, 'phoneDisplay');
  invalid({ whatsapp: '12' }, 'whatsapp');
});

test('email and social links are strictly validated', () => {
  assert.equal(valid({ email: 'Info@Example.COM' }).contact.email, 'info@example.com');
  for (const bad of ['not-an-email', 'a@b', 'x@example.com<script>', '"a"@example.com', 'a@exam ple.com']) invalid({ email: bad }, 'email');

  assert.equal(valid({ linkedin: 'https://www.linkedin.com/company/example' }).social.linkedin, 'https://www.linkedin.com/company/example');
  assert.equal(valid({ youtube: 'https://youtu.be/abc' }).social.youtube, 'https://youtu.be/abc');
  for (const bad of [
    'http://linkedin.com/company/x', // not https
    'javascript:alert(1)',
    'https://linkedin.com.evil.example/x', // look-alike host
    'https://evil.example/?u=linkedin.com',
    'https://user:pass@linkedin.com/x',
    'https://linkedin.com:8443/x',
    'linkedin.com/company/x',
    'https://facebook.com/x', // wrong network for the field
  ])
    invalid({ linkedin: bad }, 'linkedin');
});

test('address and hours keep line breaks but nothing else; limits are enforced', () => {
  const v = valid({ address: '  Plot 1, Example Road \r\n\r\n  City   402‮ 001\u0000 ', hours: 'Mon–Sat\n9:00–18:00' });
  assert.equal(v.contact.address, 'Plot 1, Example Road\nCity 402 001');
  assert.equal(v.contact.hours, 'Mon–Sat\n9:00–18:00');
  invalid({ address: 'x'.repeat(C.LIMITS.address + 1) }, 'address');
  invalid({ address: Array(C.LIMITS.addressLines + 1).fill('line').join('\n') }, 'address');
  invalid({ hours: Array(C.LIMITS.hoursLines + 1).fill('h').join('\n') }, 'hours');
  // HTML is not stripped or interpreted: it is kept as plain text and escaped when rendered.
  assert.equal(valid({ address: '<script>alert(1)</script>' }).contact.address, '<script>alert(1)</script>');
});

test('founding year must be a real past year', () => {
  assert.equal(valid({ founded: '2015' }).founded, 2015);
  for (const bad of ['1899', String(new Date().getFullYear() + 1), '20 15', '2015.5', 'abcd']) invalid({ founded: bad }, 'founded');
});

test('drafts never change what is published; publishing does', () => {
  assert.deepEqual(C.publicBusiness(), defaultBusiness, 'nothing published → built-in defaults');
  const v = valid({ phone: '+919876543210', email: 'office@example.com' });

  const d1 = C.saveDraft(v, null);
  assert.equal(C.contentState().draftId, d1.id);
  assert.deepEqual(C.publicBusiness(), defaultBusiness, 'a draft is not public');
  assert.deepEqual(C.editorBusiness(), v, 'the editor shows the draft');

  const p = C.publishDraft(null);
  assert.deepEqual(p, { ok: true, revisionId: d1.id });
  assert.deepEqual(C.publicBusiness(), v);
  assert.deepEqual(C.contentState(), { draftId: null, publishedId: d1.id });
  assert.deepEqual(C.publishDraft(null), { ok: false }, 'nothing to publish');

  const v2 = valid({ phone: '+919876543210', email: 'new@example.com', hours: 'Mon–Fri' });
  const d2 = C.saveDraft(v2, null);
  assert.deepEqual(C.publicBusiness(), v, 'still the published version');
  assert.deepEqual(C.changedFields(v, v2), ['email', 'hours']);

  assert.equal(C.discardDraft(null), true);
  assert.equal(C.getDraft(), null);
  assert.deepEqual(C.publicBusiness(), v);
  assert.equal(C.discardDraft(null), false);
  assert.ok(C.getRevision(d2.id), 'a discarded draft stays in the history');
});

test('revision history and restore', () => {
  const before = C.listRevisions().length;
  const v3 = valid({ email: 'third@example.com' });
  C.saveDraft(v3, null);
  C.publishDraft(null);
  const list = C.listRevisions();
  assert.equal(list.length, before + 1);
  assert.equal(list[0].status, 'live');
  assert.ok(list.some((r) => r.status === 'previously_live'));
  assert.ok(list.some((r) => r.status === 'unpublished'), 'the discarded draft');

  const old = list.find((r) => r.status === 'previously_live')!;
  const restored = C.restoreRevision(old.id, null)!;
  assert.equal(restored.restoredFrom, old.id);
  assert.deepEqual(restored.data, old.data);
  assert.deepEqual(C.publicBusiness(), v3, 'restoring only creates a draft');
  assert.equal(C.listRevisions()[0].status, 'draft');
  C.publishDraft(null);
  assert.deepEqual(C.publicBusiness(), old.data);
  assert.equal(C.restoreRevision(999999, null), null);
});

test('audit entries record revision ids and field names, never values', () => {
  const rows = getDb().prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'content.%'").all() as { action: string; detail: string }[];
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ['content.draft', 'content.publish', 'content.discard', 'content.restore']) assert.ok(actions.has(a), a);
  const all = JSON.stringify(rows);
  for (const secret of ['example.com', '9876543210', 'Mon–Fri']) assert.ok(!all.includes(secret), `audit must not contain ${secret}`);
});

test('stored data is re-validated on read: a tampered row cannot inject unsafe values', () => {
  const evil = JSON.stringify({
    contact: { phone: 'javascript:alert(1)', phoneDisplay: '<img src=x onerror=alert(1)>', email: 'ok@example.com', whatsapp: 12 },
    social: { linkedin: 'javascript:alert(1)', facebook: 'https://facebook.com/vk' },
    founded: 'soon',
    extra: '<script>',
  });
  const id = Number(getDb().prepare("INSERT INTO content_revisions (scope, data, created_at) VALUES ('business', ?, ?)").run(evil, new Date().toISOString()).lastInsertRowid);
  const rev = C.getRevision(id)!;
  assert.equal(rev.data.contact.phone, null);
  assert.equal(rev.data.contact.phoneDisplay, null);
  assert.equal(rev.data.contact.whatsapp, null);
  assert.equal(rev.data.contact.email, 'ok@example.com');
  assert.equal(rev.data.social.linkedin, null);
  assert.equal(rev.data.social.facebook, 'https://facebook.com/vk');
  assert.equal(rev.data.founded, null);
  assert.ok(!('extra' in rev.data));
});

test('public pages fall back to the built-in defaults if the database cannot be read', () => {
  const r = C.publicBusiness(() => {
    throw new Error('SQLITE_CANTOPEN');
  });
  assert.deepEqual(r, defaultBusiness);
});
