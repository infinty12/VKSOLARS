/** Firebase configuration parsing: off by default, never leaks values, keeps credentials out of the project. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFirebaseConfig, publicFirebaseStatus, collectionName, storagePath } from '../../src/lib/server/firebase/config.ts';

const ROOT = 'C:\\project\\vk-solar';
const OUTSIDE = 'C:\\secure\\vk-solar-admin.json';
// Fictitious identifiers in the right shape (not the real project's values).
const base = {
  FIREBASE_ENABLED: 'true',
  FIREBASE_PROJECT_ID: 'example-project-1',
  FIREBASE_WEB_API_KEY: `AIza${'x'.repeat(35)}`,
  FIREBASE_AUTH_DOMAIN: 'example-project-1.firebaseapp.com',
  FIREBASE_STORAGE_BUCKET: 'example-project-1.firebasestorage.app',
  FIREBASE_SERVICE_ACCOUNT_FILE: OUTSIDE,
};
const parse = (env: Record<string, string | undefined>, exists = true) => parseFirebaseConfig(env, { projectRoot: ROOT, fileExists: () => exists });

test('off by default: no problems reported, nothing required', () => {
  const c = parse({});
  assert.equal(c.status, 'disabled');
  assert.deepEqual(c.problems, []);
  assert.equal(c.dataEnv, 'dev');
  assert.equal(parse({ ...base, FIREBASE_ENABLED: 'yes' }).status, 'disabled', 'only exactly "true" enables');
});

test('a complete configuration with an outside credentials file is ready', () => {
  const c = parse(base);
  assert.equal(c.status, 'ready', JSON.stringify(c.problems));
  assert.deepEqual(c.credentials, { kind: 'service-account-file', path: OUTSIDE });
  assert.equal(parse({ ...base, FIREBASE_SERVICE_ACCOUNT_FILE: '', FIREBASE_USE_APPLICATION_DEFAULT_CREDENTIALS: 'true' }).credentials.kind, 'application-default');
});

test('credentials file must be absolute, outside the project, and exist', () => {
  const probs = (env: Record<string, string>, exists = true) => parse({ ...base, ...env }, exists).problems.join(' ');
  assert.match(probs({ FIREBASE_SERVICE_ACCOUNT_FILE: 'key.json' }), /absolute path/);
  assert.match(probs({ FIREBASE_SERVICE_ACCOUNT_FILE: `${ROOT}\\secrets\\key.json` }), /outside the project folder/);
  assert.match(probs({ FIREBASE_SERVICE_ACCOUNT_FILE: ROOT }), /outside the project folder/);
  assert.match(probs({}, false), /does not exist/);
  assert.match(probs({ FIREBASE_SERVICE_ACCOUNT_FILE: '' }), /No Admin credentials/);
});

test('invalid identifiers are reported without echoing the values', () => {
  const secretish = 'not-a-key-but-SECRET-VALUE';
  const c = parse({ ...base, FIREBASE_PROJECT_ID: 'Bad_ID!', FIREBASE_WEB_API_KEY: secretish, FIREBASE_AUTH_DOMAIN: 'bad host', FIREBASE_DATA_ENV: 'staging' });
  assert.equal(c.status, 'misconfigured');
  assert.equal(c.problems.length, 4);
  assert.ok(!c.problems.join(' ').includes(secretish));
  assert.ok(!c.problems.join(' ').includes('Bad_ID!'));
});

test('a service-account key in a secret variable (raw or base64) is accepted for hosting without files', () => {
  // Fictitious key material, right shape only.
  const key = { type: 'service_account', project_id: 'example-project-1', client_email: 'x@example-project-1.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' };
  const env = { ...base, FIREBASE_SERVICE_ACCOUNT_FILE: '' };
  for (const value of [JSON.stringify(key), Buffer.from(JSON.stringify(key)).toString('base64')]) {
    const c = parse({ ...env, FIREBASE_SERVICE_ACCOUNT_JSON: value });
    assert.equal(c.status, 'ready', JSON.stringify(c.problems));
    assert.equal(c.credentials.kind, 'service-account-json');
  }
  const wrongProject = parse({ ...env, FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...key, project_id: 'other-project-9' }) });
  assert.match(wrongProject.problems.join(' '), /different project/);
  const junk = parse({ ...env, FIREBASE_SERVICE_ACCOUNT_JSON: 'SECRET-LOOKING-JUNK' });
  assert.match(junk.problems.join(' '), /not a valid service-account key/);
  assert.ok(!junk.problems.join(' ').includes('SECRET-LOOKING-JUNK'), 'value never echoed');
  assert.ok(!JSON.stringify(publicFirebaseStatus(parse({ ...env, FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(key) }))).includes('PRIVATE KEY'), 'never shown');
});

test('Admin credentials are refused in PUBLIC_ (browser-visible) variables', () => {
  const c = parse({ ...base, PUBLIC_FIREBASE_SERVICE_ACCOUNT: '{}', PUBLIC_FIREBASE_PROJECT_ID: 'ok' });
  assert.equal(c.status, 'misconfigured');
  assert.equal(c.problems.length, 1);
  assert.match(c.problems[0], /PUBLIC_FIREBASE_SERVICE_ACCOUNT/);
});

test('the admin-visible status never contains the API key or credentials path', () => {
  const s = JSON.stringify(publicFirebaseStatus(parse(base)));
  assert.ok(!s.includes(base.FIREBASE_WEB_API_KEY));
  assert.ok(!s.includes('vk-solar-admin.json'));
  assert.match(s, /"credentials":"service-account-file"/);
  assert.equal(publicFirebaseStatus(parse({})).projectId, null, 'nothing shown while disabled');
});

test('dev and prod data are namespaced; prod only when chosen explicitly', () => {
  const dev = parse(base);
  const prod = parse({ ...base, FIREBASE_DATA_ENV: 'prod' });
  assert.equal(collectionName('customers', dev), 'dev_customers');
  assert.equal(collectionName('customers', prod), 'prod_customers');
  assert.equal(storagePath('media/a.webp', dev), 'dev/media/a.webp');
  for (const bad of ['../x', 'Customers', 'a/b', '']) assert.throws(() => collectionName(bad, dev), bad);
  for (const bad of ['../secret', 'media/../../x', '/abs']) assert.throws(() => storagePath(bad, dev), bad);
});

test('security rules deny every client request', () => {
  for (const file of ['firestore.rules', 'storage.rules']) {
    const rules = readFileSync(file, 'utf8');
    assert.match(rules, /allow read, write: if false;/, file);
    assert.doesNotMatch(rules.replace(/\/\/.*$/gm, ''), /if true|allow read;|allow write;|allow read, write;/, `${file} grants access`);
  }
});

test('the website itself does not import Firebase (it stays optional)', () => {
  const site = ['src/middleware.ts', 'src/layouts/BaseLayout.astro', 'src/layouts/AdminLayout.astro', 'src/pages/index.astro', 'src/pages/contact.astro'];
  for (const f of site) assert.doesNotMatch(readFileSync(f, 'utf8'), /firebase/i, f);
});
