import type { APIRoute } from 'astro';
import { readCustomer, checkCsrf, endSession } from '../lib/server/customers.ts';

export const prerender = false;

// Customer sign-out. POST only, with the session's CSRF token: a GET must never sign anyone out.
export const POST: APIRoute = async ({ cookies, request, redirect }) => {
  const session = await readCustomer(cookies);
  const form = await request.formData().catch(() => null);
  if (session && !checkCsrf(session, form?.get('_csrf'))) return new Response('Invalid security token.', { status: 403 });
  await endSession(cookies, session);
  return redirect('/login?signedout=1', 303);
};
