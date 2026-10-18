/**
 * Enquiries: storage, form tokens and inbox operations.
 *
 * - Every query uses bound parameters.
 * - Enquiry content is never written to logs or the audit log (ids and counts only).
 * - Nothing is deleted automatically; deletion is always an explicit admin action.
 */
import { randomBytes } from 'node:crypto';
import { getDb, nowIso, likeEscape, transaction } from './db.ts';
import { audit } from './audit.ts';
import { sign, safeEqual } from './secret.ts';
import { ENQUIRY_LIMIT } from './config.ts';
import { CONSENT_TEXT, type EnquiryValues } from '../enquiry.ts';
import { enqueueEnquiryNotification, kickOutbox } from './notifications.ts';

export const ENQUIRY_STATUSES = ['new', 'in_progress', 'resolved'] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];
export const STATUS_LABELS: Record<EnquiryStatus, string> = { new: 'New', in_progress: 'In progress', resolved: 'Resolved' };
export const NOTE_MAX = 2000;

/** The only messages ever shown to visitors about a submission (fixed text, never user input). */
export const ENQUIRY_MESSAGES = {
  disabled: 'Online enquiries are not active yet, so your message was not sent.',
  origin: 'This form must be submitted from the VK Solar website.',
  too_large: 'Your enquiry is too long to send. Please shorten your message and try again.',
  bad_request: 'Your enquiry could not be sent. Please check the form and try again.',
  rejected: 'Your enquiry could not be sent. Please check the form and try again.',
  token: 'This form has expired. Please reload the page and try again.',
  too_fast: 'Please take a moment to check your details, then submit again.',
  rate_limited: 'Too many enquiries have been sent from your connection. Please try again later.',
  invalid: 'Please correct the highlighted fields.',
  server: 'Sorry, something went wrong on our side and your enquiry was not saved. Please try again later.',
} as const;
export type EnquiryMessageCode = keyof typeof ENQUIRY_MESSAGES;

export const REFERENCE_RE = /^ENQ-\d{8}-[0-9A-F]{6}$/;

// ---------------------------------------------------------------- signed form tokens

/** Token embedded in the contact form: issue time + HMAC. Proves the form came from this site. */
export function issueFormToken(now = Date.now()): string {
  const t = String(now);
  return `${t}.${sign(`enquiry:${t}`)}`;
}

export type TokenCheck = 'ok' | 'invalid' | 'too_fast' | 'expired';

export function checkFormToken(token: unknown, now = Date.now()): TokenCheck {
  const [t, mac] = String(token ?? '').split('.');
  if (!t || !mac || !/^\d{13}$/.test(t) || !safeEqual(mac, sign(`enquiry:${t}`))) return 'invalid';
  const age = now - Number(t);
  if (age < ENQUIRY_LIMIT.minFillMs) return 'too_fast';
  if (age > ENQUIRY_LIMIT.maxAgeMs) return 'expired';
  return 'ok';
}

// ---------------------------------------------------------------- create

