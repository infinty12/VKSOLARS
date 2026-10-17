// Apply pending database migrations.   npm run db:migrate
// Uses STORAGE_DIR (default ./storage). Safe to run repeatedly.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { config } from '../src/lib/server/config.ts';
import { dbPath, migrate, schemaVersion } from '../src/lib/server/db.ts';
import { LATEST_SCHEMA_VERSION } from '../src/lib/server/migrations.ts';

mkdirSync(config.storageDir, { recursive: true });
const db = new DatabaseSync(dbPath());
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
const before = schemaVersion(db);
const applied = migrate(db);
db.close();
console.log(`Database: ${dbPath()}`);
console.log(`Schema version ${before} → ${LATEST_SCHEMA_VERSION}${applied.length ? ` (applied: ${applied.join(', ')})` : ' (already up to date)'}`);
