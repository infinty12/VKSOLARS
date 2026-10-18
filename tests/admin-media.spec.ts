import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { loginAsAdmin, uniqueName } from './helpers/admin';

// Default test server (enquiries closed) with disposable storage in test-storage/.
const ORIGIN = 'http://127.0.0.1:4397';
const STORAGE = resolve('test-storage');

const solid = (w = 120, h = 80) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 5, g: 38, b: 89 } } });
const png = () => solid().png().toBuffer();
const jpeg = () => solid().jpeg().toBuffer();

/** Upload through the real form; returns the new item's admin id and public URL. */
async function uploadViaForm(page: Page, file: { name: string; mimeType: string; buffer: Buffer }, alt = '') {
  await page.goto('/admin/media');
  await page.getByLabel('Image file').setInputFiles(file);
  if (alt) await page.getByLabel(/^Alt text/).fill(alt);
  await page.getByRole('button', { name: 'Upload image' }).click();
}

async function uploadOk(page: Page, alt = '') {
  const name = `${uniqueName('photo').replace(/\s/g, '-')}.png`;
  await uploadViaForm(page, { name, mimeType: 'image/png', buffer: await png() }, alt);
  await expect(page).toHaveURL(/\/admin\/media\/\d+\?msg=uploaded$/);
  const id = Number(page.url().match(/\/admin\/media\/(\d+)/)![1]);
  const src = (await page.locator('.mdd-preview img').getAttribute('src'))!;
  return { id, src, name };
}

const csrfOf = (page: Page) => page.locator('input[name="_csrf"]').first().inputValue();

