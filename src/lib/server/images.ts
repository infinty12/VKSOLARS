/**
 * Safe image processing foundation (server-only). There is no upload UI or public media route
 * yet; this module is what any future upload handler must go through.
 *
 * Every upload is:
 *   1. size-checked BEFORE decoding (default 8 MB);
 *   2. identified by Sharp from its actual bytes — the file name and the browser's claimed
 *      MIME type are never trusted (a mismatching claim is rejected);
 *   3. limited to JPEG, PNG, WebP or AVIF — SVG (scriptable XML), GIF, TIFF, HEIC, raw and
 *      everything else is refused;
 *   4. checked for sane dimensions and a pixel limit (decompression-bomb protection), and
 *      refused if animated / multi-page;
 *   5. fully decoded and RE-ENCODED to WebP (EXIF orientation applied, all metadata such as
 *      GPS stripped, longest side capped), plus a thumbnail. The original bytes are never kept.
 *   6. stored under <STORAGE_DIR>/uploads with a random server-generated name — never inside
 *      public/ or dist/, never using any part of the uploaded file name.
 */
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { config } from './config.ts';

export const IMAGE_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  minSide: 16,
  maxSide: 8000,
  maxPixels: 40_000_000,
  outputMaxSide: 2560,
  thumbMaxSide: 480,
  quality: 82,
};
export type ImageLimits = typeof IMAGE_LIMITS;

/** Sharp's detected format → the MIME types a browser may legitimately claim for it. */
const ALLOWED: Record<string, string[]> = {
  jpeg: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  png: ['image/png'],
  webp: ['image/webp'],
  heif: ['image/avif'], // Sharp reports AVIF as "heif"; accepted only when the compression is AV1
};

export type ImageRejection =
  | 'empty'
  | 'too_large'
  | 'unreadable'
  | 'unsupported_format'
  | 'svg_not_allowed'
  | 'type_mismatch'
  | 'too_small'
  | 'too_big_dimensions'
  | 'too_many_pixels'
  | 'animated_not_allowed';

export const REJECTION_MESSAGES: Record<ImageRejection, string> = {
  empty: 'The file is empty.',
  too_large: 'The file is too large.',
  unreadable: 'The file is not a readable image.',
  unsupported_format: 'Only JPEG, PNG, WebP and AVIF images are accepted.',
  svg_not_allowed: 'SVG images are not accepted.',
  type_mismatch: 'The file’s contents do not match its stated type.',
  too_small: 'The image is too small.',
  too_big_dimensions: 'The image dimensions are too large.',
  too_many_pixels: 'The image has too many pixels.',
  animated_not_allowed: 'Animated or multi-page images are not accepted.',
};

export interface ProcessedImage {
  ok: true;
  /** Random id; files are <id>.webp and <id>-thumb.webp. */
  id: string;
  width: number;
  height: number;
  bytes: number;
  sourceFormat: string;
  image: Buffer;
  thumbnail: Buffer;
}
export type ImageResult = ProcessedImage | { ok: false; reason: ImageRejection; message: string };

const reject = (reason: ImageRejection): ImageResult => ({ ok: false, reason, message: REJECTION_MESSAGES[reason] });

/**
 * Validate and re-encode an uploaded image. Pure (no disk writes). `claimedType` is the MIME
 * type the browser sent, if any — used only to detect mismatches, never to decide the format.
 */
