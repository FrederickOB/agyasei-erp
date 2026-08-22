/**
 * LOW-STOCK ALERTS AND REORDER POINTS (CLAUDE.md §3, Phase 1).
 *
 * Four things worth testing here, and one of them is the reason this feature
 * is harder than it looks:
 *
 *  1. **The boundary.** "At or below" has three cases — just above, exactly
 *     at, just below — and off-by-one at the threshold is the single most
 *     likely defect in an alert. All three are asserted, stepping a real
 *     ledger balance across the line one unit at a time.
 *
 *  2. **The dual-unit case.** 12 m rebar is STOCKED as countable bars and
 *     SOLD by the bar OR by the tonne, at exactly 13500/d² bars per tonne
 *     (04 §4.4.1). Sell a tonne and the ledger moves by ~94 bars; a threshold
 *     that followed "whichever unit was last sold" would compare 1 against
 *     100 and never fire. The test sells a TONNE and asserts the alert fires
 *     on a threshold expressed in BARS, reported in BARS.
 *
 *  3. **The permission matrix**, with a positive control beside every
 *     refusal, and no assertion anywhere on a role NAME (CLAUDE.md §2.9).
 *
 *  4. **Two-tenant isolation** on both new read paths.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { divRound } from '@erp/money';
import { createApiHarness, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenantA: string;
let tenantB: string;

let root: string;
let out01: string;
let out03: string;
let out07: string; // reserved for the seeder test — nothing else touches it
let productId: string;
let secondProductId: string;

/** The dual-unit SKU: stocked in BAR_12M, also sellable by the TON. */
let rebarId: string;
let barsPerTonne: bigint;

let bOutlet: string;
let bProduct: string;

type Caller = ReturnType<ApiHarness['callerFor']>;
let owner: Caller;
let ownerB: Caller;

const DAY = '2026-08-01';

async function move(
  caller: Caller,
  locationId: string,
  product: string,
  qtyDelta: string,
  sourceKind: 'OPENING' | 'RECEIPT' | 'WRITE_OFF' = 'OPENING',
): Promise<void> {
  await caller.inventory.recordMovement({
    idempotencyKey: uuidv7(),
    locationId,
    productId: product,
    qtyDelta,
    sourceKind,
    reasonCode: sourceKind === 'WRITE_OFF' ? 'DAMAGE' : 'OPENING',
    businessDate: DAY,
  });
}

async function setPoint(
  caller: Caller,
  locationId: string,
  product: string,
  qty: string,
  extra: { reorderUpToQty?: string; leadTimeDays?: number } = {},
) {
  return caller.inventory.setReorderPoint({
    idempotencyKey: uuidv7(),
    locationId,
    productId: product,
    reorderPointQty: qty,
    ...extra,
  });
}

/** Is this (location, product) currently raising an alert? */
async function isLow(caller: Caller, locationId: string, product: string): Promise<boolean> {
  const r = await caller.inventory.lowStock({ locationIds: [locationId], productIds: [product] });
  return r.alerts.some((a) => a.productId === product && a.locationId === locationId);
}

