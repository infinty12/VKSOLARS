import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAsAdmin, CONTENT_BASE, CONTENT_STORAGE } from './helpers/admin';

// Runs against the dedicated "content" server (see playwright.config.ts): publishing changes the
// header/footer of every page there, so nothing else uses that server.
const CONTENT = { base: CONTENT_BASE, storage: CONTENT_STORAGE };
const EDITOR = `${CONTENT_BASE}/admin/site-content`;
const PREVIEW = `${EDITOR}/preview`;
const INJECTION = '<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 2">';

async function fill(page: Page, values: Record<string, string>) {
  for (const [label, value] of Object.entries(values)) await page.getByLabel(label, { exact: true }).fill(value);
}

async function saveDraft(page: Page, values: Record<string, string>) {
  await page.goto(EDITOR);
  await fill(page, values);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/msg=contentDraft$/);
}

async function publish(page: Page) {
  await page.goto(EDITOR);
  await page.getByRole('button', { name: 'Publish draft' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(page).toHaveURL(/msg=contentPublished$/);
}

const ALL_EMPTY = {
  'Phone number': '',
  'Phone number as displayed': '',
  'WhatsApp number': '',
  'Email address': '',
  'Office address': '',
  'Opening hours': '',
  'LinkedIn page': '',
  'Instagram profile': '',
  'Facebook page': '',
  'YouTube channel': '',
  'Year founded': '',
};

test.describe('access control', () => {
  test('signed-out visitors cannot open the editor or the draft preview', async ({ page }) => {
    for (const url of [EDITOR, PREVIEW]) {
      await page.goto(url);
      await expect(page).toHaveURL(/\/admin\/login\?next=/);
    }
  });

  test('signed-out and token-less posts are refused', async ({ page, request }) => {
    const forms: Record<string, string>[] = [{ _action: 'save', email: 'x@example.com' }, { _action: 'publish' }, { _action: 'restore', revision: '1' }];
    for (const form of forms) {
      const res = await request.post(EDITOR, { form, maxRedirects: 0 });
      expect(res.status()).toBe(303);
      expect(res.headers().location).toMatch(/^\/admin\/login/);
    }
    await loginAsAdmin(page, '/admin/site-content', CONTENT);
    const res = await page.request.post(EDITOR, { form: { _action: 'publish' }, headers: { Origin: CONTENT_BASE }, maxRedirects: 0 });
    expect(res.status()).toBe(403);
  });
});

// One shared published state on the content server, so these run in order, once (desktop).
test.describe('draft, preview, publish and history', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(({ isMobile }) => !!isMobile, 'mutates shared published state; phone layout is checked inside with a phone-sized context');

  // Our confirmations use an in-page <dialog>; a native alert/confirm would mean injected script ran.
  let nativeDialogs: string[] = [];
  test.beforeEach(async ({ page }) => {
    nativeDialogs = [];
    page.on('dialog', (d) => {
      nativeDialogs.push(d.type());
      void d.dismiss();
    });
    await loginAsAdmin(page, '/admin/site-content', CONTENT);
  });
  test.afterEach(() => expect(nativeDialogs).toEqual([]));

  test('a saved draft is visible in the admin preview only', async ({ page, request }) => {
    await saveDraft(page, {
      ...ALL_EMPTY,
      'Phone number': '+91 90000 12345',
      'Phone number as displayed': '+91 90000 12345',
      'Email address': 'office@example.com',
      'Office address': `Plot 7, Example Industrial Area\n${INJECTION}`,
      'Opening hours': 'Mon–Sat 9:00–18:00\nSunday closed',
    });
    await expect(page.getByText('Not public until published.')).toBeVisible();
    await expect(page.locator('.sc-changes')).toContainText('Phone number');

    // Public pages are unchanged.
    for (const path of ['/', '/contact', '/services']) {
      const html = await (await request.get(`${CONTENT_BASE}${path}`)).text();
      expect(html, path).not.toContain('90000 12345');
      expect(html, path).not.toContain('office@example.com');
    }

    // The preview shows the draft, is marked as such and is not indexable or cacheable.
    const res = await page.goto(PREVIEW);
    expect(res!.headers()['x-robots-tag']).toContain('noindex');
    expect(res!.headers()['cache-control']).toContain('no-store');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await expect(page.getByRole('note', { name: 'Draft preview' })).toContainText('Only visible to signed-in administrators');
    await expect(page.locator('.header-call')).toContainText('+91 90000 12345');
    await expect(page.locator('[data-field="address"]')).toHaveText(`Plot 7, Example Industrial Area\n${INJECTION}`);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  });

  test('publishing makes it public — as plain text, with line breaks kept and safe structured data', async ({ page, browser }) => {
    await publish(page);

    const visitor = await browser.newContext(); // not signed in
    const pub = await visitor.newPage();
    pub.on('dialog', (d) => {
      nativeDialogs.push(d.type());
      void d.dismiss();
    });
    await pub.goto(`${CONTENT_BASE}/contact`);
    const address = pub.locator('[data-field="address"]');
    await expect(address).toHaveText(`Plot 7, Example Industrial Area\n${INJECTION}`);
    expect(await address.evaluate((el) => el.children.length), 'no elements created from the stored text').toBe(0);
    expect(await address.evaluate((el) => (el as HTMLElement).innerText)).toContain('Area\n<script>'); // line break rendered
    await expect(pub.locator('[data-field="hours"]')).toHaveText('Mon–Sat 9:00–18:00\nSunday closed');
    await expect(pub.locator('.site-footer').getByRole('link', { name: 'office@example.com' })).toHaveAttribute('href', 'mailto:office@example.com');
    await expect(pub.locator('.header-call')).toHaveAttribute('href', 'tel:+919000012345');
    expect(await pub.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

    // JSON-LD on the home page: still exactly one block, valid JSON, "</script>" cannot break out.
    await pub.goto(`${CONTENT_BASE}/`);
    const blocks = pub.locator('script[type="application/ld+json"]');
    await expect(blocks).toHaveCount(1);
    const data = JSON.parse((await blocks.textContent())!);
    expect(data['@type']).toBe('LocalBusiness');
    expect(data.address).toContain('<script>window.__pwned = 1</script>');
    expect(data.telephone).toBe('+919000012345');
    expect(await pub.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await visitor.close();

    // Phone-sized screens: published content never makes public pages wider than the screen.
    for (const width of [375, 390]) {
      const phone = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
      const p = await phone.newPage();
      for (const path of ['/', '/contact', '/about']) {
        await p.goto(`${CONTENT_BASE}${path}`);
        const size = await p.evaluate(() => ({ doc: document.documentElement.scrollWidth, layout: window.innerWidth }));
        expect(size.doc, `${path} at ${width}px`).toBeLessThanOrEqual(width);
        expect(size.layout, `${path} at ${width}px`).toBe(width);
      }
      await phone.close();
    }
  });

  test('revision history lists versions and an old one can be restored, then published', async ({ page, request }) => {
    await saveDraft(page, { 'Email address': 'second@example.com' });
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toContainText('Current draft');
    await expect(page.locator('table')).toContainText('Live');
    expect(await (await request.get(`${CONTENT_BASE}/contact`)).text()).toContain('office@example.com');

    await publish(page);
    await expect(page.locator('table tbody tr').first()).toContainText('Live');
    await expect(page.locator('table')).toContainText('Previously live');

    // Restore the version with office@example.com (the previously live one).
    const old = page.locator('table tbody tr').filter({ hasText: 'Previously live' }).first();
    await old.getByRole('button', { name: /Restore as draft/ }).click();
    await expect(page).toHaveURL(/msg=contentRestored$/);
    await expect(page.locator('table tbody tr').first()).toContainText('restored from');
    expect(await (await request.get(`${CONTENT_BASE}/contact`)).text(), 'restore alone changes nothing public').toContain('second@example.com');
    await expect(page.getByLabel('Email address', { exact: true })).toHaveValue('office@example.com');

    await publish(page);
    const html = await (await request.get(`${CONTENT_BASE}/contact`)).text();
    expect(html).toContain('office@example.com');
    expect(html).not.toContain('second@example.com');
  });

  test('a draft can be discarded without touching the live site', async ({ page, request }) => {
    await saveDraft(page, { 'Email address': 'discard-me@example.com' });
    await page.getByRole('button', { name: 'Discard draft' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect(page).toHaveURL(/msg=contentDiscarded$/);
    await expect(page.getByText('No unpublished changes.')).toBeVisible();
    expect(await (await request.get(`${CONTENT_BASE}/contact`)).text()).not.toContain('discard-me@example.com');
    await page.goto(PREVIEW);
    await expect(page).toHaveURL(/msg=noDraft$/);
  });

  test('invalid input is refused with clear errors and nothing is saved', async ({ page }) => {
    await page.goto(EDITOR);
    const revisionsBefore = await page.locator('table tbody tr').count();
    await fill(page, { 'Phone number': '98765', 'LinkedIn page': 'https://linkedin.com.evil.example/x', 'Year founded': '1850' });
    await page.getByRole('button', { name: 'Save draft' }).click();
    const summary = page.getByRole('alert').filter({ hasText: 'Please correct these fields' });
    await expect(summary).toBeVisible();
    await expect(summary).toBeFocused();
    for (const label of ['Phone number', 'LinkedIn page', 'Year founded']) {
      await expect(page.getByLabel(label, { exact: true })).toHaveAttribute('aria-invalid', 'true');
    }
    await expect(page.getByLabel('LinkedIn page', { exact: true })).toHaveValue('https://linkedin.com.evil.example/x'); // kept for correction
    await page.goto(EDITOR);
    await expect(page.locator('table tbody tr')).toHaveCount(revisionsBefore);
  });

  test('publishing empty values hides those parts of the site, leaving no empty sections', async ({ page, browser }) => {
    await saveDraft(page, ALL_EMPTY);
    await publish(page);
    const visitor = await browser.newContext(); // not signed in
    const pub = await visitor.newPage();
    await pub.goto(`${CONTENT_BASE}/contact`);
    await expect(pub.getByText('The enquiry form is the quickest way to reach us.')).toBeVisible();
    for (const selector of ['.contact-list', '.header-call', '.floating-actions', '.site-footer__social', 'a[href^="tel:"]', 'a[href^="mailto:"]', 'a[href*="wa.me"]']) {
      await expect(pub.locator(selector), selector).toHaveCount(0);
    }
    await visitor.close();

    await page.goto(`${CONTENT_BASE}/`);
    await expect(page.locator('.site-footer__contact li')).toHaveCount(1); // only "Send an enquiry"
    await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(1);
    expect(JSON.parse((await page.locator('script[type="application/ld+json"]').textContent())!)['@type']).toBe('Organization');
  });

  test('editor and preview have no detectable WCAG A/AA violations', async ({ page }) => {
    await saveDraft(page, { 'Email address': 'axe@example.com', 'Office address': 'Line one\nLine two' });
    for (const url of [EDITOR, PREVIEW]) {
      await page.goto(url);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(results.violations.map((v) => `${url} ${v.id}: ${v.nodes.length}`)).toEqual([]);
    }
  });
});
