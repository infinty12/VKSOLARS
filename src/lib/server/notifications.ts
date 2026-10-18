/**
 * Enquiry email notifications via a database outbox.
 *
 *   1. createEnquiry() inserts the enquiry AND an outbox row in one transaction (only when
 *      MAIL_ENABLED=true). The visitor's "received" response depends only on that commit.
 *   2. processOutbox() sends due rows afterwards: kicked right after each enquiry and every
 *      minute by a background timer. Failures are retried with backoff, then marked failed.
 *   3. A mail failure can only change the outbox row — never the enquiry.
 *
 * Privacy: by default the email contains no personal data (reference, time, service, state
 * and an admin link only). Errors are stored as short categories; nothing is logged except
 * ids, attempt counts and categories.
 */
import { getDb, nowIso } from './db.ts';
import { getMailConfig, type MailConfig } from './mail-config.ts';
import { createTransport, categorizeMailError, type MailTransport, type MailMessage } from './mailer.ts';
import { services } from '../../data/services.ts';

/** Delay before retry n (1-based), in ms. After the last one the row is marked failed. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1; // 5
const BATCH = 10;

/** Called inside createEnquiry's transaction. Queues nothing when email is disabled. */
export function enqueueEnquiryNotification(enquiryId: number, config: MailConfig = getMailConfig()) {
  if (!config.enabled) return;
  const now = nowIso();
  getDb()
    .prepare("INSERT INTO notification_outbox (kind, enquiry_id, status, next_attempt_at, created_at, updated_at) VALUES ('enquiry.new', ?, 'pending', ?, ?, ?)")
    .run(enquiryId, Date.now(), now, now);
}

interface EnquiryForMail {
  id: number;
  reference: string;
  createdAt: string;
  name: string;
  phone: string;
  email: string;
  service: string;
  regionName: string | null;
  location: string;
  message: string;
}

const serviceTitle: Record<string, string> = { ...Object.fromEntries(services.map((s) => [s.slug, s.title])), 'not-sure': 'Not sure — please recommend' };

export function buildEnquiryEmail(e: EnquiryForMail, config: MailConfig): MailMessage {
  const lines = [
    'A new enquiry was received through the VK Solar website.',
    '',
    `Reference: ${e.reference}`,
    `Received:  ${new Date(e.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })} IST`,
    `Service:   ${serviceTitle[e.service] ?? e.service}`,
    `State/UT:  ${e.regionName ?? 'Not given'}`,
  ];
  if (config.includeDetails) {
    lines.push(
      '',
      `Name:      ${e.name}`,
      `Phone:     ${e.phone}`,
      `Email:     ${e.email || 'Not given'}`,
      `Location:  ${e.location}`,
      '',
      'Message:',
      e.message || '(none)',
    );
  } else {
    lines.push('', 'Customer details are not included in this email. Open the enquiry in the admin inbox on the VK Solar computer:');
  }
  lines.push('', `${config.adminBaseUrl}/admin/enquiries/${e.id}`, '', '— Sent automatically by the VK Solar website. Do not reply to this email.');
  // Subject carries only the reference: no customer data in a header.
  return { to: config.to, from: config.from, subject: `New website enquiry ${e.reference}`, text: lines.join('\n') };
}

let running = false;

/**
 * Send due notifications. Safe to call concurrently (re-entrancy guarded). Returns counts.
 * `transport`/`config` are injectable for tests.
 */
