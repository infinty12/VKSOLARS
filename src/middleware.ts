/**
 * Request gatekeeper.
 *
 * /admin/** and /api/admin/**:
 *   1. Local-only: requests from non-loopback addresses get 404 unless ADMIN_ALLOW_REMOTE=true.
 *   2. Authentication: a valid server-side session is required (except the login page).
 *   3. CSRF: every non-GET request must carry the session's CSRF token (form field `_csrf`
 *      or header `x-csrf-token`). Astro's checkOrigin additionally rejects cross-site form posts.
 *   4. Responses are never cached and never indexed.
 *
 * Pre-rendered pages are built ahead of time and skip all of this.
 */
import { defineMiddleware } from 'astro:middleware';
import { config, SESSION } from './lib/server/config.ts';
import { readSession } from './lib/server/auth.ts';
import { safeEqual } from './lib/server/secret.ts';
import { ensureOutboxWorker, kickOutbox } from './lib/server/notifications.ts';
import { MEDIA } from './lib/server/media.ts';

/** Largest admin form post other than an image upload. */
const ADMIN_MAX_BODY_BYTES = 256 * 1024;

const isAdminPath = (p: string) => p === '/admin' || p.startsWith('/admin/') || p.startsWith('/api/admin/');
const PUBLIC_ADMIN_PATHS = new Set(['/admin/login', '/admin/login/']);

function isLoopback(addr: string) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });

let outboxStarted = false;

export const onRequest = defineMiddleware(async (context, next) => {
  if (context.isPrerendered) return next();

  // Resume pending email notifications after a restart (no-op when email is disabled).
  if (!outboxStarted) {
    outboxStarted = true;
    try {
      ensureOutboxWorker();
      kickOutbox();
    } catch {
      console.warn('[mail] could not start the notification worker');
    }
  }

  const path = context.url.pathname;
  if (!isAdminPath(path)) return next();

  // 1. Local-only access.
  let client = '';
  try {
    client = context.clientAddress;
  } catch {
    client = '';
  }
  if (!config.adminAllowRemote && !isLoopback(client)) return notFound();

  // 2. Authentication.
  const session = readSession(context.cookies.get(SESSION.cookieName)?.value);
  if (session) context.locals.admin = { user: session.user, csrfToken: session.csrfToken };

  const isApi = path.startsWith('/api/admin/');
  if (!session && !PUBLIC_ADMIN_PATHS.has(path)) {
    if (isApi) return Response.json({ error: 'Authentication required.' }, { status: 401 });
    const nextUrl = encodeURIComponent(path + context.url.search);
    return context.redirect(`/admin/login?next=${nextUrl}`, 303);
  }

  // 3. CSRF for state-changing requests (login has its own double-submit check).
  const method = context.request.method;
  if (session && method !== 'GET' && method !== 'HEAD') {
    // Refuse oversized bodies before reading them (server.mjs enforces the same limits first).
    const lengthHeader = context.request.headers.get('content-length');
    const limit = path === '/admin/media' || path === '/admin/media/' ? MEDIA.maxRequestBytes : ADMIN_MAX_BODY_BYTES;
    const tooBig = lengthHeader !== null && !(Number(lengthHeader) <= limit);
    const unknownLength = lengthHeader === null && context.request.headers.has('transfer-encoding');
    if (tooBig || unknownLength) {
      return new Response(tooBig ? 'Request too large.' : 'Content-Length required.', {
        status: tooBig ? 413 : 411,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    let token = context.request.headers.get('x-csrf-token') ?? '';
    if (!token) {
      const type = context.request.headers.get('content-type') ?? '';
      if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
        const form = await context.request.clone().formData();
        token = String(form.get('_csrf') ?? '');
      }
    }
    if (!token || !safeEqual(token, session.csrfToken)) {
      return isApi
        ? Response.json({ error: 'Invalid or missing security token. Reload the page and try again.' }, { status: 403 })
        : new Response('Invalid or missing security token. Go back, reload the page and try again.', {
            status: 403,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
    }
  }

  // 4. Never cache or index admin responses.
  return withHeaders(await next(), { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
});

/** Set headers, copying the response first if its headers are immutable (e.g. Response.redirect). */
function withHeaders(response: Response, headers: Record<string, string>) {
  try {
    for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    for (const [k, v] of Object.entries(headers)) copy.headers.set(k, v);
    return copy;
  }
}
