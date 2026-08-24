/**
 * THE SWEEP — the last wire in Phase 3's mechanism, tested end to end.
 *
 * Every sale here is rung through the REAL sale router (server-priced against
 * the tenant's own price list and tax pack), then swept into the ledger, and
 * the statements are asserted against Σ(app.sale) — the one reconciliation
 * that ties the operational system to the books. If these two ever disagree,
 * one of them is lying, and that is the first thing the §2.8 reviewer's
 * month of statements exists to catch.
 *
 * The chart of accounts is the DRAFT dev fixture (seedDevLedger) — the same
 * rows the dev stack runs, so what is tested is what is demoed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDevLedger, sweepSettledSales, uuidv7 } from '@erp/db';
import type { VerifiedIdentity } from '../src/auth.js';
import { createApiHarness, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenantId: string;
let outlet: string;
let creditCustomerId: string;
let accounts: { identity: VerifiedIdentity; caller: ReturnType<ApiHarness['callerFor']> };
let owner: ReturnType<ApiHarness['callerFor']>;
const SWEEP = () =>
  sweepSettledSales(h.db, { tenantId, postedBy: accounts.identity.userId, postingRuleVersion: 1 });

let receiptSeq = 0;
function sale(opts: { qty: string; credit?: boolean; discount?: bigint; knownCustomer?: boolean }) {
  receiptSeq += 1;
  return {
    idempotencyKey: uuidv7(),
    locationId: outlet,
    priceListCode: 'WHOLESALE',
    receiptNo: `SW-${String(receiptSeq).padStart(5, '0')}`,
    businessDate: '2026-08-21',
    tender: (opts.credit ? 'CREDIT' : 'CASH') as 'CREDIT' | 'CASH',
    ...(opts.credit || opts.knownCustomer ? { customerId: creditCustomerId } : {}),
    lines: [{
      productId,
      qty: opts.qty,
      ...(opts.discount === undefined ? {} : { lineDiscountMinor: opts.discount.toString(10) }),
    }],
  };
}
let productId: string;

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('sweep-a');
  await h.applyTemplate(tenantId, true);
  const root = await h.locationByCode(tenantId, 'ROOT');
  outlet = (await h.outlets(tenantId, 1))[0]!.id;
  productId = (await h.pickProduct(tenantId)).id;
  await h.seedWholesalePrice(tenantId, productId, 55_000_000n); // GH₵55.00/unit

  const seeded = await h.db.withTenant(tenantId, (tx) => seedDevLedger(tx, tenantId));
  // The draft must satisfy its own completeness gate, or the sweep opens
  // exceptions the seed itself caused.
  expect(seeded.unmappedRequired).toEqual([]);

  owner = h.callerFor(await h.identityFor(tenantId, { locs: [root, outlet] }));
  const account = await owner.credit.openAccount({
    idempotencyKey: uuidv7(),
    newCustomer: { code: 'SW-C1', name: 'Sweep Contractor' },
    termsDays: 30, feeRateBpPerMonth: 200, creditLimitMinor: '99999999999',
  });
  creditCustomerId = account.customerId;

  const identity = await h.principal(tenantId, { roleRef: 'accounts', scopeLocationId: root });
  accounts = { identity, caller: h.callerFor(identity) };
}, 240_000);

afterAll(async () => {
  await h?.close();
});

describe('settled sales reach the books, and the books tie to the sales', () => {
  it('sweeps a cash sale, a credit sale, and a KNOWN-CUSTOMER cash sale correctly', async () => {
    await owner.sales.createSale(sale({ qty: '3' })); // anonymous cash
    await owner.sales.createSale(sale({ qty: '5', credit: true })); // credit
    // The trap: cash tender, but the customer is named on the sale. Inferring
    // tender from customer_id would debit AR for money already in the till.
    await owner.sales.createSale(sale({ qty: '2', knownCustomer: true }));

    const result = await SWEEP();
    expect(result.examined).toBe(3);
    expect(result.posted).toBe(3);
    expect(result.exceptions).toBe(0);

    // The ledger's AR equals the CREDIT sale's total alone — the known-customer
    // cash sale went to the till, where the money actually is.
    const figures = await h.db.withTenant(tenantId, async (tx) => {
      const r = await tx.query<{ code: string; net: string }>(
        `select a.code, (sum(l.debit_minor) - sum(l.credit_minor))::text as net
           from app.journal_line l
           join app.gl_account a on a.tenant_id = l.tenant_id and a.id = l.account_id
           join app.journal_entry e on e.tenant_id = l.tenant_id and e.id = l.journal_entry_id
          where e.status = 'posted' group by a.code`);
      return new Map(r.rows.map((x) => [x.code, BigInt(x.net)]));
    });
    const saleTotals = await h.db.withTenant(tenantId, async (tx) => {
      const r = await tx.query<{ credit_total: string; cash_total: string; tax: string; net: string; disc: string }>(
        `select
           coalesce(sum(total_minor) filter (where exists
             (select 1 from app.credit_entry ce where ce.source_kind='SALE' and ce.source_id=s.id and ce.kind='CHARGE')), 0)::text as credit_total,
           coalesce(sum(total_minor) filter (where not exists
             (select 1 from app.credit_entry ce where ce.source_kind='SALE' and ce.source_id=s.id and ce.kind='CHARGE')), 0)::text as cash_total,
           coalesce(sum(tax_total_minor), 0)::text as tax,
           coalesce(sum(subtotal_net_minor), 0)::text as net,
           coalesce(sum(discount_minor), 0)::text as disc
         from app.sale s where deleted_at is null`);
      return r.rows[0]!;
    });

    // THE RECONCILIATION: books ≡ operational system, figure by figure.
    expect(figures.get('1400') ?? 0n).toBe(BigInt(saleTotals.credit_total)); // AR = credit sales
    expect(figures.get('1000') ?? 0n).toBe(BigInt(saleTotals.cash_total)); // till = cash sales
    expect(-(figures.get('2200') ?? 0n)).toBe(BigInt(saleTotals.tax)); // output tax
    expect(-(figures.get('4100') ?? 0n)).toBe(BigInt(saleTotals.net)); // revenue gross of discount
  });

  it('the trial balance is balanced and the statements agree, over the router', async () => {
    const tb = await accounts.caller.ledger.trialBalance({});
    expect(tb.balanced).toBe(true);
    expect(BigInt(tb.debitMinor)).toBeGreaterThan(0n);
    const bs = await accounts.caller.ledger.balanceSheet({});
    expect(bs.reconciles).toBe(true);
  });

  it('a second sweep posts NOTHING — idempotent by the document', async () => {
    const again = await SWEEP();
    expect(again.examined).toBe(0);
    expect(again.posted).toBe(0);
  });

  it('a discounted sale posts revenue GROSS with the discount as contra', async () => {
    const priced = await owner.sales.createSale(sale({ qty: '4', discount: 5_000n }));
    const result = await SWEEP();
    expect(result.posted).toBe(1);

    const contra = await h.db.withTenant(tenantId, async (tx) => {
      const r = await tx.query<{ net: string }>(
        `select coalesce(sum(l.debit_minor) - sum(l.credit_minor), 0)::text as net
           from app.journal_line l
           join app.gl_account a on a.tenant_id = l.tenant_id and a.id = l.account_id
          where a.code = '4190'`);
      return BigInt(r.rows[0]!.net);
    });
    expect(contra).toBe(BigInt(priced.discountMinor)); // debit — the contra carries the discount
  });

  it('a sale marked as a VOID document is never swept', async () => {
    // No void route exists yet (sale.void guards nothing reachable — a known
    // Phase 1 residue), so this drives the worklist clause directly: plant a
    // row with voids_sale_id set and assert the sweep refuses to examine it.
    // When the void route arrives, its own suite replaces this.
    await h.db.withTenant(tenantId, async (tx) => {
      const target = await tx.query<{ id: string }>(`select id from app.sale limit 1`);
      await tx.query(
        `insert into app.sale (tenant_id, id, write_id, hlc, location_id, price_list_id,
                               receipt_no, business_date, occurred_at, currency_code, money_scale,
                               subtotal_net_minor, discount_minor, tax_total_minor, total_minor,
                               voids_sale_id)
         select tenant_id, $1::uuid, write_id, hlc, location_id, price_list_id,
                'SW-VOID-1', business_date, occurred_at, currency_code, money_scale,
                subtotal_net_minor, discount_minor, tax_total_minor, total_minor, $2::uuid
           from app.sale where id = $2::uuid`,
        [uuidv7(), target.rows[0]!.id],
      );
    });
    const swept = await SWEEP();
    expect(swept.examined).toBe(0);
  });

  it('NO COGS line exists anywhere — Q16 is a gate, not a default', async () => {
    const cogs = await h.db.withTenant(tenantId, async (tx) => {
      const r = await tx.query<{ n: string }>(
        `select count(*)::text n from app.journal_line l
           join app.gl_account a on a.tenant_id = l.tenant_id and a.id = l.account_id
          where a.code = '5000'`);
      return Number(r.rows[0]!.n);
    });
    expect(cogs).toBe(0);
  });
});

describe('a failed posting opens an exception and touches nothing', () => {
  it('breaking a mapping turns the NEXT sale into an exception the screen can show', async () => {
    await h.db.withTenant(tenantId, (tx) =>
      tx.query(`update app.gl_account_mapping set effective_to = '2026-08-02'
                 where posting_role = 'SALES_REVENUE'`));
    await owner.sales.createSale(sale({ qty: '1' }));

    const result = await SWEEP();
    expect(result.exceptions).toBe(1);
    expect(result.posted).toBe(0);

    const listed = await accounts.caller.ledger.postingExceptions({});
    expect(listed.openCount).toBe(1);
    expect(listed.exceptions[0]!.errorCode).toBe('GL_MAPPING_MISSING');

    // …and the sale itself is untouched: settled, present, unposted.
    // Restore the mapping; the retry posts and RESOLVES the exception.
    await h.db.withTenant(tenantId, (tx) =>
      tx.query(`update app.gl_account_mapping set effective_to = null
                 where posting_role = 'SALES_REVENUE'`));
    const retry = await SWEEP();
    expect(retry.posted).toBe(1);
    const after = await accounts.caller.ledger.postingExceptions({});
    expect(after.openCount).toBe(0);
  });
});
