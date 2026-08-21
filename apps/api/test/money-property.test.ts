/**
 * Money exactness property (CLAUDE.md §2.7 category 1; ADR-0004).
 *
 * For randomly generated carts — random products, awkward prices, random
 * quantities and occasional line discounts, on dates in BOTH tax regimes —
 * the invariant is exact bigint identity, with no tolerance:
 *
 *   Σ(line nets) − Σ(line discounts) + Σ(tax components) === sale total
 *
 * asserted three ways: inside the API response, against the rows the
 * database actually stored, and between response and rows. The PRNG is
 * seeded so a failure reproduces.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { createApiHarness, makeRng, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenantId: string;
let outletId: string;
let caller: ReturnType<ApiHarness['callerFor']>;
let products: { id: string }[];

// Deliberately awkward unit prices (minor units × 10⁴): sub-minor-unit
// precision, primes, values that force every rounding path.
const PRICES_E4: bigint[] = [23_750n, 1_333_337n, 55_000_000n, 9_999n, 74_856_250n];

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('money-prop');
  await h.applyTemplate(tenantId);
  const outlet = await h.firstOutlet(tenantId);
  outletId = outlet.id;

  // Five scale-0 stocked products with the awkward price list.
  products = await h.db.withTenant(tenantId, async (tx) => {
    const res = await tx.query<{ id: string }>(
      `select p.id
       from app.product p
       join app.product_uom pu
         on pu.tenant_id = p.tenant_id and pu.product_id = p.id and pu.is_default_sell
        and pu.deleted_at is null
       join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = pu.uom_id
       where p.deleted_at is null and p.is_sellable and p.stock_tracking = 'STOCKED'
         and u.qty_scale = 0
       order by p.sku_code limit 5`,
    );
    return res.rows;
  });
  expect(products.length).toBe(5);
  for (let i = 0; i < products.length; i += 1) {
    await h.seedWholesalePrice(tenantId, products[i]!.id, PRICES_E4[i]!);
  }
  caller = h.callerFor(await h.identityFor(tenantId, { locs: [outletId] }));
}, 180_000);

afterAll(async () => {
  await h.close();
});

describe('random carts: totals are exact bigint identities', () => {
  it('Σ(line totals) + Σ(tax) === sale total, in the response AND in the database', async () => {
    const rng = makeRng(0x5eed_2026);
    const dates = ['2025-03-05', '2025-12-31', '2026-01-01', '2026-07-19'];

    for (let cart = 0; cart < 16; cart += 1) {
      const lineCount = 1 + Math.floor(rng() * 6);
      const lines = Array.from({ length: lineCount }, () => {
        const qtyN = 1 + Math.floor(rng() * 500);
        // A discount may not exceed the line net (the API rejects that, correctly).
        // The cheapest price in the list is ~1 minor unit per unit of qty, so the
        // net can be as low as qtyN; only discount lines with room for up to 9.
        const discount = qtyN >= 10 && rng() < 0.3 ? String(1 + Math.floor(rng() * 9)) : '0';
        return {
          productId: products[Math.floor(rng() * products.length)]!.id,
          qty: String(qtyN),
          lineDiscountMinor: discount,
        };
      });
      const businessDate = dates[Math.floor(rng() * dates.length)]!;

      const sale = await caller.sales.createSale({
        idempotencyKey: uuidv7(),
        locationId: outletId,
        priceListCode: 'WHOLESALE',
        receiptNo: `R-PROP-${cart}`,
        businessDate,
        tender: 'CASH',
        lines,
      });

      // (1) Inside the response.
      let net = 0n;
      let discount = 0n;
      let tax = 0n;
      for (const l of sale.lines) {
        net += BigInt(l.lineNetMinor);
        discount += BigInt(l.lineDiscountMinor);
        const componentSum = l.taxLines.reduce((s, t) => s + BigInt(t.taxMinor), 0n);
        expect(BigInt(l.taxMinor)).toBe(componentSum); // line tax = Σ its components
        tax += componentSum;
      }
      expect(BigInt(sale.subtotalNetMinor)).toBe(net);
      expect(BigInt(sale.discountMinor)).toBe(discount);
      expect(BigInt(sale.taxTotalMinor)).toBe(tax);
      expect(BigInt(sale.totalMinor)).toBe(net - discount + tax);

      // (2) Against what the database stored (RLS context of the tenant).
      const stored = await h.db.withTenant(tenantId, async (tx) => {
        const head = await tx.query<{ subtotal: string; discount: string; tax: string; total: string }>(
          `select subtotal_net_minor::text as subtotal, discount_minor::text as discount,
                  tax_total_minor::text as tax, total_minor::text as total
           from app.sale where id = $1`,
          [sale.saleId],
        );
        const sums = await tx.query<{ net: string; discount: string; linetax: string; comptax: string }>(
          `select
             coalesce(sum(l.line_net_minor), 0)::bigint::text as net,
             coalesce(sum(l.line_discount_minor), 0)::bigint::text as discount,
             coalesce(sum(l.tax_minor), 0)::bigint::text as linetax,
             (select coalesce(sum(t.tax_minor), 0)::bigint::text
              from app.sale_tax_line t where t.sale_id = $1) as comptax
           from app.sale_line l where l.sale_id = $1`,
          [sale.saleId],
        );
        return { head: head.rows[0]!, sums: sums.rows[0]! };
      });

      expect(stored.sums.net).toBe(stored.head.subtotal);
      expect(stored.sums.linetax).toBe(stored.head.tax);
      expect(stored.sums.comptax).toBe(stored.head.tax); // tax lines foot to the header
      expect(
        BigInt(stored.head.subtotal) - BigInt(stored.head.discount) + BigInt(stored.head.tax),
      ).toBe(BigInt(stored.head.total));

      // (3) Response ≡ rows.
      expect(sale.totalMinor).toBe(stored.head.total);
    }
  });
});