function newReference(): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `ENQ-${ymd}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

/** Store a validated, normalised enquiry. Returns its id and public reference. */
export function createEnquiry(v: EnquiryValues): { id: number; reference: string } {
  const regionId = (getDb().prepare('SELECT id FROM service_regions WHERE code = ?').get(v.region) as { id: number } | undefined)?.id ?? null;
  const now = nowIso();
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = newReference();
    try {
      // The enquiry and its notification (if email is enabled) commit together; sending happens
      // afterwards, so a mail problem can never undo or hide a stored enquiry.
      const id = transaction(() => {
        const res = getDb()
          .prepare(
            `INSERT INTO enquiries (reference, created_at, updated_at, name, phone, email, service, region_id, location, message, consent, consent_text, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'new')`,
          )
          .run(reference, now, now, v.name, v.phone, v.email, v.service, regionId, v.location, v.message, CONSENT_TEXT);
        const newId = Number(res.lastInsertRowid);
        enqueueEnquiryNotification(newId);
        return newId;
      });
      audit('enquiry.received', { targetType: 'enquiry', targetId: id });
      try {
        kickOutbox();
      } catch {
        // Scheduling problems must never affect the stored enquiry; the timer retries later.
      }
      return { id, reference };
    } catch (err) {
      // Retry only on a (very unlikely) reference collision.
      if (!/UNIQUE constraint failed: enquiries\.reference/.test((err as Error).message)) throw err;
    }
  }
  throw new Error('Could not allocate an enquiry reference');
}

// ---------------------------------------------------------------- read

export interface Enquiry {
  id: number;
  reference: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  phone: string;
  email: string;
  service: string;
  regionName: string | null;
  location: string;
  message: string;
  consentText: string;
  status: EnquiryStatus;
  resolvedAt: string | null;
}

export interface EnquiryNote {
  id: number;
  body: string;
  createdAt: string;
  author: string | null;
}

const SELECT = `
  SELECT e.id, e.reference, e.created_at AS createdAt, e.updated_at AS updatedAt, e.name, e.phone, e.email, e.service,
         r.name AS regionName, e.location, e.message, e.consent_text AS consentText, e.status, e.resolved_at AS resolvedAt
  FROM enquiries e LEFT JOIN service_regions r ON r.id = e.region_id`;

export function getEnquiry(id: number): Enquiry | null {
  if (!Number.isInteger(id) || id < 1) return null;
  return (getDb().prepare(`${SELECT} WHERE e.id = ?`).get(id) as Enquiry | undefined) ?? null;
}

export function listNotes(enquiryId: number): EnquiryNote[] {
  return getDb()
    .prepare(
      `SELECT n.id, n.body, n.created_at AS createdAt, u.username AS author
       FROM enquiry_notes n LEFT JOIN admin_users u ON u.id = n.author_id
       WHERE n.enquiry_id = ? ORDER BY n.id`,
    )
    .all(enquiryId) as unknown as EnquiryNote[];
}

export interface EnquiryFilter {
  q?: string;
  status?: string;
  page?: number;
  perPage?: number;
}

export function listEnquiries(filter: EnquiryFilter = {}) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const q = String(filter.q ?? '').trim().slice(0, 100);
  if (q) {
    const like = `%${likeEscape(q)}%`;
    where.push(
      "(e.reference LIKE ? ESCAPE '\\' OR e.name LIKE ? ESCAPE '\\' OR e.phone LIKE ? ESCAPE '\\' OR e.email LIKE ? ESCAPE '\\' OR e.location LIKE ? ESCAPE '\\' OR e.message LIKE ? ESCAPE '\\')",
    );
    params.push(like, like, like, like, like, like);
  }
  if (filter.status && (ENQUIRY_STATUSES as readonly string[]).includes(filter.status)) {
    where.push('e.status = ?');
    params.push(filter.status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const perPage = Math.min(Math.max(filter.perPage ?? 25, 1), 100);
  const total = (getDb().prepare(`SELECT COUNT(*) AS c FROM enquiries e ${clause}`).get(...params) as { c: number }).c;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(filter.page ?? 1, 1), pages);
  const items = getDb()
    .prepare(`${SELECT} ${clause} ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`)
    .all(...params, perPage, (page - 1) * perPage) as unknown as Enquiry[];
  return { items, total, page, pages, perPage };
}

export function statusCounts(): Record<EnquiryStatus, number> {
  const rows = getDb().prepare('SELECT status, COUNT(*) AS c FROM enquiries GROUP BY status').all() as { status: EnquiryStatus; c: number }[];
  const out = { new: 0, in_progress: 0, resolved: 0 };
  for (const r of rows) out[r.status] = r.c;
  return out;
}

// ---------------------------------------------------------------- update

export function setEnquiryStatus(id: number, status: string, userId: number): boolean {
  if (!(ENQUIRY_STATUSES as readonly string[]).includes(status)) return false;
  const current = getEnquiry(id);
  if (!current) return false;
  if (current.status === status) return true;
  const now = nowIso();
  getDb()
    .prepare('UPDATE enquiries SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?')
    .run(status, status === 'resolved' ? now : null, now, id);
  audit('enquiry.status', { userId, targetType: 'enquiry', targetId: id, detail: { from: current.status, to: status } });
  return true;
}

export function addNote(id: number, body: string, userId: number): { ok: true } | { ok: false; error: string } {
  const text = String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .trim();
  if (!text) return { ok: false, error: 'Write a note before saving.' };
  if (text.length > NOTE_MAX) return { ok: false, error: `Notes must be ${NOTE_MAX} characters or fewer.` };
  if (!getEnquiry(id)) return { ok: false, error: 'That enquiry no longer exists.' };
  const now = nowIso();
  transaction(() => {
    getDb().prepare('INSERT INTO enquiry_notes (enquiry_id, author_id, body, created_at) VALUES (?, ?, ?, ?)').run(id, userId, text, now);
    getDb().prepare('UPDATE enquiries SET updated_at = ? WHERE id = ?').run(now, id);
  });
  audit('enquiry.note', { userId, targetType: 'enquiry', targetId: id });
  return { ok: true };
}

export function deleteEnquiry(id: number, userId: number): boolean {
  const res = getDb().prepare('DELETE FROM enquiries WHERE id = ?').run(id); // notes cascade
  if (res.changes > 0) audit('enquiry.delete', { userId, targetType: 'enquiry', targetId: id });
  return res.changes > 0;
}

// ---------------------------------------------------------------- retention

const cutoffIso = (days: number, now = Date.now()) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

/** How many RESOLVED enquiries were resolved more than `days` days ago. */
export function countPastRetention(days: number): number {
  return (
    getDb().prepare("SELECT COUNT(*) AS c FROM enquiries WHERE status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at < ?").get(cutoffIso(days)) as {
      c: number;
    }
  ).c;
}

/** Delete RESOLVED enquiries resolved more than `days` days ago. Explicit admin action only. */
export function purgePastRetention(days: number, userId: number): number {
  const res = getDb()
    .prepare("DELETE FROM enquiries WHERE status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at < ?")
    .run(cutoffIso(days));
  const count = Number(res.changes);
  audit('enquiry.retention_purge', { userId, targetType: 'enquiry', detail: { days, deleted: count } });
  return count;
}
