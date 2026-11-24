/**
 * BUSINESS EXPENSES AND THE MANAGEMENT P&L SHEET (migration 0033).
 *
 * Real routers, real migrations, RLS as `app_user`. The mandatory categories
 * (CLAUDE.md §2.7):
 *
 *  1. MONEY. An amount typed as "1250.50" lands as exactly 125050 minor units
 *     against the PACK's scale; a digit beyond the currency's places is
 *     refused, not rounded. The P&L is checked against figures computed BY
 *     HAND below — a weighted-average-cost product, a product valued at its
 *     stated cost, a product with no cost at all (listed, never guessed), a
 *     return netted out of both sales and cost, and a voided expense excluded.
 *  2. IDEMPOTENCY. The same key replays the same answer and writes one row;
 *     the same key with a different payload is refused.
 *  3. TENANT ISOLATION. Every query procedure carries an `[isolation:…]` test:
 *     tenant B demonstrably holds rows, none of them reach A's answer, A's
 *     figures are exactly A's, and naming B's ids answers exactly as an id
 *     that exists nowhere.
 *
 * And the boundary this feature lives inside: NOTHING here writes the general
 * ledger. Asserted, not assumed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { minorScaleDigits, parseMajorAmount } from '@erp/contracts';
import { uuidv7 } from '@erp/db';
import type { VerifiedIdentity } from '../src/auth.js';
import {
  assertSameAsNonexistent,
  breachUnless,
  idUniverse,
  leakDetector,
  type LeakDetector,
} from './isolation-world.js';
import { createApiHarness, type ApiHarness, type TemplateTenderIds } from './util.js';

let h: ApiHarness;
let tenantA: string;
let tenantB: string;
let root: string;
let out01: string;
let out02: string;
let bOutlet: string;
let p1: string; // costed receipts at out01 and out02 → weighted-average cost
let p2: string; // no costed receipt anywhere, but a STATED cost → fallback
let p3: string; // no cost of any kind → missing, listed
let p3Sku: string;
let tm: TemplateTenderIds;

type Caller = ReturnType<ApiHarness['callerFor']>;
let ownerIdentity: VerifiedIdentity;
let owner: Caller;
let ownerB: Caller;

const FROM = '2026-08-01';
const TO = '2026-08-31';
const DAY = '2026-08-05';

const B_MARKER_CATEGORY = 'B-ONLY-MARKER-CATEGORY';
const B_MARKER_PAYEE = 'B-ONLY-MARKER-PAYEE';

async function q<T>(tenant: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return h.db.withTenant(tenant, async (tx) => (await tx.query<T>(sql, params)).rows);
}

async function serverWrite(tenant: string, op: string): Promise<string> {
  const id = uuidv7();
  await h.db.withTenant(tenant, (tx) =>
    tx.query(
      `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
       values ($1, $2, 'SERVER', $3, $4, 1, decode('00', 'hex'))`,
      [tenant, id, h.deps.clock.next(), op],
    ),
  );
  return id;
}

/** A stated cost per stocking unit, minor units × 10⁴ (app.product_cost, 0032). */
async function stateCost(tenant: string, productId: string, costE4: string): Promise<void> {
  const writeId = await serverWrite(tenant, 'test.product_cost');
  await h.db.withTenant(tenant, (tx) =>
    tx.query(
      `insert into app.product_cost (tenant_id, id, write_id, hlc, product_id, cost_e4)
       values ($1, $2, $3, $4, $5, $6)`,
      [tenant, uuidv7(), writeId, h.deps.clock.next(), productId, costE4],
    ),
  );
}

async function receive(
  caller: Caller,
  locationId: string,
  productId: string,
  qty: string,
  unitCostE4: string | null,
): Promise<void> {
  await caller.inventory.recordMovement({
    idempotencyKey: uuidv7(),
    locationId,
    productId,
    qtyDelta: qty,
    sourceKind: unitCostE4 === null ? 'OPENING' : 'RECEIPT',
    reasonCode: 'OPENING',
    businessDate: FROM,
    ...(unitCostE4 === null ? {} : { unitCostE4 }),
  });
}

