import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin, uniqueName, OPEN_BASE, OPEN_STORAGE } from './helpers/admin';

async function fillValid(page: Page, name = 'Test Customer') {
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Phone number').fill('98765 43210');
  await page.getByLabel(/^Email address/).fill('customer@example.com');
  await page.getByLabel('Service required').selectOption('solar-panel-cleaning');
  await page.getByLabel('State or union territory').selectOption({ label: 'Rajasthan' });
  await page.getByLabel('Site location').fill('Jaipur');
  await page.getByLabel(/^Message/).fill('Rooftop system, around 200 kW.');
  await page.getByLabel(/I agree to VK Solar contacting me/).check();
}

/** Count enquiries in the open server's inbox matching a search term. */
async function inboxCount(page: Page, term: string) {
  await page.goto(`${OPEN_BASE}/admin/enquiries?q=${encodeURIComponent(term)}`);
  return page.getByRole('rowheader').count();
}

test.describe('closed form (default: submissions off)', () => {
  test('shows the "not active" notice before any input', async ({ page }) => {
    await page.goto('/contact');
    const notice = page.locator('[data-unconfigured]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Online enquiries are not active yet');
    await expect(page.locator('[data-enquiry]')).toHaveAttribute('data-configured', 'false');
  });

  test('a valid submit says it was NOT sent and makes no request', async ({ page }) => {
    let requests = 0;
    page.on('request', (r) => r.url().includes('/api/enquiries') && requests++);
    await page.goto('/contact');
    await fillValid(page);
    await page.getByRole('button', { name: 'Request free inspection' }).click();
    const status = page.locator('[data-status]');
    await expect(status).toContainText('was not sent');
    await expect(status).not.toContainText(/thank you|received/i);
    expect(requests).toBe(0);
  });

  test('the server refuses submissions while closed and stores nothing', async ({ request }) => {
    const res = await request.post('/api/enquiries', {
      data: { name: 'Should Not Store', phone: '9876543210', service: 'ac-service', region: 'goa', location: 'Panaji', consent: true, _t: 'x' },
      headers: { Origin: 'http://127.0.0.1:4397' },
    });
    expect(res.status()).toBe(503);
    expect((await res.json()).code).toBe('disabled');
  });
});

