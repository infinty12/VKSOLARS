import { test, expect, type Page, type Browser } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import sharp from 'sharp';
import { loginAsAdmin, CONTENT_BASE, CONTENT_STORAGE } from './helpers/admin';

// Runs on the dedicated "content" server (see playwright.config.ts). All values below are
// obviously fictitious test data in disposable storage — never real company facts.
const CONTENT = { base: CONTENT_BASE, storage: CONTENT_STORAGE };
const ADMIN = `${CONTENT_BASE}/admin/content`;
const INJECTION = '<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 2">';

const field = (page: Page, name: string) => page.locator(`#f-${name}`);

async function fillItem(page: Page, values: Record<string, string | boolean>) {
  for (const [name, v] of Object.entries(values)) {
    if (typeof v === 'boolean') await field(page, name).setChecked(v);
    else if ((await field(page, name).evaluate((el) => el.tagName)) === 'SELECT') await field(page, name).selectOption(v);
    else await field(page, name).fill(v);
  }
}

/** Create an item through the form; returns its admin URL. */
async function createItem(page: Page, kind: string, values: Record<string, string | boolean>) {
  await page.goto(`${ADMIN}/${kind}/new`);
  await fillItem(page, values);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/content/${kind}/\\d+\\?msg=itemSaved$`));
  return page.url().replace(/\?.*$/, '');
}

async function confirmAction(page: Page, button: string | RegExp, expectMsg: string) {
  await page.getByRole('button', { name: button, exact: typeof button === 'string' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(page).toHaveURL(new RegExp(`msg=${expectMsg}`));
}

async function visitorPage(browser: Browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  return { page, close: () => ctx.close() };
}

const csrfOf = (page: Page) => page.locator('input[name="_csrf"]').first().inputValue();

test.describe('access control', () => {
  test('signed-out visitors cannot open the content admin or the draft preview', async ({ page }) => {
    for (const path of ['', '/preview', '/stat/new', '/team/1']) {
      await page.goto(`${ADMIN}${path}`);
      await expect(page).toHaveURL(/\/admin\/login\?next=/);
    }
  });

  test('signed-out and token-less changes are refused', async ({ page, request }) => {
    const forms: [string, Record<string, string>][] = [
      [ADMIN, { _action: 'move', id: '1', direction: 'up' }],
      [`${ADMIN}/stat/new`, { _action: 'save', value: '1', label: 'x' }],
      [`${ADMIN}/stat/1`, { _action: 'publish' }],
    ];
    for (const [url, form] of forms) {
      const res = await request.post(url, { form, maxRedirects: 0 });
      expect(res.status(), url).toBe(303);
      expect(res.headers().location).toMatch(/^\/admin\/login/);
    }
    await loginAsAdmin(page, '/admin/content', CONTENT);
    for (const [url, form] of forms) {
      const res = await page.request.post(url, { form, headers: { Origin: CONTENT_BASE }, maxRedirects: 0 });
      expect(res.status(), url).toBe(403);
    }
  });
});

test.describe('verified content', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(({ isMobile }) => !!isMobile, 'mutates shared published state; phone layout is checked inside with phone-sized contexts');

  let nativeDialogs: string[] = [];
  test.beforeEach(async ({ page }) => {
    nativeDialogs = [];
    page.on('dialog', (d) => {
      nativeDialogs.push(d.type());
      void d.dismiss();
    });
    await loginAsAdmin(page, '/admin/content', CONTENT);
  });
  test.afterEach(() => expect(nativeDialogs).toEqual([]));

  test('a statistic needs a source and verification before it can be published; drafts stay private', async ({ page, browser }) => {
    const url = await createItem(page, 'stat', { value: '1,250', suffix: '+', label: 'Test figure (example)' });
    await expect(page.getByText('Draft — not on the website')).toBeVisible();
    await expect(page.getByText('Add the source of this figure.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();

    // A forged publish request is refused by the server too.
    const forged = await page.request.post(url, { form: { _csrf: await csrfOf(page), _action: 'publish' }, headers: { Origin: CONTENT_BASE } });
    expect(forged.status()).toBe(422);

    const visitor = await visitorPage(browser);
    await visitor.page.goto(`${CONTENT_BASE}/`);
    await expect(visitor.page.locator('#stats-title')).toHaveCount(0);

    // The admin preview shows the draft.
    const pre = await page.goto(`${ADMIN}/preview`);
    expect(pre!.headers()['x-robots-tag']).toContain('noindex');
    expect(pre!.headers()['cache-control']).toContain('no-store');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await expect(page.locator('[data-count="1250"]')).toHaveCount(1);

    await page.goto(url);
    await fillItem(page, { source: 'TEST-ONLY-SOURCE-NOTE', verified: true });
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('Ready to publish.')).toBeVisible();
    await confirmAction(page, 'Publish', 'itemPublished');

    for (const path of ['/', '/about']) {
      await visitor.page.goto(`${CONTENT_BASE}${path}`);
      await expect(visitor.page.locator('.stats__item')).toHaveCount(1);
      await expect(visitor.page.locator('.stats__label')).toHaveText('Test figure (example)');
      await expect(visitor.page.locator('[data-count="1250"]')).toHaveCount(1);
      expect(await visitor.page.content(), 'the source note is never public').not.toContain('TEST-ONLY-SOURCE-NOTE');
    }
    await visitor.close();
  });

  test('testimonials need recorded approval; edits stay private until republished; text is never HTML', async ({ page, browser }) => {
    const quote = `Test quote line one.\n${INJECTION}`;
    const url = await createItem(page, 'testimonial', { quote, name: 'Test Client (example)', organisation: 'Example Org' });
    await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    await fillItem(page, { approved: true });
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('Record how and when the client approved publication.')).toBeVisible();
    await fillItem(page, { approvalNote: 'TEST-ONLY-APPROVAL-RECORD' });
    await page.getByRole('button', { name: 'Save draft' }).click();
    await confirmAction(page, 'Publish', 'itemPublished');

    const visitor = await visitorPage(browser);
    visitor.page.on('dialog', (d) => {
      nativeDialogs.push(d.type());
      void d.dismiss();
    });
    await visitor.page.goto(`${CONTENT_BASE}/`);
    const q = visitor.page.locator('.testimonial blockquote p');
    await expect(q).toHaveText(`“${quote}”`);
    expect(await q.evaluate((el) => el.children.length), 'no elements created from stored text').toBe(0);
    expect(await q.evaluate((el) => (el as HTMLElement).innerText)).toContain('one.\n<script>');
    expect(await visitor.page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(await visitor.page.content()).not.toContain('TEST-ONLY-APPROVAL-RECORD');
    await expect(visitor.page.locator('script[type="application/ld+json"]')).not.toContainText('Test Client'); // no reviews in structured data

    // Edit → still the old version publicly; then discard.
    await page.goto(url);
    await fillItem(page, { quote: 'Edited draft quote' });
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('your latest edits are not public yet')).toBeVisible();
    await visitor.page.reload();
    await expect(q).toContainText('Test quote line one.');
    await expect(visitor.page.getByText('Edited draft quote')).toHaveCount(0);
    await confirmAction(page, 'Discard changes', 'itemDiscarded');
    await expect(field(page, 'quote')).toHaveValue(quote);

    // Unpublish → gone from the site; delete is allowed only once unpublished.
    await expect(page.getByRole('button', { name: 'Delete' })).toBeDisabled();
    await confirmAction(page, 'Unpublish', 'itemUnpublished');
    await visitor.page.reload();
    await expect(visitor.page.locator('.testimonial')).toHaveCount(0);
    await confirmAction(page, 'Delete', 'deleted');
    await visitor.close();
  });

  test('team photos come from the media library, block media deletion while in use, and are released', async ({ page, browser }) => {
    // Upload a photo through the media library.
    await page.goto(`${CONTENT_BASE}/admin/media`);
    const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 84, g: 131, b: 179 } } }).png().toBuffer();
    await page.getByLabel('Image file').setInputFiles({ name: 'test-portrait.png', mimeType: 'image/png', buffer: png });
    await page.getByLabel(/^Alt text/).fill('Test portrait (example)');
    await page.getByRole('button', { name: 'Upload image' }).click();
    await expect(page).toHaveURL(/\/admin\/media\/\d+\?msg=uploaded$/);
    const mediaUrl = page.url().replace(/\?.*$/, '');
    const mediaId = mediaUrl.match(/(\d+)$/)![1];
    const src = (await page.locator('.mdd-preview img').getAttribute('src'))!;

    const url = await createItem(page, 'team', { name: 'Test Person (example)', role: 'Test role', bio: 'Line one\nLine two', photoId: mediaId, consent: true });
    await confirmAction(page, 'Publish', 'itemPublished');

    const visitor = await visitorPage(browser);
    await visitor.page.goto(`${CONTENT_BASE}/about`);
    await expect(visitor.page.getByRole('img', { name: 'Test portrait (example)' })).toHaveAttribute('src', src.replace('.webp', '-thumb.webp'));
    await expect(visitor.page.locator('.member__bio')).toHaveText('Line one\nLine two');
    await expect(visitor.page.locator('[data-placeholder="team"]')).toHaveCount(0);

    // The media item is in use: delete disabled and refused.
    await page.goto(mediaUrl);
    await expect(page.getByText(/This image is in use in 2 places/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete image' })).toBeDisabled();
    const refused = await page.request.post(mediaUrl, { form: { _csrf: await csrfOf(page), _action: 'delete' }, headers: { Origin: CONTENT_BASE }, maxRedirects: 0 });
    expect(refused.headers().location).toMatch(/msg=inuse$/);
    expect((await visitor.page.request.get(`${CONTENT_BASE}${src}`)).status()).toBe(200);

    // Unpublish and delete the member → the photo is released and can be deleted.
    await page.goto(url);
    await confirmAction(page, 'Unpublish', 'itemUnpublished');
    await confirmAction(page, 'Delete', 'deleted');
    await page.goto(mediaUrl);
    await expect(page.getByText('Not used anywhere on the site.')).toBeVisible();
    await confirmAction(page, 'Delete image', 'deleted');
    await visitor.page.goto(`${CONTENT_BASE}/about`);
    await expect(visitor.page.locator('[data-placeholder="team"]')).toBeVisible(); // empty team → "coming soon" note
    await visitor.close();
  });

  test('ordering takes effect immediately on the website', async ({ page, browser }) => {
    for (const text of ['Test credential A', 'Test credential B', 'Test credential C']) {
      await createItem(page, 'achievement', { text, evidence: 'Test evidence', verified: true });
      await confirmAction(page, 'Publish', 'itemPublished');
    }
    const visitor = await visitorPage(browser);
    const list = () => visitor.page.locator('.achievements li');
    await visitor.page.goto(`${CONTENT_BASE}/about`);
    await expect(list()).toHaveText(['Test credential A', 'Test credential B', 'Test credential C']);

    await page.goto(ADMIN);
    const section = page.locator('section[aria-labelledby="ct-achievement-title"]');
    await expect(section.getByRole('button', { name: /^Up\s*: move/ }).first()).toBeDisabled();
    await section.getByRole('button', { name: /^Up\s*: move “Test credential C” up$/ }).click();
    await expect(page).toHaveURL(/msg=itemMoved/);
    await visitor.page.reload();
    await expect(list()).toHaveText(['Test credential A', 'Test credential C', 'Test credential B']);

    // Long unbroken text never makes public pages wider than a phone screen.
    await createItem(page, 'achievement', { text: `Test-${'x'.repeat(150)}`, evidence: 'e', verified: true });
    await confirmAction(page, 'Publish', 'itemPublished');
    for (const width of [375, 390]) {
      const phone = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
      const p = await phone.newPage();
      for (const path of ['/', '/about']) {
        await p.goto(`${CONTENT_BASE}${path}`);
        const size = await p.evaluate(() => ({ doc: document.documentElement.scrollWidth, layout: window.innerWidth }));
        expect(size.doc, `${path} at ${width}px`).toBeLessThanOrEqual(width);
        expect(size.layout, `${path} at ${width}px`).toBe(width);
      }
      await phone.close();
    }
    await visitor.close();
  });

  test('admin content pages and the preview have no detectable WCAG A/AA violations', async ({ page }) => {
    await page.goto(ADMIN);
    const first = await page.locator('.ct-item__link').first().getAttribute('href');
    for (const url of [ADMIN, `${CONTENT_BASE}${first}`, `${ADMIN}/team/new`, `${ADMIN}/preview`]) {
      await page.goto(url);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(results.violations.map((v) => `${url} ${v.id}: ${v.nodes.length}`)).toEqual([]);
    }
  });
});
