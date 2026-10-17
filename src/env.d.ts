/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Set by middleware for authenticated /admin requests. */
    admin?: {
      user: import('./lib/server/auth.ts').AdminUser;
      csrfToken: string;
    };
  }
}
