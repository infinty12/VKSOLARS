/**
 * Verified content items (Stage 7B): statistics, testimonials, team members, achievements.
 *
 * - Each item has a private working copy (draft) and, once published, a snapshot visitors see.
 *   Editing never changes the live site until the item is published again.
 * - Values are validated plain text (never HTML), re-validated when read back.
 * - Internal notes — statistic sources, testimonial approvals, achievement evidence — are stored
 *   with the item but never included in what public pages receive (see the to*Public functions).
 * - Publishing requires the verification/approval/consent fields; nothing is ever pre-filled.
 * - Team photos come from the media library; every draft/published reference is recorded in
 *   media_usages, so an image in use cannot be deleted. The photo's alt text is copied into the
 *   draft when it is saved (photoAlt), so a later alt-text edit in Media reaches the website only
 *   after the item is saved and published again.
 * - Public pages use published items only. Only if the database cannot be read do they fall back
 *   to the lists in src/config/site.ts. An empty published list stays empty.
 */
import { getDb, nowIso, transaction } from './db.ts';
import { audit } from './audit.ts';
import { getMedia, mediaUrl, thumbSize, MEDIA } from './media.ts';
import { oneLine, multiLine } from './site-content.ts';
import { site } from '../../config/site.ts';

export const KINDS = ['stat', 'testimonial', 'team', 'achievement'] as const;
export type Kind = (typeof KINDS)[number];
export const isKind = (k: unknown): k is Kind => (KINDS as readonly unknown[]).includes(k);

export const KIND_LABELS: Record<Kind, { one: string; many: string; where: string }> = {
  stat: { one: 'Statistic', many: 'Statistics', where: 'Home and About pages (figures band)' },
  testimonial: { one: 'Testimonial', many: 'Testimonials', where: 'Home page' },
  team: { one: 'Team member', many: 'Team', where: 'About page' },
  achievement: { one: 'Achievement', many: 'Credentials and achievements', where: 'About page' },
};

type FieldType = 'text' | 'multiline' | 'number' | 'checkbox' | 'media';
export interface FieldSpec {
  name: string;
  label: string;
  type: FieldType;
  max?: number;
  lines?: number;
  required?: boolean;
  /** Never shown on the public website. */
  internal?: boolean;
  hint?: string;
}

export const FIELDS: Record<Kind, FieldSpec[]> = {
  stat: [
    { name: 'value', label: 'Figure', type: 'number', required: true, hint: 'Whole number only, e.g. 250. Put any unit in the suffix.' },
    { name: 'suffix', label: 'Suffix', type: 'text', max: 12, hint: 'Optional, e.g. +, %, MW or “sites”.' },
    { name: 'label', label: 'Label', type: 'text', max: 60, required: true, hint: 'What the figure counts, e.g. “Plants inspected”.' },
    { name: 'source', label: 'Source of this figure', type: 'multiline', max: 300, lines: 4, internal: true, hint: 'Required to publish. Where the figure comes from (record, report, date). Never shown on the website.' },
    { name: 'verified', label: 'I confirm this figure is accurate and verified from the source above', type: 'checkbox' },
  ],
  testimonial: [
    { name: 'quote', label: 'Quote', type: 'multiline', max: 600, lines: 6, required: true, hint: 'The client’s words exactly as approved.' },
    { name: 'name', label: 'Client name', type: 'text', max: 80, required: true },
    { name: 'role', label: 'Role', type: 'text', max: 80, hint: 'Optional.' },
    { name: 'organisation', label: 'Organisation', type: 'text', max: 100, hint: 'Optional.' },
    { name: 'approvalNote', label: 'Approval record', type: 'multiline', max: 300, lines: 3, internal: true, hint: 'Required to publish. How and when the client approved publication. Never shown on the website.' },
    { name: 'approved', label: 'The client approved publishing this quote with their name, role and organisation', type: 'checkbox' },
  ],
  team: [
    { name: 'name', label: 'Name', type: 'text', max: 80, required: true },
    { name: 'role', label: 'Role', type: 'text', max: 80, required: true },
    { name: 'bio', label: 'Short bio', type: 'multiline', max: 400, lines: 4, hint: 'Optional. Only confirmed details.' },
    { name: 'photoId', label: 'Photo', type: 'media', hint: 'Optional. Choose an image from the media library; its alt text is used.' },
    { name: 'consent', label: 'This person agreed to appear on the website with these details', type: 'checkbox' },
  ],
  achievement: [
    { name: 'text', label: 'Credential or achievement', type: 'text', max: 160, required: true },
    { name: 'evidence', label: 'Evidence', type: 'multiline', max: 300, lines: 3, internal: true, hint: 'Required to publish. Certificate number, issuer, date. Never shown on the website.' },
    { name: 'verified', label: 'I confirm this has been verified against the evidence above', type: 'checkbox' },
  ],
};

