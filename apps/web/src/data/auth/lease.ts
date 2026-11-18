/**
 * The offline lease, enforced on the device (02-security §2.7).
 *
 *   full        0 → full_until (T, default 72 h): everything the user's
 *               permissions allow whose offline_mode is until_lease_expiry or
 *               always.
 *   restricted  full_until → hard_stop_at (+24 h): offline_mode = always only —
 *               cash at the list price, lookups, reprints. No credit, no
 *               adjustments. "The outlet keeps taking money; it stops taking
 *               risk." A banner shows the time left and how to restore.
 *   sealed      after hard_stop_at, or on tampering: READ-ONLY. Never wiped —
 *               the outbox survives until a server authentication reopens it.
 *
 * ENFORCING EXPIRY AGAINST A CLOCK THE DEVICE CONTROLS IS CIRCULAR, so the
 * horizon is whichever of these fires FIRST:
 *   · the wall clock passes the horizon;
 *   · MONOTONIC elapsed since the lease arrived passes it (performance.now —
 *     boot/page relative, not settable by changing the date). A reload resets
 *     the monotonic reference, so on a cold start only the wall clock and the
 *     backwards-jump check apply — exactly §2.7's stated fallback;
 *   · the wall clock jumps BACKWARDS past the last value recorded — prima facie
 *     tampering, and the device seals immediately.
 *
 * A lease that does not verify against the pinned lease keys is NOT honoured
 * for extension and does NOT seal: the device keeps the horizons of the last
 * lease it did verify and says "cannot verify server response". Sealing on an
 * unverifiable lease would turn a key-rotation slip into a fleet outage.
 *
 * Pure functions over explicit clocks, so every horizon is unit-tested.
 */
import { leaseClaims, type LeaseClaims } from '@erp/contracts';
import { verifyEs256 } from './webcrypto';

export type LeaseMode = 'full' | 'restricted' | 'sealed';

export interface LeaseClock {
  /** Date.now() */
  readonly wallMs: number;
  /** performance.now() — monotonic, page-relative. */
  readonly monoMs: number;
}

/** What the device keeps about the lease it last VERIFIED. */
export interface HeldLease {
  readonly jws: string;
  readonly claims: LeaseClaims;
  /** Wall clock when it arrived — evidence only. */
  readonly receivedWallMs: number;
  /**
   * Monotonic reading when it arrived, valid only within the SAME page
   * lifetime (`pageId`). A different page → monotonic unavailable.
   */
  readonly receivedMonoMs: number;
  readonly pageId: string;
}

export interface LeaseVerdict {
  readonly mode: LeaseMode;
  /** Why — for the banner and for the security log. */
  readonly reason:
    | 'within_full'
    | 'past_full_until'
    | 'past_hard_stop'
    | 'clock_moved_backwards'
    | 'no_lease';
  /** Seconds until the next horizon, by the stricter of the two clocks. Null when sealed. */
  readonly secondsLeft: number | null;
}

/** Tolerance for an ordinary NTP correction before a backwards step counts as tampering. */
export const BACKWARDS_TOLERANCE_MS = 5 * 60 * 1000;

/** Verify a lease JWS against the pinned lease keys. Null = not honoured. */
export async function verifyLease(
  jws: string,
  pinnedKeys: readonly Record<string, unknown>[],
): Promise<LeaseClaims | null> {
  const verified = await verifyEs256(jws, pinnedKeys);
  if (!verified || verified.header['typ'] !== 'erp-lease+jwt') return null;
  const parsed = leaseClaims.safeParse(verified.payload);
  if (!parsed.success) return null;
  const c = parsed.data;
  if (!(c.issued_at < c.full_until && c.full_until <= c.hard_stop_at)) return null;
  return c;
}

/**
 * The verdict for `held` at `now`, given the largest wall-clock value this
 * device has ever recorded (persisted across reloads).
 */
export function leaseVerdict(
  held: HeldLease | null,
  now: LeaseClock,
  lastWallMs: number | null,
  pageId: string,
): LeaseVerdict {
  if (held === null) return { mode: 'sealed', reason: 'no_lease', secondsLeft: null };
  if (lastWallMs !== null && now.wallMs < lastWallMs - BACKWARDS_TOLERANCE_MS) {
    return { mode: 'sealed', reason: 'clock_moved_backwards', secondsLeft: null };
  }
  const c = held.claims;
  const T = (c.full_until - c.issued_at) * 1000;
  const H = (c.hard_stop_at - c.issued_at) * 1000;
  // Elapsed since issue: the wall clock's view, and — same page only — the
  // monotonic view anchored at arrival. Take the LARGER (the stricter).
  const wallElapsed = now.wallMs - c.issued_at * 1000;
  const monoElapsed =
    held.pageId === pageId ? now.monoMs - held.receivedMonoMs + Math.max(0, held.receivedWallMs - c.issued_at * 1000) : -Infinity;
  const elapsed = Math.max(wallElapsed, monoElapsed);
  if (elapsed >= H) return { mode: 'sealed', reason: 'past_hard_stop', secondsLeft: null };
  if (elapsed >= T) {
    return { mode: 'restricted', reason: 'past_full_until', secondsLeft: Math.floor((H - elapsed) / 1000) };
  }
  return { mode: 'full', reason: 'within_full', secondsLeft: Math.floor((T - elapsed) / 1000) };
}

/**
 * May this capability be exercised offline under this verdict? §2.4's
 * offline_mode, read from the lease (the server partitioned the user's codes
 * by it — `platform.permission` is the single source).
 */
export function offlineAllows(verdict: LeaseVerdict, claims: LeaseClaims | null, code: string): boolean {
  if (claims === null || verdict.mode === 'sealed') return false;
  if (claims.offline.always.includes(code)) return true;
  return verdict.mode === 'full' && claims.offline.until_lease_expiry.includes(code);
}

/** "2 h 15 min" — the banner's countdown. */
export function describeRemaining(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)} d ${h % 24} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${Math.max(m, 0)} min`;
}
