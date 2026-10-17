// Starts the BUILT server against an isolated, freshly-reset storage directory, for tests.
//   STORAGE_DIR (default ./test-storage) is WIPED on every start — never point it at real data.
//   A test administrator with a random password is created and written to
//   <STORAGE_DIR>/test-admin.json for the test suite to read. Nothing is hardcoded.
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

const storage = resolve(process.env.STORAGE_DIR || 'test-storage');
if (!/test|tmp|temp|snapshot/i.test(basename(storage))) {
  console.error(`Refusing to wipe "${storage}": test storage folder name must contain "test", "tmp", "temp" or "snapshot".`);
  process.exit(1);
}
if (!existsSync(resolve('dist/server/entry.mjs'))) {
  console.error('No build found. Run "npm run build" first.');
  process.exit(1);
}

rmSync(storage, { recursive: true, force: true });
mkdirSync(storage, { recursive: true });
process.env.STORAGE_DIR = storage;

const { getDb } = await import('../src/lib/server/db.ts');
const { createAdmin } = await import('../src/lib/server/auth.ts');
getDb();
const credentials = { username: 'test-admin', password: randomBytes(18).toString('base64url') };
createAdmin(credentials.username, credentials.password);
writeFileSync(join(storage, 'test-admin.json'), JSON.stringify(credentials));

await import('../server.mjs');
