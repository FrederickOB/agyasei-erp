/**
 * Customer credit: accounts, the append-only entry ledger, derived
 * exposure, ageing by days past due, and the facility fee behind the Q4
 * gate (06-customer-credit).
 *
 * Exposure is `sum(credit_entry.amount_minor)` — never a stored counter
 * (§6.2): an append-only log of signed integers is commutative, so two
 * offline batches arriving in either order produce the same sum and credit
 * TRANSACTIONS have no conflict case at all.
 *
 * Ageing buckets are DAYS PAST DUE, not invoice age (§6.3): an invoice
 * ages against the terms snapshotted when it was charged (due_date on the
 * entry), and every bucket means the same thing for a 30-day and a 60-day
 * account. Unapplied payments are on-account credit — a separate line,
 * never silently netted into the oldest bucket.
 *
 * The facility fee (§6.4): rate is bp/month per account; provisional
 * policy defaults are D-1 overdue-only, D-2 simple, D-3 30E/360; the
 * arithmetic is all-bigint with division LAST and truncation toward the
 * customer. Accrual REFUSES to post while the tenant's policy is
 * unconfirmed (§6.4.5 — the Q4 gate, in code); preview computes in shadow
 * mode with every figure labelled provisional.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { openAccountInput, recordEntryInput } from '@erp/contracts';
import { deterministicUuid } from '@erp/db';
import { mulDiv } from '@erp/money';
import { days30, type CreditPolicy } from '../credit-policy.js';
import type { Queryable } from '../db.js';
import { runIdempotent } from '../pipeline.js';
import { permissionProcedure, router } from '../trpc.js';
import {
  addCalendarDays,
  calendarDaysBetween,
  mutationEnvelope,
  wire,
  zBusinessDate,
  zUuid,
} from '../wire.js';

/**
 * The two DEVICE-UPLOADABLE input shapes — `openAccountInput` and
 * `recordEntryInput` — are not defined here. They live in `@erp/contracts`,
 * the one declaration both sides of the wire import, so a device builder
 * cannot be written against a shape this router will reject (see
 * `packages/contracts/src/device-ops.ts` for why that rule exists). The
 * query and accrual inputs below stay local: they are not device writes.
 */

interface EntryRow {
  id: string;
  kind: string;
  amount_minor: string;
  business_date: string;
  due_date: string | null;
  applies_to_id: string | null;
}

async function loadEntries(tx: Queryable, accountId: string, upTo?: string): Promise<EntryRow[]> {
  const res = await tx.query<EntryRow>(
    `select id, kind, amount_minor::text, business_date::text, due_date::text, applies_to_id
     from app.credit_entry
     where account_id = $1 ${upTo ? 'and business_date <= $2::date' : ''}
     order by business_date, id`,
    upTo ? [accountId, upTo] : [accountId],
  );
  return res.rows;
}

async function requireAccount(
  tx: Queryable,
  accountId: string,
): Promise<{ id: string; termsDays: number; feeRateBp: bigint; creditLimitMinor: bigint; status: string }> {
  const res = await tx.query<{
    id: string;
    terms_days: number;
    facility_fee_bp_per_month: string;
    credit_limit_minor: string;
    status: string;
  }>(
    `select id, terms_days, facility_fee_bp_per_month::text, credit_limit_minor::text, status
     from app.customer_account where id = $1 and deleted_at is null`,
    [accountId],
  );
  const row = res.rows[0];
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'credit account not found' });
  return {
    id: row.id,
    termsDays: row.terms_days,
    feeRateBp: BigInt(row.facility_fee_bp_per_month),
    creditLimitMinor: BigInt(row.credit_limit_minor),
    status: row.status,
  };
}

interface FeeAccrual {
  chargeId: string;
  dueDate: string;
  basisMinor: bigint;
  elapsedDays30: number;
  cumulativeMinor: bigint;
  alreadyPostedMinor: bigint;
  deltaMinor: bigint;
}

/**
 * §6.4.3 under the provisional settings: per-invoice, cumulative
 * computation with delta posting — truncation error bounded under one
 * minor unit per invoice FOR ALL TIME, and no allocation remainder exists
 * because the fee is computed at invoice grain.
 *
 *   cumulative = (basis × rate_bp × elapsed30) / (10000 × 30)   -- ÷ LAST,
 *   delta      = cumulative − Σ prior fee entries for the invoice
 *
 * The formula contains no currency scale — no literal 100 anywhere.
 */