export type ItemData = Record<string, string | number | boolean | null>;
export type FormValues = Record<string, string>;

const MAX_FIGURE = 999_999_999;

// ---------------------------------------------------------------- validation

/** Validate submitted values for a draft. Publishing has extra requirements (publishProblems). */
export function validateItem(kind: Kind, input: Record<string, unknown>): { ok: true; value: ItemData } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const out: ItemData = {};
  for (const f of FIELDS[kind]) {
    const raw = input[f.name];
    if (f.type === 'checkbox') {
      out[f.name] = raw === true || raw === 'on' || raw === 'true';
      continue;
    }
    if (f.type === 'number') {
      const s = oneLine(raw).replace(/[,\s]/g, '');
      if (!s) {
        out[f.name] = null;
        if (f.required) errors[f.name] = `Enter the ${f.label.toLowerCase()}.`;
      } else if (!/^\d{1,9}$/.test(s) || Number(s) > MAX_FIGURE) {
        out[f.name] = null;
        errors[f.name] = 'Enter a whole number (digits only), e.g. 250.';
      } else out[f.name] = Number(s);
      continue;
    }
    if (f.type === 'media') {
      const s = oneLine(raw);
      if (!s) out[f.name] = null;
      else if (!/^\d{1,9}$/.test(s) || !getMedia(Number(s))) {
        out[f.name] = null;
        errors[f.name] = 'Choose an image from the media library.';
      } else out[f.name] = Number(s);
      continue;
    }
    const value = f.type === 'multiline' ? multiLine(raw) : oneLine(raw);
    out[f.name] = value;
    if (!value && f.required) errors[f.name] = `Enter the ${f.label.toLowerCase()}.`;
    else if (f.max && value.length > f.max) errors[f.name] = `Keep this to ${f.max} characters.`;
    else if (f.lines && value.split('\n').length > f.lines) errors[f.name] = `Keep this to ${f.lines} lines.`;
    else if (f.name === 'suffix' && value && !/^[\p{L}\p{N} +%×./-]+$/u.test(value)) errors[f.name] = 'Use letters, digits, spaces and + % × . / - only.';
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: out };
}

/** What still blocks publishing (empty = can publish). Never satisfied automatically. */
export function publishProblems(kind: Kind, d: ItemData): string[] {
  const problems: string[] = [];
  if (kind === 'stat') {
    if (!d.source) problems.push('Add the source of this figure.');
    if (d.verified !== true) problems.push('Confirm the figure is accurate and verified.');
  } else if (kind === 'testimonial') {
    if (!d.approvalNote) problems.push('Record how and when the client approved publication.');
    if (d.approved !== true) problems.push('Confirm the client approved publishing this testimonial.');
  } else if (kind === 'team') {
    if (d.consent !== true) problems.push('Confirm this person agreed to appear on the website.');
  } else if (kind === 'achievement') {
    if (!d.evidence) problems.push('Add the evidence for this credential or achievement.');
    if (d.verified !== true) problems.push('Confirm it has been verified.');
  }
  return problems;
}

export function toFormValues(kind: Kind, d: ItemData | null): FormValues {
  const out: FormValues = {};
  for (const f of FIELDS[kind]) {
    const v = d?.[f.name];
    out[f.name] = f.type === 'checkbox' ? (v === true ? 'on' : '') : v === null || v === undefined ? '' : String(v);
  }
  return out;
}

