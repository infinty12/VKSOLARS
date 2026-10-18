# VK Solar High-Tech Power Solution — website

Website for VK Solar: solar panel cleaning, preventive maintenance, AI drone inspection and related services, with a
local admin panel for **service-area coverage across India** and an **enquiry inbox**.

**Stack:** [Astro 7.4](https://astro.build) with the Node adapter (`@astrojs/node`) · TypeScript (strict) · SQLite via
Node’s built-in `node:sqlite` · plain CSS design tokens · Playwright + axe-core tests.

- Content pages (`/`, `/services`, `/ai-drone-inspection`, `/about`, 404) are **pre-rendered** static HTML.
- `/service-areas`, `/contact`, `/api/enquiries` and `/admin/**` are **server-rendered** and read the database.
- Everything runs locally. **Not deployed.** The admin is reachable only from this computer by default.

---

## Requirements

- Node.js **22.22.0 or newer** (developed on Node 24.22; `node:sqlite` and native TypeScript in scripts are used)
- npm 9.6.5+
- Windows, macOS or Linux (commands below are for Windows PowerShell; they work the same in other shells)

## First-time setup

```powershell
npm install
npm run test:install          # one-time: Playwright's Chromium, for tests only
Copy-Item .env.example .env   # then edit .env (see Configuration)
npm run build
npm run db:migrate            # creates storage\vk-solar.db and applies migrations
npm run admin:create          # asks for a username and a password (hidden input, min 12 chars)
npm start                     # http://127.0.0.1:4321  — admin at http://127.0.0.1:4321/admin
```

Stop the server with **Ctrl+C**. To restart after code changes: `npm run build`, then `npm start` again.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server with hot reload (no security headers; uses `./storage`) |
| `npm run build` | Production build to `dist/` (server + pre-rendered pages) |
| `npm start` | Run the built site with security headers via `server.mjs` (loads `.env`) |
| `npm run preview` | Same as `npm start` |
| `npm run db:migrate` | Apply pending database migrations (safe to repeat) |
| `npm run admin:create` | Create the first administrator; `npm run admin:create -- --reset <name>` sets a new password |
| `npm run check` | Astro + TypeScript diagnostics |
| `npm run lint` | ESLint |
| `npm run contrast` | WCAG contrast check of every colour pair the design system uses |
| `npm run tokens` | Design-token integrity check (duplicates, undefined variables, valid CSS, exact brand colours) |
| `npm run snapshot` | Crawl the built site through the real server into `.snapshot/` (disposable storage) |
| `npm run links` | Broken links, missing `#anchors` and `href="#"` placeholders in the snapshot |
| `npm run validate:html` | html-validate over the snapshot |
| `npm run seo` | Titles, descriptions, one `<h1>`, Open Graph, canonical, robots and sitemap in the snapshot |
| `npm run smoke:admin` | Security smoke test of admin, sessions, CSRF, local-only access and the enquiry endpoint |
| `npm run test` | Playwright suite (starts its own servers with disposable storage; run `npm run build` first) |
| `npm run verify` | All of the above in order |

On a low-memory machine run the suite with fewer parallel browsers: `$env:PW_WORKERS=2; npm run verify`.

Tests and the snapshot **never touch `storage/`**: they use throwaway folders (`test-storage*`, `*-test-storage`) that
are wiped on every run and excluded from Git.

## Configuration (`.env`)

| Variable | Purpose | Default |
|---|---|---|
| `PUBLIC_SITE_URL` | Live domain (set at **build** time). Enables canonical URLs, `og:url`/`og:image`, sitemap | unset |
| `STORAGE_DIR` | Database, secret key and backups | `./storage` |
| `ENQUIRIES_ENABLED` | Server switch for public enquiries (see below) | off |
| `APP_SECRET` | Secret for signing form tokens; if unset, a random key is created in `STORAGE_DIR` | auto |
| `HOST` / `PORT` | Network binding | `127.0.0.1` / `4321` |
| `ADMIN_ALLOW_REMOTE` | Allow `/admin` from other machines. **Leave unset.** | off |
| `COOKIE_SECURE` | Force `Secure` cookies (set when served over HTTPS behind a TLS proxy) | off |
| `TRUST_PROXY` | Trust `X-Forwarded-*` headers (only behind a proxy you control) | off |
| `ENQUIRY_RATE_LIMIT_PER_IP` / `_GLOBAL`, `ENQUIRY_MIN_FILL_MS` | Spam limits; defaults 5 per 10 min per address, 100 per hour site-wide, 3 s minimum | — |

`.env`, `storage/` and all databases are excluded from Git. Never commit them.

## Admin panel

Sign in at **http://127.0.0.1:4321/admin** with the account from `npm run admin:create`. There is no public registration
and no default password.

- **Local only:** `/admin` returns 404 to any non-loopback address unless `ADMIN_ALLOW_REMOTE=true`. `server.mjs` binds to
  `127.0.0.1` and ignores `X-Forwarded-*` headers unless `TRUST_PROXY=true`.
- **Sessions:** HttpOnly, SameSite=Strict cookie; 2 hours idle / 12 hours maximum; only a hash of the token is stored.
  Changing a password (`admin:create -- --reset`) signs that account out everywhere.
- **CSRF:** every state-changing admin request needs the session’s token; cross-site form posts are rejected.
- **Login:** scrypt password hashes, one generic error message, lockout for 15 minutes after 5 failures.
- **Audit log:** sign-ins, location and enquiry changes are recorded (ids and counts only — never enquiry content). The
  dashboard shows recent activity.

### Service Areas (India-wide coverage)

All 28 states and 8 union territories are pre-loaded from the Government of India list
([knowindia.india.gov.in](https://knowindia.india.gov.in/states-uts/); names of administrative divisions are public facts,
no third-party dataset or licence). **No coverage is pre-filled** and no city directory is imported — every location is
added by an administrator.

Each location has a state/UT, optional district and city (both empty = the whole state/UT), a status, optional services
and a public note.

| Status | Shown publicly when published? | Presented as |
|---|---|---|
| Coverage available | Yes | an active service location |
| Limited coverage | Yes | an active service location (with its note) |
| Planned | Yes, in a separate “Planned — not yet available” list | **not** available |
| Not yet confirmed | **Never** — cannot be published (blocked by the form, the server and a database constraint) | — |

Unpublished and deleted locations never appear. Duplicates (same state/UT, district and city, ignoring case and spaces)
are rejected. The public `/service-areas` page has search and a state filter that work without JavaScript.

### Enquiries

The contact form posts to `POST /api/enquiries`, which stores enquiries in the local database for the admin inbox.
**No email is sent and no third-party service is used.**

**Submissions are off by default.** They are accepted only when **both** are on:

1. the server switch `ENQUIRIES_ENABLED=true` in `.env` (restart `npm start` after changing it), and
2. the admin switch **Admin → Enquiries → Enquiry settings → Accept enquiries**.

Until then the contact page shows “Online enquiries are not active yet”, the browser does not send anything, and the
server refuses submissions (`503`) without storing them.

To turn enquiries on locally: set `ENQUIRIES_ENABLED=true` in `.env`, `npm start`, sign in, tick **Accept enquiries**,
then submit a test enquiry from `/contact` and check it appears in the inbox. When hosting later, set
`ENQUIRIES_ENABLED` in the host’s environment, serve over HTTPS and set `COOKIE_SECURE=true`.

Every submission must pass, in order: switches on → same-origin request → size limit (16 KB) → hidden honeypot empty →
signed form token (issued by `/contact`, at least 3 s and at most 24 h old) → rate limits → server-side validation (the
same rules as the browser, in `src/lib/enquiry.ts`). Only then is it stored, with parameterised queries. Visitors only ever
see fixed messages — never database errors. A success message is shown **only after the server confirms the enquiry was
stored**, with its reference (e.g. `ENQ-20261018-1A2B3C`). The form also works without JavaScript.

Fields: name, phone (Indian mobile or landline), email (optional), service, state/UT, city/site location, message
(optional) and a required consent checkbox. The exact consent wording is stored with each enquiry.

**Inbox** (Admin → Enquiries): search, status filter (New / In progress / Resolved), pagination, detail view, status
changes, internal notes (admin-only, never shown to the customer) and delete with confirmation.

**Retention policy:** resolved enquiries are kept for **365 days** after resolution by default (adjustable, 30–3650 days,
in Enquiry settings). **Nothing is deleted automatically.** The inbox shows how many resolved enquiries are past the
policy, and an admin deletes them after a preview of the exact count and a confirmation; the deletion is audit-logged.
New and In-progress enquiries are never affected. Delete individual enquiries at any time when the details are no longer
needed or the person asks.

## Database, migrations and backups

- File: `storage\vk-solar.db` (SQLite, WAL mode). Migrations live in `src/lib/server/migrations.ts` and are applied in
  order by `npm run db:migrate` (and automatically on first server start). Migrations are append-only: never edit one
  that has shipped.
- **Back up** while the server is stopped (Ctrl+C), by copying the whole storage folder:

  ```powershell
  Copy-Item -Recurse storage "backups\storage-$(Get-Date -Format yyyyMMdd-HHmmss)"
  ```

  The folder contains customer enquiries — keep backups private and out of Git (`backups/` is ignored).
- **Restore:** stop the server, move the current `storage` aside, copy the backup folder back to `storage`, run
  `npm run db:migrate`, then `npm start`.
- A built-in backup/restore command is not part of this stage yet.

## Business information — `src/config/site.ts`

Company facts shown on the static pages come from this one file, and **anything left `null` or empty is hidden** — the site
never shows invented data. (Service coverage and enquiries are in the database instead, managed in the admin.)

| Field | Shows up as |
|---|---|
| `contact.phone` / `phoneDisplay` | Header call link (wide screens), mobile floating call button, footer, contact page, CTA buttons |
| `contact.whatsapp` | Floating WhatsApp button, footer, contact page |
| `contact.email`, `address`, `hours` | Footer and contact page; `address` also upgrades JSON-LD to `LocalBusiness` |
| `social.*` | Footer social links |
| `stats` | Home and About statistics band (hidden while empty) |
| `testimonials` | Home testimonials (hidden while empty; each must have `approved: true`) |
| `team`, `achievements` | About page (a clearly marked “coming soon” note shows while `team` is empty) |
| `founded` | JSON-LD `foundingDate` |

## AI drone dashboard

The dashboard on `/ai-drone-inspection` is a **demonstration** using invented numbers from
`src/data/sampleInspection.ts`, permanently labelled “Illustrative sample data — not live telemetry.” There is no drone
API or telemetry feed.

## Content to confirm before launch

| Item | Status |
|---|---|
| Phone, WhatsApp, email, office address, hours | **Not provided** — hidden |
| Live domain | **Not provided** — canonical/sitemap disabled |
| Confirmed service locations | **Not provided** — add them in Admin → Service Areas |
| Company statistics, testimonials | **Not provided** — sections hidden |
| Team profiles, certifications, founding year | **Not provided** — About shows a “coming soon” note |
| Logo, photography | Placeholder logo and SVG illustrations — replace with official assets |
| About page mission, vision and values; service descriptions | **Draft copy** — needs VK Solar’s approval |
| Home, About and Services pages still mention Rajasthan | Review wording now that coverage is India-wide |

## Accessibility & quality

- Target: WCAG 2.1 AA. Public pages and the admin pass axe-core’s WCAG 2.1 A/AA rules in the test suite (automated checks
  can’t catch everything — a manual screen-reader pass is still recommended).
- Brand palette: Midnight Navy `#021024`, Deep Solar Blue `#052659`, Steel Blue `#5483B3`, Soft Blue `#7DA0CA`, Ice Blue
  `#C1E8FF`, all defined in `src/styles/tokens.css`. Steel Blue is used for icons, borders and focus rings only (3.98:1 on
  white); Soft and Ice Blue are decorative/background only.
- Keyboard: skip links, visible focus, focus-trapped mobile menu, accessible tabs and dialogs.
- `prefers-reduced-motion` disables reveal, float and count-up animations.

## Deployment

**Not deployed, and no hosting provider has been chosen.** The site now needs a **Node.js host** (it runs `server.mjs`);
static-only hosts such as GitHub Pages or plain Netlify/Cloudflare Pages hosting can no longer serve it.

`server.mjs` sends the security headers itself on every response: a Content-Security-Policy (`'self'` only, no
third-party connections), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options: DENY` and
`Cross-Origin-Opener-Policy`. `public/_headers` from the earlier static setup is no longer used.

Before any deployment: serve over HTTPS, set `COOKIE_SECURE=true`, keep `ADMIN_ALLOW_REMOTE` unset (or put the admin behind
additional access control), set `TRUST_PROXY=true` only behind a proxy you control, and back up `storage/` regularly.
