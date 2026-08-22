/**
 * THE PURCHASE-ORDER ROUTER, THROUGH ITS OWN SURFACE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 * `apps/api/src/routers/procurement.ts` shipped at 2,009 lines with **no file
 * in `apps/api/test/`**: nothing under this directory referenced
 * `procurement.` at all. The coverage that existed sat BESIDE the router and
 * not through it —
 *
 *   · `packages/db/test/procurement.test.ts`      the SCHEMA and the triggers
 *   · `apps/web/tests/procurement-api.test.ts`    the CLIENT, against a mock
 *   · `packages/wire-conformance/…-reads-…`       the READ paths only
 *   · `apps/api/test/receiving.test.ts`           builds its orders with RAW
 *                                                 SQL INSERTs, so it never
 *                                                 calls this router either
 *
 * — three suites around a router and none through it, which is
 * `docs/phase1-status.md` §0 row 13.
 *
 * The specific hole that mattered: **`ctx.permissions.requireWithinAmount(
 * 'purchase.order.approve', …)`**, the money bound that decides who may commit
 * the business to a spend, had no test ANYWHERE in the repository. CLAUDE.md
 * §2.7 category 1 makes that not-done. This file closes it, and it runs under
 * `pnpm test` with no docker.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE STATES A FIGURE BOTH SIDES COULD AGREE ON WRONGLY
 * ---------------------------------------------------------------------------
 * The bound is READ from the template's own `role_permission.bound` row, the
 * conversion factor and the scales are READ from `product_uom`, and the
 * expected line total is computed with `@erp/money`'s `lineNetMinor` — the
 * same primitive the router calls — rather than written out as a literal.
 * A test that states its own bound is a test that agrees with itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lineNetMinor } from '@erp/money';
import { uuidv7 } from '@erp/db';
import type { VerifiedIdentity } from '../src/auth.js';
import { createApiHarness, type ApiHarness } from './util.js';

type Caller = ReturnType<ApiHarness['callerFor']>;

let h: ApiHarness;

let tenantA: string;
let tenantB: string;
let rootA: string;
let out01: string;
let out03: string;
let regBono: string;

let supplierId: string;

/** Stocked and bought in the same unit, scale 0 — the simple case. */
let plainProductId: string;
let plainUomId: string;

/** Stocked in BAR_12M (scale 0), bought by the TON (scale 3). */
let rebarId: string;
let rebarTonUomId: string;
let rebarTonScale: number;

/** Read from the template, never stated. */
let approvalBound: bigint;

let managerA: VerifiedIdentity;
let manager: Caller; // outlet_manager @ OUT-01 — creates, cannot approve
let managerAt03: Caller;
let counter: Caller; // counter_staff — neither
let accounts: Caller; // accounts @ ROOT — approves, UNBOUNDED, cannot create
let regional: Caller; // regional_manager @ REG-BONO — creates AND approves, BOUNDED
let ownerB: Caller;

const DAY = '2026-08-20';

interface LineSpec {
  productId: string;
  uomId: string;
  qtyOrdered: string;
  unitPriceE4: string;
}

function orderPayload(lines: LineSpec[], over: Record<string, unknown> = {}) {
  return {
    idempotencyKey: uuidv7(),
    supplierId,
    deliverToLocationId: out01,
    orderDate: DAY,
    lines: lines.map((l, i) => ({ lineNo: i + 1, ...l })),
    ...over,
  } as Parameters<Caller['procurement']['createPurchaseOrder']>[0];
}

