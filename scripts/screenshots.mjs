// Full-page screenshots of built pages at several widths, for visual review.
// Usage: node scripts/screenshots.mjs <outDir> [route ...]   (needs `astro preview` on :4321)
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [outDir = 'screenshots', ...routeArgs] = process.argv.slice(2);
const routes = routeArgs.length ? routeArgs : ['/'];
const widths = (process.env.WIDTHS ?? '390,1440').split(',').map(Number);

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
for (const width of widths) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  for (const route of routes) {
    await page.goto(`http://localhost:4321${route}`, { waitUntil: 'networkidle' });
    // Reveal everything so off-screen sections aren't captured mid-animation.
    await page.evaluate(() => document.querySelectorAll('[data-reveal]').forEach((el) => el.classList.add('is-visible')));
    await page.waitForTimeout(700);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const name = `${route === '/' ? 'home' : route.replace(/\//g, '')}-${width}.png`;
    await page.screenshot({ path: join(outDir, name), fullPage: true });
    console.log(`${name}  horizontal overflow: ${overflow}px`);
  }
  await page.close();
}
await browser.close();
