/**
 * Idempotent retry through the pipeline (03 §3.3): the same createSale
 * twice produces ONE sale and byte-identical responses; concurrent
 * same-key calls produce exactly one effect; a reused key with a different
 * payload is refused, applying nothing. Idempotency-key uniqueness is
 * per tenant, never global (ADR-0005).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { createApiHarness, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenantA: string;
let tenantB: string;
let outletId: string;
let productId: string;
let caller: ReturnType<ApiHarness['callerFor']>;

beforeAll(async () => {
  h = await createApiHarness();
  tenantA = await h.provisionTenant('idem-a');
  tenantB = await h.provisionTenant('idem-b');
  await h.applyTemplate(tenantA);
  const outlet = await h.firstOutlet(tenantA);
  outletId = outlet.id;
  const product = await h.pickProduct(tenantA);
  productId = product.id;
  await h.seedWholesalePrice(tenantA, productId, 55_000_000n); // 5500 minor/unit (GH₵55.00), e4
  caller = h.callerFor(await h.identityFor(tenantA, { locs: [outletId] }));
}, 180_000);

afterAll(async () => {
  await h.close();
});

function saleInput(key: string, receiptNo: string) {
  return {
    idempotencyKey: key,
    locationId: outletId,
    priceListCode: 'WHOLESALE',
    receiptNo,
    businessDate: '2026-08-15',
    tender: 'CASH' as const,
    lines: [{ productId, qty: '5' }],
  };
}

describe('idempotent createSale', () => {
  it('same key twice → one sale, identical responses, one write_log row', async () => {
    const key = uuidv7();
    const first = await caller.sales.createSale(saleInput(key, 'R-0001'));
    const second = await caller.sales.createSale(saleInput(key, 'R-0001'));
    expect(second).toEqual(first); // the STORED response, replayed verbatim

    const counts = await h.db.asAdmin((tx) =>
      tx.query<{ sales: string; markers: string }>(
        `select
           (select count(*) from app.sale where tenant_id = $1 and id = $2)::text as sales,
           (select count(*) from app.write_log where tenant_id = $1 and id = $3)::text as markers`,
        [tenantA, first.saleId, key],
      ),
    );
    expect(counts.rows[0]!.sales).toBe('1');
    expect(counts.rows[0]!.markers).toBe('1');
  });

  it('concurrent same-key calls → exactly one effect, identical responses', async () => {
    const key = uuidv7();
    const input = saleInput(key, 'R-0002');
    const [r1, r2] = await Promise.all([caller.sales.createSale(input), caller.sales.createSale(input)]);
    expect(r2).toEqual(r1);

    const count = await h.db.asAdmin((tx) =>
      tx.query<{ n: string }>(
        `select count(*)::text as n from app.sale where tenant_id = $1 and receipt_no = 'R-0002'`,
        [tenantA],
      ),
    );
    expect(count.rows[0]!.n).toBe('1');
  });

  it('retrying a movement does not double the derived on-hand', async () => {
    const key = uuidv7();
    const move = {
      idempotencyKey: key,
      locationId: outletId,
      productId,
      qtyDelta: '40',
      sourceKind: 'RECEIPT' as const,
      reasonCode: 'OPENING',
      businessDate: '2026-08-15',
    };
    const before = await caller.inventory.onHand({ locationId: outletId, productId });
    await caller.inventory.recordMovement(move);
    await caller.inventory.recordMovement(move); // retry after "ambiguous failure"
    const after = await caller.inventory.onHand({ locationId: outletId, productId });
    expect(BigInt(after.qtyOnHand) - BigInt(before.qtyOnHand)).toBe(40n);
  });

  it('same key, DIFFERENT payload → 409 IDEMPOTENCY_KEY_REUSE, nothing applied', async () => {
    const key = uuidv7();
    await caller.sales.createSale(saleInput(key, 'R-0003'));
    await expect(caller.sales.createSale(saleInput(key, 'R-0003-DIFFERENT'))).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('IDEMPOTENCY_KEY_REUSE'),
    });
    const count = await h.db.asAdmin((tx) =>
      tx.query<{ n: string }>(
        `select count(*)::text as n from app.sale
         where tenant_id = $1 and receipt_no like 'R-0003%'`,
        [tenantA],
      ),
    );
    expect(count.rows[0]!.n).toBe('1');
  });

  it('the same key value in ANOTHER tenant is independent (per-tenant scope, never global)', async () => {
    const key = uuidv7();
    // Tenant A uses the key.
    await caller.credit.openAccount({
      idempotencyKey: key,
      newCustomer: { code: 'CR-KEY-A', name: 'Key Scope A' },
      termsDays: 30,
      feeRateBpPerMonth: 200,
      creditLimitMinor: '100000',
    });
    // Tenant B reuses the SAME key value for a different write — no
    // collision, no false "already applied", no cross-tenant probe.
    const callerB = h.callerFor(await h.identityFor(tenantB));
    const resB = await callerB.credit.openAccount({
      idempotencyKey: key,
      newCustomer: { code: 'CR-KEY-B', name: 'Key Scope B' },
      termsDays: 60,
      feeRateBpPerMonth: 300,
      creditLimitMinor: '200000',
    });
    expect(resB.termsDays).toBe(60);
    const rows = await h.db.asAdmin((tx) =>
      tx.query<{ tenant_id: string }>(`select tenant_id from app.write_log where id = $1`, [key]),
    );
    expect(rows.rows.map((r) => r.tenant_id).sort()).toEqual([tenantA, tenantB].sort());
  });
});
