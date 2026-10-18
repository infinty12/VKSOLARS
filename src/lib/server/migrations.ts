/**
 * Ordered, append-only schema migrations. NEVER edit a migration that has shipped —
 * add a new one. Each runs once inside a transaction and is recorded in schema_migrations.
 */
import { REGIONS } from './regions.ts';

export interface Migration {
  id: number;
  name: string;
  sql: string;
  /**
   * Run with foreign-key enforcement off (required when rebuilding a table that other tables
   * reference: dropping it with enforcement on would fire ON DELETE CASCADE). The runner checks
   * PRAGMA foreign_key_check before committing.
   */
  rebuildsTables?: boolean;
}

const regionRows = REGIONS.map(
  (r, i) => `('${r.code}', '${r.name.replace(/'/g, "''")}', '${r.type}', ${i})`,
).join(',\n    ');

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'admin auth, settings and audit log',
    sql: `
      CREATE TABLE admin_users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        password_changed_at TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE admin_sessions (
        id TEXT PRIMARY KEY,               -- SHA-256 of the cookie token; the raw token is never stored
        user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at INTEGER NOT NULL,       -- epoch ms
        last_seen_at INTEGER NOT NULL,
        absolute_expires_at INTEGER NOT NULL,
        user_agent TEXT
      );
      CREATE INDEX idx_admin_sessions_user ON admin_sessions(user_id);

      CREATE TABLE login_attempts (
        key TEXT PRIMARY KEY,              -- "ip:<addr>" or "user:<name>"
        failures INTEGER NOT NULL,
        window_start INTEGER NOT NULL,
        locked_until INTEGER
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,               -- JSON
        updated_at TEXT NOT NULL
      );

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        user_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        detail TEXT                        -- JSON, never contains enquiry content or passwords
      );
      CREATE INDEX idx_audit_at ON audit_log(at);
    `,
  },
  {
    id: 2,
    name: 'service regions and locations',
    sql: `
      CREATE TABLE service_regions (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('state', 'ut')),
        sort INTEGER NOT NULL
      );

      INSERT INTO service_regions (code, name, type, sort) VALUES
        ${regionRows};

      CREATE TABLE service_locations (
        id INTEGER PRIMARY KEY,
        region_id INTEGER NOT NULL REFERENCES service_regions(id),
        district TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('available', 'limited', 'planned', 'unconfirmed')),
        services TEXT NOT NULL DEFAULT '[]', -- JSON array of service slugs
        note TEXT NOT NULL DEFAULT '',
        published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
        dedupe_key TEXT NOT NULL UNIQUE,     -- region|district|city, lower-cased and trimmed
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        -- An unconfirmed location can never be public.
        CHECK (NOT (published = 1 AND status = 'unconfirmed'))
      );
      CREATE INDEX idx_locations_region ON service_locations(region_id);
      CREATE INDEX idx_locations_public ON service_locations(published, status);
    `,
  },
  {
    id: 3,
    name: 'enquiries and internal notes',
    sql: `
      CREATE TABLE enquiries (
        id INTEGER PRIMARY KEY,
        reference TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        service TEXT NOT NULL,
        region_id INTEGER REFERENCES service_regions(id),
        location TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        consent INTEGER NOT NULL CHECK (consent = 1),
        consent_text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved')),
        resolved_at TEXT
      );
      CREATE INDEX idx_enquiries_created ON enquiries(created_at);
      CREATE INDEX idx_enquiries_status ON enquiries(status, created_at);

      CREATE TABLE enquiry_notes (
        id INTEGER PRIMARY KEY,
        enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
        author_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_notes_enquiry ON enquiry_notes(enquiry_id);
    `,
  },
  {
    id: 4,
    name: 'never reuse ids of deleted locations, enquiries and notes (AUTOINCREMENT)',
    // Without AUTOINCREMENT SQLite reuses the highest id after a delete, so a stale admin link or
    // audit-log entry for a deleted enquiry could point at a different person's enquiry.
    rebuildsTables: true,
    sql: `
      CREATE TABLE service_locations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        region_id INTEGER NOT NULL REFERENCES service_regions(id),
        district TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('available', 'limited', 'planned', 'unconfirmed')),
        services TEXT NOT NULL DEFAULT '[]',
        note TEXT NOT NULL DEFAULT '',
        published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
        dedupe_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (NOT (published = 1 AND status = 'unconfirmed'))
      );
      INSERT INTO service_locations_new (id, region_id, district, city, status, services, note, published, dedupe_key, created_at, updated_at)
        SELECT id, region_id, district, city, status, services, note, published, dedupe_key, created_at, updated_at FROM service_locations;
      DROP TABLE service_locations;
      ALTER TABLE service_locations_new RENAME TO service_locations;
      CREATE INDEX idx_locations_region ON service_locations(region_id);
      CREATE INDEX idx_locations_public ON service_locations(published, status);

      CREATE TABLE enquiries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reference TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        service TEXT NOT NULL,
        region_id INTEGER REFERENCES service_regions(id),
        location TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        consent INTEGER NOT NULL CHECK (consent = 1),
        consent_text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved')),
        resolved_at TEXT
      );
      INSERT INTO enquiries_new (id, reference, created_at, updated_at, name, phone, email, service, region_id, location, message, consent, consent_text, status, resolved_at)
        SELECT id, reference, created_at, updated_at, name, phone, email, service, region_id, location, message, consent, consent_text, status, resolved_at FROM enquiries;

      CREATE TABLE enquiry_notes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
        author_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO enquiry_notes_new (id, enquiry_id, author_id, body, created_at)
        SELECT id, enquiry_id, author_id, body, created_at FROM enquiry_notes;

      DROP TABLE enquiry_notes;
      DROP TABLE enquiries;
      ALTER TABLE enquiries_new RENAME TO enquiries;
      ALTER TABLE enquiry_notes_new RENAME TO enquiry_notes;
      CREATE INDEX idx_enquiries_created ON enquiries(created_at);
      CREATE INDEX idx_enquiries_status ON enquiries(status, created_at);
      CREATE INDEX idx_notes_enquiry ON enquiry_notes(enquiry_id);
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].id;
