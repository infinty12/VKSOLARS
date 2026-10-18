/** Backup / restore against disposable storage and backup folders. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const base = mkdtempSync(join(tmpdir(), 'vk-unit-test-backup-'));
const storage = join(base, 'test-storage');
const backups = join(base, 'test-backups');
process.env.STORAGE_DIR = storage;
process.env.BACKUP_DIR = backups;

const { getDb, closeDb } = await import('../../src/lib/server/db.ts');
const B = await import('../../src/lib/server/backup.ts');
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = await import('../../src/lib/server/migrations.ts');

after(() => {
  closeDb();
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const now = () => new Date().toISOString();
function addEnquiry(name: string) {
  getDb()
    .prepare("INSERT INTO enquiries (reference, created_at, updated_at, name, phone, service, location, consent, consent_text) VALUES (?, ?, ?, ?, '9876543210', 'ac-service', 'Panaji', 1, 't')")
    .run(`ENQ-20261018-${createHash('md5').update(name).digest('hex').slice(0, 6).toUpperCase()}`, now(), now(), name);
}
const enquiryNames = () => (getDb().prepare('SELECT name FROM enquiries ORDER BY id').all() as { name: string }[]).map((r) => r.name);
const uploadsDir = join(storage, 'uploads');

test('backup contains a verified DB copy, uploads and a checksummed manifest — and never secrets', async () => {
  addEnquiry('Before Backup');
  mkdirSync(uploadsDir, { recursive: true });
  writeFileSync(join(uploadsDir, '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b.webp'), 'fake-webp-bytes');
  writeFileSync(join(storage, 'secret.key'), 'do-not-back-me-up');
  mkdirSync(join(storage, 'mail-outbox'), { recursive: true });
  writeFileSync(join(storage, 'mail-outbox', 'm.json'), '{}');

  const b = await B.createBackup();
  assert.match(b.name, /^backup-\d{8}-\d{6}-\d{3}$/);
  assert.equal(b.manifest!.counts.enquiries, 1);
  assert.equal(b.manifest!.counts.uploads, 1);
  assert.equal(b.manifest!.schemaVersion, LATEST_SCHEMA_VERSION);
  const paths = b.manifest!.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['uploads/3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b.webp', 'vk-solar.db']);
  assert.ok(!existsSync(join(b.path, 'secret.key')) && !existsSync(join(b.path, 'mail-outbox')));
  assert.deepEqual(B.verifyBackup(b.name), { ok: true, problems: [], manifest: b.manifest });
  assert.equal(readdirSync(backups).some((n) => n.endsWith('.partial')), false, 'no partial folders left behind');
});

test('backup taken while writes are happening is consistent', async () => {
  const writes = Array.from({ length: 50 }, (_, i) => i);
  const [b] = await Promise.all([B.createBackup(), (async () => writes.forEach((i) => addEnquiry(`Concurrent ${i}`)))()]);
  const r = B.verifyBackup(b.name);
  assert.ok(r.ok, r.problems.join('; '));
});

test('backups started at the same moment get separate folders', async () => {
  const all = await Promise.all([B.createBackup(), B.createBackup(), B.createBackup()]);
  assert.equal(new Set(all.map((b) => b.name)).size, 3);
  for (const b of all) assert.ok(B.verifyBackup(b.name).ok, b.name);
});

test('a tampered database, manifest or upload fails verification, and restore changes nothing', async () => {
  const good = await B.createBackup();
  const before = enquiryNames();

  // Flip a byte in the database copy.
  const dbFile = join(good.path, 'vk-solar.db');
  const bytes = readFileSync(dbFile);
  bytes[bytes.length - 100] ^= 0xff;
  writeFileSync(dbFile, bytes);
  const r1 = B.verifyBackup(good.name);
  assert.equal(r1.ok, false);
  assert.ok(r1.problems.some((p) => /Checksum mismatch: vk-solar\.db/.test(p)), r1.problems.join('; '));
  await assert.rejects(B.restoreBackup(good.name), /failed verification, nothing was changed/);
  assert.deepEqual(enquiryNames(), before);

  // Extra file planted in a backup.
  const b2 = await B.createBackup();
  writeFileSync(join(b2.path, 'evil.js'), 'alert(1)');
  assert.ok(B.verifyBackup(b2.name).problems.some((p) => /Unexpected file not in manifest: evil\.js/.test(p)));

  // Manifest pointing outside the backup folder.
  const b3 = await B.createBackup();
  const m = JSON.parse(readFileSync(join(b3.path, 'manifest.json'), 'utf8'));
  m.files.push({ path: '../../storage/vk-solar.db', bytes: 1, sha256: 'x' });
  writeFileSync(join(b3.path, 'manifest.json'), JSON.stringify(m));
  assert.ok(B.verifyBackup(b3.name).problems.includes('Manifest lists an unsafe file path.'));

  // Missing manifest.
  const b4 = await B.createBackup();
  rmSync(join(b4.path, 'manifest.json'));
  assert.deepEqual(B.verifyBackup(b4.name).problems, ['manifest.json is missing or unreadable.']);
});

test('a backup from a newer schema is refused', async () => {
  const b = await B.createBackup();
  const m = JSON.parse(readFileSync(join(b.path, 'manifest.json'), 'utf8'));
  m.schemaVersion = LATEST_SCHEMA_VERSION + 1;
  writeFileSync(join(b.path, 'manifest.json'), JSON.stringify(m));
  const r = B.verifyBackup(b.name);
  assert.ok(r.problems.some((p) => /newer version of the site/.test(p)), r.problems.join('; '));
});

test('backup names are allow-listed (no traversal)', () => {
  for (const bad of ['../storage', '..\\storage', 'backup-20261018-120000-000/../../x', 'C:\\backup-20261018-120000-000', 'backup-2026', '', '.']) {
    assert.equal(B.backupPath(bad), null, bad);
  }
  assert.ok(B.backupPath('backup-20261018-120000-000'));
  assert.equal(B.verifyBackup('../../etc').ok, false);
});

test('restore round trip: data and uploads come back, current data is kept as a safety backup', async () => {
  const snapshot = await B.createBackup();
  const atBackup = enquiryNames();
  addEnquiry('Added After Backup');
  writeFileSync(join(uploadsDir, '11111111-2222-4333-8444-555555555555.webp'), 'new-upload');

  const r = await B.restoreBackup(snapshot.name);
  assert.equal(r.restored, snapshot.name);
  assert.match(r.safetyBackup!, /-safety$/);
  assert.deepEqual(enquiryNames(), atBackup, 'data is back to the backup');
  assert.deepEqual(readdirSync(uploadsDir), ['3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b.webp'], 'uploads match the backup');

  // The safety backup holds what was there before the restore — so the restore can be undone.
  const safety = B.verifyBackup(r.safetyBackup!);
  assert.ok(safety.ok, safety.problems.join('; '));
  assert.equal(safety.manifest!.counts.enquiries, atBackup.length + 1);
  await B.restoreBackup(r.safetyBackup!);
  assert.ok(enquiryNames().includes('Added After Backup'));
});

test('restore refuses while the server is running', async () => {
  const b = await B.createBackup();
  writeFileSync(join(storage, 'server.pid'), String(process.pid)); // a live process
  try {
    assert.equal(B.serverRunning().running, true);
    await assert.rejects(B.restoreBackup(b.name), /server is running/);
  } finally {
    rmSync(join(storage, 'server.pid'));
  }
  writeFileSync(join(storage, 'server.pid'), '999999'); // stale pid: not running
  assert.equal(B.serverRunning().running, false);
  rmSync(join(storage, 'server.pid'));
});

test('an older-schema backup is restored and migrated up to the current schema', async () => {
  // Build a valid backup folder by hand from a schema-v3 database.
  const name = 'backup-20250101-000000-000';
  const folder = join(backups, name);
  mkdirSync(folder, { recursive: true });
  const dbFile = join(folder, 'vk-solar.db');
  const old = new DatabaseSync(dbFile);
  old.exec('PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.filter((x) => x.id <= 3)) {
    old.exec(m.sql);
    old.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.id, m.name, 'x');
  }
  old.prepare("INSERT INTO enquiries (reference, created_at, updated_at, name, phone, service, location, consent, consent_text) VALUES ('ENQ-20250101-AAAAAA', ?, ?, 'Old Schema Person', '9876543210', 'ac-service', 'X', 1, 't')").run(now(), now());
  old.close();
  const buf = readFileSync(dbFile);
  writeFileSync(
    join(folder, 'manifest.json'),
    JSON.stringify({
      format: 'vk-solar-backup',
      formatVersion: 1,
      createdAt: now(),
      kind: 'manual',
      schemaVersion: 3,
      counts: { enquiries: 1, locations: 0, admins: 0, uploads: 0 },
      files: [{ path: 'vk-solar.db', bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }],
    }),
  );
  assert.ok(B.verifyBackup(name).ok, B.verifyBackup(name).problems.join('; '));
  const r = await B.restoreBackup(name);
  assert.equal(r.migratedFrom, 3);
  assert.equal(r.migratedTo, LATEST_SCHEMA_VERSION);
  assert.deepEqual(enquiryNames(), ['Old Schema Person']);
  const tables = (getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
  assert.ok(tables.includes('notification_outbox'), 'migration 5 applied');
});

test('prune keeps the newest N manual backups and never deletes safety backups', async () => {
  for (let i = 0; i < 3; i++) await B.createBackup();
  const before = B.listBackups();
  const safetyBefore = before.filter((b) => b.name.endsWith('-safety')).map((b) => b.name);
  const manualBefore = before.filter((b) => !b.name.endsWith('-safety'));
  const removed = B.pruneBackups(2);
  const after = B.listBackups();
  assert.equal(after.filter((b) => !b.name.endsWith('-safety')).length, 2);
  assert.deepEqual(after.filter((b) => b.name.endsWith('-safety')).map((b) => b.name), safetyBefore);
  assert.equal(removed.length, manualBefore.length - 2);
  assert.throws(() => B.pruneBackups(0), /at least 1/);
});
