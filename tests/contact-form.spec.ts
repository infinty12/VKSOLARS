import { test, expect, type Page } from '@playwright/test';

const ENDPOINT = 'https://api.web3forms.com/submit';

async function fillValid(page: Page) {
  await page.getByLabel('Full name').fill('Test Customer');
  await page.getByLabel('Phone number').fill('98765 43210');
  await page.getByLabel('Site location').fill('Jaipur');
  await page.getByLabel('Service required').selectOption('solar-panel-cleaning');
  await page.getByLabel(/^Message/).fill('Rooftop system, around 200 kW.');
}

/** Simulate a configured form (a real key is supplied via PUBLIC_WEB3FORMS_KEY at build time). */
async function markConfigured(page: Page) {
  await page.locator('[data-enquiry]').evaluate((form) => form.setAttribute('data-configured', 'true'));
}

test.beforeEach(async ({ page }) => {
  // No test may ever reach the real form provider.
  await page.route(ENDPOINT, (route) => route.abort());
});

test('empty submit shows an error summary, inline errors and focuses the summary', async ({ page }) => {
  await page.goto('/contact');
  await page.getByRole('button', { name: 'Request free inspection' }).click();

  const summary = page.locator('[data-error-summary]');
  await expect(summary).toBeVisible();
  await expect(summary).toBeFocused();
  await expect(summary.getByRole('link')).toHaveCount(4);

  for (const label of ['Full name', 'Phone number', 'Site location', 'Service required']) {
    await expect(page.getByLabel(label)).toHaveAttribute('aria-invalid', 'true');
  }
  await expect(page.locator('#f-phone-error')).toContainText('phone number');

  // Summary links move focus to the field.
  await summary.getByRole('link', { name: /phone number/i }).click();
  await expect(page.getByLabel('Phone number')).toBeFocused();
});

test('invalid phone is rejected on blur and cleared when corrected', async ({ page }) => {
  await page.goto('/contact');
  const phone = page.getByLabel('Phone number');
  await phone.fill('12345');
  await phone.blur();
  await expect(page.locator('#f-phone-error')).toContainText('valid Indian phone number');
  await expect(phone).toHaveAttribute('aria-invalid', 'true');
  await phone.fill('+91 98765 43210');
  await expect(page.locator('#f-phone-error')).toBeEmpty();
  await expect(phone).not.toHaveAttribute('aria-invalid', 'true');
});

test('without a configured key, the form is visibly marked as not active before any input', async ({ page }) => {
  await page.goto('/contact');
  const notice = page.locator('[data-unconfigured]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Online enquiries are not active yet');
  await expect(page.locator('[data-enquiry]')).toHaveAttribute('data-configured', 'false');
  await expect(page.locator('input[name="access_key"]')).toHaveCount(0);
});

test('without a configured key, a valid submit reports it was NOT sent and makes no request', async ({ page }) => {
  let requests = 0;
  await page.route(ENDPOINT, (route) => {
    requests++;
    return route.abort();
  });
  await page.goto('/contact');
  await fillValid(page);
  await page.getByRole('button', { name: 'Request free inspection' }).click();
  const status = page.locator('[data-status]');
  await expect(status).toContainText('was not sent');
  await expect(status).not.toContainText(/thank you/i);
  expect(requests).toBe(0);
});

test('successful submission shows success only after the provider confirms, and resets the form', async ({ page }) => {
  let body: Record<string, unknown> = {};
  // Hold the provider's reply until the loading state has been checked, so the assertion
  // can't race a fixed delay on a busy machine.
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  await page.route(ENDPOINT, async (route) => {
    body = route.request().postDataJSON();
    await released;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });
  await page.goto('/contact');
  await markConfigured(page);
  await fillValid(page);

  const submit = page.locator('[data-submit]');
  await submit.click();
  // Loading state blocks duplicate submissions, and no success is shown before the provider replies.
  await expect(submit).toBeDisabled();
  await expect(submit).toContainText('Sending');
  await expect(page.locator('[data-status]')).not.toContainText(/thank you/i);
  release();

  await expect(page.locator('[data-status]')).toContainText('your enquiry has been sent');
  await expect(submit).toBeEnabled();
  await expect(page.getByLabel('Full name')).toHaveValue('');

  expect(body.name).toBe('Test Customer');
  expect(body.phone).toBe('98765 43210');
  expect(body.location).toBe('Jaipur');
  expect(body.service).toBe('Solar Panel Cleaning');
  expect(body.botcheck).toBeUndefined();
});

test('provider error keeps the user’s input and shows a truthful error', async ({ page }) => {
  await page.route(ENDPOINT, (route) =>
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, message: 'Invalid key' }) }),
  );
  await page.goto('/contact');
  await markConfigured(page);
  await fillValid(page);
  await page.locator('[data-submit]').click();
  await expect(page.locator('[data-status]')).toContainText('could not be sent');
  await expect(page.locator('[data-status]')).not.toContainText(/thank you/i);
  await expect(page.getByLabel('Full name')).toHaveValue('Test Customer');
  await expect(page.locator('[data-submit]')).toBeEnabled();
});

test('network failure shows an error, not success', async ({ page }) => {
  await page.goto('/contact');
  await markConfigured(page);
  await fillValid(page);
  await page.locator('[data-submit]').click(); // route aborted in beforeEach
  await expect(page.locator('[data-status]')).toContainText('could not be sent');
});

test('double-clicking submit sends only one request', async ({ page }) => {
  let requests = 0;
  await page.route(ENDPOINT, async (route) => {
    requests++;
    await new Promise((r) => setTimeout(r, 500));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });
  await page.goto('/contact');
  await markConfigured(page);
  await fillValid(page);
  await page.locator('[data-submit]').dblclick();
  await expect(page.locator('[data-status]')).toContainText('has been sent');
  expect(requests).toBe(1);
});

test('service CTA pre-selects the service on the contact form', async ({ page }) => {
  await page.goto('/services');
  await page.locator('#ac-service').getByRole('link', { name: 'Request this service' }).click();
  await expect(page).toHaveURL(/\/contact\?service=ac-service#enquiry/);
  await expect(page.getByLabel('Service required')).toHaveValue('ac-service');
});

test('availability form on Service Areas pre-fills the location', async ({ page }) => {
  await page.goto('/service-areas');
  await page.getByLabel('Your site location').fill('Jodhpur');
  await page.getByRole('button', { name: /Check availability/ }).click();
  await expect(page).toHaveURL(/\/contact\?location=Jodhpur#enquiry/);
  await expect(page.getByLabel('Site location')).toHaveValue('Jodhpur');
});

test('honeypot is not reachable by keyboard or visible', async ({ page }) => {
  await page.goto('/contact');
  const trap = page.locator('[name="botcheck"]');
  await expect(trap).toHaveAttribute('tabindex', '-1');
  const box = await trap.boundingBox();
  expect(box === null || box.x < 0).toBe(true);
});
