/**
 * Serves media-library images.  GET /media/<uuid>.webp  and  /media/<uuid>-thumb.webp
 *
 * - The name must be exactly a server-generated uuid file name (allow-list, not sanitising),
 *   so there is no way to name any other file: no "..", separators, encodings or extensions.
 * - The uuid must belong to an image registered in the media table; stray files in the
 *   uploads folder are never served.
 * - Files are read from STORAGE_DIR/uploads, which is outside public/ and dist/.
 * - Always served as image/webp with nosniff, a locked-down CSP and no directory listing.
 */
import type { APIRoute } from 'astro';
import { readFile } from 'node:fs/promises';
import { resolveUploadPath } from '../../lib/server/images.ts';
import { getMediaByUid } from '../../lib/server/media.ts';

export const prerender = false;

const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

export const GET: APIRoute = async ({ params }) => {
  const file = String(params.file ?? '');
  const path = resolveUploadPath(file);
  if (!path) return notFound();
  const uid = file.slice(0, 36);
  if (!getMediaByUid(uid)) return notFound();

  let data: Buffer;
  try {
    data = await readFile(path);
  } catch {
    return notFound();
  }
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': 'image/webp',
      'Content-Length': String(data.length),
      'Content-Disposition': `inline; filename="${file}"`,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
};
