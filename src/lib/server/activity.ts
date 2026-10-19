/**
 * Read-only view of the audit log (Admin → Activity): readable labels, filter categories,
 * date range, paging, and links to items that still exist.
 *
 * The audit log only ever stores ids, counts and field names (see audit.ts). As a second line of
 * defence, details shown here are limited to simple values, and any key that looks sensitive is
 * never displayed.
 */
import { getDb } from './db.ts';

export const ACTIVITY_PAGE_SIZE = 50;

export const CATEGORIES = {
  signin: { label: 'Sign-in', match: (a: string) => a.startsWith('login.') || a === 'logout' },
  areas: { label: 'Service areas', match: (a: string) => a.startsWith('location.') },
  enquiries: { label: 'Enquiries', match: (a: string) => a.startsWith('enquiry.') || a.startsWith('settings.enquiries') },
  requests: { label: 'Customer requests', match: (a: string) => a.startsWith('request.') },
  media: { label: 'Media', match: (a: string) => a.startsWith('media.') },
  content: { label: 'Content', match: (a: string) => a.startsWith('content.') },
  backups: { label: 'Backups', match: (a: string) => a.startsWith('backup.') },
  account: { label: 'Account', match: (a: string) => a.startsWith('account.') || a.startsWith('admin.') },
} as const;
export type Category = keyof typeof CATEGORIES;
export const isCategory = (c: unknown): c is Category => typeof c === 'string' && c in CATEGORIES;

/** SQL condition for a category (kept in step with CATEGORIES.match above; tested). */
const CATEGORY_SQL: Record<Category, string> = {
  signin: "(action LIKE 'login.%' OR action = 'logout')",
  areas: "action LIKE 'location.%'",
  enquiries: "(action LIKE 'enquiry.%' OR action LIKE 'settings.enquiries%')",
  requests: "action LIKE 'request.%'",
  media: "action LIKE 'media.%'",
  content: "action LIKE 'content.%'",
  backups: "action LIKE 'backup.%'",
  account: "(action LIKE 'account.%' OR action LIKE 'admin.%')",
};

export const ACTION_LABELS: Record<string, string> = {
  'login.success': 'Signed in',
  'login.failure': 'Failed sign-in attempt',
  'login.blocked': 'Sign-in blocked (too many attempts)',
  logout: 'Signed out',
  'location.create': 'Service area added',
  'location.update': 'Service area updated',
  'location.delete': 'Service area deleted',
  'location.publish': 'Service area published',
  'location.unpublish': 'Service area unpublished',
  'enquiry.received': 'Enquiry received',
  'enquiry.status': 'Enquiry status changed',
  'enquiry.note': 'Enquiry note added',
  'enquiry.delete': 'Enquiry deleted',
  'enquiry.retention_purge': 'Old enquiries removed (retention clean-up)',
  'settings.enquiries_accept': 'Enquiry form switched on/off',
  'settings.enquiries_retention': 'Enquiry retention period changed',
  'request.status': 'Customer request status changed',
  'request.note': 'Customer request note added',
  'media.upload': 'Image uploaded',
  'media.upload_rejected': 'Image upload refused',
  'media.alt': 'Image alt text changed',
  'media.delete': 'Image deleted',
  'media.delete_refused': 'Image deletion refused (in use)',
  'content.draft': 'Business details draft saved',
  'content.restore': 'Business details revision restored as draft',
  'content.publish': 'Business details published',
  'content.discard': 'Business details draft discarded',
  'content.item.create': 'Content item created',
  'content.item.save': 'Content item draft saved',
  'content.item.publish': 'Content item published',
  'content.item.unpublish': 'Content item unpublished',
  'content.item.discard': 'Content item changes discarded',
  'content.item.delete': 'Content item deleted',
  'content.item.move': 'Content item reordered',
  'backup.create': 'Backup created',
  'backup.verify': 'Backup verified',
  'account.password_changed': 'Password changed',
  'account.password_change_failed': 'Password change refused',
  'account.sessions_revoked': 'Signed out other sessions',
  'admin.created_cli': 'Administrator created (command line)',
  'admin.password_reset_cli': 'Password reset (command line)',
};

export const actionLabel = (action: string) => ACTION_LABELS[action] ?? action;

export function categoryOf(action: string): Category | null {
  for (const [key, c] of Object.entries(CATEGORIES)) if (c.match(action)) return key as Category;
  return null;
}

// Keys never shown, whatever they contain.
const SENSITIVE_KEY = /pass|token|secret|hash|cookie|session|email|phone|name|message|note|address|alt|text|quote|(^|_)ip($|_)/i;