function computeFeeAccruals(
  policy: CreditPolicy,
  feeRateBp: bigint,
  entries: EntryRow[],
  asOf: string,
): FeeAccrual[] {
  const appliedNonFee = new Map<string, bigint>();
  const appliedFee = new Map<string, bigint>();
  for (const e of entries) {
    if (!e.applies_to_id) continue;
    const target = e.kind === 'FEE' ? appliedFee : appliedNonFee;
    target.set(e.applies_to_id, (target.get(e.applies_to_id) ?? 0n) + BigInt(e.amount_minor));
  }

  const out: FeeAccrual[] = [];
  for (const e of entries) {
    if (e.kind !== 'CHARGE' || !e.due_date) continue;
    // D-2: feeOnFee=false — fees never enter their own basis.
    const outstanding = BigInt(e.amount_minor) + (appliedNonFee.get(e.id) ?? 0n);
    if (outstanding <= 0n) continue;
    // D-1: overdue only — nothing accrues inside terms (+ grace).
    const accrualStart =
      policy.feeGraceDays > 0 ? addCalendarDays(e.due_date, policy.feeGraceDays) : e.due_date;
    const elapsed = Math.max(0, days30(accrualStart, asOf));
    if (elapsed === 0) continue;
    // ÷ last, truncating toward zero: the sub-minor fraction is always
    // FORGONE, never charged — truncation favours the customer.
    const cumulative = mulDiv(outstanding, feeRateBp * BigInt(elapsed), 10_000n * 30n, 'down');
    const already = appliedFee.get(e.id) ?? 0n;
    const delta = cumulative - already;
    if (delta <= 0n) continue;
    out.push({
      chargeId: e.id,
      dueDate: e.due_date,
      basisMinor: outstanding,
      elapsedDays30: elapsed,
      cumulativeMinor: cumulative,
      alreadyPostedMinor: already,
      deltaMinor: delta,
    });
  }
  return out;
}

