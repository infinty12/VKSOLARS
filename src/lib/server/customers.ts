/**
 * Customer portal (Firebase): accounts, sessions, profiles and service requests.
 *
 * - OFF unless CUSTOMER_PORTAL_ENABLED=true AND Firebase is configured (FIREBASE_ENABLED, see
 *   firebase/config.ts). Otherwise the portal pages say it is unavailable and nothing connects.
 * - Accounts: Firebase Authentication (email/password), called from the server.
 * - Sessions: Firebase session cookies (HttpOnly, SameSite=Strict), verified with revocation
 *   checks on every request. Each form carries a CSRF token derived from the session.
 * - Roles: every customer has a server-written profile with role "customer". Browsers can never
 *   write Firestore (rules deny all), so nobody can give themselves another role. Administrators
 *   do NOT use these accounts: the admin panel keeps its own sign-in (npm run admin:create).
 * - Data: Firestore collections prefixed with the data environment (dev_/prod_). Customers only
 *   ever see their own profile and requests; internal admin notes are never shown to them.
 */
import { randomBytes } from 'node:crypto';
import type { AstroCookies } from 'astro';
import { getFirebaseConfig, collectionName } from './firebase/config.ts';
import { firestore, firebaseAuth } from './firebase/admin.ts';
import { sign, safeEqual } from './secret.ts';
import { setStrictCookie } from './http.ts';
import { REGIONS } from './regions.ts';
import { services } from '../../data/services.ts';

const flag = (v: string | undefined) => (v ?? '').trim().toLowerCase() === 'true';

export const CUSTOMER_COOKIE = 'vk_customer_session';
export const PORTAL_CSRF_COOKIE = 'vk_portal_csrf';
export const SESSION_DAYS = 5;

/** Whether customers can register, sign in and submit requests. */
export function portalStatus(): { open: boolean; reason: 'ok' | 'switched_off' | 'firebase_not_ready' } {
  if (!flag(process.env.CUSTOMER_PORTAL_ENABLED)) return { open: false, reason: 'switched_off' };
  if (getFirebaseConfig().status !== 'ready') return { open: false, reason: 'firebase_not_ready' };
  return { open: true, reason: 'ok' };
}

// ---------------------------------------------------------------- request types & statuses

export const REQUEST_TYPES = [{ value: 'free-inspection', label: 'Free solar inspection' }, ...services.map((s) => ({ value: s.slug, label: s.title }))];
const REQUEST_TYPE_VALUES = new Set(REQUEST_TYPES.map((t) => t.value));
export const requestTypeLabel = (v: string) => REQUEST_TYPES.find((t) => t.value === v)?.label ?? v;

export const REQUEST_STATUSES = ['submitted', 'reviewing', 'scheduled', 'in_progress', 'completed', 'cancelled'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  submitted: 'Submitted',
  reviewing: 'Under review',
  scheduled: 'Visit scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
export const isRequestStatus = (s: unknown): s is RequestStatus => (REQUEST_STATUSES as readonly unknown[]).includes(s);

// ---------------------------------------------------------------- validation

const clean = (v: unknown, max: number) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max + 1);
const cleanMulti = (v: unknown, max: number) =>
  String(v ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max + 1);

export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const REGION_CODES = new Set(REGIONS.map((r) => r.code));
export const regionName = (code: string) => REGIONS.find((r) => r.code === code)?.name ?? '';

export interface Profile {
  name: string;
  phone: string;
  city: string;
  region: string;
}
export type Errors = Record<string, string>;

export function validateProfile(input: Record<string, unknown>): { ok: true; value: Profile } | { ok: false; errors: Errors; value: Profile } {
  const value: Profile = {
    name: clean(input.name, 80),
    phone: clean(input.phone, 20),
    city: clean(input.city, 80),
    region: clean(input.region, 10),
  };
  const errors: Errors = {};
  if (value.name.length < 2 || value.name.length > 80) errors.name = 'Enter your full name (2–80 characters).';
  const digits = value.phone.replace(/[\s()+-]/g, '');
  if (!/^\d{10,13}$/.test(digits)) errors.phone = 'Enter a phone number with 10–13 digits.';
  if (value.city.length > 80) errors.city = 'Keep the city to 80 characters.';
  if (value.region && !REGION_CODES.has(value.region)) errors.region = 'Choose a state or union territory from the list.';
  return Object.keys(errors).length ? { ok: false, errors, value } : { ok: true, value };
}

