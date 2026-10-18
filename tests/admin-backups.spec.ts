import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loginAsAdmin } from './helpers/admin';

// The default test server keeps backups in test-storage/backups (see scripts/test-server.mjs).
const BACKUPS = resolve('test-storage', 'backups');
const backupNames = () => (existsSync(BACKUPS) ? readdirSync(BACKUPS).filter((n) => /^backup-\d{8}-\d{6}-\d{3}$/.test(n)) : []);

test.describe('access control', () => {
  test('signed-out visitors are sent to login', async ({ page }) => {
    await page.goto('/admin/backups');
    await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin%2Fbackups/);
  });

  test('signed-out POST cannot create a backup', async ({ request }) => {
    // The middleware redirects before the page runs, so no backup code is reached.
    const res = await request.post('/admin/backups', { form: { _action: 'create' }, maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers().location).toMatch(/^\/admin\/login/);
  });

  test('signed-in POST without the CSRF token is rejected', async ({ page }) => {
    await loginAsAdmin(page, '/admin/backups');
    const res = await page.request.post('/admin/backups', { form: { _action: 'create' }, headers: { Origin: 'http://127.0.0.1:4397' }, maxRedirects: 0 });
    expect(res.status()).toBe(403);
  });

  test('no backup can be downloaded or read over HTTP', async ({ page, request }) => {
    await loginAsAdmin(page, '/admin/backups');
    await page.getByRole('button', { name: 'Create backup now' }).click();
    const name = (await page.locator('.bk-name').first().textContent())!.trim();
    for (const path of [`/backups/${name}/vk-solar.db`, `/${name}/vk-solar.db`, `/admin/backups/${name}`, `/admin/backups?name=../storage`]) {
      const res = await request.get(path, { maxRedirects: 0 });
      const body = await res.body();
      expect(body.subarray(0, 15).toString('latin1'), path).not.toBe('SQLite format 3');
    }
  });
});

test.describe('backups page', () => {
  test('create a backup, see it listed, verify it', async ({ page }) => {
    await loginAsAdmin(page, '/admin/backups');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Backups');

    await page.getByRole('button', { name: 'Create backup now' }).click();
    await expect(page).toHaveURL(/\/admin\/backups\?msg=backup$/);
    await expect(page.getByRole('status').filter({ hasText: 'Backup created and verified.' })).toBeVisible();
    await expect(page.locator('.bk-status')).toContainText('Last backup:');

    const name = (await page.locator('.bk-name').first().textContent())!.trim();
    expect(name).toMatch(/^backup-\d{8}-\d{6}-\d{3}$/);
    expect(backupNames()).toContain(name);
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row).toContainText('schema v');

    await row.getByRole('button', { name: /^Verify/ }).click();
    await expect(page.getByRole('status').filter({ hasText: `${name} verified` })).toBeVisible();

    // Restore is explained, but not offered in the browser.
    await expect(page.getByText(/npm run restore -- backup-/)).toBeVisible();
    await expect(page.getByRole('button', { name: /restore/i })).toHaveCount(0);
  });

  test('verifying an invalid name is refused safely', async ({ page }) => {
    await loginAsAdmin(page, '/admin/backups');
    const token = await page.locator('input[name="_csrf"]').first().inputValue();
    const res = await page.request.post('/admin/backups', {
      form: { _csrf: token, _action: 'verify', name: '../storage' },
      headers: { Origin: 'http://127.0.0.1:4397' },
    });
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('Backup not found (or not a valid backup name).');
  });

  test('is accessible', async ({ page }) => {
    await loginAsAdmin(page, '/admin/backups');
    await page.getByRole('button', { name: 'Create backup now' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Backup created' })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
});
