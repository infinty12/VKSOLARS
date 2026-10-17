// Admin security smoke test against the BUILT server, using disposable storage only.
//   npm run build && npm run smoke:admin
//
// Starts two isolated servers (each with its own freshly-wiped *-test-storage folder):
//   A: default settings (local-only, forwarding headers ignored)
//   B: TRUST_PROXY=true, to exercise the non-loopback rejection path via a forwarded client IP
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';

const results = [];
const check = (name, ok, detail = '') => results.push({ ok, line: `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}` });
const skip = (name, why) => results.push({ ok: true, skipped: true, line: `SKIP  ${name}  (${why})` });

function startServer(port, storage, extraEnv = {}) {
  const child = spawn(process.execPath, ['scripts/test-server.mjs'], {
    env: { ...process.env, PORT: String(port), STORAGE_DIR: storage, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const ready = new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`server on ${port} did not start: ${stderr}`)), 30000);
    child.stdout.on('data', (d) => d.toString().includes('listening') && (clearTimeout(t), ok()));
    child.on('exit', (c) => fail(new Error(`server on ${port} exited (${c}): ${stderr}`)));
  });
  return { child, ready };
}

const formBody = (o) => new URLSearchParams(o).toString();
const cookieOf = (res, name) => {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return raw ? { raw, value: raw.split(';')[0].slice(name.length + 1) } : null;
};
const tokenIn = (html) => html.match(/name="_csrf" value="([^"]+)"/)?.[1];

