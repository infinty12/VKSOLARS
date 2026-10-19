/**
 * Admin sign-in on Firebase (for the hosted website), used when ADMIN_AUTH=firebase.
 *
 * - Credentials: Firebase Authentication email/password, checked by the server.
 * - Authorisation: the account must carry the custom claim `admin: true`. Only the Admin SDK can
 *   set claims (npm run admin:grant, run by you locally); customers can never give it to themselves.
 *   The claim is re-checked on every request (cached for one minute), so revoking it takes effect.
 * - Sessions: random token in an HttpOnly, SameSite=Strict cookie; only its SHA-256 hash is stored,
 *   in Firestore, with a per-session CSRF token. 2 h idle, 12 h maximum (same as the local admin).
 * - Lockout: 5 failures per account or per address within 15 minutes lock for 15 minutes, stored in
 *   Firestore so it holds across all server instances.
 *
 * Without ADMIN_AUTH=firebase the admin keeps its local SQLite sign-in (auth.ts) unchanged.
 */
import { randomBytes, createHash } from 'node:crypto';
import { getFirebaseConfig, collectionName } from './firebase/config.ts';
import { firestore, firebaseAuth } from './firebase/admin.ts';
import { signInWithPassword } from './firebase/identity.ts';
import { SESSION, LOGIN_LIMIT } from './config.ts';
import type { Session } from './auth.ts';

export type AdminAuthMode = 'local' | 'firebase' | 'firebase-unavailable';

export function adminAuthMode(): AdminAuthMode {
  if ((process.env.ADMIN_AUTH ?? '').trim().toLowerCase() !== 'firebase') return 'local';
  return getFirebaseConfig().status === 'ready' ? 'firebase' : 'firebase-unavailable';
}

/** Admin pages that work on Firebase today; the rest still use local storage (Stage 2). */
export const FIREBASE_ADMIN_PATHS = ['/admin/login', '/admin/logout', '/admin/requests', '/admin/customers'];
export const isFirebaseAdminPath = (path: string) => FIREBASE_ADMIN_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sessions = async () => (await firestore()).collection(collectionName('admin_sessions'));
const attempts = async () => (await firestore()).collection(collectionName('admin_login_attempts'));

// ---------------------------------------------------------------- lockout

async function lockedUntil(keys: string[], now: number) {
  const col = await attempts();
  let until = 0;
  for (const key of keys) {
    const snap = await col.doc(sha256(key)).get();
    const t = Number(snap.get('lockedUntil') ?? 0);
    if (t > now) until = Math.max(until, t);
  }
  return until || null;
}

async function recordFailure(keys: string[], now: number) {
  const db = await firestore();
  const col = await attempts();
  for (const key of keys) {
    const ref = col.doc(sha256(key));
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const start = Number(snap.get('windowStart') ?? 0);
      const fresh = !snap.exists || now - start > LOGIN_LIMIT.windowMs;
      const failures = fresh ? 1 : Number(snap.get('failures') ?? 0) + 1;
      tx.set(ref, { failures, windowStart: fresh ? now : start, lockedUntil: failures >= LOGIN_LIMIT.maxFailures ? now + LOGIN_LIMIT.lockMs : 0 });
    });
  }
}

async function clearFailures(keys: string[]) {
  const col = await attempts();
  for (const key of keys) await col.doc(sha256(key)).delete();
}

// ---------------------------------------------------------------- sign-in & sessions

export type AdminSignIn = { ok: true; token: string } | { ok: false; reason: 'locked' | 'invalid' | 'unavailable' };

/** Check email + password with Firebase and require the admin claim. Generic failure: never says which part was wrong. */
export async function firebaseAdminSignIn(email: string, password: string, ip: string, userAgent: string | null, now = Date.now()): Promise<AdminSignIn> {
  const keys = [`ip:${ip}`, `user:${email.toLowerCase()}`];
  try {
    if (await lockedUntil(keys, now)) return { ok: false, reason: 'locked' };
    const result = await signInWithPassword(email, password);
    let admin = false;
    let uid = '';
    if (result.ok) {
      const decoded = await (await firebaseAuth()).verifyIdToken(result.idToken, true);
      admin = decoded.admin === true;
      uid = decoded.uid;
    } else if (result.error === 'unavailable') {
      return { ok: false, reason: 'unavailable' };
    }
    if (!admin) {
      await recordFailure(keys, now);
      return { ok: false, reason: 'invalid' };
    }
    await clearFailures(keys);
    const token = randomBytes(32).toString('base64url');
    await (await sessions()).doc(sha256(token)).create({
      uid,
      email: email.toLowerCase(),
      csrfToken: randomBytes(32).toString('base64url'),
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + SESSION.absoluteMs,
      userAgent: userAgent?.slice(0, 200) ?? null,
    });
    return { ok: true, token };
  } catch (err) {
    console.error('[admin] Firebase sign-in failed:', (err as Error).name);
    return { ok: false, reason: 'unavailable' };
  }
}

// Re-check the admin claim at most once a minute per account (revocation takes effect quickly).
const claimCache = new Map<string, { admin: boolean; at: number }>();
async function stillAdmin(uid: string, now: number) {
  const hit = claimCache.get(uid);
  if (hit && now - hit.at < 60_000) return hit.admin;
  let admin = false;
  try {
    const user = await (await firebaseAuth()).getUser(uid);
    admin = !user.disabled && user.customClaims?.admin === true;
  } catch {
    admin = false;
  }
  claimCache.set(uid, { admin, at: now });
  return admin;
}

/** Validate a session cookie (sliding idle window). Expired or no-longer-admin sessions are deleted. */
export async function readFirebaseAdminSession(token: string | undefined, now = Date.now()): Promise<Session | null> {
  if (!token || token.length > 100) return null;
  try {
    const ref = (await sessions()).doc(sha256(token));
    const snap = await ref.get();
    if (!snap.exists) return null;
    const s = snap.data() as { uid: string; email: string; csrfToken: string; lastSeenAt: number; absoluteExpiresAt: number };
    if (now - s.lastSeenAt > SESSION.idleMs || now > s.absoluteExpiresAt || !(await stillAdmin(s.uid, now))) {
      await ref.delete();
      return null;
    }
    if (now - s.lastSeenAt > 60_000) await ref.update({ lastSeenAt: now }); // avoid a write on every click
    return { user: { id: 0, username: s.email }, csrfToken: s.csrfToken, expiresAt: Math.min(now + SESSION.idleMs, s.absoluteExpiresAt) };
  } catch (err) {
    console.error('[admin] could not read the admin session:', (err as Error).name);
    return null;
  }
}

export async function deleteFirebaseAdminSession(token: string | undefined) {
  if (!token) return;
  try {
    await (await sessions()).doc(sha256(token)).delete();
  } catch {
    /* already gone */
  }
}
