import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import sharp from 'sharp';

const storage = mkdtempSync(join(tmpdir(), 'vk-unit-test-images-'));
process.env.STORAGE_DIR = storage;
const { processImage, saveProcessedImage, resolveUploadPath, deleteStoredImage, uploadsDir, IMAGE_LIMITS } = await import('../../src/lib/server/images.ts');

after(() => rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const solid = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 5, g: 38, b: 89 } } });
const jpeg = (w = 64, h = 48) => solid(w, h).jpeg().toBuffer();
const png = (w = 64, h = 48) => solid(w, h).png().toBuffer();

async function expectReject(input: Buffer | Promise<Buffer>, reason: string, claimed?: string, limits = IMAGE_LIMITS) {
  const r = await processImage(await input, claimed, limits);
  assert.equal(r.ok, false, `expected rejection "${reason}"`);
  if (!r.ok) assert.equal(r.reason, reason);
}

test('accepts JPEG, PNG, WebP and AVIF and re-encodes all of them to WebP', async () => {
  const inputs: [string, Buffer, string][] = [
    ['jpeg', await jpeg(), 'image/jpeg'],
    ['png', await png(), 'image/png'],
    ['webp', await solid(64, 48).webp().toBuffer(), 'image/webp'],
    ['avif', await solid(64, 48).avif().toBuffer(), 'image/avif'],
  ];
  for (const [fmt, buf, type] of inputs) {
    const r = await processImage(buf, type);
    assert.ok(r.ok, `${fmt}: ${r.ok ? '' : r.reason}`);
    if (!r.ok) continue;
    assert.equal(r.sourceFormat, fmt);
    assert.equal((await sharp(r.image).metadata()).format, 'webp');
    assert.equal((await sharp(r.thumbnail).metadata()).format, 'webp');
    assert.match(r.id, /^[0-9a-f-]{36}$/);
  }
});

test('the claimed MIME type is optional but must match the real contents', async () => {
  assert.ok((await processImage(await png())).ok, 'no claim is fine');
  await expectReject(png(), 'type_mismatch', 'image/jpeg');
  await expectReject(jpeg(), 'type_mismatch', 'image/png');
  await expectReject(jpeg(), 'type_mismatch', 'text/html');
});

test('rejects SVG — even when disguised with a PNG name/type', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script><rect width="64" height="64"/></svg>');
  await expectReject(svg, 'svg_not_allowed', 'image/svg+xml');
  await expectReject(svg, 'svg_not_allowed', 'image/png');
  await expectReject(Buffer.from(`<?xml version="1.0"?>\n${svg}`), 'svg_not_allowed');
  await expectReject(Buffer.from(`   \n\n${svg}`), 'svg_not_allowed');
});

test('rejects non-images, truncated files and unsupported formats', async () => {
  await expectReject(Buffer.from('this is not an image, just text named photo.jpg'), 'unreadable', 'image/jpeg');
  await expectReject(Buffer.from('<?php system($_GET["c"]); ?>'), 'unreadable', 'image/jpeg');
  const full = await solid(400, 300).jpeg({ quality: 90 }).toBuffer();
  await expectReject(full.subarray(0, Math.floor(full.length / 2)), 'unreadable', 'image/jpeg');
  await expectReject(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), 'unreadable');
  await expectReject(solid(64, 48).gif().toBuffer(), 'unsupported_format');
  await expectReject(solid(64, 48).tiff().toBuffer(), 'unsupported_format');
  await expectReject(Buffer.alloc(0), 'empty');
});

test('rejects animated / multi-page images', async () => {
  const frame = (c: string) => sharp({ create: { width: 32, height: 32, channels: 3, background: c } }).png().toBuffer();
  const animated = await sharp([await frame('#021024'), await frame('#c1e8ff')], { join: { animated: true } })
    .webp({ loop: 0, delay: [100, 100] })
    .toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2, 'fixture should have 2 frames');
  await expectReject(animated, 'animated_not_allowed', 'image/webp');
});