/** Raise + submit through the REAL router, so the fixture is the path. */
async function submittedOrder(
  by: Caller,
  lines: LineSpec[],
  over: Record<string, unknown> = {},
): Promise<{ id: string; total: bigint }> {
  const raised = await by.procurement.createPurchaseOrder(orderPayload(lines, over));
  await by.procurement.changePurchaseOrderStatus({
    idempotencyKey: uuidv7(),
    purchaseOrderId: raised.purchaseOrderId,
    toStatus: 'SUBMITTED',
  });
  return { id: raised.purchaseOrderId, total: BigInt(raised.totalMinor) };
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantA = await h.provisionTenant('procurement-a');
  tenantB = await h.provisionTenant('procurement-b');
  await h.applyTemplate(tenantA, true);
  await h.applyTemplate(tenantB, true);

  rootA = await h.rootLocation(tenantA);
  out01 = await h.locationByCode(tenantA, 'OUT-01');
  out03 = await h.locationByCode(tenantA, 'OUT-03');
  regBono = await h.locationByCode(tenantA, 'REG-BONO');

  const plain = await h.pickProduct(tenantA);
  plainProductId = plain.id;
  plainUomId = await h.db.withTenant(tenantA, async (tx) => {
    const res = await tx.query<{ uom_id: string }>(
      `select pu.uom_id from app.product_uom pu
         join app.product p on p.tenant_id = pu.tenant_id and p.id = pu.product_id
        where pu.product_id = $1 and pu.uom_id = p.stocking_uom_id
          and pu.deleted_at is null and pu.can_buy`,
      [plainProductId],
    );
    const id = res.rows[0]?.uom_id;
    if (!id) throw new Error('the template did not seed a buyable stocking unit');
    return id;
  });

  // The dual-unit line, and its TON scale — read, not assumed.
  const rebar = await h.db.withTenant(tenantA, async (tx) => {
    const res = await tx.query<{ id: string; ton_uom_id: string; ton_scale: number }>(
      `select p.id, pu.uom_id as ton_uom_id, tu.qty_scale as ton_scale
         from app.product p
         join app.unit_of_measure su
           on su.tenant_id = p.tenant_id and su.id = p.stocking_uom_id and su.code = 'BAR_12M'
         join app.product_uom pu
           on pu.tenant_id = p.tenant_id and pu.product_id = p.id and pu.deleted_at is null
         join app.unit_of_measure tu
           on tu.tenant_id = p.tenant_id and tu.id = pu.uom_id and tu.code = 'TON'
        where p.deleted_at is null
        order by p.sku_code limit 1`,
    );
    const row = res.rows[0];
    if (!row) throw new Error('the template seeded no dual-unit rebar line');
    // Making the tonne BUYABLE is ordinary tenant configuration — the same
    // one-row flag §4.10 describes for cement bought by the tonne.
    await tx.query(
      `update app.product_uom set can_buy = true
        where product_id = $1 and uom_id = $2 and deleted_at is null`,
      [row.id, row.ton_uom_id],
    );
    return row;
  });
  rebarId = rebar.id;
  rebarTonUomId = rebar.ton_uom_id;
  rebarTonScale = rebar.ton_scale;

  supplierId = await h.db.withTenant(tenantA, async (tx) => {
    const res = await tx.query<{ id: string }>(
      `select id from app.supplier where deleted_at is null and is_active
        order by code limit 1`,
    );
    const id = res.rows[0]?.id;
    if (!id) throw new Error('the template seeded no supplier');
    return id;
  });

  // THE BOUND, out of the template's own row. If a future template edit
  // changes it, this suite follows rather than lying.
  approvalBound = await h.db.withTenant(tenantA, async (tx) => {
    const res = await tx.query<{ bound: string | null }>(
      `select rp.bound->>'max_order_value_minor' as bound
         from app.role_permission rp
         join app.role r on r.tenant_id = rp.tenant_id and r.id = rp.role_id
        where rp.permission_code = 'purchase.order.approve'
          and r.origin_ref = 'role:regional_manager'`,
    );
    const b = res.rows[0]?.bound;
    if (b == null) throw new Error('the template bounds no approver — this suite has nothing to test');
    return BigInt(b);
  });

  managerA = await h.principal(tenantA, { roleRef: 'outlet_manager', scopeLocationId: out01 });
  manager = h.callerFor(managerA);
  managerAt03 = h.callerFor(
    await h.principal(tenantA, { roleRef: 'outlet_manager', scopeLocationId: out03 }),
  );
  counter = h.callerFor(
    await h.principal(tenantA, { roleRef: 'counter_staff', scopeLocationId: out01 }),
  );
  accounts = h.callerFor(await h.principal(tenantA, { roleRef: 'accounts', scopeLocationId: rootA }));
  regional = h.callerFor(
    await h.principal(tenantA, { roleRef: 'regional_manager', scopeLocationId: regBono }),
  );

  const bOutlet = (await h.firstOutlet(tenantB)).id;
  ownerB = h.callerFor(await h.identityFor(tenantB, { locs: [bOutlet] }));
}, 300_000);

afterAll(async () => {
  await h?.close();
});

// ---------------------------------------------------------------------------
// 1. Money: the total is Σ(once-rounded lines), and nothing else
// ---------------------------------------------------------------------------

