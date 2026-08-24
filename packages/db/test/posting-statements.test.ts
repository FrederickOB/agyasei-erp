/**
 * THE STATEMENTS — and the equivalence §5.9.1 says must be asserted, not
 * assumed.
 *
 * "Drop `location_id` from the projection and the GROUP BY and the same query
 * is the consolidated statement. That equivalence is the payoff of §5.5, and
 * it is asserted as a test, not assumed." So: consolidated === Σ locations, on
 * a ledger built by the real posting engine from the real rules.
 *
 * Nothing here inserts a journal line by hand. Every figure below is the
 * consequence of documents posted through `postDocument`, so a statement that
 * agrees with the fixture proves the whole chain — rule, mapping, engine,
 * journal, report — rather than proving a SQL query against rows a test wrote.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.js';
import { postDocument } from '../src/posting/engine.js';
import { paymentEntry, saleEntry, transferEntry } from '../src/posting/rules.js';
import {
  balanceSheet, clearingNet, profitAndLoss, statementsReconcile, trialBalance,
} from '../src/posting/statements.js';
import type { Queryable, TestDb } from '../src/testing/harness.js';
import { makeLocation } from './rbac-fixtures.js';
import { setupDb, setupTwoTenants, TENANT_A, TENANT_B } from './util.js';

let db: TestDb;
let techiman: string;
let sunyani: string;
let clearingAccount: string;
const POSTER = '018f0000-0000-8000-8000-0000000000ff';
const CUSTOMER = '018f0000-0000-8000-8000-00000000c0de';
const FY = 'FY27';
const OPTS = { tenantId: TENANT_A, postedBy: POSTER, postingRuleVersion: 1 };

async function account(
  tx: Queryable, tenantId: string,
  spec: { code: string; type: string; control?: string | null },
): Promise<string> {
  const id = uuidv7();
  await tx.query(
    `insert into app.gl_account
       (tenant_id, id, code, name, account_type, normal_balance, is_postable,
        control_account_kind, report_line_key)
     values ($1,$2,$3,$4,$5,$6,true,$7,$8)`,
    [tenantId, id, spec.code, `Test ${spec.code}`, spec.type,
     spec.type === 'ASSET' || spec.type === 'EXPENSE' ? 'D' : 'C',
     spec.control ?? null, `line:${spec.code}`],
  );
  return id;
}

async function mapRole(tx: Queryable, tenantId: string, role: string, accountId: string): Promise<void> {
  await tx.query(
    `insert into app.gl_account_mapping
       (tenant_id, id, posting_role, scope_kind, account_id, mapping_set_version, effective_from)
     values ($1,$2,$3,'tenant',$4,1,'2026-01-01')`,
    [tenantId, uuidv7(), role, accountId],
  );
}

async function calendar(tx: Queryable, tenantId: string): Promise<void> {
  await tx.query(
    `insert into app.fiscal_year (tenant_id, fy_code, starts_on, ends_on)
     values ($1,$2,'2026-08-01','2027-07-31')`, [tenantId, FY]);
  await tx.query(`insert into app.gl_counter (tenant_id, fy_code) values ($1,$2)`, [tenantId, FY]);
  await tx.query(
    `insert into app.accounting_period (tenant_id, id, fy_code, seq, starts_on, ends_on)
     values ($1,$2,$3,1,'2026-08-01','2026-08-31')`, [tenantId, uuidv7(), FY]);
}

beforeAll(async () => {
  db = await setupDb();
  await setupTwoTenants(db);
  await db.withTenant(TENANT_A, async (tx) => {
    techiman = await makeLocation(tx, TENANT_A, { code: 'ST-01' });
    sunyani = await makeLocation(tx, TENANT_A, { code: 'ST-02' });
    await calendar(tx, TENANT_A);
    clearingAccount = await account(tx, TENANT_A, { code: '1900', type: 'ASSET' });
    await mapRole(tx, TENANT_A, 'TILL_CASH', await account(tx, TENANT_A, { code: '1000', type: 'ASSET', control: 'TILL' }));
    await mapRole(tx, TENANT_A, 'SALES_REVENUE', await account(tx, TENANT_A, { code: '4100', type: 'INCOME' }));
    await mapRole(tx, TENANT_A, 'OUTPUT_TAX', await account(tx, TENANT_A, { code: '2200', type: 'LIABILITY' }));
    await mapRole(tx, TENANT_A, 'COGS', await account(tx, TENANT_A, { code: '5000', type: 'EXPENSE' }));
    await mapRole(tx, TENANT_A, 'INVENTORY', await account(tx, TENANT_A, { code: '1300', type: 'ASSET', control: 'INVENTORY' }));
    await mapRole(tx, TENANT_A, 'INVENTORY_IN_TRANSIT', await account(tx, TENANT_A, { code: '1350', type: 'ASSET' }));
    await mapRole(tx, TENANT_A, 'AR_TRADE', await account(tx, TENANT_A, { code: '1400', type: 'ASSET', control: 'AR' }));
    await mapRole(tx, TENANT_A, 'INTERLOC_CLEARING', clearingAccount);
  });

  // ── A DAY OF TRADE, posted through the real engine. ─────────────────────
  // Techiman: a cash sale and a credit sale.
  for (const doc of [
    saleEntry({
      saleId: uuidv7(), locationId: techiman, businessDate: '2026-08-15', tender: 'CASH',
      revenueMinor: 15_000n, discountMinor: 0n,
      taxes: [{ taxCode: 'GH.VAT.STD', taxMinor: 3_000n }], costMinor: 9_000n,
    }),
    saleEntry({
      saleId: uuidv7(), locationId: techiman, businessDate: '2026-08-15', tender: 'CREDIT',
      customerId: CUSTOMER, revenueMinor: 500_000n, discountMinor: 0n,
      taxes: [{ taxCode: 'GH.VAT.STD', taxMinor: 100_000n }], costMinor: 300_000n,
    }),
    // Sunyani: a cash sale.
    saleEntry({
      saleId: uuidv7(), locationId: sunyani, businessDate: '2026-08-16', tender: 'CASH',
      revenueMinor: 40_000n, discountMinor: 0n,
      taxes: [{ taxCode: 'GH.VAT.STD', taxMinor: 8_000n }], costMinor: 25_000n,
    }),
    // The contractor pays at SUNYANI against TECHIMAN's invoice.
    paymentEntry({
      paymentId: uuidv7(), businessDate: '2026-08-20',
      receivingLocationId: sunyani, obligationLocationId: techiman,
      customerId: CUSTOMER, amountMinor: 600_000n, instrument: 'CASH',
    }),
    // Stock moves between the two outlets.
    transferEntry({
      transferId: uuidv7(), businessDate: '2026-08-22',
      fromLocationId: techiman, toLocationId: sunyani, costMinor: 120_000n,
    }),
  ]) {
    const r = await postDocument(db, doc, OPTS);
    if (r.status !== 'posted') {
      throw new Error(`fixture failed to post: ${JSON.stringify(r)}`);
    }
  }
}, 240_000);

afterAll(async () => {
  await db?.close();
});

describe('the trial balance — §5.9.2, the most useful diagnostic in the system', () => {
  it('sums to zero for the tenant', async () => {
    const tb = await db.withTenant(TENANT_A, (tx) => trialBalance(tx));
    expect(tb.balanced).toBe(true);
    expect(tb.debitMinor).toBe(tb.creditMinor);
    // Non-vacuous: there is genuinely trade in here. A balanced empty ledger
    // would satisfy the assertion above and prove nothing.
    expect(tb.debitMinor).toBeGreaterThan(0n);
    expect(tb.rows.length).toBeGreaterThan(4);
  });

  it('…AND for every location independently', async () => {
    // Only possible because entries balance per location (§5.5.3). This is
    // the assertion that would have caught the mis-attribution defect, which
    // the tenant-level total above is blind to.
    const tb = await db.withTenant(TENANT_A, (tx) => trialBalance(tx));
    expect(tb.byLocation).toHaveLength(2);
    for (const loc of tb.byLocation) {
      expect(loc.balanced).toBe(true);
      expect(loc.debitMinor).toBeGreaterThan(0n);
    }
  });
});

describe('consolidated === Σ locations — the equivalence §5.9.1 refuses to assume', () => {
  it('the P&L is the same figure grouped or not', async () => {
    const consolidated = await db.withTenant(TENANT_A, (tx) => profitAndLoss(tx));
    const perLocation = await db.withTenant(TENANT_A, (tx) =>
      profitAndLoss(tx, { byLocation: true }));

    const summed = perLocation.rows.reduce((a, r) => a + r.amountMinor, 0n);
    const straight = consolidated.rows.reduce((a, r) => a + r.amountMinor, 0n);
    expect(summed).toBe(straight);
    expect(consolidated.revenueMinor).toBe(555_000n); // 15,000 + 500,000 + 40,000
    expect(consolidated.expenseMinor).toBe(334_000n); // 9,000 + 300,000 + 25,000
    expect(consolidated.resultMinor).toBe(221_000n);
  });

  it('the balance sheet is too', async () => {
    const consolidated = await db.withTenant(TENANT_A, (tx) => balanceSheet(tx));
    const perLocation = await db.withTenant(TENANT_A, (tx) =>
      balanceSheet(tx, { byLocation: true }));
    const summed = perLocation.rows.reduce((a, r) => a + r.amountMinor, 0n);
    const straight = consolidated.rows.reduce((a, r) => a + r.amountMinor, 0n);
    expect(summed).toBe(straight);
  });

  it('one location’s P&L is NOT the network’s — the negative control', async () => {
    // Without this, the equivalence tests above would pass on a query that
    // ignored the location filter entirely.
    const techimanOnly = await db.withTenant(TENANT_A, (tx) =>
      profitAndLoss(tx, { locationIds: [techiman] }));
    const network = await db.withTenant(TENANT_A, (tx) => profitAndLoss(tx));
    expect(techimanOnly.revenueMinor).toBe(515_000n); // 15,000 + 500,000
    expect(techimanOnly.revenueMinor).toBeLessThan(network.revenueMinor);
  });
});

describe('a transfer cannot inflate consolidated revenue — §5.6.3', () => {
  it('the 120,000 of stock moved between outlets appears in NO income account', async () => {
    // Structural, not a reporting elimination: the transfer rule never touches
    // an income account, so there is nothing to eliminate and no step that
    // could be forgotten.
    const pl = await db.withTenant(TENANT_A, (tx) => profitAndLoss(tx));
    expect(pl.revenueMinor).toBe(555_000n); // the three sales, and nothing else
    const incomeRows = pl.rows.filter((r) => r.accountType === 'INCOME');
    expect(incomeRows.every((r) => r.code === '4100')).toBe(true);
  });

  it('…but it DID move stock between the two locations', async () => {
    // The positive control: if the transfer had not posted, the test above
    // would pass for the wrong reason.
    const perLocation = await db.withTenant(TENANT_A, (tx) =>
      balanceSheet(tx, { byLocation: true }));
    const inTransit = perLocation.rows.find(
      (r) => r.code === '1350' && r.locationId === sunyani);
    expect(inTransit?.amountMinor).toBe(120_000n);
  });
});

describe('inter-location clearing nets to zero', () => {
  it('across the tenant — so it drops out of the consolidated balance sheet', async () => {
    const net = await db.withTenant(TENANT_A, (tx) => clearingNet(tx, clearingAccount));
    expect(net).toBe(0n);
  });

  it('…while being NON-ZERO at each location, which is what makes theirs balance', async () => {
    // "Due to/from other locations". A clearing account that were zero
    // everywhere would mean the pairs had never been written.
    const perLocation = await db.withTenant(TENANT_A, (tx) =>
      balanceSheet(tx, { byLocation: true }));
    const clearing = perLocation.rows.filter((r) => r.accountId === clearingAccount);
    expect(clearing.length).toBe(2);
    expect(clearing.every((r) => r.amountMinor !== 0n)).toBe(true);
    expect(clearing.reduce((a, r) => a + r.amountMinor, 0n)).toBe(0n);
  });
});

describe('the two statements agree about one ledger', () => {
  it('assets − (liabilities + equity) === revenue − expenses, on any day', async () => {
    // Mid-year the balance sheet does NOT sum to zero, and that is correct:
    // the period's profit sits in income and expense until year-end close.
    // This identity is the stronger statement and holds every day.
    const r = await db.withTenant(TENANT_A, (tx) => statementsReconcile(tx));
    expect(r.reconciles).toBe(true);
    expect(r.resultMinor).toBe(221_000n);
    expect(r.gapMinor).toBe(221_000n);
  });

  it('and it holds per location too', async () => {
    for (const locationId of [techiman, sunyani]) {
      const r = await db.withTenant(TENANT_A, (tx) =>
        statementsReconcile(tx, { locationIds: [locationId] }));
      expect(r.reconciles).toBe(true);
    }
  });
});

describe('the receivable cleared where the obligation lived — read off the statements', () => {
  it('Techiman’s AR is nil after the payment, and Sunyani never carried one', async () => {
    // The mis-attribution defect, expressed as the report that would have
    // exposed it. The contractor bought 600,000 at Techiman and paid at
    // Sunyani; if the AR had cleared at the till, Techiman would show a
    // permanent 600,000 debit and Sunyani a permanent credit on an asset.
    const perLocation = await db.withTenant(TENANT_A, (tx) =>
      balanceSheet(tx, { byLocation: true }));
    const ar = perLocation.rows.filter((r) => r.code === '1400');
    const techimanAr = ar.find((r) => r.locationId === techiman);
    const sunyaniAr = ar.find((r) => r.locationId === sunyani);

    // Asserted STRICTLY, because `x === undefined || x === 0` passes when the
    // row is simply absent — and an absent row is exactly what a broken
    // fixture produces. Techiman's AR must EXIST (the credit sale used it)
    // and net to nil (the payment cleared it); Sunyani's must never have been
    // touched at all.
    expect(techimanAr).toBeDefined();
    expect(techimanAr!.amountMinor).toBe(0n);
    expect(sunyaniAr).toBeUndefined();
  });
});

describe('tenant isolation on every statement — §2.7 category 3', () => {
  it('tenant B’s statements are empty while A’s are not', async () => {
    const bTb = await db.withTenant(TENANT_B, (tx) => trialBalance(tx));
    const bPl = await db.withTenant(TENANT_B, (tx) => profitAndLoss(tx));
    const bBs = await db.withTenant(TENANT_B, (tx) => balanceSheet(tx));

    expect(bTb.rows).toHaveLength(0);
    expect(bPl.revenueMinor).toBe(0n);
    expect(bBs.rows).toHaveLength(0);

    // The positive control that makes the emptiness meaningful.
    const aTb = await db.withTenant(TENANT_A, (tx) => trialBalance(tx));
    expect(aTb.rows.length).toBeGreaterThan(0);
  });

  it('naming tenant A’s location from tenant B returns nothing, not A’s figures', async () => {
    const leaked = await db.withTenant(TENANT_B, (tx) =>
      profitAndLoss(tx, { locationIds: [techiman] }));
    expect(leaked.revenueMinor).toBe(0n);
    expect(leaked.rows).toHaveLength(0);
  });
});
