/**
 * Backups and restore. Shared by `npm run backup|backup:list|restore` and the admin Backups page.
 * Plain TypeScript with erasable syntax so Node can run it directly from /scripts.
 *
 * A backup is a folder  <BACKUP_DIR>/backup-YYYYMMDD-HHMMSS-mmm/  containing:
 *   vk-solar.db     consistent online copy (SQLite backup API — safe while the server runs)
 *   uploads/        copy of STORAGE_DIR/uploads, if any
 *   manifest.json   format, schema version, counts and a SHA-256 checksum for every file
 * Never included: .env, SMTP credentials, storage/secret.key, the mail test outbox.
 *
 * Restore requires the server to be stopped, validates everything first, makes a safety
 * backup of the current data, swaps files in, then applies newer migrations.
 */
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync, renameSync, cpSync, copyFileSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { config } from './config.ts';
import { getDb, closeDb, dbPath, migrate, schemaVersion } from './db.ts';
import { LATEST_SCHEMA_VERSION } from './migrations.ts';

export const BACKUP_FORMAT = 'vk-solar-backup';
export const BACKUP_FORMAT_VERSION = 1;
const NAME_RE = /^backup-\d{8}-\d{6}-\d{3}(-safety)?$/;
const REQUIRED_TABLES = ['admin_users', 'settings', 'service_regions', 'service_locations', 'enquiries', 'schema_migrations'];

export interface ManifestFile {
  path: string; // forward slashes, relative to the backup folder
  bytes: number;
  sha256: string;
}

export interface Manifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  createdAt: string;
  kind: 'manual' | 'safety';
  schemaVersion: number;
  counts: { enquiries: number; locations: number; admins: number; uploads: number };
  files: ManifestFile[];
}

export interface BackupInfo {
  name: string;
  path: string;
  manifest: Manifest | null;
  totalBytes: number;
}

/** Where backups live. Outside STORAGE_DIR by default so copying storage never nests backups. */
export const backupRoot = () => resolve(process.env.BACKUP_DIR || 'backups');

const sha256File = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = join(dir, d.name);
    if (d.isSymbolicLink()) return []; // never follow links
    return d.isDirectory() ? walk(full) : d.isFile() ? [full] : [];
  });
}

function timestampName(kind: 'manual' | 'safety', now = new Date()) {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const base = `backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${p(now.getMilliseconds(), 3)}`;
  return kind === 'safety' ? `${base}-safety` : base;
}

/** Resolve a backup name to its folder, or null if the name isn't a valid backup name (no traversal). */
export function backupPath(name: string, root = backupRoot()): string | null {
  if (!NAME_RE.test(name)) return null;
  const full = resolve(root, name);
  return full.startsWith(root + sep) ? full : null;
}

function countRows(db: DatabaseSync) {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    enquiries: n('SELECT COUNT(*) AS n FROM enquiries'),
    locations: n('SELECT COUNT(*) AS n FROM service_locations'),
    admins: n('SELECT COUNT(*) AS n FROM admin_users'),
  };
}

// ---------------------------------------------------------------- create

