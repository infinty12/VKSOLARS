/**
 * Enquiry form rules — shared by the form markup (limits, attributes), the client-side
 * validator and the server endpoint (src/pages/api/enquiries.ts), so all three always agree.
 * Must stay free of server-only imports: it is bundled into the browser script.
 */

export const LIMITS = {
  nameMin: 2,
  nameMax: 80,
  phoneMax: 20,
  emailMax: 120,
  locationMin: 2,
  locationMax: 120,
  messageMax: 1000,
} as const;

/** Hidden spam-trap field: invisible to people, often filled in by bots. */
export const HONEYPOT_FIELD = 'hp_company';

/** The exact consent wording shown next to the checkbox. Stored with each enquiry. */
export const CONSENT_TEXT = 'I agree to VK Solar contacting me by phone or email about this enquiry.';

export interface EnquiryValues {
  name: string;
  phone: string;
  email: string;
  service: string;
  region: string;
  location: string;
  message: string;
  consent: boolean;
}

export type EnquiryErrors = Partial<Record<keyof EnquiryValues, string>>;

export interface EnquiryOptions {
  serviceSlugs: readonly string[];
  regionCodes: readonly string[];
}

/** Strip spaces, dashes and brackets; keep a leading +. */
export function normalisePhone(raw: string) {
  return raw.trim().replace(/[\s\-().]/g, '');
}

/** Indian mobile (10 digits starting 6–9, optional +91/91/0 prefix) or landline with STD code (10–11 digits starting 0). */
export function isValidIndianPhone(raw: string) {
  const p = normalisePhone(raw);
  return /^(?:\+?91|0)?[6-9]\d{9}$/.test(p) || /^0\d{9,10}$/.test(p);
}

/** Pragmatic email check: one @, no spaces, a dot in the domain. */
export function isValidEmail(raw: string) {
  return /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i.test(raw);
}

/** Trim, collapse whitespace (keeping line breaks in multi-line text) and drop control characters. */
export function cleanField(value: unknown, multiline = false): string {
  const s = String(value ?? '').replace(/\r\n?/g, '\n');
  const noControls = s.replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, ' ');
  if (!multiline) return noControls.replace(/\s+/g, ' ').trim();
  return noControls
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Normalised copy of the values, as the server stores them. */
export function normaliseEnquiry(values: Partial<Record<keyof EnquiryValues, unknown>>): EnquiryValues {
  return {
    name: cleanField(values.name),
    phone: cleanField(values.phone),
    email: cleanField(values.email).toLowerCase(),
    service: cleanField(values.service),
    region: cleanField(values.region),
    location: cleanField(values.location),
    message: cleanField(values.message, true),
    consent: values.consent === true || values.consent === 'on' || values.consent === 'true',
  };
}

export function validateEnquiry(values: EnquiryValues, opts: EnquiryOptions): EnquiryErrors {
  const errors: EnquiryErrors = {};
  const name = values.name.trim();
  const location = values.location.trim();
  const message = values.message.trim();
  const email = values.email.trim();

  if (!name) errors.name = 'Enter your name.';
  else if (name.length < LIMITS.nameMin) errors.name = `Name must be at least ${LIMITS.nameMin} characters.`;
  else if (name.length > LIMITS.nameMax) errors.name = `Name must be ${LIMITS.nameMax} characters or fewer.`;

  if (!values.phone.trim()) errors.phone = 'Enter a phone number so we can arrange your inspection.';
  else if (values.phone.length > LIMITS.phoneMax || !isValidIndianPhone(values.phone))
    errors.phone = 'Enter a valid Indian phone number, for example 98765 43210.';

  if (email && (email.length > LIMITS.emailMax || !isValidEmail(email)))
    errors.email = 'Enter a valid email address, for example name@example.com, or leave it empty.';

  if (!values.service) errors.service = 'Choose the service you need, or “Not sure”.';
  else if (!opts.serviceSlugs.includes(values.service)) errors.service = 'Choose a service from the list.';

  if (!values.region) errors.region = 'Choose your state or union territory.';
  else if (!opts.regionCodes.includes(values.region)) errors.region = 'Choose a state or union territory from the list.';

  if (!location) errors.location = 'Enter your city, town or site location.';
  else if (location.length < LIMITS.locationMin) errors.location = 'Location is too short.';
  else if (location.length > LIMITS.locationMax) errors.location = `Location must be ${LIMITS.locationMax} characters or fewer.`;

  if (message.length > LIMITS.messageMax) errors.message = `Message must be ${LIMITS.messageMax} characters or fewer.`;

  if (!values.consent) errors.consent = 'Please confirm we may contact you about this enquiry.';

  return errors;
}
