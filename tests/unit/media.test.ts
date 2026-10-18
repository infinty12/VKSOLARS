/** Media library against disposable storage. Images are generated in memory with Sharp. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const storage = mkdtempSync(join(tmpdir(), 'vk-unit-test-media-'));
process.env.STORAGE_DIR = storage;
const { getDb, closeDb } = await import('../../src/lib/server/db.ts');
const M = await import('../../src/lib/server/media.ts');
const { IMAGE_LIMITS } = await import('../../src/lib/server/images.ts');

after(() => {
  closeDb();
  rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const solid = (w = 64, h = 48) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 84, g: 131, b: 179 } } });
const uploads = () => (existsSync(join(storage, 'uploads')) ? readdirSync(join(storage, 'uploads')).sort() : []);
const auditRows = () => getDb().prepare('SELECT action, target_id AS targetId, detail FROM audit_log ORDER BY id').all() as { action: string; targetId: string | null; detail: string | null }[];

async function upload(over: Partial<Parameters<typeof M.uploadMedia>[0]> = {}) {
  return M.uploadMedia({ data: await solid().jpeg().toBuffer(), claimedType: 'image/jpeg', originalName: 'roof.jpg', altText: 'A roof', userId: null, ...over });
}

test('a valid upload is re-encoded, stored under a random name and registered', async () => {
  const before = uploads().length;
  const r = await upload({ originalName: 'Site photo.JPG', altText: '  Panels  on a\nroof  ' });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.match(r.item.uid, /^[0-9a-f-]{36}$/);
  assert.equal(r.item.mimeType, 'image/webp');
  assert.equal(r.item.sourceFormat, 'jpeg');
  assert.equal(r.item.altText, 'Panels on a roof');
  assert.equal(r.item.originalName, 'Site photo.JPG');
  assert.deepEqual([r.item.width, r.item.height], [64, 48]);
  assert.equal(r.item.usageCount, 0);
  assert.equal(uploads().length, before + 2);
  assert.ok(uploads().includes(`${r.item.uid}.webp`) && uploads().includes(`${r.item.uid}-thumb.webp`));
  assert.ok(!uploads().some((f) => /photo|jpg/i.test(f)), 'the uploaded name is never used on disk');
  assert.equal(M.mediaUrl(r.item.uid), `/media/${r.item.uid}.webp`);
  assert.equal(M.getMediaByUid(r.item.uid)?.id, r.item.id);
});

test('uploaded file names are kept only as a sanitised label', () => {
  assert.equal(M.safeOriginalName('../../etc/passwd.jpg'), 'passwd.jpg');
  assert.equal(M.safeOriginalName('C:\\Users\\me\\Desktop\\site.png'), 'site.png');
  assert.equal(M.safeOriginalName('evil\u202Egnp.exe'), 'evilgnp.exe', 'bidi override removed');
  assert.equal(M.safeOriginalName('a\u0000b\r\nc.jpg'), 'abc.jpg');
  assert.equal(M.safeOriginalName('x'.repeat(500)).length, M.MEDIA.nameMax);
  assert.equal(M.safeOriginalName(undefined), '');
});

test('invalid, misleading, oversized and malformed files are refused and nothing is stored', async () => {
  const before = uploads().length;
  const count = () => (getDb().prepare('SELECT COUNT(*) AS n FROM media').get() as { n: number }).n;
  const rows = count();
  const cases: [string, Parameters<typeof M.uploadMedia>[0]][] = [
    ['unreadable', { data: Buffer.from('not an image at all'), claimedType: 'image/png', originalName: 'x.png', userId: null }],
    ['type_mismatch', { data: await solid().jpeg().toBuffer(), claimedType: 'image/png', originalName: 'x.png', userId: null }],
    ['svg_not_allowed', { data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), claimedType: 'image/png', userId: null }],
    ['unsupported_format', { data: await solid().gif().toBuffer(), claimedType: 'image/gif', userId: null }],
    ['too_large', { data: await solid().png().toBuffer(), claimedType: 'image/png', userId: null, limits: { ...IMAGE_LIMITS, maxBytes: 100 } }],
    ['unreadable', { data: (await solid(400, 300).jpeg().toBuffer()).subarray(0, 600), claimedType: 'image/jpeg', userId: null }],
    ['empty', { data: Buffer.alloc(0), claimedType: 'image/jpeg', userId: null }],
  ];
  for (const [reason, input] of cases) {
    const r = await M.uploadMedia(input);
    assert.equal(r.ok, false, reason);
    if (!r.ok) assert.equal(r.reason, reason);
  }
  const longAlt = await upload({ altText: 'x'.repeat(M.MEDIA.altMax + 1) });
  assert.equal(longAlt.ok, false);
  assert.equal(uploads().length, before, 'no files written');
  assert.equal(count(), rows, 'no rows written');
  const rejected = auditRows().filter((a) => a.action === 'media.upload_rejected');
  assert.ok(rejected.length >= cases.length);
  assert.ok(rejected.every((a) => /^\{"reason":"[a-z_]+"\}$/.test(a.detail ?? '')), 'audit holds the reason only');
});

test('alt text can be updated and is validated; audit records the length only', async () => {
  const r = await upload();
  assert.ok(r.ok);
  if (!r.ok) return;
  const alt = 'Inverter room with <b>two</b> inverters';
  assert.deepEqual(M.updateAltText(r.item.id, alt, null), { ok: true });
  assert.equal(M.getMedia(r.item.id)!.altText, alt, 'stored as plain text (escaped on output)');
  assert.equal(M.updateAltText(r.item.id, 'x'.repeat(M.MEDIA.altMax + 1), null).ok, false);
  assert.equal(M.updateAltText(999999, 'x', null).ok, false);
  const row = auditRows().filter((a) => a.action === 'media.alt').pop()!;
  assert.equal(row.targetId, String(r.item.id));
  assert.equal(row.detail, JSON.stringify({ length: alt.length }));
  assert.ok(!JSON.stringify(auditRows()).includes('Inverter room'), 'alt text content never reaches the audit log');
});

test('search matches alt text and file name, with LIKE wildcards escaped', async () => {
  const tag = `zx${Date.now().toString(36)}`;
  await upload({ originalName: `${tag}-file.png`, data: await solid().png().toBuffer(), claimedType: 'image/png', altText: '' });
  await upload({ altText: `Drone over ${tag}` });
  assert.equal(M.listMedia({ q: tag }).total, 2);
  assert.equal(M.listMedia({ q: `${tag}-file` }).total, 1);
  assert.equal(M.listMedia({ q: '%' }).total, 0, '% is a literal, not a wildcard');
  assert.equal(M.listMedia({ q: '_' }).total, 0);
});

test('an image in use cannot be deleted; an unused one is removed with its files', async () => {
  const r = await upload();
  assert.ok(r.ok);
  if (!r.ok) return;
  M.addMediaUsage(r.item.id, 'page', 'home-hero');
  M.addMediaUsage(r.item.id, 'page', 'home-hero'); // idempotent
  assert.equal(M.getMedia(r.item.id)!.usageCount, 1);

  assert.deepEqual(M.deleteMedia(r.item.id, null), { ok: false, reason: 'in_use', usages: 1 });
  assert.ok(M.getMedia(r.item.id) && uploads().includes(`${r.item.uid}.webp`), 'still there');
  // The database refuses too, even if application code were bypassed.
  assert.throws(() => getDb().prepare('DELETE FROM media WHERE id = ?').run(r.item.id), /FOREIGN KEY/);

  M.removeMediaUsage(r.item.id, 'page', 'home-hero');
  assert.deepEqual(M.deleteMedia(r.item.id, null), { ok: true });
  assert.equal(M.getMedia(r.item.id), null);
  assert.ok(!uploads().includes(`${r.item.uid}.webp`) && !uploads().includes(`${r.item.uid}-thumb.webp`));
  assert.deepEqual(M.deleteMedia(r.item.id, null), { ok: false, reason: 'not_found' });

  const actions = auditRows().map((a) => a.action);
  assert.ok(actions.includes('media.delete_refused') && actions.includes('media.delete') && actions.includes('media.upload'));
});

test('lookups by uid and id reject anything that is not a valid identifier', () => {
  for (const bad of ['../vk-solar', '', 'not-a-uuid', '00000000-0000-0000-0000-00000000000g']) assert.equal(M.getMediaByUid(bad), null);
  assert.equal(M.getMedia(NaN), null);
  assert.equal(M.getMedia(-1), null);
});

test('uploads are rate limited per administrator', () => {
  const user = 900001;
  for (let i = 0; i < M.MEDIA.uploadsPerWindow; i++) assert.equal(M.uploadRateLimit(user), null);
  assert.ok((M.uploadRateLimit(user) ?? 0) > 0);
  assert.equal(M.uploadRateLimit(user + 1), null, 'other administrators are unaffected');
});

test('thumbnail size keeps the aspect ratio and never enlarges', () => {
  assert.deepEqual(M.thumbSize({ width: 2560, height: 1280 }), { width: 480, height: 240 });
  assert.deepEqual(M.thumbSize({ width: 100, height: 50 }), { width: 100, height: 50 });
});