export async function processOutbox(opts: { config?: MailConfig; transport?: MailTransport; now?: number } = {}) {
  const result = { sent: 0, retried: 0, failed: 0, cancelled: 0 };
  if (running) return result;
  running = true;
  try {
    const config = opts.config ?? getMailConfig();
    const db = getDb();
    const now = opts.now ?? Date.now();
    // Rows left in 'sending' by a crash are due again.
    db.prepare("UPDATE notification_outbox SET status = 'pending' WHERE status = 'sending' AND next_attempt_at < ?").run(now - 10 * 60_000);
    const due = db
      .prepare("SELECT id, enquiry_id AS enquiryId, attempts FROM notification_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?")
      .all(now, BATCH) as { id: number; enquiryId: number | null; attempts: number }[];
    if (due.length === 0) return result;

    const transport = opts.transport ?? (config.status === 'ready' ? createTransport(config) : null);
    for (const row of due) {
      const stamp = nowIso();
      // Configuration problems are not retried: they need a person to fix .env.
      if (!transport || config.status !== 'ready') {
        db.prepare("UPDATE notification_outbox SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(
          config.status === 'disabled' ? 'mail_disabled' : 'config_invalid',
          stamp,
          row.id,
        );
        result.failed++;
        continue;
      }
      const enquiry = row.enquiryId
        ? (db
            .prepare(
              `SELECT e.id, e.reference, e.created_at AS createdAt, e.name, e.phone, e.email, e.service, r.name AS regionName, e.location, e.message
               FROM enquiries e LEFT JOIN service_regions r ON r.id = e.region_id WHERE e.id = ?`,
            )
            .get(row.enquiryId) as EnquiryForMail | undefined)
        : undefined;
      if (!enquiry) {
        // Deleted before we could notify: nothing to send, and nothing personal to keep.
        db.prepare("UPDATE notification_outbox SET status = 'cancelled', last_error = 'enquiry_deleted', updated_at = ? WHERE id = ?").run(stamp, row.id);
        result.cancelled++;
        continue;
      }
      db.prepare("UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(stamp, row.id);
      const attempt = row.attempts + 1;
      try {
        await transport.send(buildEnquiryEmail(enquiry, config));
        db.prepare("UPDATE notification_outbox SET status = 'sent', last_error = NULL, sent_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), row.id);
        result.sent++;
      } catch (err) {
        const category = categorizeMailError(err);
        if (attempt >= MAX_ATTEMPTS) {
          db.prepare("UPDATE notification_outbox SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(category, nowIso(), row.id);
          result.failed++;
        } else {
          db.prepare("UPDATE notification_outbox SET status = 'pending', last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?").run(
            category,
            now + RETRY_DELAYS_MS[attempt - 1],
            nowIso(),
            row.id,
          );
          result.retried++;
        }
        console.warn(`[mail] notification #${row.id} not sent: ${category} (attempt ${attempt}/${MAX_ATTEMPTS})`);
      }
    }
    return result;
  } finally {
    running = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let autoRun = true;

/** Tests: turn off automatic background processing so they can drive processOutbox() directly. */
export function setOutboxAutoRun(on: boolean) {
  autoRun = on;
}

/** Start the once-a-minute retry timer (no-op when email is disabled). */
export function ensureOutboxWorker() {
  if (!autoRun || timer || !getMailConfig().enabled) return;
  timer = setInterval(() => void processOutbox().catch(() => console.warn('[mail] outbox run failed')), 60_000);
  timer.unref();
}

/** Process the outbox soon, without delaying the current response. */
export function kickOutbox() {
  if (!autoRun || !getMailConfig().enabled) return;
  ensureOutboxWorker();
  setImmediate(() => void processOutbox().catch(() => console.warn('[mail] outbox run failed')));
}

export function outboxCounts() {
  const rows = getDb().prepare('SELECT status, COUNT(*) AS c FROM notification_outbox GROUP BY status').all() as { status: string; c: number }[];
  const out = { pending: 0, sending: 0, sent: 0, failed: 0, cancelled: 0 };
  for (const r of rows) if (r.status in out) out[r.status as keyof typeof out] = r.c;
  const lastError = getDb().prepare("SELECT last_error AS e, updated_at AS at FROM notification_outbox WHERE status IN ('failed', 'pending') AND last_error IS NOT NULL ORDER BY id DESC LIMIT 1").get() as
    | { e: string; at: string }
    | undefined;
  return { ...out, lastError: lastError ?? null };
}
