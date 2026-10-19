// Check the Firebase configuration.   npm run firebase:check
//
// Without flags: validates .env only (no network). Prints problems, never values.
// With --connect: also makes READ-ONLY calls to the configured project to confirm the Admin
// credentials work — it reads one non-existent document in the current data environment's
// namespace and asks Auth for at most one user (only the count is printed). Nothing is written.
import { getFirebaseConfig, publicFirebaseStatus, collectionName } from '../src/lib/server/firebase/config.ts';

const connect = process.argv.includes('--connect');
const config = getFirebaseConfig();
const status = publicFirebaseStatus(config);

console.log(`Firebase: ${status.status}${status.projectId ? ` (project ${status.projectId}, data environment "${status.dataEnv}")` : ''}`);
console.log(`Admin credentials: ${status.credentials}`);
for (const p of status.problems) console.log(`  - ${p}`);
if (config.status === 'disabled') console.log('Set FIREBASE_ENABLED=true in .env to use Firebase.');

if (connect && config.status === 'ready') {
  const { firestore, firebaseAuth } = await import('../src/lib/server/firebase/admin.ts');
  try {
    const doc = await (await firestore()).collection(collectionName('meta')).doc('connectivity-check').get();
    console.log(`Firestore: reachable (read-only check; test document ${doc.exists ? 'exists' : 'does not exist'}).`);
  } catch (err) {
    console.log(`Firestore: NOT reachable (${err.code ?? err.name}).`);
    process.exitCode = 1;
  }
  try {
    const page = await (await firebaseAuth()).listUsers(1);
    console.log(`Authentication: reachable (${page.users.length ? 'has users' : 'no users yet'}).`);
  } catch (err) {
    console.log(`Authentication: NOT reachable (${err.code ?? err.name}).`);
    process.exitCode = 1;
  }
} else if (connect) {
  console.log('Not connecting: fix the configuration first.');
  process.exitCode = 1;
} else if (config.status === 'misconfigured') {
  process.exitCode = 1;
}
