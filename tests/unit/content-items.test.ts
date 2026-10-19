/** Verified content items: validation, publishing rules, draft isolation, ordering, media usage. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const storage = mkdtempSync(join(tmpdir(), 'vk-unit-test-items-'));
process.env.STORAGE_DIR = storage;
const { getDb, closeDb } = await import('../../src/lib/server/db.ts');
const C = await import('../../src/lib/server/content-items.ts');
const M = await import('../../src/lib/server/media.ts');

after(() => {
  closeDb();
  rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const ok = (kind: Parameters<typeof C.validateItem>[0], input: Record<string, unknown>) => {
  const r = C.validateItem(kind, input);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  return r.ok ? r.value : (null as never);
};
const errs = (kind: Parameters<typeof C.validateItem>[0], input: Record<string, unknown>) => {
  const r = C.validateItem(kind, input);
  assert.equal(r.ok, false, JSON.stringify(input));
  return r.ok ? {} : r.errors;
};

async function uploadPhoto(alt = 'Portrait photo') {
  const data = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 5, g: 38, b: 89 } } }).png().toBuffer();
  const r = await M.uploadMedia({ data, claimedType: 'image/png', originalName: 'p.png', altText: alt, userId: null });
  assert.ok(r.ok);
  return r.ok ? r.item : (null as never);
}

test('validation: required fields, limits, whole-number figures, plain text only', () => {
  assert.deepEqual(Object.keys(errs('stat', {})).sort(), ['label', 'value']);
  for (const bad of ['12.5', '-3', '1e3', 'abc', '1000000000']) assert.ok('value' in errs('stat', { value: bad, label: 'x' }), bad);
  assert.equal(ok('stat', { value: '1,250', label: 'Plants', suffix: '+' }).value, 1250);
  assert.ok('suffix' in errs('stat', { value: '1', label: 'x', suffix: '<b>' }));
  assert.ok('label' in errs('stat', { value: '1', label: 'x'.repeat(61) }));
  assert.ok('quote' in errs('testimonial', { name: 'A' }));
  assert.ok('quote' in errs('testimonial', { quote: 'q'.repeat(601), name: 'A' }));
  assert.ok('photoId' in errs('team', { name: 'A', role: 'B', photoId: '999999' }), 'photo must exist in the library');
  assert.ok('photoId' in errs('team', { name: 'A', role: 'B', photoId: '../1' }));
  const q = ok('testimonial', { quote: '  Great\r\n\r\nwork <script>x</script>‮ ', name: ' A  B ' });
  assert.equal(q.quote, 'Great\nwork <script>x</script>', 'line breaks kept, invisible chars removed, HTML kept as text');
  assert.equal(q.name, 'A B');
  assert.equal(q.approved, false, 'checkboxes are never pre-ticked');
});

test('publishing requires source/approval/consent/evidence — never satisfied automatically', () => {
  const stat = ok('stat', { value: '10', label: 'Sites' });
  assert.equal(C.publishProblems('stat', stat).length, 2);
  assert.deepEqual(C.publishProblems('stat', ok('stat', { value: '10', label: 'Sites', source: 'Job log 2026', verified: 'on' })), []);
  assert.equal(C.publishProblems('testimonial', ok('testimonial', { quote: 'q', name: 'n', approved: 'on' })).length, 1, 'approval record needed');
  assert.equal(C.publishProblems('testimonial', ok('testimonial', { quote: 'q', name: 'n', approvalNote: 'Email 1 Oct' })).length, 1, 'approval tick needed');
  assert.equal(C.publishProblems('team', ok('team', { name: 'n', role: 'r' })).length, 1);
  assert.equal(C.publishProblems('achievement', ok('achievement', { text: 't', verified: 'on' })).length, 1);

  const id = C.createItem('stat', stat, null);
  const r = C.publishItem(id, null);
  assert.equal(r.ok, false);
  assert.equal(C.publicContent().stats.length, 0);
  C.deleteItem(id, null);
});

test('drafts are private; publish, edit, discard and unpublish behave as snapshots', () => {
  const v1 = ok('testimonial', { quote: 'Version one', name: 'Client A', approvalNote: 'Signed form', approved: 'on' });
  const id = C.createItem('testimonial', v1, null);
  assert.equal(C.getItem(id)!.status, 'draft');
  assert.equal(C.publicContent().testimonials.length, 0, 'a new draft is not public');
  assert.equal(C.draftPreviewContent().testimonials.length, 1, 'but appears in the admin preview');

  assert.deepEqual(C.publishItem(id, null), { ok: true });
  assert.deepEqual(C.publicContent().testimonials, [{ quote: 'Version one', name: 'Client A', role: '', organisation: '' }]);
  assert.equal(C.getItem(id)!.status, 'published');

  C.saveItemDraft(id, { ...v1, quote: 'Version two' }, null);
  assert.equal(C.getItem(id)!.status, 'changed');
  assert.equal(C.publicContent().testimonials[0].quote, 'Version one', 'edits stay private until republished');
  assert.equal(C.draftPreviewContent().testimonials[0].quote, 'Version two');

  assert.equal(C.discardItemChanges(id, null), true);
  assert.equal(C.getItem(id)!.draft!.quote, 'Version one');
  assert.equal(C.getItem(id)!.status, 'published');

  assert.deepEqual(C.deleteItem(id, null), { ok: false, reason: 'published' }, 'unpublish before deleting');
  assert.equal(C.unpublishItem(id, null), true);
  assert.equal(C.publicContent().testimonials.length, 0);
  assert.deepEqual(C.deleteItem(id, null), { ok: true });
  assert.equal(C.getItem(id), null);
});

test('public data never contains internal notes', () => {
  const id = C.createItem('stat', ok('stat', { value: '42', label: 'Inspections', suffix: 'MW', source: 'SECRET-SOURCE-NOTE', verified: 'on' }), null);
  C.publishItem(id, null);
  const a = C.createItem('achievement', ok('achievement', { text: 'Certified installer', evidence: 'SECRET-EVIDENCE', verified: 'on' }), null);
  C.publishItem(a, null);
  const pub = C.publicContent();
  assert.deepEqual(pub.stats, [{ value: 42, suffix: ' MW', label: 'Inspections' }], 'unit suffix gets a space');
  assert.deepEqual(pub.achievements, ['Certified installer']);
  const all = JSON.stringify([pub, C.draftPreviewContent()]);
  assert.ok(!all.includes('SECRET'), 'sources/evidence never leave the admin');
  C.unpublishItem(id, null);
  C.unpublishItem(a, null);
  C.deleteItem(id, null);
  C.deleteItem(a, null);
});

test('ordering: move up/down, immediately reflected in the published order', () => {
  const ids = ['First', 'Second', 'Third'].map((t) => {
    const id = C.createItem('achievement', ok('achievement', { text: t, evidence: 'e', verified: 'on' }), null);
    C.publishItem(id, null);
    return id;
  });
  assert.deepEqual(C.publicContent().achievements, ['First', 'Second', 'Third']);
  assert.equal(C.moveItem(ids[2], 'up', null), true);
  assert.deepEqual(C.publicContent().achievements, ['First', 'Third', 'Second']);
  assert.equal(C.moveItem(ids[0], 'up', null), false, 'already first');
  assert.equal(C.moveItem(ids[1], 'down', null), false, 'already last');
  assert.equal(C.moveItem(ids[0], 'down', null), true);
  assert.deepEqual(C.publicContent().achievements, ['Third', 'First', 'Second']);
  for (const id of ids) {
    C.unpublishItem(id, null);
    C.deleteItem(id, null);
  }
});

test('team photos: usage is tracked for draft and published versions and blocks media deletion', async () => {
  const photo = await uploadPhoto('Sample portrait at a rooftop plant');
  const other = await uploadPhoto('');
  const id = C.createItem('team', ok('team', { name: 'Test Person', role: 'Engineer', photoId: String(photo.id), consent: 'on' }), null);
  assert.equal(M.getMedia(photo.id)!.usageCount, 1, 'draft reference recorded');
  assert.deepEqual(M.deleteMedia(photo.id, null), { ok: false, reason: 'in_use', usages: 1 });

  C.publishItem(id, null);
  assert.equal(M.getMedia(photo.id)!.usageCount, 2, 'draft + published');
  const member = C.publicContent().team[0];
  assert.equal(member.photo!.src, `/media/${photo.uid}-thumb.webp`);
  assert.equal(member.photo!.alt, 'Sample portrait at a rooftop plant', 'uses the media alt text');

  // Switch the draft to another photo: the published one is still in use until republished.
  C.saveItemDraft(id, { ...C.getItem(id)!.draft!, photoId: other.id }, null);
  assert.equal(M.getMedia(photo.id)!.usageCount, 1);
  assert.equal(M.getMedia(other.id)!.usageCount, 1);
  assert.equal(M.deleteMedia(photo.id, null).ok, false);
  C.publishItem(id, null);
  assert.equal(M.getMedia(photo.id)!.usageCount, 0, 'released after republishing');
  assert.equal(C.publicContent().team[0].photo!.alt, 'Portrait of Test Person', 'fallback alt text');
  assert.deepEqual(M.deleteMedia(photo.id, null), { ok: true });

  C.unpublishItem(id, null);
  assert.equal(M.getMedia(other.id)!.usageCount, 1, 'draft still uses it');
  C.deleteItem(id, null);
  assert.equal(M.getMedia(other.id)!.usageCount, 0, 'deleting the item releases it');
  assert.deepEqual(M.deleteMedia(other.id, null), { ok: true });
});

test('7B.1: a photo alt-text change in Media reaches the website only after save + publish', async () => {
  const photo = await uploadPhoto('Alt version one');
  const id = C.createItem('team', ok('team', { name: 'Alt Test (example)', role: 'Role', photoId: String(photo.id), consent: 'on' }), null);
  C.publishItem(id, null);
  const alt = () => C.publicContent().team.find((m) => m.name === 'Alt Test (example)')!.photo!.alt;
  assert.equal(alt(), 'Alt version one');

  // Edit the alt text in the media library: the live profile does not change.
  assert.deepEqual(M.updateAltText(photo.id, 'Alt version two', null), { ok: true });
  assert.equal(alt(), 'Alt version one', 'published copy unchanged');
  assert.equal(C.draftPreviewContent().team.find((m) => m.name === 'Alt Test (example)')!.photo!.alt, 'Alt version one', 'draft unchanged until saved');
  assert.equal(C.getItem(id)!.status, 'published');

  // Saving the draft picks up the new text as an unpublished change; publishing makes it live.
  C.saveItemDraft(id, C.getItem(id)!.draft!, null);
  assert.equal(C.getItem(id)!.status, 'changed');
  assert.equal(C.getItem(id)!.draft!.photoAlt, 'Alt version two');
  assert.equal(alt(), 'Alt version one', 'still not public');
  const save = getDb().prepare("SELECT detail FROM audit_log WHERE action = 'content.item.save' AND target_id = ? ORDER BY id DESC LIMIT 1").get(String(id)) as { detail: string };
  assert.deepEqual(JSON.parse(save.detail).changed, ['photoAlt'], 'audit names the field, not the text');
  C.publishItem(id, null);
  assert.equal(alt(), 'Alt version two');

  C.unpublishItem(id, null);
  C.deleteItem(id, null);
  M.deleteMedia(photo.id, null);
});

test('7B.1: profiles published before alt text was saved with them keep using the library text', async () => {
  const photo = await uploadPhoto('Library alt');
  const now = new Date().toISOString();
  const legacy = JSON.stringify({ name: 'Legacy (example)', role: 'Role', bio: '', photoId: photo.id, consent: true });
  const id = Number(
    getDb().prepare("INSERT INTO content_items (kind, position, draft_data, published_data, published_at, created_at, updated_at) VALUES ('team', 50, ?, ?, ?, ?, ?)").run(legacy, legacy, now, now, now).lastInsertRowid,
  );
  assert.equal(C.publicContent().team.find((m) => m.name === 'Legacy (example)')!.photo!.alt, 'Library alt');
  getDb().prepare('DELETE FROM content_items WHERE id = ?').run(id);
  M.deleteMedia(photo.id, null);
});

test('7B.1: a photo deleted between choosing and saving is refused cleanly — nothing is saved', async () => {
  const photo = await uploadPhoto('Soon gone');
  const count = () => (getDb().prepare("SELECT COUNT(*) AS n FROM content_items WHERE kind = 'team'").get() as { n: number }).n;
  const usages = () => (getDb().prepare("SELECT COUNT(*) AS n FROM media_usages WHERE usage_type = 'Team member'").get() as { n: number }).n;

  // New item: validated while the image existed, then the image disappears (e.g. another process).
  const data = ok('team', { name: 'Race (example)', role: 'Role', photoId: String(photo.id), consent: 'on' });
  const before = { items: count(), usages: usages() };
  getDb().prepare('DELETE FROM media WHERE id = ?').run(photo.id);
  assert.throws(() => C.createItem('team', data, null), C.PhotoUnavailableError);
  assert.deepEqual({ items: count(), usages: usages() }, before, 'no item and no usage rows written');

  // Existing item: its stored draft is untouched.
  const second = await uploadPhoto('Second');
  const id = C.createItem('team', ok('team', { name: 'Race two (example)', role: 'Role' }), null);
  const stored = () => getDb().prepare('SELECT draft_data AS d, updated_at AS u FROM content_items WHERE id = ?').get(id) as { d: string; u: string };
  const snapshot = stored();
  const update = ok('team', { name: 'Race two (example)', role: 'Changed role', photoId: String(second.id) });
  getDb().prepare('DELETE FROM media WHERE id = ?').run(second.id);
  assert.throws(() => C.saveItemDraft(id, update, null), C.PhotoUnavailableError);
  assert.deepEqual(stored(), snapshot, 'draft and timestamp unchanged');
  assert.equal(usages(), before.usages);
  C.deleteItem(id, null);
});

test('tampered rows are re-validated; invalid published items are never shown', () => {
  const now = new Date().toISOString();
  const ins = getDb().prepare('INSERT INTO content_items (kind, position, draft_data, published_data, created_at, updated_at) VALUES (?, 99, ?, ?, ?, ?)');
  const bad = Number(ins.run('stat', '{}', JSON.stringify({ value: 'lots', label: 'x' }), now, now).lastInsertRowid);
  const partial = Number(ins.run('testimonial', '{}', JSON.stringify({ quote: 'Fine', name: 'B', role: 'r'.repeat(500), approved: true }), now, now).lastInsertRowid);
  const pub = C.publicContent();
  assert.equal(pub.stats.length, 0, 'a published stat without a valid figure is skipped');
  assert.deepEqual(pub.testimonials, [{ quote: 'Fine', name: 'B', role: '', organisation: '' }], 'over-long optional field dropped');
  getDb().prepare('DELETE FROM content_items WHERE id IN (?, ?)').run(bad, partial);
});

test('empty published collections stay empty; site.ts lists are used only if the database fails', () => {
  assert.deepEqual(C.publicContent(), { stats: [], testimonials: [], team: [], achievements: [] });
  const fallback = C.publicContent(() => {
    throw new Error('SQLITE_CANTOPEN');
  });
  assert.deepEqual(fallback, C.defaultContent());
});

test('audit entries record ids, kinds and field names — never content', () => {
  const rows = getDb().prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'content.item.%'").all() as { action: string; detail: string }[];
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ['create', 'save', 'publish', 'unpublish', 'discard', 'delete', 'move']) assert.ok(actions.has(`content.item.${a}`), a);
  const all = JSON.stringify(rows);
  for (const s of ['Version', 'Client A', 'SECRET', 'Sample portrait', 'Test Person']) assert.ok(!all.includes(s), s);
});
