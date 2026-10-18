/**
 * Service locations: where VK Solar has (or plans) coverage, configured only by an admin.
 *
 * Rules enforced here (and, for the critical ones, also by database constraints):
 *   - Every location belongs to one of the 36 seeded states/UTs.
 *   - District and city are optional; leaving both empty means a state/UT-wide entry.
 *   - One entry per (state/UT, district, city) — compared case- and space-insensitively.
 *   - An "unconfirmed" location can never be published (DB CHECK constraint too).
 *   - Only published locations are ever shown publicly (see listPublicLocations).
 */
import { getDb, nowIso, likeEscape } from './db.ts';
import { audit } from './audit.ts';
import { services } from '../../data/services.ts';

export const COVERAGE_STATUSES = ['available', 'limited', 'planned', 'unconfirmed'] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export const STATUS_LABELS: Record<CoverageStatus, string> = {
  available: 'Coverage available',
  limited: 'Limited coverage',
  planned: 'Planned — not yet available',
  unconfirmed: 'Not yet confirmed',
};

/** Statuses that represent an active service location. Planned/unconfirmed never do. */
export const SERVICEABLE: readonly CoverageStatus[] = ['available', 'limited'];

export const SERVICE_SLUGS = services.map((s) => s.slug);
export const LIMITS = { place: 80, note: 280 } as const;

export interface Region {
  id: number;
  code: string;
  name: string;
  type: 'state' | 'ut';
}

export interface Location {
  id: number;
  regionId: number;
  regionCode: string;
  regionName: string;
  regionType: 'state' | 'ut';
  district: string;
  city: string;
  status: CoverageStatus;
  services: string[];
  note: string;
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LocationInput {
  regionCode: string;
  district: string;
  city: string;
  status: string;
  services: string[];
  note: string;
  published: boolean;
}

export type LocationErrors = Partial<Record<keyof LocationInput | 'form', string>>;

// ---------------------------------------------------------------- regions

export function listRegions(): Region[] {
  return getDb().prepare('SELECT id, code, name, type FROM service_regions ORDER BY sort').all() as unknown as Region[];
}

function regionByCode(code: string): Region | undefined {
  return getDb().prepare('SELECT id, code, name, type FROM service_regions WHERE code = ?').get(code) as Region | undefined;
}

// ---------------------------------------------------------------- normalisation & validation

/** Trim, collapse internal whitespace and remove control characters. */
export function cleanText(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max + 1); // keep one extra char so over-length input is detected, not silently cut
}