let receiptSeq = 0;
async function sell(
  caller: Caller,
  locationId: string,
  lines: { productId: string; qty: string }[],
): Promise<{ saleId: string; subtotalNetMinor: string }> {
  receiptSeq += 1;
  const sale = await caller.sales.createSale(
    await h.legacySale({
      idempotencyKey: uuidv7(),
      locationId,
      priceListCode: 'WHOLESALE',
      receiptNo: `EXP-${String(receiptSeq).padStart(4, '0')}`,
      businessDate: DAY,
      tender: 'CASH',
      lines,
    }),
  );
  return { saleId: sale.saleId, subtotalNetMinor: sale.subtotalNetMinor };
}

function recordInput(over: Record<string, unknown> = {}) {
  return {
    idempotencyKey: uuidv7(),
    expenseDate: DAY,
    locationId: out01 as string | null,
    category: { name: 'Rent' } as { name: string } | { id: string },
    amount: '1500.00',
    paidFrom: 'BANK' as const,
    ...over,
  };
}

async function expenseRows(tenant: string) {
  return q<{ id: string; amount_minor: string; location_id: string | null; currency_code: string; money_scale: string }>(
    tenant,
    `select id, amount_minor::text, location_id, currency_code::text, money_scale::text
       from app.expense order by created_at, id`,
  );
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantA = await h.provisionTenant('expenses-a');
  tenantB = await h.provisionTenant('expenses-b');
  await h.applyTemplate(tenantA);
  await h.applyTemplate(tenantB);

  root = await h.rootLocation(tenantA);
  const outlets = await h.outlets(tenantA, 2);
  out01 = outlets[0]!.id;
  out02 = outlets[1]!.id;
  bOutlet = (await h.firstOutlet(tenantB)).id;
  tm = await h.tenderMethods(tenantA);

  // Three stocked, sellable products whose default sell unit IS their stocking
  // unit at scale 0, so a quantity sold is a quantity of stock, exactly.
  const picked = await q<{ id: string; sku_code: string }>(
    tenantA,
    `select p.id, p.sku_code
       from app.product p
       join app.product_uom pu on pu.tenant_id = p.tenant_id and pu.product_id = p.id
        and pu.is_default_sell and pu.deleted_at is null and pu.uom_id = p.stocking_uom_id
       join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
      where p.deleted_at is null and p.is_sellable and p.stock_tracking = 'STOCKED' and u.qty_scale = 0
      order by p.sku_code limit 3`,
  );
  [p1, p2, p3] = picked.map((r) => r.id) as [string, string, string];
  p3Sku = picked[2]!.sku_code;
  await h.seedWholesalePrice(tenantA, p1, 55_000_000n); // 55.00 a unit, tax-exclusive
  await h.seedWholesalePrice(tenantA, p2, 20_000_000n); // 20.00
  await h.seedWholesalePrice(tenantA, p3, 10_000_000n); // 10.00

  ownerIdentity = await h.identityFor(tenantA, { locs: [root, out01, out02] });
  owner = h.callerFor(ownerIdentity);
  ownerB = h.callerFor(await h.identityFor(tenantB, { locs: [bOutlet] }));

  // ── The cost basis ────────────────────────────────────────────────────
  // p1 at out01: 100 @ 40.00 and 70 @ 41.03 → Σ cost_e4 = 6 872 100 000 over 170.
  await receive(owner, out01, p1, '100', '40000000');
  await receive(owner, out01, p1, '70', '41030000');
  // p1 at out02: 20 @ 40.00.
  await receive(owner, out02, p1, '20', '40000000');
  // p2 and p3 arrive with NO cost on the movement.
  await receive(owner, out01, p2, '30', null);
  await receive(owner, out01, p3, '30', null);
  // p2 has a stated cost of 12.345 a unit (1234.5 minor × 10⁴ = 12 345 000).
  await stateCost(tenantA, p2, '12345000');
  // A TRAP: p1 also has a stated cost, wildly different. The WAC must win.
  await stateCost(tenantA, p1, '999900000');

  // ── Sales on 5 August ─────────────────────────────────────────────────
  // out01: 5 × p1 (27 500), then 3 × p1 + 3 × p2 + 4 × p3 (16 500 + 6 000 + 4 000).
  await sell(owner, out01, [{ productId: p1, qty: '5' }]);
  const second = await sell(owner, out01, [
    { productId: p1, qty: '3' },
    { productId: p2, qty: '3' },
    { productId: p3, qty: '4' },
  ]);
  expect(second.subtotalNetMinor).toBe('26500');
  // 2 of the 3 p1 come back: −11 000 net sales, −2 units of cost.
  const ret = await owner.returns.record({
    idempotencyKey: uuidv7(),
    kind: 'RETURN',
    originalSaleId: second.saleId,
    locationId: out01,
    cashSessionId: await h.openTill(tenantA, out01, DAY),
    returnNo: 'EXP-R-0001',
    reason: 'two bags came back',
    lines: [{ originalLineNo: 1, qty: '2', disposition: 'RESTOCK' }],
    refund: { methodId: tm.cash, onAccountClaimMinor: '0', immediateClaimMinor: '0' },
  });
  expect(ret.subtotalNetMinor).toBe('11000');
  // out02: 2 × p1 (11 000).
  await sell(owner, out02, [{ productId: p1, qty: '2' }]);

  // ── Tenant B: its own trade, its own expenses, its own stated cost ────
  const bProduct = await h.pickProduct(tenantB);
  await h.seedWholesalePrice(tenantB, bProduct.id, 77_000_000n);
  await receive(ownerB, bOutlet, bProduct.id, '50', '30000000');
  await sell(ownerB, bOutlet, [{ productId: bProduct.id, qty: '7' }]);
  await stateCost(tenantB, bProduct.id, '11110000');
  await ownerB.expenses.record({
    idempotencyKey: uuidv7(),
    expenseDate: DAY,
    locationId: bOutlet,
    category: { name: B_MARKER_CATEGORY },
    amount: '4321.00',
    paidFrom: 'CASH',
    payee: B_MARKER_PAYEE,
  });
  await ownerB.expenses.record({
    idempotencyKey: uuidv7(),
    expenseDate: DAY,
    locationId: null,
    category: { name: 'Rent' },
    amount: '777.77',
    paidFrom: 'BANK',
  });
}, 300_000);

