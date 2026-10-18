/**
 * Media library (server-only): images uploaded by an administrator, processed by images.ts.
 *
 * - Bytes go through processImage() (allow-list, size/pixel limits, full decode, metadata
 *   stripped, re-encoded to WebP) and are stored by saveProcessedImage() under
 *   <STORAGE_DIR>/uploads with a random "<uuid>.webp" name. The original bytes are never kept.
 * - The uploaded file name is kept only as a display label, after sanitising; it is never used
 *   to build a path, a URL or a response header.
 * - Files are served by /media/<uuid>.webp only when a matching row exists here.
 * - media_usages records where an image is used. An image with usages cannot be deleted (the
 *   database enforces this too, with ON DELETE RESTRICT).
 */
import { getDb, nowIso, likeEscape, transaction } from './db.ts';
import { audit } from './audit.ts';
import { hit } from './ratelimit.ts';
import { processImage, saveProcessedImage, deleteStoredImage, IMAGE_LIMITS, type ImageLimits } from './images.ts';

export const MEDIA = {
  altMax: 250,
  nameMax: 120,
  pageSize: 24,
  /** Uploads allowed per administrator per window. */
  uploadsPerWindow: 30,
  uploadWindowMs: 10 * 60 * 1000,
  /**
   * Largest upload request accepted (one image plus form fields). Enforced before the body is
   * read, by server.mjs and the middleware; keep the copy in server.mjs in sync.
   */
  maxRequestBytes: IMAGE_LIMITS.maxBytes + 256 * 1024,
};

const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface MediaItem {
  id: number;
  uid: string;
  originalName: string;
  mimeType: string;
  sourceFormat: string;
  width: number;
  height: number;
  bytes: number;
  thumbBytes: number;
  altText: string;
  uploadedBy: string | null;
  createdAt: string;
  updatedAt: string;
  usageCount: number;
}

export interface MediaUsage {
  usageType: string;
  usageKey: string;
  createdAt: string;
}

const SELECT = `
  SELECT m.id, m.uid, m.original_name AS originalName, m.mime_type AS mimeType, m.source_format AS sourceFormat,
         m.width, m.height, m.bytes, m.thumb_bytes AS thumbBytes, m.alt_text AS altText,
         u.username AS uploadedBy, m.created_at AS createdAt, m.updated_at AS updatedAt,
         (SELECT COUNT(*) FROM media_usages x WHERE x.media_id = m.id) AS usageCount
  FROM media m LEFT JOIN admin_users u ON u.id = m.uploaded_by`;

/** Public URL of an image (or its thumbnail). */
export const mediaUrl = (uid: string, thumb = false) => `/media/${uid}${thumb ? '-thumb' : ''}.webp`;

/** Thumbnail dimensions, for width/height attributes (no layout shift). */
export function thumbSize(m: Pick<MediaItem, 'width' | 'height'>) {
  const scale = Math.min(1, IMAGE_LIMITS.thumbMaxSide / Math.max(m.width, m.height));
  return { width: Math.max(1, Math.round(m.width * scale)), height: Math.max(1, Math.round(m.height * scale)) };
}

/**
 * A display-only label from the uploaded file name: last path segment only, control and
 * bidirectional-override characters removed, whitespace collapsed, length capped.
 */
export function safeOriginalName(name: unknown): string {
  const base = String(name ?? '').split(/[/\\]/).pop() ?? '';
  return base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MEDIA.nameMax);
}

/** Alt text: plain text, single line, trimmed. Returns an error message if invalid. */
export function cleanAltText(input: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const value = String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length > MEDIA.altMax) return { ok: false, error: `Alt text must be ${MEDIA.altMax} characters or fewer.` };
  return { ok: true, value };
}

/** Rate limit for uploads. Returns null if allowed, or seconds to wait. */
export const uploadRateLimit = (userId: number) => hit(`media-upload:${userId}`, MEDIA.uploadsPerWindow, MEDIA.uploadWindowMs);

export type UploadResult = { ok: true; item: MediaItem } | { ok: false; error: string; reason: string };