/** Seed a WHOLESALE price for a NON-default selling unit (e.g. the tonne). */
async function seedPriceForUom(
  tenantId: string,
  product: string,
  uomCode: string,
  unitPriceE4: bigint,
): Promise<void> {
  await h.db.withTenant(tenantId, async (tx) => {
    const writeId = uuidv7();
    await tx.query(
      `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
       values ($1,$2,'SERVER',$3,'test.price_seed',1,decode('00','hex'))`,
      [tenantId, writeId, h.deps.clock.next()],
    );
    const list = await tx.query<{ id: string }>(
      `select id from app.price_list where code = 'WHOLESALE' and deleted_at is null`,
    );
    await tx.query(
      `update app.price_list set effective_from = least(effective_from, '2019-01-01'::date) where id = $1`,
      [list.rows[0]!.id],
    );
    const uom = await tx.query<{ id: string }>(
      `select id from app.unit_of_measure where code = $1 and deleted_at is null`,
      [uomCode],
    );
    await tx.query(
      `insert into app.price_list_item
         (tenant_id, id, write_id, hlc, price_list_id, product_id, uom_id,
          unit_price_e4, min_qty, effective_from)
       values ($1,$2,$3,$4,$5,$6,$7,$8,0,'2019-01-01')`,
      [
        tenantId,
        uuidv7(),
        writeId,
        h.deps.clock.next(),
        list.rows[0]!.id,
        product,
        uom.rows[0]!.id,
        unitPriceE4.toString(10),
      ],
    );
  });
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantA = await h.provisionTenant('reorder-a');
  tenantB = await h.provisionTenant('reorder-b');
  await h.applyTemplate(tenantA);
  await h.applyTemplate(tenantB);

  root = await h.rootLocation(tenantA);
  out01 = await h.locationByCode(tenantA, 'OUT-01');
  out03 = await h.locationByCode(tenantA, 'OUT-03');
  out07 = await h.locationByCode(tenantA, 'OUT-07');

  const picked = await h.db.withTenant(tenantA, async (tx) => {
    const plain = await tx.query<{ id: string }>(
      `select p.id
         from app.product p
         join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
        where p.deleted_at is null and p.is_sellable and p.stock_tracking = 'STOCKED'
          and u.qty_scale = 0
        order by p.sku_code limit 3`,
    );
    // The genuine dual-unit line: stocked in bars, sellable by the tonne.
    const dual = await tx.query<{ id: string; factor_num: string; factor_den: string }>(
      `select p.id, pu.factor_num::text, pu.factor_den::text
         from app.product p
         join app.unit_of_measure su
           on su.tenant_id = p.tenant_id and su.id = p.stocking_uom_id and su.code = 'BAR_12M'
         join app.product_uom pu
           on pu.tenant_id = p.tenant_id and pu.product_id = p.id and pu.can_sell
          and pu.deleted_at is null
         join app.unit_of_measure tu
           on tu.tenant_id = p.tenant_id and tu.id = pu.uom_id and tu.code = 'TON'
        where p.deleted_at is null
          -- a diameter whose bars-per-tonne lands in a range a single
          -- delivery can cover, so the test reads like a real yard
          and pu.factor_num / pu.factor_den between 40 and 140
        order by p.sku_code limit 1`,
    );
    return { plain: plain.rows.map((r) => r.id), dual: dual.rows[0]! };
  });
  productId = picked.plain[0]!;
  secondProductId = picked.plain[1]!;
  rebarId = picked.dual.id;
  // 1.000 TON converts to round(factor_num / factor_den) bars: the same
  // rational conversion sales.ts applies, computed here from the SEEDED
  // factors rather than from the router, so this is a real cross-check.
  barsPerTonne = divRound(BigInt(picked.dual.factor_num), BigInt(picked.dual.factor_den), 'half-up');

  await seedPriceForUom(tenantA, rebarId, 'TON', 4_500_000_000n); // GH₵4,500/t

  owner = h.callerFor(await h.identityFor(tenantA, { locs: [root, out01, out03, out07] }));

  bOutlet = (await h.firstOutlet(tenantB)).id;
  bProduct = (await h.pickProduct(tenantB)).id;
  ownerB = h.callerFor(await h.identityFor(tenantB, { locs: [bOutlet] }));
}, 300_000);

afterAll(async () => {
  await h.close();
});

