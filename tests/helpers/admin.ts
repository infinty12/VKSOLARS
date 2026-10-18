import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';

/** The "enquiries open" test server (see playwright.config.ts). */
export const OPEN_BASE = 'http://127.0.0.1:4395';
export const OPEN_STORAGE = 'test-storage-open';

/** Credentials of the disposable test admin created by scripts/test-server.mjs. */
export function testAdmin(storage = 'test-storage'): { username: string; password: string } {
  return JSON.parse(readFileSync(resolve(storage, 'test-admin.json'), 'utf8'));
}

/** Sign in on the default server, or on another one by passing its base URL and storage folder. */
export async function loginAsAdmin(page: Page, next = '/admin', server?: { base: string; storage: string }) {
  const { username, password } = testAdmin(server?.storage);
  const base = server?.base ?? '';
  await page.goto(`${base}/admin/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${next.replace(/[/?]/g, '\\$&')}$`));
}

/** A name that won't collide between parallel tests or the desktop/mobile projects. */
export const uniqueName = (prefix: string) => `${prefix} ${Math.random().toString(36).slice(2, 8)}`;