/**
 * Re-validate stored JSON. Invalid fields are dropped; returns null if a required field is
 * then missing (such an item is never shown publicly).
 */
function readData(kind: Kind, json: string | null): ItemData | null {
  if (json === null) return null;
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(json);
    raw = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    raw = {};
  }
  const fields: Record<string, unknown> = {};
  for (const f of FIELDS[kind]) fields[f.name] = typeof raw[f.name] === 'number' ? String(raw[f.name]) : raw[f.name];
  for (let i = 0; i < 3; i++) {
    const r = validateItem(kind, fields);
    if (r.ok) return kind === 'team' ? withStoredPhotoAlt(r.value, raw.photoAlt) : r.value;
    let cleared = false;
    for (const [name] of Object.entries(r.errors)) {
      const spec = FIELDS[kind].find((f) => f.name === name)!;
      if (spec.required) return null;
      fields[name] = '';
      cleared = true;
    }
    if (!cleared) break;
  }
  return null;
}

/**
 * The photo alt text saved with a team member (not a form field). Kept only when there is a
 * photo; null means "not recorded" (items saved before Stage 7B.1).
 */
function withStoredPhotoAlt(d: ItemData, stored: unknown): ItemData {
  const alt = typeof stored === 'string' && typeof d.photoId === 'number' ? oneLine(stored).slice(0, MEDIA.altMax) : null;
  return { ...d, photoAlt: alt };
}

const changedFields = (kind: Kind, a: ItemData | null, b: ItemData | null) => {
  const fa = toFormValues(kind, a);
  const fb = toFormValues(kind, b);
  const changed = FIELDS[kind].map((f) => f.name).filter((n) => fa[n] !== fb[n]);
  // A new copy of the photo's alt text is a change too: it must be published to reach the site.
  if (kind === 'team' && (a?.photoAlt ?? null) !== (b?.photoAlt ?? null) && !changed.includes('photoId')) changed.push('photoAlt');
  return changed;
};

// ---------------------------------------------------------------- public shapes (no internal notes)

