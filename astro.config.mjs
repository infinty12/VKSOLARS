// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import vercel from '@astrojs/vercel';
import sitemap from '@astrojs/sitemap';

// The live domain is not confirmed yet. Set PUBLIC_SITE_URL (e.g. https://www.example.in)
// in .env to enable canonical URLs, og:url and the XML sitemap.
const site = process.env.PUBLIC_SITE_URL || undefined;

// Vercel sets VERCEL=1 during its builds: use the Vercel adapter there, and the local Node server
// (server.mjs, `npm start`) everywhere else.
const onVercel = Boolean(process.env.VERCEL);
// Vercel's own host names for this deployment, so form posts pass Astro's origin check.
const vercelHosts = [process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_URL].filter(Boolean);

// Server-rendered pages (read from the database at request time) aren't discovered by the
// sitemap integration automatically, so list the public ones explicitly.
const serverRenderedPublicPages = ['/', '/services/', '/ai-drone-inspection/', '/about/', '/service-areas/', '/contact/', '/privacy/'];

export default defineConfig({
  site,
  // Pages are server-rendered by default; content pages opt back into static
  // pre-rendering with `export const prerender = true`.
  output: 'server',
  adapter: onVercel ? vercel() : node({ mode: 'standalone' }),
  server: {
    // Never listen on all interfaces by default — the admin panel must stay local.
    host: '127.0.0.1',
    port: 4321,
  },
  security: {
    // Reject cross-site form submissions (POST/PUT/PATCH/DELETE) to server-rendered routes.
    checkOrigin: true,
    // Host headers Astro may trust when building request URLs. Without this, Astro treats every
    // request as http://localhost:<port>, so a browser on http://127.0.0.1 would fail the origin
    // check. Add the live domain via PUBLIC_SITE_URL when one exists.
    allowedDomains: [
      { hostname: 'localhost' },
      { hostname: '127.0.0.1' },
      ...(site ? [{ hostname: new URL(site).hostname, protocol: new URL(site).protocol.replace(':', '') }] : []),
      ...vercelHosts.map((hostname) => ({ hostname, protocol: 'https' })),
    ],
  },
  integrations: site
    ? [sitemap({ customPages: serverRenderedPublicPages.map((p) => new URL(p, site).href), filter: (p) => !p.includes('/admin') })]
    : [],
  build: {
    format: 'directory',
  },
  prefetch: {
    prefetchAll: false,
    defaultStrategy: 'hover',
  },
});
