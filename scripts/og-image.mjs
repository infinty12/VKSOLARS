// Renders public/og-image.jpg (1200×630 JPEG) from brand fonts/colours. Run: node scripts/og-image.mjs
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const font = (p) => readFileSync(new URL(`../node_modules/${p}`, import.meta.url)).toString('base64');
const poppins = font('@fontsource/poppins/files/poppins-latin-700-normal.woff2');
const inter = font('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2');

const html = `<!doctype html><html><head><style>
@font-face{font-family:P;src:url(data:font/woff2;base64,${poppins})}
@font-face{font-family:I;src:url(data:font/woff2;base64,${inter});font-weight:100 900}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;background:linear-gradient(135deg,#021024,#052659);color:#fff;font-family:I;position:relative;overflow:hidden}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(193,232,255,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(193,232,255,.07) 1px,transparent 1px);background-size:48px 48px}
.sun{position:absolute;right:120px;top:90px;width:300px;height:300px;border-radius:50%;background:radial-gradient(circle,#fff 0,#fff 18%,rgba(193,232,255,.5) 36%,transparent 70%)}
.wrap{position:absolute;left:80px;top:80px;right:80px;bottom:80px;display:flex;flex-direction:column;justify-content:space-between}
.brand{display:flex;align-items:center;gap:18px}
.brand b{font-family:P;font-size:34px}.brand span{display:block;font-size:16px;letter-spacing:.14em;color:#A2C8E7;text-transform:uppercase;margin-top:4px}
h1{font-family:P;font-size:84px;line-height:1.02;letter-spacing:-.01em}
p{font-size:28px;color:#C1E8FF;margin-top:18px;font-family:P}
.foot{font-size:22px;color:#A2C8E7}
</style></head><body><div class="grid"></div><div class="sun"></div><div class="wrap">
<div class="brand"><svg width="64" height="64" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#021024" stroke="#C1E8FF" stroke-opacity=".4"/><circle cx="27.5" cy="12" r="4" fill="#C1E8FF"/><path d="M8 30 11.5 18h17L32 30z" fill="none" stroke="#C1E8FF" stroke-width="2" stroke-linejoin="round"/><path d="M9.8 24h20.4M17.2 18 16 30M22.8 18 24 30" stroke="#C1E8FF" stroke-width="1.5"/></svg>
<div><b>VK Solar</b><span>High-Tech Power Solution</span></div></div>
<div><h1>CLEAN ENERGY.<br>BETTER FUTURE.</h1><p>More Power. Less Worry.</p></div>
<div class="foot">Solar cleaning · Maintenance · AI drone inspection — Rajasthan</div>
</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({
  path: new URL('../public/og-image.jpg', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  type: 'jpeg',
  quality: 88,
});
await browser.close();
console.log('Wrote public/og-image.jpg');
