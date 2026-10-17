// Design-token integrity check for src/styles/tokens.css.
//   1. No custom property is defined twice within the same selector block.
//   2. Every var(--x) used anywhere in src/ has a definition (tokens.css or a local declaration).
//   3. Reports tokens that are defined but never used (so legacy aliases can be pruned).
//   4. Every token resolves to valid CSS in a real browser (Chromium + CSS.supports per value type).
//   5. The five approved brand colours are exact.
// Run: npm run tokens
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const tokensPath = join(root, 'src/styles/tokens.css');
const css = readFileSync(tokensPath, 'utf8');
const problems = [];

const APPROVED = {
  '--brand-midnight': '#021024',
  '--brand-solar': '#052659',
  '--brand-steel': '#5483b3',
  '--brand-soft': '#7da0ca',
  '--brand-ice': '#c1e8ff',
};

// ---- 1. Duplicates per block -------------------------------------------------
const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
const blocks = [];
const blockRe = /(@media[^{]+)?\{?\s*(:root)\s*\{([^}]*)\}/g;
for (const m of noComments.matchAll(blockRe)) blocks.push({ selector: (m[1] ? `${m[1].trim()} ` : '') + m[2], body: m[3] });
const defined = new Map(); // name -> value (from the base :root)
for (const { selector, body } of blocks) {
  const seen = new Set();
  for (const d of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = d;
    if (seen.has(name)) problems.push(`duplicate ${name} in "${selector}"`);
    seen.add(name);
    if (selector === ':root') defined.set(name, value.trim());
  }
}
const baseCount = defined.size;

// ---- 5. Approved palette ------------------------------------------------------
for (const [name, hex] of Object.entries(APPROVED)) {
  const v = defined.get(name)?.toLowerCase();
  if (v !== hex) problems.push(`${name} is "${v}", expected exactly ${hex}`);
}

// ---- 2/3. Undefined references and unused tokens ------------------------------
function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const f = join(dir, n);
    return statSync(f).isDirectory() ? files(f) : /\.(astro|css|ts|mjs)$/.test(n) ? [f] : [];
  });
}
const sources = files(join(root, 'src')).map((f) => ({ f, text: readFileSync(f, 'utf8') }));
const localDefs = new Set();
for (const { text } of sources) for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) localDefs.add(m[1]);
const used = new Map(); // name -> count across src (including references inside tokens.css)
const withFallback = new Set(); // var(--x, fallback) is a deliberate optional hook
for (const { text } of sources)
  for (const m of text.matchAll(/var\((--[\w-]+)\s*(,)?/g)) {
    used.set(m[1], (used.get(m[1]) ?? 0) + 1);
    if (m[2]) withFallback.add(m[1]);
  }

for (const name of used.keys()) {
  if (!defined.has(name) && !localDefs.has(name) && !withFallback.has(name)) problems.push(`var(${name}) is used but never defined`);
}
const unused = [...defined.keys()].filter((n) => !used.has(n));

// ---- 4. Browser validity -------------------------------------------------------
const kindOf = (name) => {
  if (/^--(gradient)/.test(name)) return ['background-image'];
  if (/^--shadow-(xs|sm|md|lg|header)$/.test(name)) return ['box-shadow'];
  if (/^--(border-thin|border-accent|glass-border)$/.test(name)) return ['border'];
  if (/^--glass-blur$/.test(name)) return ['backdrop-filter'];
  if (/^--font-/.test(name)) return ['font-family'];
  if (/^--(fs|space|section|gutter|page-inline|header-height|container|radius|target|measure)/.test(name)) return ['width', 'font-size'];
  if (/^--(lh|fw|grid-columns|z-)/.test(name)) return ['line-height', 'font-weight', 'z-index', 'order'];
  if (/^--tracking/.test(name)) return ['letter-spacing'];
  if (/^--dur/.test(name)) return ['transition-duration'];
  if (/^--ease/.test(name)) return ['transition-timing-function'];
  return ['color']; // everything else is a colour token
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<!doctype html><style>${css}</style><body></body>`);
const results = await page.evaluate(
  ([names, kinds]) => {
    const cs = getComputedStyle(document.documentElement);
    return names.map((n, i) => {
      const resolved = cs.getPropertyValue(n).trim();
      const ok = resolved !== '' && kinds[i].some((prop) => CSS.supports(prop, resolved));
      return { n, resolved, ok };
    });
  },
  [[...defined.keys()], [...defined.keys()].map(kindOf)],
);
// Resolved values for the brand colours, so "exact" is confirmed after parsing too.
const brandResolved = await page.evaluate((names) => {
  const probe = document.createElement('div');
  document.body.append(probe);
  return Object.fromEntries(
    names.map((n) => {
      probe.style.color = `var(${n})`;
      return [n, getComputedStyle(probe).color];
    }),
  );
}, Object.keys(APPROVED));
await browser.close();

for (const r of results) if (!r.ok) problems.push(`${r.n} does not resolve to valid CSS: "${r.resolved}"`);
const hexToRgb = (h) => `rgb(${[1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ')})`;
for (const [n, hex] of Object.entries(APPROVED)) {
  if (brandResolved[n] !== hexToRgb(hex)) problems.push(`${n} renders as ${brandResolved[n]}, expected ${hexToRgb(hex)}`);
}

// ---- Report --------------------------------------------------------------------
console.log(`Blocks: ${blocks.map((b) => b.selector).join(' | ')}`);
console.log(`Tokens defined in :root: ${baseCount} · var() names referenced in src: ${used.size}`);
console.log(`Browser-validated: ${results.filter((r) => r.ok).length}/${results.length}`);
console.log(`Brand colours as rendered: ${Object.entries(brandResolved).map(([n, v]) => `${n}=${v}`).join(', ')}`);
if (unused.length) console.log(`Defined but unused (${unused.length}): ${unused.join(', ')}`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nTokens OK.');