export interface PublicStat {
  value: number;
  suffix: string;
  label: string;
}
export interface PublicTestimonial {
  quote: string;
  name: string;
  role: string;
  organisation: string;
}
export interface PublicTeamMember {
  name: string;
  role: string;
  bio: string;
  photo: { src: string; width: number; height: number; alt: string } | null;
}
export interface PublicContent {
  stats: PublicStat[];
  testimonials: PublicTestimonial[];
  team: PublicTeamMember[];
  achievements: string[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function toPublic(kind: Kind, d: ItemData, into: PublicContent) {
  if (kind === 'stat') {
    const suffix = str(d.suffix);
    into.stats.push({ value: Number(d.value), suffix: /^[\p{L}\p{N}]/u.test(suffix) ? ` ${suffix}` : suffix, label: str(d.label) });
  } else if (kind === 'testimonial') {
    into.testimonials.push({ quote: str(d.quote), name: str(d.name), role: str(d.role), organisation: str(d.organisation) });
  } else if (kind === 'team') {
    const media = typeof d.photoId === 'number' ? getMedia(d.photoId) : null;
    const name = str(d.name);
    into.team.push({
      name,
      role: str(d.role),
      bio: str(d.bio),
      // The alt text saved with the item; items saved before it was recorded use the library's current text.
      photo: media ? { src: mediaUrl(media.uid, true), ...thumbSize(media), alt: (typeof d.photoAlt === 'string' ? d.photoAlt : media.altText) || `Portrait of ${name}` } : null,
    });
  } else {
    into.achievements.push(str(d.text));
  }
}

const emptyContent = (): PublicContent => ({ stats: [], testimonials: [], team: [], achievements: [] });

/** The lists in src/config/site.ts — used only if the database cannot be read. */
export function defaultContent(): PublicContent {
  return {
    stats: site.stats.map((s) => ({ value: s.value, suffix: s.suffix ?? '', label: s.label })),
    testimonials: site.testimonials.filter((t) => t.approved).map((t) => ({ quote: t.quote, name: t.name, role: t.role ?? '', organisation: t.organisation ?? '' })),
    team: site.team.map((m) => ({ name: m.name, role: m.role, bio: m.bio ?? '', photo: m.photo ? { src: m.photo, width: 320, height: 320, alt: `Portrait of ${m.name}` } : null })),
    achievements: [...site.achievements],
  };
}

interface Row {
  id: number;
  kind: Kind;
  position: number;
  draft: string;
  published: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

const SELECT = `
  SELECT c.id, c.kind, c.position, c.draft_data AS draft, c.published_data AS published, c.published_at AS publishedAt,
         pu.username AS publishedBy, c.updated_at AS updatedAt, uu.username AS updatedBy
  FROM content_items c
  LEFT JOIN admin_users pu ON pu.id = c.published_by
  LEFT JOIN admin_users uu ON uu.id = c.updated_by`;

const ORDER = 'ORDER BY c.position, c.id';

/** Published items only, in order. This is what visitors see. */
export function publishedContent(): PublicContent {
  const out = emptyContent();
  const rows = getDb().prepare(`${SELECT} WHERE c.published_data IS NOT NULL ${ORDER}`).all() as unknown as Row[];
  for (const r of rows) {
    const d = readData(r.kind, r.published);
    if (d) toPublic(r.kind, d, out);
  }
  return out;
}

/** Every item's draft as it would look if published (admin preview only). */
export function draftPreviewContent(): PublicContent {
  const out = emptyContent();
  const rows = getDb().prepare(`${SELECT} ${ORDER}`).all() as unknown as Row[];
  for (const r of rows) {
    const d = readData(r.kind, r.draft);
    if (d) toPublic(r.kind, d, out);
  }
  return out;
}

let warned = false;
/** For public pages. Never throws: falls back to src/config/site.ts if the database can't be read. */
export function publicContent(load: () => PublicContent = publishedContent): PublicContent {
  try {
    return load();
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn('[content] using built-in content lists; published items could not be read:', (err as Error).name);
    }
    return defaultContent();
  }
}

/** Content for this request: the draft preview on the admin preview page, else published content. */
export const contentFor = (locals: App.Locals): PublicContent => locals.contentPreview ?? publicContent();

// ---------------------------------------------------------------- admin

/** Images offered in the team photo picker (newest first). */
export function mediaOptions(limit = 500) {
  return getDb()
    .prepare('SELECT id, uid, original_name AS originalName, alt_text AS altText FROM media ORDER BY id DESC LIMIT ?')
    .all(limit) as unknown as { id: number; uid: string; originalName: string; altText: string }[];
}

/** One-line summary of an item for lists. */
export function itemSummary(kind: Kind, d: ItemData | null): string {
  if (!d) return '(incomplete draft)';
  if (kind === 'stat') {
    const suffix = str(d.suffix);
    return `${d.value ?? ''}${/^[\p{L}\p{N}]/u.test(suffix) ? ` ${suffix}` : suffix} — ${str(d.label)}`;
  }
  if (kind === 'testimonial') return `${str(d.name)}: “${str(d.quote).slice(0, 80)}${str(d.quote).length > 80 ? '…' : ''}”`;
  if (kind === 'team') return `${str(d.name)} — ${str(d.role)}`;
  return str(d.text);
}

export type ItemStatus = 'draft' | 'published' | 'changed';
export interface AdminItem {
  id: number;
  kind: Kind;
  position: number;
  draft: ItemData | null;
  published: ItemData | null;
  status: ItemStatus;
  publishedAt: string | null;
  publishedBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
  problems: string[];
}

function toAdmin(r: Row): AdminItem {
  const draft = readData(r.kind, r.draft);
  const published = readData(r.kind, r.published);
  const isPublished = r.published !== null;
  return {
    id: r.id,
    kind: r.kind,
    position: r.position,
    draft,
    published,
    status: !isPublished ? 'draft' : changedFields(r.kind, draft, published).length ? 'changed' : 'published',
    publishedAt: r.publishedAt,
    publishedBy: r.publishedBy,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
    problems: draft ? publishProblems(r.kind, draft) : ['This draft is incomplete. Edit and save it again.'],
  };
}

export function listItems(kind: Kind): AdminItem[] {
  return (getDb().prepare(`${SELECT} WHERE c.kind = ? ${ORDER}`).all(kind) as unknown as Row[]).map(toAdmin);
}

export function getItem(id: number): AdminItem | null {
  if (!Number.isInteger(id) || id <= 0) return null;
  const r = getDb().prepare(`${SELECT} WHERE c.id = ?`).get(id) as Row | undefined;
  return r ? toAdmin(r) : null;
}

const USAGE_TYPE = 'Team member';
const usageKeys = (id: number) => ({ draft: `#${id} (draft)`, published: `#${id} (published)` });

/** Record which media items this content item's draft and published versions use. */
function syncUsages(id: number) {
  const row = getDb().prepare('SELECT kind, draft_data AS draft, published_data AS published FROM content_items WHERE id = ?').get(id) as
    | { kind: Kind; draft: string; published: string | null }
    | undefined;
  const keys = usageKeys(id);
  getDb().prepare('DELETE FROM media_usages WHERE usage_type = ? AND usage_key IN (?, ?)').run(USAGE_TYPE, keys.draft, keys.published);
  if (!row || row.kind !== 'team') return;
  const add = getDb().prepare('INSERT OR IGNORE INTO media_usages (media_id, usage_type, usage_key, created_at) VALUES (?, ?, ?, ?)');
  const draft = readData('team', row.draft);
  const published = readData('team', row.published);
  if (typeof draft?.photoId === 'number') add.run(draft.photoId, USAGE_TYPE, keys.draft, nowIso());
  if (typeof published?.photoId === 'number') add.run(published.photoId, USAGE_TYPE, keys.published, nowIso());
}

/** The chosen photo no longer exists (deleted between choosing it and saving). Nothing was saved. */
export class PhotoUnavailableError extends Error {
  constructor() {
    super('The chosen image is no longer in the media library.');
    this.name = 'PhotoUnavailableError';
  }
}

/**
 * Inside the save transaction: confirm the photo still exists and copy its current alt text into
 * the draft. Throws PhotoUnavailableError (rolling the whole save back) if the image has gone.
 */
function prepareForSave(kind: Kind, data: ItemData): ItemData {
  if (kind !== 'team') return data;
  if (typeof data.photoId !== 'number') return { ...data, photoAlt: null };
  const media = getMedia(data.photoId);
  if (!media) throw new PhotoUnavailableError();
  return { ...data, photoAlt: media.altText };
}

/** Run a save; a database foreign-key rejection on the photo becomes PhotoUnavailableError. */
function guardPhoto<T>(fn: () => T): T {
  try {
    return transaction(fn);
  } catch (err) {
    if (err instanceof PhotoUnavailableError || /FOREIGN KEY constraint failed/i.test((err as Error).message)) throw new PhotoUnavailableError();
    throw err;
  }
}

/** Create a draft item. Throws PhotoUnavailableError (nothing saved) if its photo has just been deleted. */
export function createItem(kind: Kind, input: ItemData, userId: number | null): number {
  const id = guardPhoto(() => {
    const data = prepareForSave(kind, input);
    const now = nowIso();
    const pos = (getDb().prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM content_items WHERE kind = ?').get(kind) as { p: number }).p;
    const newId = Number(
      getDb()
        .prepare('INSERT INTO content_items (kind, position, draft_data, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(kind, pos, JSON.stringify(data), userId, userId, now, now).lastInsertRowid,
    );
    syncUsages(newId);
    return newId;
  });
  audit('content.item.create', { userId, targetType: 'content_item', targetId: id, detail: { kind } });
  return id;
}

/** Save the draft. Throws PhotoUnavailableError (nothing saved) if its photo has just been deleted. */
export function saveItemDraft(id: number, input: ItemData, userId: number | null): boolean {
  const item = getItem(id);
  if (!item) return false;
  const data = guardPhoto(() => {
    const prepared = prepareForSave(item.kind, input);
    getDb().prepare('UPDATE content_items SET draft_data = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(prepared), userId, nowIso(), id);
    syncUsages(id);
    return prepared;
  });
  audit('content.item.save', { userId, targetType: 'content_item', targetId: id, detail: { kind: item.kind, changed: changedFields(item.kind, item.draft, data) } });
  return true;
}

export type PublishResult = { ok: true } | { ok: false; reason: 'not_found' | 'incomplete'; problems?: string[] };

export function publishItem(id: number, userId: number | null): PublishResult {
  const item = getItem(id);
  if (!item) return { ok: false, reason: 'not_found' };
  if (!item.draft) return { ok: false, reason: 'incomplete', problems: item.problems };
  const problems = publishProblems(item.kind, item.draft);
  if (problems.length) return { ok: false, reason: 'incomplete', problems };
  transaction(() => {
    getDb()
      .prepare('UPDATE content_items SET published_data = ?, published_at = ?, published_by = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(item.draft), nowIso(), userId, nowIso(), id);
    syncUsages(id);
  });
  audit('content.item.publish', { userId, targetType: 'content_item', targetId: id, detail: { kind: item.kind } });
  return { ok: true };
}

export function unpublishItem(id: number, userId: number | null): boolean {
  const item = getItem(id);
  if (!item || item.status === 'draft') return false;
  transaction(() => {
    getDb().prepare('UPDATE content_items SET published_data = NULL, published_at = NULL, published_by = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id);
    syncUsages(id);
  });
  audit('content.item.unpublish', { userId, targetType: 'content_item', targetId: id, detail: { kind: item.kind } });
  return true;
}

/** Throw away unpublished edits: the draft becomes the published version again. */
export function discardItemChanges(id: number, userId: number | null): boolean {
  const item = getItem(id);
  if (!item || item.status !== 'changed') return false;
  transaction(() => {
    getDb().prepare('UPDATE content_items SET draft_data = published_data, updated_by = ?, updated_at = ? WHERE id = ?').run(userId, nowIso(), id);
    syncUsages(id);
  });
  audit('content.item.discard', { userId, targetType: 'content_item', targetId: id, detail: { kind: item.kind } });
  return true;
}

export type DeleteItemResult = { ok: true } | { ok: false; reason: 'not_found' | 'published' };

/** Delete an item that is not published (unpublish first). Its media usages are released. */
export function deleteItem(id: number, userId: number | null): DeleteItemResult {
  const item = getItem(id);
  if (!item) return { ok: false, reason: 'not_found' };
  if (item.status !== 'draft') return { ok: false, reason: 'published' };
  transaction(() => {
    const keys = usageKeys(id);
    getDb().prepare('DELETE FROM media_usages WHERE usage_type = ? AND usage_key IN (?, ?)').run(USAGE_TYPE, keys.draft, keys.published);
    getDb().prepare('DELETE FROM content_items WHERE id = ?').run(id);
  });
  audit('content.item.delete', { userId, targetType: 'content_item', targetId: id, detail: { kind: item.kind } });
  return { ok: true };
}

/** Move an item one place up or down within its list. Takes effect immediately (order is not private). */
export function moveItem(id: number, direction: 'up' | 'down', userId: number | null): boolean {
  const item = getItem(id);
  if (!item) return false;
  const moved = transaction(() => {
    const list = getDb().prepare('SELECT id FROM content_items WHERE kind = ? ORDER BY position, id').all(item.kind) as { id: number }[];
    const i = list.findIndex((r) => r.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= list.length) return false;
    [list[i], list[j]] = [list[j], list[i]];
    const set = getDb().prepare('UPDATE content_items SET position = ? WHERE id = ?');
    list.forEach((r, n) => set.run(n + 1, r.id));
    return true;
  });
  if (moved) audit('content.item.move', { userId, targetType: 'content_item', targetId: id, detail: { kind: item.kind, direction } });
  return moved;
}
