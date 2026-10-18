import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';

/** Credentials of the disposable test admin created by scripts/test-server.mjs. */
export function testAdmin(): { username: string; password: string } {
  return JSON.parse(readFileSync(resolve('test-storage/test-admin.json'), 'utf8'));
}

export async function loginAsAdmin(page: Page, next = '/admin') {
  const { username, password } = testAdmin();
  await page.goto(`/admin/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${next.replace(/[/?]/g, '\\$&')}$`));
}

/** A name that won't collide between parallel tests or the desktop/mobile projects. */
export const uniqueName = (prefix: string) => `${prefix} ${Math.random().toString(36).slice(2, 8)}`;
