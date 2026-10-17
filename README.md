# VK Solar High-Tech Power Solution — website

Marketing website for VK Solar: solar panel cleaning, preventive maintenance, AI drone inspection and related services
for industrial and commercial sites across Rajasthan.

**Stack:** [Astro 7.4](https://astro.build) (static output) · TypeScript (strict) · plain CSS design tokens ·
Playwright + axe-core for browser and accessibility tests. No UI framework; client JavaScript is limited to the mobile
menu, contact form, gallery lightbox, dashboard tabs and small scroll effects.

---

## Requirements

- Node.js **22.22.0 or newer** (Astro 7 requirement; developed on Node 24.22)
- npm 9.6.5+

## Getting started

```bash
npm install
npm run test:install   # one-time: downloads Playwright's Chromium for tests
cp .env.example .env   # then fill in values (see Configuration)
npm run dev            # http://localhost:4321
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server with hot reload |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Serve the production build on :4321 |
| `npm run check` | Astro + TypeScript diagnostics |
| `npm run lint` | ESLint (TypeScript + Astro rules) |
| `npm run contrast` | WCAG contrast check of every colour pair the design system uses |
| `npm run links` | Checks the built site for broken links, missing `#anchors` and `href="#"` placeholders |
| `npm run validate:html` | Validates the built HTML with html-validate (see note below) |
| `npm run seo` | Checks titles, descriptions, one `<h1>` per page, Open Graph, canonical, robots and sitemap in `dist/` |
| `npm run test` | Playwright suite (starts `astro preview` automatically; run `npm run build` first) |
| `npm run verify` | All of the above in order |

`node scripts/check-seo.mjs <dir> <url>` checks a build made with a domain, e.g.
`PUBLIC_SITE_URL=https://www.example.in npx astro build --outDir dist-seo` then
`node scripts/check-seo.mjs dist-seo https://www.example.in`.

**html-validate exclusions** (`.htmlvalidate.json`): formatting-only rules are off because they describe Astro’s
minified output style, not validity. `role="list"` on `<ul>`/`<ol>` is allowed on purpose — Safari/VoiceOver drops list
semantics when `list-style: none` is applied, and the role restores them.

Utility scripts: `node scripts/screenshots.mjs <outDir> [routes…]` (full-page screenshots, needs preview running;
`WIDTHS=375,768,1440` to choose widths) and `node scripts/og-image.mjs` (regenerates `public/og-image.jpg`).

## Project structure

```
src/
  config/site.ts         ← ALL business facts (contact, cities, stats, testimonials, team, domain)
  config/navigation.ts   ← main navigation
  config/schema.ts       ← JSON-LD built only from verified fields
  data/services.ts       ← the eight services (copy, benefits, inclusions)
  data/process.ts        ← five-step process + home-page benefits
  data/sampleInspection.ts ← ILLUSTRATIVE data for the drone dashboard demo
  lib/enquiry.ts         ← contact form validation rules
  styles/tokens.css      ← design tokens: colour, type, spacing, grid, radii, shadows, motion
  styles/global.css      ← reset, base typography, layout primitives, focus styles
  styles/fonts.css       ← self-hosted Poppins / Inter / JetBrains Mono (Latin subset)
  layouts/               ← BaseLayout (head/SEO) and SiteLayout (header/footer)
  components/            ← Header, Footer, Button, ServiceCard, ContactForm, InspectionDashboard, …
  pages/                 ← /, /services, /ai-drone-inspection, /about, /service-areas, /contact, 404, robots.txt
public/                  ← favicon, og-image.jpg, _headers (security headers)
tests/                   ← Playwright specs
scripts/                 ← contrast, link check, screenshots, OG image
```

## Configuration

### Environment variables (`.env`)

| Variable | Purpose | If empty |
|---|---|---|
| `PUBLIC_SITE_URL` | Live domain, e.g. `https://www.example.in` | No canonical URLs, `og:url`/`og:image`, or `sitemap.xml` |
| `PUBLIC_WEB3FORMS_KEY` | Contact-form access key | Form validates but tells the user it **was not sent** |

Both are `PUBLIC_` because they are meant to be visible in the browser — the Web3Forms key is designed to be public.
There are no server-side secrets in this project.

### Business information — `src/config/site.ts`

Every company fact on the site comes from this one file, and **anything left `null` or empty is hidden** — the site never
shows invented data. Fill in only verified information:

| Field | Shows up as |
|---|---|
| `contact.phone` / `phoneDisplay` | Header call link (wide screens), mobile floating call button, footer, contact page, CTA buttons |
| `contact.whatsapp` | Floating WhatsApp button, footer, contact page |
| `contact.email`, `address`, `hours` | Footer and contact page; `address` also upgrades JSON-LD to `LocalBusiness` |
| `social.*` | Footer social links |
| `stats` | Home and About statistics band with count-up (hidden while empty) |
| `testimonials` | Home testimonials (hidden while empty; each must have `approved: true`) |
| `team`, `achievements` | About page (a clearly marked “coming soon” note shows while `team` is empty) |
| `serviceAreas.confirmed` | City list and map pins on Service Areas; footer service-area list |
| `founded` | JSON-LD `foundingDate` |

## Contact form

- **Until `PUBLIC_WEB3FORMS_KEY` is set, the form shows a visible “Online enquiries are not active yet” notice** above
  the fields, and submitting says the message was not sent. No request is made.
- Client-side validation (on blur and on submit) with inline errors, a linked error summary, and correct input types and
  autocomplete for mobile keyboards and autofill.
- Loading state, duplicate-submission guard, 15-second timeout, and truthful success/error messages: **“sent” is shown
  only after the provider replies `success: true`.** On failure the user’s input is kept.
- Spam protection: hidden honeypot field (`botcheck`), plus Web3Forms’ own server-side spam filtering.
- `?service=<slug>` and `?location=<text>` in the URL pre-fill the form (used by service CTAs and the Service Areas
  availability box).

**Setup:** create a free access key at [web3forms.com](https://web3forms.com) using the inbox that should receive
enquiries, then set `PUBLIC_WEB3FORMS_KEY` and rebuild.

**Server-side validation:** the site is static, so server-side checks run at Web3Forms. For full control (your own
validation, rate limiting, CRM integration), add an Astro server endpoint with a host adapter (Netlify/Vercel/Cloudflare),
reuse `validateEnquiry()` from `src/lib/enquiry.ts` on the server, and point `site.form.endpoint` at it.

## AI drone dashboard

The dashboard on `/ai-drone-inspection` is a **demonstration** that uses invented numbers from
`src/data/sampleInspection.ts`. It is permanently labelled “Illustrative sample data — not live telemetry.” There is no
drone API, telemetry feed or analytics backend.

To connect real data later you would need: a source of inspection results (an inspection-software export or API),
per-client access control (results are confidential), and a server or build step to fetch them. Keep the
`SampleBlock` shape in `sampleInspection.ts` as the interface and replace the data source; remove the sample label only
when the data is real.

## Content to confirm before launch

| Item | Status |
|---|---|
| Phone, WhatsApp, email, office address, hours | **Not provided** — hidden |
| Live domain | **Not provided** — canonical/sitemap disabled |
| Web3Forms key | **Not provided** — form reports “not sent” |
| Confirmed service cities | **Not provided** — availability is “confirmed per site” |
| Company statistics | **Not provided** — section hidden |
| Client testimonials | **Not provided** — section hidden |
| Team profiles, certifications, founding year | **Not provided** — About shows a “coming soon” note |
| Logo | Placeholder mark in `src/components/Logo.astro` — replace with the official logo |
| Photography | None supplied; the site uses SVG illustrations (solar array, thermal examples) labelled where relevant. Replace with real, approved photos via `astro:assets` `<Image>` |
| About page mission, vision and values | **Draft copy** written from the brief — needs VK Solar’s approval |
| Service descriptions | Written from general industry practice — review for accuracy against what VK Solar actually provides |
| Home-page “trained technicians” benefit | Taken from the brief — confirm it is accurate |

## Accessibility & quality

- Target: WCAG 2.1 AA. All pages pass axe-core’s WCAG 2.1 A/AA rules in the test suite (automated checks can’t catch
  everything — a manual screen-reader pass is still recommended).
- Brand-colour adjustments for contrast: supporting text uses `#5C6B80` instead of `#718096` (which is 4.02:1 on white),
  and the CTA gradient starts at `#3A6A8F` instead of `#4A7FA7` (white text on `#4A7FA7` is 4.30:1). `#4A7FA7` is still
  used for icons, borders and focus rings, where 3:1 applies.
- Keyboard: skip link, visible focus, focus-trapped mobile menu with Escape, accessible tabs and dialog.
- `prefers-reduced-motion` disables reveal, float and count-up animations.

## Deployment

**Not deployed, and no hosting provider has been chosen yet.** The build is static (`dist/`) and can be hosted on any
static host. Set the two environment variables in the host’s build settings.

### Security headers — where they actually apply

`public/_headers` defines a Content-Security-Policy, `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
`Permissions-Policy`, `X-Frame-Options: DENY`, and immutable caching for `/_astro/*`. That file format is only honoured
by some hosts:

| Host | Does `_headers` apply? | What to do |
|---|---|---|
| Netlify | Yes | Nothing |
| Cloudflare Pages | Yes | Nothing |
| Vercel | **No** | Copy the values into `vercel.json` → `headers` |
| GitHub Pages | **No — custom headers aren’t supported** | Put a CDN (e.g. Cloudflare) in front, or accept no CSP |
| S3 + CloudFront, Nginx, Apache, others | **No** | Configure the same headers in the CDN/server |

The CSP was verified by injecting it into every page in Chromium (no violations; menu, lightbox, form and fonts all
worked). It has **not** been verified on a live host — after deploying, check the response headers with your browser’s
dev tools or `curl -I`.
