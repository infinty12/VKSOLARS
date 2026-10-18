/**
 * SQLite access via Node's built-in node:sqlite (no native driver to compile on Windows).
 * One connection per process, opened lazily; pending migrations run on first open.
 * All queries elsewhere MUST use prepared statements with bound parameters.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { MIGRATIONS } from './migrations.ts';

let db: DatabaseSync | null = null;

export const dbPath = () => join(config.storageDir, 'vk-solar.db');

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(config.storageDir, { recursive: true });
  const conn = new DatabaseSync(dbPath());
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(conn);
  db = conn;
  return conn;
}

/** Close the connection (used by restore and tests). The next getDb() reopens it. */
export function closeDb() {
  db?.close();
  db = null;
}

export function schemaVersion(conn: DatabaseSync): number {
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const row = conn.prepare('SELECT MAX(id) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}

/** Apply every migration newer than the database's current version. Returns the ids applied. */
export function migrate(conn: DatabaseSync): number[] {
  const current = schemaVersion(conn);
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (m.id <= current) continue;
    // Table rebuilds must run with FK enforcement off (it can only be changed outside a
    // transaction), otherwise dropping the old table would cascade-delete referencing rows.
    if (m.rebuildsTables) conn.exec('PRAGMA foreign_keys = OFF');
    conn.exec('BEGIN IMMEDIATE');
    try {
      conn.exec(m.sql);
      if (m.rebuildsTables) {
        const broken = conn.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`foreign key check failed (${broken.length} row(s))`);
      }
      conn.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, nowIso());
      conn.exec('COMMIT');
      applied.push(m.id);
    } catch (err) {
      conn.exec('ROLLBACK');
      throw new Error(`Migration ${m.id} (${m.name}) failed: ${(err as Error).message}`, { cause: err });
    } finally {
      if (m.rebuildsTables) conn.exec('PRAGMA foreign_keys = ON');
    }
  }
  return applied;
}

export const nowIso = () => new Date().toISOString();

/** Run fn in a transaction. */
export function transaction<T>(fn: () => T): T {
  const conn = getDb();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

/** Escape LIKE wildcards in user search input (used with `ESCAPE '\\'`). */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
