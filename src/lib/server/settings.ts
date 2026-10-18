import { getDb, nowIso } from './db.ts';
import { config } from './config.ts';

/** Known settings with their defaults. Unknown keys are rejected. */
const DEFAULTS = {
  /** Admin switch for public enquiries (also requires ENQUIRIES_ENABLED=true). */
  'enquiries.accept': false as boolean,
  /**
   * Retention policy for RESOLVED enquiries, in days after resolution. Nothing is deleted
   * automatically: the inbox shows how many are past this age and an admin can delete them
   * after a preview and confirmation.
   */
  'enquiries.retentionDays': 365 as number,
};

export type SettingKey = keyof typeof DEFAULTS;
export type SettingValue<K extends SettingKey> = (typeof DEFAULTS)[K];

export function getSetting<K extends SettingKey>(key: K): SettingValue<K> {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return DEFAULTS[key];
  try {
    return JSON.parse(row.value) as SettingValue<K>;
  } catch {
    return DEFAULTS[key];
  }
}

export function setSetting<K extends SettingKey>(key: K, value: SettingValue<K>) {
  if (!(key in DEFAULTS)) throw new Error(`Unknown setting ${key}`);
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), nowIso());
}

/**
 * Whether the public contact form accepts submissions. BOTH gates must be open:
 * the ENQUIRIES_ENABLED environment variable (server operator) and the admin setting.
 */
export function enquiryGates() {
  const env = config.enquiriesEnabled;
  const admin = getSetting('enquiries.accept');
  return { env, admin, open: env && admin };
}
