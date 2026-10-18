/**
 * Editable business details (Stage 7A): validation, draft/publish and revision history.
 *
 * - Values are validated plain text (never HTML) and stored as JSON in immutable revisions.
 * - content_state points at the current draft and the published revision. Public pages read
 *   ONLY the published revision (publicBusiness); drafts are visible only in the admin editor
 *   and its preview. With nothing published, or if the database fails, the built-in defaults
 *   from src/config/site.ts are shown.
 * - Every change is audit-logged with revision ids and field names, never the values.
 */
import { getDb, nowIso, transaction } from './db.ts';
import { audit } from './audit.ts';
import { defaultBusiness, type BusinessDetails } from '../../config/site.ts';

const SCOPE = 'business';

export const LIMITS = {
  phoneDisplay: 25,
  email: 254,
  address: 300,
  addressLines: 6,
  hours: 200,
  hoursLines: 4,
  url: 300,
};

export const FIELD_LABELS = {
  phone: 'Phone number',
  phoneDisplay: 'Phone number as displayed',
  whatsapp: 'WhatsApp number',
  email: 'Email address',
  address: 'Office address',
  hours: 'Opening hours',
  linkedin: 'LinkedIn page',
  instagram: 'Instagram profile',
  facebook: 'Facebook page',
  youtube: 'YouTube channel',
  founded: 'Year founded',
} as const;
export type FieldName = keyof typeof FIELD_LABELS;
export const FIELD_NAMES = Object.keys(FIELD_LABELS) as FieldName[];

const SOCIAL_HOSTS: Record<'linkedin' | 'instagram' | 'facebook' | 'youtube', string[]> = {
  linkedin: ['linkedin.com'],
  instagram: ['instagram.com'],
  facebook: ['facebook.com'],
  youtube: ['youtube.com', 'youtu.be'],
};

// ---------------------------------------------------------------- validation

