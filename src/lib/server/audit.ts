import { getDb, nowIso } from './db.ts';

/**
 * Record a sensitive action. `detail` must never contain passwords, tokens or enquiry
 * content (names, phone numbers, messages) — only ids, counts and field names.
 */
export function audit(
  action: string,
  opts: { userId?: number | null; targetType?: string; targetId?: string | number; detail?: Record<string, unknown> } = {},
) {
  getDb()
    .prepare('INSERT INTO audit_log (at, user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      nowIso(),
      // Hosted (Firebase) admins have no local account id: stored as no user.
      opts.userId && opts.userId > 0 ? opts.userId : null,
      action,
      opts.targetType ?? null,
      opts.targetId === undefined ? null : String(opts.targetId),
      opts.detail ? JSON.stringify(opts.detail) : null,
    );
}

export function recentAudit(limit = 20) {
  return getDb()
    .prepare(
      `SELECT a.at, a.action, a.target_type AS targetType, a.target_id AS targetId, u.username
       FROM audit_log a LEFT JOIN admin_users u ON u.id = a.user_id
       ORDER BY a.id DESC LIMIT ?`,
    )
    .all(limit) as { at: string; action: string; targetType: string | null; targetId: string | null; username: string | null }[];
}