/** Safe "key: value" pairs from an audit detail JSON (simple values only, truncated). */
export function safeDetails(detail: string | null): { key: string; value: string }[] {
  if (!detail) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(detail);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const out: { key: string; value: string }[] = [];
  for (const [key, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key) || !/^[a-zA-Z0-9_]{1,40}$/.test(key)) continue;
    let value: string | null = null;
    if (typeof v === 'number' || typeof v === 'boolean') value = String(v);
    else if (typeof v === 'string') value = v.slice(0, 60);
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length <= 40)) value = (v as string[]).slice(0, 12).join(', ') || 'none';
    if (value !== null) out.push({ key, value });
    if (out.length >= 6) break;
  }
  return out;
}

export interface ActivityFilter {
  category?: Category | null;
  /** Inclusive, YYYY-MM-DD in the server's local time zone. */
  from?: string | null;
  to?: string | null;
  page?: number;
}

export interface ActivityRow {
  id: number;
  at: string;
  action: string;
  label: string;
  category: Category | null;
  username: string | null;
  targetType: string | null;
  targetId: string | null;
  details: { key: string; value: string }[];
  link: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Local midnight of a YYYY-MM-DD date as an ISO string, or null if invalid. */
export function dayStartIso(day: string | null | undefined, offsetDays = 0): string | null {
  if (!day || !DATE_RE.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number);
  // Reject impossible dates such as 2026-02-31 (JavaScript would roll them into March).
  const check = new Date(y, m - 1, d);
  if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d) return null;
  return new Date(y, m - 1, d + offsetDays).toISOString();
}

/** Links for targets that still exist (checked in bulk for the page being shown). */
function resolveLinks(rows: { targetType: string | null; targetId: string | null }[]): Map<string, string> {
  const links = new Map<string, string>();
  const ids = (type: string) => [...new Set(rows.filter((r) => r.targetType === type && /^\d{1,12}$/.test(r.targetId ?? '')).map((r) => Number(r.targetId)))];
  const existing = (table: string, list: number[], extra = '') => {
    if (!list.length) return [] as { id: number; kind?: string }[];
    return getDb()
      .prepare(`SELECT id${extra} FROM ${table} WHERE id IN (${list.map(() => '?').join(',')})`)
      .all(...list) as { id: number; kind?: string }[];
  };
  for (const r of existing('service_locations', ids('location'))) links.set(`location:${r.id}`, `/admin/service-areas/${r.id}`);
  for (const r of existing('enquiries', ids('enquiry'))) links.set(`enquiry:${r.id}`, `/admin/enquiries/${r.id}`);
  for (const r of existing('media', ids('media'))) links.set(`media:${r.id}`, `/admin/media/${r.id}`);
  for (const r of existing('content_items', ids('content_item'), ', kind')) links.set(`content_item:${r.id}`, `/admin/content/${r.kind}/${r.id}`);
  return links;
}

function staticLink(targetType: string | null, targetId: string | null = null): string | null {
  if (targetType === 'customer_request' && /^[A-Za-z0-9]{10,40}$/.test(targetId ?? '')) return `/admin/requests/${targetId}`;
  if (targetType === 'content') return '/admin/site-content';
  if (targetType === 'backup') return '/admin/backups';
  return null;
}

export function listActivity(filter: ActivityFilter = {}) {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.category && isCategory(filter.category)) where.push(CATEGORY_SQL[filter.category]);
  const from = dayStartIso(filter.from);
  const to = dayStartIso(filter.to, 1); // exclusive: start of the day after
  if (from) {
    where.push('a.at >= ?');
    params.push(from);
  }
  if (to) {
    where.push('a.at < ?');
    params.push(to);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (getDb().prepare(`SELECT COUNT(*) AS n FROM audit_log a ${clause}`).get(...params) as { n: number }).n;
  const pages = Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(filter.page ?? 1) || 1), pages);
  const raw = getDb()
    .prepare(
      `SELECT a.id, a.at, a.action, a.target_type AS targetType, a.target_id AS targetId, a.detail, u.username
       FROM audit_log a LEFT JOIN admin_users u ON u.id = a.user_id ${clause}
       ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, ACTIVITY_PAGE_SIZE, (page - 1) * ACTIVITY_PAGE_SIZE) as {
    id: number;
    at: string;
    action: string;
    targetType: string | null;
    targetId: string | null;
    detail: string | null;
    username: string | null;
  }[];
  const links = resolveLinks(raw);
  const rows: ActivityRow[] = raw.map((r) => ({
    id: r.id,
    at: r.at,
    action: r.action,
    label: actionLabel(r.action),
    category: categoryOf(r.action),
    username: r.username,
    // An admin target id is a username (CLI entries); never shown as a target.
    targetType: r.targetType === 'admin' ? null : r.targetType,
    targetId: r.targetType === 'admin' ? null : r.targetId,
    details: safeDetails(r.detail),
    link: links.get(`${r.targetType}:${r.targetId}`) ?? staticLink(r.targetType, r.targetId),
  }));
  return { rows, total, page, pages, from: from ? filter.from! : null, to: dayStartIso(filter.to) ? filter.to! : null };
}