/** Validate, process, store and register an uploaded image. Nothing is stored on failure. */
export async function uploadMedia(input: {
  data: Buffer;
  claimedType?: string | null;
  originalName?: unknown;
  altText?: unknown;
  userId: number | null;
  limits?: ImageLimits;
}): Promise<UploadResult> {
  const alt = cleanAltText(input.altText);
  if (!alt.ok) return { ok: false, error: alt.error, reason: 'alt_too_long' };

  const processed = await processImage(input.data, input.claimedType || null, input.limits ?? IMAGE_LIMITS);
  if (!processed.ok) {
    audit('media.upload_rejected', { userId: input.userId, targetType: 'media', detail: { reason: processed.reason } });
    return { ok: false, error: processed.message, reason: processed.reason };
  }

  saveProcessedImage(processed); // 'wx': never overwrites
  const now = nowIso();
  let id: number;
  try {
    id = Number(
      getDb()
        .prepare(
          `INSERT INTO media (uid, original_name, mime_type, source_format, width, height, bytes, thumb_bytes, alt_text, uploaded_by, created_at, updated_at)
           VALUES (?, ?, 'image/webp', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          processed.id,
          safeOriginalName(input.originalName),
          processed.sourceFormat,
          processed.width,
          processed.height,
          processed.bytes,
          processed.thumbnail.length,
          alt.value,
          input.userId,
          now,
          now,
        ).lastInsertRowid,
    );
  } catch (err) {
    deleteStoredImage(processed.id); // keep disk and database consistent
    throw err;
  }
  audit('media.upload', {
    userId: input.userId,
    targetType: 'media',
    targetId: id,
    detail: { format: processed.sourceFormat, width: processed.width, height: processed.height, bytes: processed.bytes, hasAlt: alt.value.length > 0 },
  });
  return { ok: true, item: getMedia(id)! };
}

export function getMedia(id: number): MediaItem | null {
  if (!Number.isInteger(id) || id <= 0) return null;
  return (getDb().prepare(`${SELECT} WHERE m.id = ?`).get(id) as MediaItem | undefined) ?? null;
}

/** Look up by public uid (used by the /media route). */
export function getMediaByUid(uid: string): MediaItem | null {
  if (!UID_RE.test(uid)) return null;
  return (getDb().prepare(`${SELECT} WHERE m.uid = ?`).get(uid) as MediaItem | undefined) ?? null;
}

export interface MediaFilter {
  q?: string;
  page?: number;
}

export function listMedia(filter: MediaFilter = {}) {
  const q = (filter.q ?? '').trim().slice(0, 100);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q) {
    const like = `%${likeEscape(q)}%`;
    where.push("(m.alt_text LIKE ? ESCAPE '\\' OR m.original_name LIKE ? ESCAPE '\\' OR m.uid LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (getDb().prepare(`SELECT COUNT(*) AS n FROM media m ${clause}`).get(...params) as { n: number }).n;
  const pages = Math.max(1, Math.ceil(total / MEDIA.pageSize));
  const page = Math.min(Math.max(1, Math.floor(filter.page ?? 1) || 1), pages);
  const items = getDb()
    .prepare(`${SELECT} ${clause} ORDER BY m.id DESC LIMIT ? OFFSET ?`)
    .all(...params, MEDIA.pageSize, (page - 1) * MEDIA.pageSize) as unknown as MediaItem[];
  return { items, total, page, pages, q };
}

export function updateAltText(id: number, input: unknown, userId: number | null): { ok: true } | { ok: false; error: string } {
  const alt = cleanAltText(input);
  if (!alt.ok) return alt;
  const r = getDb().prepare('UPDATE media SET alt_text = ?, updated_at = ? WHERE id = ?').run(alt.value, nowIso(), id);
  if (r.changes === 0) return { ok: false, error: 'That image no longer exists.' };
  audit('media.alt', { userId, targetType: 'media', targetId: id, detail: { length: alt.value.length } });
  return { ok: true };
}

export function listUsages(mediaId: number): MediaUsage[] {
  return getDb()
    .prepare('SELECT usage_type AS usageType, usage_key AS usageKey, created_at AS createdAt FROM media_usages WHERE media_id = ? ORDER BY id')
    .all(mediaId) as unknown as MediaUsage[];
}

/** Record that an image is used somewhere (idempotent). For the future content editor. */
export function addMediaUsage(mediaId: number, usageType: string, usageKey: string) {
  getDb()
    .prepare('INSERT OR IGNORE INTO media_usages (media_id, usage_type, usage_key, created_at) VALUES (?, ?, ?, ?)')
    .run(mediaId, usageType, usageKey, nowIso());
}

export function removeMediaUsage(mediaId: number, usageType: string, usageKey: string) {
  getDb().prepare('DELETE FROM media_usages WHERE media_id = ? AND usage_type = ? AND usage_key = ?').run(mediaId, usageType, usageKey);
}

export type DeleteResult = { ok: true } | { ok: false; reason: 'not_found' | 'in_use'; usages?: number };

/** Delete an unused image (row first, then files). Images in use are refused. */
export function deleteMedia(id: number, userId: number | null): DeleteResult {
  const result = transaction((): DeleteResult & { uid?: string } => {
    const item = getMedia(id);
    if (!item) return { ok: false, reason: 'not_found' };
    if (item.usageCount > 0) return { ok: false, reason: 'in_use', usages: item.usageCount };
    getDb().prepare('DELETE FROM media WHERE id = ?').run(id);
    return { ok: true, uid: item.uid };
  });
  if (!result.ok) {
    if (result.reason === 'in_use') audit('media.delete_refused', { userId, targetType: 'media', targetId: id, detail: { usages: result.usages } });
    return result;
  }
  deleteStoredImage(result.uid!);
  audit('media.delete', { userId, targetType: 'media', targetId: id });
  return { ok: true };
}
