// Static link check over the built site (run after `npm run build`).
// Fails on: href="#" / empty hrefs, internal links to pages that don't exist,
// and in-page anchors (#id) that don't exist on the target page.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return htmlFiles(full);
    return name.endsWith('.html') ? [full] : [];
  });
}

function routeOf(file) {
  const rel = relative(dist, file).split(sep).join('/');
  if (rel === 'index.html') return '/';
  if (rel === '404.html') return '/404';
  return '/' + rel.replace(/\/index\.html$/, '').replace(/\.html$/, '');
}

const pages = new Map();
for (const file of htmlFiles(dist)) {
  const html = readFileSync(file, 'utf8');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const hrefs = [...html.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map((m) => m[1]);
  pages.set(routeOf(file), { ids, hrefs });
}

const problems = [];
let checked = 0;
for (const [route, { hrefs }] of pages) {
  for (const raw of hrefs) {
    checked++;
    const href = raw.replace(/&amp;/g, '&');
    if (href === '' || href === '#') {
      problems.push(`${route}: placeholder link href="${raw}"`);
      continue;
    }
    if (/^(https?:|mailto:|tel:)/.test(href)) continue;
    const [pathAndQuery, hash] = href.split('#');
    const path = pathAndQuery.split('?')[0] || route;
    const normalised = path.length > 1 ? path.replace(/\/$/, '') : path;
    const target = pages.get(normalised);
    if (!target) {
      const asset = join(dist, normalised);
      if (!existsSync(asset)) problems.push(`${route}: broken link ${href}`);
      continue;
    }
    if (hash && !target.ids.has(hash)) problems.push(`${route}: missing anchor ${href}`);
  }
}

console.log(`Checked ${checked} links across ${pages.size} pages.`);
if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`\n${problems.length} problem(s).`);
  process.exit(1);
}
console.log('No broken links, missing anchors or placeholder hrefs.');
