/**
 * The customer-credit wire contracts — `credit.open_account` and
 * `credit.record_entry`.
 *
 * Both lived privately in `apps/api/src/routers/credit.ts`, declared on one
 * side of the wire only. There is no PWA builder for either yet; they are
 * here so that the one someone writes next imports a declaration instead of
 * inventing a shape, which is the whole of how the sale-payload bug happened.
 *
 * Money crosses as decimal STRINGS of minor units and becomes `bigint` here
 * (ADR-0004); `.strict()` everywhere, so `tenant_id` in a payload fails loudly
 * (CLAUDE.md §2.1).
 *
 * What is deliberately NOT here: the facility fee's rate table, its day-count
 * convention or any accrual arithmetic. `feeRateBpPerMonth` is a per-ACCOUNT
 * tenant setting carried on the wire, not a platform rate (ADR-0006), and the
 * accrual itself is a server-side operation behind the Q4 policy gate —
 * never a device write.
 */
import { z } from 'zod';
import { mutationEnvelope, zBusinessDate, zScaledInt, zScaledIntNonNeg, zUuid } from './wire.js';

export const openAccountInput = z
  .object({
    ...mutationEnvelope,
    customerId: zUuid.optional(),
    newCustomer: z
      .object({
        code: z.string().min(1).max(64),
        name: z.string().min(1),
        phone: z.string().optional(),
      })
      .strict()
      .optional(),
    termsDays: z.number().int().min(0).max(365),
    /** Basis points per month, per ACCOUNT (ADR-0006). 2%/month = 200. */
    feeRateBpPerMonth: z.number().int().min(0).max(10_000),
    creditLimitMinor: zScaledIntNonNeg,
  })
  .strict()
  .refine((v) => (v.customerId === undefined) !== (v.newCustomer === undefined), {
    message: 'provide exactly one of customerId or newCustomer',
  });

/**
 * Entry kinds a device may record. FEE is absent deliberately: fee entries are
 * accrual-only, written server-side behind the policy gate (06 §6.4.5), and a
 * till that could post one would be calculating a charge it has no authority
 * to calculate.
 */
export const CREDIT_ENTRY_KINDS = ['CHARGE', 'PAYMENT', 'ADJUSTMENT', 'WRITE_OFF'] as const;
export type CreditEntryKind = (typeof CREDIT_ENTRY_KINDS)[number];

export const recordEntryInput = z
  .object({
    ...mutationEnvelope,
    accountId: zUuid,
    kind: z.enum(CREDIT_ENTRY_KINDS),
    /** SIGNED minor units: CHARGE > 0, PAYMENT/WRITE_OFF < 0 (ce_sign). */
    amountMinor: zScaledInt.refine((v) => v !== 0n, 'amount must be non-zero'),
    businessDate: zBusinessDate,
    dueDate: zBusinessDate.optional(),
    appliesToId: zUuid.optional(),
  })
  .strict();

export type OpenAccountInput = z.input<typeof openAccountInput>;
export type OpenAccountParsed = z.output<typeof openAccountInput>;
export type RecordEntryInput = z.input<typeof recordEntryInput>;
export type RecordEntryParsed = z.output<typeof recordEntryInput>;
