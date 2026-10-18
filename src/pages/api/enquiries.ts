/**
 * Public enquiry endpoint.  POST /api/enquiries
 *
 * Accepts JSON (from the page script) or a normal form post (no-JS fallback → 303 redirect back
 * to /contact). Nothing is stored unless EVERY check passes:
 *   1. submissions enabled (ENQUIRIES_ENABLED=true AND admin "Accept enquiries" on)
 *   2. same-origin request (Origin / Sec-Fetch-Site), on top of Astro's checkOrigin
 *   3. body size limit
 *   4. honeypot field empty
 *   5. valid signed form token issued by /contact, not too fresh, not expired
 *   6. per-address and site-wide rate limits
 *   7. server-side validation with the shared rules
 * Responses never include database errors, stack traces or other internals, and enquiry content
 * is never logged.
 */
import type { APIRoute } from 'astro';
import { HONEYPOT_FIELD, normaliseEnquiry, validateEnquiry, type EnquiryErrors } from '../../lib/enquiry.ts';
import { checkFormToken, createEnquiry, ENQUIRY_MESSAGES as MESSAGES, type EnquiryMessageCode as Code } from '../../lib/server/enquiries.ts';
import { enquiryGates } from '../../lib/server/settings.ts';
import { listRegions } from '../../lib/server/areas.ts';
import { hit } from '../../lib/server/ratelimit.ts';
import { ENQUIRY_LIMIT } from '../../lib/server/config.ts';
import { services } from '../../data/services.ts';

export const prerender = false;

const SERVICE_SLUGS = [...services.map((s) => s.slug), 'not-sure'];

export const POST: APIRoute = async ({ request, url, clientAddress }) => {
  const contentType = request.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  // Only a real browser form post gets the redirect-back fallback; every other client gets a
  // status code with a JSON body (including unsupported content types → 415).
  const isFormPost = contentType.includes('application/x-www-form-urlencoded');

  const reply = (status: number, code: Code | 'sent', extra: { reference?: string; errors?: EnquiryErrors; retryAfter?: number } = {}) => {
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (extra.retryAfter) headers['Retry-After'] = String(extra.retryAfter);
    if (!isFormPost) {
      const body = code === 'sent' ? { ok: true, reference: extra.reference } : { ok: false, code, message: MESSAGES[code], errors: extra.errors };
      return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
    }
    // No-JS fallback: back to the form with a whitelisted status code (never user text).
    const back = new URL('/contact', url);
    if (code === 'sent') {
      back.searchParams.set('enquiry', 'sent');
      back.searchParams.set('ref', extra.reference ?? '');
    } else {
      back.searchParams.set('enquiry', code);
    }
    back.hash = 'enquiry';
    return new Response(null, { status: 303, headers: { ...headers, Location: `${back.pathname}${back.search}${back.hash}` } });
  };

  // 1. Submissions enabled?
  let gatesOpen = false;
  try {
    gatesOpen = enquiryGates().open;
  } catch {
    return reply(503, 'server');
  }
  if (!gatesOpen) return reply(503, 'disabled');

  // 2. Same-origin only.
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  const sameOrigin = origin ? origin === url.origin : fetchSite === 'same-origin';
  if (!sameOrigin) return reply(403, 'origin');

  // 3. Size limit (header first, then the actual body).
  if (Number(request.headers.get('content-length') ?? 0) > ENQUIRY_LIMIT.maxBodyBytes) return reply(413, 'too_large');
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return reply(400, 'bad_request');
  }
  if (Buffer.byteLength(raw) > ENQUIRY_LIMIT.maxBodyBytes) return reply(413, 'too_large');

  // Parse.
  let data: Record<string, unknown>;
  try {
    if (isJson) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reply(400, 'bad_request');
      data = parsed as Record<string, unknown>;
    } else if (isFormPost) {
      data = Object.fromEntries(new URLSearchParams(raw));
    } else {
      return reply(415, 'bad_request');
    }
  } catch {
    return reply(400, 'bad_request');
  }
  for (const v of Object.values(data)) if (v !== null && typeof v === 'object') return reply(400, 'bad_request');

  // 4. Honeypot: humans never see this field. Reply honestly ("not sent"), never with a fake success.
  if (String(data[HONEYPOT_FIELD] ?? '').trim() !== '') return reply(400, 'rejected');

  // 5. Signed form token.
  const token = checkFormToken(data._t);
  if (token === 'too_fast') return reply(400, 'too_fast');
  if (token !== 'ok') return reply(400, 'token');

  // 6. Rate limits (counted only for requests that passed the checks above).
  const ip = (() => {
    try {
      return clientAddress;
    } catch {
      return 'unknown';
    }
  })();
  const wait = hit(`ip:${ip}`, ENQUIRY_LIMIT.perIpMax, ENQUIRY_LIMIT.perIpWindowMs) ?? hit('global', ENQUIRY_LIMIT.globalMax, ENQUIRY_LIMIT.globalWindowMs);
  if (wait) return reply(429, 'rate_limited', { retryAfter: wait });

  // 7. Validate with the shared rules.
  let regionCodes: string[];
  try {
    regionCodes = listRegions().map((r) => r.code);
  } catch {
    return reply(500, 'server');
  }
  const values = normaliseEnquiry(data);
  const errors = validateEnquiry(values, { serviceSlugs: SERVICE_SLUGS, regionCodes });
  if (Object.keys(errors).length) return reply(422, 'invalid', { errors });

  // Store.
  try {
    const { reference } = createEnquiry(values);
    return reply(201, 'sent', { reference });
  } catch (err) {
    console.error('[enquiries] failed to store enquiry:', (err as Error).name); // no content, no stack
    return reply(500, 'server');
  }
};

// Anything other than POST is not supported.
export const ALL: APIRoute = () => new Response(null, { status: 405, headers: { Allow: 'POST' } });
