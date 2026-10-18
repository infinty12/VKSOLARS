// Restore a backup.   npm run restore -- <backup-name>          (asks you to type RESTORE)
//                     npm run restore -- <backup-name> --yes    (no prompt, for automation)
//
// The server must be stopped. The backup is fully verified first; if anything is wrong nothing
// is changed. A safety backup of the current data is taken before anything is replaced.
import { createInterface } from 'node:readline';
import { restoreBackup, verifyBackup, listBackups } from '../src/lib/server/backup.ts';
import { closeDb, dbPath } from '../src/lib/server/db.ts';

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
const yes = args.includes('--yes');

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  return answer.trim() === 'RESTORE';
}

try {
  if (!name) {
    const recent = listBackups().slice(0, 5).map((b) => `  ${b.name}`);
    throw new Error(`Name the backup to restore, e.g. npm run restore -- ${listBackups()[0]?.name ?? 'backup-YYYYMMDD-HHMMSS-mmm'}${recent.length ? `\nMost recent:\n${recent.join('\n')}` : '\n(no backups found)'}`);
  }
  const check = verifyBackup(name);
  if (!check.ok) throw new Error(`Backup failed verification, nothing was changed:\n- ${check.problems.join('\n- ')}`);
  const c = check.manifest.counts;
  console.log(`Backup ${name} verified: created ${check.manifest.createdAt}, schema v${check.manifest.schemaVersion}, ${c.enquiries} enquiries, ${c.locations} locations, ${c.uploads} uploads.`);
  console.log(`This REPLACES the current data in ${dbPath()} (a safety backup is taken first).`);

  if (!yes) {
    if (!process.stdin.isTTY) throw new Error('Refusing to restore without confirmation. Run it in a terminal, or add --yes.');
    if (!(await confirm('Type RESTORE to continue: '))) throw new Error('Cancelled. Nothing was changed.');
  }

  const r = await restoreBackup(name);
  console.log(`Restored ${r.restored}.`);
  if (r.safetyBackup) console.log(`Previous data saved as ${r.safetyBackup} (restore it the same way to undo).`);
  if (r.migratedFrom !== r.migratedTo) console.log(`Database upgraded from schema v${r.migratedFrom} to v${r.migratedTo}.`);
  console.log('You can now start the server: npm start');
} catch (err) {
  console.error(`Restore not done: ${err.message}`);
  process.exitCode = 1;
} finally {
  closeDb();
}