export interface RequestInput {
  type: string;
  location: string;
  region: string;
  systemSize: string;
  message: string;
}

export function validateRequest(input: Record<string, unknown>): { ok: true; value: RequestInput } | { ok: false; errors: Errors; value: RequestInput } {
  const value: RequestInput = {
    type: clean(input.type, 60),
    location: clean(input.location, 120),
    region: clean(input.region, 10),
    systemSize: clean(input.systemSize, 40),
    message: cleanMulti(input.message, 1000),
  };
  const errors: Errors = {};
  if (!REQUEST_TYPE_VALUES.has(value.type)) errors.type = 'Choose the service you need.';
  if (value.location.length < 2 || value.location.length > 120) errors.location = 'Enter the site location (town or city, 2–120 characters).';
  if (!REGION_CODES.has(value.region)) errors.region = 'Choose the state or union territory.';
  if (value.systemSize.length > 40) errors.systemSize = 'Keep this to 40 characters.';
  if (value.message.length > 1000) errors.message = 'Keep the details to 1000 characters.';
  return Object.keys(errors).length ? { ok: false, errors, value } : { ok: true, value };
}

export function validateCredentials(input: Record<string, unknown>, mode: 'login' | 'register'): Errors {
  const errors: Errors = {};
  const email = clean(input.email, 254).toLowerCase();
  const password = String(input.password ?? '');
  if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';
  if (mode === 'register') {
    if (password.length < 8 || password.length > 128) errors.password = 'Use 8–128 characters for your password.';
    else if (password !== String(input.confirm ?? '')) errors.confirm = 'The passwords do not match.';
  } else if (!password) errors.password = 'Enter your password.';
  return errors;
}

// ---------------------------------------------------------------- sessions & CSRF

export interface CustomerSession {
  uid: string;
  email: string;
  /** Per-session CSRF token for this customer's forms. */
  csrf: string;
}

/** Exchange a fresh ID token for a session cookie and set it. */
export async function startSession(cookies: AstroCookies, url: URL, idToken: string) {
  const expiresIn = SESSION_DAYS * 24 * 60 * 60 * 1000;
  const cookie = await (await firebaseAuth()).createSessionCookie(idToken, { expiresIn });
  setStrictCookie(cookies, url, CUSTOMER_COOKIE, cookie, { maxAgeSec: expiresIn / 1000 });
}

/** The signed-in customer, or null. Verifies the cookie (including revocation) and the profile role. */
export async function readCustomer(cookies: AstroCookies): Promise<CustomerSession | null> {
  if (!portalStatus().open) return null;
  const value = cookies.get(CUSTOMER_COOKIE)?.value;
  if (!value || value.length > 4096) return null;
  try {
    const decoded = await (await firebaseAuth()).verifySessionCookie(value, true);
    const profile = await (await firestore()).collection(collectionName('customers')).doc(decoded.uid).get();
    if (!profile.exists || profile.get('role') !== 'customer' || profile.get('disabled') === true) return null;
    return { uid: decoded.uid, email: String(decoded.email ?? profile.get('email') ?? ''), csrf: sign(`portal:${decoded.uid}:${decoded.auth_time}`) };
  } catch {
    return null;
  }
}

export const checkCsrf = (session: CustomerSession, token: unknown) => typeof token === 'string' && token.length > 0 && safeEqual(token, session.csrf);

/** Double-submit token for the sign-in and registration forms (no session yet). */
export function issueFormCsrf(cookies: AstroCookies, url: URL) {
  const token = randomBytes(24).toString('base64url');
  setStrictCookie(cookies, url, PORTAL_CSRF_COOKIE, token, { maxAgeSec: 1800 });
  return token;
}
export const checkFormCsrf = (cookies: AstroCookies, token: unknown) => {
  const cookie = cookies.get(PORTAL_CSRF_COOKIE)?.value ?? '';
  return typeof token === 'string' && !!cookie && safeEqual(token, cookie);
};

