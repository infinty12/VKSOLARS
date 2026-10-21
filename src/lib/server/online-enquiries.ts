/**
 * Contact-form enquiries on the hosted site (ENQUIRY_STORE=firebase).
 *
 * On Vercel the local SQLite database lives in /tmp and is wiped regularly, so enquiries are saved
 * to Firestore instead, in the same collection as portal requests (<env>_requests, marked
 * source "contact-form", uid null) so they appear in Admin -> Customer requests. Portal customers
 * only ever query their own uid, so they never see these.
 *
 * Order of work, so nothing is lost or misreported:
 *   1. save the enquiry (if this fails, the visitor is told it was NOT sent);
 *   2. send the notification email (if configured), straight away — serverless functions do not
 *      keep background timers running;
 *   3. record the email outcome on the enquiry (sent / failed + short category / disabled).
 * An email failure never undoes the saved enquiry; admins see the failure on the request.
 * Enquiry content is never logged.
 */
import { randomBytes, createHash } from 'node:crypto';
import { getFirebaseConfig, collectionName } from './firebase/config.ts';
import { firestore } from './firebase/admin.ts';
import { getMailConfig, type MailConfig } from './mail-config.ts';
import { createTransport, categorizeMailError, type MailTransport, type MailMessage } from './mailer.ts';
import { CONSENT_TEXT, type EnquiryValues } from '../enquiry.ts';
import { REGIONS } from './regions.ts';
import { services } from '../../data/services.ts';
import { ENQUIRY_LIMIT } from './config.ts';

/** Where public enquiries are stored: Firestore on the hosted site, SQLite locally. */
export function enquiryStore(): 'firebase' | 'local' {
  return (process.env.ENQUIRY_STORE ?? '').trim().toLowerCase() === 'firebase' && getFirebaseConfig().status === 'ready' ? 'firebase' : 'local';
}

const serviceTitle: Record<string, string> = { ...Object.fromEntries(services.map((s) => [s.slug, s.title])), 'not-sure': 'Not sure — please recommend' };
const regionName = (code: string) => REGIONS.find((r) => r.code === code)?.name ?? null;

export const newReference = () => {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `ENQ-${ymd}-${randomBytes(3).toString('hex').toUpperCase()}`;
};

export interface SavedEnquiry {
  id: string;
  reference: string;
  createdAt: string;
}

export type NotificationOutcome = { status: 'sent' } | { status: 'failed'; error: string } | { status: 'disabled' };

/** The pieces that talk to the outside world; replaceable in tests. */
export interface EnquiryDeps {
  save: (v: EnquiryValues) => Promise<SavedEnquiry>;
  notify: (v: EnquiryValues, saved: SavedEnquiry) => Promise<NotificationOutcome>;
  record: (saved: SavedEnquiry, outcome: NotificationOutcome) => Promise<void>;
}

export type SubmitResult = { ok: true; reference: string; notification: NotificationOutcome['status'] } | { ok: false; reason: 'store_failed' };

/** Save, then notify, then record the notification outcome. Never reports success unless saved. */
export async function submitOnlineEnquiry(values: EnquiryValues, deps: EnquiryDeps = firestoreDeps()): Promise<SubmitResult> {
  let saved: SavedEnquiry;
  try {
    saved = await deps.save(values);
  } catch (err) {
    console.error('[enquiries] could not save enquiry to Firestore:', (err as Error).name);
    return { ok: false, reason: 'store_failed' };
  }
  let outcome: NotificationOutcome;
  try {
    outcome = await deps.notify(values, saved);
  } catch (err) {
    outcome = { status: 'failed', error: categorizeMailError(err) };
  }
  if (outcome.status === 'failed') console.warn(`[mail] enquiry ${saved.reference} saved, but the notification failed: ${outcome.error}`);
  try {
    await deps.record(saved, outcome);
  } catch (err) {
    console.warn('[enquiries] could not record the notification outcome:', (err as Error).name);
  }
  return { ok: true, reference: saved.reference, notification: outcome.status };
}

// ---------------------------------------------------------------- Firestore + email implementations

