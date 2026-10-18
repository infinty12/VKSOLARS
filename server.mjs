// Production server: wraps Astro's Node handler to add security headers to EVERY response
// (pre-rendered pages and static files included), bind to localhost by default, and record a
// PID file so the restore script can refuse to run while the server is up.
//
//   npm run build && npm start      →  http://127.0.0.1:4321
//
// Environment: HOST (default 127.0.0.1), PORT (default 4321), plus those in .env.example.
import http from 'node:http';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

process.env.ASTRO_NODE_AUTOSTART = 'disabled';
process.env.ASTRO_NODE_LOGGING ??= 'disabled';
const { handler } = await import('./dist/server/entry.mjs');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4321);
const storageDir = resolve(process.env.STORAGE_DIR || 'storage');

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// Only trust X-Forwarded-* when a reverse proxy we control sets them. Otherwise a client could
// send "X-Forwarded-For: 127.0.0.1" to impersonate a local address and reach /admin.
const TRUST_PROXY = (process.env.TRUST_PROXY ?? '').toLowerCase() === 'true';

// Request-body limits, enforced from Content-Length BEFORE any of the body is read or parsed.
// The image upload endpoint allows one image (8 MB) plus form fields; keep in sync with
// MEDIA.maxRequestBytes in src/lib/server/media.ts. Everything else is small form/JSON posts.
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 + 256 * 1024;
const UPLOAD_PATHS = new Set(['/admin/media', '/admin/media/']);

function bodyLimitError(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return null;
  const length = req.headers['content-length'];
  const chunked = req.headers['transfer-encoding'] !== undefined;
  if (length === undefined) return chunked ? { status: 411, text: 'Content-Length required.' } : null;
  const path = (req.url ?? '/').split('?')[0];
  const limit = UPLOAD_PATHS.has(path) ? MAX_UPLOAD_BYTES : MAX_BODY_BYTES;
  return Number(length) > limit ? { status: 413, text: 'Request too large.' } : null;
}

const server = http.createServer((req, res) => {
  if (!TRUST_PROXY) {
    for (const h of Object.keys(req.headers)) if (h.startsWith('x-forwarded-') || h === 'forwarded') delete req.headers[h];
  }
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  const tooBig = bodyLimitError(req);
  if (tooBig) {
    res.writeHead(tooBig.status, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
    res.end(tooBig.text);
    // Discard (never buffer) what the client is still sending, up to a cap, so it can read the
    // response; beyond that just drop the connection.
    let drained = 0;
    req.on('data', (c) => {
      drained += c.length;
      if (drained > 32 * 1024 * 1024) req.destroy();
    });
    return;
  }
  handler(req, res);
});

server.listen(PORT, HOST, () => {
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(join(storageDir, 'server.pid'), String(process.pid));
  console.log(`VK Solar server listening on http://${HOST}:${PORT} (storage: ${storageDir})`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.warn('WARNING: listening on a non-loopback address. /admin is still restricted to loopback unless ADMIN_ALLOW_REMOTE=true.');
  }
});

const shutdown = () => {
  rmSync(join(storageDir, 'server.pid'), { force: true });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
