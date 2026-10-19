/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Set by middleware for authenticated /admin requests. */
    admin?: {
      user: import('./lib/server/auth.ts').AdminUser;
      csrfToken: string;
    };
    /** Published business details for public pages (set by middleware; drafts only on the admin preview). */
    business?: import('./config/site.ts').BusinessDetails;
    /** Draft statistics/testimonials/team/achievements — set ONLY by the admin content preview page. */
    contentPreview?: import('./lib/server/content-items.ts').PublicContent;
  }
}
