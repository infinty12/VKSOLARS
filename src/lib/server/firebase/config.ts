/**
 * Firebase configuration (server-only), from environment variables.
 *
 * Firebase is OFF unless FIREBASE_ENABLED=true. Nothing in the website depends on it yet; when it
 * is off or misconfigured the site keeps working exactly as before (SQLite, local uploads).
 *
 * Two kinds of values:
 * - Web app identifiers (project id, web API key, auth domain, storage bucket). These are not
 *   secrets (browsers see them in any Firebase web app), but they are kept in .env, not in code.
 * - Admin credentials. NEVER in .env values, code or chat: either a service-account JSON file kept
 *   OUTSIDE the project folder (path in FIREBASE_SERVICE_ACCOUNT_FILE), or Application Default
 *   Credentials provided by the hosting platform.
 *
 * Development and production data are separated by FIREBASE_DATA_ENV ("dev" by default). Every
 * Firestore collection and Storage path is prefixed with it, and "prod" must be chosen explicitly.
 *
 * parseFirebaseConfig() is pure (takes an env object and a file-exists check) so it can be tested.
 * Problems are DESCRIPTIONS ONLY, never the configured values.
 */
import { existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

export type FirebaseStatus = 'disabled' | 'ready' | 'misconfigured';
export type DataEnv = 'dev' | 'prod';

export interface FirebaseConfig {
  enabled: boolean;
  status: FirebaseStatus;
  problems: string[];
  projectId: string;
  /** Web API key (an identifier, used server-side for password sign-in). Never shown in the admin. */
  webApiKey: string;
  authDomain: string;
  storageBucket: string;
  dataEnv: DataEnv;
  credentials: { kind: 'service-account-file'; path: string } | { kind: 'application-default' } | { kind: 'none' };
}

type Env = Record<string, string | undefined>;

const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const API_KEY_RE = /^AIza[0-9A-Za-z_-]{35}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const bool = (v: string | undefined) => (v ?? '').trim().toLowerCase() === 'true';

export function parseFirebaseConfig(env: Env, opts: { fileExists?: (p: string) => boolean; projectRoot?: string } = {}): FirebaseConfig {
  const fileExists = opts.fileExists ?? existsSync;
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  const problems: string[] = [];
  const enabled = bool(env.FIREBASE_ENABLED);

  const projectId = (env.FIREBASE_PROJECT_ID ?? '').trim();
  if (!projectId) problems.push('FIREBASE_PROJECT_ID is missing.');
  else if (!PROJECT_ID_RE.test(projectId)) problems.push('FIREBASE_PROJECT_ID is not a valid project id.');

  const webApiKey = (env.FIREBASE_WEB_API_KEY ?? '').trim();
  if (!webApiKey) problems.push('FIREBASE_WEB_API_KEY is missing.');
  else if (!API_KEY_RE.test(webApiKey)) problems.push('FIREBASE_WEB_API_KEY does not look like a Firebase web API key.');

  const authDomain = (env.FIREBASE_AUTH_DOMAIN ?? '').trim();
  if (authDomain && !HOST_RE.test(authDomain)) problems.push('FIREBASE_AUTH_DOMAIN is not a valid host name.');

  const storageBucket = (env.FIREBASE_STORAGE_BUCKET ?? '').trim();
  if (storageBucket && !HOST_RE.test(storageBucket)) problems.push('FIREBASE_STORAGE_BUCKET is not a valid bucket name.');

  const dataEnvRaw = (env.FIREBASE_DATA_ENV ?? 'dev').trim().toLowerCase() || 'dev';
  let dataEnv: DataEnv = 'dev';
  if (dataEnvRaw === 'dev' || dataEnvRaw === 'prod') dataEnv = dataEnvRaw;
  else problems.push('FIREBASE_DATA_ENV must be "dev" or "prod".');

  // Admin credentials: a service-account file OUTSIDE the project, or Application Default Credentials.
  let credentials: FirebaseConfig['credentials'] = { kind: 'none' };
  const fileRaw = (env.FIREBASE_SERVICE_ACCOUNT_FILE ?? '').trim();
  if (fileRaw) {
    const path = resolve(fileRaw);
    const rel = relative(projectRoot, path);
    const insideProject = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    if (!isAbsolute(fileRaw)) problems.push('FIREBASE_SERVICE_ACCOUNT_FILE must be an absolute path.');
    else if (insideProject) problems.push('FIREBASE_SERVICE_ACCOUNT_FILE must be outside the project folder, so it can never be committed.');
    else if (!fileExists(path)) problems.push('FIREBASE_SERVICE_ACCOUNT_FILE does not exist.');
    else credentials = { kind: 'service-account-file', path };
  } else if (bool(env.FIREBASE_USE_APPLICATION_DEFAULT_CREDENTIALS)) {
    credentials = { kind: 'application-default' };
  } else {
    problems.push('No Admin credentials: set FIREBASE_SERVICE_ACCOUNT_FILE or FIREBASE_USE_APPLICATION_DEFAULT_CREDENTIALS=true.');
  }

  // Never mix Admin credentials into public (browser-visible) variables.
  for (const key of Object.keys(env)) {
    if (/^PUBLIC_/.test(key) && /SERVICE_ACCOUNT|PRIVATE_KEY|CLIENT_SECRET/i.test(key)) problems.push(`${key} must not hold Admin credentials (PUBLIC_ variables reach the browser).`);
  }

  const status: FirebaseStatus = !enabled ? 'disabled' : problems.length ? 'misconfigured' : 'ready';
  return { enabled, status, problems: enabled ? problems : [], projectId, webApiKey, authDomain, storageBucket, dataEnv, credentials };
}

let cached: FirebaseConfig | null = null;

export function getFirebaseConfig(): FirebaseConfig {
  cached ??= parseFirebaseConfig(process.env);
  return cached;
}

/** Reset the cached configuration (tests). */
export function resetFirebaseConfig() {
  cached = null;
}

/**
 * What an administrator may see: status, problems, project id and data environment. NEVER the API
 * key, the credentials path or anything else that identifies credentials.
 */
export function publicFirebaseStatus(config = getFirebaseConfig()) {
  return {
    status: config.status,
    problems: config.problems,
    projectId: config.status === 'disabled' ? null : config.projectId || null,
    dataEnv: config.dataEnv,
    credentials: config.credentials.kind,
  };
}

/** Namespaced Firestore collection name, e.g. "dev_customers". Keeps dev and prod data apart. */
export const collectionName = (base: string, config = getFirebaseConfig()) => {
  if (!/^[a-z][a-z0-9_]{0,60}$/.test(base)) throw new Error('invalid collection name');
  return `${config.dataEnv}_${base}`;
};

/** Namespaced Storage path, e.g. "dev/media/<file>". */
export const storagePath = (path: string, config = getFirebaseConfig()) => {
  if (!/^[a-z0-9][a-z0-9/_.-]{0,200}$/i.test(path) || path.split('/').includes('..')) throw new Error('invalid storage path');
  return `${config.dataEnv}/${path}`;
};