/** Sign out: clear the cookie and revoke the customer's Firebase sessions everywhere. */
export async function endSession(cookies: AstroCookies, session: CustomerSession | null) {
  cookies.delete(CUSTOMER_COOKIE, { path: '/' });
  if (session) await (await firebaseAuth()).revokeRefreshTokens(session.uid).catch(() => undefined);
}

// ---------------------------------------------------------------- profiles

const customers = async () => (await firestore()).collection(collectionName('customers'));
const requests = async () => (await firestore()).collection(collectionName('requests'));
const now = () => new Date().toISOString();

export interface CustomerRecord extends Profile {
  uid: string;
  email: string;
  createdAt: string;
  updatedAt: string;
  requestCount: number;
}

/** Exact wording of the registration consent checkbox (stored with each account). */
export const REGISTRATION_CONSENT_TEXT =
  'I have read the Privacy Notice and agree to VK Solar using my name, email address, phone number and location to create my account, manage my service requests and contact me about them.';

/** Create the profile for a newly registered account. Role is always "customer". */
export async function createProfile(uid: string, email: string, profile: Profile) {
  const ts = now();
  await (await customers()).doc(uid).create({
    ...profile,
    email,
    role: 'customer',
    disabled: false,
    requestCount: 0,
    consentText: REGISTRATION_CONSENT_TEXT,
    consentAt: ts,
    createdAt: ts,
    updatedAt: ts,
  });
}

export async function getProfile(uid: string): Promise<CustomerRecord | null> {
  const snap = await (await customers()).doc(uid).get();
  if (!snap.exists) return null;
  const d = snap.data()!;
  return { uid, email: String(d.email ?? ''), name: String(d.name ?? ''), phone: String(d.phone ?? ''), city: String(d.city ?? ''), region: String(d.region ?? ''), createdAt: String(d.createdAt ?? ''), updatedAt: String(d.updatedAt ?? ''), requestCount: Number(d.requestCount ?? 0) };
}

/** Update only the editable profile fields (never role, email or flags). */
export async function updateProfile(uid: string, profile: Profile) {
  await (await customers()).doc(uid).update({ ...profile, updatedAt: now() });
}

// ---------------------------------------------------------------- requests

export interface StatusChange {
  status: RequestStatus;
  at: string;
}

export interface ServiceRequest {
  id: string;
  reference: string;
  uid: string;
  type: string;
  location: string;
  region: string;
  systemSize: string;
  message: string;
  status: RequestStatus;
  history: StatusChange[];
  createdAt: string;
  updatedAt: string;
}

const toRequest = (id: string, d: FirebaseFirestore.DocumentData): ServiceRequest => ({
  id,
  reference: String(d.reference ?? ''),
  uid: String(d.uid ?? ''),
  type: String(d.type ?? ''),
  location: String(d.location ?? ''),
  region: String(d.region ?? ''),
  systemSize: String(d.systemSize ?? ''),
  message: String(d.message ?? ''),
  status: isRequestStatus(d.status) ? d.status : 'submitted',
  history: Array.isArray(d.history) ? (d.history as StatusChange[]).filter((h) => isRequestStatus(h?.status)).slice(-20) : [],
  createdAt: String(d.createdAt ?? ''),
  updatedAt: String(d.updatedAt ?? ''),
});

const newReference = () => {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `REQ-${ymd}-${randomBytes(3).toString('hex').toUpperCase()}`;
};

/** At most this many requests per customer per day (spam protection). */
export const DAILY_REQUEST_LIMIT = 5;