test.describe('validation (runs in the browser, mirrors the server)', () => {
  test('empty submit shows an error summary, inline errors and focuses the summary', async ({ page }) => {
    await page.goto('/contact');
    await page.getByRole('button', { name: 'Request free inspection' }).click();
    const summary = page.locator('[data-error-summary]');
    await expect(summary).toBeVisible();
    await expect(summary).toBeFocused();
    await expect(summary.getByRole('link')).toHaveCount(6);
    for (const label of ['Full name', 'Phone number', 'Service required', 'State or union territory', 'Site location']) {
      await expect(page.getByLabel(label)).toHaveAttribute('aria-invalid', 'true');
    }
    await expect(page.locator('#f-consent-error')).toContainText('confirm we may contact you');
    await summary.getByRole('link', { name: /phone number/i }).click();
    await expect(page.getByLabel('Phone number')).toBeFocused();
  });

  test('invalid phone and email are rejected on blur and cleared when corrected', async ({ page }) => {
    await page.goto('/contact');
    const phone = page.getByLabel('Phone number');
    await phone.fill('12345');
    await phone.blur();
    await expect(page.locator('#f-phone-error')).toContainText('valid Indian phone number');
    await phone.fill('+91 98765 43210');
    await expect(page.locator('#f-phone-error')).toBeEmpty();

    const email = page.getByLabel(/^Email address/);
    await email.fill('not-an-email');
    await email.blur();
    await expect(page.locator('#f-email-error')).toContainText('valid email');
    await email.fill('');
    await expect(page.locator('#f-email-error')).toBeEmpty();
  });

  test('honeypot is not reachable by keyboard or visible', async ({ page }) => {
    await page.goto('/contact');
    const trap = page.locator('[name="hp_company"]');
    await expect(trap).toHaveAttribute('tabindex', '-1');
    const box = await trap.boundingBox();
    expect(box === null || box.x < 0).toBe(true);
  });

  test('service CTA pre-selects the service on the contact form', async ({ page }) => {
    await page.goto('/services');
    await page.locator('#ac-service').getByRole('link', { name: 'Request this service' }).click();
    await expect(page).toHaveURL(/\/contact\?service=ac-service#enquiry/);
    await expect(page.getByLabel('Service required')).toHaveValue('ac-service');
  });

  test('availability box on Service Areas pre-fills the location', async ({ page }) => {
    await page.goto('/service-areas');
    await page.getByLabel('Your site location').fill('Jodhpur');
    await page.getByRole('button', { name: /Check availability/ }).click();
    await expect(page).toHaveURL(/\/contact\?location=Jodhpur#enquiry/);
    await expect(page.getByLabel('Site location')).toHaveValue('Jodhpur');
  });
});

test.describe('open form (database-backed)', () => {
  test('successful submission is stored and only then shown as received, with a reference', async ({ page }) => {
    const name = uniqueName('Stored Customer');
    // Hold the server's reply until the loading state has been checked.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    await page.route('**/api/enquiries', async (route) => {
      await released;
      await route.continue();
    });
    await page.goto(`${OPEN_BASE}/contact`);
    await expect(page.locator('[data-unconfigured]')).toHaveCount(0);
    await fillValid(page, name);

    const submit = page.locator('[data-submit]');
    await submit.click();
    await expect(submit).toBeDisabled();
    await expect(submit).toContainText('Sending');
    await expect(page.locator('[data-status]')).not.toContainText(/received/i);
    release();

    const status = page.locator('[data-status]');
    await expect(status).toContainText(/your enquiry has been received \(reference ENQ-\d{8}-[0-9A-F]{6}\)/);
    await expect(submit).toBeEnabled();
    await expect(page.getByLabel('Full name')).toHaveValue('');

    // It really is in the database: visible in the admin inbox.
    await loginAsAdmin(page, '/admin/enquiries', { base: OPEN_BASE, storage: OPEN_STORAGE });
    expect(await inboxCount(page, name)).toBe(1);
  });

  test('double-clicking submit stores only one enquiry', async ({ page }) => {
    const name = uniqueName('Double Click');
    await page.goto(`${OPEN_BASE}/contact`);
    await fillValid(page, name);
    await page.locator('[data-submit]').dblclick();
    await expect(page.locator('[data-status]')).toContainText('has been received');
    await loginAsAdmin(page, '/admin/enquiries', { base: OPEN_BASE, storage: OPEN_STORAGE });
    expect(await inboxCount(page, name)).toBe(1);
  });

  test('server-side validation rejects bad data even when the browser checks are bypassed', async ({ page }) => {
    await page.goto(`${OPEN_BASE}/contact`);
    const token = await page.locator('input[name="_t"]').inputValue();
    const res = await page.request.post(`${OPEN_BASE}/api/enquiries`, {
      data: { name: 'X', phone: '123', email: 'bad', service: 'hacking', region: 'atlantis', location: '', consent: false, _t: token },
      headers: { Origin: OPEN_BASE },
    });
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(Object.keys(body.errors).sort()).toEqual(['consent', 'email', 'location', 'name', 'phone', 'region', 'service']);
  });

  test('server errors are shown truthfully and keep the user’s input', async ({ page }) => {
    await page.route('**/api/enquiries', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'server', message: 'Sorry, something went wrong on our side and your enquiry was not saved. Please try again later.' }) }),
    );
    await page.goto(`${OPEN_BASE}/contact`);
    await fillValid(page);
    await page.locator('[data-submit]').click();
    await expect(page.locator('[data-status]')).toContainText('was not saved');
    await expect(page.locator('[data-status]')).not.toContainText(/received/i);
    await expect(page.getByLabel('Full name')).toHaveValue('Test Customer');
  });

  test('network failure shows an error, not success', async ({ page }) => {
    await page.route('**/api/enquiries', (route) => route.abort());
    await page.goto(`${OPEN_BASE}/contact`);
    await fillValid(page);
    await page.locator('[data-submit]').click();
    await expect(page.locator('[data-status]')).toContainText('could not be sent');
  });

  test('works without JavaScript (plain form post + redirect)', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    const name = uniqueName('No Script');
    await page.goto(`${OPEN_BASE}/contact`);
    await fillValid(page, name);
    await page.getByRole('button', { name: 'Request free inspection' }).click();
    await expect(page).toHaveURL(/\/contact\?enquiry=sent&ref=ENQ-\d{8}-[0-9A-F]{6}#enquiry$/);
    await expect(page.locator('[data-status]')).toContainText('has been received');
    await context.close();

    const admin = await browser.newPage();
    await loginAsAdmin(admin, '/admin/enquiries', { base: OPEN_BASE, storage: OPEN_STORAGE });
    expect(await inboxCount(admin, name)).toBe(1);
    await admin.close();
  });

  test('a forged reference in the URL is not displayed', async ({ page }) => {
    await page.goto(`${OPEN_BASE}/contact?enquiry=sent&ref=<script>alert(1)</script>#enquiry`);
    await expect(page.locator('[data-status]')).toBeEmpty();
  });
});
