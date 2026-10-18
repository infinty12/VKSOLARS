import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAsAdmin, uniqueName } from './helpers/admin';

async function addLocation(
  page: Page,
  opts: { region: string; district?: string; city?: string; status?: string; services?: string[]; note?: string; publish?: boolean },
) {
  await page.goto('/admin/service-areas/new');
  await page.getByLabel('State or union territory').selectOption({ label: opts.region });
  if (opts.status) await page.getByLabel('Coverage status').selectOption({ label: opts.status });
  if (opts.district) await page.getByLabel(/^District/).fill(opts.district);
  if (opts.city) await page.getByLabel(/^City or town/).fill(opts.city);
  for (const s of opts.services ?? []) await page.getByLabel(s, { exact: true }).check();
  if (opts.note) await page.getByLabel(/^Public note/).fill(opts.note);
  if (opts.publish) await page.getByLabel(/^Published/).check();
  await page.getByRole('button', { name: 'Add location' }).click();
}

test.describe('access control', () => {
  test('signed-out visitors are sent to login for every service-area page', async ({ page }) => {
    for (const path of ['/admin/service-areas', '/admin/service-areas/new', '/admin/service-areas/1']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/admin\/login\?next=/);
    }
  });

  test('signed-out POST cannot create a location', async ({ request }) => {
    const res = await request.post('/admin/service-areas/new', {
      form: { regionCode: 'rajasthan', status: 'available', city: 'Should Not Exist' },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(303);
    expect(res.headers().location).toMatch(/^\/admin\/login/);
  });

  test('signed-in POST without the CSRF token is rejected', async ({ page }) => {
    await loginAsAdmin(page);
    const res = await page.request.post('/admin/service-areas/new', {
      form: { regionCode: 'rajasthan', status: 'available', city: uniqueName('Nocsrf') },
      headers: { Origin: new URL(page.url()).origin },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(403);
  });
});

test.describe('service-area management', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test('a new location starts unconfirmed and unpublished', async ({ page }) => {
    await page.goto('/admin/service-areas/new');
    await expect(page.getByLabel('Coverage status')).toHaveValue('unconfirmed');
    await expect(page.getByLabel(/^Published/)).not.toBeChecked();
  });

  test('create, edit, publish and unpublish a location', async ({ page }) => {
    const city = uniqueName('Testpur');
    await addLocation(page, { region: 'Rajasthan', district: 'Jaipur', city, status: 'Coverage available', services: ['Solar Panel Cleaning'] });
    await expect(page.getByRole('status').filter({ hasText: 'Location added' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`${city}, Jaipur district — Rajasthan`);
    await expect(page.locator('.loc-meta')).toContainText('Not published');

    // Edit: change status and note.
    await page.getByLabel('Coverage status').selectOption({ label: 'Limited coverage' });
    await page.getByLabel(/^Public note/).fill('Ground-mount sites only');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Changes saved' })).toBeVisible();
    await expect(page.locator('.loc-meta')).toContainText('Limited coverage');
    await expect(page.getByLabel(/^Public note/)).toHaveValue('Ground-mount sites only');

    // Publish, then unpublish.
    await page.locator('.loc-meta').getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Location published' })).toBeVisible();
    await expect(page.locator('.loc-meta')).toContainText('Published');
    await page.locator('.loc-meta').getByRole('button', { name: 'Unpublish' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Location unpublished' })).toBeVisible();
    await expect(page.locator('.loc-meta')).toContainText('Not published');
  });

  test('state/UT-wide entry (no district or city) is allowed', async ({ page }) => {
    // Desktop/mobile projects and --repeat-each runs share one database, so each run uses its own
    // union territory/state to avoid colliding on the same state-wide entry (a duplicate is
    // correctly rejected, which is tested separately).
    const pool = ['Goa', 'Sikkim', 'Tripura', 'Mizoram', 'Nagaland', 'Manipur', 'Meghalaya', 'Lakshadweep', 'Ladakh', 'Puducherry'];
    const index = (test.info().project.name === 'desktop' ? 0 : 5) + (test.info().repeatEachIndex % 5);
    const region = pool[index];
    await addLocation(page, { region, status: 'Planned — not yet available' });
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`All of ${region}`);
  });

  test('duplicates are rejected, ignoring case and extra spaces', async ({ page }) => {
    const city = uniqueName('Dupeville');
    await addLocation(page, { region: 'Gujarat', district: 'Surat', city });
    await expect(page.getByRole('status').filter({ hasText: 'Location added' })).toBeVisible();

    await addLocation(page, { region: 'Gujarat', district: '  SURAT ', city: `  ${city.toUpperCase()}  ` });
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('This location already exists');
    await expect(alert.getByRole('link', { name: 'Open the existing entry' })).toBeVisible();
  });

  test('an unconfirmed location cannot be published — form, button and forged request', async ({ page }) => {
    const city = uniqueName('Unsure');
    // 1. Form: ticking "Published" with status unconfirmed is rejected.
    await addLocation(page, { region: 'Kerala', city, publish: true });
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('#published-error')).toContainText('cannot be published');

    // 2. Saved as unpublished, the Publish button is disabled with an explanation.
    await page.getByLabel(/^Published/).uncheck();
    await page.getByRole('button', { name: 'Add location' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Location added' })).toBeVisible();
    const publish = page.locator('.loc-meta').getByRole('button', { name: 'Publish' });
    await expect(publish).toBeDisabled();
    await expect(page.locator('#publish-why')).toBeVisible();

    // 3. Forged request bypassing the disabled button is refused by the server.
    const csrf = await page.locator('input[name="_csrf"]').first().inputValue();
    const res = await page.request.post(page.url(), {
      form: { _csrf: csrf, _action: 'publish' },
      headers: { Origin: new URL(page.url()).origin },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(422);
    expect(await res.text()).toContain('cannot be published');
    await page.reload();
    await expect(page.locator('.loc-meta')).toContainText('Not published');
  });

  test('invalid input shows field errors and keeps the entered values', async ({ page }) => {
    await page.goto('/admin/service-areas/new');
    await page.getByLabel(/^City or town/).fill('Bad<script>');
    await page.getByLabel(/^Public note/).fill('<b>hi</b>');
    await page.getByRole('button', { name: 'Add location' }).click();
    await expect(page.getByRole('alert')).toBeFocused();
    await expect(page.locator('#regionCode-error')).toContainText('Choose a state');
    await expect(page.locator('#city-error')).toContainText('can only contain');
    await expect(page.locator('#note-error')).toContainText('cannot contain');
    await expect(page.getByLabel('State or union territory')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel(/^City or town/)).toHaveValue('Bad<script>');
  });

  test('search and filters narrow the list', async ({ page }) => {
    const tag = uniqueName('Filtertown');
    await addLocation(page, { region: 'Punjab', district: 'Ludhiana', city: tag, status: 'Coverage available' });
    await page.locator('.loc-meta').getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Location published' })).toBeVisible();

    await page.goto('/admin/service-areas');
    await page.getByLabel('Search').fill(tag);
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('rowheader')).toHaveCount(1);
    await expect(page.getByRole('rowheader')).toContainText(tag);

    // Matching search but wrong status → no results.
    await page.getByLabel('Status').selectOption({ label: 'Planned — not yet available' });
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('No locations match these filters.')).toBeVisible();

    // Region + visibility filters.
    await page.goto(`/admin/service-areas?q=${encodeURIComponent(tag)}&region=punjab&visibility=published`);
    await expect(page.getByRole('rowheader')).toHaveCount(1);
    await page.goto(`/admin/service-areas?q=${encodeURIComponent(tag)}&region=punjab&visibility=unpublished`);
    await expect(page.getByText('No locations match these filters.')).toBeVisible();
    await page.goto(`/admin/service-areas?q=${encodeURIComponent(tag)}&region=kerala`);
    await expect(page.getByText('No locations match these filters.')).toBeVisible();
  });

  test('quick publish from the list, and the list button is disabled for unconfirmed entries', async ({ page }) => {
    const ok = uniqueName('Quickpub');
    const unsure = uniqueName('Quickunsure');
    await addLocation(page, { region: 'Haryana', city: ok, status: 'Coverage available' });
    await addLocation(page, { region: 'Haryana', city: unsure });
    await page.goto(`/admin/service-areas?q=${encodeURIComponent('Quick')}&region=haryana`);
    const okRow = page.getByRole('row').filter({ hasText: ok });
    await okRow.getByRole('button', { name: /^Publish/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Location published' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: ok })).toContainText('Published');
    const disabledBtn = page.getByRole('row').filter({ hasText: unsure }).getByRole('button', { name: /^Publish/ });
    await expect(disabledBtn).toBeDisabled();
    // ...and it must also LOOK disabled, not just refuse clicks.
    expect(Number(await disabledBtn.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(0.6);
  });

  test('delete asks for confirmation; cancelling keeps the location', async ({ page }) => {
    const city = uniqueName('Deleteme');
    await addLocation(page, { region: 'Bihar', city });
    await expect(page.getByRole('status').filter({ hasText: 'Location added' })).toBeVisible();
    const editUrl = page.url();

    await page.getByRole('button', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(city);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(editUrl);

    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect(page).toHaveURL(/\/admin\/service-areas\?msg=deleted$/);
    await page.goto(editUrl);
    await expect(page).toHaveURL(/msg=notfound/);
  });

  test('admin service-area pages have no detectable WCAG A/AA violations', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 1000, 'run once');
    const city = uniqueName('Axecity');
    await addLocation(page, { region: 'Assam', city });
    for (const url of [page.url(), '/admin/service-areas', '/admin/service-areas/new', '/admin']) {
      await page.goto(url);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(results.violations.map((v) => `${url} ${v.id}: ${v.nodes.length}`)).toEqual([]);
    }
  });
});
