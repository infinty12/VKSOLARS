import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAsAdmin, uniqueName } from './helpers/admin';

/** Create a location through the real admin UI; optionally publish it. Returns its edit URL. */
async function adminAdd(page: Page, opts: { region: string; city: string; status: string; publish?: boolean; note?: string }) {
  await page.goto('/admin/service-areas/new');
  await page.getByLabel('State or union territory').selectOption({ label: opts.region });
  await page.getByLabel('Coverage status').selectOption({ label: opts.status });
  await page.getByLabel(/^City or town/).fill(opts.city);
  if (opts.note) await page.getByLabel(/^Public note/).fill(opts.note);
  await page.getByRole('button', { name: 'Add location' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Location added' })).toBeVisible();
  if (opts.publish) {
    await page.locator('.loc-meta').getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Location published' })).toBeVisible();
  }
  return page.url().split('?')[0];
}

test('only published, confirmed locations appear publicly — and planned ones are labelled not available', async ({ page, browser }) => {
  const tag = uniqueName('Pubtest');
  await loginAsAdmin(page);
  await adminAdd(page, { region: 'Gujarat', city: `${tag} Available`, status: 'Coverage available', publish: true, note: 'Rooftop sites only' });
  await adminAdd(page, { region: 'Gujarat', city: `${tag} Limited`, status: 'Limited coverage', publish: true });
  await adminAdd(page, { region: 'Gujarat', city: `${tag} Planned`, status: 'Planned — not yet available', publish: true });
  await adminAdd(page, { region: 'Gujarat', city: `${tag} Draft`, status: 'Coverage available', publish: false });
  await adminAdd(page, { region: 'Gujarat', city: `${tag} Unsure`, status: 'Not yet confirmed' });
  const deletedUrl = await adminAdd(page, { region: 'Gujarat', city: `${tag} Deleted`, status: 'Coverage available', publish: true });
  await page.goto(deletedUrl);
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(page).toHaveURL(/msg=deleted/);

  // Check as a signed-out visitor (separate context: no admin cookie).
  const visitorContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const visitor = await visitorContext.newPage();
  await visitor.goto(`/service-areas?q=${encodeURIComponent(tag)}`);
  const active = visitor.locator('[data-coverage="active"]');
  const planned = visitor.locator('[data-coverage="planned"]');

  await expect(active).toContainText(`${tag} Available`);
  await expect(active).toContainText('Service available');
  await expect(active).toContainText('Rooftop sites only');
  await expect(active).toContainText(`${tag} Limited`);
  await expect(active).toContainText('Limited service');
  await expect(active).not.toContainText(`${tag} Planned`);
  await expect(planned).toContainText(`${tag} Planned`);
  await expect(planned).toContainText('Planned — not yet available');

  const page_ = await visitor.content();
  for (const hidden of ['Draft', 'Unsure', 'Deleted']) expect(page_, hidden).not.toContain(`${tag} ${hidden}`);
  await expect(visitor.locator('[data-result-count]')).toContainText('2 confirmed locations found');

  // Unpublishing removes it from the public page immediately.
  const avail = await adminAdd(page, { region: 'Gujarat', city: `${tag} Toggle`, status: 'Coverage available', publish: true });
  await visitor.goto(`/service-areas?q=${encodeURIComponent(`${tag} Toggle`)}`);
  await expect(visitor.locator('[data-coverage="active"]')).toContainText(`${tag} Toggle`);
  await page.goto(avail);
  await page.locator('.loc-meta').getByRole('button', { name: 'Unpublish' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Location unpublished' })).toBeVisible();
  await visitor.reload();
  await expect(visitor.locator('[data-coverage="active"]')).toHaveCount(0);
  await expect(visitor.getByText('We haven’t published a confirmed location matching your search yet')).toBeVisible();
  await visitorContext.close();
});

test('state filter only offers states with published coverage and narrows results', async ({ page }) => {
  const tag = uniqueName('Statefilter');
  await loginAsAdmin(page);
  await adminAdd(page, { region: 'Odisha', city: `${tag} A`, status: 'Coverage available', publish: true });
  await page.goto('/service-areas');
  const select = page.getByLabel('State or union territory');
  await expect(select.locator('option', { hasText: 'Odisha' })).toHaveCount(1);
  await expect(select.locator('option', { hasText: 'Lakshadweep' })).toHaveCount(0); // never given coverage in tests
  await select.selectOption({ label: 'Odisha' });
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/region=odisha/);
  await expect(page.locator('[data-coverage="active"]')).toContainText(`${tag} A`);
  await expect(page.locator('.sa-region__name')).toHaveText(['Odisha']);
});

test('the Rajasthan map and Rajasthan-only copy are gone; no unconfirmed claims', async ({ page }) => {
  await page.goto('/service-areas');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Solar services across India');
  await expect(page.locator('.rmap, svg[aria-label*="Rajasthan"]')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('Our focus is Rajasthan');
  await page.goto('/contact');
  await expect(page.locator('.rmap, svg[aria-label*="Rajasthan"]')).toHaveCount(0);
});

test('public Service Areas page has no detectable WCAG A/AA violations with results', async ({ page }) => {
  await loginAsAdmin(page);
  await adminAdd(page, { region: 'Kerala', city: uniqueName('Axearea'), status: 'Coverage available', publish: true });
  await adminAdd(page, { region: 'Kerala', city: uniqueName('Axeplan'), status: 'Planned — not yet available', publish: true });
  await page.goto('/service-areas');
  await page.evaluate(() => document.querySelectorAll('[data-reveal]').forEach((el) => el.classList.add('is-visible')));
  await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-reveal]')).every((el) => getComputedStyle(el).opacity === '1'));
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