test('enforces byte size, dimension and pixel limits', async () => {
  const small = { ...IMAGE_LIMITS, maxBytes: 1000 };
  await expectReject(solid(400, 400).png({ compressionLevel: 0 }).toBuffer(), 'too_large', undefined, small);
  await expectReject(png(10, 64), 'too_small');
  await expectReject(png(64, 10), 'too_small');
  const tight = { ...IMAGE_LIMITS, maxSide: 200, maxPixels: 30_000 };
  await expectReject(png(300, 50), 'too_big_dimensions', undefined, tight);
  await expectReject(png(190, 190), 'too_many_pixels', undefined, tight); // 36,100 px > 30,000
  // Decompression bomb: tiny file, huge declared canvas.
  const bomb = await solid(4000, 4000).png({ compressionLevel: 9 }).toBuffer();
  assert.ok(bomb.length < 200_000, 'fixture is small on disk');
  await expectReject(bomb, 'too_many_pixels', undefined, { ...IMAGE_LIMITS, maxPixels: 1_000_000 });
});

test('output is capped in size, EXIF orientation applied and metadata (incl. GPS) stripped', async () => {
  const withExif = await solid(3000, 1000)
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExifMerge({ IFD0: { Make: 'TestCam' }, IFD3: { GPSLatitude: '26/1 54/1 0/1', GPSLatitudeRef: 'N' } })
    .toBuffer();
  const inMeta = await sharp(withExif).metadata();
  assert.equal(inMeta.orientation, 6);
  assert.ok(inMeta.exif, 'fixture has EXIF');
  const r = await processImage(withExif, 'image/jpeg');
  assert.ok(r.ok);
  if (!r.ok) return;
  const out = await sharp(r.image).metadata();
  assert.equal(out.exif, undefined, 'EXIF (incl. GPS) removed');
  assert.equal(out.orientation, undefined);
  // Orientation 6 = rotate 90°: a 3000x1000 source becomes portrait, then capped to 2560 on the long side.
  assert.equal(out.width, 853);
  assert.equal(out.height, 2560);
  assert.ok(Math.max((await sharp(r.thumbnail).metadata()).width!, (await sharp(r.thumbnail).metadata()).height!) <= IMAGE_LIMITS.thumbMaxSide);
});

test('stored files get random server names inside STORAGE_DIR/uploads only, never overwriting', async () => {
  const r = await processImage(await png(), 'image/png');
  assert.ok(r.ok);
  if (!r.ok) return;
  const { main, thumb } = saveProcessedImage(r);
  assert.equal(main, `${r.id}.webp`);
  assert.equal(thumb, `${r.id}-thumb.webp`);
  const dir = uploadsDir();
  assert.ok(dir.startsWith(storage + sep));
  assert.deepEqual(readdirSync(dir).sort(), [main, thumb].sort());
  assert.throws(() => saveProcessedImage(r), /EEXIST/, 'never overwrites an existing upload');
  deleteStoredImage(r.id);
  assert.equal(existsSync(join(dir, main)), false);
});

test('resolveUploadPath only accepts exact server-generated names (no traversal)', () => {
  const id = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
  assert.ok(resolveUploadPath(`${id}.webp`)?.startsWith(uploadsDir() + sep));
  assert.ok(resolveUploadPath(`${id}-thumb.webp`));
  for (const bad of [
    '../vk-solar.db',
    '..\\vk-solar.db',
    `../${id}.webp`,
    `${id}.webp/../../secret.key`,
    `${id}.svg`,
    `${id}.webp.exe`,
    `/etc/${id}.webp`,
    `C:\\${id}.webp`,
    `%2e%2e%2f${id}.webp`,
    `${id.toUpperCase()}.webp`,
    'photo.webp',
    '',
  ]) {
    assert.equal(resolveUploadPath(bad), null, bad);
  }
  // deleteStoredImage with a hostile id is a no-op.
  assert.doesNotThrow(() => deleteStoredImage('../../vk-solar'));
});