describe('the reorder-point boundary: just above, exactly at, just below', () => {
  it('fires at or below the threshold, and not one unit above it', async () => {
    await move(owner, out01, productId, '101');
    await setPoint(owner, out01, productId, '100', { reorderUpToQty: '250' });

    // 101 on hand against a threshold of 100: NOT low.
    expect(await isLow(owner, out01, productId)).toBe(false);

    // Exactly at the threshold IS low — "reorder point" means reorder now,
    // not "reorder after you have gone below it".
    await move(owner, out01, productId, '-1', 'WRITE_OFF');
    expect(await isLow(owner, out01, productId)).toBe(true);

    // And below stays low, with the shortfall growing by exactly one unit.
    const at = await owner.inventory.lowStock({ locationIds: [out01], productIds: [productId] });
    await move(owner, out01, productId, '-1', 'WRITE_OFF');
    const below = await owner.inventory.lowStock({ locationIds: [out01], productIds: [productId] });
    expect(BigInt(below.alerts[0]!.shortfallQty)).toBe(
      BigInt(at.alerts[0]!.shortfallQty) + 1n,
    );
    // Shortfall is measured to the ORDER-UP-TO level, not to the threshold.
    expect(below.alerts[0]!.shortfallQty).toBe('151'); // 250 − 99
    expect(below.alerts[0]!.qtyOnHand).toBe('99');
  });

  it('a threshold of zero means "tell me when it is actually gone"', async () => {
    await move(owner, out03, productId, '5');
    await setPoint(owner, out03, productId, '0');
    expect(await isLow(owner, out03, productId)).toBe(false);

    await move(owner, out03, productId, '-5', 'WRITE_OFF');
    expect(await isLow(owner, out03, productId)).toBe(true);

    // …and it sorts FIRST: coverage against a zero threshold is undefined,
    // and a product that is gone outranks one that is merely thin.
    const r = await owner.inventory.lowStock({ locationIds: [out01, out03] });
    expect(r.alerts[0]!.locationId).toBe(out03);
    expect(r.alerts[0]!.coverageBp).toBeNull();
  });

  it('an inactive threshold raises nothing, and STAYS FINDABLE so it can be switched back on', async () => {
    await owner.inventory.setReorderPoint({
      idempotencyKey: uuidv7(),
      locationId: out03,
      productId,
      reorderPointQty: '0',
      isActive: false,
    });
    expect(await isLow(owner, out03, productId)).toBe(false);

    // The management list must still show it. Filtering inactive rows out of
    // BOTH the alert and the list is the trap: switching a threshold off
    // would delete it from the only screen that could switch it back on.
    const list = await owner.inventory.reorderPoints({ locationId: out03 });
    const row = list.points.find((p) => p.productId === productId);
    expect(row).toBeDefined();
    expect(row!.isActive).toBe(false);
    expect(row!.reorderPointQty).toBe('0'); // the numbers survived

    await owner.inventory.setReorderPoint({
      idempotencyKey: uuidv7(),
      locationId: out03,
      productId,
      reorderPointQty: '0',
      isActive: true,
    });
    expect(await isLow(owner, out03, productId)).toBe(true);
  });
});

describe('dual selling units: the comparison is in the STOCKING unit', () => {
  it('a tonne sold moves the ledger in bars, and the alert fires on the bar threshold', async () => {
    // A yard holding 150 bars, told to reorder at 100 bars.
    await move(owner, out01, rebarId, '150');
    await setPoint(owner, out01, rebarId, '100');
    expect(await isLow(owner, out01, rebarId)).toBe(false);

    // Sell ONE TONNE. The sale is priced per tonne; what leaves the yard is
    // 13500/d² bars, converted once by the snapshotted rational factor.
    await owner.sales.createSale({
      idempotencyKey: uuidv7(),
      locationId: out01,
      priceListCode: 'WHOLESALE',
      receiptNo: 'RB-TONNE-1',
      businessDate: '2026-08-05',
      tender: 'CASH',
      lines: [{ productId: rebarId, qty: '1000', uomCode: 'TON' }], // 1.000 t at scale 3
    });

    const expectedBars = 150n - barsPerTonne;
    const onHand = await owner.inventory.onHand({ locationId: out01, productId: rebarId });
    expect(onHand.qtyOnHand).toBe(String(expectedBars));
    expect(onHand.uomCode).toBe('BAR_12M');

    // The alert now fires — and every quantity on it is in BARS. A threshold
    // that had followed the SELLING unit would be comparing "1 tonne sold"
    // against "100", which is not a comparison at all.
    const r = await owner.inventory.lowStock({ locationIds: [out01], productIds: [rebarId] });
    expect(r.alerts).toHaveLength(1);
    const alert = r.alerts[0]!;
    expect(alert.uomCode).toBe('BAR_12M');
    expect(alert.qtyOnHand).toBe(String(expectedBars));
    expect(alert.reorderPointQty).toBe('100');
    expect(BigInt(alert.qtyOnHand)).toBeLessThanOrEqual(BigInt(alert.reorderPointQty));
    // Sanity on the conversion itself: a tonne is more than fifty bars and
    // fewer than a hundred and fifty, so the sale genuinely crossed the line.
    expect(barsPerTonne).toBeGreaterThan(40n);
    expect(barsPerTonne).toBeLessThan(140n);
  });

  it('the server names the unit, so a client cannot set a threshold in tonnes', async () => {
    const set = await setPoint(owner, out01, rebarId, '120');
    // The response echoes the SERVER's unit. There is no field on the wire
    // for a caller to have named a different one (contracts/src/inventory.ts).
    expect(set.uomCode).toBe('BAR_12M');
    expect(set.qtyScale).toBe(0);
    // …and the database refuses a row denominated in the selling unit even
    // if something bypassed the router entirely (migration 0007's trigger).
    const attempt = h.db.withTenant(tenantA, async (tx) => {
      const writeId = uuidv7();
      await tx.query(
        `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
         values ($1,$2,'SERVER',$3,'test.bad_uom',1,decode('00','hex'))`,
        [tenantA, writeId, h.deps.clock.next()],
      );
      const ton = await tx.query<{ id: string }>(
        `select id from app.unit_of_measure where code = 'TON' and deleted_at is null`,
      );
      await tx.query(
        `insert into app.reorder_point
           (tenant_id, id, write_id, hlc, location_id, product_id, uom_id, qty_scale,
            reorder_point_qty, is_active)
         values ($1,$2,$3,$4,$5,$6,$7,3,1,true)`,
        [tenantA, uuidv7(), writeId, h.deps.clock.next(), out03, rebarId, ton.rows[0]!.id],
      );
    });
    await expect(attempt).rejects.toThrow(/not the stocking unit/);
  });
});

