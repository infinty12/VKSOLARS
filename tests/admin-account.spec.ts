import { test, expect, type Page, type Browser } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync } from 'node:crypto';
import { resolve } from 'node:path';
import { loginAsAdmin } from './helpers/admin';

// Default test server (disposable test-storage/). Each run creates its OWN throwaway administrator,
// so changing passwords and ending sessions never affects the shared test admin.
const ORIGIN = 'http://127.0.0.1:4397';
const DB = resolve('test-storage', 'vk-solar.db');

/** Same format as src/lib/server/auth.ts hashPassword (scrypt N=2^15, r=8, p=1, 64-byte key). */
function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return ['scrypt', 32768, 8, 1, salt.toString('base64'), key.toString('base64')].join('$');
}

function createTestAdmin() {
  const username = `acct-test-${randomBytes(4).toString('hex')}`;
  const password = `pw-${randomBytes(12).toString('base64url')}`;
  const db = new DatabaseSync(DB);
  try {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO admin_users (username, password_hash, created_at, updated_at, password_changed_at) VALUES (?, ?, ?, ?, ?)').run(
      username,
      hashPassword(password),
      now,
      now,
      now,
    );
  } finally {
    db.close();
  }
  return { username, password };
}

async function signIn(browser: Browser, username: string, password: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/admin/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  return { ctx, page };
}

async function confirm(page: Page, button: string) {
  await page.getByRole('button', { name: button }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
}

test.describe('access control', () => {
  test('signed-out visitors are sent to login', async ({ page }) => {
    for (const path of ['/admin/account', '/admin/activity']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/admin\/login\?next=/);
    }
  });

  test('signed-out and token-less account changes are refused', async ({ page, request }) => {
    const forms: Record<string, string>[] = [{ _action: 'password', current_password: 'x', new_password: 'y', confirm_password: 'y' }, { _action: 'revoke_others' }];
    for (const form of forms) {
      const res = await request.post('/admin/account', { form, maxRedirects: 0 });
      expect(res.status()).toBe(303);
      expect(res.headers().location).toMatch(/^\/admin\/login/);
    }
    await loginAsAdmin(page, '/admin/account');
    const res = await page.request.post('/admin/account', { form: { _action: 'revoke_others' }, headers: { Origin: ORIGIN }, maxRedirects: 0 });
    expect(res.status()).toBe(403);
  });
});