async function login(base, username, password, next = '') {
  const page = await fetch(`${base}/admin/login`, { redirect: 'manual' });
  const csrfCookie = cookieOf(page, 'vk_login_csrf');
  const token = tokenIn(await page.text());
  return fetch(`${base}/admin/login${next}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base, Cookie: `vk_login_csrf=${csrfCookie?.value}` },
    body: formBody({ username, password, _csrf: token }),
  });
}

const A = { port: 4398, storage: resolve('.smoke-a-test-storage') };
const B = { port: 4396, storage: resolve('.smoke-b-test-storage') };
const servers = [];
let exit = 0;

try {
  const a = startServer(A.port, A.storage);
  const b = startServer(B.port, B.storage, { TRUST_PROXY: 'true' });
  servers.push(a.child, b.child);
  await Promise.all([a.ready, b.ready]);
  const base = `http://127.0.0.1:${A.port}`;
  const baseB = `http://127.0.0.1:${B.port}`;
  const creds = JSON.parse(readFileSync(join(A.storage, 'test-admin.json'), 'utf8'));
  const credsB = JSON.parse(readFileSync(join(B.storage, 'test-admin.json'), 'utf8'));
  const get = (p, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts });

  // ---- Local-only binding
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (lan) {
    const refused = await new Promise((r) => {
      const s = net.connect({ host: lan, port: A.port, timeout: 2000 }, () => (s.destroy(), r(false)));
      s.on('error', () => r(true));
      s.on('timeout', () => (s.destroy(), r(true)));
    });
    check('server is not reachable on the LAN address (bound to 127.0.0.1 only)', refused, lan);
  } else {
    skip('server is not reachable on the LAN address', 'no non-internal IPv4 interface on this machine');
  }

  // ---- Public pages + headers
  for (const p of ['/', '/services/', '/ai-drone-inspection/', '/about/', '/contact/', '/service-areas/', '/robots.txt']) {
    const r = await get(p);
    check(`GET ${p} → 200`, r.status === 200, String(r.status));
  }
  const home = await get('/');
  for (const h of ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy']) {
    check(`security header ${h} present`, !!home.headers.get(h));
  }

  // ---- Unauthenticated access
  for (const p of ['/admin', '/admin/']) {
    const r = await get(p);
    check(`GET ${p} unauthenticated → 303 to /admin/login`, r.status === 303 && r.headers.get('location')?.startsWith('/admin/login'), `${r.status} ${r.headers.get('location')}`);
  }
  const postUnauth = await get('/admin/logout', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base }, body: '' });
  check('POST /admin/logout unauthenticated → redirect to login (no action)', postUnauth.status === 303 && postUnauth.headers.get('location')?.startsWith('/admin/login'), String(postUnauth.status));
  // Admin URLs that don't exist (yet) fall through to the static 404 before middleware runs.
  // Expected: plain 404, no admin content, no data. (This is what failed in the earlier ad-hoc run.)
  for (const p of ['/admin/does-not-exist', '/api/admin/anything']) {
    const r = await get(p);
    const body = await r.text();
    check(`GET ${p} (no such route) → 404 with no admin content`, r.status === 404 && !/csrf|Dashboard|Log out/i.test(body), String(r.status));
  }

  // ---- Login + CSRF
  const loginPage = await get('/admin/login');
  const loginCookie = cookieOf(loginPage, 'vk_login_csrf');
  check('login CSRF cookie is HttpOnly + SameSite=Strict', !!loginCookie && /HttpOnly/i.test(loginCookie.raw) && /SameSite=Strict/i.test(loginCookie.raw));
  check('login page: Cache-Control no-store, X-Robots-Tag noindex', loginPage.headers.get('cache-control') === 'no-store' && /noindex/.test(loginPage.headers.get('x-robots-tag') ?? ''));
  const loginToken = tokenIn(await loginPage.text());
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base };

  const noToken = await get('/admin/login', { method: 'POST', headers: FORM, body: formBody({ username: creds.username, password: creds.password }) });
  check('login without CSRF token → rejected, no session', noToken.status === 401 && !cookieOf(noToken, 'vk_admin_session'), String(noToken.status));

  const crossSite = await get('/admin/login', {
    method: 'POST',
    headers: { ...FORM, Origin: 'https://evil.example', Cookie: `vk_login_csrf=${loginCookie.value}` },
    body: formBody({ username: creds.username, password: creds.password, _csrf: loginToken }),
  });
  check('cross-origin login POST → 403 (Astro checkOrigin)', crossSite.status === 403, String(crossSite.status));

  const wrong = await get('/admin/login', {
    method: 'POST',
    headers: { ...FORM, Cookie: `vk_login_csrf=${loginCookie.value}` },
    body: formBody({ username: creds.username, password: 'definitely-wrong-pass', _csrf: loginToken }),
  });
  const wrongBody = await wrong.text();
  check('wrong password → 401 with generic message', wrong.status === 401 && wrongBody.includes('Incorrect username or password'), String(wrong.status));
  const unknownUser = await login(base, 'no-such-user', 'whatever-password-1');
  check('unknown username → same generic 401', unknownUser.status === 401 && (await unknownUser.text()).includes('Incorrect username or password'), String(unknownUser.status));

  const ok = await login(base, creds.username, creds.password, '?next=/admin');
  const session = cookieOf(ok, 'vk_admin_session');
  check('correct login → 303 to /admin', ok.status === 303 && ok.headers.get('location') === '/admin', `${ok.status} ${ok.headers.get('location')}`);
  check('session cookie HttpOnly + SameSite=Strict + Path=/', !!session && /HttpOnly/i.test(session.raw) && /SameSite=Strict/i.test(session.raw) && /Path=\//.test(session.raw));
  check('session cookie not Secure on plain-HTTP localhost (Secure is set on HTTPS or COOKIE_SECURE=true)', !/;\s*Secure/i.test(session?.raw ?? ''));

  const evil = await login(base, creds.username, creds.password, '?next=//evil.example');
  check('open redirect ?next=//evil.example → /admin', evil.headers.get('location') === '/admin', evil.headers.get('location'));

  const authed = await get('/admin', { headers: { Cookie: `vk_admin_session=${session.value}` } });
  const dash = await authed.text();
  check('authenticated GET /admin → 200, no-store', authed.status === 200 && authed.headers.get('cache-control') === 'no-store', String(authed.status));
  const csrf = tokenIn(dash);

  const badCsrf = await get('/admin/logout', { method: 'POST', headers: { ...FORM, Cookie: `vk_admin_session=${session.value}` }, body: formBody({ _csrf: 'forged' }) });
  check('POST with forged CSRF token → 403', badCsrf.status === 403, String(badCsrf.status));
  const noCsrf = await get('/admin/logout', { method: 'POST', headers: { ...FORM, Cookie: `vk_admin_session=${session.value}` }, body: '' });
  check('POST without CSRF token → 403', noCsrf.status === 403, String(noCsrf.status));
  const headerCsrf = await get('/admin/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, 'x-csrf-token': 'forged', Cookie: `vk_admin_session=${session.value}` },
    body: '{}',
  });
  check('POST with forged x-csrf-token header → 403', headerCsrf.status === 403, String(headerCsrf.status));

  const out = await get('/admin/logout', { method: 'POST', headers: { ...FORM, Cookie: `vk_admin_session=${session.value}` }, body: formBody({ _csrf: csrf }) });
  check('logout with valid CSRF → 303', out.status === 303, String(out.status));
  const reuse = await get('/admin', { headers: { Cookie: `vk_admin_session=${session.value}` } });
  check('session rejected after logout', reuse.status === 303, String(reuse.status));

  // ---- Session expiry (age the session in the disposable DB instead of waiting)
  const db = new DatabaseSync(join(A.storage, 'vk-solar.db'));
  const s2 = cookieOf(await login(base, creds.username, creds.password), 'vk_admin_session');
  db.prepare('UPDATE admin_sessions SET last_seen_at = ?').run(Date.now() - 3 * 60 * 60 * 1000);
  const idle = await get('/admin', { headers: { Cookie: `vk_admin_session=${s2.value}` } });
  check('session idle > 2 h → rejected', idle.status === 303, String(idle.status));
  const s3 = cookieOf(await login(base, creds.username, creds.password), 'vk_admin_session');
  db.prepare('UPDATE admin_sessions SET absolute_expires_at = ?').run(Date.now() - 1000);
  const absolute = await get('/admin', { headers: { Cookie: `vk_admin_session=${s3.value}` } });
  check('session past 12 h absolute limit → rejected', absolute.status === 303, String(absolute.status));
  const stored = db.prepare('SELECT id FROM admin_sessions').all();
  check('session ids stored hashed (cookie value not in DB)', stored.every((r) => r.id !== s3.value && /^[0-9a-f]{64}$/.test(r.id)));
  const hash = db.prepare('SELECT password_hash FROM admin_users').get().password_hash;
  check('password stored as scrypt hash, not plaintext', hash.startsWith('scrypt$') && !hash.includes(creds.password));
  db.close();

  // ---- Forwarding-header spoofing
  const spoofA = await get('/admin', { headers: { 'X-Forwarded-For': '203.0.113.9', Forwarded: 'for=203.0.113.9' } });
  check('default: spoofed X-Forwarded-For/Forwarded ignored (treated as local → login redirect, not trusted)', spoofA.status === 303, String(spoofA.status));
  const remoteB = await fetch(`${baseB}/admin`, { redirect: 'manual', headers: { 'X-Forwarded-For': '203.0.113.9' } });
  check('TRUST_PROXY=true + non-loopback client IP → /admin 404 (local-only enforced)', remoteB.status === 404, String(remoteB.status));
  const remoteLogin = await fetch(`${baseB}/admin/login`, { redirect: 'manual', headers: { 'X-Forwarded-For': '203.0.113.9' } });
  check('TRUST_PROXY=true + non-loopback client IP → /admin/login 404', remoteLogin.status === 404, String(remoteLogin.status));
  const localB = await login(baseB, credsB.username, credsB.password);
  check('TRUST_PROXY=true + loopback client → login still works', localB.status === 303, String(localB.status));

  // ---- Login rate limiting (run last: it locks the test account)
  let last;
  for (let i = 0; i < 6; i++) last = await login(base, creds.username, 'wrong-wrong-wrong');
  check('repeated failures → 429 lockout', last.status === 429, String(last.status));
  const lockedOut = await login(base, creds.username, creds.password);
  check('correct password refused while locked', lockedOut.status === 429, String(lockedOut.status));
} catch (err) {
  check('smoke test ran to completion', false, err.message);
} finally {
  // Wait for the servers to exit: on Windows their open database files block deletion until then.
  const exits = servers.map((c) => (c.exitCode !== null ? Promise.resolve() : new Promise((r) => c.once('exit', r))));
  for (const c of servers) c.kill();
  await Promise.all(exits);
  for (const s of [A.storage, B.storage]) rmSync(s, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

for (const r of results) console.log(r.line);
const failed = results.filter((r) => !r.ok).length;
const skipped = results.filter((r) => r.skipped).length;
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
exit = failed ? 1 : 0;
process.exit(exit);
