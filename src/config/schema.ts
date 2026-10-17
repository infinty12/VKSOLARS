/**
 * JSON-LD structured data built ONLY from verified fields in site.ts.
 * Fields that are not yet confirmed (address, phone, URL, reviews) are omitted rather than guessed.
 * No ratings or reviews are ever emitted.
 */
import { site, socialLinks } from './site';
import type { Service } from '../data/services';

type Json = Record<string, unknown>;

function compact(obj: Json): Json {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)));
}

const areaServed = { '@type': 'State', name: 'Rajasthan', containedInPlace: { '@type': 'Country', name: 'India' } };

export function organizationSchema(): Json {
  const c = site.contact;
  // LocalBusiness needs a real address; until one is confirmed, publish a plain Organization.
  const type = c.address ? 'LocalBusiness' : 'Organization';
  return compact({
    '@context': 'https://schema.org',
    '@type': type,
    name: site.name,
    alternateName: site.shortName,
    description: site.description,
    url: site.url,
    telephone: c.phone,
    email: c.email,
    address: c.address ?? undefined,
    foundingDate: site.founded ? String(site.founded) : undefined,
    areaServed,
    sameAs: socialLinks.map((s) => s.href),
  });
}

export function serviceSchema(service: Service, path: string): Json {
  return compact({
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: service.title,
    description: service.description,
    serviceType: service.title,
    areaServed,
    provider: compact({ '@type': 'Organization', name: site.name, url: site.url }),
    url: site.url ? new URL(path, site.url).href : undefined,
  });
}