test.describe('account security', () => {
  test.describe.configure({ mode: 'serial' });

  test('sessions, signing out other sessions, and changing the password', async ({ browser }) => {
    const { username, password } = createTestAdmin();
    const newPassword = `new-${randomBytes(12).toString('base64url')}`;
    const a = await signIn(browser, username, password);
    const b = await signIn(browser, username, password);
    await expect(a.page).toHaveURL(/\/admin$/);
    await expect(b.page).toHaveURL(/\/admin$/);

    // Session list: both sessions, current one marked, no token values in the page.
    await a.page.goto('/admin/account');
    await expect(a.page.locator('tr[data-session="current"]')).toHaveCount(1);
    await expect(a.page.locator('tr[data-session="other"]')).toHaveCount(1);
    const html = await a.page.content();
    for (const c of [...(await a.ctx.cookies()), ...(await b.ctx.cookies())]) {
      if (c.name === 'vk_admin_session') expect(html, 'session token never shown').not.toContain(c.value);
    }

    // Wrong current password: refused, nothing changes, other session still signed in.
    await a.page.getByLabel('Current password').fill('definitely-not-it');
    await a.page.getByLabel('New password', { exact: true }).fill(newPassword);
    await a.page.getByLabel('Confirm new password').fill(newPassword);
    await a.page.getByRole('button', { name: 'Change password' }).click();
    await expect(a.page.getByRole('alert').filter({ hasText: 'Your current password is incorrect.' })).toBeVisible();
    await expect(a.page.getByLabel('Current password')).toHaveAttribute('aria-invalid', 'true');
    await expect(a.page.getByLabel('Current password')).toHaveValue(''); // never echoed back
    await b.page.goto('/admin');
    await expect(b.page).toHaveURL(/\/admin$/);

    // Sign out other sessions: B is signed out, A stays.
    await a.page.goto('/admin/account');
    await confirm(a.page, 'Sign out all other sessions');
    await expect(a.page).toHaveURL(/msg=sessionsRevoked$/);
    await expect(a.page.locator('tr[data-session="other"]')).toHaveCount(0);
    await b.page.goto('/admin');
    await expect(b.page).toHaveURL(/\/admin\/login/);

    // B signs in again, then A changes the password: B is signed out, A continues.
    await b.page.getByLabel('Username').fill(username);
    await b.page.getByLabel('Password').fill(password);
    await b.page.getByRole('button', { name: 'Sign in' }).click();
    await expect(b.page).toHaveURL(/\/admin$/);
    const oldCookie = (await a.ctx.cookies()).find((c) => c.name === 'vk_admin_session')!.value;
    await a.page.getByLabel('Current password').fill(password);
    await a.page.getByLabel('New password', { exact: true }).fill(newPassword);
    await a.page.getByLabel('Confirm new password').fill(newPassword);
    await a.page.getByRole('button', { name: 'Change password' }).click();
    await expect(a.page).toHaveURL(/msg=passwordChanged$/);
    await expect(a.page.getByRole('status').filter({ hasText: 'Password changed' })).toBeVisible();
    const newCookie = (await a.ctx.cookies()).find((c) => c.name === 'vk_admin_session')!.value;
    expect(newCookie).not.toBe(oldCookie); // session rotated
    await a.page.goto('/admin/activity');
    await expect(a.page).toHaveURL(/\/admin\/activity$/); // still signed in
    await b.page.goto('/admin');
    await expect(b.page).toHaveURL(/\/admin\/login/);

    // Old password no longer works; the new one does.
    const old = await signIn(browser, username, password);
    await expect(old.page.getByText('Incorrect username or password.')).toBeVisible();
    const fresh = await signIn(browser, username, newPassword);
    await expect(fresh.page).toHaveURL(/\/admin$/);

    // Activity: the account actions are listed with readable labels; no password values anywhere.
    await a.page.goto('/admin/activity?area=account');
    for (const label of ['Password changed', 'Signed out other sessions', 'Password change refused']) {
      await expect(a.page.getByRole('rowheader').filter({ hasText: label }).first()).toBeVisible();
    }
    const activityHtml = await a.page.content();
    for (const secret of [password, newPassword, 'definitely-not-it', newCookie]) expect(activityHtml).not.toContain(secret);

    for (const c of [a, b, old, fresh]) await c.ctx.close();
  });
});

test.describe('activity log', () => {
  test('filters by area and date, newest first, with readable labels', async ({ page }) => {
    await loginAsAdmin(page, '/admin/activity');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Activity');
    // Signing in just now was recorded.
    await page.getByLabel('Area').selectOption({ label: 'Sign-in' });
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await page.getByLabel('From').fill(ymd);
    await page.getByLabel('To').fill(ymd);
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page).toHaveURL(new RegExp(`area=signin&from=${ymd}&to=${ymd}`));
    await expect(page.getByRole('rowheader').filter({ hasText: 'Signed in' }).first()).toBeVisible();
    await expect(page.locator('tbody th')).not.toContainText(['Image uploaded']);

    await page.goto('/admin/activity?from=2999-01-01');
    await expect(page.getByText('No activity matches these filters.')).toBeVisible();
    await page.goto('/admin/activity?from=2026-02-31');
    await expect(page.getByRole('alert').filter({ hasText: 'One of the dates was not valid' })).toBeVisible();

    // The dashboard uses the same readable labels and links to the full log.
    await page.goto('/admin');
    await expect(page.getByRole('link', { name: 'View all activity' })).toHaveAttribute('href', '/admin/activity');
    await expect(page.locator('section[aria-labelledby="d-audit"] tbody')).toContainText('Signed in');
  });

  test('account and activity pages have no detectable WCAG A/AA violations', async ({ page }) => {
    await loginAsAdmin(page, '/admin/account');
    for (const url of ['/admin/account', '/admin/activity']) {
      await page.goto(url);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(results.violations.map((v) => `${url} ${v.id}: ${v.nodes.length}`)).toEqual([]);
    }
  });
});