// Letters (any script), marks, digits, spaces and common punctuation in Indian place names.
const PLACE_RE = /^[\p{L}\p{M}\p{N} .,'()&/-]+$/u;

const dedupeKey = (regionId: number, district: string, city: string) =>
  `${regionId}|${district.toLocaleLowerCase('en-IN')}|${city.toLocaleLowerCase('en-IN')}`;

export function validateLocation(raw: Partial<LocationInput>): { value?: Omit<LocationInput, 'regionCode'> & { region: Region }; errors: LocationErrors } {
  const errors: LocationErrors = {};
  const region = regionByCode(String(raw.regionCode ?? ''));
  if (!region) errors.regionCode = 'Choose a state or union territory.';

  const district = cleanText(raw.district, LIMITS.place);
  const city = cleanText(raw.city, LIMITS.place);
  for (const [key, val, label] of [
    ['district', district, 'District'],
    ['city', city, 'City or town'],
  ] as const) {
    if (val.length > LIMITS.place) errors[key] = `${label} must be ${LIMITS.place} characters or fewer.`;
    else if (val && !PLACE_RE.test(val)) errors[key] = `${label} can only contain letters, numbers, spaces and . , ' ( ) & / -`;
  }

  const status = String(raw.status ?? '') as CoverageStatus;
  if (!COVERAGE_STATUSES.includes(status)) errors.status = 'Choose a coverage status.';

  const svc = [...new Set((raw.services ?? []).map(String))];
  const unknown = svc.filter((s) => !SERVICE_SLUGS.includes(s));
  if (unknown.length) errors.services = 'One or more selected services are not recognised.';

  const note = cleanText(raw.note, LIMITS.note);
  if (note.length > LIMITS.note) errors.note = `Note must be ${LIMITS.note} characters or fewer.`;
  if (/[<>]/.test(note)) errors.note = 'Note cannot contain < or >.';

  const published = Boolean(raw.published);
  if (published && status === 'unconfirmed') {
    errors.published = 'An unconfirmed location cannot be published. Set it to Available, Limited or Planned first.';
  }

  if (Object.keys(errors).length || !region) return { errors };
  return { value: { region, district, city, status, services: svc, note, published }, errors };
}

// ---------------------------------------------------------------- queries

const SELECT = `
  SELECT l.id, l.region_id AS regionId, r.code AS regionCode, r.name AS regionName, r.type AS regionType,
         l.district, l.city, l.status, l.services, l.note, l.published, l.created_at AS createdAt, l.updated_at AS updatedAt
  FROM service_locations l JOIN service_regions r ON r.id = l.region_id`;

interface Row extends Omit<Location, 'services' | 'published'> {
  services: string;
  published: number;
}

const toLocation = (r: Row): Location => ({
  ...r,
  services: (() => {
    try {
      const v = JSON.parse(r.services);
      return Array.isArray(v) ? v.filter((s) => SERVICE_SLUGS.includes(s)) : [];
    } catch {
      return [];
    }
  })(),
  published: r.published === 1,
});

export function getLocation(id: number): Location | null {
  if (!Number.isInteger(id) || id < 1) return null;
  const row = getDb().prepare(`${SELECT} WHERE l.id = ?`).get(id) as Row | undefined;
  return row ? toLocation(row) : null;
}

export interface LocationFilter {
  q?: string;
  region?: string;
  status?: string;
  visibility?: 'published' | 'unpublished' | '';
  page?: number;
  perPage?: number;
}

export function listLocations(filter: LocationFilter = {}) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const q = cleanText(filter.q, 100);
  if (q) {
    const like = `%${likeEscape(q)}%`;
    where.push("(l.district LIKE ? ESCAPE '\\' OR l.city LIKE ? ESCAPE '\\' OR r.name LIKE ? ESCAPE '\\' OR l.note LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  if (filter.region) {
    where.push('r.code = ?');
    params.push(filter.region);
  }
  if (filter.status && (COVERAGE_STATUSES as readonly string[]).includes(filter.status)) {
    where.push('l.status = ?');
    params.push(filter.status);
  }
  if (filter.visibility === 'published') where.push('l.published = 1');
  if (filter.visibility === 'unpublished') where.push('l.published = 0');

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const perPage = Math.min(Math.max(filter.perPage ?? 25, 1), 100);
  const total = (getDb().prepare(`SELECT COUNT(*) AS c FROM service_locations l JOIN service_regions r ON r.id = l.region_id ${clause}`).get(...params) as { c: number }).c;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(filter.page ?? 1, 1), pages);
  const rows = getDb()
    .prepare(`${SELECT} ${clause} ORDER BY r.sort, l.district COLLATE NOCASE, l.city COLLATE NOCASE LIMIT ? OFFSET ?`)
    .all(...params, perPage, (page - 1) * perPage) as unknown as Row[];
  return { items: rows.map(toLocation), total, page, pages, perPage };
}

/** Only published locations — the ONLY function the public page may use. */
export function listPublicLocations(): Location[] {
  const rows = getDb()
    .prepare(`${SELECT} WHERE l.published = 1 AND l.status != 'unconfirmed' ORDER BY r.sort, l.district COLLATE NOCASE, l.city COLLATE NOCASE`)
    .all() as unknown as Row[];
  return rows.map(toLocation);
}

// ---------------------------------------------------------------- mutations

