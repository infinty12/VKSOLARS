/**
 * Central business configuration for VK Solar.
 *
 * EVERY company fact shown on the site comes from this file. Leave a value as `null`
 * or an empty array until it is verified — the related UI is then hidden or shown
 * as a clearly marked placeholder. Never fill these with guesses.
 */

export interface Stat {
  /** Numeric value used for the count-up animation, e.g. 250 */
  value: number;
  /** Text shown after the number, e.g. "+" or " MW" */
  suffix?: string;
  label: string;
  /** Where the figure comes from, kept for internal verification. Not displayed. */
  source: string;
}

export interface Testimonial {
  quote: string;
  name: string;
  role?: string;
  organisation?: string;
  /** Must be true — confirms the client approved publication. */
  approved: true;
}

export interface TeamMember {
  name: string;
  role: string;
  bio?: string;
  /** Path under /public, e.g. "/team/name.webp" */
  photo?: string;
}

const env = import.meta.env;

export const site = {
  name: 'VK Solar High-Tech Power Solution',
  shortName: 'VK Solar',
  tagline: 'More Power. Less Worry.',
  headline: 'Clean Energy. Better Future.',
  description:
    'Solar panel cleaning, preventive maintenance, AI drone inspection and performance testing for industrial and commercial solar plants across Rajasthan.',
  region: 'Rajasthan, India',
  locale: 'en_IN',

  /** Live domain, from PUBLIC_SITE_URL. null → no canonical / og:url / sitemap. */
  url: (env.PUBLIC_SITE_URL as string | undefined) || null,

  contact: {
    /** E.164 format, e.g. "+919800000000". null hides call buttons. */
    phone: null as string | null,
    /** Display format, e.g. "+91 98000 00000" */
    phoneDisplay: null as string | null,
    /** WhatsApp number in E.164 without "+", e.g. "919800000000". null hides WhatsApp buttons. */
    whatsapp: null as string | null,
    email: null as string | null,
    /** Full postal address of a real office. null hides the address block. */
    address: null as string | null,
    hours: null as string | null,
  },

  /** Only real profile URLs. null entries are not rendered. */
  social: {
    linkedin: null as string | null,
    instagram: null as string | null,
    facebook: null as string | null,
    youtube: null as string | null,
  },

  // Enquiries are stored in the local database via POST /api/enquiries and read in the admin
  // inbox. Submissions are off unless ENQUIRIES_ENABLED=true and the admin setting is on.

  /** Verified company figures only. Empty → statistics section is hidden. */
  stats: [] as Stat[],

  /** Client-approved testimonials only. Empty → testimonials section is hidden. */
  testimonials: [] as Testimonial[],

  /** Verified team profiles. Empty → "team profiles coming soon" placeholder. */
  team: [] as TeamMember[],

  /** Verified certifications / achievements. Empty → hidden. */
  achievements: [] as string[],

  /** Year the company was founded, once confirmed. */
  founded: null as number | null,

  // Service coverage is NOT configured here: it is managed in the admin panel (Service Areas)
  // and stored in the database, so it can be published without code changes.
} as const;

export const hasPhone = Boolean(site.contact.phone);
export const hasWhatsApp = Boolean(site.contact.whatsapp);
export const hasEmail = Boolean(site.contact.email);

export function whatsappLink(message = `Hello ${site.shortName}, I would like to enquire about your solar services.`) {
  if (!site.contact.whatsapp) return null;
  return `https://wa.me/${site.contact.whatsapp}?text=${encodeURIComponent(message)}`;
}

export function telLink() {
  return site.contact.phone ? `tel:${site.contact.phone}` : null;
}

export const socialLinks = (Object.entries(site.social) as [string, string | null][])
  .filter((entry): entry is [string, string] => Boolean(entry[1]))
  .map(([network, href]) => ({ network, href }));
