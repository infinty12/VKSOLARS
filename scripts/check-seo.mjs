// SEO output check for a built site.
// Usage: node scripts/check-seo.mjs [distDir] [expectedSiteUrl]
//   With a site URL: canonical, og:url, og:image, sitemap and robots Sitemap line must all be present and correct.
//   Without one:     none of those may be emitted (nothing should point at an unknown domain).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const dist = process.argv[2] ?? 'dist';
const siteUrl = process.argv[3] ?? null;
const problems = [];
const fail = (msg) => problems.push(msg);

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return htmlFiles(full);
    return name.endsWith('.html') ? [full] : [];
  });
}

const route = (file) => {
  const rel = relative(dist, file).split(sep).join('/');
  return rel === 'index.html' ? '/' : '/' + rel.replace(/index\.html$/, '').replace(/\.html$/, '');
};
const meta = (html, attr, key) => html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`))?.[1] ?? null;
const count = (html, re) => (html.match(re) ?? []).length;

/** Width/height from a JPEG's SOF marker, or null if the file isn't a JPEG. */
function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

const pages = htmlFiles(dist).map((f) => ({ file: f, path: route(f), html: readFileSync(f, 'utf8') }));
const indexable = pages.filter((p) => !/name="robots" content="noindex"/.test(p.html));
const titles = new Map();

for (const { path, html } of pages) {
  if (count(html, /<title>/g) !== 1) fail(`${path}: expected exactly one <title>`);
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
  if (titles.has(title)) fail(`${path}: duplicate <title> also used by ${titles.get(title)}`);
  titles.set(title, path);
  if (!meta(html, 'name', 'description')) fail(`${path}: missing meta description`);
  if (count(html, /<h1[\s>]/g) !== 1) fail(`${path}: expected exactly one <h1>`);
  for (const k of ['og:title', 'og:description', 'og:type', 'og:site_name']) if (!meta(html, 'property', k)) fail(`${path}: missing ${k}`);

  const canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1] ?? null;
  const ogUrl = meta(html, 'property', 'og:url');
  const ogImage = meta(html, 'property', 'og:image');

  const noindex = /name="robots" content="noindex"/.test(html);
  if (siteUrl && noindex) {
    if (canonical || ogUrl) fail(`${path}: noindex page must not declare canonical/og:url`);
  } else if (siteUrl) {
    const expected = new URL(path.endsWith('/') ? path : `${path}/`, siteUrl).href;
    if (canonical !== expected) fail(`${path}: canonical ${canonical} ≠ ${expected}`);
    if (ogUrl !== canonical) fail(`${path}: og:url ${ogUrl} ≠ canonical`);
    if (!ogImage) fail(`${path}: missing og:image`);
    else {
      const local = join(dist, new URL(ogImage).pathname);
      if (!existsSync(local)) fail(`${path}: og:image ${ogImage} does not exist in build`);
      else {
        const size = jpegSize(readFileSync(local));
        if (!ogImage.endsWith('.jpg')) fail(`${path}: og:image extension is not .jpg`);
        if (!size) fail(`${path}: og:image is not a valid JPEG`);
        else if (size.width !== 1200 || size.height !== 630) fail(`${path}: og:image is ${size.width}×${size.height}, expected 1200×630`);
      }
    }
  } else if (canonical || ogUrl || ogImage) {
    fail(`${path}: canonical/og:url/og:image emitted without a configured domain`);
  }
}

const robots = existsSync(join(dist, 'robots.txt')) ? readFileSync(join(dist, 'robots.txt'), 'utf8') : null;
if (!robots) fail('robots.txt missing');
else if (siteUrl && !robots.includes(`Sitemap: ${new URL('sitemap-index.xml', siteUrl).href}`)) fail('robots.txt missing Sitemap line');
else if (!siteUrl && /Sitemap:/i.test(robots)) fail('robots.txt references a sitemap without a domain');

if (siteUrl) {
  const sitemap = existsSync(join(dist, 'sitemap-0.xml')) ? readFileSync(join(dist, 'sitemap-0.xml'), 'utf8') : '';
  if (!existsSync(join(dist, 'sitemap-index.xml'))) fail('sitemap-index.xml missing');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const p of indexable) {
    const url = new URL(p.path.endsWith('/') ? p.path : `${p.path}/`, siteUrl).href;
    if (!locs.includes(url)) fail(`sitemap missing ${url}`);
  }
  if (locs.some((l) => l.includes('404'))) fail('sitemap includes the 404 page');
  console.log(`sitemap URLs (${locs.length}):\n  ${locs.join('\n  ')}`);
} else if (existsSync(join(dist, 'sitemap-index.xml'))) {
  fail('sitemap generated without a domain');
}

console.log(`Checked ${pages.length} pages in ${dist} (${siteUrl ? `site ${siteUrl}` : 'no domain configured'}).`);
if (problems.length) {
  console.log(problems.join('\n'));
  process.exit(1);
}
console.log('SEO output OK.');
