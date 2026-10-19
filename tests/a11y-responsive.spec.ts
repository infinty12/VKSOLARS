import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAsAdmin } from './helpers/admin';

const pages = ['/', '/services', '/ai-drone-inspection', '/about', '/service-areas', '/contact', '/404'];
const widths = [375, 390, 768, 1024, 1280, 1440];

test.describe('accessibility (axe, WCAG 2.1 A/AA)', () => {
  // Desktop project only — the mobile project covers layout separately.
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1000, 'run once per page');

  for (const path of pages) {
    test(`${path} has no detectable WCAG A/AA violations`, async ({ page }) => {
      await page.goto(path);
      // Make reveal-on-scroll content visible so its contrast is checked at full opacity.
      await page.evaluate(() => document.querySelectorAll('[data-reveal]').forEach((el) => el.classList.add('is-visible')));
      // Wait for the fade-in (600ms + per-item stagger) to finish, so axe never measures a half-transparent element.
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('[data-reveal]')).every((el) => getComputedStyle(el).opacity === '1'),
      );
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) — ${v.nodes[0]?.target.join(' ')}`);
      expect(summary).toEqual([]);
    });
  }

  test('open mobile menu has no violations', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Open menu' }).click();
    const results = await new AxeBuilder({ page }).include('header').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

test.describe('responsive admin layout', () => {
  // Runs once (desktop project) and opens its own phone-emulating context per width: with
  // isMobile, a page wider than the screen silently widens the layout viewport, so we compare
  // the document width against the configured width, not against window.innerWidth.
  // Scroll containers inside the page (e.g. the admin nav) may scroll; the page itself must not.
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1000, 'widths are set explicitly');
  const adminPages = ['/admin', '/admin/service-areas', '/admin/service-areas/new', '/admin/enquiries', '/admin/enquiries/settings', '/admin/media', '/admin/site-content', '/admin/content', '/admin/content/team/new', '/admin/backups'];

  for (const width of [375, 390]) {
    test(`signed-in admin pages do not overflow horizontally at ${width}px`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL, viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
      try {
        const page = await context.newPage();
        await loginAsAdmin(page);
        for (const path of adminPages) {
          await page.goto(path);
          const size = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, layout: window.innerWidth }));
          expect(size.doc, `${path} document is ${size.doc}px wide at ${width}px`).toBeLessThanOrEqual(width);
          expect(size.layout, `${path} layout viewport widened to ${size.layout}px at ${width}px`).toBe(width);
        }
      } finally {
        await context.close();
      }
    });
  }
});

test.describe('responsive layout', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1000, 'widths are set explicitly');

  for (const width of widths) {
    test(`no horizontal overflow or clipped headings at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const path of pages) {
        await page.goto(path);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${path} overflows by ${overflow}px at ${width}px`).toBeLessThanOrEqual(0);

        const clipped = await page.evaluate(() =>
          Array.from(document.querySelectorAll('h1, h2, h3'))
            .filter((h) => (h as HTMLElement).offsetParent !== null && !h.closest('.sr-only'))
            .filter((h) => h.scrollWidth > h.clientWidth + 1)
            .map((h) => h.textContent?.trim()),
        );
        expect(clipped, `${path} at ${width}px`).toEqual([]);
      }
    });
  }

  test('interactive targets are at least 24×24px (WCAG 2.2) and primary controls 44px tall', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of pages) {
      await page.goto(path);
      const small = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('a, button, input, select, textarea'))
          .filter((el) => el.offsetParent !== null && !el.closest('.sr-only, .skip-link, .enquiry__trap, p, td, li > p'))
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && (r.width < 24 || r.height < 24))
          .map(({ el, r }) => `${el.tagName} "${el.textContent?.trim().slice(0, 30)}" ${Math.round(r.width)}×${Math.round(r.height)}`),
      );
      expect(small, path).toEqual([]);

      const buttons = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('.btn, button:not(.gallery__thumb), input:not([type=hidden]):not([type=checkbox]), select'))
          // Same exclusion as the target-size check above: the off-screen, aria-hidden spam trap
          // is not a control anyone can see or reach.
          .filter((el) => el.offsetParent !== null && !el.closest('.enquiry__trap'))
          .map((el) => ({ el, h: el.getBoundingClientRect().height }))
          .filter(({ h }) => h < 44)
          .map(({ el, h }) => `${el.tagName}.${el.className} ${Math.round(h)}px`),
      );
      expect(buttons, path).toEqual([]);
    }
  });

  test('reduced motion: content is visible without animation', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(`${baseURL}/`);
    const opacity = await page.locator('.service-card').last().evaluate((el) => getComputedStyle(el).opacity);
    expect(opacity).toBe('1');
    await context.close();
  });
});