afterAll(async () => {
  await h?.close();
});

// ---------------------------------------------------------------------------
// 1. Amounts are exact
// ---------------------------------------------------------------------------

describe('amounts are parsed EXACTLY against the pack’s scale, never assumed 100', () => {
  it('parseMajorAmount: exact at every scale; a digit beyond the currency is refused, not rounded', () => {
    expect(minorScaleDigits(100n)).toBe(2);
    expect(minorScaleDigits(1000n)).toBe(3);
    expect(minorScaleDigits(1n)).toBe(0);
    expect(minorScaleDigits(30n)).toBeNull(); // not a power of ten: no decimal form exists
    expect(minorScaleDigits(0n)).toBeNull();

    expect(parseMajorAmount('1250.50', 100n)).toBe(125050n);
    expect(parseMajorAmount('1250.5', 100n)).toBe(125050n);
    expect(parseMajorAmount('1250', 100n)).toBe(125000n);
    expect(parseMajorAmount('12.500', 100n)).toBe(1250n); // trailing zeros are exact
    expect(parseMajorAmount('12.505', 100n)).toBeNull(); // a typo, never rounded to 12.51
    expect(parseMajorAmount('1.234', 1000n)).toBe(1234n);
    expect(parseMajorAmount('7', 1n)).toBe(7n);
    expect(parseMajorAmount('7.5', 1n)).toBeNull();
    expect(parseMajorAmount('0.1', 100n)).toBe(10n); // 0.1 is not 0.1000000000000000055
    expect(parseMajorAmount('1,000', 100n)).toBeNull();
    expect(parseMajorAmount('-5', 100n)).toBeNull();
    expect(parseMajorAmount('1e3', 100n)).toBeNull();
    expect(parseMajorAmount('5', 30n)).toBeNull();
  });

  it('a typed amount lands as exact minor units, with the pack’s currency and scale snapshotted', async () => {
    const r = await owner.expenses.record(recordInput({ amount: '250.50', category: { name: 'Fuel' }, paidFrom: 'CASH' }));
    expect(r).toMatchObject({ amountMinor: '25050', categoryName: 'Fuel', categoryCreated: true, locationId: out01 });
    const row = (await expenseRows(tenantA)).find((e) => e.id === r.expenseId)!;
    const pack = await q<{ currency_code: string; minor: string }>(
      tenantA,
      `select j.currency_code::text as currency_code, j.minor_units_per_major::text as minor
         from platform.tenant t join platform.jurisdiction j on j.code = t.jurisdiction_code
        where t.id = app.current_tenant()`,
    );
    expect(row).toMatchObject({ amount_minor: '25050', currency_code: pack[0]!.currency_code, money_scale: pack[0]!.minor });
    expect(r.currencyCode).toBe(pack[0]!.currency_code);
  });

  it('refuses more decimal places than the currency carries, and writes nothing', async () => {
    const before = await expenseRows(tenantA);
    await expect(owner.expenses.record(recordInput({ amount: '12.505' }))).rejects.toThrow(/AMOUNT_SCALE.*more decimal places/);
    await expect(owner.expenses.record(recordInput({ amount: '0.00' }))).rejects.toThrow(/AMOUNT_NOT_POSITIVE/);
    await expect(owner.expenses.record(recordInput({ amount: '1,000.00' }))).rejects.toThrow(/plain decimal/);
    await expect(owner.expenses.record(recordInput({ amount: '-5' }))).rejects.toThrow(/plain decimal/);
    expect(await expenseRows(tenantA)).toEqual(before);
  });

  it('a tenant id in the payload is refused, not ignored', async () => {
    await expect(owner.expenses.record({ ...recordInput(), tenantId: tenantB } as never)).rejects.toThrow(/unrecognized/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Categories, idempotency, voids — and never the ledger
// ---------------------------------------------------------------------------

describe('recording: categories on first use, once per key, never the ledger', () => {
  it('a typed name matches an existing category case-insensitively instead of making a second', async () => {
    const r = await owner.expenses.record(recordInput({ amount: '100.25', category: { name: 'fuel' }, paidFrom: 'MOBILE_MONEY' }));
    expect(r).toMatchObject({ categoryName: 'Fuel', categoryCreated: false, amountMinor: '10025' });
    const fuel = await q<{ n: string }>(tenantA, `select count(*)::text n from app.expense_category where lower(name) = 'fuel'`);
    expect(fuel[0]!.n).toBe('1');
    // …and by id.
    const byId = await owner.expenses.record(recordInput({ amount: '1500', category: { id: r.categoryId }, locationId: out01 }));
    expect(byId.categoryName).toBe('Fuel');
    await owner.expenses.void({ idempotencyKey: uuidv7(), expenseId: byId.expenseId, reason: 'wrong category' });
  });

  it('the same key replays the stored answer and writes ONE expense; a different payload under it is refused', async () => {
    const input = recordInput({ amount: '1500.00', category: { name: 'Rent' }, payee: 'Landlord', reference: 'AUG-RENT' });
    const first = await owner.expenses.record(input);
    const again = await owner.expenses.record(input);
    expect(again).toEqual(first);
    expect((await expenseRows(tenantA)).filter((e) => e.id === first.expenseId)).toHaveLength(1);
    await expect(owner.expenses.record({ ...input, amount: '1600.00' })).rejects.toThrow(/IDEMPOTENCY_KEY_REUSE/);
    const marker = await q<{ op: string; user_id: string }>(tenantA, `select op, user_id from app.write_log where id = $1`, [first.expenseId]);
    expect(marker).toEqual([{ op: 'expense.record', user_id: ownerIdentity.userId }]);
  });

  it('records at the second outlet and for the whole business; outside the period too', async () => {
    await owner.expenses.record(recordInput({ locationId: out02, category: { name: 'Electricity' }, amount: '300' }));
    await owner.expenses.record(recordInput({ locationId: null, category: { name: 'Accountant fee' }, amount: '800.00', paidFrom: 'BANK' }));
    await owner.expenses.record(recordInput({ expenseDate: '2026-09-01', amount: '50.00' })); // September: out of range
  });

  it('refuses a location that is not an outlet or warehouse, and a category that does not exist', async () => {
    await expect(owner.expenses.record(recordInput({ locationId: root }))).rejects.toThrow(/NOT_AN_EXPENSE_LOCATION/);
    await expect(owner.expenses.record(recordInput({ category: { id: uuidv7() } }))).rejects.toThrow(/UNKNOWN_CATEGORY/);
  });

  it('a void excludes the expense; a second void is refused; the void replays by key', async () => {
    const wrong = await owner.expenses.record(recordInput({ amount: '999.99' }));
    const key = uuidv7();
    const v = await owner.expenses.void({ idempotencyKey: key, expenseId: wrong.expenseId, reason: 'typed twice' });
    expect(v).toEqual({ voidId: key, expenseId: wrong.expenseId, reason: 'typed twice' });
    expect(await owner.expenses.void({ idempotencyKey: key, expenseId: wrong.expenseId, reason: 'typed twice' })).toEqual(v);
    await expect(
      owner.expenses.void({ idempotencyKey: uuidv7(), expenseId: wrong.expenseId, reason: 'again' }),
    ).rejects.toThrow(/ALREADY_VOIDED/);
    await expect(owner.expenses.void({ idempotencyKey: uuidv7(), expenseId: uuidv7(), reason: 'x' })).rejects.toThrow(/UNKNOWN_EXPENSE/);
    // The original is untouched — immutable at the database, not by convention.
    await expect(
      h.db.withTenant(tenantA, (tx) => tx.query(`update app.expense set amount_minor = 1 where id = $1`, [wrong.expenseId])),
    ).rejects.toThrow();
    const listed = await owner.expenses.list({ from: FROM, to: TO });
    expect(listed.expenses.find((e) => e.expenseId === wrong.expenseId)).toMatchObject({ voided: true, voidReason: 'typed twice' });
  });

  it('NOTHING reaches the general ledger', async () => {
    const ids = (await expenseRows(tenantA)).map((e) => e.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(await q(tenantA, `select 1 from app.journal_entry where source_id = any($1::uuid[])`, [ids])).toEqual([]);
    expect(await q(tenantA, `select 1 from app.journal_line jl join app.journal_entry je on je.id = jl.journal_entry_id and je.tenant_id = jl.tenant_id where je.source_id = any($1::uuid[])`, [ids])).toEqual([]);
    expect((await q<{ code: string }>(tenantA, `select code from platform.permission where code like 'gl.%' order by code`)).map((r) => r.code)).toEqual(['gl.view']);
  });
});

// ---------------------------------------------------------------------------
// 3. The P&L, against figures computed by hand
// ---------------------------------------------------------------------------

/*
 * THE HAND COMPUTATION (period 1–31 August; every sale on 5 August):
 *
 * out01
 *   sales   p1: 5 × 55.00 = 27 500, 3 × 55.00 = 16 500, return 2 → −11 000
 *           p2: 3 × 20.00 = 6 000        p3: 4 × 10.00 = 4 000
 *           net sales = 27 500 + 16 500 − 11 000 + 6 000 + 4 000 = 43 000
 *   COGS    p1 (WAC): Σ cost_e4 = 100 × 40 000 000 + 70 × 41 030 000 = 6 872 100 000 over 170;
 *                     net qty 6 → 6 872 100 000 × 6 / (170 × 10⁴) = 24 254.47… → 24 254
 *           p2 (stated 12 345 000 e4): 3 × 12 345 000 / 10⁴ = 3 703.5 → half-up 3 704
 *           p3: no cost at all → 0, LISTED as missing (qty 4)
 *           COGS = 27 958, of which 3 704 at stated cost
 *   gross   43 000 − 27 958 = 15 042; margin 15 042 × 10⁶ / 43 000 = 349 813.95… → 349 814
 *   expenses Fuel 25 050 + 10 025 = 35 075; Rent 150 000 (the 999.99 is voided; the 1 500.00
 *            Fuel-by-id was voided; September's 50.00 is out of range) → 185 075
 *   net     15 042 − 185 075 = −170 033
 *
 * out02
 *   sales 2 × 55.00 = 11 000; COGS 2 × 4 000 = 8 000; gross 3 000;
 *   margin 3 000 × 10⁶ / 11 000 = 272 727.27… → 272 727; Electricity 30 000; net −27 000
 *
 * whole business: Accountant fee 80 000
 *
 * consolidated
 *   sales 54 000; COGS 35 958 (3 704 stated); gross 18 042;
 *   margin 18 042 × 10⁶ / 54 000 = 334 111.1… → 334 111
 *   expenses 80 000 + 30 000 + 35 075 + 150 000 = 295 075; net 18 042 − 295 075 = −277 033
 */
describe('profitSheet — the management P&L, exact to the minor unit', () => {
  it('consolidated: sales, WAC + stated-cost COGS, missing cost listed, expenses by category, net', async () => {
    const pl = await owner.expenses.profitSheet({ from: FROM, to: TO });
    expect(pl.basis).toBe('MANAGEMENT');
    expect(pl.note).toMatch(/not the audited ledger/);
    expect(pl.wholeBusinessIncluded).toBe(true);
    expect(pl.consolidated).toEqual({
      netSalesMinor: '54000',
      cogsMinor: '35958',
      cogsAtStatedCostMinor: '3704',
      cogsComplete: false,
      missingCostCount: 1,
      grossProfitMinor: '18042',
      grossMarginPctE4: '334111',
      expenses: [
        { categoryId: expect.any(String), categoryName: 'Accountant fee', amountMinor: '80000' },
        { categoryId: expect.any(String), categoryName: 'Electricity', amountMinor: '30000' },
        { categoryId: expect.any(String), categoryName: 'Fuel', amountMinor: '35075' },
        { categoryId: expect.any(String), categoryName: 'Rent', amountMinor: '150000' },
      ],
      totalExpensesMinor: '295075',
      netProfitMinor: '-277033',
    });
    expect(pl.wholeBusiness).toEqual({
      expenses: [{ categoryId: expect.any(String), categoryName: 'Accountant fee', amountMinor: '80000' }],
      totalExpensesMinor: '80000',
    });
    expect(pl.missingCost).toEqual([
      { productId: p3, skuCode: p3Sku, productName: expect.any(String), uomCode: expect.any(String), qtyScale: 0, qtySold: '4', byLocation: [{ locationId: out01, qtySold: '4' }] },
    ]);
  });

  it('per location: each outlet’s own statement; whole-business expenses belong to none of them', async () => {
    const pl = await owner.expenses.profitSheet({ from: FROM, to: TO });
    const at = (id: string) => pl.locations.find((l) => l.locationId === id)!;
    expect(at(out01)).toMatchObject({
      netSalesMinor: '43000',
      cogsMinor: '27958',
      cogsAtStatedCostMinor: '3704',
      cogsComplete: false,
      missingCostCount: 1,
      grossProfitMinor: '15042',
      grossMarginPctE4: '349814',
      totalExpensesMinor: '185075',
      netProfitMinor: '-170033',
    });
    expect(at(out01).expenses.map((e) => [e.categoryName, e.amountMinor])).toEqual([['Fuel', '35075'], ['Rent', '150000']]);
    expect(at(out02)).toMatchObject({
      netSalesMinor: '11000',
      cogsMinor: '8000',
      cogsAtStatedCostMinor: '0',
      cogsComplete: true,
      grossProfitMinor: '3000',
      grossMarginPctE4: '272727',
      totalExpensesMinor: '30000',
      netProfitMinor: '-27000',
    });
    // A location with nothing in the period is zeros and a withheld margin — never an error.
    const quiet = pl.locations.find((l) => l.locationId !== out01 && l.locationId !== out02)!;
    expect(quiet).toMatchObject({ netSalesMinor: '0', cogsMinor: '0', grossMarginPctE4: null, totalExpensesMinor: '0', netProfitMinor: '0', cogsComplete: true });
    // Σ(locations) + whole business = consolidated, for every figure.
    const sum = (k: 'netSalesMinor' | 'cogsMinor' | 'totalExpensesMinor' | 'netProfitMinor') =>
      pl.locations.reduce((a, l) => a + BigInt(l[k]), 0n);
    expect(sum('netSalesMinor')).toBe(BigInt(pl.consolidated.netSalesMinor));
    expect(sum('cogsMinor')).toBe(BigInt(pl.consolidated.cogsMinor));
    expect(sum('totalExpensesMinor') + 80_000n).toBe(BigInt(pl.consolidated.totalExpensesMinor));
    expect(sum('netProfitMinor') - 80_000n).toBe(BigInt(pl.consolidated.netProfitMinor));
  });

  it('narrowed to one location: that location’s figures, and the whole-business expenses left out — said so', async () => {
    const pl = await owner.expenses.profitSheet({ from: FROM, to: TO, locationIds: [out01] });
    expect(pl.wholeBusinessIncluded).toBe(false);
    expect(pl.wholeBusiness).toBeNull();
    expect(pl.locations.map((l) => l.locationId)).toEqual([out01]);
    expect(pl.consolidated).toMatchObject({ netSalesMinor: '43000', cogsMinor: '27958', totalExpensesMinor: '185075', netProfitMinor: '-170033' });
    const listed = await owner.expenses.list({ from: FROM, to: TO, locationIds: [out01] });
    expect(listed.wholeBusinessIncluded).toBe(false);
    expect(new Set(listed.expenses.map((e) => e.locationId))).toEqual(new Set([out01]));
  });

  it('an empty period is a state: zeros, nothing missing, no margin — not an error', async () => {
    const pl = await owner.expenses.profitSheet({ from: '2025-01-01', to: '2025-01-31' });
    expect(pl.consolidated).toMatchObject({
      netSalesMinor: '0', cogsMinor: '0', grossProfitMinor: '0', grossMarginPctE4: null,
      expenses: [], totalExpensesMinor: '0', netProfitMinor: '0', cogsComplete: true,
    });
    expect(pl.missingCost).toEqual([]);
  });

  it('a range that runs backwards is refused, not swapped', async () => {
    await expect(owner.expenses.profitSheet({ from: TO, to: FROM })).rejects.toThrow(/from must not be after to/);
  });
});

// ---------------------------------------------------------------------------
// 4. Who may do what — every refusal beside a positive control
// ---------------------------------------------------------------------------

describe('permissions: expense.record where it is booked; gl.view to read', () => {
  it('an outlet manager (no expense.record, no gl.view) is refused; Accounts, positive control, is not', async () => {
    const manager = h.callerFor(await h.principal(tenantA, { roleRef: 'outlet_manager', scopeLocationId: out01 }));
    const before = await expenseRows(tenantA);
    await expect(manager.expenses.record(recordInput())).rejects.toThrow(/expense\.record/);
    await expect(manager.expenses.categories()).rejects.toThrow(/expense\.record/);
    await expect(manager.expenses.profitSheet({ from: FROM, to: TO })).rejects.toThrow(/gl\.view/);
    await expect(manager.expenses.list({ from: FROM, to: TO })).rejects.toThrow(/gl\.view/);
    expect(await expenseRows(tenantA)).toEqual(before);

    const accounts = h.callerFor(await h.principal(tenantA, { roleRef: 'accounts' }));
    const ok = await accounts.expenses.record(recordInput({ locationId: null, category: { name: 'Bank charges' }, amount: '12.00', expenseDate: '2026-10-02' }));
    expect(ok.amountMinor).toBe('1200');
    expect((await accounts.expenses.categories()).categories.map((c) => c.name)).toContain('Bank charges');
    expect((await accounts.expenses.profitSheet({ from: FROM, to: TO })).consolidated.netSalesMinor).toBe('54000');
  });

  it('a grant at one outlet books there — and neither at another outlet nor for the whole business', async () => {
    // Tenant-editable data: this tenant gives its outlet managers the capability.
    const roleId = (await q<{ id: string }>(tenantA, `select id from app.role where origin_ref = 'role:outlet_manager'`))[0]!.id;
    const writeId = await serverWrite(tenantA, 'test.role_permission');
    await h.db.withTenant(tenantA, (tx) =>
      tx.query(
        `insert into app.role_permission (tenant_id, id, write_id, hlc, role_id, permission_code)
         values ($1, $2, $3, $4, $5, 'expense.record')`,
        [tenantA, uuidv7(), writeId, h.deps.clock.next(), roleId],
      ),
    );
    const manager = h.callerFor(await h.principal(tenantA, { roleRef: 'outlet_manager', scopeLocationId: out01 }));
    const date = { expenseDate: '2026-10-03' };
    // Positive control: at their own outlet.
    expect((await manager.expenses.record(recordInput({ ...date, amount: '20.00', category: { name: 'Cleaning' } }))).amountMinor).toBe('2000');
    await expect(manager.expenses.record(recordInput({ ...date, locationId: out02 }))).rejects.toThrow(/not at location/);
    await expect(manager.expenses.record(recordInput({ ...date, locationId: null }))).rejects.toThrow(/not over the whole tenant/);
  });
});

// ---------------------------------------------------------------------------
// 5. Tenant isolation — one registered test per query procedure
// ---------------------------------------------------------------------------

describe('two tenants: B’s expenses, categories and trade never reach A', () => {
  let detector: LeakDetector;

  beforeAll(async () => {
    detector = leakDetector(await idUniverse(h, tenantB), [B_MARKER_CATEGORY, B_MARKER_PAYEE]);
  });

  /** Claim 1: tenant B really holds rows — read as the operator, with an explicit tenant predicate. */
  async function bHolds(table: string): Promise<number> {
    const r = await h.db.asAdmin((tx) =>
      tx.query<{ n: string }>(`select count(*)::text n from app.${table} where tenant_id = $1`, [tenantB]),
    );
    return Number(r.rows[0]!.n);
  }

  it('[isolation:expenses.categories] A’s categories only; B’s marker category is nowhere', async () => {
    breachUnless((await bHolds('expense_category')) >= 2, 'tenant B holds no categories — the probe would be vacuous');
    const cats = await owner.expenses.categories();
    expect(cats.categories.length).toBeGreaterThan(0);
    detector.assertClean('expenses.categories', cats);
    const own = await q<{ id: string }>(tenantA, `select id from app.expense_category where deleted_at is null and is_active order by id`);
    expect(cats.categories.map((c) => c.categoryId).sort()).toEqual(own.map((r) => r.id));
    // Both tenants named a category "Rent": A sees exactly one, its own.
    expect(cats.categories.filter((c) => c.name === 'Rent')).toHaveLength(1);
  });

  it('[isolation:expenses.list] exactly A’s expenses; B’s location answers as a nonexistent one', async () => {
    breachUnless((await bHolds('expense')) >= 2, 'tenant B holds no expenses — the probe would be vacuous');
    const listed = await owner.expenses.list({ from: FROM, to: TO });
    expect(listed.expenses.length).toBeGreaterThan(0);
    detector.assertClean('expenses.list', listed);
    const own = await q<{ id: string }>(tenantA, `select id from app.expense where expense_date between $1 and $2 order by id`, [FROM, TO]);
    expect(listed.expenses.map((e) => e.expenseId).sort()).toEqual(own.map((r) => r.id));
    const answer = await assertSameAsNonexistent('expenses.list', detector, bOutlet, (id) =>
      owner.expenses.list({ from: FROM, to: TO, locationIds: [id] }),
    );
    expect(answer).toMatch(/^refused FORBIDDEN/);
  });

  it('[isolation:expenses.profitSheet] A’s figures exactly; B’s sales, costs and expenses add nothing; B’s location answers as nonexistent', async () => {
    breachUnless((await bHolds('sale')) >= 1 && (await bHolds('product_cost')) >= 1, 'tenant B holds no trade — vacuous');
    const pl = await owner.expenses.profitSheet({ from: FROM, to: TO });
    detector.assertClean('expenses.profitSheet', pl);
    // Exactly A's hand-computed figures: B's 7 × 77.00 sale and 4 321.00 + 777.77 of expenses are absent.
    expect(pl.consolidated).toMatchObject({ netSalesMinor: '54000', cogsMinor: '35958', totalExpensesMinor: '295075' });
    const answer = await assertSameAsNonexistent('expenses.profitSheet', detector, bOutlet, (id) =>
      owner.expenses.profitSheet({ from: FROM, to: TO, locationIds: [id] }),
    );
    expect(answer).toMatch(/^refused FORBIDDEN/);
  });

  it('writes: B’s expense cannot be voided from A, and B’s location cannot be booked from A — both answer as nonexistent', async () => {
    const bExpense = (
      await h.db.asAdmin((tx) => tx.query<{ id: string }>(`select id from app.expense where tenant_id = $1 limit 1`, [tenantB]))
    ).rows[0]!.id;
    const voidAnswer = await assertSameAsNonexistent('expenses.void', detector, bExpense, (id) =>
      owner.expenses.void({ idempotencyKey: uuidv7(), expenseId: id, reason: 'not yours' }),
    );
    expect(voidAnswer).toMatch(/^refused NOT_FOUND/);
    const recordAnswer = await assertSameAsNonexistent('expenses.record', detector, bOutlet, (id) =>
      owner.expenses.record(recordInput({ locationId: id })),
    );
    expect(recordAnswer).toMatch(/^refused FORBIDDEN/);
    // And B's expense is untouched.
    expect(await bHolds('expense_void')).toBe(0);
  });
});
