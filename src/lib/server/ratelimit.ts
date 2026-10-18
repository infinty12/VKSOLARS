/**
 * Small in-memory fixed-window rate limiter. Per process, so counters reset when the server
 * restarts — acceptable for a single local server; use a shared store if you ever run several.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Returns null if allowed, or the number of seconds until the window resets. */
export function hit(key: string, max: number, windowMs: number, now = Date.now()): number | null {
  if (max <= 0) return null;
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  if (b.count >= max) return Math.max(1, Math.ceil((b.resetAt - now) / 1000));
  b.count += 1;
  // Keep memory bounded: drop expired buckets occasionally.
  if (buckets.size > 5000) for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
  return null;
}
