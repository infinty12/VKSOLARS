// Starts the BUILT server against an isolated storage directory, for tests.
//   STORAGE_DIR (default ./test-storage) is WIPED on every start — never point it at real data.
//   KEEP_STORAGE=true reuses the existing test storage instead (used to test persistence across
//   a restart); the folder-name safety check still applies.
//   A test administrator with a random password is created and written to
//   <STORAGE_DIR>/test-admin.json for the test suite to read. Nothing is hardcoded.
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

const storage = resolve(process.env.STORAGE_DIR || 'test-storage');
if (!/test|tmp|temp|snapshot/i.test(basename(storage))) {
  console.error(`Refusing to use "${storage}": test storage folder name must contain "test", "tmp", "temp" or "snapshot".`);
  process.exit(1);
}
if (!existsSync(resolve('dist/server/entry.mjs'))) {
  console.error('No build found. Run "npm run build" first.');
  process.exit(1);
}

const keep = (process.env.KEEP_STORAGE ?? '').toLowerCase() === 'true' && existsSync(join(storage, 'test-admin.json'));
if (!keep) {
  rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  mkdirSync(storage, { recursive: true });
}
process.env.STORAGE_DIR = storage;

const { getDb } = await import('../src/lib/server/db.ts');
getDb();
// Test-only: pre-enable the admin "Accept enquiries" switch (the ENQUIRIES_ENABLED server switch
// must still be set separately). Only reachable here, behind the test-folder-name check above.
if ((process.env.TEST_ACCEPT_ENQUIRIES ?? '').toLowerCase() === 'true') {
  const { setSetting } = await import('../src/lib/server/settings.ts');
  setSetting('enquiries.accept', true);
}
if (!keep) {
  const { createAdmin } = await import('../src/lib/server/auth.ts');
  const credentials = { username: 'test-admin', password: randomBytes(18).toString('base64url') };
  createAdmin(credentials.username, credentials.password);
  writeFileSync(join(storage, 'test-admin.json'), JSON.stringify(credentials));
}

await import('../server.mjs');
