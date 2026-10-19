/**
 * Firebase Admin SDK access (server-only). Loaded lazily: if Firebase is disabled or
 * misconfigured, firebase-admin is never imported and nothing connects to Google.
 *
 * The Admin SDK bypasses Firestore/Storage security rules, so every caller must do its own
 * authorization checks (as the existing admin code does for SQLite).
 */
import { getFirebaseConfig, type FirebaseConfig } from './config.ts';

export class FirebaseUnavailableError extends Error {
  constructor(status: string) {
    super(`Firebase is not available (${status}).`);
    this.name = 'FirebaseUnavailableError';
  }
}

type AdminApp = import('firebase-admin/app').App;
let appPromise: Promise<AdminApp> | null = null;

async function initApp(config: FirebaseConfig): Promise<AdminApp> {
  const { initializeApp, getApps, cert, applicationDefault } = await import('firebase-admin/app');
  const existing = getApps().find((a) => a.name === 'vk-solar');
  if (existing) return existing;
  const c = config.credentials;
  const credential =
    c.kind === 'service-account-file'
      ? cert(c.path)
      : c.kind === 'service-account-json'
        ? cert({ projectId: c.account.project_id, clientEmail: c.account.client_email, privateKey: c.account.private_key })
        : applicationDefault();
  return initializeApp(
    { credential, projectId: config.projectId, ...(config.storageBucket ? { storageBucket: config.storageBucket } : {}) },
    'vk-solar',
  );
}

/** The Admin app, or a FirebaseUnavailableError if Firebase is off or misconfigured. */
export function firebaseApp(config = getFirebaseConfig()): Promise<AdminApp> {
  if (config.status !== 'ready') return Promise.reject(new FirebaseUnavailableError(config.status));
  appPromise ??= initApp(config).catch((err) => {
    appPromise = null; // allow a retry after fixing configuration
    throw err;
  });
  return appPromise;
}

export async function firestore() {
  const { getFirestore } = await import('firebase-admin/firestore');
  return getFirestore(await firebaseApp());
}

export async function firebaseAuth() {
  const { getAuth } = await import('firebase-admin/auth');
  return getAuth(await firebaseApp());
}

export async function storageBucket() {
  const config = getFirebaseConfig();
  if (!config.storageBucket) throw new FirebaseUnavailableError('no storage bucket configured');
  const { getStorage } = await import('firebase-admin/storage');
  return getStorage(await firebaseApp()).bucket(config.storageBucket);
}
