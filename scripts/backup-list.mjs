// List backups.   npm run backup:list            (add -- --verify to re-check every backup)
import { listBackups, verifyBackup, backupRoot } from '../src/lib/server/backup.ts';

const verify = process.argv.includes('--verify');
const backups = listBackups();
console.log(`Backups in ${backupRoot()}: ${backups.length}`);
let bad = 0;
for (const b of backups) {
  const m = b.manifest;
  const info = m
    ? `${m.createdAt}  schema v${m.schemaVersion}  enquiries ${m.counts.enquiries}  locations ${m.counts.locations}  uploads ${m.counts.uploads}  ${(b.totalBytes / 1024).toFixed(1)} KB${m.kind === 'safety' ? '  (safety)' : ''}`
    : 'manifest missing or unreadable';
  let status = '';
  if (verify) {
    const r = verifyBackup(b.name);
    status = r.ok ? '  ✔ verified' : `  ✖ ${r.problems.join('; ')}`;
    if (!r.ok) bad++;
  }
  console.log(`  ${b.name}  ${info}${status}`);
}
if (verify && bad) process.exitCode = 1;
