// Create the first administrator, or reset an administrator's password.
//
//   npm run admin:create                  create an admin (prompts for username + password)
//   npm run admin:create -- --reset NAME  set a new password for NAME (ends their sessions)
//
// The password is read with hidden input from the terminal. When stdin is not a terminal
// (automation), it is read from the first line of stdin instead. Nothing is hardcoded.
import { createInterface } from 'node:readline';
import { getDb, closeDb, dbPath } from '../src/lib/server/db.ts';
import {
  adminCount,
  createAdmin,
  setAdminPassword,
  validateNewPassword,
  validateUsername,
} from '../src/lib/server/auth.ts';
import { audit } from '../src/lib/server/audit.ts';

const args = process.argv.slice(2);
const resetIndex = args.indexOf('--reset');
const resetUser = resetIndex >= 0 ? args[resetIndex + 1] : null;

let pipedLines = null;
async function readPiped() {
  if (pipedLines) return pipedLines;
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  pipedLines = data.split(/\r?\n/);
  return pipedLines;
}

async function ask(question, { hidden = false, pipedIndex = 0 } = {}) {
  if (!process.stdin.isTTY) {
    const lines = await readPiped();
    return (lines[pipedIndex] ?? '').trim();
  }
  if (!hidden) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((r) => rl.question(question, r));
    rl.close();
    return answer.trim();
  }
  // Hidden input: raw mode, echo nothing.
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        cleanup();
        process.stdout.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        cleanup();
        process.stdout.write('\n');
        reject(new Error('Cancelled.'));
      } else if (ch === '\u0008' || ch === '\u007f') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
    };
    process.stdin.on('data', onData);
  });
}

async function main() {
  getDb(); // opens the database and applies pending migrations
  console.log(`Database: ${dbPath()}`);

  let username = resetUser;
  if (!username) {
    if (adminCount() > 0) {
      console.log('An administrator already exists. To change a password, run: npm run admin:create -- --reset <username>');
      process.exitCode = 1;
      return;
    }
    username = await ask('New admin username: ', { pipedIndex: 0 });
    const userError = validateUsername(username);
    if (userError) throw new Error(userError);
  }

  const offset = resetUser ? 0 : 1;
  const password = await ask('Password (hidden): ', { hidden: true, pipedIndex: offset });
  const pwError = validateNewPassword(password, username);
  if (pwError) throw new Error(pwError);
  const confirm = await ask('Confirm password (hidden): ', { hidden: true, pipedIndex: offset + 1 });
  if (confirm !== password) throw new Error('Passwords do not match.');

  if (resetUser) {
    if (!setAdminPassword(username, password)) throw new Error(`No administrator named "${username}".`);
    audit('admin.password_reset_cli', { targetType: 'admin', targetId: username });
    console.log(`Password updated for "${username}". All of their sessions have been signed out.`);
  } else {
    const user = createAdmin(username, password);
    audit('admin.created_cli', { userId: user.id, targetType: 'admin', targetId: user.id });
    console.log(`Administrator "${username}" created. Sign in at http://127.0.0.1:4321/admin/login`);
  }
}

main()
  .catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