// Control characters, zero-width and bidi-override characters never belong in contact details.
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** One line of plain text: invisible characters removed, whitespace collapsed. */
const oneLine = (v: unknown) => String(v ?? '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();

/** Multi-line plain text: each line cleaned, blank lines dropped, \n kept as the only separator. */
const multiLine = (v: unknown) =>
  String(v ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(INVISIBLE, '').replace(/[^\S\n]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

const digits = (s: string) => s.replace(/\D/g, '');

/** Every field empty: all related sections hidden. */
const EMPTY: BusinessDetails = {
  contact: { phone: null, phoneDisplay: null, whatsapp: null, email: null, address: null, hours: null },
  social: { linkedin: null, instagram: null, facebook: null, youtube: null },
  founded: null,
};

export type FormValues = Record<FieldName, string>;
export type ValidationResult = { ok: true; value: BusinessDetails } | { ok: false; errors: Partial<Record<FieldName, string>> };

/** Validate submitted form values. Empty fields become null (the related UI is then hidden). */
export function validateBusiness(input: Partial<Record<FieldName, unknown>>): ValidationResult {
  const errors: Partial<Record<FieldName, string>> = {};
  const out: BusinessDetails = structuredClone(EMPTY);

  const phoneRaw = oneLine(input.phone);
  if (phoneRaw) {
    const phone = phoneRaw.replace(/[\s().-]/g, '');
    if (/^\+[1-9]\d{7,14}$/.test(phone)) out.contact.phone = phone;
    else errors.phone = 'Use international format starting with +, e.g. +91 98765 43210.';
  }

  const display = oneLine(input.phoneDisplay);
  if (display) {
    if (!phoneRaw) errors.phoneDisplay = 'Enter the phone number first.';
    else if (display.length > LIMITS.phoneDisplay || !/^[0-9+()\- ]+$/.test(display)) errors.phoneDisplay = 'Use only digits, spaces, +, - and brackets (25 characters max).';
    else if (out.contact.phone && digits(display) !== digits(out.contact.phone)) errors.phoneDisplay = 'Must be the same number as the phone number, just formatted for reading.';
    else out.contact.phoneDisplay = display;
  }

  const wa = oneLine(input.whatsapp);
  if (wa) {
    const n = wa.replace(/[\s().+-]/g, '');
    if (/^[1-9]\d{7,14}$/.test(n)) out.contact.whatsapp = n;
    else errors.whatsapp = 'Use the full number with country code, e.g. +91 98765 43210.';
  }

  const email = oneLine(input.email);
  if (email) {
    if (email.length <= LIMITS.email && /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(email)) out.contact.email = email.toLowerCase();
    else errors.email = 'Enter a valid email address, e.g. name@example.com.';
  }

  const address = multiLine(input.address);
  if (address) {
    if (address.length > LIMITS.address || address.split('\n').length > LIMITS.addressLines)
      errors.address = `Keep the address to ${LIMITS.address} characters and ${LIMITS.addressLines} lines.`;
    else out.contact.address = address;
  }

  const hours = multiLine(input.hours);
  if (hours) {
    if (hours.length > LIMITS.hours || hours.split('\n').length > LIMITS.hoursLines) errors.hours = `Keep the hours to ${LIMITS.hours} characters and ${LIMITS.hoursLines} lines.`;
    else out.contact.hours = hours;
  }

  for (const network of Object.keys(SOCIAL_HOSTS) as (keyof typeof SOCIAL_HOSTS)[]) {
    const raw = oneLine(input[network]);
    if (!raw) continue;
    const label = FIELD_LABELS[network];
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {
      url = null;
    }
    const host = url?.hostname.toLowerCase() ?? '';
    const allowed = SOCIAL_HOSTS[network].some((d) => host === d || host.endsWith(`.${d}`));
    if (!url || raw.length > LIMITS.url || url.protocol !== 'https:' || url.username || url.password || url.port || !allowed) {
      errors[network] = `Enter the full https:// address of the ${label.toLowerCase()} on ${SOCIAL_HOSTS[network].join(' or ')}.`;
    } else {
      out.social[network] = url.href;
    }
  }

  const foundedRaw = oneLine(input.founded);
  if (foundedRaw) {
    const year = Number(foundedRaw);
    const max = new Date().getFullYear();
    if (/^\d{4}$/.test(foundedRaw) && year >= 1900 && year <= max) out.founded = year;
    else errors.founded = `Enter a year between 1900 and ${max}.`;
  }

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: out };
}

/** Form values (strings) for a set of business details, for pre-filling the editor. */
export function toFormValues(b: BusinessDetails): FormValues {
  return {
    phone: b.contact.phone ?? '',
    phoneDisplay: b.contact.phoneDisplay ?? '',
    whatsapp: b.contact.whatsapp ? `+${b.contact.whatsapp}` : '',
    email: b.contact.email ?? '',
    address: b.contact.address ?? '',
    hours: b.contact.hours ?? '',
    linkedin: b.social.linkedin ?? '',
    instagram: b.social.instagram ?? '',
    facebook: b.social.facebook ?? '',
    youtube: b.social.youtube ?? '',
    founded: b.founded ? String(b.founded) : '',
  };
}

/** Field names whose values differ between two versions. */
export function changedFields(a: BusinessDetails, b: BusinessDetails): FieldName[] {
  const fa = toFormValues(a);
  const fb = toFormValues(b);
  return FIELD_NAMES.filter((f) => fa[f] !== fb[f]);
}

/**
 * Re-validate stored JSON on the way out, so even a hand-edited database row can only ever
 * yield clean, plain-text values. Anything invalid falls back to empty.
 */
function fromStored(json: string): BusinessDetails {
  let raw: { contact?: Record<string, unknown>; social?: Record<string, unknown>; founded?: unknown } = {};
  try {
    raw = JSON.parse(json) ?? {};
  } catch {
    raw = {};
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  const fields = {} as FormValues;
  for (const f of FIELD_NAMES) fields[f] = str(f === 'founded' ? raw.founded : (raw.contact?.[f] ?? raw.social?.[f]));
  if (fields.whatsapp) fields.whatsapp = `+${fields.whatsapp}`;
  // Drop invalid fields until the rest validates (a dropped phone also invalidates its display form).
  for (let i = 0; i < 3; i++) {
    const r = validateBusiness(fields);
    if (r.ok) return r.value;
    for (const f of Object.keys(r.errors) as FieldName[]) fields[f] = '';
  }
  return EMPTY;
}

// ---------------------------------------------------------------- revisions

export interface Revision {
  id: number;
  data: BusinessDetails;
  createdAt: string;
  createdBy: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  restoredFrom: number | null;
}

interface RevisionRow {
  id: number;
  data: string;
  createdAt: string;
  createdBy: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  restoredFrom: number | null;
}

const REVISION_SELECT = `
  SELECT r.id, r.data, r.created_at AS createdAt, cu.username AS createdBy, r.published_at AS publishedAt,
         pu.username AS publishedBy, r.restored_from AS restoredFrom
  FROM content_revisions r
  LEFT JOIN admin_users cu ON cu.id = r.created_by
  LEFT JOIN admin_users pu ON pu.id = r.published_by`;

const toRevision = (r: RevisionRow): Revision => ({ ...r, data: fromStored(r.data) });

export function getRevision(id: number): Revision | null {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = getDb().prepare(`${REVISION_SELECT} WHERE r.id = ? AND r.scope = ?`).get(id, SCOPE) as RevisionRow | undefined;
  return row ? toRevision(row) : null;
}

export function contentState(): { draftId: number | null; publishedId: number | null } {
  const row = getDb().prepare('SELECT draft_revision_id AS draftId, published_revision_id AS publishedId FROM content_state WHERE scope = ?').get(SCOPE) as
    | { draftId: number | null; publishedId: number | null }
    | undefined;
  return { draftId: row?.draftId ?? null, publishedId: row?.publishedId ?? null };
}

function setState(changes: { draftId?: number | null; publishedId?: number | null }) {
  const cur = contentState();
  const next = { ...cur, ...changes };
  getDb()
    .prepare(
      `INSERT INTO content_state (scope, draft_revision_id, published_revision_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET draft_revision_id = excluded.draft_revision_id,
         published_revision_id = excluded.published_revision_id, updated_at = excluded.updated_at`,
    )
    .run(SCOPE, next.draftId, next.publishedId, nowIso());
}

export const getDraft = () => {
  const { draftId } = contentState();
  return draftId ? getRevision(draftId) : null;
};

export const getPublished = () => {
  const { publishedId } = contentState();
  return publishedId ? getRevision(publishedId) : null;
};

/** What public pages show: the published version, else the built-in defaults. */
export const livePublished = (): BusinessDetails => getPublished()?.data ?? defaultBusiness;

/** For the editor: the draft if there is one, else what is live. */
export const editorBusiness = (): BusinessDetails => getDraft()?.data ?? livePublished();

let warned = false;
/**
 * Published business details for public pages. Never throws: if the database cannot be read,
 * the built-in defaults are used (and one warning is logged, without details).
 */
export function publicBusiness(load: () => BusinessDetails = livePublished): BusinessDetails {
  try {
    return load();
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn('[content] using built-in business details; published content could not be read:', (err as Error).name);
    }
    return defaultBusiness;
  }
}

/** Save a validated version as the new draft (a new revision). Public pages are unaffected. */
export function saveDraft(value: BusinessDetails, userId: number | null, restoredFrom: number | null = null): Revision {
  const id = transaction(() => {
    const newId = Number(
      getDb()
        .prepare('INSERT INTO content_revisions (scope, data, created_by, created_at, restored_from) VALUES (?, ?, ?, ?, ?)')
        .run(SCOPE, JSON.stringify(value), userId, nowIso(), restoredFrom).lastInsertRowid,
    );
    setState({ draftId: newId });
    return newId;
  });
  audit(restoredFrom ? 'content.restore' : 'content.draft', {
    userId,
    targetType: 'content',
    targetId: id,
    detail: { scope: SCOPE, changed: changedFields(livePublished(), value), ...(restoredFrom ? { from: restoredFrom } : {}) },
  });
  return getRevision(id)!;
}

/** Publish the current draft. Returns false if there is no draft. */
export function publishDraft(userId: number | null): { ok: true; revisionId: number } | { ok: false } {
  const result = transaction(() => {
    const { draftId } = contentState();
    if (!draftId) return null;
    getDb().prepare('UPDATE content_revisions SET published_at = ?, published_by = ? WHERE id = ?').run(nowIso(), userId, draftId);
    setState({ draftId: null, publishedId: draftId });
    return draftId;
  });
  if (!result) return { ok: false };
  audit('content.publish', { userId, targetType: 'content', targetId: result, detail: { scope: SCOPE } });
  return { ok: true, revisionId: result };
}

/** Drop the current draft (it stays in the history). Returns false if there was none. */
export function discardDraft(userId: number | null): boolean {
  const { draftId } = contentState();
  if (!draftId) return false;
  setState({ draftId: null });
  audit('content.discard', { userId, targetType: 'content', targetId: draftId, detail: { scope: SCOPE } });
  return true;
}

/** Copy an earlier revision into a new draft (it still has to be published). */
export function restoreRevision(id: number, userId: number | null): Revision | null {
  const rev = getRevision(id);
  if (!rev) return null;
  return saveDraft(rev.data, userId, rev.id);
}

export type RevisionStatus = 'live' | 'draft' | 'previously_live' | 'unpublished';

export function listRevisions(limit = 30): (Revision & { status: RevisionStatus; changed: FieldName[] })[] {
  const { draftId, publishedId } = contentState();
  const rows = (getDb().prepare(`${REVISION_SELECT} WHERE r.scope = ? ORDER BY r.id DESC LIMIT ?`).all(SCOPE, limit + 1) as unknown as RevisionRow[]).map(toRevision);
  return rows.slice(0, limit).map((r, i) => ({
    ...r,
    status: r.id === publishedId ? 'live' : r.id === draftId ? 'draft' : r.publishedAt ? 'previously_live' : 'unpublished',
    changed: changedFields(rows[i + 1]?.data ?? defaultBusiness, r.data),
  }));
}
