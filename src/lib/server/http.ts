import type { AstroCookies } from 'astro';
import { config } from './config.ts';

/** Cookies are Secure on HTTPS, or always when COOKIE_SECURE=true (e.g. behind a TLS proxy). */
export const isSecureRequest = (url: URL) => url.protocol === 'https:' || config.cookieSecure;

export function setStrictCookie(cookies: AstroCookies, url: URL, name: string, value: string, opts: { maxAgeSec?: number; path?: string } = {}) {
  cookies.set(name, value, {
    httpOnly: true,
    sameSite: 'strict',
    secure: isSecureRequest(url),
    path: opts.path ?? '/',
    ...(opts.maxAgeSec ? { maxAge: opts.maxAgeSec } : {}),
  });
}

/** Only allow redirects back into the admin area (blocks open redirects like //evil.example). */
export function safeAdminRedirect(next: string | null | undefined): string {
  if (!next || !next.startsWith('/admin') || next.startsWith('//') || next.includes('\\')) return '/admin';
  return next;
}

export function clientIp(getter: () => string): string {
  try {
    return getter();
  } catch {
    return 'unknown';
  }
}

/** Whitelisted flash messages, selected by ?msg=key so no user-controlled text is ever reflected. */
export const FLASH = {
  saved: { kind: 'success', text: 'Changes saved.' },
  created: { kind: 'success', text: 'Location added.' },
  deleted: { kind: 'success', text: 'Deleted.' },
  published: { kind: 'success', text: 'Location published — it is now visible on the public Service Areas page.' },
  unpublished: { kind: 'success', text: 'Location unpublished — it is no longer visible to visitors.' },
  status: { kind: 'success', text: 'Status updated.' },
  note: { kind: 'success', text: 'Note added.' },
  purged: { kind: 'success', text: 'Retention clean-up finished.' },
  backup: { kind: 'success', text: 'Backup created and verified.' },
  uploaded: { kind: 'success', text: 'Image uploaded. Check the alt text describes it before using it on the site.' },
  inuse: { kind: 'error', text: 'This image is in use, so it cannot be deleted. Remove it from those places first.' },
  contentDraft: { kind: 'success', text: 'Draft saved. It is not public yet — preview it, then publish when ready.' },
  contentPublished: { kind: 'success', text: 'Published. The website now shows these details.' },
  contentDiscarded: { kind: 'success', text: 'Draft discarded. The website is unchanged.' },
  contentRestored: { kind: 'success', text: 'Revision restored as a new draft. Publish it to make it live.' },
  noDraft: { kind: 'info', text: 'There is no draft at the moment.' },
  itemSaved: { kind: 'success', text: 'Draft saved. It is not on the website until you publish it.' },
  itemPublished: { kind: 'success', text: 'Published. It now appears on the website.' },
  itemUnpublished: { kind: 'success', text: 'Unpublished. It no longer appears on the website.' },
  itemDiscarded: { kind: 'success', text: 'Unpublished edits discarded. The draft matches the published version again.' },
  itemIsPublished: { kind: 'error', text: 'Unpublish this item before deleting it.' },
  itemMoved: { kind: 'success', text: 'Order updated. The website uses the new order.' },
  passwordChanged: { kind: 'success', text: 'Password changed. You are still signed in here; all other sessions were signed out.' },
  sessionsRevoked: { kind: 'success', text: 'All your other sessions were signed out.' },
  notfound: { kind: 'error', text: 'That item no longer exists.' },
} as const satisfies Record<string, { kind: 'success' | 'error' | 'info'; text: string }>;

export function flashFrom(url: URL) {
  const key = url.searchParams.get('msg') as keyof typeof FLASH | null;
  return key && key in FLASH ? FLASH[key] : null;
}
