// Create a backup of the database and uploads.   npm run backup
// Optional: npm run backup -- --keep 14   (afterwards delete all but the newest 14 manual backups)
// Safe while the server is running. Uses STORAGE_DIR and BACKUP_DIR (defaults ./storage, ./backups).
import { createBackup, pruneBackups, backupRoot } from '../src/lib/server/backup.ts';
import { closeDb } from '../src/lib/server/db.ts';

const args = process.argv.slice(2);
const keepIndex = args.indexOf('--keep');
const keep = keepIndex >= 0 ? Number(args[keepIndex + 1]) : null;

try {
  if (keep !== null && !(Number.isInteger(keep) && keep >= 1)) throw new Error('--keep needs a whole number of at least 1, e.g. --keep 14. No backup was made.');
  const b = await createBackup();
  const c = b.manifest.counts;
  console.log(`Backup created: ${b.name}`);
  console.log(`  Folder:  ${b.path}`);
  console.log(`  Schema:  v${b.manifest.schemaVersion}   Enquiries: ${c.enquiries}   Locations: ${c.locations}   Uploads: ${c.uploads}`);
  console.log(`  Size:    ${(b.totalBytes / 1024).toFixed(1)} KB, ${b.manifest.files.length} file(s), all checksummed and verified`);
  console.log('  Contains customer enquiries: keep it private. It does not contain .env or SMTP credentials.');
  if (keep !== null) {
    const removed = pruneBackups(keep);
    console.log(removed.length ? `Pruned ${removed.length} older manual backup(s): ${removed.join(', ')}` : `Nothing to prune (keeping ${keep}).`);
  }
  console.log(`All backups: ${backupRoot()}`);
} catch (err) {
  console.error(`Backup failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  closeDb();
}
