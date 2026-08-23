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
import {
  accountForCustomerInput,
  openAccountInput,
  recordEntryInput,
  setLimitInput,
  setStatusInput,
} from '@erp/contracts';
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

/**
 * What `setStatus` answers with, declared rather than inferred: the no-op
 * branch and the transition branch return the same shape, and TypeScript would
 * otherwise narrow `changed` to the literal of whichever branch it saw first.
 */
type StatusDecision = {
  accountId: string;
  /** False when the account was already in the status asked for. */
  changed: boolean;
  fromStatus: string;
  status: string;
  /** The log row this wrote, or null for a no-op. */
  changeId: string | null;
  /** Σ(entries) at the moment the decision was taken. Minor units, on the wire. */
  exposureMinor: string;
};

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

/**
 * The accepted head of an account's credit-limit decision log.
 *
 * Exactly one accepted version per account exists — `credit_limit_one_head`
 * (migration 0011) makes that a database guarantee rather than a convention —
 * so this is a lookup, not a search, and there is no "which one is current?"
 * to get wrong. `null` means the account predates the log; its limit is
 * whatever `openAccount` inserted and the first change writes the genesis
 * version.
 */
async function loadHeadVersion(
  tx: Queryable,
  accountId: string,
): Promise<{ id: string; limitMinor: bigint; termsDays: number; effectiveFrom: string } | null> {
  const res = await tx.query<{
    id: string;
    limit_minor: string;
    terms_days: number;
    effective_from: string;
  }>(
    `select id, limit_minor::text, terms_days, effective_from::text
     from app.credit_limit_version
     where credit_account_id = $1 and state = 'accepted'`,
    [accountId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    limitMinor: BigInt(row.limit_minor),
    termsDays: row.terms_days,
    effectiveFrom: row.effective_from,
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
            // THE GENESIS VERSION (06 §6.6.1). Opening an account IS a limit
            // decision, so it gets a row in the decision log like every later
            // one — with `supersedes_id` null, which is what makes the first
            // change's compare-and-set have something to name. An account with
            // no genesis row is the case `credit_limit_one_accepted_child`'s
            // NULLS NOT DISTINCT exists to close (M-12: the root case failed
            // OPEN under the default).
            await atx.query(
              `insert into app.credit_limit_version
                 (tenant_id, id, write_id, hlc, credit_account_id, limit_minor,
                  terms_days, fee_rate_bp, reason_code, note, supersedes_id,
                  state, decided_by, decided_at_location, effective_from)
               values ($1,$2,$3,$4,$5,$6,$7,$8,'ACCOUNT_OPENED',null,null,
                       'accepted',$9,null,current_date)`,
              [
                tenantId,
                deterministicUuid(key, 'credit_limit_version'),
                key,
                ctx.deps.clock.next(),
                accountId,
                wire(input.creditLimitMinor),
                input.termsDays,
                input.feeRateBpPerMonth,
                ctx.identity.userId,
              ],
            );
          },
        };
      },
    );
    return result.response;
  }),

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * CHANGE A CREDIT LIMIT — append a decision, never edit a column
   * ═══════════════════════════════════════════════════════════════════════
   * Before migration 0011 a limit could be set once, at `openAccount`, and
   * never changed: `credit_limit_minor` was INSERTed and appeared in no UPDATE
   * anywhere. CLAUDE.md §3 lists "limits" as a Phase 1 pillar and a number
   * that can be typed once and never corrected is not one.
   *
   * TWO CAPABILITIES, BOTH TENANT-WIDE, AND `credit.limit.change` IS
   * UNCONDITIONAL HERE — unlike `openAccount`, which asks for it only when the
   * limit it is setting is non-zero. Cutting a customer to zero is as much a
   * risk decision as raising them to fifty thousand, and the person who may do
   * one may do the other.
   *
   * `supersedesId` IS THE COMPARE-AND-SET (06 §6.6.1). It names the version
   * the author had in front of them. A claim that does not match the accepted
   * head is REFUSED with the head's own figures — the loser sees the number
   * that won and decides again against it. This is the canonical hard case
   * (CLAUDE.md §2.2) answered the way §3.6 rules: not last-write-wins, and
   * not "lower wins" either, which §6.6.3 deletes by name. Nobody's judgement
   * is discarded silently, because nobody's judgement is discarded at all —
   * the second author is told and asked again.
   *
   * The fee rate is carried forward from the account, never taken from the
   * caller: `previewFacilityFee` and `accrueFacilityFee` read the account's
   * CURRENT rate, so a new one would reprice history. An effective-dated fee
   * rate is 06 §6.4 work that is not built, and inventing a half of it here
   * would put a wrong number on a customer's statement.
   */
  setLimit: permissionProcedure({
    code: 'credit.account.manage',
    at: 'tenant',
  }).input(setLimitInput).mutation(async ({ ctx, input }) => {
    ctx.permissions.requireTenantWide('credit.limit.change');
    const tenantId = ctx.identity.tenantId;
    const decidedBy = ctx.identity.userId;
    const key = input.idempotencyKey;
    const result = await runIdempotent(
      { runner: ctx.deps.runner, clock: ctx.deps.clock },
      ctx.identity,
      { op: 'credit.set_limit', idempotencyKey: key, claimedHlc: input.claimedHlc, clientWallAt: input.clientWallAt },
      input,
      async (tx) => {
        const account = await requireAccount(tx, input.accountId);
        const head = await loadHeadVersion(tx, input.accountId);

        // The CAS, in the application, for a message a person can act on. The
        // database says the same thing structurally (`credit_limit_one_head`),
        // which is what makes two SIMULTANEOUS writes impossible rather than
        // merely unlikely — this check cannot see a transaction that has not
        // committed yet, and the index can.
        const claimed = input.supersedesId ?? null;
        const current = head === null ? null : head.id;
        if (claimed !== current) {
          throw new TRPCError({
            code: 'CONFLICT',
            message:
              `LIMIT_VERSION_STALE: this account's limit was decided by somebody else while you ` +
              `were deciding. Nothing has been changed. The limit in force is ` +
              `${wire(account.creditLimitMinor)} minor units` +
              (head === null ? '' : ` from ${head.effectiveFrom}`) +
              `. Read the account again and decide against that figure.`,
          });
        }

        // §6.6.2: never future-dated. The scheduled write that would apply it
        // does not exist, so the account would go on showing the old limit as
        // current — which is the one thing a credit screen may not do. The
        // database trigger says this too; here it is a BAD_REQUEST rather than
        // a 500.
        const today = await tx.query<{ today: string }>(`select current_date::text as today`);
        if (input.effectiveFrom > today.rows[0]!.today) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              `a credit limit may not be future-dated: ${input.effectiveFrom} is after ` +
              `${today.rows[0]!.today}. Nothing applies it on the day it arrives.`,
          });
        }
        if (head !== null && input.effectiveFrom < head.effectiveFrom) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              `a credit limit may not take effect (${input.effectiveFrom}) before the version ` +
              `it replaces (${head.effectiveFrom}).`,
          });
        }

        const versionId = deterministicUuid(key, 'credit_limit_version');
        const response = {
          accountId: input.accountId,
          versionId,
          supersedesId: current,
          previousLimitMinor: wire(account.creditLimitMinor),
          creditLimitMinor: wire(input.creditLimitMinor),
          previousTermsDays: account.termsDays,
          termsDays: input.termsDays,
          /** Carried forward, never taken from the caller. See the header. */
          feeRateBpPerMonth: Number(account.feeRateBp),
          effectiveFrom: input.effectiveFrom,
        };
        return {
          response,
          apply: async (atx) => {
            // Parent first, so there is no instant at which two accepted
            // versions exist: `credit_limit_one_head` is checked per statement.
            if (current !== null) {
              await atx.query(
                `update app.credit_limit_version
                    set state = 'superseded', updated_at = transaction_timestamp()
                  where id = $1 and state = 'accepted'`,
                [current],
              );
            }
            await atx.query(
              `insert into app.credit_limit_version
                 (tenant_id, id, write_id, hlc, credit_account_id, limit_minor,
                  terms_days, fee_rate_bp, reason_code, note, supersedes_id,
                  state, decided_by, decided_at_location, effective_from)
               values ($1,$2,$3,$4,$5,$6,$7,$8,'MANUAL',$9,$10,
                       'accepted',$11,null,$12::date)`,
              [
                tenantId,
                versionId,
                key,
                ctx.deps.clock.next(),
                input.accountId,
                wire(input.creditLimitMinor),
                input.termsDays,
                Number(account.feeRateBp),
                input.reason,
                current,
                decidedBy,
                input.effectiveFrom,
              ],
            );
            // `app.customer_account.credit_limit_minor` is NOT written here.
            // The projection trigger owns it and is the only thing the
            // database permits to write it (migration 0011 §5).
          },
        };
      },
    );
    return result.response;
  }),


  /**
   * ═════════════════════════════════════════════════════════════════════════
   * CUTTING A CUSTOMER OFF — the write side of a check that already existed
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `sales.createSale` has refused credit tender on any account that is not
   * `ACTIVE` since the sale path existed. Nothing could move an account off
   * `ACTIVE`. The enforcement was real and the switch was missing, so a
   * customer who stopped paying could not be cut off through the app at all.
   *
   * THREE STATUSES AND FIVE LEGAL MOVES (credit-offline-plan R4):
   *
   *   ACTIVE     -> SUSPENDED   reason required
   *   SUSPENDED  -> ACTIVE      reason required
   *   ACTIVE     -> CLOSED      only at exposure = 0
   *   SUSPENDED  -> CLOSED      only at exposure = 0
   *   CLOSED     -> ACTIVE      a reopen, audited as one
   *   X          -> X           a no-op, not an error
   *
   * `CLOSED -> SUSPENDED` is the one remaining pair and it is refused: an
   * account with no exposure and no trade has nothing to suspend, and allowing
   * it would make "closed" mean two different things.
   *
   * WHAT SUSPENDED MEANS, EXACTLY (R4). No new `CHARGE` entries — the sale
   * path refuses credit tender, and CASH SALES ARE UNAFFECTED, because
   * suspending credit must not stop the customer buying. `PAYMENT`,
   * `ADJUSTMENT`, `WRITE_OFF` and fee accrual all continue: a suspended
   * customer still owes what they owe, and stopping the ledger would quietly
   * forgive it.
   *
   * THE COMPARE-AND-SET, in the shape `setLimit` already uses. `expectedStatus`
   * names the status the author had in front of them. A claim that no longer
   * matches is refused with the status that won, because a suspension decided
   * against a stale picture is exactly the case 02 §2.5's
   * `requires_fresh_authorization` flag exists for — and migration 0012 flips
   * that flag on `credit.account.manage`.
   *
   * WHAT THIS CANNOT DO, said plainly: it cannot reach a device that is dark.
   * A partitioned outlet keeps selling on credit until it syncs, and no
   * mechanism here changes that (R4's offline case). The answers to it —
   * revoking the cap leases a dark device runs out of, and conflict class #20
   * for sales that arrive after a suspension — belong to the counter allowance
   * surface, which is not built. This route does not pretend otherwise.
   *
   * The history is APPEND-ONLY at the database, with no whitelist at all:
   * `app.credit_status_change` refuses UPDATE and DELETE outright, and
   * `app.customer_account.status` is a projection only a trigger may write. A
   * suspension cannot be tidied away afterwards, which is the whole reason to
   * record who, when and why.
   */
  setStatus: permissionProcedure({
    code: 'credit.account.manage',
    at: 'tenant',
  }).input(setStatusInput).mutation(async ({ ctx, input }) => {
    const tenantId = ctx.identity.tenantId;
    const decidedBy = ctx.identity.userId;
    const key = input.idempotencyKey;
    const result = await runIdempotent(
      { runner: ctx.deps.runner, clock: ctx.deps.clock },
      ctx.identity,
      {
        op: 'credit.set_status',
        idempotencyKey: key,
        claimedHlc: input.claimedHlc,
        clientWallAt: input.clientWallAt,
      },
      input,
      async (tx) => {
        const account = await requireAccount(tx, input.accountId);
        const current = account.status;

        // Exposure is Σ(entries), read here rather than recomputed later: the
        // CLOSE rule is applied to this figure and the log records it, so an
        // auditor sees the number the decision was actually taken against.
        const sum = await tx.query<{ exposure: string }>(
          `select coalesce(sum(amount_minor), 0)::bigint::text as exposure
           from app.credit_entry where account_id = $1`,
          [input.accountId],
        );
        const exposure = BigInt(sum.rows[0]!.exposure);

        // ---- X -> X. A no-op, not an error, and checked FIRST -------------
        // Whatever the author believed, the account already is what they asked
        // for; nothing changes and the response says which status is in force.
        // Answering CONFLICT here would make a retry of a request that already
        // succeeded look like somebody else's decision.
        if (current === input.status) {
          const noop: StatusDecision = {
            accountId: input.accountId,
            changed: false,
            fromStatus: current,
            status: current,
            changeId: null,
            exposureMinor: wire(exposure),
          };
          return {
            response: noop,
            apply: async () => {
              /* nothing to write */
            },
          };
        }

        // ---- the compare-and-set ------------------------------------------
        if (input.expectedStatus !== current) {
          throw new TRPCError({
            code: 'CONFLICT',
            message:
              `CREDIT_STATUS_STALE: you decided against an account you believed was ` +
              `${input.expectedStatus}, and it is ${current}. Nothing has been changed. ` +
              `Read the account again and decide against what it says now.`,
          });
        }

        // ---- the transition table -----------------------------------------
        const legal =
          (current === 'ACTIVE' && input.status === 'SUSPENDED') ||
          (current === 'SUSPENDED' && input.status === 'ACTIVE') ||
          (current === 'CLOSED' && input.status === 'ACTIVE') ||
          ((current === 'ACTIVE' || current === 'SUSPENDED') && input.status === 'CLOSED');
        if (!legal) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              `CREDIT_STATUS_TRANSITION_REFUSED: ${current} to ${input.status} is not a move ` +
              `this account can make. Nothing has been changed.`,
          });
        }

        // ---- closing needs a settled account ------------------------------
        // Closing at a non-zero balance would take the account out of every
        // "who owes us money" read while the money is still owed. Settle it,
        // write it off, or SUSPEND instead — suspension stops new credit and
        // leaves the debt exactly where it is.
        if (input.status === 'CLOSED' && exposure !== 0n) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              `CREDIT_STATUS_CLOSE_BLOCKED: this account still stands at ` +
              `${wire(exposure)} minor units. An account is closed once it is settled or ` +
              `written off. To stop further credit now, suspend it — the debt stays where ` +
              `it is and the account stays visible.`,
          });
        }

        const changeId = deterministicUuid(key, 'credit_status_change');
        const decided: StatusDecision = {
          accountId: input.accountId,
          changed: true,
          fromStatus: current,
          status: input.status,
          changeId,
          exposureMinor: wire(exposure),
        };
        return {
          response: decided,
          apply: async (atx) => {
            await atx.query(
              `insert into app.credit_status_change
                 (tenant_id, id, write_id, hlc, credit_account_id, from_status,
                  to_status, reason_code, note, exposure_at_decision_minor,
                  decided_by, decided_at_location)
               values ($1,$2,$3,$4,$5,$6,$7,'MANUAL',$8,$9,$10,null)`,
              [
                tenantId,
                changeId,
                key,
                ctx.deps.clock.next(),
                input.accountId,
                current,
                input.status,
                input.reason,
                wire(exposure),
                decidedBy,
              ],
            );
            // `app.customer_account.status` is NOT written here. The
            // projection trigger owns it and is the only thing the database
            // permits to write it (migration 0012 §4).
          },
        };
      },
    );
    return result.response;
  }),

  /**
   * Which account belongs to this customer?
   *
   * Every other credit route is addressed by ACCOUNT; everything a device
   * holds is addressed by CUSTOMER, and `app.customer_account` is in no sync
   * bucket — so before this route the only client that could read a credit
   * position was one that made a person type a UUID.
   *
   * `credit.view` at ANY location, deliberately the same guard as the reads it
   * precedes: it discloses an identifier and a status word and no money at
   * all, so it cannot leak a figure to somebody who could not then read it.
   */
  accountForCustomer: permissionProcedure({ code: 'credit.view', at: 'any' })
    .input(accountForCustomerInput)
    .query(async ({ ctx, input }) => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const res = await tx.query<{ id: string; status: string }>(
          `select id, status from app.customer_account
           where customer_id = $1 and deleted_at is null`,
          [input.customerId],
        );
        const row = res.rows[0];
        if (!row) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'NO_CREDIT_ACCOUNT: this customer has no credit account.',
          });
        }
        return { accountId: row.id, customerId: input.customerId, status: row.status };
      });
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
        const head = await loadHeadVersion(tx, input.accountId);
        return {
          accountId: input.accountId,
          exposureMinor: wire(exposure),
          creditLimitMinor: wire(account.creditLimitMinor),
          availableMinor: wire(account.creditLimitMinor - exposure),
          status: account.status,
          /** The terms the NEXT charge will age against (06 §6.3). */
          termsDays: account.termsDays,
          /**
           * The accepted head of the limit decision log, or null for an
           * account opened before migration 0011. A client that wants to
           * CHANGE the limit sends this back as `supersedesId`: it is the
           * compare-and-set, and it is published here because this is the read
           * that shows the number a person is about to decide against
           * (06 §6.6.1).
           */
          limitVersionId: head === null ? null : head.id,
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
