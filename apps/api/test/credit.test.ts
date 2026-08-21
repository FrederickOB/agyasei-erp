/**
 * Credit through the API (06-customer-credit; CLAUDE.md §2.7 category 1).
 *
 * - Exposure is Σ(credit_entry.amount_minor) — DERIVED on read, never a
 *   stored counter (§6.2), asserted both through the API and against the
 *   rows the database actually holds.
 * - Ageing buckets are DAYS PAST DUE against the due date snapshotted at
 *   charge time (§6.3), probed at the exact 30/31/60/61 (and 90/91)
 *   boundaries. An unapplied payment is on-account credit — reported as its
 *   own line, never silently netted into a bucket.
 * - The facility fee sits behind the Q4 gate (§6.4.5): accrual REFUSES to
 *   post while the tenant's credit policy is unconfirmed; preview computes
 *   in shadow mode labelled provisional; once an Accounts human confirms,
 *   accrual posts cumulative-minus-posted deltas, 30E/360, truncating
 *   toward the customer, and a retried posting replays instead of doubling.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { createApiHarness, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenantId: string;
let caller: ReturnType<ApiHarness['callerFor']>;

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('credit-t');
  caller = h.callerFor(await h.identityFor(tenantId, { role: 'accounts' }));
}, 180_000);

afterAll(async () => {
  await h.close();
});

async function openAccount(opts: {
  code: string;
  termsDays?: number;
  // Rate in integer basis points, the wire shape of feeRateBpPerMonth
  // (z.number().int() bounded 0..10000) — not a monetary amount.
  feeBp?: number; // lint-money-ignore — integer bp rate on the wire, not minor units
  limitMinor?: string;
}): Promise<string> {
  const res = await caller.credit.openAccount({
    idempotencyKey: uuidv7(),
    newCustomer: { code: opts.code, name: `Customer ${opts.code}` },
    termsDays: opts.termsDays ?? 30,
    feeRateBpPerMonth: opts.feeBp ?? 200,
    creditLimitMinor: opts.limitMinor ?? '1000000',
  });
  return res.accountId;
}

describe('exposure is Σ(entries), derived', () => {
  it('charge + unapplied payment + adjustment sum exactly, API ≡ database', async () => {
    const accountId = await openAccount({ code: 'CR-EXP' });
    await caller.credit.recordEntry({
      idempotencyKey: uuidv7(),
      accountId,
      kind: 'CHARGE',
      amountMinor: '500000',
      businessDate: '2026-08-01',
    });
    await caller.credit.recordEntry({
      idempotencyKey: uuidv7(),
      accountId,
      kind: 'PAYMENT',
      amountMinor: '-200000',
      businessDate: '2026-08-05',
    });
    await caller.credit.recordEntry({
      idempotencyKey: uuidv7(),
      accountId,
      kind: 'ADJUSTMENT',
      amountMinor: '1000',
      businessDate: '2026-08-06',
    });

    const exp = await caller.credit.exposure({ accountId });
    expect(exp.exposureMinor).toBe('301000');
    expect(exp.creditLimitMinor).toBe('1000000');
    expect(exp.availableMinor).toBe('699000');

    // The database agrees: the figure IS the sum of the append-only ledger.
    const db = await h.db.withTenant(tenantId, (tx) =>
      tx.query<{ sum: string }>(
        `select coalesce(sum(amount_minor), 0)::bigint::text as sum
         from app.credit_entry where account_id = $1`,
        [accountId],
      ),
    );
    expect(db.rows[0]!.sum).toBe('301000');
  });

  it('the ce_sign convention is enforced at the gate: a positive PAYMENT is refused', async () => {
    const accountId = await openAccount({ code: 'CR-SIGN' });
    await expect(
      caller.credit.recordEntry({
        idempotencyKey: uuidv7(),
        accountId,
        kind: 'PAYMENT',
        amountMinor: '500',
        businessDate: '2026-08-01',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('ageing: days past due, exact bucket boundaries', () => {
  let accountId: string;

  beforeAll(async () => {
    accountId = await openAccount({ code: 'CR-AGE', termsDays: 30 });
    // Charged 2026-01-01 on 30-day terms → due 2026-01-31 (calendar days —
    // a promise made in real days, §6.4.3).
    const entry = await caller.credit.recordEntry({
      idempotencyKey: uuidv7(),
      accountId,
      kind: 'CHARGE',
      amountMinor: '100000',
      businessDate: '2026-01-01',
    });
    expect(entry.dueDate).toBe('2026-01-31');
  });

  /** asOf → the single non-zero bucket the 100000 charge lands in. */
  async function bucketAt(asOf: string): Promise<{ label: string; daysPastDue: number }> {
    const res = await caller.credit.ageing({ accountId, asOf });
    expect(res.agedBy).toBe('days_past_due');
    const nonZero = res.buckets.filter((b) => b.amountMinor !== '0');
    expect(nonZero).toHaveLength(1);
    expect(nonZero[0]!.amountMinor).toBe('100000');
    expect(res.invoices).toHaveLength(1);
    expect(res.invoices[0]!.bucket).toBe(nonZero[0]!.label);
    return { label: nonZero[0]!.label, daysPastDue: res.invoices[0]!.daysPastDue };
  }

  it('on the due date itself (0 days past due) the invoice is current', async () => {
    expect(await bucketAt('2026-01-31')).toEqual({ label: 'current', daysPastDue: 0 });
  });

  it('day 30 past due is the LAST day of 1-30', async () => {
    expect(await bucketAt('2026-03-02')).toEqual({ label: '1-30', daysPastDue: 30 });
  });

  it('day 31 past due is the FIRST day of 31-60', async () => {
    expect(await bucketAt('2026-03-03')).toEqual({ label: '31-60', daysPastDue: 31 });
  });

  it('day 60 past due is the LAST day of 31-60', async () => {
    expect(await bucketAt('2026-04-01')).toEqual({ label: '31-60', daysPastDue: 60 });
  });

  it('day 61 past due is the FIRST day of 61-90', async () => {
    expect(await bucketAt('2026-04-02')).toEqual({ label: '61-90', daysPastDue: 61 });
  });

  it('days 90 and 91 split 61-90 from 90+', async () => {
    expect(await bucketAt('2026-05-01')).toEqual({ label: '61-90', daysPastDue: 90 });
    expect(await bucketAt('2026-05-02')).toEqual({ label: '90+', daysPastDue: 91 });
  });

  it('an unapplied payment is on-account credit, never netted into a bucket', async () => {
    const acc = await openAccount({ code: 'CR-ONACC', termsDays: 30 });
    await caller.credit.recordEntry({
      idempotencyKey: uuidv7(),
      accountId: acc,
      kind: 'CHARGE',
      amountMinor: '100000',
      businessDate: '2026-01-01',
    });
    await caller.credit.recordEntry({
      idempotencyKey: uuidv7(),
      accountId: acc,
      kind: 'PAYMENT',
      amountMinor: '-30000',
      businessDate: '2026-02-15',
      // deliberately NOT applied to the charge
    });
    const res = await caller.credit.ageing({ accountId: acc, asOf: '2026-03-03' });
    const b = res.buckets.find((x) => x.label === '31-60')!;
    expect(b.amountMinor).toBe('100000'); // the FULL charge still ages
    expect(res.onAccountCreditMinor).toBe('30000'); // the credit is its own line
  });
});

