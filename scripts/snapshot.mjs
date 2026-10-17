// Crawl the built site through the real server and save every public page to .snapshot/,
// so the link, HTML and SEO checks also cover server-rendered pages (/contact, /service-areas).
//   npm run snapshot     (needs `npm run build` first; uses an isolated temporary storage dir)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PORT = 4399;
const base = `http://127.0.0.1:${PORT}`;
const out = resolve('.snapshot');

const server = spawn(process.execPath, ['scripts/test-server.mjs'], {
  env: { ...process.env, PORT: String(PORT), STORAGE_DIR: resolve('.snapshot-test-storage') },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let exitCode = 0;
try {
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('Server did not start within 30s')), 30000);
    server.stdout.on('data', (d) => d.toString().includes('listening') && (clearTimeout(timer), ok()));
    server.on('exit', (code) => fail(new Error(`Server exited (${code})`)));
  });

  rmSync(out, { recursive: true, force: true });
  const queue = ['/', '/robots.txt', '/this-page-does-not-exist'];
  const seen = new Set();
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const res = await fetch(base + path, { redirect: 'manual' });
    const body = await res.text();
    const file =
      path === '/this-page-does-not-exist'
        ? '404.html'
        : path.endsWith('.txt') || path.endsWith('.xml')
          ? path.slice(1)
          : join(path.replace(/^\//, ''), 'index.html');
    mkdirSync(join(out, file, '..'), { recursive: true });
    writeFileSync(join(out, file), body);
    if (!(res.headers.get('content-type') ?? '').includes('text/html')) continue;
    for (const m of body.matchAll(/<a\b[^>]*\shref="([^"#?]*)/g)) {
      const href = m[1];
      if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/admin')) continue;
      const normal = href.endsWith('/') ? href : `${href}/`;
      if (!seen.has(normal) && !/\.\w+$/.test(href)) queue.push(normal);
    }
  }
  console.log(`Snapshot: ${seen.size} URLs saved to ${out}`);
} catch (err) {
  console.error(err.message);
  exitCode = 1;
} finally {
  // Wait for the server to exit: on Windows its open database file blocks deletion until then.
  const exited = server.exitCode !== null ? Promise.resolve() : new Promise((r) => server.once('exit', r));
  server.kill();
  await exited;
  rmSync(resolve('.snapshot-test-storage'), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  process.exit(exitCode);
}
