import type { APIRoute } from 'astro';
import { SESSION } from '../../lib/server/config.ts';
import { deleteSession } from '../../lib/server/auth.ts';
import { audit } from '../../lib/server/audit.ts';

// POST only (CSRF-checked by middleware). A GET must never sign the user out.
export const POST: APIRoute = ({ cookies, locals, redirect }) => {
  deleteSession(cookies.get(SESSION.cookieName)?.value);
  cookies.delete(SESSION.cookieName, { path: '/' });
  if (locals.admin) audit('logout', { userId: locals.admin.user.id });
  return redirect('/admin/login', 303);
};
