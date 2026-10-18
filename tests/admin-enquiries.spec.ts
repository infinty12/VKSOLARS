import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { loginAsAdmin, uniqueName, OPEN_BASE, OPEN_STORAGE } from './helpers/admin';

const OPEN = { base: OPEN_BASE, storage: OPEN_STORAGE };

/** Submit an enquiry through the real public form on the open server; returns its reference. */
async function submitEnquiry(page: Page, opts: { name: string; message?: string; location?: string }) {
  await page.goto(`${OPEN_BASE}/contact`);
  await page.getByLabel('Full name').fill(opts.name);
  await page.getByLabel('Phone number').fill('98765 43210');
  await page.getByLabel('Service required').selectOption('preventive-maintenance');
  await page.getByLabel('State or union territory').selectOption({ label: 'Maharashtra' });
  await page.getByLabel('Site location').fill(opts.location ?? 'Pune');
  if (opts.message) await page.getByLabel(/^Message/).fill(opts.message);
  await page.getByLabel(/I agree to VK Solar contacting me/).check();
  await page.locator('[data-submit]').click();
  const status = page.locator('[data-status]');
  await expect(status).toContainText('has been received');
  return (await status.textContent())!.match(/ENQ-\d{8}-[0-9A-F]{6}/)![0];
}

async function openEnquiry(page: Page, reference: string) {
  await page.goto(`${OPEN_BASE}/admin/enquiries?q=${reference}`);
  await page.getByRole('rowheader').getByRole('link').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Enquiry from');
}

test.describe('access control and privacy', () => {
  test('signed-out visitors are sent to login for every inbox page', async ({ page }) => {
    for (const path of ['/admin/enquiries', '/admin/enquiries/1', '/admin/enquiries/settings']) {
      await page.goto(`${OPEN_BASE}${path}`);
      await expect(page).toHaveURL(/\/admin\/login\?next=/);
    }
  });

  test('signed-out POSTs cannot change or delete enquiries', async ({ request }) => {
    for (const [path, form] of [
      ['/admin/enquiries/1', { _action: 'delete' }],
      ['/admin/enquiries/1', { _action: 'status', status: 'resolved' }],
      ['/admin/enquiries/settings', { _action: 'accept', accept: 'on' }],
    ] as const) {
      const res = await request.post(`${OPEN_BASE}${path}`, { form, maxRedirects: 0 });
      expect(res.status(), path).toBe(303);
      expect(res.headers().location).toMatch(/^\/admin\/login/);
    }
  });

  test('signed-in POST without the CSRF token is rejected', async ({ page }) => {
    const ref = await submitEnquiry(page, { name: uniqueName('Csrf Check') });
    await loginAsAdmin(page, '/admin/enquiries', OPEN);
    await openEnquiry(page, ref);
    const res = await page.request.post(page.url(), { form: { _action: 'delete' }, headers: { Origin: OPEN_BASE }, maxRedirects: 0 });
    expect(res.status()).toBe(403);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Enquiry from');
  });

  test('enquiries cannot be read through any public route', async ({ request }) => {
    const get = await request.get(`${OPEN_BASE}/api/enquiries`);
    expect(get.status()).toBe(405);
    const json = await request.get(`${OPEN_BASE}/api/enquiries?id=1`);
    expect(json.status()).toBe(405);
    const page = await request.get(`${OPEN_BASE}/admin/enquiries`, { maxRedirects: 0 });
    expect(page.status()).toBe(303);
  });
});

