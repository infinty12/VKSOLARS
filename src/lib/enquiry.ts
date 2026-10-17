/**
 * Enquiry form rules — shared by the form markup (limits, attributes) and the
 * client-side validator, so both always agree.
 *
 * Note: this site is static. Server-side validation and spam filtering happen at the
 * form provider (Web3Forms). See README → "Contact form" for moving to your own backend.
 */

export const LIMITS = {
  nameMin: 2,
  nameMax: 80,
  locationMin: 2,
  locationMax: 120,
  messageMax: 1000,
} as const;

export interface EnquiryValues {
  name: string;
  phone: string;
  location: string;
  service: string;
  message: string;
}

export type EnquiryErrors = Partial<Record<keyof EnquiryValues, string>>;

/** Strip spaces, dashes and brackets; keep a leading +. */
export function normalisePhone(raw: string) {
  return raw.trim().replace(/[\s\-().]/g, '');
}

/** Indian mobile (10 digits starting 6–9, optional +91/91/0 prefix) or landline with STD code (10–11 digits starting 0). */
export function isValidIndianPhone(raw: string) {
  const p = normalisePhone(raw);
  return /^(?:\+?91|0)?[6-9]\d{9}$/.test(p) || /^0\d{9,10}$/.test(p);
}

export function validateEnquiry(values: EnquiryValues, serviceSlugs: readonly string[]): EnquiryErrors {
  const errors: EnquiryErrors = {};
  const name = values.name.trim();
  const location = values.location.trim();
  const message = values.message.trim();

  if (!name) errors.name = 'Enter your name.';
  else if (name.length < LIMITS.nameMin) errors.name = `Name must be at least ${LIMITS.nameMin} characters.`;
  else if (name.length > LIMITS.nameMax) errors.name = `Name must be ${LIMITS.nameMax} characters or fewer.`;

  if (!values.phone.trim()) errors.phone = 'Enter a phone number so we can arrange your inspection.';
  else if (!isValidIndianPhone(values.phone))
    errors.phone = 'Enter a valid Indian phone number, for example 98765 43210.';

  if (!location) errors.location = 'Enter your city or site location.';
  else if (location.length < LIMITS.locationMin) errors.location = 'Location is too short.';
  else if (location.length > LIMITS.locationMax) errors.location = `Location must be ${LIMITS.locationMax} characters or fewer.`;

  if (!values.service) errors.service = 'Choose the service you need, or “Not sure”.';
  else if (!serviceSlugs.includes(values.service)) errors.service = 'Choose a service from the list.';

  if (message.length > LIMITS.messageMax) errors.message = `Message must be ${LIMITS.messageMax} characters or fewer.`;

  return errors;
}
