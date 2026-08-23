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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CHANGING A CREDIT LIMIT — the brief's most sensitive credit operation
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NOT device-uploadable, and it is important that this is a decision rather
 * than an omission. 06 §6.6.3(7) rules that severity-1 credit resolutions
 * require connectivity, and CLAUDE.md §2.2's canonical hard case is two
 * locations editing the same customer's limit while both offline. A queued
 * limit edit is that case, manufactured: the device cannot see the version it
 * is superseding, so it cannot state one, and a write with no `supersedesId`
 * is last-write-wins wearing a contract. It goes over tRPC and is refused out
 * loud when the device is partitioned.
 *
 * `supersedesId` IS THE COMPARE-AND-SET (06 §6.6.1). It names the version the
 * author had in front of them when they decided. Omitted only for an account
 * that has no version yet. The server refuses a write whose claim does not
 * match the accepted head and answers with the head, so the loser sees the
 * number that won and decides again against it — never a silent overwrite.
 *
 * The fee rate is deliberately absent. It is carried forward from the version
 * in force, because `previewFacilityFee` and `accrueFacilityFee` read the
 * account's CURRENT rate and would reprice history against a new one; an
 * effective-dated fee rate is 06 §6.4 work that is not built.
 */
export const setLimitInput = z
  .object({
    ...mutationEnvelope,
    accountId: zUuid,
    creditLimitMinor: zScaledIntNonNeg,
    termsDays: z.number().int().min(0).max(365),
    /** The trading day this decision applies from. Never in the future. */
    effectiveFrom: zBusinessDate,
    /** Mandatory. A limit that changed for no recorded reason is unauditable. */
    reason: z.string().trim().min(3).max(500),
    /** The version the author believed was current. Absent only for genesis. */
    supersedesId: zUuid.optional(),
  })
  .strict();

/**
 * Which credit account belongs to this customer?
 *
 * Every credit route is addressed by ACCOUNT; everything a device holds is
 * addressed by CUSTOMER, and `app.customer_account` is in no sync bucket — so
 * without this a screen has to make a person type a UUID.
 */
export const accountForCustomerInput = z.object({ customerId: zUuid }).strict();

export type SetLimitInput = z.input<typeof setLimitInput>;
export type SetLimitParsed = z.output<typeof setLimitInput>;
export type AccountForCustomerInput = z.input<typeof accountForCustomerInput>;
