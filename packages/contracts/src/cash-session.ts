/**
 * The till — `cash_session.open` and `cash_session.close` (04 §4.8a, 08 §8.2a).
 *
 * Both are TRADE writes that ride the device's ordered outbox like a sale:
 * a till opened offline at 07:00 has to be on the server before the sales
 * rung into it are, and the outbox is what guarantees that order. So both
 * carry the mutation envelope (client idempotency key + claimed HLC,
 * CLAUDE.md §2.2) and both are registered in `deviceOpContracts`.
 *
 * ── THE SESSION'S ID IS THE OPEN'S IDEMPOTENCY KEY ────────────────────────
 * The device mints one UUIDv7 when the till is opened, uses it as the open's
 * idempotency key, and quotes it as `cashSessionId` on every sale and on the
 * close. The server stores `app.cash_session.id` = that key. One identifier,
 * minted offline, so a sale can name its till before the server has heard of
 * either — and a replayed open is the same session, never a second one.
 *
 * ── WHAT IS NOT ON THE WIRE ───────────────────────────────────────────────
 * No device id, no user id: `device_id` and `opened_by` come from the
 * verified token, server-side (02 §2.2 "five identifiers that never come from
 * the client"). The DRAWER choice is a platform enum — whose drawer this is —
 * not an identity.
 *
 * No expected cash as a FACT. `clientExpectedMinor` is what the device showed
 * the cashier, recorded beside the server's own figure so a divergence is
 * visible; it is never what the variance is computed from (the same rule as
 * `clientTotalMinor` on a sale).
 */
import { z } from 'zod';
import { mutationEnvelope, zBusinessDate, zScaledIntNonNeg, zUuid } from './wire.js';

/**
 * Whose drawer the session is.
 *  - DEVICE: this device's own drawer (the server records the token's device).
 *  - SHARED: the location's shared drawer, which any device there may ring
 *    into. Two devices claiming it for one day while offline is §3.6 class
 *    #17 — it lands, and goes to review.
 */
export const CASH_DRAWERS = ['DEVICE', 'SHARED'] as const;
export type CashDrawer = (typeof CASH_DRAWERS)[number];

/**
 * §8.2a: online, the open is refused more than this many days from the
 * server's own date at the location. A platform tolerance, not a tenant's.
 */
export const CASH_SESSION_DATE_TOLERANCE_DAYS = 1;

export const openCashSessionInput = z
  .object({
    ...mutationEnvelope,
    locationId: zUuid,
    /** The trading day, asserted by a person and shown to them large (08 §8.2a). */
    businessDate: zBusinessDate,
    /** The counted opening float, minor units, as a decimal string. */
    openingFloatMinor: zScaledIntNonNeg,
    /** Device clock at open. UNTRUSTED — display only. */
    openedAt: z.string().datetime({ offset: true }),
    /** True when the device could not validate the date against the server. */
    openedOffline: z.boolean(),
    drawer: z.enum(CASH_DRAWERS).default('DEVICE'),
  })
  .strict();

export type OpenCashSessionInput = z.input<typeof openCashSessionInput>;
export type OpenCashSessionParsed = z.output<typeof openCashSessionInput>;

export const closeCashSessionInput = z
  .object({
    ...mutationEnvelope,
    locationId: zUuid,
    cashSessionId: zUuid,
    /** Device clock at close. UNTRUSTED — display only. */
    closedAt: z.string().datetime({ offset: true }),
    /**
     * The midnight close (08 §8.2a): nobody counted, so there is no count and
     * nothing banked. A person's close always carries a count.
     */
    autoClosed: z.boolean(),
    countedMinor: zScaledIntNonNeg.optional(),
    /** Taken out of the drawer for the bank at close (05 §5.6.2 rule 11). */
    bankedMinor: zScaledIntNonNeg.optional(),
    /** What the device showed as expected. Recorded, compared, never used. */
    clientExpectedMinor: zScaledIntNonNeg.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.autoClosed) {
      if (v.countedMinor !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['countedMinor'],
          message: 'an automatic close counts nothing — nobody was there to count' });
      }
      if (v.bankedMinor !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bankedMinor'],
          message: 'an automatic close banks nothing' });
      }
      return;
    }
    if (v.countedMinor === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['countedMinor'],
        message: 'closing a till needs the counted cash' });
      return;
    }
    if (v.bankedMinor !== undefined && v.bankedMinor > v.countedMinor) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bankedMinor'],
        message: 'cannot bank more than was counted in the drawer' });
    }
  });

export type CloseCashSessionInput = z.input<typeof closeCashSessionInput>;
export type CloseCashSessionParsed = z.output<typeof closeCashSessionInput>;

/**
 * The online half of §8.2a's open rules, asked BEFORE the open is queued: the
 * server's own date at the location, and the state of the accounting period
 * covering the proposed day. A read, so it is not an outbox op; a device that
 * cannot reach it opens offline and says so (`openedOffline`).
 */
export const cashSessionOpenCheckInput = z
  .object({
    locationId: zUuid,
    businessDate: zBusinessDate,
  })
  .strict();

export type CashSessionOpenCheckInput = z.input<typeof cashSessionOpenCheckInput>;

/** The answer, typed once so both sides read the same shape. */
export interface CashSessionOpenCheck {
  /** The server's calendar date AT THE LOCATION (its timezone, not UTC). */
  readonly serverDate: string;
  readonly toleranceDays: number;
  /** The accounting period covering the proposed date, or null when none is defined. */
  readonly periodStatus: 'open' | 'closed' | 'locked' | null;
  /** Null when the open may proceed; otherwise the sentence to show. */
  readonly refusal: string | null;
}