function bucketLabels(bounds: readonly number[]): { label: string; from: number; to: number | null }[] {
  const buckets: { label: string; from: number; to: number | null }[] = [
    { label: 'current', from: Number.NEGATIVE_INFINITY, to: 0 },
  ];
  let prev = 0;
  for (const b of bounds) {
    buckets.push({ label: `${prev + 1}-${b}`, from: prev + 1, to: b });
    prev = b;
  }
  buckets.push({ label: `${prev}+`, from: prev + 1, to: null });
  return buckets;
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * WHY EVERY CREDIT WRITE HERE IS `at: 'tenant'`
 * ─────────────────────────────────────────────────────────────────────────
 * A customer's credit account belongs to the TENANT, not to an outlet:
 * `app.customer_account` has no location column, because the contractor who
 * buys cement at Techiman on Monday and at Wenchi on Thursday has ONE
 * exposure and one limit. So there is no location in these requests to check
 * a permission at — and "held somewhere" would be the wrong answer, because
 * it would let a grant made at one outlet reach an object that spans all of
 * them.
 *
 * `at: 'tenant'` requires the capability at the ROOT of the tenant's location
 * tree. Grants expand DOWN the closure (a grant at the Bono region covers
 * every outlet under it; a grant at Techiman covers Techiman), so authority
 * at the root is exactly "over the whole tenant" and a leaf grant can never
 * reach it. That is the location-scoped variant for an object with no
 * location: an outlet manager holding `credit.entry.record` at their own
 * counter is refused here, and Accounts — assigned at the root — is not.
 *
 * Reads are `at: 'any'`: a manager with `credit.view` at their outlet may
 * look a customer up. The tenant boundary on those reads is RLS, which is a
 * different control and is not weakened by this one.
 */
export const creditRouter = router({
  /**
   * Opening an account also SETS A CREDIT LIMIT, so it passes through
   * `credit.limit.change` whenever the limit is non-zero — one of the brief's
   * two hard prohibitions, and the reason it is checked HERE and not only on
   * some future setLimit endpoint. There must be no path to a credit limit
   * that does not pass through that capability; opening an account with
   * GH₵50,000 of headroom is such a path.
   */
  openAccount: permissionProcedure({
    code: 'credit.account.manage',
    at: 'tenant',
  }).input(openAccountInput).mutation(async ({ ctx, input }) => {
    if (input.creditLimitMinor !== 0n) {
      ctx.permissions.requireTenantWide('credit.limit.change');
    }
    const tenantId = ctx.identity.tenantId;
    const key = input.idempotencyKey;
    const result = await runIdempotent(
      { runner: ctx.deps.runner, clock: ctx.deps.clock },
      ctx.identity,
      { op: 'credit.open_account', idempotencyKey: key, claimedHlc: input.claimedHlc, clientWallAt: input.clientWallAt },
      input,
      async (tx) => {
        let customerId = input.customerId ?? deterministicUuid(key, 'customer');
        let createCustomer = false;
        if (input.newCustomer) {
          createCustomer = true;
        } else {
          const cust = await tx.query<{ id: string }>(
            `select id from app.customer where id = $1 and deleted_at is null`,
            [customerId],
          );
          if (!cust.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'customer not found' });
          const existing = await tx.query<{ id: string }>(
            `select id from app.customer_account where customer_id = $1 and deleted_at is null`,
            [customerId],
          );
          if (existing.rows[0]) {
            throw new TRPCError({ code: 'CONFLICT', message: 'customer already has a credit account' });
          }
        }
        const accountId = deterministicUuid(key, 'customer_account');
        const response = {
          accountId,
          customerId,
          termsDays: input.termsDays,
          feeRateBpPerMonth: input.feeRateBpPerMonth,
          creditLimitMinor: wire(input.creditLimitMinor),
        };
        return {
          response,
          apply: async (atx) => {
            if (createCustomer && input.newCustomer) {
              await atx.query(
                `insert into app.customer
                   (tenant_id, id, write_id, hlc, code, name, phone, is_credit_customer)
                 values ($1,$2,$3,$4,$5,$6,$7,true)`,
                [
                  tenantId,
                  customerId,
                  key,
                  ctx.deps.clock.next(),
                  input.newCustomer.code,
                  input.newCustomer.name,
                  input.newCustomer.phone ?? null,
                ],
              );
            }
            await atx.query(
              `insert into app.customer_account
                 (tenant_id, id, write_id, hlc, customer_id, credit_limit_minor,
                  terms_days, facility_fee_bp_per_month, status)
               values ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE')`,
              [
                tenantId,
                accountId,
                key,
                ctx.deps.clock.next(),
                customerId,
                wire(input.creditLimitMinor),
                input.termsDays,
                input.feeRateBpPerMonth,
              ],
            );
          },
        };
      },
    );
    return result.response;
  }),

  recordEntry: permissionProcedure({
    code: 'credit.entry.record',
    at: 'tenant',
  }).input(recordEntryInput).mutation(async ({ ctx, input }) => {
    const tenantId = ctx.identity.tenantId;
    const key = input.idempotencyKey;
    const result = await runIdempotent(
      { runner: ctx.deps.runner, clock: ctx.deps.clock },
      ctx.identity,
      { op: 'credit.record_entry', idempotencyKey: key, claimedHlc: input.claimedHlc, clientWallAt: input.clientWallAt },
      input,
      async (tx) => {
        const account = await requireAccount(tx, input.accountId);
        // The ce_sign convention, checked here for a clear message; the
        // schema CHECK is the backstop.
        if (input.kind === 'CHARGE' && input.amountMinor <= 0n) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'a CHARGE must be positive' });
        }
        if ((input.kind === 'PAYMENT' || input.kind === 'WRITE_OFF') && input.amountMinor >= 0n) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: `${input.kind} must be negative` });
        }
        const dueDate =
          input.kind === 'CHARGE'
            ? input.dueDate ?? addCalendarDays(input.businessDate, account.termsDays)
            : input.dueDate ?? null;
        const entryId = deterministicUuid(key, 'credit_entry');
        const response = {
          entryId,
          accountId: input.accountId,
          kind: input.kind,
          amountMinor: wire(input.amountMinor),
          businessDate: input.businessDate,
          dueDate,
        };
        return {
          response,
          apply: async (atx) => {
            await atx.query(
              `insert into app.credit_entry
                 (tenant_id, id, write_id, hlc, account_id, kind, amount_minor,
                  business_date, due_date, source_kind, source_id, applies_to_id)
               values ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,'MANUAL',null,$10)`,
              [
                tenantId,
                entryId,
                key,
                ctx.deps.clock.next(),
                input.accountId,
                input.kind,
                wire(input.amountMinor),
                input.businessDate,
                dueDate,
                input.appliesToId ?? null,
              ],
            );
          },
        };
      },
    );
    return result.response;
  }),

  /** Exposure = Σ(entries). Derived on every read; never a counter. */
  exposure: permissionProcedure({ code: 'credit.view', at: 'any' })
    .input(z.object({ accountId: zUuid }).strict())
    .query(async ({ ctx, input }) => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const account = await requireAccount(tx, input.accountId);
        const res = await tx.query<{ exposure: string }>(
          `select coalesce(sum(amount_minor), 0)::bigint::text as exposure
           from app.credit_entry where account_id = $1`,
          [input.accountId],
        );
        const exposure = BigInt(res.rows[0]!.exposure);
        return {
          accountId: input.accountId,
          exposureMinor: wire(exposure),
          creditLimitMinor: wire(account.creditLimitMinor),
          availableMinor: wire(account.creditLimitMinor - exposure),
          status: account.status,
        };
      });
    }),

  /** Ageing by DAYS PAST DUE (§6.3), boundaries from the tenant policy. */
  ageing: permissionProcedure({ code: 'credit.view', at: 'any' })
    .input(z.object({ accountId: zUuid, asOf: zBusinessDate }).strict())
    .query(async ({ ctx, input }) => {
      const policy = await ctx.deps.policyStore.get(ctx.identity.tenantId);
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        await requireAccount(tx, input.accountId);
        const entries = await loadEntries(tx, input.accountId, input.asOf);

        const appliedNonFee = new Map<string, bigint>();
        let onAccount = 0n; // unapplied payments/credits (negative sum)
        let feeOutstanding = 0n;
        for (const e of entries) {
          if (e.kind === 'FEE') {
            feeOutstanding += BigInt(e.amount_minor);
            continue;
          }
          if (e.kind === 'CHARGE') continue;
          if (e.applies_to_id) {
            appliedNonFee.set(e.applies_to_id, (appliedNonFee.get(e.applies_to_id) ?? 0n) + BigInt(e.amount_minor));
          } else {
            onAccount += BigInt(e.amount_minor);
          }
        }

        const buckets = bucketLabels(policy.ageingBucketDays);
        const totals = buckets.map(() => 0n);
        const invoices: {
          chargeId: string;
          dueDate: string | null;
          daysPastDue: number;
          outstandingMinor: string;
          bucket: string;
        }[] = [];
        for (const e of entries) {
          if (e.kind !== 'CHARGE') continue;
          const outstanding = BigInt(e.amount_minor) + (appliedNonFee.get(e.id) ?? 0n);
          if (outstanding <= 0n) continue;
          const dpd = e.due_date ? calendarDaysBetween(e.due_date, input.asOf) : 0;
          const idx = buckets.findIndex((b) => dpd >= b.from && (b.to === null || dpd <= b.to));
          const bucket = buckets[idx]!;
          totals[idx] = totals[idx]! + outstanding;
          invoices.push({
            chargeId: e.id,
            dueDate: e.due_date,
            daysPastDue: dpd,
            outstandingMinor: wire(outstanding),
            bucket: bucket.label,
          });
        }

        return {
          accountId: input.accountId,
          asOf: input.asOf,
          agedBy: 'days_past_due' as const, // labelled on every export (§6.3)
          buckets: buckets.map((b, i) => ({ label: b.label, amountMinor: wire(totals[i]!) })),
          /** On-account credit: reduces exposure, belongs to NO bucket. */
          onAccountCreditMinor: wire(-onAccount),
          /** Fee receivable — separate from trade AR (§6.4.4). */
          feeOutstandingMinor: wire(feeOutstanding),
          invoices,
        };
      });
    }),

  /**
   * Shadow-mode computation (§6.4.5): available BEFORE the policy is
   * confirmed, writes nothing, and every figure carries the provisional
   * label — someone will quote a report to a customer.
   */
  previewFacilityFee: permissionProcedure({ code: 'credit.view', at: 'any' })
    .input(z.object({ accountId: zUuid, asOf: zBusinessDate }).strict())
    .query(async ({ ctx, input }) => {
      const policy = await ctx.deps.policyStore.get(ctx.identity.tenantId);
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const account = await requireAccount(tx, input.accountId);
        const entries = await loadEntries(tx, input.accountId, input.asOf);
        const accruals = computeFeeAccruals(policy, account.feeRateBp, entries, input.asOf);
        return {
          accountId: input.accountId,
          asOf: input.asOf,
          provisional: policy.confirmedAt === null,
          label: policy.confirmedAt === null ? 'provisional — not chargeable' : 'confirmed policy',
          accruals: accruals.map((a) => ({
            chargeId: a.chargeId,
            dueDate: a.dueDate,
            basisMinor: wire(a.basisMinor),
            elapsedDays30: a.elapsedDays30,
            cumulativeMinor: wire(a.cumulativeMinor),
            alreadyPostedMinor: wire(a.alreadyPostedMinor),
            deltaMinor: wire(a.deltaMinor),
          })),
          totalDeltaMinor: wire(accruals.reduce((s, a) => s + a.deltaMinor, 0n)),
        };
      });
    }),

  /**
   * Post facility-fee accruals. THE Q4 GATE (§6.4.5): while the tenant's
   * credit policy is unconfirmed this REFUSES — loudly, never skipping —
   * because the five fee decisions are revenue recognition calls no agent
   * makes (open-questions.md Q4; CLAUDE.md §2.8).
   */
  accrueFacilityFee: permissionProcedure({ code: 'credit.fee.accrue', at: 'tenant' })
    .input(z.object({ ...mutationEnvelope, accountId: zUuid, asOf: zBusinessDate }).strict())
    .mutation(async ({ ctx, input }) => {
      const policy = await ctx.deps.policyStore.get(ctx.identity.tenantId);
      if (policy.confirmedAt === null) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'FEE_POLICY_UNCONFIRMED: the credit policy (Q4 decisions D-1..D-5) has not been confirmed ' +
            'by an Accounts-role human — accrual refuses to post (06 §6.4.5). Use previewFacilityFee for shadow figures.',
        });
      }
      const tenantId = ctx.identity.tenantId;
      const key = input.idempotencyKey;
      const result = await runIdempotent(
        { runner: ctx.deps.runner, clock: ctx.deps.clock },
        ctx.identity,
        { op: 'credit.accrue_fee', idempotencyKey: key, claimedHlc: input.claimedHlc, clientWallAt: input.clientWallAt },
        input,
        async (tx) => {
          const account = await requireAccount(tx, input.accountId);
          const entries = await loadEntries(tx, input.accountId, input.asOf);
          const accruals = computeFeeAccruals(policy, account.feeRateBp, entries, input.asOf);
          const response = {
            accountId: input.accountId,
            asOf: input.asOf,
            postings: accruals.map((a, i) => ({
              entryId: deterministicUuid(key, 'fee', String(i)),
              chargeId: a.chargeId,
              basisMinor: wire(a.basisMinor),
              elapsedDays30: a.elapsedDays30,
              cumulativeMinor: wire(a.cumulativeMinor),
              deltaMinor: wire(a.deltaMinor),
            })),
            totalPostedMinor: wire(accruals.reduce((s, a) => s + a.deltaMinor, 0n)),
          };
          return {
            response,
            apply: async (atx) => {
              for (const [i, a] of accruals.entries()) {
                await atx.query(
                  `insert into app.credit_entry
                     (tenant_id, id, write_id, hlc, account_id, kind, amount_minor,
                      business_date, due_date, source_kind, source_id, applies_to_id)
                   values ($1,$2,$3,$4,$5,'FEE',$6,$7::date,null,'FEE_ACCRUAL',null,$8)`,
                  [
                    tenantId,
                    deterministicUuid(key, 'fee', String(i)),
                    key,
                    ctx.deps.clock.next(),
                    input.accountId,
                    wire(a.deltaMinor),
                    input.asOf,
                    a.chargeId,
                  ],
                );
              }
            },
          };
        },
      );
      return result.response;
    }),
});