export async function createRequest(uid: string, input: RequestInput): Promise<{ ok: true; request: ServiceRequest } | { ok: false; reason: 'limit' }> {
  const db = await firestore();
  const col = await requests();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recent = await col.where('uid', '==', uid).where('createdAt', '>=', dayAgo).count().get();
  if (recent.data().count >= DAILY_REQUEST_LIMIT) return { ok: false, reason: 'limit' };
  const ts = now();
  const ref = col.doc();
  const data = { ...input, uid, reference: newReference(), status: 'submitted', history: [{ status: 'submitted', at: ts }], createdAt: ts, updatedAt: ts };
  await db.runTransaction(async (tx) => {
    tx.create(ref, data);
    tx.update((await customers()).doc(uid), { requestCount: (await import('firebase-admin/firestore')).FieldValue.increment(1), updatedAt: ts });
  });
  return { ok: true, request: toRequest(ref.id, data) };
}

/** A customer's own requests, newest first. */
export async function listOwnRequests(uid: string, limit = 50): Promise<ServiceRequest[]> {
  const snap = await (await requests()).where('uid', '==', uid).orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map((d) => toRequest(d.id, d.data()));
}

/** Customers may cancel their own request while it has not started. */
export async function cancelOwnRequest(uid: string, id: string): Promise<boolean> {
  if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return false;
  const db = await firestore();
  const ref = (await requests()).doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('uid') !== uid || !['submitted', 'reviewing'].includes(snap.get('status'))) return false;
    const ts = now();
    tx.update(ref, { status: 'cancelled', updatedAt: ts, history: [...(snap.get('history') ?? []), { status: 'cancelled', at: ts }].slice(-20) });
    return true;
  });
}

// ---------------------------------------------------------------- admin (callers must be signed-in admins)

export async function adminListCustomers(opts: { after?: string; limit?: number } = {}) {
  let q = (await customers()).orderBy('createdAt', 'desc').limit(opts.limit ?? 50);
  if (opts.after) q = q.startAfter(opts.after);
  const snap = await q.get();
  return snap.docs.map((d) => {
    const x = d.data();
    return { uid: d.id, email: String(x.email ?? ''), name: String(x.name ?? ''), phone: String(x.phone ?? ''), city: String(x.city ?? ''), region: String(x.region ?? ''), createdAt: String(x.createdAt ?? ''), requestCount: Number(x.requestCount ?? 0), disabled: x.disabled === true };
  });
}

export async function adminListRequests(opts: { status?: RequestStatus | null; uid?: string | null; after?: string; limit?: number } = {}) {
  let q: FirebaseFirestore.Query = await requests();
  if (opts.status) q = q.where('status', '==', opts.status);
  if (opts.uid) q = q.where('uid', '==', opts.uid);
  q = q.orderBy('createdAt', 'desc').limit(opts.limit ?? 50);
  if (opts.after) q = q.startAfter(opts.after);
  const snap = await q.get();
  return snap.docs.map((d) => toRequest(d.id, d.data()));
}

export async function adminGetRequest(id: string) {
  if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return null;
  const snap = await (await requests()).doc(id).get();
  if (!snap.exists) return null;
  const request = toRequest(snap.id, snap.data()!);
  const customer = await getProfile(request.uid);
  const notesSnap = await snap.ref.collection('notes').orderBy('createdAt', 'asc').limit(100).get();
  const notes = notesSnap.docs.map((n) => ({ body: String(n.get('body') ?? ''), author: String(n.get('author') ?? ''), createdAt: String(n.get('createdAt') ?? '') }));
  return { request, customer, notes };
}

export async function adminSetStatus(id: string, status: RequestStatus) {
  const db = await firestore();
  const ref = (await requests()).doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    if (snap.get('status') === status) return true;
    const ts = now();
    tx.update(ref, { status, updatedAt: ts, history: [...(snap.get('history') ?? []), { status, at: ts }].slice(-20) });
    return true;
  });
}

export const NOTE_MAX = 2000;
/** Internal note, visible to administrators only. */
export async function adminAddNote(id: string, body: string, author: string) {
  const text = cleanMulti(body, NOTE_MAX);
  if (!text || text.length > NOTE_MAX) return false;
  const ref = (await requests()).doc(id);
  if (!(await ref.get()).exists) return false;
  await ref.collection('notes').add({ body: text, author, createdAt: now() });
  return true;
}