/** Create a backup of the current storage. Safe while the server is running. */
export async function createBackup(opts: { kind?: 'manual' | 'safety'; root?: string } = {}): Promise<BackupInfo> {
  const kind = opts.kind ?? 'manual';
  const root = opts.root ?? backupRoot();
  const source = dbPath();
  if (!existsSync(source)) throw new Error('There is no database to back up yet.');

  // Claim a unique name atomically (mkdir fails if it exists), so two backups started in the
  // same millisecond never share a folder.
  mkdirSync(root, { recursive: true });
  let name = '';
  let folder = '';
  let tmp = '';
  for (let t = Date.now(); ; t++) {
    name = timestampName(kind, new Date(t));
    folder = backupPath(name, root)!;
    tmp = `${folder}.partial`;
    if (existsSync(folder)) continue;
    try {
      mkdirSync(tmp);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  try {
    // Online, consistent copy of the live database (includes committed WAL content).
    const live = getDb();
    await sqliteBackup(live, join(tmp, 'vk-solar.db'));
    // The copy inherits WAL mode; switch it to a single self-contained file so opening it
    // later (read-only, for verification) never leaves -wal/-shm files in the backup folder.
    const rw = new DatabaseSync(join(tmp, 'vk-solar.db'));
    try {
      rw.exec('PRAGMA journal_mode = DELETE');
    } finally {
      rw.close();
    }

    const uploads = join(config.storageDir, 'uploads');
    if (existsSync(uploads)) cpSync(uploads, join(tmp, 'uploads'), { recursive: true, dereference: false, verbatimSymlinks: true });

    // Verify the copy before calling it a backup.
    const copy = new DatabaseSync(join(tmp, 'vk-solar.db'), { readOnly: true });
    let counts: ReturnType<typeof countRows>;
    let version: number;
    try {
      const integrity = (copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
      if (integrity !== 'ok') throw new Error('The backup copy failed its integrity check.');
      counts = countRows(copy);
      version = (copy.prepare('SELECT MAX(id) AS v FROM schema_migrations').get() as { v: number }).v;
    } finally {
      copy.close();
    }

    const files = walk(tmp).map((f) => ({ path: relative(tmp, f).split(sep).join('/'), bytes: statSync(f).size, sha256: sha256File(f) }));
    const manifest: Manifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      kind,
      schemaVersion: version,
      counts: { ...counts, uploads: files.filter((f) => f.path.startsWith('uploads/')).length },
      files,
    };
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
    renameSync(tmp, folder); // the backup only appears once it is complete
    return { name, path: folder, manifest, totalBytes: files.reduce((s, f) => s + f.bytes, 0) };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw err;
  }
}

// ---------------------------------------------------------------- list & verify

export function listBackups(root = backupRoot()): BackupInfo[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => NAME_RE.test(n))
    .sort()
    .reverse()
    .map((name) => {
      const path = backupPath(name, root)!;
      let manifest: Manifest | null = null;
      try {
        manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as Manifest;
      } catch {
        manifest = null;
      }
      const totalBytes = manifest?.files?.reduce((s, f) => s + (Number(f.bytes) || 0), 0) ?? 0;
      return { name, path, manifest, totalBytes };
    });
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  manifest: Manifest | null;
}

/** Check a backup thoroughly: manifest, every checksum, no extra files, DB integrity, schema version. */
export function verifyBackup(name: string, root = backupRoot()): VerifyResult {
  const problems: string[] = [];
  const folder = backupPath(name, root);
  if (!folder || !existsSync(folder)) return { ok: false, problems: ['Backup not found (or not a valid backup name).'], manifest: null };

  let manifest: Manifest | null = null;
  try {
    manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    return { ok: false, problems: ['manifest.json is missing or unreadable.'], manifest: null };
  }
  if (manifest.format !== BACKUP_FORMAT || manifest.formatVersion !== BACKUP_FORMAT_VERSION) problems.push('Unrecognised backup format.');
  if (!Array.isArray(manifest.files)) return { ok: false, problems: [...problems, 'Manifest has no file list.'], manifest };
  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 1) problems.push('Manifest has no valid schema version.');
  else if (manifest.schemaVersion > LATEST_SCHEMA_VERSION)
    problems.push(`Backup is from a newer version of the site (schema ${manifest.schemaVersion} > ${LATEST_SCHEMA_VERSION}). Update the code first.`);

  const listed = new Set<string>();
  for (const f of manifest.files) {
    const rel = String(f.path ?? '');
    const full = resolve(folder, rel);
    if (!rel || rel.includes('\\') || rel.split('/').includes('..') || !full.startsWith(folder + sep)) {
      problems.push('Manifest lists an unsafe file path.');
      continue;
    }
    listed.add(rel);
    if (!existsSync(full)) problems.push(`Missing file: ${rel}`);
    else if (statSync(full).size !== f.bytes || sha256File(full) !== f.sha256) problems.push(`Checksum mismatch: ${rel}`);
  }
  if (!listed.has('vk-solar.db')) problems.push('Backup does not contain vk-solar.db.');
  for (const f of walk(folder)) {
    const rel = relative(folder, f).split(sep).join('/');
    if (rel !== 'manifest.json' && !listed.has(rel)) problems.push(`Unexpected file not in manifest: ${rel}`);
  }

  if (!problems.some((p) => /vk-solar\.db/.test(p))) {
    try {
      const db = new DatabaseSync(join(folder, 'vk-solar.db'), { readOnly: true });
      try {
        const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
        if (integrity !== 'ok') problems.push('Database integrity check failed.');
        const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
        const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
        if (missing.length) problems.push(`Database is missing tables: ${missing.join(', ')}`);
        else if ((db.prepare('SELECT MAX(id) AS v FROM schema_migrations').get() as { v: number }).v !== manifest.schemaVersion)
          problems.push('Database schema version does not match the manifest.');
      } finally {
        db.close();
      }
    } catch {
      problems.push('Database file cannot be opened.');
    }
  }
  return { ok: problems.length === 0, problems, manifest };
}