describe('urgency ordering', () => {
  it('orders by coverage — a ratio — because shortfalls in different units are not comparable', async () => {
    // Two products at the same location: one at 10% of its threshold, one at
    // 90%. The 10% one is the emergency even though its raw shortfall is
    // smaller.
    await move(owner, out07, productId, '10');
    await setPoint(owner, out07, productId, '100'); // 10% covered
    await move(owner, out07, secondProductId, '900');
    await setPoint(owner, out07, secondProductId, '1000'); // 90% covered

    const r = await owner.inventory.lowStock({ locationIds: [out07] });
    expect(r.alerts.map((a) => a.productId)).toEqual([productId, secondProductId]);
    expect(r.alerts[0]!.coverageBp).toBe('1000'); // 10.00%
    expect(r.alerts[1]!.coverageBp).toBe('9000'); // 90.00%
    // The raw shortfall would have ordered them the other way round.
    expect(BigInt(r.alerts[0]!.shortfallQty)).toBeLessThan(BigInt(r.alerts[1]!.shortfallQty));
  });
});

describe('the permission matrix', () => {
  async function principalAt(roleRef: string, scopeLocationId: string): Promise<Caller> {
    return h.callerFor(
      await h.principal(tenantA, {
        roleRef,
        scopeLocationId,
        // Wider than the grant on purpose, so a refusal is the database's.
        locs: [root, out01, out03, out07],
      }),
    );
  }

  it('counter staff cannot set a threshold, but CAN see the alerts at their own outlet', async () => {
    const counter = await principalAt('counter_staff', out01);
    await expect(setPoint(counter, out01, productId, '5')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // Positive control on the same principal at the same location: the
    // person who has to tell a customer "we're out" sees it coming.
    const alerts = await counter.inventory.lowStock({ locationIds: [out01] });
    expect(alerts.scope.locationCount).toBe(1);
    expect(alerts.alertCount).toBeGreaterThan(0);
  });

  it('an outlet manager sets thresholds at their own outlet and nowhere else', async () => {
    const manager = await principalAt('outlet_manager', out01);
    const ok = await setPoint(manager, out01, secondProductId, '7');
    expect(ok.reorderPointQty).toBe('7');

    await expect(setPoint(manager, out03, secondProductId, '7')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('the alert scope follows the closure: a region grant covers its outlets', async () => {
    const regional = await principalAt('regional_manager', await h.locationByCode(tenantA, 'REG-BONO'));
    const r = await regional.inventory.lowStock({});
    const locs = r.locations.map((l) => l.locationId);
    expect(locs).toContain(out01);
    expect(locs).toContain(out03);
    expect(locs).not.toContain(await h.locationByCode(tenantA, 'OUT-04')); // Northern
  });

  it('a principal holding stock.view nowhere is refused, not shown an empty list', async () => {
    const identity = await h.principal(tenantA, { roleRef: 'accounts', scopeLocationId: root });
    // Accounts deliberately does not hold stock.view (segregation of duties).
    await expect(
      h.callerFor(identity).inventory.lowStock({}),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // An empty list would read as "nothing is low", which is a statement
    // about the business rather than about this user's authority.
  });
});

describe('writes go through the one idempotent pipeline', () => {
  it('replays the stored response on a retry, and updates in place on a new key', async () => {
    const key = uuidv7();
    const first = await owner.inventory.setReorderPoint({
      idempotencyKey: key,
      locationId: out07,
      productId: rebarId,
      reorderPointQty: '42',
    });
    const replay = await owner.inventory.setReorderPoint({
      idempotencyKey: key,
      locationId: out07,
      productId: rebarId,
      reorderPointQty: '42',
    });
    expect(replay).toEqual(first);
    expect(first.created).toBe(true);

    const updated = await setPoint(owner, out07, rebarId, '43');
    expect(updated.created).toBe(false);
    expect(updated.reorderPointId).toBe(first.reorderPointId); // one live row
    expect(updated.reorderPointQty).toBe('43');
  });

  it('refuses an order-up-to level below the reorder point', async () => {
    await expect(
      setPoint(owner, out01, productId, '100', { reorderUpToQty: '99' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('carries the Phase 2 fields without reading them in Phase 1', async () => {
    const set = await setPoint(owner, out01, secondProductId, '10', {
      reorderUpToQty: '200',
      leadTimeDays: 14,
    });
    expect(set.reorderUpToQty).toBe('200');
    expect(set.leadTimeDays).toBe(14);
    const list = await owner.inventory.reorderPoints({ locationId: out01 });
    const row = list.points.find((p) => p.productId === secondProductId)!;
    expect(row.leadTimeDays).toBe(14);
  });
});

describe('template seeding', () => {
  it('seeds from the ledger, at a fraction of opening stock, and never twice', async () => {
    const fresh = await h.locationByCode(tenantA, 'OUT-20');
    const caller = h.callerFor(await h.identityFor(tenantA, { locs: [fresh] }));

    // Nothing on the shelves: nothing to threshold. This is the behaviour
    // that keeps the pilot's first low-stock screen from being 5,000 rows of
    // thresholds nobody chose, every one of them breached at zero stock.
    const empty = await caller.inventory.ensureReorderPoints({ locationId: fresh });
    expect(empty.seeded).toBe(0);
    expect(empty.needsFounderReview).toBe(false);

    await move(caller, fresh, productId, '40');
    const seeded = await caller.inventory.ensureReorderPoints({ locationId: fresh });
    expect(seeded.seeded).toBe(1);
    // The level is a template GUESS and says so, so onboarding shows it to a
    // human rather than letting it look computed.
    expect(seeded.needsFounderReview).toBe(true);

    const list = await caller.inventory.reorderPoints({ locationId: fresh });
    const row = list.points.find((p) => p.productId === productId)!;
    expect(row.reorderPointQty).toBe('10'); // 25% of 40
    expect(row.reorderUpToQty).toBe('40'); // back to what it opened with

    // Idempotent and additive.
    const again = await caller.inventory.ensureReorderPoints({ locationId: fresh });
    expect(again.seeded).toBe(0);
  });

  it('never overwrites a threshold somebody has since tuned', async () => {
    const fresh = await h.locationByCode(tenantA, 'OUT-20');
    const caller = h.callerFor(await h.identityFor(tenantA, { locs: [fresh] }));
    await setPoint(caller, fresh, productId, '999');
    await caller.inventory.ensureReorderPoints({ locationId: fresh });
    const list = await caller.inventory.reorderPoints({ locationId: fresh });
    expect(list.points.find((p) => p.productId === productId)!.reorderPointQty).toBe('999');
  });
});

describe('two-tenant isolation', () => {
  it('one tenant’s alerts and thresholds are invisible to the other', async () => {
    await ownerB.inventory.recordMovement({
      idempotencyKey: uuidv7(),
      locationId: bOutlet,
      productId: bProduct,
      qtyDelta: '3',
      sourceKind: 'OPENING',
      reasonCode: 'OPENING',
      businessDate: DAY,
    });
    await ownerB.inventory.setReorderPoint({
      idempotencyKey: uuidv7(),
      locationId: bOutlet,
      productId: bProduct,
      reorderPointQty: '50',
    });

    const b = await ownerB.inventory.lowStock({});
    expect(b.alerts.some((a) => a.productId === bProduct)).toBe(true);

    const a = await owner.inventory.lowStock({});
    expect(a.alerts.some((x) => x.productId === bProduct)).toBe(false);
    expect(a.locations.some((l) => l.locationId === bOutlet)).toBe(false);

    // Naming the other tenant's location is refused on both read paths, and
    // on the write path — RLS makes the row unresolvable, and the permission
    // model refuses before that.
    await expect(owner.inventory.lowStock({ locationIds: [bOutlet] })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(owner.inventory.reorderPoints({ locationId: bOutlet })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(setPoint(owner, bOutlet, bProduct, '1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
