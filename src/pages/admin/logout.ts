import type { APIRoute } from 'astro';
import { SESSION } from '../../lib/server/config.ts';
import { deleteSession } from '../../lib/server/auth.ts';
import { adminAuthMode, deleteFirebaseAdminSession } from '../../lib/server/admin-firebase.ts';
import { audit } from '../../lib/server/audit.ts';

// POST only (CSRF-checked by middleware). A GET must never sign the user out.
export const POST: APIRoute = async ({ cookies, locals, redirect }) => {
  const token = cookies.get(SESSION.cookieName)?.value;
  if (adminAuthMode() === 'local') deleteSession(token);
  else await deleteFirebaseAdminSession(token);
  cookies.delete(SESSION.cookieName, { path: '/' });
  if (locals.admin) audit('logout', { userId: locals.admin.user.id });
  return redirect('/admin/login', 303);
};
