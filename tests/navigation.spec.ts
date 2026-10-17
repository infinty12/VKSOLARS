import { test, expect, type Page } from '@playwright/test';

const routes = [
  { path: '/', label: 'Home' },
  { path: '/services', label: 'Services' },
  { path: '/ai-drone-inspection', label: 'AI Drone Inspection' },
  { path: '/about', label: 'About Us' },
  { path: '/service-areas', label: 'Service Areas' },
  { path: '/contact', label: 'Contact' },
];

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('requestfailed', (req) => errors.push(`request failed: ${req.url()}`));
  return errors;
}

test.describe('routes', () => {
  for (const { path } of routes) {
    test(`${path} renders with one h1, a title and no console errors`, async ({ page }) => {
      const errors = collectErrors(page);
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page).toHaveTitle(/VK Solar/);
      expect(await page.locator('meta[name="description"]').getAttribute('content')).toBeTruthy();
      expect(errors).toEqual([]);
    });
  }

  test('unknown route serves the 404 page', async ({ page }) => {
    const response = await page.goto('/this-page-does-not-exist');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('couldn’t find');
  });
});

test.describe('desktop navigation', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1180, 'desktop nav only');

  test('every main nav link navigates and marks the active page', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Main', exact: true });
    for (const { path, label } of routes) {
      await nav.getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path === '/' ? '/$' : path}`));
      await expect(
        page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: label, exact: true }),
      ).toHaveAttribute('aria-current', 'page');
    }
  });

  test('menu toggle is hidden on desktop', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /menu/i })).toBeHidden();
  });
});

test.describe('mobile menu', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) >= 1180, 'mobile menu only');

  test('opens, traps focus, closes with Escape and returns focus', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByRole('button', { name: 'Open menu' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();

    const closeToggle = page.getByRole('button', { name: 'Close menu' });
    await expect(closeToggle).toHaveAttribute('aria-expanded', 'true');
    const menu = page.locator('#mobile-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Home' })).toBeFocused();
    await expect(menu.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');

    // Content behind the menu is inert.
    expect(await page.locator('main').evaluate((el) => (el as HTMLElement).inert)).toBe(true);

    // Tabbing past the last item wraps back to the toggle.
    const focusableCount = await page.locator('#mobile-menu a, #mobile-menu button').count();
    for (let i = 0; i < focusableCount; i++) await page.keyboard.press('Tab');
    await expect(closeToggle).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeFocused();
    expect(await page.locator('main').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
  });

  test('navigates to every page from the menu', async ({ page }) => {
    await page.goto('/');
    for (const { path, label } of routes) {
      await page.getByRole('button', { name: 'Open menu' }).click();
      await page.locator('#mobile-menu').getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path === '/' ? '/$' : path}`));
      await expect(page.locator('#mobile-menu')).toBeHidden();
    }
  });
});

test('skip link moves focus to main content', async ({ page }) => {
  await page.goto('/services');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skip).toBeFocused();
  await skip.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});