describe('a purchase order prices itself, once, with the documented rounding rule', () => {
  it('line_net_minor is lineNetMinor(qty, buyScale, priceE4, half-up) — the shared primitive', async () => {
    const qty = '1600'; // 1.600 TON at scale 3
    const priceE4 = '9000000000';
    const raised = await manager.procurement.createPurchaseOrder(
      orderPayload([{ productId: rebarId, uomId: rebarTonUomId, qtyOrdered: qty, unitPriceE4: priceE4 }]),
    );
    const expected = lineNetMinor(BigInt(qty), rebarTonScale, BigInt(priceE4), 'half-up');
    expect(raised.lines).toHaveLength(1);
    expect(raised.lines[0]!.lineNetMinor).toBe(expected.toString(10));
    expect(raised.totalMinor).toBe(expected.toString(10));

    // …and Postgres holds exactly that, not a re-derivation.
    const stored = await h.db.withTenant(tenantA, async (tx) => {
      const res = await tx.query<{ n: string }>(
        `select line_net_minor::text as n from app.purchase_order_line
          where purchase_order_id = $1 and deleted_at is null order by line_no`,
        [raised.purchaseOrderId],
      );
      return res.rows.map((r) => BigInt(r.n));
    });
    expect(stored).toEqual([expected]);
  });

  it('rounds HALF-UP at the boundary, once per line, and never on the sum', async () => {
    // Three lines each landing exactly on a half minor unit. Rounding the SUM
    // instead of the parts gives a different answer, which is the bug.
    const priceE4 = '5000'; // 0.5 minor units per whole unit
    const line = {
      productId: plainProductId,
      uomId: plainUomId,
      qtyOrdered: '1',
      unitPriceE4: priceE4,
    };
    const raised = await manager.procurement.createPurchaseOrder(
      orderPayload([line, line, line]),
    );
    const each = lineNetMinor(1n, 0, BigInt(priceE4), 'half-up');
    expect(each).toBe(1n); // half-up: 0.5 → 1
    expect(raised.totalMinor).toBe((each * 3n).toString(10));
    // Rounding the sum would give round(1.5) = 2, not 3. Stated so the
    // assertion cannot be read as arbitrary.
    expect(raised.totalMinor).not.toBe('2');
  });

  it('the total a status change reports is the SAME Σ(lines) — one figure, one source', async () => {
    const { id, total } = await submittedOrder(manager, [
      { productId: rebarId, uomId: rebarTonUomId, qtyOrdered: '2500', unitPriceE4: '9000000000' },
      { productId: plainProductId, uomId: plainUomId, qtyOrdered: '7', unitPriceE4: '123456' },
    ]);
    const approved = await accounts.procurement.changePurchaseOrderStatus({
      idempotencyKey: uuidv7(),
      purchaseOrderId: id,
      toStatus: 'APPROVED',
    });
    expect(BigInt(approved.totalMinor)).toBe(total);
    const summed = await h.db.withTenant(tenantA, async (tx) => {
      const res = await tx.query<{ n: string | null }>(
        `select sum(line_net_minor)::text as n from app.purchase_order_line
          where purchase_order_id = $1 and deleted_at is null`,
        [id],
      );
      return BigInt(res.rows[0]?.n ?? '0');
    });
    expect(summed).toBe(total);
  });

  it('quantities and money leave as decimal STRINGS, never JS numbers (ADR-0004)', async () => {
    const raised = await manager.procurement.createPurchaseOrder(
      orderPayload([
        { productId: rebarId, uomId: rebarTonUomId, qtyOrdered: '1600', unitPriceE4: '9000000000' },
      ]),
    );
    expect(typeof raised.totalMinor).toBe('string');
    const l = raised.lines[0]!;
    for (const v of [l.lineNetMinor, l.qtyOrdered, l.unitPriceE4, l.qtyOrderedStock]) {
      expect(typeof v).toBe('string');
      expect(v).toMatch(/^-?\d+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. THE APPROVAL BOUND — the money control that had no test
// ---------------------------------------------------------------------------

describe('purchase.order.approve is bounded by an amount, and the bound is the tenant’s data', () => {
  /** A line whose server-priced total lands where the test needs it. */
  function worth(minor: bigint): LineSpec {
    // 1 whole unit at scale 0 priced at `minor` × 10⁴ costs exactly `minor`.
    return {
      productId: plainProductId,
      uomId: plainUomId,
      qtyOrdered: '1',
      unitPriceE4: (minor * 10_000n).toString(10),
    };
  }

  it('refuses ABOVE the bound, and the refusal names the SERVER’s own total', async () => {
    const over = approvalBound + 1n;
    const { id, total } = await submittedOrder(regional, [worth(over)], {
      deliverToLocationId: out01,
    });
    expect(total).toBe(over);
    await expect(
      regional.procurement.changePurchaseOrderStatus({
        idempotencyKey: uuidv7(),
        purchaseOrderId: id,
        toStatus: 'APPROVED',
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining(over.toString(10)),
    });
  });

  it('allows the SAME principal AT the bound — so the refusal is the amount, not the capability', async () => {
    const { id, total } = await submittedOrder(regional, [worth(approvalBound)], {
      deliverToLocationId: out01,
    });
    expect(total).toBe(approvalBound);
    const ok = await regional.procurement.changePurchaseOrderStatus({
      idempotencyKey: uuidv7(),
      purchaseOrderId: id,
      toStatus: 'APPROVED',
    });
    expect(ok.status).toBe('APPROVED');
  });

  it('a refused approval writes NOTHING — the order is still SUBMITTED with no approver', async () => {
    const { id } = await submittedOrder(regional, [worth(approvalBound + 1n)], {
      deliverToLocationId: out01,
    });
    await expect(
      regional.procurement.changePurchaseOrderStatus({
        idempotencyKey: uuidv7(),
        purchaseOrderId: id,
        toStatus: 'APPROVED',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const row = await h.db.withTenant(tenantA, async (tx) => {
      const res = await tx.query<{ status: string; approved_by: string | null }>(
        `select status, approved_by_user_id::text as approved_by
           from app.purchase_order where id = $1`,
        [id],
      );
      return res.rows[0];
    });
    expect(row?.status).toBe('SUBMITTED');
    expect(row?.approved_by).toBeNull();

    // The positive control: an UNBOUNDED approver clears the very same order,
    // so the refusal above was the bound and not a broken route.
    const ok = await accounts.procurement.changePurchaseOrderStatus({
      idempotencyKey: uuidv7(),
      purchaseOrderId: id,
      toStatus: 'APPROVED',
    });
    expect(ok.status).toBe('APPROVED');
  });

  it('the bound is measured against Σ(lines), which no caller supplies', async () => {
    // There is deliberately no client-asserted total on this route. Two lines
    // each under the bound, together over it, must still be refused.
    const half = approvalBound / 2n + 1n;
    const { id, total } = await submittedOrder(regional, [worth(half), worth(half)], {
      deliverToLocationId: out01,
    });
    expect(total).toBe(half * 2n);
    expect(total).toBeGreaterThan(approvalBound);
    await expect(
      regional.procurement.changePurchaseOrderStatus({
        idempotencyKey: uuidv7(),
        purchaseOrderId: id,
        toStatus: 'APPROVED',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// ---------------------------------------------------------------------------
// 3. Separation of duties, and scope
// ---------------------------------------------------------------------------

describe('raising an order and approving it are different capabilities', () => {
  it('the raiser cannot approve, and the approver cannot raise', async () => {
    const { id } = await submittedOrder(manager, [
      { productId: plainProductId, uomId: plainUomId, qtyOrdered: '2', unitPriceE4: '10000' },
    ]);
    await expect(
      manager.procurement.changePurchaseOrderStatus({
        idempotencyKey: uuidv7(),
        purchaseOrderId: id,
        toStatus: 'APPROVED',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // The other direction: Accounts approves and does not raise.
    await expect(
      accounts.procurement.createPurchaseOrder(
        orderPayload([
          { productId: plainProductId, uomId: plainUomId, qtyOrdered: '2', unitPriceE4: '10000' },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // …and the positive control on the same order and the same payload.
    const ok = await accounts.procurement.changePurchaseOrderStatus({
      idempotencyKey: uuidv7(),
      purchaseOrderId: id,
      toStatus: 'APPROVED',
    });
    expect(ok.status).toBe('APPROVED');
  });

  it('counter staff can neither raise an order nor read one', async () => {
    await expect(
      counter.procurement.createPurchaseOrder(
        orderPayload([
          { productId: plainProductId, uomId: plainUomId, qtyOrdered: '1', unitPriceE4: '10000' },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(counter.procurement.listPurchaseOrders({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('a capability is a capability AT A PLACE: OUT-01’s manager cannot order into OUT-03', async () => {
    const into03 = orderPayload(
      [{ productId: plainProductId, uomId: plainUomId, qtyOrdered: '1', unitPriceE4: '10000' }],
      { deliverToLocationId: out03 },
    );
    await expect(manager.procurement.createPurchaseOrder(into03)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      managerAt03.procurement.createPurchaseOrder({ ...into03, idempotencyKey: uuidv7() }),
    ).resolves.toBeTruthy();
  });

  it('supplier.manage is not held by the manager who buys from them', async () => {
    await expect(
      manager.procurement.upsertSupplier({
        idempotencyKey: uuidv7(),
        code: 'X1',
        name: 'X1',
        paymentTermsDays: 30,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      accounts.procurement.upsertSupplier({
        idempotencyKey: uuidv7(),
        code: 'X1',
        name: 'X1',
        paymentTermsDays: 30,
      }),
    ).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4. The state machine is the database's, and the router only reads it
// ---------------------------------------------------------------------------

describe('the purchase-order state machine, through the router', () => {
  it('DRAFT cannot jump straight to APPROVED, and the refusal names the legal next steps', async () => {
    const raised = await manager.procurement.createPurchaseOrder(
      orderPayload([
        { productId: plainProductId, uomId: plainUomId, qtyOrdered: '1', unitPriceE4: '10000' },
      ]),
    );
    await expect(
      accounts.procurement.changePurchaseOrderStatus({
        idempotencyKey: uuidv7(),
        purchaseOrderId: raised.purchaseOrderId,
        toStatus: 'APPROVED',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('SUBMITTED'),
    });
  });

  it('cancelling requires a reason — an order abandoned unexplained is unanswerable later', async () => {
    const raised = await manager.procurement.createPurchaseOrder(
      orderPayload([
        { productId: plainProductId, uomId: plainUomId, qtyOrdered: '1', unitPriceE4: '10000' },
      ]),
    );
    await expect(
      manager.procurement.changePurchaseOrderStatus({
        idempotencyKey: uuidv7(),
        purchaseOrderId: raised.purchaseOrderId,
        toStatus: 'CANCELLED',
      }),
    ).rejects.toBeTruthy();
    const ok = await manager.procurement.changePurchaseOrderStatus({
      idempotencyKey: uuidv7(),
      purchaseOrderId: raised.purchaseOrderId,
      toStatus: 'CANCELLED',
      reason: 'supplier cannot supply',
    });
    expect(ok.status).toBe('CANCELLED');
    expect(ok.cancelReason).toBe('supplier cannot supply');
  });

  it('the same idempotency key raises ONE order, not two', async () => {
    const payload = orderPayload([
      { productId: plainProductId, uomId: plainUomId, qtyOrdered: '3', unitPriceE4: '10000' },
    ]);
    const first = await manager.procurement.createPurchaseOrder(payload);
    const replay = await manager.procurement.createPurchaseOrder(payload);
    expect(replay.purchaseOrderId).toBe(first.purchaseOrderId);
    const count = await h.db.withTenant(tenantA, async (tx) => {
      const res = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.purchase_order where id = $1`,
        [first.purchaseOrderId],
      );
      return res.rows[0]?.n;
    });
    expect(count).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// 5. Tenant isolation on every read path this router owns (§2.7 category 3)
// ---------------------------------------------------------------------------

describe('tenant B cannot see or touch tenant A’s buying', () => {
  let aOrderId: string;

  beforeAll(async () => {
    const raised = await manager.procurement.createPurchaseOrder(
      orderPayload([
        { productId: plainProductId, uomId: plainUomId, qtyOrdered: '5', unitPriceE4: '10000' },
      ]),
    );
    aOrderId = raised.purchaseOrderId;
  });

  it('the positive control first: tenant A CAN read the order by that id', async () => {
    const seen = await manager.procurement.purchaseOrder({ purchaseOrderId: aOrderId });
    expect(seen.purchaseOrderId).toBe(aOrderId);
  });

  it('reading it as tenant B is NOT_FOUND, not a redacted row', async () => {
    await expect(ownerB.procurement.purchaseOrder({ purchaseOrderId: aOrderId })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });

  it('tenant B’s order list contains none of tenant A’s orders', async () => {
    const list = await ownerB.procurement.listPurchaseOrders({ limit: 500 });
    expect(list.orders.some((o: { purchaseOrderId: string }) => o.purchaseOrderId === aOrderId)).toBe(
      false,
    );
  });

  it('tenant B’s supplier list shares no id with tenant A’s, though the codes match', async () => {
    const a = await manager.procurement.listSuppliers({});
    const b = await ownerB.procurement.listSuppliers({});
    const aIds = new Set(a.suppliers.map((s: { supplierId: string }) => s.supplierId));
    expect(b.suppliers.length).toBeGreaterThan(0);
    expect(b.suppliers.some((s: { supplierId: string }) => aIds.has(s.supplierId))).toBe(false);
  });

  it('tenant B asking which suppliers stock tenant A’s product gets nothing of A’s', async () => {
    await expect(
      ownerB.procurement.suppliersForProduct({ productId: plainProductId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('tenant B cannot move tenant A’s order along', async () => {
    await expect(
      ownerB.procurement.changePurchaseOrderStatus({
        idempotencyKey: uuidv7(),
        purchaseOrderId: aOrderId,
        toStatus: 'SUBMITTED',
      }),
    ).rejects.toBeTruthy();
    const stillDraft = await manager.procurement.purchaseOrder({ purchaseOrderId: aOrderId });
    expect(stillDraft.status).toBe('DRAFT');
  });
});

// ---------------------------------------------------------------------------
// 6. `updatePurchaseOrder` — the amendment route nothing exercised
// ---------------------------------------------------------------------------
//
// It has no client (`docs/phase2-status.md` §3) and, until this section, no
// test: a guarded mutating route on a money document that nothing in the
// repository ever called. That is exactly the shape of surface that rots.
//
// The question this section was written to answer was whether the audit
// control holds — can an APPROVED order have its lines silently changed, so
// that what was approved and what was received are no longer the same
// document? The answer is NO, and it is refused TWICE: by the router's own
// status check and, underneath it, by 0008's
// `assert_purchase_order_line_draft_only` trigger. Both halves are
// demonstrated below, the trigger by going around the router entirely.
// ---------------------------------------------------------------------------

/** A line whose server-priced total is exactly `minor`. Scale 0, qty 1. */
function costing(minor: bigint): LineSpec {
  return {
    productId: plainProductId,
    uomId: plainUomId,
    qtyOrdered: '1',
    unitPriceE4: (minor * 10_000n).toString(10),
  };
}

function amendment(purchaseOrderId: string, over: Record<string, unknown> = {}) {
  return {
    idempotencyKey: uuidv7(),
    purchaseOrderId,
    ...over,
  } as Parameters<Caller['procurement']['updatePurchaseOrder']>[0];
}

/** Header + Σ(lines) straight out of Postgres, never re-derived by the test. */
async function orderFacts(id: string) {
  return h.db.withTenant(tenantA, async (tx) => {
    const res = await tx.query<{
      status: string;
      notes: string | null;
      expected_at: string | null;
      live_lines: string;
      all_lines: string;
      total: string;
    }>(
      `select po.status, po.notes, po.expected_at::text as expected_at,
              (select count(*) from app.purchase_order_line l
                where l.purchase_order_id = po.id and l.deleted_at is null)::text as live_lines,
              (select count(*) from app.purchase_order_line l
                where l.purchase_order_id = po.id)::text as all_lines,
              (select coalesce(sum(l.line_net_minor), 0) from app.purchase_order_line l
                where l.purchase_order_id = po.id and l.deleted_at is null)::text as total
         from app.purchase_order po where po.id = $1`,
      [id],
    );
    const r = res.rows[0];
    if (!r) throw new Error('order vanished');
    return {
      status: r.status,
      notes: r.notes,
      expectedAt: r.expected_at,
      liveLines: Number(r.live_lines),
      allLines: Number(r.all_lines),
      total: BigInt(r.total),
    };
  });
}

describe('amending a purchase order is the SAME capability as raising one', () => {
  let draftId: string;

  beforeAll(async () => {
    const raised = await manager.procurement.createPurchaseOrder(
      orderPayload([costing(4000n)]),
    );
    draftId = raised.purchaseOrderId;
  });

  it('counter staff, who cannot raise an order, cannot amend one either', async () => {
    await expect(
      counter.procurement.updatePurchaseOrder(amendment(draftId, { notes: 'slipped in' })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await orderFacts(draftId)).notes).not.toBe('slipped in');
  });

  it('the approver is not an amender — `accounts` holds approve, not create', async () => {
    await expect(
      accounts.procurement.updatePurchaseOrder(amendment(draftId, { notes: 'by the approver' })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await orderFacts(draftId)).notes).not.toBe('by the approver');
  });

  it('the permission is checked AT THE ORDER’S location, not merely held somewhere', async () => {
    // OUT-03's manager holds `purchase.order.create` — at OUT-03. The route
    // declares `at: 'any'` because the payload names no location; the real
    // check is made against the order's own deliver-to once it is loaded.
    await expect(
      managerAt03.procurement.updatePurchaseOrder(amendment(draftId, { notes: 'from OUT-03' })),
    ).rejects.toBeTruthy();
    expect((await orderFacts(draftId)).notes).not.toBe('from OUT-03');

    // The positive control: OUT-01's manager, same role, same permission,
    // is allowed the byte-identical amendment.
    const ok = await manager.procurement.updatePurchaseOrder(
      amendment(draftId, { notes: 'from OUT-01' }),
    );
    expect(ok.notes).toBe('from OUT-01');
    expect((await orderFacts(draftId)).notes).toBe('from OUT-01');
  });
});

describe('lines may be changed while DRAFT and at no other time', () => {
  /** Raise → submit → approve, through the router, with an unbounded approver. */
  async function approvedOrder(minor: bigint): Promise<string> {
    const { id } = await submittedOrder(manager, [costing(minor)]);
    await accounts.procurement.changePurchaseOrderStatus({
      idempotencyKey: uuidv7(),
      purchaseOrderId: id,
      toStatus: 'APPROVED',
    });
    return id;
  }

  it('DRAFT accepts an amendment, and reports what it did', async () => {
    const raised = await manager.procurement.createPurchaseOrder(orderPayload([costing(1000n)]));
    const amended = await manager.procurement.updatePurchaseOrder(
      amendment(raised.purchaseOrderId, {
        expectedAt: '2026-09-01',
        notes: 'amended before submission',
        lines: [
          { lineNo: 1, ...costing(1500n) },
          { lineNo: 2, ...costing(2500n) },
        ],
      }),
    );
    expect(amended.status).toBe('DRAFT');
    expect(amended.linesReplaced).toBe(true);
    expect(amended.lineCount).toBe(2);
    expect(amended.expectedAt).toBe('2026-09-01');

    const after = await orderFacts(raised.purchaseOrderId);
    expect(after.liveLines).toBe(2);
    expect(after.expectedAt).toBe('2026-09-01');
    expect(after.notes).toBe('amended before submission');
  });

  it('SUBMITTED is refused, and the refusal leaves the order untouched', async () => {
    const { id } = await submittedOrder(manager, [costing(1000n)]);
    const before = await orderFacts(id);
    await expect(
      manager.procurement.updatePurchaseOrder(
        amendment(id, { lines: [{ lineNo: 1, ...costing(999_999n) }] }),
      ),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('SUBMITTED'),
    });
    expect(await orderFacts(id)).toEqual(before);
  });

  it('APPROVED IS REFUSED — the approved document and the received one are the same document', async () => {
    // This is the audit control. If an approved order could take a silent
    // line change, an approval would certify nothing: whatever turned up
    // could be written back onto the order after the fact and the receipt
    // would match perfectly.
    const id = await approvedOrder(2000n);
    const before = await orderFacts(id);
    expect(before.status).toBe('APPROVED');

    await expect(
      manager.procurement.updatePurchaseOrder(
        amendment(id, { lines: [{ lineNo: 1, ...costing(500_000n) }] }),
      ),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('APPROVED'),
    });

    // Nothing moved: not the total, not the line count, not the history.
    const after = await orderFacts(id);
    expect(after).toEqual(before);
    expect(after.total).toBe(2000n);
  });

  it('a header-only amendment is refused on an APPROVED order too — not just the lines', async () => {
    const id = await approvedOrder(2000n);
    await expect(
      manager.procurement.updatePurchaseOrder(amendment(id, { notes: 'retro-fitted' })),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await orderFacts(id)).notes).not.toBe('retro-fitted');
  });

  it('CANCELLED is refused', async () => {
    const raised = await manager.procurement.createPurchaseOrder(orderPayload([costing(1000n)]));
    await manager.procurement.changePurchaseOrderStatus({
      idempotencyKey: uuidv7(),
      purchaseOrderId: raised.purchaseOrderId,
      toStatus: 'CANCELLED',
      reason: 'no longer required',
    });
    await expect(
      manager.procurement.updatePurchaseOrder(
        amendment(raised.purchaseOrderId, { lines: [{ lineNo: 1, ...costing(1n) }] }),
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('THE DATABASE IS THE BACKSTOP: the trigger refuses a line edit the router never sees', async () => {
    // Demonstrated by going AROUND the router entirely — raw SQL as the
    // tenant's own role, exactly as a future handler that forgot the status
    // check would. 0008's `assert_purchase_order_line_draft_only` is the
    // half of the control that survives a careless caller.
    const id = await approvedOrder(3000n);
    await expect(
      h.db.withTenant(tenantA, (tx) =>
        tx.query(
          `update app.purchase_order_line set line_net_minor = 1
            where purchase_order_id = $1 and deleted_at is null`,
          [id],
        ),
      ),
    ).rejects.toThrow(/DRAFT/);

    // …and it refuses a fabricated INSERT for the same reason.
    await expect(
      h.db.withTenant(tenantA, (tx) =>
        tx.query(
          `insert into app.purchase_order_line
             (tenant_id, id, write_id, hlc, purchase_order_id, line_no, product_id,
              uom_id, qty_scale, qty_ordered, unit_price_e4,
              stocking_uom_id, qty_stock_scale, qty_ordered_stock, factor_num, factor_den,
              line_net_minor)
           select l.tenant_id, gen_random_uuid(), l.write_id, l.hlc, l.purchase_order_id, 99,
                  l.product_id, l.uom_id, l.qty_scale, l.qty_ordered, l.unit_price_e4,
                  l.stocking_uom_id, l.qty_stock_scale, l.qty_ordered_stock,
                  l.factor_num, l.factor_den, l.line_net_minor
             from app.purchase_order_line l
            where l.purchase_order_id = $1 and l.deleted_at is null limit 1`,
          [id],
        ),
      ),
    ).rejects.toThrow(/DRAFT/);

    expect((await orderFacts(id)).total).toBe(3000n);
  });

  it('SUBMITTED → DRAFT is the ONE backward edge, and it is what makes amendment legal', async () => {
    const { id } = await submittedOrder(manager, [costing(1000n)]);
    await manager.procurement.changePurchaseOrderStatus({
      idempotencyKey: uuidv7(),
      purchaseOrderId: id,
      toStatus: 'DRAFT',
    });
    const amended = await manager.procurement.updatePurchaseOrder(
      amendment(id, { lines: [{ lineNo: 1, ...costing(1234n) }] }),
    );
    expect(amended.totalMinor).toBe('1234');
    expect((await orderFacts(id)).total).toBe(1234n);
  });

  it('APPROVED never returns to DRAFT, so that route cannot be used to reopen the lines', async () => {
    const id = await approvedOrder(2000n);
    await expect(
      manager.procurement.changePurchaseOrderStatus({
        idempotencyKey: uuidv7(),
        purchaseOrderId: id,
        toStatus: 'DRAFT',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await orderFacts(id)).status).toBe('APPROVED');
  });
});

describe('an amendment reprices the whole order, exactly, and keeps the old lines as history', () => {
  it('the new total is Σ(lineNetMinor(...)) over the NEW lines, and Postgres agrees', async () => {
    const raised = await manager.procurement.createPurchaseOrder(
      orderPayload([
        { productId: rebarId, uomId: rebarTonUomId, qtyOrdered: '1600', unitPriceE4: '9000000000' },
      ]),
    );
    const qty = '2500';
    const priceE4 = '7777777777';
    const amended = await manager.procurement.updatePurchaseOrder(
      amendment(raised.purchaseOrderId, {
        lines: [
          { lineNo: 1, productId: rebarId, uomId: rebarTonUomId, qtyOrdered: qty, unitPriceE4: priceE4 },
          { lineNo: 2, ...costing(3n) },
        ],
      }),
    );
    const expected =
      lineNetMinor(BigInt(qty), rebarTonScale, BigInt(priceE4), 'half-up') + 3n;
    expect(amended.totalMinor).toBe(expected.toString(10));

    const facts = await orderFacts(raised.purchaseOrderId);
    expect(facts.total).toBe(expected);
    // The replaced line is gone from the sum but NOT from the table: three
    // rows exist, two live. A hard delete would erase what was amended away.
    expect(facts.liveLines).toBe(2);
    expect(facts.allLines).toBe(3);

    // And the route's own read agrees with the amendment, not with the raise.
    const read = await manager.procurement.purchaseOrder({
      purchaseOrderId: raised.purchaseOrderId,
    });
    expect(read.totalMinor).toBe(expected.toString(10));
    expect(read.lineCount).toBe(2);
  });

  it('money and quantities come back as decimal STRINGS from this route too (ADR-0004)', async () => {
    const raised = await manager.procurement.createPurchaseOrder(orderPayload([costing(10n)]));
    const amended = await manager.procurement.updatePurchaseOrder(
      amendment(raised.purchaseOrderId, {
        lines: [
          { lineNo: 1, productId: rebarId, uomId: rebarTonUomId, qtyOrdered: '1600', unitPriceE4: '9000000000' },
        ],
      }),
    );
    expect(typeof amended.totalMinor).toBe('string');
    expect(amended.totalMinor).toMatch(/^-?\d+$/);
    const l = amended.lines?.[0];
    expect(l).toBeTruthy();
    for (const v of [l!.lineNetMinor, l!.qtyOrdered, l!.unitPriceE4, l!.qtyOrderedStock]) {
      expect(typeof v).toBe('string');
      expect(v).toMatch(/^-?\d+$/);
    }
  });

  it('omitting `lines` amends the header ONLY — the lines are not rewritten', async () => {
    const raised = await manager.procurement.createPurchaseOrder(
      orderPayload([costing(700n), costing(300n)]),
    );
    const id = raised.purchaseOrderId;
    const lineWriteIds = async () =>
      h.db.withTenant(tenantA, async (tx) => {
        const res = await tx.query<{ id: string; write_id: string }>(
          `select id::text, write_id::text from app.purchase_order_line
            where purchase_order_id = $1 and deleted_at is null order by line_no`,
          [id],
        );
        return res.rows;
      });
    const before = await lineWriteIds();

    const amended = await manager.procurement.updatePurchaseOrder(
      amendment(id, { notes: 'header only' }),
    );
    expect(amended.linesReplaced).toBe(false);
    expect(amended.lines).toBeNull();
    expect(amended.lineCount).toBe(2);
    expect(amended.totalMinor).toBe('1000');

    // Same row ids, same write ids: nothing was soft-deleted and re-inserted.
    expect(await lineWriteIds()).toEqual(before);
    const facts = await orderFacts(id);
    expect(facts.allLines).toBe(2);
    expect(facts.total).toBe(1000n);
    expect(facts.notes).toBe('header only');
  });

  it('the same idempotency key amends ONCE — a replay does not re-replace the lines', async () => {
    const raised = await manager.procurement.createPurchaseOrder(orderPayload([costing(500n)]));
    const payload = amendment(raised.purchaseOrderId, {
      lines: [{ lineNo: 1, ...costing(800n) }, { lineNo: 2, ...costing(200n) }],
    });
    const first = await manager.procurement.updatePurchaseOrder(payload);
    const afterFirst = await orderFacts(raised.purchaseOrderId);
    expect(afterFirst.allLines).toBe(3); // 1 superseded + 2 live

    const replay = await manager.procurement.updatePurchaseOrder(payload);
    expect(replay.totalMinor).toBe(first.totalMinor);
    // A second application would soft-delete the two live rows and insert two
    // more, taking the table to five. It stays at three.
    expect(await orderFacts(raised.purchaseOrderId)).toEqual(afterFirst);
    expect(afterFirst.total).toBe(1000n);
  });
});

describe('the approval bound is measured against the AMENDED order, never the raised one', () => {
  it('an order amended UP past the bound is refused by the approver who could have cleared it', async () => {
    const { id, total } = await submittedOrder(regional, [costing(approvalBound)], {
      deliverToLocationId: out01,
    });
    expect(total).toBe(approvalBound);

    // Pull it back, inflate it, re-submit. This is the evasion the bound has
    // to survive: approve-the-small-one, amend-to-the-big-one.
    await regional.procurement.changePurchaseOrderStatus({
      idempotencyKey: uuidv7(),
      purchaseOrderId: id,
      toStatus: 'DRAFT',
    });
    const over = approvalBound + 1n;
    const amended = await regional.procurement.updatePurchaseOrder(
      amendment(id, { lines: [{ lineNo: 1, ...costing(over) }] }),
    );
    expect(amended.totalMinor).toBe(over.toString(10));
    await regional.procurement.changePurchaseOrderStatus({
      idempotencyKey: uuidv7(),
      purchaseOrderId: id,
      toStatus: 'SUBMITTED',
    });

    await expect(
      regional.procurement.changePurchaseOrderStatus({
        idempotencyKey: uuidv7(),
        purchaseOrderId: id,
        toStatus: 'APPROVED',
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining(over.toString(10)),
    });
    expect((await orderFacts(id)).status).toBe('SUBMITTED');
  });

  it('and an order amended DOWN under the bound becomes approvable — the figure is current, not stale', async () => {
    const { id } = await submittedOrder(regional, [costing(approvalBound + 1n)], {
      deliverToLocationId: out01,
    });
    await expect(
      regional.procurement.changePurchaseOrderStatus({
        idempotencyKey: uuidv7(),
        purchaseOrderId: id,
        toStatus: 'APPROVED',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await regional.procurement.changePurchaseOrderStatus({
      idempotencyKey: uuidv7(),
      purchaseOrderId: id,
      toStatus: 'DRAFT',
    });
    await regional.procurement.updatePurchaseOrder(
      amendment(id, { lines: [{ lineNo: 1, ...costing(approvalBound) }] }),
    );
    await regional.procurement.changePurchaseOrderStatus({
      idempotencyKey: uuidv7(),
      purchaseOrderId: id,
      toStatus: 'SUBMITTED',
    });
    const ok = await regional.procurement.changePurchaseOrderStatus({
      idempotencyKey: uuidv7(),
      purchaseOrderId: id,
      toStatus: 'APPROVED',
    });
    expect(ok.status).toBe('APPROVED');
    expect(BigInt(ok.totalMinor)).toBe(approvalBound);
  });
});

// ---------------------------------------------------------------------------
// 7. `updatePurchaseOrder` across the tenant boundary (§2.7 category 3)
// ---------------------------------------------------------------------------
//
// The sharp version of the test: tenant B's caller is built from THE SAME
// TEMPLATE ROLE as tenant A's, so it demonstrably holds
// `purchase.order.create` and the only thing that can refuse it is the tenant
// boundary. A refusal from a caller that never held the permission would
// prove nothing.
// ---------------------------------------------------------------------------

describe('tenant B cannot amend tenant A’s order, holding the very same capability', () => {
  let managerB: Caller;
  let bOrderId: string;
  let aOrderId: string;

  beforeAll(async () => {
    const bOutlet = (await h.firstOutlet(tenantB)).id;
    managerB = h.callerFor(
      await h.principal(tenantB, { roleRef: 'outlet_manager', scopeLocationId: bOutlet }),
    );

    const bFixture = await h.db.withTenant(tenantB, async (tx) => {
      const sup = await tx.query<{ id: string }>(
        `select id from app.supplier where deleted_at is null and is_active order by code limit 1`,
      );
      const prod = await tx.query<{ product_id: string; uom_id: string }>(
        `select p.id as product_id, pu.uom_id
           from app.product p
           join app.product_uom pu
             on pu.tenant_id = p.tenant_id and pu.product_id = p.id
            and pu.uom_id = p.stocking_uom_id and pu.deleted_at is null and pu.can_buy
           join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = pu.uom_id
          where p.deleted_at is null and p.is_purchasable and u.qty_scale = 0
          order by p.sku_code limit 1`,
      );
      const s = sup.rows[0];
      const p = prod.rows[0];
      if (!s || !p) throw new Error('tenant B’s template seeded no buyable product or supplier');
      return { supplierId: s.id, productId: p.product_id, uomId: p.uom_id };
    });

    // The positive control, first: the same role in its OWN tenant raises and
    // amends without complaint.
    const raisedB = await managerB.procurement.createPurchaseOrder({
      idempotencyKey: uuidv7(),
      supplierId: bFixture.supplierId,
      deliverToLocationId: bOutlet,
      orderDate: DAY,
      lines: [
        { lineNo: 1, productId: bFixture.productId, uomId: bFixture.uomId, qtyOrdered: '1', unitPriceE4: '10000' },
      ],
    } as Parameters<Caller['procurement']['createPurchaseOrder']>[0]);
    bOrderId = raisedB.purchaseOrderId;

    const raisedA = await manager.procurement.createPurchaseOrder(
      orderPayload([costing(4242n)], { notes: 'tenant A’s own words' }),
    );
    aOrderId = raisedA.purchaseOrderId;
  });

  it('the positive control: tenant B’s manager CAN amend tenant B’s own draft', async () => {
    const ok = await managerB.procurement.updatePurchaseOrder(
      amendment(bOrderId, { notes: 'B amends B' }),
    );
    expect(ok.purchaseOrderId).toBe(bOrderId);
    expect(ok.notes).toBe('B amends B');
  });

  it('the same caller amending tenant A’s order gets NOT_FOUND — never a redacted row', async () => {
    await expect(
      managerB.procurement.updatePurchaseOrder(amendment(aOrderId, { notes: 'B amends A' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('and tenant A’s order is byte-for-byte what it was — no partial write, no leaked id', async () => {
    const before = await orderFacts(aOrderId);
    await expect(
      managerB.procurement.updatePurchaseOrder(
        amendment(aOrderId, {
          notes: 'B replaces A’s lines',
          lines: [{ lineNo: 1, ...costing(1n) }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const after = await orderFacts(aOrderId);
    expect(after).toEqual(before);
    expect(after.total).toBe(4242n);
    expect(after.notes).toBe('tenant A’s own words');
    expect(after.allLines).toBe(1);

    // Tenant A still reads its own order, so the refusal above was the
    // boundary and not a broken route.
    const seen = await manager.procurement.purchaseOrder({ purchaseOrderId: aOrderId });
    expect(seen.totalMinor).toBe('4242');
  });

  it('a tenant B order id is equally invisible to tenant A — the boundary runs both ways', async () => {
    await expect(
      manager.procurement.updatePurchaseOrder(amendment(bOrderId, { notes: 'A amends B' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const stillB = await managerB.procurement.purchaseOrder({ purchaseOrderId: bOrderId });
    expect(stillB.notes).toBe('B amends B');
  });
});