export async function processImage(input: Buffer, claimedType?: string | null, limits: ImageLimits = IMAGE_LIMITS): Promise<ImageResult> {
  if (!input || input.length === 0) return reject('empty');
  if (input.length > limits.maxBytes) return reject('too_large');

  // Cheap signature check first: SVG/XML text is refused before Sharp ever parses it.
  const head = input.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.includes('<svg')) return reject('svg_not_allowed');

  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    meta = await sharp(input, { limitInputPixels: limits.maxPixels, failOn: 'error' }).metadata();
  } catch (err) {
    return /pixel limit/i.test((err as Error).message) ? reject('too_many_pixels') : reject('unreadable');
  }

  const format = meta.format ?? '';
  if (format === 'svg') return reject('svg_not_allowed');
  if (!(format in ALLOWED)) return reject('unsupported_format');
  if (format === 'heif' && meta.compression !== 'av1') return reject('unsupported_format'); // HEIC is not accepted
  if (claimedType && !ALLOWED[format].includes(claimedType.toLowerCase())) return reject('type_mismatch');

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < limits.minSide || height < limits.minSide) return reject('too_small');
  if (width > limits.maxSide || height > limits.maxSide) return reject('too_big_dimensions');
  if (width * height > limits.maxPixels) return reject('too_many_pixels');
  if ((meta.pages ?? 1) > 1) return reject('animated_not_allowed');

  try {
    // Full decode + re-encode. failOn:'error' also catches truncated/corrupt data that the
    // header alone did not reveal. Metadata is not copied (Sharp strips it unless asked).
    const pipeline = () => sharp(input, { limitInputPixels: limits.maxPixels, failOn: 'error' }).rotate();
    const image = await pipeline()
      .resize({ width: limits.outputMaxSide, height: limits.outputMaxSide, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: limits.quality })
      .toBuffer({ resolveWithObject: true });
    const thumbnail = await pipeline()
      .resize({ width: limits.thumbMaxSide, height: limits.thumbMaxSide, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
    return {
      ok: true,
      id: randomUUID(),
      width: image.info.width,
      height: image.info.height,
      bytes: image.info.size,
      sourceFormat: format === 'heif' ? 'avif' : format,
      image: image.data,
      thumbnail,
    };
  } catch {
    return reject('unreadable');
  }
}

// ---------------------------------------------------------------- storage

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The uploads directory: inside STORAGE_DIR, never under public/ or dist/. */
export const uploadsDir = (storageDir = config.storageDir) => resolve(storageDir, 'uploads');

/**
 * Resolve a stored file name to an absolute path, or null if the name is not exactly a
 * server-generated "<uuid>.webp" / "<uuid>-thumb.webp". Blocks traversal (../, absolute paths,
 * encoded separators, other extensions) by allow-listing rather than sanitising.
 */
export function resolveUploadPath(fileName: string, storageDir = config.storageDir): string | null {
  const m = /^([0-9a-f-]{36})(-thumb)?\.webp$/.exec(fileName);
  if (!m || !ID_RE.test(m[1])) return null;
  const dir = uploadsDir(storageDir);
  const full = resolve(dir, fileName);
  return full.startsWith(dir + sep) ? full : null;
}

/** Write a processed image to the uploads directory. Returns the stored file names. */
export function saveProcessedImage(img: ProcessedImage, storageDir = config.storageDir) {
  const dir = uploadsDir(storageDir);
  mkdirSync(dir, { recursive: true });
  const main = `${img.id}.webp`;
  const thumb = `${img.id}-thumb.webp`;
  const mainPath = resolveUploadPath(main, storageDir);
  const thumbPath = resolveUploadPath(thumb, storageDir);
  if (!mainPath || !thumbPath) throw new Error('invalid image id');
  // 'wx' = fail if the file exists: never overwrite another upload.
  writeFileSync(mainPath, img.image, { flag: 'wx' });
  try {
    writeFileSync(thumbPath, img.thumbnail, { flag: 'wx' });
  } catch (err) {
    rmSync(mainPath, { force: true });
    throw err;
  }
  return { main, thumb };
}

/** Delete a stored image and its thumbnail by id (no-op for invalid ids). */
export function deleteStoredImage(id: string, storageDir = config.storageDir) {
  for (const name of [`${id}.webp`, `${id}-thumb.webp`]) {
    const p = resolveUploadPath(name, storageDir);
    if (p) rmSync(p, { force: true });
  }
}
