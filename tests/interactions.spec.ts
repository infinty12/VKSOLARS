import { test, expect } from '@playwright/test';

test.describe('thermal gallery lightbox', () => {
  test('opens, navigates with buttons and arrow keys, closes with Escape and restores focus', async ({ page }) => {
    await page.goto('/ai-drone-inspection');
    const thumb = page.getByRole('button', { name: /Bypass diode \/ substring/ });
    await thumb.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-counter]')).toHaveText('2 / 6');
    await expect(dialog).toHaveAccessibleName('Bypass diode / substring');
    await expect(dialog.locator('svg.thermal rect').first()).toBeVisible();

    // Cloning the image into the dialog must not duplicate any ids.
    const dupes = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
      return ids.filter((id, i) => ids.indexOf(id) !== i);
    });
    expect(dupes).toEqual([]);

    await dialog.getByRole('button', { name: 'Next image' }).click();
    await expect(dialog.locator('[data-counter]')).toHaveText('3 / 6');
    await page.keyboard.press('ArrowLeft');
    await expect(dialog.locator('[data-counter]')).toHaveText('2 / 6');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(thumb).toBeFocused();
  });

  test('is fully keyboard operable: opens with Enter, keeps Tab inside, closes with the Close button', async ({ page }) => {
    await page.goto('/ai-drone-inspection');
    const thumb = page.getByRole('button', { name: /Cracked cells/ });
    await thumb.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Focus starts inside the dialog, and tabbing never reaches page content behind it.
    // (A native modal <dialog> lets Tab pass once to the browser's own UI — reported as <body> — then
    // wraps back to the first control. That is specified behaviour, so <body> is allowed; any other
    // element outside the dialog is a failure.)
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    const visited = new Set<string>();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      const state = await dialog.evaluate((d) => {
        const a = document.activeElement;
        return {
          inside: d.contains(a),
          isBody: a === document.body,
          label: a?.getAttribute('aria-label') ?? `<${a?.tagName.toLowerCase()} class="${a?.className}">`,
        };
      });
      expect(state.inside || state.isBody, `focus escaped to page content on Tab ${i + 1}`).toBe(true);
      if (state.inside) visited.add(state.label);
    }
    // On small screens the dialog's content overflows, so Chrome also makes the <dialog> itself a focus stop
    // (keyboard scrolling of a scroll container). That is correct, and it is still inside the dialog.
    visited.delete('<dialog class="lightbox">');
    expect([...visited].sort()).toEqual(['Close', 'Next image', 'Previous image']);
    await dialog.getByRole('button', { name: 'Close' }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(thumb).toBeFocused();
  });

  test('gallery and lightbox are labelled as illustrative', async ({ page }) => {
    await page.goto('/ai-drone-inspection');
    await expect(page.locator('.gallery__note')).toContainText('not images from a real inspection');
    await page.getByRole('button', { name: /Single-cell hotspot/ }).click();
    await expect(page.getByRole('dialog').locator('.illustrative-tag')).toHaveText('Illustrative example');
  });
});

test.describe('inspection dashboard', () => {
  test('is labelled as illustrative sample data', async ({ page }) => {
    await page.goto('/ai-drone-inspection');
    await expect(page.locator('[data-dashboard]')).toContainText('Illustrative sample data — not live telemetry');
  });

  test('tabs switch panels by click and keyboard', async ({ page }) => {
    await page.goto('/ai-drone-inspection');
    const tabA = page.getByRole('tab', { name: 'Block A' });
    const tabB = page.getByRole('tab', { name: 'Block B' });
    const tabC = page.getByRole('tab', { name: 'Block C' });
    await expect(tabA).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#panel-block-a')).toBeVisible();

    await tabB.click();
    await expect(tabB).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#panel-block-b')).toBeVisible();
    await expect(page.locator('#panel-block-a')).toBeHidden();

    await tabB.focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabC).toBeFocused();
    await expect(page.locator('#panel-block-c')).toBeVisible();
    await page.keyboard.press('Home');
    await expect(tabA).toBeFocused();
    await expect(tabA).toHaveAttribute('tabindex', '0');
    await expect(tabC).toHaveAttribute('tabindex', '-1');
  });
});

test.describe('content integrity', () => {
  test('sections without verified data stay hidden', async ({ page }) => {
    await page.goto('/');
    // No stats or testimonials are configured, so neither section may render.
    await expect(page.locator('#stats-title')).toHaveCount(0);
    await expect(page.locator('#testimonials-title')).toHaveCount(0);
  });

  test('no call or WhatsApp buttons render without a configured number', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
    await expect(page.locator('a[href*="wa.me"]')).toHaveCount(0);
  });

  test('home hero has both primary CTAs pointing to contact', async ({ page }) => {
    await page.goto('/');
    const hero = page.locator('.hero');
    await expect(hero.getByRole('link', { name: 'Get Free Inspection' })).toHaveAttribute('href', '/contact#enquiry');
    await expect(hero.getByRole('link', { name: 'Contact Us' })).toHaveAttribute('href', '/contact');
  });

  test('every service card links to its section', async ({ page }) => {
    await page.goto('/');
    const cards = page.locator('.service-card__link');
    await expect(cards).toHaveCount(8);
    for (const href of await cards.evaluateAll((els) => els.map((e) => e.getAttribute('href')))) {
      expect(href).toMatch(/^\/(services#[a-z-]+|ai-drone-inspection)$/);
    }
  });
});
