// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// The live domain is not confirmed yet. Set PUBLIC_SITE_URL (e.g. https://www.example.in)
// in .env to enable canonical URLs, og:url and the XML sitemap.
const site = process.env.PUBLIC_SITE_URL || undefined;

export default defineConfig({
  site,
  integrations: site ? [sitemap()] : [],
  build: {
    format: 'directory',
  },
  prefetch: {
    prefetchAll: false,
    defaultStrategy: 'hover',
  },
});
