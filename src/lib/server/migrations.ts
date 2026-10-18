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
  {
    id: 5,
    name: 'notification outbox for enquiry emails',
    // Written in the same transaction as the enquiry, sent afterwards. A mail failure can only
    // change a row here — never the enquiry. last_error holds a short category, never a message
    // body, address or credential.
    sql: `
      CREATE TABLE notification_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('enquiry.new')),
        enquiry_id INTEGER REFERENCES enquiries(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,      -- epoch ms
        last_error TEXT,                       -- category only, e.g. 'auth_failed'
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE INDEX idx_outbox_due ON notification_outbox(status, next_attempt_at);
    `,
  },
  {
    id: 6,
    name: 'media library and media usage tracking',
    // uid is the random server-generated file id (<uid>.webp / <uid>-thumb.webp in
    // STORAGE_DIR/uploads). original_name is a sanitised display label only, never a path.
    // media_usages blocks deleting an image that is in use (ON DELETE RESTRICT).
    sql: `
      CREATE TABLE media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT NOT NULL UNIQUE CHECK (length(uid) = 36),
        original_name TEXT NOT NULL DEFAULT '',
        mime_type TEXT NOT NULL DEFAULT 'image/webp' CHECK (mime_type IN ('image/webp')),
        source_format TEXT NOT NULL CHECK (source_format IN ('jpeg', 'png', 'webp', 'avif')),
        width INTEGER NOT NULL CHECK (width > 0),
        height INTEGER NOT NULL CHECK (height > 0),
        bytes INTEGER NOT NULL CHECK (bytes > 0),
        thumb_bytes INTEGER NOT NULL DEFAULT 0,
        alt_text TEXT NOT NULL DEFAULT '',
        uploaded_by INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_media_created ON media(created_at);

      CREATE TABLE media_usages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE RESTRICT,
        usage_type TEXT NOT NULL,
        usage_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (media_id, usage_type, usage_key)
      );
      CREATE INDEX idx_media_usages_media ON media_usages(media_id);
    `,
  },
  {
    id: 7,
    name: 'editable content: revisions with draft and published pointers',
    // Every saved draft is a new, immutable revision (validated plain text as JSON). content_state
    // points at the current draft (if any) and the published revision, so public pages can only
    // ever read the published one.
    sql: `
      CREATE TABLE content_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL CHECK (scope IN ('business')),
        data TEXT NOT NULL CHECK (json_valid(data)),
        created_by INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        restored_from INTEGER REFERENCES content_revisions(id) ON DELETE SET NULL,
        published_at TEXT,
        published_by INTEGER REFERENCES admin_users(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_content_revisions_scope ON content_revisions(scope, id);

      CREATE TABLE content_state (
        scope TEXT PRIMARY KEY CHECK (scope IN ('business')),
        draft_revision_id INTEGER REFERENCES content_revisions(id),
        published_revision_id INTEGER REFERENCES content_revisions(id),
        updated_at TEXT NOT NULL
      );
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].id;