test.describe('inbox', () => {
  test('status changes, internal notes and their audit trail', async ({ page }) => {
    const name = uniqueName('Status Flow');
    const ref = await submitEnquiry(page, { name, message: 'Two inverters tripping since June.' });
    await loginAsAdmin(page, '/admin/enquiries', OPEN);
    await openEnquiry(page, ref);

    await expect(page.locator('.enq-current')).toContainText('New');
    await expect(page.locator('.enq-message')).toHaveText('Two inverters tripping since June.');
    await expect(page.locator('.enq-consent')).toContainText('I agree to VK Solar contacting me');

    await page.getByLabel('Change status').selectOption({ label: 'In progress' });
    await page.getByRole('button', { name: 'Update status' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Status updated' })).toBeVisible();
    await expect(page.locator('.enq-current')).toContainText('In progress');

    await page.getByLabel('Add a note').fill('Called customer, visit booked for Monday.\nBring thermal camera.');
    await page.getByRole('button', { name: 'Save note' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Note added' })).toBeVisible();
    await expect(page.locator('.enq-note__body')).toHaveText('Called customer, visit booked for Monday.\nBring thermal camera.');

    await page.getByLabel('Change status').selectOption({ label: 'Resolved' });
    await page.getByRole('button', { name: 'Update status' }).click();
    await expect(page.locator('.enq-current')).toContainText('Resolved');
    await expect(page.getByText(/^Resolved \d/)).toBeVisible();

    // Audit log records the actions for this enquiry id, and never its content.
    const id = page.url().match(/\/admin\/enquiries\/(\d+)/)![1];
    const db = new DatabaseSync(resolve(OPEN_STORAGE, 'vk-solar.db'), { readOnly: true });
    const rows = db.prepare("SELECT action, detail FROM audit_log WHERE target_type = 'enquiry' AND target_id = ? ORDER BY id").all(id) as {
      action: string;
      detail: string | null;
    }[];
    db.close();
    expect(rows.map((r) => r.action)).toEqual(['enquiry.received', 'enquiry.status', 'enquiry.note', 'enquiry.status']);
    expect(JSON.stringify(rows)).not.toContain(name);
    expect(JSON.stringify(rows)).not.toContain('inverters');
  });

  test('empty and over-long notes are rejected', async ({ page }) => {
    const ref = await submitEnquiry(page, { name: uniqueName('Note Rules') });
    await loginAsAdmin(page, '/admin/enquiries', OPEN);
    await openEnquiry(page, ref);
    const csrf = await page.locator('input[name="_csrf"]').first().inputValue();
    const empty = await page.request.post(page.url(), { form: { _csrf: csrf, _action: 'note', note: '   ' }, headers: { Origin: OPEN_BASE } });
    expect(empty.status()).toBe(422);
    expect(await empty.text()).toContain('Write a note before saving');
    const long = await page.request.post(page.url(), { form: { _csrf: csrf, _action: 'note', note: 'x'.repeat(2001) }, headers: { Origin: OPEN_BASE } });
    expect(long.status()).toBe(422);
    expect(await long.text()).toContain('2000 characters or fewer');
  });

  test('user-submitted HTML is shown as text, never executed', async ({ page }) => {
    let dialogs = 0;
    page.on('dialog', async (d) => {
      dialogs++;
      await d.dismiss();
    });
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const ref = await submitEnquiry(page, { name: `Xss ${Math.random().toString(36).slice(2, 6)} <b>bold</b>`, message: payload });
    await loginAsAdmin(page, '/admin/enquiries', OPEN);
    await page.goto(`${OPEN_BASE}/admin/enquiries?q=${ref}`);
    await expect(page.getByRole('rowheader')).toContainText('<b>bold</b>');
    await openEnquiry(page, ref);
    await expect(page.locator('.enq-message')).toHaveText(payload);
    await expect(page.locator('.enq-message img, .enq-message script, h1 b')).toHaveCount(0);
    expect(dialogs).toBe(0);
  });

  test('search and status filters narrow the inbox', async ({ page }) => {
    const tag = uniqueName('Searchable');
    const ref = await submitEnquiry(page, { name: tag, location: 'Nashik' });
    await loginAsAdmin(page, '/admin/enquiries', OPEN);
    await page.getByRole('searchbox', { name: 'Search' }).fill(tag);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('rowheader')).toHaveCount(1);
    await expect(page.getByRole('rowheader')).toContainText(ref);

    await page.goto(`${OPEN_BASE}/admin/enquiries?q=${encodeURIComponent(tag)}&status=resolved`);
    await expect(page.getByText('No enquiries match.')).toBeVisible();
    await page.goto(`${OPEN_BASE}/admin/enquiries?q=${encodeURIComponent(tag)}&status=new`);
    await expect(page.getByRole('rowheader')).toHaveCount(1);
    await expect(page.getByRole('link', { name: /^New \d+/ })).toHaveAttribute('aria-current', 'page');
  });

  test('delete asks for confirmation; cancelling keeps the enquiry', async ({ page }) => {
    const name = uniqueName('Delete Me');
    const ref = await submitEnquiry(page, { name });
    await loginAsAdmin(page, '/admin/enquiries', OPEN);
    await openEnquiry(page, ref);
    const url = page.url();

    await page.getByRole('button', { name: 'Delete enquiry' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(ref);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(url);

    await page.getByRole('button', { name: 'Delete enquiry' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect(page).toHaveURL(/\/admin\/enquiries\?msg=deleted$/);
    await page.goto(`${OPEN_BASE}/admin/enquiries?q=${ref}`);
    await expect(page.getByText('No enquiries match.')).toBeVisible();
    await page.goto(url);
    await expect(page).toHaveURL(/msg=notfound/);
  });

  test('settings page shows both switches and the retention policy', async ({ page }) => {
    await loginAsAdmin(page, '/admin/enquiries/settings', OPEN);
    await expect(page.locator('.set-gates')).toContainText('ENQUIRIES_ENABLED');
    await expect(page.locator('.set-result')).toContainText('accepting enquiries');
    await expect(page.locator('#retention')).toContainText('Nothing is deleted automatically');
    // Browser layer: the input's min/max blocks an out-of-range value before it is sent.
    const days = page.getByLabel('Retention period (days)');
    await days.fill('5');
    expect(await days.evaluate((el: HTMLInputElement) => el.validity.rangeUnderflow)).toBe(true);
    // Server layer: a request that bypasses the browser check is still rejected.
    const csrf = await page.locator('input[name="_csrf"]').first().inputValue();
    const res = await page.request.post(page.url().split('#')[0], {
      form: { _csrf: csrf, _action: 'retention', retentionDays: '5' },
      headers: { Origin: OPEN_BASE },
    });
    expect(res.status()).toBe(422);
    expect(await res.text()).toContain('between 30 and 3650');
  });

  test('closed server: the admin switch alone does not open the form', async ({ page }) => {
    await loginAsAdmin(page, '/admin/enquiries/settings');
    await expect(page.locator('.set-result')).toContainText('closed');
    await page.getByLabel('Accept enquiries from the website contact form').check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.set-result')).toContainText('closed'); // ENQUIRIES_ENABLED is not set on this server
    await page.goto('/contact');
    await expect(page.locator('[data-unconfigured]')).toBeVisible();
    // Restore the default for other tests.
    await page.goto('/admin/enquiries/settings');
    await page.getByLabel('Accept enquiries from the website contact form').uncheck();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
  });

  test('inbox pages have no detectable WCAG A/AA violations', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 1000, 'run once');
    const ref = await submitEnquiry(page, { name: uniqueName('Axe Inbox') });
    await loginAsAdmin(page, '/admin/enquiries', OPEN);
    await openEnquiry(page, ref);
    for (const url of [page.url(), `${OPEN_BASE}/admin/enquiries`, `${OPEN_BASE}/admin/enquiries/settings`]) {
      await page.goto(url);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(results.violations.map((v) => `${url} ${v.id}: ${v.nodes.length}`)).toEqual([]);
    }
  });
});