// ---------------------------------------------------------------- restore

/** Is the server running against this storage folder? (Based on the PID file server.mjs writes.) */
export function serverRunning(storageDir = config.storageDir): { running: boolean; pid?: number } {
  const pidFile = join(storageDir, 'server.pid');
  if (!existsSync(pidFile)) return { running: false };
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return { running: false };
  try {
    process.kill(pid, 0); // signal 0 = existence check only
    return { running: true, pid };
  } catch (err) {
    // EPERM means it exists but belongs to someone else: treat as running.
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? { running: true, pid } : { running: false };
  }
}

export interface RestoreResult {
  restored: string;
  safetyBackup: string | null;
  migratedFrom: number;
  migratedTo: number;
  counts: Manifest['counts'];
}

/**
 * Restore a verified backup into STORAGE_DIR. Throws (changing nothing) if the server is
 * running or the backup fails verification. Takes a safety backup of current data first.
 */
export async function restoreBackup(name: string, opts: { root?: string } = {}): Promise<RestoreResult> {
  const root = opts.root ?? backupRoot();
  const running = serverRunning();
  if (running.running) throw new Error(`The server is running (process ${running.pid}). Stop it (Ctrl+C) before restoring.`);

  const check = verifyBackup(name, root);
  if (!check.ok || !check.manifest) throw new Error(`Backup failed verification, nothing was changed:\n- ${check.problems.join('\n- ')}`);
  const folder = backupPath(name, root)!;

  // 1. Safety backup of what is there now (so a restore can itself be undone).
  let safety: string | null = null;
  if (existsSync(dbPath())) safety = (await createBackup({ kind: 'safety', root })).name;
  closeDb();

  // 2. Swap the database in: copy beside the target, then rename over it.
  mkdirSync(config.storageDir, { recursive: true });
  const target = dbPath();
  const incoming = `${target}.restoring`;
  copyFileSync(join(folder, 'vk-solar.db'), incoming);
  for (const ext of ['-wal', '-shm']) rmSync(`${target}${ext}`, { force: true });
  rmSync(target, { force: true, maxRetries: 10, retryDelay: 100 });
  renameSync(incoming, target);

  // 3. Uploads: replace with the backup's copy (the old set is preserved in the safety backup).
  const uploads = join(config.storageDir, 'uploads');
  rmSync(uploads, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (existsSync(join(folder, 'uploads'))) cpSync(join(folder, 'uploads'), uploads, { recursive: true });

  // 4. Bring an older backup up to the current schema.
  const db = new DatabaseSync(target);
  let from = 0;
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    from = schemaVersion(db);
    migrate(db);
  } finally {
    db.close();
  }
  return { restored: name, safetyBackup: safety, migratedFrom: from, migratedTo: LATEST_SCHEMA_VERSION, counts: check.manifest.counts };
}

/** Delete all but the newest `keep` MANUAL backups (safety backups are never pruned). Explicit use only. */
export function pruneBackups(keep: number, root = backupRoot()): string[] {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be a whole number of at least 1');
  const manual = listBackups(root).filter((b) => !b.name.endsWith('-safety'));
  const remove = manual.slice(keep);
  for (const b of remove) rmSync(b.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return remove.map((b) => b.name);
}
