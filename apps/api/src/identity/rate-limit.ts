/**
 * Fixed-window rate limiting for enrolment redemption (02 §2.7): 5 attempts
 * per source per hour, 20 per tenant per hour — the tenant limit ALERTING
 * rather than merely refusing.
 *
 * In-process. A deployment with more than one API instance needs these
 * counters in a shared store, and that is named as a production gap rather
 * than pretended away here: per-instance counters multiply the allowance by
 * the instance count.
 */
export interface RateLimiter {
  /** Records one attempt for `key`. True when it is within the limit. */
  hit(key: string, nowMs?: number): boolean;
  /** Attempts recorded for `key` in the current window. */
  count(key: string, nowMs?: number): number;
}

export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const windows = new Map<string, { startMs: number; n: number }>();
  const current = (key: string, now: number) => {
    let w = windows.get(key);
    if (!w || now - w.startMs >= windowMs) {
      w = { startMs: now, n: 0 };
      windows.set(key, w);
    }
    if (windows.size > 50_000) {
      for (const [k, v] of windows) if (now - v.startMs >= windowMs) windows.delete(k);
    }
    return w;
  };
  return {
    hit(key, nowMs = Date.now()) {
      const w = current(key, nowMs);
      w.n += 1;
      return w.n <= limit;
    },
    count(key, nowMs = Date.now()) {
      return current(key, nowMs).n;
    },
  };
}

export const ENROL_PER_SOURCE_PER_HOUR = 5;
export const ENROL_PER_TENANT_PER_HOUR = 20;
export const HOUR_MS = 60 * 60 * 1000;