export type SaveResult = { ok: true; id: number } | { ok: false; errors: LocationErrors; duplicateOf?: number };

function findDuplicate(key: string, exceptId?: number): number | null {
  const row = getDb().prepare('SELECT id FROM service_locations WHERE dedupe_key = ? AND id != ?').get(key, exceptId ?? 0) as { id: number } | undefined;
  return row?.id ?? null;
}

export function createLocation(input: Partial<LocationInput>, userId: number): SaveResult {
  const { value, errors } = validateLocation(input);
  if (!value) return { ok: false, errors };
  const key = dedupeKey(value.region.id, value.district, value.city);
  const dup = findDuplicate(key);
  if (dup) return { ok: false, errors: { form: 'This location already exists.' }, duplicateOf: dup };
  const now = nowIso();
  const res = getDb()
    .prepare(
      `INSERT INTO service_locations (region_id, district, city, status, services, note, published, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(value.region.id, value.district, value.city, value.status, JSON.stringify(value.services), value.note, value.published ? 1 : 0, key, now, now);
  const id = Number(res.lastInsertRowid);
  audit('location.create', { userId, targetType: 'location', targetId: id, detail: { status: value.status, published: value.published } });
  return { ok: true, id };
}

export function updateLocation(id: number, input: Partial<LocationInput>, userId: number): SaveResult {
  const existing = getLocation(id);
  if (!existing) return { ok: false, errors: { form: 'That location no longer exists.' } };
  const { value, errors } = validateLocation(input);
  if (!value) return { ok: false, errors };
  const key = dedupeKey(value.region.id, value.district, value.city);
  const dup = findDuplicate(key, id);
  if (dup) return { ok: false, errors: { form: 'Another entry already exists for this location.' }, duplicateOf: dup };
  getDb()
    .prepare(
      `UPDATE service_locations SET region_id = ?, district = ?, city = ?, status = ?, services = ?, note = ?, published = ?, dedupe_key = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(value.region.id, value.district, value.city, value.status, JSON.stringify(value.services), value.note, value.published ? 1 : 0, key, nowIso(), id);
  audit('location.update', { userId, targetType: 'location', targetId: id, detail: { status: value.status, published: value.published } });
  return { ok: true, id };
}

export function setPublished(id: number, published: boolean, userId: number): { ok: true } | { ok: false; error: string } {
  const loc = getLocation(id);
  if (!loc) return { ok: false, error: 'That location no longer exists.' };
  if (published && loc.status === 'unconfirmed') {
    return { ok: false, error: 'An unconfirmed location cannot be published. Change its status first.' };
  }
  getDb().prepare('UPDATE service_locations SET published = ?, updated_at = ? WHERE id = ?').run(published ? 1 : 0, nowIso(), id);
  audit(published ? 'location.publish' : 'location.unpublish', { userId, targetType: 'location', targetId: id });
  return { ok: true };
}

export function deleteLocation(id: number, userId: number): boolean {
  const res = getDb().prepare('DELETE FROM service_locations WHERE id = ?').run(id);
  if (res.changes > 0) audit('location.delete', { userId, targetType: 'location', targetId: id });
  return res.changes > 0;
}

/** Human-readable place label, most specific first. */
export function placeLabel(l: Pick<Location, 'city' | 'district' | 'regionName'>) {
  if (l.city && l.district) return `${l.city}, ${l.district} district`;
  if (l.city) return l.city;
  if (l.district) return `${l.district} district`;
  return `All of ${l.regionName}`;
}

/** Read a LocationInput from submitted form data. */
export function locationInputFromForm(form: FormData): Partial<LocationInput> {
  return {
    regionCode: String(form.get('regionCode') ?? ''),
    district: String(form.get('district') ?? ''),
    city: String(form.get('city') ?? ''),
    status: String(form.get('status') ?? ''),
    services: form.getAll('services').map(String),
    note: String(form.get('note') ?? ''),
    published: form.get('published') === 'on',
  };
}
