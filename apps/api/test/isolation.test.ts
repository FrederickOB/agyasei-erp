/**
 * Two-tenant isolation THROUGH THE API (CLAUDE.md §2.7 category 3).
 *
 * Two tenants are provisioned through the operator plane, templated
 * identically, and then every Phase 1 read path is probed from both sides:
 * list, search, detail (foreign id → the SAME generic not-found a missing
 * id gets — no existence leak), and the derived aggregates (on-hand,
 * exposure). A forged tenant id in a payload is REJECTED by the strict
 * input schema, and the write it rode in on cannot cross regardless,
 * because every statement's tenant comes from the verified token.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import { uuidv7 } from '@erp/db';
import { createApiHarness, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  h = await createApiHarness();
  tenantA = await h.provisionTenant('tenant-a');
  tenantB = await h.provisionTenant('tenant-b');
  await h.applyTemplate(tenantA);
  await h.applyTemplate(tenantB);
}, 180_000);

afterAll(async () => {
  await h.close();
});

describe('tenant isolation through the API', () => {
  it('list: each tenant sees a full catalogue and the id sets are disjoint', async () => {
    const a = await h.callerFor(await h.identityFor(tenantA)).catalogue.list({ limit: 200 });
    const b = await h.callerFor(await h.identityFor(tenantB)).catalogue.list({ limit: 200 });
    expect(a.products.length).toBeGreaterThan(100);
    expect(b.products.length).toBeGreaterThan(100);
    const aIds = new Set(a.products.map((p) => p.productId));
    for (const p of b.products) expect(aIds.has(p.productId)).toBe(false);
  });

  it('search: a product visible only in tenant B is invisible to tenant A', async () => {
    // Author a B-only product directly in B's own RLS context.
    await h.db.withTenant(tenantB, async (tx) => {
      const writeId = uuidv7();
      await tx.query(
        `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
         values ($1, $2, 'SERVER', $3, 'test.author_product', 1, decode('00','hex'))`,
        [tenantB, writeId, h.deps.clock.next()],
      );
      const donor = await tx.query<{ category_id: string; stocking_uom_id: string }>(
        `select category_id, stocking_uom_id from app.product limit 1`,
      );
      await tx.query(
        `insert into app.product
           (tenant_id, id, write_id, hlc, sku_code, name, category_id, stocking_uom_id, tax_code)
         values ($1,$2,$3,$4,'SKU-ZZZ','Unobtainium Coupling ZZZ',$5,$6,'GH.VAT.STD')`,
        [tenantB, uuidv7(), writeId, h.deps.clock.next(), donor.rows[0]!.category_id, donor.rows[0]!.stocking_uom_id],
      );
    });

    const inB = await h.callerFor(await h.identityFor(tenantB)).catalogue.search({ q: 'unobtainium zzz' });
    expect(inB.products).toHaveLength(1);
    const inA = await h.callerFor(await h.identityFor(tenantA)).catalogue.search({ q: 'unobtainium zzz' });
    expect(inA.products).toHaveLength(0);
  });

  it('detail: a foreign id and a nonexistent id are INDISTINGUISHABLE', async () => {
    const callerB = h.callerFor(await h.identityFor(tenantB));
    const bProduct = (await callerB.catalogue.list({ limit: 1 })).products[0]!;
    const callerA = h.callerFor(await h.identityFor(tenantA));

    // POSITIVE CONTROLS FIRST. The Phase 2 gate (§4.4.2) found this test
    // vacuous: `catalogue.detail` was called nowhere else, so a stub that
    // always threw NOT_FOUND passed it. The route must be shown to ANSWER —
    // for B, with B's own id, and for A, with A's — before its refusal of the
    // other tenant's id means anything.
    const ownB = await callerB.catalogue.detail({ productId: bProduct.productId });
    expect(ownB.productId).toBe(bProduct.productId);
    const aProduct = (await callerA.catalogue.list({ limit: 1 })).products[0]!;
    const ownA = await callerA.catalogue.detail({ productId: aProduct.productId });
    expect(ownA.skuCode).toBe(aProduct.skuCode);

    const errors: TRPCError[] = [];
    for (const probeId of [bProduct.productId, uuidv7()]) {
      try {
        await callerA.catalogue.detail({ productId: probeId });
        expect.unreachable('detail should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TRPCError);
        errors.push(err as TRPCError);
      }
    }
    expect(errors[0]!.code).toBe('NOT_FOUND');
    expect(errors[1]!.code).toBe('NOT_FOUND');
    // Same code, same message: nothing reveals that the first id exists.
    expect(errors[0]!.message).toBe(errors[1]!.message);
  });

  it('aggregates: on-hand sums exclude the other tenant entirely', async () => {
    const outletA = await h.firstOutlet(tenantA);
    const outletB = await h.firstOutlet(tenantB);
    const productA = await h.pickProduct(tenantA);
    const productB = await h.pickProduct(tenantB);

    const callerA = h.callerFor(await h.identityFor(tenantA, { locs: [outletA.id] }));
    const callerB = h.callerFor(await h.identityFor(tenantB, { locs: [outletB.id] }));

    await callerA.inventory.recordMovement({
      idempotencyKey: uuidv7(),
      locationId: outletA.id,
      productId: productA.id,
      qtyDelta: '100',
      sourceKind: 'OPENING',
      reasonCode: 'OPENING',
      businessDate: '2026-08-01',
    });
    await callerB.inventory.recordMovement({
      idempotencyKey: uuidv7(),
      locationId: outletB.id,
      productId: productB.id,
      qtyDelta: '77',
      sourceKind: 'OPENING',
      reasonCode: 'OPENING',
      businessDate: '2026-08-01',
    });

    const onHandA = await callerA.inventory.onHand({ locationId: outletA.id, productId: productA.id });
    const onHandB = await callerB.inventory.onHand({ locationId: outletB.id, productId: productB.id });
    expect(onHandA.qtyOnHand).toBe('100');
    expect(onHandB.qtyOnHand).toBe('77');

    // A cannot even name B's rows. Asked at A's OWN outlet — where A is
    // unquestionably permitted — B's product does not resolve at all: it is
    // RLS that makes it invisible, not the permission check.
    await expect(
      callerA.inventory.onHand({ locationId: outletA.id, productId: productB.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // And B's LOCATION is refused before any row is read: `stock.view` is a
    // capability AT A PLACE, and A holds it at no place of B's. Two
    // independent controls, either of which alone would be enough here.
    await expect(
      callerA.inventory.onHand({ locationId: outletB.id, productId: productB.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('credit: exposure aggregates only this tenant; a foreign account is not found', async () => {
    const callerA = h.callerFor(await h.identityFor(tenantA));
    const callerB = h.callerFor(await h.identityFor(tenantB));

    const accA = await callerA.credit.openAccount({
      idempotencyKey: uuidv7(),
      newCustomer: { code: 'CR-A1', name: 'Kwame Contractors' },
      termsDays: 30,
      feeRateBpPerMonth: 200,
      creditLimitMinor: '800000',
    });
    const accB = await callerB.credit.openAccount({
      idempotencyKey: uuidv7(),
      newCustomer: { code: 'CR-B1', name: 'Bono Builders' },
      termsDays: 60,
      feeRateBpPerMonth: 300,
      creditLimitMinor: '900000',
    });

    await callerA.credit.recordEntry({
      idempotencyKey: uuidv7(),
      accountId: accA.accountId,
      kind: 'CHARGE',
      amountMinor: '500000',
      businessDate: '2026-08-10',
    });
    await callerB.credit.recordEntry({
      idempotencyKey: uuidv7(),
      accountId: accB.accountId,
      kind: 'CHARGE',
      amountMinor: '111111',
      businessDate: '2026-08-10',
    });

    const expA = await callerA.credit.exposure({ accountId: accA.accountId });
    expect(expA.exposureMinor).toBe('500000');

    await expect(callerA.credit.exposure({ accountId: accB.accountId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      callerA.credit.ageing({ accountId: accB.accountId, asOf: '2026-09-01' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a forged tenant id in a payload is rejected, and cannot cross regardless', async () => {
    const outletA = await h.firstOutlet(tenantA);
    const productA = await h.pickProduct(tenantA);
    const callerA = h.callerFor(await h.identityFor(tenantA, { locs: [outletA.id] }));

    // Strict schemas: an unknown tenant key is a validation failure, not a
    // silently-stripped input.
    await expect(
      callerA.inventory.recordMovement({
        idempotencyKey: uuidv7(),
        locationId: outletA.id,
        productId: productA.id,
        qtyDelta: '5',
        sourceKind: 'RECEIPT',
        reasonCode: 'OPENING',
        businessDate: '2026-08-02',
        // @ts-expect-error — forged tenant id must not typecheck either
        tenantId: tenantB,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // And the legitimate write lands under the TOKEN's tenant, only.
    const key = uuidv7();
    await callerA.inventory.recordMovement({
      idempotencyKey: key,
      locationId: outletA.id,
      productId: productA.id,
      qtyDelta: '5',
      sourceKind: 'RECEIPT',
      reasonCode: 'OPENING',
      businessDate: '2026-08-02',
    });
    const owners = await h.db.asAdmin((tx) =>
      tx.query<{ tenant_id: string }>(`select tenant_id from app.write_log where id = $1`, [key]),
    );
    expect(owners.rows).toHaveLength(1);
    expect(owners.rows[0]!.tenant_id).toBe(tenantA);
  });
});
