/**
 * Effective-dated tax through the sale path (ADR-0002; 07 §7.2.4).
 *
 * The Ghana pack changes REGIME on 2026-01-01: before it, VAT 15% computes
 * on net PLUS the NHIL/GETFund/COVID levies (base_kind 'net_plus' — the
 * cascade); from that day, every component applies to net and COVID is
 * repealed. A sale the day before and a sale the day itself must use
 * different rows, different bases and different totals — and each must
 * reprice EXACTLY from its own snapshot months later (recomputeCheck).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { createApiHarness, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenantId: string;
let outletId: string;
let productId: string;
let caller: ReturnType<ApiHarness['callerFor']>;

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('tax-a');
  await h.applyTemplate(tenantId);
  const outlet = await h.firstOutlet(tenantId);
  outletId = outlet.id;
  const product = await h.pickProduct(tenantId);
  productId = product.id;
  // 5500 minor units per unit (GH₵55.00), e4 representation.
  await h.seedWholesalePrice(tenantId, productId, 55_000_000n);
  caller = h.callerFor(await h.identityFor(tenantId, { locs: [outletId] }));
}, 180_000);

afterAll(async () => {
  await h.close();
});

function saleOn(businessDate: string, receiptNo: string) {
  return caller.sales.createSale({
    idempotencyKey: uuidv7(),
    locationId: outletId,
    priceListCode: 'WHOLESALE',
    receiptNo,
    businessDate,
    tender: 'CASH',
    lines: [{ productId, qty: '5' }], // net = 5 × 5500 = 27500
  });
}

describe('tax boundary: the rate row in force on the business date', () => {
  it('2025-12-31 uses the PRIOR regime: levies on net, VAT on the cascaded base', async () => {
    const sale = await saleOn('2025-12-31', 'R-TAX-2025');
    const line = sale.lines[0]!;
    expect(line.lineNetMinor).toBe('27500');

    const byCode = new Map(line.taxLines.map((t) => [t.taxCode, t]));
    // Levies at 2.5 / 2.5 / 1 % on net 27500 (half_up per the pack rows).
    expect(byCode.get('GH.NHIL')).toMatchObject({ baseKind: 'net', baseMinor: '27500', taxMinor: '688' });
    expect(byCode.get('GH.GETFUND')).toMatchObject({ baseKind: 'net', baseMinor: '27500', taxMinor: '688' });
    expect(byCode.get('GH.COVID')).toMatchObject({ baseKind: 'net', baseMinor: '27500', taxMinor: '275' });
    // VAT on net PLUS the three levies: 27500+688+688+275 = 29151 → 15% → 4373.
    expect(byCode.get('GH.VAT.STD')).toMatchObject({
      baseKind: 'net_plus',
      baseMinor: '29151',
      taxMinor: '4373',
    });
    expect(sale.taxTotalMinor).toBe('6024');
    expect(sale.totalMinor).toBe('33524');
  });

  it('2026-01-01 (the boundary day itself) uses the NEW regime: everything on net, COVID gone', async () => {
    const sale = await saleOn('2026-01-01', 'R-TAX-2026');
    const line = sale.lines[0]!;
    const byCode = new Map(line.taxLines.map((t) => [t.taxCode, t]));
    expect(byCode.has('GH.COVID')).toBe(false); // repealed — range closed, row survives
    expect(byCode.get('GH.VAT.STD')).toMatchObject({ baseKind: 'net', baseMinor: '27500', taxMinor: '4125' });
    expect(byCode.get('GH.NHIL')).toMatchObject({ taxMinor: '688' });
    expect(byCode.get('GH.GETFUND')).toMatchObject({ taxMinor: '688' });
    expect(sale.taxTotalMinor).toBe('5501');
    expect(sale.totalMinor).toBe('33001');
  });

  it('each sale pins the EXACT tax_rate row in force on its business date', async () => {
    const pre = await saleOn('2025-06-15', 'R-TAX-PIN-PRE');
    const post = await saleOn('2026-03-01', 'R-TAX-PIN-POST');
    const preVat = pre.lines[0]!.taxLines.find((t) => t.taxCode === 'GH.VAT.STD')!;
    const postVat = post.lines[0]!.taxLines.find((t) => t.taxCode === 'GH.VAT.STD')!;
    expect(preVat.taxRateId).not.toBe(postVat.taxRateId);

    // And each pinned row genuinely is the platform row in force that day.
    const rows = await h.db.asAdmin((tx) =>
      tx.query<{ id: string; on_pre: boolean; on_post: boolean }>(
        `select id, effective @> date '2025-06-15' as on_pre, effective @> date '2026-03-01' as on_post
         from platform.tax_rate where jurisdiction_code = 'GH' and tax_code = 'GH.VAT.STD'`,
      ),
    );
    const preRow = rows.rows.find((r) => r.on_pre)!;
    const postRow = rows.rows.find((r) => r.on_post)!;
    expect(preVat.taxRateId).toBe(preRow.id);
    expect(postVat.taxRateId).toBe(postRow.id);
  });

  it('historical reprice: recomputing from the snapshot reproduces both documents EXACTLY', async () => {
    const pre = await saleOn('2025-11-20', 'R-TAX-RC-PRE');
    const post = await saleOn('2026-02-10', 'R-TAX-RC-POST');
    for (const sale of [pre, post]) {
      const check = await caller.sales.recomputeCheck({ saleId: sale.saleId });
      expect(check.mismatches).toEqual([]);
      expect(check.matches).toBe(true);
    }
  });
});
