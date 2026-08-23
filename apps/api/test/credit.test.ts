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
/**
 * A tenant with the template APPLIED, so the authorization tests below run
 * against the tenant's real composed roles rather than the harness's
 * grant-everything default — which is the third thing that agreed with
 * neither the seed data nor the live stack (phase1-status §0, the RBAC row).
 */
let roleTenantId: string;

/**
 * TODAY, computed. `openAccount` stamps the genesis version with the
 * database's `current_date` and 06 §6.6.2 makes `effective_from`
 * non-decreasing along the chain, so a hard-coded literal here would start
 * failing on the calendar — exactly phase1-status §0's row 10.
 */
const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('credit-t');
  caller = h.callerFor(await h.identityFor(tenantId, { role: 'accounts' }));
  roleTenantId = await h.provisionTenant('credit-roles');
  await h.applyTemplate(roleTenantId);
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

// ---------------------------------------------------------------------------
// The credit limit is an append-only decision log (06 §6.6, migration 0011)
// ---------------------------------------------------------------------------

describe('setting and changing a credit limit', () => {
  it('opening an account writes the genesis version, and exposure publishes it', async () => {
    const accountId = await openAccount({ code: 'CR-GEN', limitMinor: '500000' });
    const exp = await caller.credit.exposure({ accountId });
    expect(exp.limitVersionId).not.toBeNull();
    expect(exp.creditLimitMinor).toBe('500000');

    const rows = await h.db.withTenant(tenantId, (tx) =>
      tx.query<{ limit_minor: string; state: string; supersedes_id: string | null }>(
        `select limit_minor::text, state, supersedes_id
         from app.credit_limit_version where credit_account_id = $1`,
        [accountId],
      ),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.state).toBe('accepted');
    expect(rows.rows[0]!.supersedes_id).toBeNull();
    expect(rows.rows[0]!.limit_minor).toBe('500000');
  });

  it('a change appends a version, supersedes the old one and PROJECTS onto the account', async () => {
    const accountId = await openAccount({ code: 'CR-CHG', limitMinor: '500000' });
    const before = await caller.credit.exposure({ accountId });

    const res = await caller.credit.setLimit({
      idempotencyKey: uuidv7(),
      accountId,
      creditLimitMinor: '800000',
      termsDays: 45,
      effectiveFrom: TODAY,
      reason: 'deposit cleared, raised after review',
      supersedesId: before.limitVersionId!,
    });
    expect(res.previousLimitMinor).toBe('500000');
    expect(res.creditLimitMinor).toBe('800000');

    // The PROJECTION is what every other route reads.
    const after = await caller.credit.exposure({ accountId });
    expect(after.creditLimitMinor).toBe('800000');
    expect(after.termsDays).toBe(45);
    expect(after.limitVersionId).toBe(res.versionId);

    const rows = await h.db.withTenant(tenantId, (tx) =>
      tx.query<{ limit_minor: string; state: string; note: string | null }>(
        `select limit_minor::text, state, note from app.credit_limit_version
         where credit_account_id = $1 order by created_at, limit_minor`,
        [accountId],
      ),
    );
    expect(rows.rows.map((r) => `${r.limit_minor}:${r.state}`).sort()).toEqual([
      '500000:superseded',
      '800000:accepted',
    ]);
    // The reason is recorded, verbatim. A limit that changed for no stated
    // reason is unauditable.
    expect(rows.rows.find((r) => r.state === 'accepted')!.note).toBe(
      'deposit cleared, raised after review',
    );
  });

  it('the fee rate is CARRIED FORWARD, never taken from the caller', async () => {
    const accountId = await openAccount({ code: 'CR-FEE-FWD', feeBp: 250 });
    const head = await caller.credit.exposure({ accountId });
    const res = await caller.credit.setLimit({
      idempotencyKey: uuidv7(),
      accountId,
      creditLimitMinor: '2000000',
      termsDays: 30,
      effectiveFrom: TODAY,
      reason: 'annual review',
      supersedesId: head.limitVersionId!,
    });
    expect(res.feeRateBpPerMonth).toBe(250);
    const row = await h.db.withTenant(tenantId, (tx) =>
      tx.query<{ fee_rate_bp: number }>( // lint-money-ignore: an integer bp rate column
        `select fee_rate_bp from app.credit_limit_version where id = $1`,
        [res.versionId],
      ),
    );
    expect(row.rows[0]!.fee_rate_bp).toBe(250);
  });

  it('THE COMPARE-AND-SET: a stale claim is refused and NOTHING is changed', async () => {
    const accountId = await openAccount({ code: 'CR-CAS', limitMinor: '500000' });
    const head = await caller.credit.exposure({ accountId });

    // Two people, each holding the same version, each decide a number.
    await caller.credit.setLimit({
      idempotencyKey: uuidv7(),
      accountId,
      creditLimitMinor: '800000',
      termsDays: 30,
      effectiveFrom: TODAY,
      reason: 'saw the deposit arrive',
      supersedesId: head.limitVersionId!,
    });

    await expect(
      caller.credit.setLimit({
        idempotencyKey: uuidv7(),
        accountId,
        creditLimitMinor: '300000',
        termsDays: 30,
        effectiveFrom: TODAY,
        reason: 'heard they are slow paying',
        supersedesId: head.limitVersionId!,
      }),
    ).rejects.toThrow(/LIMIT_VERSION_STALE/);

    // Not last-write-wins, and not "lower wins" either (§6.6.3 deletes that
    // rule by name). The first decision stands and the second author is told.
    const after = await caller.credit.exposure({ accountId });
    expect(after.creditLimitMinor).toBe('800000');
    const count = await h.db.withTenant(tenantId, (tx) =>
      tx.query<{ n: string }>(
        `select count(*)::text as n from app.credit_limit_version where credit_account_id = $1`,
        [accountId],
      ),
    );
    expect(count.rows[0]!.n).toBe('2');
  });

  it('refuses a future-dated version — nothing would apply it on the day', async () => {
    const accountId = await openAccount({ code: 'CR-FUT' });
    const head = await caller.credit.exposure({ accountId });
    await expect(
      caller.credit.setLimit({
        idempotencyKey: uuidv7(),
        accountId,
        creditLimitMinor: '900000',
        termsDays: 30,
        effectiveFrom: '2099-01-01',
        reason: 'takes effect next century',
        supersedesId: head.limitVersionId!,
      }),
    ).rejects.toThrow(/future-dated/);
  });

  it('THE DATABASE REFUSES a direct write to the projected column', async () => {
    const accountId = await openAccount({ code: 'CR-BACKSTOP', limitMinor: '500000' });
    await expect(
      h.db.withTenant(tenantId, (tx) =>
        tx.query(`update app.customer_account set credit_limit_minor = 99999999 where id = $1`, [
          accountId,
        ]),
      ),
    ).rejects.toThrow(/projection of app.credit_limit_version/);
    const exp = await caller.credit.exposure({ accountId });
    expect(exp.creditLimitMinor).toBe('500000');
  });

  it('THE DATABASE REFUSES editing a decision that was already made', async () => {
    const accountId = await openAccount({ code: 'CR-APPEND', limitMinor: '400000' });
    const head = await caller.credit.exposure({ accountId });
    await expect(
      h.db.withTenant(tenantId, (tx) =>
        tx.query(`update app.credit_limit_version set limit_minor = 1 where id = $1`, [
          head.limitVersionId,
        ]),
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('a replayed key returns the same version and appends nothing', async () => {
    const accountId = await openAccount({ code: 'CR-IDEM', limitMinor: '500000' });
    const head = await caller.credit.exposure({ accountId });
    const key = uuidv7();
    const body = {
      idempotencyKey: key,
      accountId,
      creditLimitMinor: '700000',
      termsDays: 30,
      effectiveFrom: TODAY,
      reason: 'reviewed with the customer',
      supersedesId: head.limitVersionId!,
    };
    const first = await caller.credit.setLimit(body);
    const second = await caller.credit.setLimit(body);
    expect(second.versionId).toBe(first.versionId);
    const count = await h.db.withTenant(tenantId, (tx) =>
      tx.query<{ n: string }>(
        `select count(*)::text as n from app.credit_limit_version where credit_account_id = $1`,
        [accountId],
      ),
    );
    expect(count.rows[0]!.n).toBe('2');
  });
});

describe('who may change a limit', () => {
  async function accountsCaller(): Promise<ReturnType<ApiHarness['callerFor']>> {
    return h.callerFor(await h.principal(roleTenantId, { roleRef: 'accounts' }));
  }

  async function openOn(code: string, limitMinor: string): Promise<string> {
    const accounts = await accountsCaller();
    const res = await accounts.credit.openAccount({
      idempotencyKey: uuidv7(),
      newCustomer: { code, name: `Customer ${code}` },
      termsDays: 30,
      feeRateBpPerMonth: 200,
      creditLimitMinor: limitMinor,
    });
    return res.accountId;
  }

  it('an outlet manager may NOT read the account and may NOT change the limit', async () => {
    const accounts = await accountsCaller();
    const accountId = await openOn('CR-RBAC', '500000');
    const head = await accounts.credit.exposure({ accountId });
    const manager = h.callerFor(await h.principal(roleTenantId, { roleRef: 'outlet_manager' }));

    // THE POSITIVE CONTROL ON THE PRINCIPAL, moved off the credit routes.
    // It used to be `manager.credit.exposure(...)` succeeding — which stopped
    // being true when the residency rule took `credit.view` out of the
    // outlet-manager template role (packages/db/src/seed/roles.ts, "THE
    // RESIDENCY RULE"; docs/credit-offline-plan.md R1.b). The control is still
    // needed for the same reason — "refused" below must not be able to mean
    // "this caller is broken" — so it now runs on a route the manager DOES
    // hold (`stock.view`), which proves the caller resolves permissions and
    // reaches a router before the refusals are believed.
    const control = await manager.inventory.lowStock({});
    expect(control.scope.locationCount).toBeGreaterThan(0);

    // The read is now refused too, and the refusal names the capability.
    await expect(manager.credit.exposure({ accountId })).rejects.toThrow(
      /PERMISSION_DENIED: credit\.view/,
    );

    await expect(
      manager.credit.setLimit({
        idempotencyKey: uuidv7(),
        accountId,
        creditLimitMinor: '9000000',
        termsDays: 30,
        effectiveFrom: TODAY,
        reason: 'trying it on',
        supersedesId: head.limitVersionId!,
      }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    const after = await accounts.credit.exposure({ accountId });
    expect(after.creditLimitMinor).toBe('500000');
  });

  it('counter staff hold no credit capability at all — not even the read', async () => {
    const accountId = await openOn('CR-RBAC-2', '500000');
    const counter = h.callerFor(await h.principal(roleTenantId, { roleRef: 'counter_staff' }));
    await expect(counter.credit.exposure({ accountId })).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(
      counter.credit.recordEntry({
        idempotencyKey: uuidv7(),
        accountId,
        kind: 'PAYMENT',
        amountMinor: '-1000',
        businessDate: '2026-08-01',
      }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });
});

describe('finding the account for a customer', () => {
  it('answers with the account, so no screen has to make a person type one', async () => {
    const opened = await caller.credit.openAccount({
      idempotencyKey: uuidv7(),
      newCustomer: { code: 'CR-BY-CUST', name: 'Customer CR-BY-CUST' },
      termsDays: 30,
      feeRateBpPerMonth: 200,
      creditLimitMinor: '100000',
    });
    const found = await caller.credit.accountForCustomer({ customerId: opened.customerId });
    expect(found.accountId).toBe(opened.accountId);
    expect(found.status).toBe('ACTIVE');
  });

  it('says NO_CREDIT_ACCOUNT for a customer who buys for cash', async () => {
    const cashOnly = uuidv7();
    await h.db.withTenant(tenantId, async (tx) => {
      const writeId = uuidv7();
      await tx.query(
        `insert into app.write_log (tenant_id, id, origin, hlc, op, request_hash)
         values ($1,$2,'SERVER',$3,'test.cash_customer','\\x00'::bytea)`,
        [tenantId, writeId, h.deps.clock.next()],
      );
      await tx.query(
        `insert into app.customer (tenant_id, id, write_id, hlc, code, name)
         values ($1,$2,$3,$4,'CASH-ONLY','Walk-in')`,
        [tenantId, cashOnly, writeId, h.deps.clock.next()],
      );
    });
    await expect(caller.credit.accountForCustomer({ customerId: cashOnly })).rejects.toThrow(
      /NO_CREDIT_ACCOUNT/,
    );
  });

  it('is invisible across a tenant boundary — a second tenant sees NOT_FOUND', async () => {
    const opened = await caller.credit.openAccount({
      idempotencyKey: uuidv7(),
      newCustomer: { code: 'CR-ISO', name: 'Customer CR-ISO' },
      termsDays: 30,
      feeRateBpPerMonth: 200,
      creditLimitMinor: '100000',
    });
    const other = await h.provisionTenant('credit-t2');
    const otherCaller = h.callerFor(await h.identityFor(other, { role: 'accounts' }));
    await expect(
      otherCaller.credit.accountForCustomer({ customerId: opened.customerId }),
    ).rejects.toThrow(/NO_CREDIT_ACCOUNT/);
    await expect(otherCaller.credit.exposure({ accountId: opened.accountId })).rejects.toThrow(
      /credit account not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// Cutting a customer off — `credit.setStatus`
// ---------------------------------------------------------------------------

/**
 * `customer_account.status` was ENFORCED by `sales.createSale` (it refuses
 * credit tender on any account that is not ACTIVE) and SET BY NOTHING. These
 * tests cover the write side of that check, and the one that matters most is
 * the last group: the refusal is driven through the REAL sale path, because a
 * transition that produced a value the till did not recognise would suspend an
 * account the till still honoured — worse than no feature at all.
 */
describe('the account lifecycle: ACTIVE / SUSPENDED / CLOSED', () => {
  async function statusOf(accountId: string): Promise<string> {
    return (await caller.credit.exposure({ accountId })).status;
  }

  async function charge(accountId: string, amountMinor: string): Promise<void> {
    await caller.credit.recordEntry({
      idempotencyKey: uuidv7(),
      accountId,
      kind: 'CHARGE',
      amountMinor,
      businessDate: TODAY,
      dueDate: TODAY,
    });
  }

  it('ACTIVE → SUSPENDED → ACTIVE, and the account projects each decision', async () => {
    const accountId = await openAccount({ code: 'CS-CYCLE' });
    expect(await statusOf(accountId)).toBe('ACTIVE');

    const off = await caller.credit.setStatus({
      idempotencyKey: uuidv7(),
      accountId,
      status: 'SUSPENDED',
      expectedStatus: 'ACTIVE',
      reason: 'two invoices unpaid past 90 days',
    });
    expect(off).toMatchObject({ changed: true, fromStatus: 'ACTIVE', status: 'SUSPENDED' });
    expect(off.changeId).not.toBeNull();
    expect(await statusOf(accountId)).toBe('SUSPENDED');

    const on = await caller.credit.setStatus({
      idempotencyKey: uuidv7(),
      accountId,
      status: 'ACTIVE',
      expectedStatus: 'SUSPENDED',
      reason: 'settled in full, cleared by the accountant',
    });
    expect(on).toMatchObject({ changed: true, fromStatus: 'SUSPENDED', status: 'ACTIVE' });
    expect(await statusOf(accountId)).toBe('ACTIVE');
  });

  it('closes a settled account, and reopens a closed one', async () => {
    const accountId = await openAccount({ code: 'CS-CLOSE' });
    const closed = await caller.credit.setStatus({
      idempotencyKey: uuidv7(),
      accountId,
      status: 'CLOSED',
      expectedStatus: 'ACTIVE',
      reason: 'customer has wound up the business',
    });
    expect(closed).toMatchObject({ status: 'CLOSED', exposureMinor: '0' });
    expect(await statusOf(accountId)).toBe('CLOSED');

    const reopened = await caller.credit.setStatus({
      idempotencyKey: uuidv7(),
      accountId,
      status: 'ACTIVE',
      expectedStatus: 'CLOSED',
      reason: 'trading again under the same company',
    });
    expect(reopened).toMatchObject({ fromStatus: 'CLOSED', status: 'ACTIVE' });
    expect(await statusOf(accountId)).toBe('ACTIVE');
  });

  it('REFUSES to close an account that still owes money — suspend it instead', async () => {
    const accountId = await openAccount({ code: 'CS-OWING' });
    await charge(accountId, '250000');
    await expect(
      caller.credit.setStatus({
        idempotencyKey: uuidv7(),
        accountId,
        status: 'CLOSED',
        expectedStatus: 'ACTIVE',
        reason: 'tidying the ledger',
      }),
    ).rejects.toThrow(/CREDIT_STATUS_CLOSE_BLOCKED/);
    expect(await statusOf(accountId)).toBe('ACTIVE');

    // …and the alternative the refusal names actually works, at the same
    // balance. "Refused" must not be able to mean "this account is stuck".
    await caller.credit.setStatus({
      idempotencyKey: uuidv7(),
      accountId,
      status: 'SUSPENDED',
      expectedStatus: 'ACTIVE',
      reason: 'stopping further credit while we chase the balance',
    });
    expect(await statusOf(accountId)).toBe('SUSPENDED');
  });

  it('REFUSES CLOSED → SUSPENDED, naming the pair it refused', async () => {
    const accountId = await openAccount({ code: 'CS-ILLEGAL' });
    await caller.credit.setStatus({
      idempotencyKey: uuidv7(),
      accountId,
      status: 'CLOSED',
      expectedStatus: 'ACTIVE',
      reason: 'closed at the customer’s request',
    });
    await expect(
      caller.credit.setStatus({
        idempotencyKey: uuidv7(),
        accountId,
        status: 'SUSPENDED',
        expectedStatus: 'CLOSED',
        reason: 'trying it on',
      }),
    ).rejects.toThrow(/CREDIT_STATUS_TRANSITION_REFUSED: CLOSED to SUSPENDED/);
    expect(await statusOf(accountId)).toBe('CLOSED');
  });

  it('X → X is a NO-OP, not an error, and writes no history', async () => {
    const accountId = await openAccount({ code: 'CS-NOOP' });
    const same = await caller.credit.setStatus({
      idempotencyKey: uuidv7(),
      accountId,
      status: 'ACTIVE',
      expectedStatus: 'ACTIVE',
      reason: 'confirming the account is open',
    });
    expect(same).toMatchObject({ changed: false, status: 'ACTIVE', changeId: null });
    const n = await h.db.withTenant(tenantId, (tx) =>
      tx.query<{ n: string }>(
        `select count(*)::text as n from app.credit_status_change where credit_account_id = $1`,
        [accountId],
      ),
    );
    expect(n.rows[0]!.n).toBe('0');
  });

  it('THE COMPARE-AND-SET: a stale claim is refused with the status that won', async () => {
    const accountId = await openAccount({ code: 'CS-CAS' });
    await caller.credit.setStatus({
      idempotencyKey: uuidv7(),
      accountId,
      status: 'SUSPENDED',
      expectedStatus: 'ACTIVE',
      reason: 'first decision, taken by somebody else',
    });
    // A second person, still looking at the screen from before.
    await expect(
      caller.credit.setStatus({
        idempotencyKey: uuidv7(),
        accountId,
        status: 'CLOSED',
        expectedStatus: 'ACTIVE',
        reason: 'deciding against a picture that has moved',
      }),
    ).rejects.toThrow(/CREDIT_STATUS_STALE.*believed was ACTIVE, and it is SUSPENDED/s);
    expect(await statusOf(accountId)).toBe('SUSPENDED');
  });

  it('a reason is REQUIRED, and a three-character shrug is not one', async () => {
    const accountId = await openAccount({ code: 'CS-REASON' });
    await expect(
      caller.credit.setStatus({
        idempotencyKey: uuidv7(),
        accountId,
        status: 'SUSPENDED',
        expectedStatus: 'ACTIVE',
        reason: '  ',
      }),
    ).rejects.toThrow();
    expect(await statusOf(accountId)).toBe('ACTIVE');
  });

  it('a replayed key returns the same decision and appends nothing', async () => {
    const accountId = await openAccount({ code: 'CS-IDEM' });
    const body = {
      idempotencyKey: uuidv7(),
      accountId,
      status: 'SUSPENDED' as const,
      expectedStatus: 'ACTIVE' as const,
      reason: 'payment plan broken twice',
    };
    const first = await caller.credit.setStatus(body);
    const second = await caller.credit.setStatus(body);
    expect(second.changeId).toBe(first.changeId);
    const n = await h.db.withTenant(tenantId, (tx) =>
      tx.query<{ n: string }>(
        `select count(*)::text as n from app.credit_status_change where credit_account_id = $1`,
        [accountId],
      ),
    );
    expect(n.rows[0]!.n).toBe('1');
  });

  it('records WHO, WHEN and WHY — the question somebody asks three months later', async () => {
    const accountId = await openAccount({ code: 'CS-AUDIT' });
    await charge(accountId, '90000');
    await caller.credit.setStatus({
      idempotencyKey: uuidv7(),
      accountId,
      status: 'SUSPENDED',
      expectedStatus: 'ACTIVE',
      reason: 'cheque returned unpaid on 12 August',
    });
    const row = await h.db.withTenant(tenantId, (tx) =>
      tx.query<{
        from_status: string;
        to_status: string;
        note: string;
        reason_code: string;
        decided_by: string;
        exposure: string;
        created_at: string;
      }>(
        `select from_status, to_status, note, reason_code, decided_by,
                exposure_at_decision_minor::text as exposure, created_at::text
         from app.credit_status_change where credit_account_id = $1`,
        [accountId],
      ),
    );
    const decision = row.rows[0]!;
    expect(decision.from_status).toBe('ACTIVE');
    expect(decision.to_status).toBe('SUSPENDED');
    expect(decision.note).toBe('cheque returned unpaid on 12 August');
    expect(decision.reason_code).toBe('MANUAL');
    expect(decision.decided_by).toBeTruthy();
    expect(decision.created_at).toBeTruthy();
    // The figure the rule was applied to, recorded rather than recomputed.
    expect(decision.exposure).toBe('90000');
  });

  it('THE HISTORY IS APPEND-ONLY: the database refuses UPDATE and DELETE', async () => {
    const accountId = await openAccount({ code: 'CS-APPEND' });
    const res = await caller.credit.setStatus({
      idempotencyKey: uuidv7(),
      accountId,
      status: 'SUSPENDED',
      expectedStatus: 'ACTIVE',
      reason: 'stopped answering the phone',
    });
    await expect(
      h.db.withTenant(tenantId, (tx) =>
        tx.query(`update app.credit_status_change set note = 'never happened' where id = $1`, [
          res.changeId,
        ]),
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      h.db.withTenant(tenantId, (tx) =>
        tx.query(`delete from app.credit_status_change where id = $1`, [res.changeId]),
      ),
    ).rejects.toThrow(/append-only/);
    expect(await statusOf(accountId)).toBe('SUSPENDED');
  });

  it('THE DATABASE REFUSES a direct write to the projected status column', async () => {
    const accountId = await openAccount({ code: 'CS-BACKSTOP' });
    await expect(
      h.db.withTenant(tenantId, (tx) =>
        tx.query(`update app.customer_account set status = 'SUSPENDED' where id = $1`, [accountId]),
      ),
    ).rejects.toThrow(/projection of app.credit_status_change/);
    expect(await statusOf(accountId)).toBe('ACTIVE');
  });

  it('is invisible across a tenant boundary — a second tenant cannot suspend it', async () => {
    const accountId = await openAccount({ code: 'CS-ISO' });
    const other = await h.provisionTenant('credit-status-t2');
    const otherCaller = h.callerFor(await h.identityFor(other, { role: 'accounts' }));
    await expect(
      otherCaller.credit.setStatus({
        idempotencyKey: uuidv7(),
        accountId,
        status: 'SUSPENDED',
        expectedStatus: 'ACTIVE',
        reason: 'another tenant reaching across the boundary',
      }),
    ).rejects.toThrow(/credit account not found/);
    expect(await statusOf(accountId)).toBe('ACTIVE');
    // The decision log is scoped the same way: not one row is readable.
    const seen = await h.db.withTenant(other, (tx) =>
      tx.query<{ n: string }>(`select count(*)::text as n from app.credit_status_change`),
    );
    expect(seen.rows[0]!.n).toBe('0');
  });
});

describe('who may cut a customer off', () => {
  it('an outlet manager may NOT see the status and may NOT change it; accounts may both', async () => {
    const accounts = h.callerFor(await h.principal(roleTenantId, { roleRef: 'accounts' }));
    const opened = await accounts.credit.openAccount({
      idempotencyKey: uuidv7(),
      newCustomer: { code: 'CS-RBAC', name: 'Customer CS-RBAC' },
      termsDays: 30,
      feeRateBpPerMonth: 200,
      creditLimitMinor: '500000',
    });
    const manager = h.callerFor(await h.principal(roleTenantId, { roleRef: 'outlet_manager' }));

    // The positive control on the principal, on a route it holds — see the
    // note in "who may change a limit". The manager no longer holds
    // `credit.view`, so it cannot see the status either.
    const control = await manager.inventory.lowStock({});
    expect(control.scope.locationCount).toBeGreaterThan(0);
    await expect(manager.credit.exposure({ accountId: opened.accountId })).rejects.toThrow(
      /PERMISSION_DENIED: credit\.view/,
    );

    await expect(
      manager.credit.setStatus({
        idempotencyKey: uuidv7(),
        accountId: opened.accountId,
        status: 'SUSPENDED',
        expectedStatus: 'ACTIVE',
        reason: 'the manager thinks they are slow',
      }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    expect((await accounts.credit.exposure({ accountId: opened.accountId })).status).toBe('ACTIVE');

    // THE POSITIVE CONTROL ON THE CAPABILITY ITSELF: the holder may.
    await accounts.credit.setStatus({
      idempotencyKey: uuidv7(),
      accountId: opened.accountId,
      status: 'SUSPENDED',
      expectedStatus: 'ACTIVE',
      reason: 'accounts has reviewed the ageing and stopped the account',
    });
    expect((await accounts.credit.exposure({ accountId: opened.accountId })).status).toBe(
      'SUSPENDED',
    );
  });

  it('counter staff cannot reach the route at all', async () => {
    const accounts = h.callerFor(await h.principal(roleTenantId, { roleRef: 'accounts' }));
    const opened = await accounts.credit.openAccount({
      idempotencyKey: uuidv7(),
      newCustomer: { code: 'CS-RBAC-2', name: 'Customer CS-RBAC-2' },
      termsDays: 30,
      feeRateBpPerMonth: 200,
      creditLimitMinor: '500000',
    });
    const counter = h.callerFor(await h.principal(roleTenantId, { roleRef: 'counter_staff' }));
    await expect(
      counter.credit.setStatus({
        idempotencyKey: uuidv7(),
        accountId: opened.accountId,
        status: 'SUSPENDED',
        expectedStatus: 'ACTIVE',
        reason: 'not this person’s decision',
      }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });
});

/**
 * THE WHOLE POINT, driven through the real sale path.
 *
 * `sales.createSale` reads `customer_account.status` and refuses credit tender
 * on anything that is not exactly 'ACTIVE'. This group proves that the values
 * `setStatus` produces are the values that check recognises — a mismatch would
 * suspend an account the till still honoured, which is worse than no feature —
 * and that a CASH sale to the same customer is untouched, because suspending
 * credit must not stop the customer buying (credit-offline-plan R4).
 */
describe('a suspended account is refused a credit sale AT THE TILL', () => {
  let saleTenant: string;
  let outletId: string;
  let productId: string;
  let officeCaller: ReturnType<ApiHarness['callerFor']>;
  let tillCaller: ReturnType<ApiHarness['callerFor']>;
  let customerId: string;
  let accountId: string;
  let receipt = 0;

  function nextReceipt(): string {
    receipt += 1;
    return `CS-${String(receipt).padStart(5, '0')}`;
  }

  beforeAll(async () => {
    saleTenant = await h.provisionTenant('credit-status-sale');
    await h.applyTemplate(saleTenant);
    outletId = (await h.outlets(saleTenant, 1))[0]!.id;
    productId = (await h.pickProduct(saleTenant)).id;
    await h.seedWholesalePrice(saleTenant, productId, 10_000_000n); // GH₵10.00/unit

    officeCaller = h.callerFor(await h.principal(saleTenant, { roleRef: 'accounts' }));
    tillCaller = h.callerFor(
      await h.principal(saleTenant, { roleRef: 'outlet_manager', scopeLocationId: outletId }),
    );

    const opened = await officeCaller.credit.openAccount({
      idempotencyKey: uuidv7(),
      newCustomer: { code: 'CS-TILL', name: 'Till Test Contractor' },
      termsDays: 30,
      feeRateBpPerMonth: 200,
      creditLimitMinor: '99999999',
    });
    customerId = opened.customerId;
    accountId = opened.accountId;
  }, 180_000);

  function sale(tender: 'CASH' | 'CREDIT') {
    return {
      idempotencyKey: uuidv7(),
      locationId: outletId,
      priceListCode: 'WHOLESALE',
      receiptNo: nextReceipt(),
      businessDate: TODAY,
      tender,
      lines: [{ productId, qty: '1' }],
      ...(tender === 'CREDIT' ? { customerId } : {}),
    };
  }

  it('sells on credit while ACTIVE — the positive control the refusal is measured against', async () => {
    await expect(tillCaller.sales.createSale(sale('CREDIT'))).resolves.toMatchObject({
      tender: 'CREDIT',
    });
  });

  it('the till REFUSES the credit sale once accounts suspends the customer', async () => {
    await officeCaller.credit.setStatus({
      idempotencyKey: uuidv7(),
      accountId,
      status: 'SUSPENDED',
      expectedStatus: 'ACTIVE',
      reason: 'ageing review: 61-90 bucket and no contact',
    });
    await expect(tillCaller.sales.createSale(sale('CREDIT'))).rejects.toThrow(
      /credit account is SUSPENDED/,
    );
  });

  it('…and the SAME customer may still buy for CASH. Suspending credit is not a ban', async () => {
    await expect(tillCaller.sales.createSale(sale('CASH'))).resolves.toMatchObject({
      tender: 'CASH',
    });
  });

  it('a CLOSED account is refused too — the check is an allow-list of one', async () => {
    // Settle the balance the credit sale left, so the close is legal.
    const owed = await officeCaller.credit.exposure({ accountId });
    await officeCaller.credit.recordEntry({
      idempotencyKey: uuidv7(),
      accountId,
      kind: 'PAYMENT',
      amountMinor: `-${owed.exposureMinor}`,
      businessDate: TODAY,
    });
    await officeCaller.credit.setStatus({
      idempotencyKey: uuidv7(),
      accountId,
      status: 'CLOSED',
      expectedStatus: 'SUSPENDED',
      reason: 'settled in full and closed',
    });
    await expect(tillCaller.sales.createSale(sale('CREDIT'))).rejects.toThrow(
      /credit account is CLOSED/,
    );
  });

  it('reinstating the account puts the till back to work', async () => {
    await officeCaller.credit.setStatus({
      idempotencyKey: uuidv7(),
      accountId,
      status: 'ACTIVE',
      expectedStatus: 'CLOSED',
      reason: 'customer settled and asked to trade again',
    });
    await expect(tillCaller.sales.createSale(sale('CREDIT'))).resolves.toMatchObject({
      tender: 'CREDIT',
    });
  });
});