/** Notification email: same privacy rules as the local outbox (details only if MAIL_INCLUDE_DETAILS=true). */
export function buildOnlineEnquiryEmail(v: EnquiryValues, saved: SavedEnquiry, config: MailConfig, siteUrl: string): MailMessage {
  const lines = [
    'A new enquiry was received through the VK Solar website.',
    '',
    `Reference: ${saved.reference}`,
    `Received:  ${new Date(saved.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })} IST`,
    `Service:   ${serviceTitle[v.service] ?? v.service}`,
    `State/UT:  ${regionName(v.region) ?? 'Not given'}`,
  ];
  if (config.includeDetails) {
    lines.push('', `Name:      ${v.name}`, `Phone:     ${v.phone}`, `Email:     ${v.email || 'Not given'}`, `Location:  ${v.location}`, '', 'Message:', v.message || '(none)');
  } else {
    lines.push('', 'Customer details are not included in this email. Open the request in the admin panel:');
  }
  lines.push('', `${siteUrl}/admin/requests/${saved.id}`, '', '— Sent automatically by the VK Solar website. Do not reply to this email.');
  return { to: config.to, from: config.from, subject: `New website enquiry ${saved.reference}`, text: lines.join('\n') };
}

export function firestoreDeps(opts: { mail?: MailConfig; transport?: MailTransport; siteUrl?: string } = {}): EnquiryDeps {
  const requests = async () => (await firestore()).collection(collectionName('requests'));
  return {
    async save(v) {
      const createdAt = new Date().toISOString();
      const ref = (await requests()).doc();
      const reference = newReference();
      await ref.create({
        source: 'contact-form',
        uid: null,
        reference,
        type: v.service,
        location: v.location,
        region: v.region,
        systemSize: '',
        message: v.message,
        contact: { name: v.name, phone: v.phone, email: v.email },
        consent: { text: CONSENT_TEXT, at: createdAt },
        status: 'submitted',
        history: [{ status: 'submitted', at: createdAt }],
        notification: { status: 'pending', at: createdAt },
        createdAt,
        updatedAt: createdAt,
      });
      return { id: ref.id, reference, createdAt };
    },
    async notify(v, saved) {
      const config = opts.mail ?? getMailConfig();
      if (config.status !== 'ready') return { status: 'disabled' };
      const transport = opts.transport ?? createTransport(config);
      const siteUrl = (opts.siteUrl ?? (process.env.PUBLIC_SITE_URL || config.adminBaseUrl)).replace(/\/+$/, '');
      try {
        await transport.send(buildOnlineEnquiryEmail(v, saved, config, siteUrl));
        return { status: 'sent' };
      } catch (err) {
        return { status: 'failed', error: categorizeMailError(err) };
      }
    },
    async record(saved, outcome) {
      await (await requests())
        .doc(saved.id)
        .update({ notification: { ...outcome, at: new Date().toISOString() } });
    },
  };
}

// ---------------------------------------------------------------- rate limit shared by all server instances

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Fixed-window counters in Firestore (the in-memory limiter is per server instance, which is too
 * weak on Vercel). Returns seconds to wait, or null if allowed. Addresses are stored hashed.
 */
export async function sharedRateLimit(ip: string, now = Date.now()): Promise<number | null> {
  const db = await firestore();
  const col = db.collection(collectionName('rate_limits'));
  const rules = [
    { key: `enquiry-ip:${ip}`, max: ENQUIRY_LIMIT.perIpMax, windowMs: ENQUIRY_LIMIT.perIpWindowMs },
    { key: 'enquiry-global', max: ENQUIRY_LIMIT.globalMax, windowMs: ENQUIRY_LIMIT.globalWindowMs },
  ];
  for (const rule of rules) {
    const ref = col.doc(sha(rule.key));
    const wait = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const start = Number(snap.get('windowStart') ?? 0);
      const fresh = !snap.exists || now - start >= rule.windowMs;
      const count = fresh ? 0 : Number(snap.get('count') ?? 0);
      if (rule.max > 0 && count >= rule.max) return Math.max(1, Math.ceil((start + rule.windowMs - now) / 1000));
      tx.set(ref, { windowStart: fresh ? now : start, count: count + 1, expiresAt: new Date((fresh ? now : start) + rule.windowMs) });
      return null;
    });
    if (wait) return wait;
  }
  return null;
}
