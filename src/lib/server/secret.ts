import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

let cached: Buffer | null = null;

/**
 * HMAC key for signed form tokens. Uses APP_SECRET if set; otherwise creates a random key
 * once in storage/secret.key (excluded from Git) so tokens survive restarts.
 */
export function appSecret(): Buffer {
  if (cached) return cached;
  if (config.appSecret) {
    cached = Buffer.from(config.appSecret, 'utf8');
    return cached;
  }
  mkdirSync(config.storageDir, { recursive: true });
  const file = join(config.storageDir, 'secret.key');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
  cached = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  return cached;
}

export const sign = (data: string) => createHmac('sha256', appSecret()).update(data).digest('base64url');

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
