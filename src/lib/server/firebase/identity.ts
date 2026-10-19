/**
 * Firebase Authentication email/password calls made from the SERVER (Identity Toolkit REST API).
 * The browser only ever posts to our own pages; no Firebase script runs in the browser.
 */
import { getFirebaseConfig } from './config.ts';

export type IdentityError =
  | 'email_exists'
  | 'invalid_credentials'
  | 'weak_password'
  | 'too_many_attempts'
  | 'signup_disabled'
  | 'user_disabled'
  | 'unavailable';

export const IDENTITY_MESSAGES: Record<IdentityError, string> = {
  email_exists: 'An account with this email already exists. Sign in instead.',
  invalid_credentials: 'Incorrect email or password.',
  weak_password: 'Choose a stronger password (at least 8 characters).',
  too_many_attempts: 'Too many attempts. Please wait a few minutes and try again.',
  signup_disabled: 'Registration is not available at the moment.',
  user_disabled: 'This account has been disabled. Please contact us.',
  unavailable: 'Sign-in is temporarily unavailable. Please try again later.',
};

function mapError(code: string): IdentityError {
  if (code.startsWith('EMAIL_EXISTS')) return 'email_exists';
  if (/INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND|INVALID_EMAIL/.test(code)) return 'invalid_credentials';
  if (code.startsWith('WEAK_PASSWORD')) return 'weak_password';
  if (code.startsWith('TOO_MANY_ATTEMPTS')) return 'too_many_attempts';
  if (code.startsWith('OPERATION_NOT_ALLOWED') || code.startsWith('ADMIN_ONLY_OPERATION')) return 'signup_disabled';
  if (code.startsWith('USER_DISABLED')) return 'user_disabled';
  return 'unavailable';
}

async function call(endpoint: 'signUp' | 'signInWithPassword', email: string, password: string) {
  const { webApiKey } = getFirebaseConfig();
  try {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${endpoint}?key=${encodeURIComponent(webApiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { idToken?: string; localId?: string; error?: { message?: string } };
    if (!res.ok || !data.idToken || !data.localId) return { ok: false as const, error: mapError(data.error?.message ?? '') };
    return { ok: true as const, idToken: data.idToken, uid: data.localId };
  } catch {
    return { ok: false as const, error: 'unavailable' as const };
  }
}

export const signUpWithPassword = (email: string, password: string) => call('signUp', email, password);
export const signInWithPassword = (email: string, password: string) => call('signInWithPassword', email, password);