test.describe('access control', () => {
  test('signed-out visitors are sent to login', async ({ page }) => {
    for (const path of ['/admin/media', '/admin/media/1']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/admin\/login\?next=/);
    }
  });

  test('signed-out uploads, edits and deletes are refused', async ({ request }) => {
    const posts = [
      request.post('/admin/media', { multipart: { _action: 'upload', image: { name: 'a.png', mimeType: 'image/png', buffer: await png() } }, maxRedirects: 0 }),
      request.post('/admin/media/1', { form: { _action: 'alt', alt: 'x' }, maxRedirects: 0 }),
      request.post('/admin/media/1', { form: { _action: 'delete' }, maxRedirects: 0 }),
    ];
    for (const res of await Promise.all(posts)) {
      expect(res.status()).toBe(303);
      expect(res.headers().location).toMatch(/^\/admin\/login/);
    }
  });

  test('signed-in upload without the CSRF token is rejected', async ({ page }) => {
    await loginAsAdmin(page, '/admin/media');
    const res = await page.request.post('/admin/media', {
      multipart: { _action: 'upload', image: { name: 'a.png', mimeType: 'image/png', buffer: await png() } },
      headers: { Origin: ORIGIN },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(403);
  });

  test('an over-size request is refused before it is read', async ({ page }) => {
    await loginAsAdmin(page, '/admin/media');
    const res = await page.request.post('/admin/media', {
      multipart: { _csrf: await csrfOf(page), _action: 'upload', image: { name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(9 * 1024 * 1024, 1) } },
      headers: { Origin: ORIGIN },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(413);
  });
});

test.describe('uploading', () => {
  test('upload, add alt text, then find it in the library', async ({ page }) => {
    await loginAsAdmin(page, '/admin/media');
    const { id, src, name } = await uploadOk(page);
    await expect(page.getByRole('status').filter({ hasText: 'Image uploaded' })).toBeVisible();
    expect(src).toMatch(/^\/media\/[0-9a-f-]{36}\.webp$/);
    await expect(page.locator('.mdd-dl')).toContainText(name);
    await expect(page.locator('.mdd-dl')).toContainText('120 × 80 px');
    await expect(page.locator('.mdd-dl')).toContainText('uploaded as PNG');

    const alt = uniqueName('Engineer checking inverter');
    await page.getByLabel('Description of the image').fill(alt);
    await page.getByRole('button', { name: 'Save alt text' }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/media/${id}\\?msg=saved$`));
    await expect(page.getByRole('status').filter({ hasText: 'Changes saved' })).toBeVisible();
    await expect(page.getByRole('img', { name: alt })).toBeVisible();

    await page.goto('/admin/media');
    await page.getByRole('searchbox', { name: 'Search' }).fill(alt);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.locator('.md-item')).toHaveCount(1);
    await expect(page.locator('.md-item').getByRole('img', { name: alt })).toBeVisible();
    await expect(page.locator('.md-item').getByRole('link', { name })).toHaveAttribute('href', `/admin/media/${id}`);
  });

  test('invalid formats, misleading types and malformed images are refused with a clear message', async ({ page }) => {
    await loginAsAdmin(page, '/admin/media');
    const truncated = (await solid(400, 300).jpeg().toBuffer()).subarray(0, 700);
    const cases: [{ name: string; mimeType: string; buffer: Buffer }, RegExp][] = [
      [{ name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('just some text pretending to be a picture') }, /not a readable image/],
      [{ name: 'photo.png', mimeType: 'image/png', buffer: await jpeg() }, /do not match its stated type/],
      [{ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }, /SVG images are not accepted/],
      [{ name: 'broken.jpg', mimeType: 'image/jpeg', buffer: truncated }, /not a readable image/],
    ];
    for (const [file, message] of cases) {
      await uploadViaForm(page, file, 'Should not be kept');
      await expect(page).toHaveURL(/\/admin\/media$/);
      await expect(page.getByRole('alert').or(page.getByRole('status')).filter({ hasText: message })).toBeVisible();
      await expect(page.getByLabel(/^Alt text/)).toHaveValue('Should not be kept'); // input kept
    }
  });

  test('a file over the size limit is caught in the browser and by the server', async ({ page }) => {
    await loginAsAdmin(page, '/admin/media');
    const big = { name: 'huge.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(8 * 1024 * 1024 + 1024, 7) };
    await page.getByLabel('Image file').setInputFiles(big);
    await expect(page.getByText(/The limit is 8 MB/)).toBeVisible();
    await page.getByRole('button', { name: 'Upload image' }).click();
    await expect(page).toHaveURL(/\/admin\/media$/); // not submitted

    // Bypassing the browser check: the request fits the request cap, the file does not.
    const res = await page.request.post('/admin/media', {
      multipart: { _csrf: await csrfOf(page), _action: 'upload', image: big },
      headers: { Origin: ORIGIN },
    });
    expect(res.status()).toBe(422);
    expect(await res.text()).toContain('The file is too large.');
  });
});

test.describe('serving', () => {
  test('library images are served safely; nothing else under /media is', async ({ page, request }) => {
    await loginAsAdmin(page, '/admin/media');
    const { src } = await uploadOk(page);
    const ok = await request.get(src);
    expect(ok.status()).toBe(200);
    expect(ok.headers()['content-type']).toBe('image/webp');
    expect(ok.headers()['x-content-type-options']).toBe('nosniff');
    expect(ok.headers()['content-security-policy']).toContain("default-src 'none'");
    expect((await ok.body()).subarray(8, 12).toString('latin1')).toBe('WEBP');
    expect((await request.get(src.replace('.webp', '-thumb.webp'))).status()).toBe(200);

    // A file that exists in the uploads folder but is not in the library is never served.
    const stray = randomUUID();
    mkdirSync(resolve(STORAGE, 'uploads'), { recursive: true });
    writeFileSync(resolve(STORAGE, 'uploads', `${stray}.webp`), 'stray');
    const uid = src.slice(7, 43);
    for (const path of [
      `/media/${stray}.webp`,
      `/media/${randomUUID()}.webp`,
      `/media/${uid}.png`,
      `/media/${uid}.webp.html`,
      `/media/${uid.toUpperCase()}.webp`,
      '/media/..%2Fvk-solar.db',
      '/media/..%2F..%2Fpackage.json',
      '/media/%2e%2e%2fsecret.key',
      '/media/test-admin.json',
      '/media/..%5Cvk-solar.db',
      '/media/',
      '/uploads/' + uid + '.webp',
      '/test-storage/vk-solar.db',
    ]) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(404);
      expect((await res.body()).subarray(0, 15).toString('latin1'), path).not.toBe('SQLite format 3');
    }
  });
});

test.describe('deleting', () => {
  test('an unused image needs confirmation; cancelling keeps it, confirming removes it', async ({ page, request }) => {
    await loginAsAdmin(page, '/admin/media');
    const { id, src } = await uploadOk(page);
    await expect(page.getByText('Not used anywhere on the site.')).toBeVisible();

    await page.getByRole('button', { name: 'Delete image' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/media/${id}`));
    expect((await request.get(src)).status()).toBe(200);

    await page.getByRole('button', { name: 'Delete image' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect(page).toHaveURL(/\/admin\/media\?msg=deleted$/);
    expect((await request.get(src)).status()).toBe(404);
    await page.goto(`/admin/media/${id}`);
    await expect(page).toHaveURL(/\/admin\/media\?msg=notfound$/);
  });

  test('an image in use cannot be deleted — not from the page, not by a forged request', async ({ page, request }) => {
    await loginAsAdmin(page, '/admin/media');
    const { id, src } = await uploadOk(page);
    const db = new DatabaseSync(resolve(STORAGE, 'vk-solar.db'));
    try {
      db.prepare("INSERT INTO media_usages (media_id, usage_type, usage_key, created_at) VALUES (?, 'page', 'test-usage', ?)").run(id, new Date().toISOString());
    } finally {
      db.close();
    }
    await page.reload();
    await expect(page.getByText('This image is in use in 1 place')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete image' })).toBeDisabled();

    const res = await page.request.post(`/admin/media/${id}`, { form: { _csrf: await csrfOf(page), _action: 'delete' }, headers: { Origin: ORIGIN }, maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers().location).toBe(`/admin/media/${id}?msg=inuse`);
    expect((await request.get(src)).status()).toBe(200);
  });
});

test('media pages have no detectable WCAG A/AA violations', async ({ page }) => {
  await loginAsAdmin(page, '/admin/media');
  const { id } = await uploadOk(page, 'Solar panels at sunset');
  for (const url of ['/admin/media', `/admin/media/${id}`]) {
    await page.goto(url);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations.map((v) => `${url} ${v.id}: ${v.nodes.length}`)).toEqual([]);
  }
});
