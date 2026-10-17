import type { APIRoute } from 'astro';

export const prerender = true;

// The sitemap is only generated when PUBLIC_SITE_URL is set, so only reference it then.
export const GET: APIRoute = ({ site }) => {
  const lines = ['User-agent: *', 'Allow: /', 'Disallow: /admin/', 'Disallow: /api/'];
  if (site) lines.push('', `Sitemap: ${new URL('sitemap-index.xml', site).href}`);
  return new Response(lines.join('\n') + '\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