describe('facility fee: the Q4 gate, then cumulative-delta accrual', () => {
  let accountId: string;
  let chargeId: string;
  const accrueKey = uuidv7();

  beforeAll(async () => {
    // 200 bp/month, 30-day terms. Charged 2025-12-01 → due 2025-12-31.
    accountId = await openAccount({ code: 'CR-FEE', termsDays: 30, feeBp: 200 });
    const entry = await caller.credit.recordEntry({
      idempotencyKey: uuidv7(),
      accountId,
      kind: 'CHARGE',
      amountMinor: '150000',
      businessDate: '2025-12-01',
    });
    expect(entry.dueDate).toBe('2025-12-31');
    chargeId = entry.entryId;
  });

  it('REFUSES to post while the policy is unconfirmed — the Q4 gate, in code', async () => {
    await expect(
      caller.credit.accrueFacilityFee({ idempotencyKey: uuidv7(), accountId, asOf: '2026-01-31' }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('FEE_POLICY_UNCONFIRMED'),
    });
    // Nothing posted: the refusal is loud AND clean.
    const fees = await h.db.withTenant(tenantId, (tx) =>
      tx.query<{ n: string }>(
        `select count(*)::text as n from app.credit_entry where account_id = $1 and kind = 'FEE'`,
        [accountId],
      ),
    );
    expect(fees.rows[0]!.n).toBe('0');
  });

  it('preview works in shadow mode, every figure labelled provisional', async () => {
    // 30E/360 from 2025-12-31 to 2026-01-31 is exactly 30 days:
    // 150000 × 200bp × 30/30 ÷ 10000 = 3000, truncating toward the customer.
    const preview = await caller.credit.previewFacilityFee({ accountId, asOf: '2026-01-31' });
    expect(preview.provisional).toBe(true);
    expect(preview.label).toBe('provisional — not chargeable');
    expect(preview.totalDeltaMinor).toBe('3000');
    expect(preview.accruals).toHaveLength(1);
    expect(preview.accruals[0]).toMatchObject({
      chargeId,
      basisMinor: '150000',
      elapsedDays30: 30,
      cumulativeMinor: '3000',
      deltaMinor: '3000',
    });
  });

  it('posts once confirmed; a retried posting replays instead of doubling', async () => {
    await h.policyStore.confirm(tenantId, 'ama.serwaa@accounts', 'Q4 decisions D-1..D-5 confirmed for test');
    const first = await caller.credit.accrueFacilityFee({
      idempotencyKey: accrueKey,
      accountId,
      asOf: '2026-01-31',
    });
    expect(first.totalPostedMinor).toBe('3000');
    expect(first.postings).toHaveLength(1);
    expect(first.postings[0]).toMatchObject({ chargeId, deltaMinor: '3000' });

    // Retry after an "ambiguous failure": stored response, no second FEE row.
    const retry = await caller.credit.accrueFacilityFee({
      idempotencyKey: accrueKey,
      accountId,
      asOf: '2026-01-31',
    });
    expect(retry).toEqual(first);
    const fees = await h.db.withTenant(tenantId, (tx) =>
      tx.query<{ n: string; sum: string }>(
        `select count(*)::text as n, coalesce(sum(amount_minor), 0)::bigint::text as sum
         from app.credit_entry where account_id = $1 and kind = 'FEE'`,
        [accountId],
      ),
    );
    expect(fees.rows[0]!.n).toBe('1');
    expect(fees.rows[0]!.sum).toBe('3000');
  });

  it('a later accrual posts only the delta: cumulative − already-posted', async () => {
    // 30E/360 from 2025-12-31 to 2026-03-02 = 360 − 270 − 28 = 62 days:
    // cumulative = 150000 × 200 × 62 ÷ (10000 × 30) = 6200; already 3000 → 3200.
    const second = await caller.credit.accrueFacilityFee({
      idempotencyKey: uuidv7(),
      accountId,
      asOf: '2026-03-02',
    });
    expect(second.totalPostedMinor).toBe('3200');
    expect(second.postings[0]).toMatchObject({ cumulativeMinor: '6200', deltaMinor: '3200' });

    const exp = await caller.credit.exposure({ accountId });
    expect(exp.exposureMinor).toBe('156200'); // 150000 charge + 6200 fees
  });

  it('a fully applied payment stops accrual; posted fees remain receivable', async () => {
    await caller.credit.recordEntry({
      idempotencyKey: uuidv7(),
      accountId,
      kind: 'PAYMENT',
      amountMinor: '-150000',
      businessDate: '2026-03-02',
      appliesToId: chargeId,
    });
    const preview = await caller.credit.previewFacilityFee({ accountId, asOf: '2026-04-01' });
    expect(preview.accruals).toEqual([]);
    expect(preview.totalDeltaMinor).toBe('0');

    const ageing = await caller.credit.ageing({ accountId, asOf: '2026-04-01' });
    expect(ageing.invoices).toEqual([]); // the trade charge is settled
    for (const b of ageing.buckets) expect(b.amountMinor).toBe('0');
    expect(ageing.feeOutstandingMinor).toBe('6200'); // fee receivable, separate from trade AR

    const exp = await caller.credit.exposure({ accountId });
    expect(exp.exposureMinor).toBe('6200');
  });
});
