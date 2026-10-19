// Give (or remove) admin rights for the HOSTED admin panel (ADMIN_AUTH=firebase).
//
//   npm run admin:grant -- someone@example.com            make this Firebase account an admin
//   npm run admin:grant -- someone@example.com --revoke   remove admin rights and sign them out
//
// First create the account yourself in Firebase console -> Authentication -> Users -> Add user
// (choose a strong password there; it is never typed here). Only this script, run with the Admin
// key on your own computer, can grant the role: customers can never make themselves admins.
import { getFirebaseConfig, collectionName } from '../src/lib/server/firebase/config.ts';
import { firebaseAuth, firestore } from '../src/lib/server/firebase/admin.ts';

const args = process.argv.slice(2);
const email = (args.find((a) => !a.startsWith('--')) ?? '').trim().toLowerCase();
const revoke = args.includes('--revoke');

try {
  if (getFirebaseConfig().status !== 'ready') throw new Error('Firebase is not configured. Run npm run firebase:check.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Give the account email, e.g. npm run admin:grant -- you@example.com');
  const auth = await firebaseAuth();
  const user = await auth.getUserByEmail(email).catch(() => null);
  if (!user) throw new Error(`No Firebase account for ${email}. Create it first in Firebase console -> Authentication -> Users -> Add user.`);

  if (revoke) {
    const claims = { ...(user.customClaims ?? {}) };
    delete claims.admin;
    await auth.setCustomUserClaims(user.uid, claims);
    await auth.revokeRefreshTokens(user.uid);
    const db = await firestore();
    const open = await db.collection(collectionName('admin_sessions')).where('uid', '==', user.uid).get();
    for (const d of open.docs) await d.ref.delete();
    console.log(`Admin rights removed from ${email}; ${open.size} admin session(s) ended.`);
  } else {
    // An admin must not also be a portal customer (keeps the two roles separate).
    const db = await firestore();
    for (const env of ['dev', 'prod']) {
      if ((await db.collection(`${env}_customers`).doc(user.uid).get()).exists) {
        throw new Error(`${email} is registered as a customer. Use a separate email address for the admin account.`);
      }
    }
    if (user.disabled) throw new Error(`${email} is disabled in Firebase. Enable it first.`);
    await auth.setCustomUserClaims(user.uid, { ...(user.customClaims ?? {}), admin: true });
    console.log(`${email} is now an administrator. Sign in at /admin/login (it may take up to a minute).`);
  }
} catch (err) {
  console.error(`Not done: ${err.message}`);
  process.exitCode = 1;
}
