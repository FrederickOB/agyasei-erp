/**
 * Tax-INCLUSIVE price lists through the sale path (04 §4.13 rows 6 and 10;
 * 07 §7.2.4). Tenant #1's best-ranked list is `RETAIL`, `is_tax_inclusive`,
 * so until this worked the pilot counter could not ring a retail sale at all.
 *
 * ── THE INVARIANT UNDER TEST ─────────────────────────────────────────────
 *   net + Σ(tax components) === the gross the customer was quoted
 * exactly, for every cart, on every business date, in the response AND in the
 * rows the database actually stored. A shelf price is what the customer hands
 * over; if the parts do not sum to it, either the customer is short-changed or
 * the books do not reconcile.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The other three properties, each its own describe block: an inclusive sale
 * and an equivalent exclusive one store IDENTICAL figures (the kind of list is
 * a property of the list, never of the sale); a historical sale de-grosses
 * against the composition in force on ITS business date, not today's; and the
 * server's own recompute reproduces every de-grossed figure from the sale's
 * snapshot.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { createApiHarness, makeRng, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenantId: string;
let outletId: string;
let caller: ReturnType<ApiHarness['callerFor']>;
let productId: string;
let products: { id: string }[];

/**
 * A NET unit price and the GROSS it composes to under the 2026 Ghana regime
 * (NHIL 2.5% + GETFund 2.5% + VAT 15%, all on net — 20% effective):
 *   net 5500 → 138 + 138 + 825 = 1101 tax → gross 6601.
 * Both figures are minor units; the price columns are ×10⁴ (`rate_e4`).
 * Nothing here is a constant the SERVER uses — the server derives every one of
 * these from the pack rows. They are written out so a failure says which
 * component moved.
 */
const NET_UNIT_MINOR = 5_500n;
const GROSS_UNIT_MINOR = 6_601n;
const e4 = (minor: bigint): bigint => minor * 10_000n;

/** Deliberately awkward SHELF prices for the property cart. Index 0 is the
 * gross above; index 1 is 4 pesewas, a gross the forward composition can
 * never produce, so de-grossing it must place a residual. */
const SHELF_PRICES_MINOR: bigint[] = [6_601n, 4n, 1_999n, 12_345n, 7n];

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('tax-incl');
  await h.applyTemplate(tenantId);
  outletId = (await h.firstOutlet(tenantId)).id;

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
       order by p.sku_code limit 7`,
    );
    return res.rows;
  });
  expect(products.length).toBe(7);
  productId = products[0]!.id;

  // products[0..4] carry a RETAIL shelf price. products[0] additionally
  // carries the WHOLESALE net whose gross that shelf price IS, at qty 1.
  // A price list item is effective-dated per (list, product, unit), so each
  // product is priced ONCE per list here and never re-priced later.
  await h.seedListPrice(tenantId, 'WHOLESALE', productId, e4(NET_UNIT_MINOR));
  for (let i = 0; i < SHELF_PRICES_MINOR.length; i += 1) {
    await h.seedListPrice(tenantId, 'RETAIL', products[i]!.id, e4(SHELF_PRICES_MINOR[i]!));
  }
  // products[5..6] are reserved for the equivalence test, which derives their
  // RETAIL shelf price from the server's own WHOLESALE repricing.
  await h.seedListPrice(tenantId, 'WHOLESALE', products[5]!.id, e4(1_234n));
  await h.seedListPrice(tenantId, 'WHOLESALE', products[6]!.id, e4(87_650n));

  caller = h.callerFor(await h.identityFor(tenantId, { locs: [outletId] }));
}, 180_000);

afterAll(async () => {
  await h.close();
});

type Line = { productId: string; qty: string; lineDiscountMinor?: string };

async function ring(
  priceListCode: string,
  receiptNo: string,
  lines: Line[],
  businessDate = '2026-08-23',
) {
  return caller.sales.createSale(await h.legacySale({
    idempotencyKey: uuidv7(),
    locationId: outletId,
    priceListCode,
    receiptNo,
    businessDate,
    tender: 'CASH',
    lines,
  }));
}

/** The header the DATABASE holds, not the one the response claimed. */
async function storedHead(saleId: string) {
  return h.db.withTenant(tenantId, async (tx) => {
    const head = await tx.query<{
      subtotal: string;
      discount: string;
      tax: string;
      total: string;
    }>(
      `select subtotal_net_minor::text as subtotal, discount_minor::text as discount,
              tax_total_minor::text as tax, total_minor::text as total
       from app.sale where id = $1`,
      [saleId],
    );
    const comp = await tx.query<{ comptax: string; lines: string }>(
      `select coalesce(sum(t.tax_minor), 0)::bigint::text as comptax,
              (select coalesce(sum(l.line_net_minor), 0)::bigint::text
               from app.sale_line l where l.sale_id = $1) as lines
       from app.sale_tax_line t where t.sale_id = $1`,
      [saleId],
    );
    return { ...head.rows[0]!, ...comp.rows[0]! };
  });
}

describe('a tax-inclusive list rings, and the parts sum to the shelf price', () => {
  it('carves the tax OUT of the quoted gross — never adds it on', async () => {
    const qty = 5n;
    const gross = GROSS_UNIT_MINOR * qty; // 33 005
    const sale = await ring('RETAIL', 'R-INC-1', [{ productId, qty: String(qty) }]);

    const line = sale.lines[0]!;
    const componentSum = line.taxLines.reduce((s, t) => s + BigInt(t.taxMinor), 0n);
    expect(BigInt(line.taxMinor)).toBe(componentSum);
    // The whole point: net + tax IS the shelf price × quantity, to the pesewa.
    expect(BigInt(line.lineNetMinor) + componentSum).toBe(gross);
    expect(BigInt(sale.totalMinor)).toBe(gross);
    // And the tax was carved out, not added: the total is not gross + tax.
    expect(BigInt(sale.totalMinor)).toBeLessThan(gross + componentSum);

    const stored = await storedHead(sale.saleId);
    expect(BigInt(stored.subtotal) + BigInt(stored.tax)).toBe(gross);
    expect(stored.total).toBe(String(gross));
    expect(stored.comptax).toBe(stored.tax);
    expect(stored.lines).toBe(stored.subtotal);
  });

  it('holds for a gross the forward composition can never produce (a residual is placed)', async () => {
    // 4 pesewas at 20% effective: net 3 grosses to 3 and net 4 grosses to 5,
    // so 4 has NO preimage. The leftover pesewa must land on a component
    // rather than be absorbed, or the receipt does not foot.
    const sale = await ring('RETAIL', 'R-INC-RESID', [{ productId: products[1]!.id, qty: '1' }]);
    const line = sale.lines[0]!;
    const componentSum = line.taxLines.reduce((s, t) => s + BigInt(t.taxMinor), 0n);
    expect(BigInt(line.lineNetMinor) + componentSum).toBe(4n);

    const placed = line.taxLines.filter((t) => BigInt(t.residualMinor) !== 0n);
    expect(placed.length).toBeGreaterThan(0);
    // Every component still reports its own re-verifiable arithmetic.
    for (const t of line.taxLines) {
      expect(BigInt(t.taxMinor)).toBe(BigInt(t.computedMinor) + BigInt(t.residualMinor));
    }
    // A zero-rated component could never be handed one (no component here is
    // zero-rated, so assert the weaker, still-load-bearing fact): the residual
    // went to a component that actually has a claim on the tax.
    for (const t of placed) expect(BigInt(t.rateBp)).toBeGreaterThan(0n);
    expect(await storedHead(sale.saleId).then((s) => s.total)).toBe('4');
  });

  it('a line discount comes off the GROSS, and the line still foots (row 10)', async () => {
    const qty = 5n;
    const gross = GROSS_UNIT_MINOR * qty;
    const discount = 1_000n;
    const sale = await ring('RETAIL', 'R-INC-DISC', [
      { productId, qty: String(qty), lineDiscountMinor: String(discount) },
    ]);
    const line = sale.lines[0]!;
    const componentSum = line.taxLines.reduce((s, t) => s + BigInt(t.taxMinor), 0n);

    // What the customer pays is the quoted gross less what was taken off it.
    expect(BigInt(sale.totalMinor)).toBe(gross - discount);
    expect(BigInt(line.lineNetMinor) - BigInt(line.lineDiscountMinor) + componentSum).toBe(
      gross - discount,
    );
    // Both stored figures are net of tax — the discount recorded against a
    // revenue contra is smaller than the gross discount the operator typed,
    // by exactly the tax that came off with it.
    expect(BigInt(line.lineDiscountMinor)).toBeLessThan(discount);
    expect(BigInt(line.lineDiscountMinor)).toBeGreaterThan(0n);

    const stored = await storedHead(sale.saleId);
    expect(BigInt(stored.subtotal) - BigInt(stored.discount) + BigInt(stored.tax)).toBe(
      BigInt(stored.total),
    );
  });

  it('refuses a discount larger than the quoted gross', async () => {
    await expect(
      ring('RETAIL', 'R-INC-OVER', [
        { productId, qty: '1', lineDiscountMinor: String(GROSS_UNIT_MINOR + 1n) },
      ]),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('the kind of list is a property of the LIST, never of the sale', () => {
  it('the same cart on an inclusive and an equivalent exclusive list stores the same figures', async () => {
    // "Equivalent" is derived, never asserted: price the cart on the EXCLUSIVE
    // list first, then make the inclusive shelf price exactly the gross the
    // server itself arrived at, per unit. (Quantities divide 10⁴, so the e4
    // shelf price is exact and the extended amount reproduces that gross to
    // the pesewa — no rounding is hidden inside the fixture.)
    const cases: { p: string; qty: string }[] = [
      { p: productId, qty: '1' },
      { p: products[5]!.id, qty: '5' },
      { p: products[6]!.id, qty: '25' },
    ];
    for (const { p, qty } of cases) {
      const excl = await ring('WHOLESALE', `R-EQ-X-${qty}`, [{ productId: p, qty }]);
      if (p !== productId) {
        const shelfE4 = (BigInt(excl.totalMinor) * 10_000n) / BigInt(qty);
        expect(shelfE4 * BigInt(qty)).toBe(BigInt(excl.totalMinor) * 10_000n);
        await h.seedListPrice(tenantId, 'RETAIL', p, shelfE4);
      }
      const incl = await ring('RETAIL', `R-EQ-I-${qty}`, [{ productId: p, qty }]);

      expect(incl.subtotalNetMinor).toBe(excl.subtotalNetMinor);
      expect(incl.taxTotalMinor).toBe(excl.taxTotalMinor);
      expect(incl.totalMinor).toBe(excl.totalMinor);
      expect(incl.discountMinor).toBe(excl.discountMinor);

      const i = incl.lines[0]!;
      const x = excl.lines[0]!;
      expect(i.lineNetMinor).toBe(x.lineNetMinor);
      expect(i.taxMinor).toBe(x.taxMinor);
      expect(i.taxLines.map((t) => [t.taxCode, t.baseMinor, t.taxMinor, t.taxRateId])).toEqual(
        x.taxLines.map((t) => [t.taxCode, t.baseMinor, t.taxMinor, t.taxRateId]),
      );
      // Priced from the shelf gross, the de-grossing is the EXACT inverse of
      // the forward path here, so no residual is placed either.
      for (const t of i.taxLines) expect(t.residualMinor).toBe('0');

      const si = await storedHead(incl.saleId);
      const sx = await storedHead(excl.saleId);
      expect(si).toEqual(sx);
    }
  });

  it('nothing in a sale row or a sale response names the pricing direction', async () => {
    const sale = await ring('RETAIL', 'R-EQ-OPAQUE', [{ productId, qty: '2' }]);
    const json = JSON.stringify(sale).toLowerCase();
    expect(json).not.toContain('inclusive');
    expect(json).not.toContain('gross');

    const columns = await h.db.withTenant(tenantId, async (tx) =>
      tx.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'app' and table_name in ('sale','sale_line','sale_tax_line')`,
      ),
    );
    for (const c of columns.rows) expect(c.column_name).not.toContain('inclusive');
  });
});

describe('a historical sale de-grosses against ITS OWN business date', () => {
  it('2025-12-31 inverts the pre-2026 CASCADE, not today’s flat composition', async () => {
    const qty = '5';
    const gross = GROSS_UNIT_MINOR * 5n;
    const old = await ring('RETAIL', 'R-INC-2025', [{ productId, qty }], '2025-12-31');
    const now = await ring('RETAIL', 'R-INC-2026', [{ productId, qty }], '2026-01-01');

    const oldLine = old.lines[0]!;
    const nowLine = now.lines[0]!;
    const oldByCode = new Map(oldLine.taxLines.map((t) => [t.taxCode, t]));

    // The composition in force that day: COVID exists, and VAT sits on a base
    // that already carries the levies.
    expect(oldByCode.has('GH.COVID')).toBe(true);
    expect(oldByCode.get('GH.VAT.STD')!.baseKind).toBe('net_plus');
    expect(new Map(nowLine.taxLines.map((t) => [t.taxCode, t])).has('GH.COVID')).toBe(false);

    // 21.9% effective against 20% — the same shelf price, a materially
    // different net, with NO rate differing between the two regimes.
    expect(BigInt(oldLine.lineNetMinor)).toBeLessThan(BigInt(nowLine.lineNetMinor));

    // And both foot to the same quoted gross, exactly.
    for (const s of [old, now]) {
      expect(BigInt(s.totalMinor)).toBe(gross);
      const line = s.lines[0]!;
      const sum = line.taxLines.reduce((a, t) => a + BigInt(t.taxMinor), 0n);
      expect(BigInt(line.lineNetMinor) + sum).toBe(gross);
    }

    // VAT's base really is the cascaded one: net + the three levies.
    const levies = ['GH.NHIL', 'GH.GETFUND', 'GH.COVID'].reduce(
      (a, c) => a + BigInt(oldByCode.get(c)!.taxMinor),
      0n,
    );
    expect(BigInt(oldByCode.get('GH.VAT.STD')!.baseMinor)).toBe(
      BigInt(oldLine.lineNetMinor) + levies,
    );
  });

  it('recomputeCheck reproduces every de-grossed figure from the sale’s own snapshot', async () => {
    const sales = [
      await ring('RETAIL', 'R-INC-RC-A', [{ productId, qty: '3' }], '2025-11-20'),
      await ring('RETAIL', 'R-INC-RC-B', [{ productId, qty: '3' }], '2026-02-10'),
      await ring('RETAIL', 'R-INC-RC-C', [
        { productId, qty: '9', lineDiscountMinor: '777' },
        { productId: products[2]!.id, qty: '4' },
      ]),
      await ring('WHOLESALE', 'R-INC-RC-X', [{ productId, qty: '3' }]),
    ];
    for (const s of sales) {
      const check = await caller.sales.recomputeCheck({ saleId: s.saleId });
      expect(check.mismatches).toEqual([]);
      expect(check.matches).toBe(true);
    }
  });
});

describe('random carts on a tax-inclusive list: exact bigint identities', () => {
  it('Σ(line totals) + Σ(tax) === sale total, in the response AND in the database', async () => {
    const rng = makeRng(0x5eed_10c1);
    const dates = ['2025-03-05', '2025-12-31', '2026-01-01', '2026-07-19'];

    for (let cart = 0; cart < 16; cart += 1) {
      const lineCount = 1 + Math.floor(rng() * 6);
      const picks = Array.from({ length: lineCount }, () => {
        const idx = Math.floor(rng() * SHELF_PRICES_MINOR.length);
        const qtyN = BigInt(1 + Math.floor(rng() * 500));
        const shelf = SHELF_PRICES_MINOR[idx]!;
        const extended = shelf * qtyN;
        // A discount may not exceed the quoted gross (the API rejects that).
        const discount =
          extended >= 10n && rng() < 0.3 ? BigInt(1 + Math.floor(rng() * 9)) : 0n;
        return { idx, qtyN, extended, discount };
      });
      const businessDate = dates[Math.floor(rng() * dates.length)]!;

      const sale = await ring(
        'RETAIL',
        `R-INC-PROP-${cart}`,
        picks.map((p) => ({
          productId: products[p.idx]!.id,
          qty: String(p.qtyN),
          lineDiscountMinor: String(p.discount),
        })),
        businessDate,
      );

      // (1) Inside the response — and, per line, against the price the
      //     customer was quoted, which is the whole claim being made here.
      let net = 0n;
      let discount = 0n;
      let tax = 0n;
      for (let i = 0; i < sale.lines.length; i += 1) {
        const l = sale.lines[i]!;
        const p = picks[i]!;
        const componentSum = l.taxLines.reduce((s, t) => s + BigInt(t.taxMinor), 0n);
        expect(BigInt(l.taxMinor)).toBe(componentSum);
        for (const t of l.taxLines) {
          expect(BigInt(t.taxMinor)).toBe(BigInt(t.computedMinor) + BigInt(t.residualMinor));
        }
        expect(BigInt(l.lineNetMinor) - BigInt(l.lineDiscountMinor) + componentSum).toBe(
          p.extended - p.discount,
        );
        net += BigInt(l.lineNetMinor);
        discount += BigInt(l.lineDiscountMinor);
        tax += componentSum;
      }
      expect(BigInt(sale.subtotalNetMinor)).toBe(net);
      expect(BigInt(sale.discountMinor)).toBe(discount);
      expect(BigInt(sale.taxTotalMinor)).toBe(tax);
      expect(BigInt(sale.totalMinor)).toBe(net - discount + tax);
      expect(BigInt(sale.totalMinor)).toBe(
        picks.reduce((a, p) => a + p.extended - p.discount, 0n),
      );

      // (2) Against what the database stored, and (3) response ≡ rows.
      const stored = await storedHead(sale.saleId);
      expect(stored.lines).toBe(stored.subtotal);
      expect(stored.comptax).toBe(stored.tax);
      expect(BigInt(stored.subtotal) - BigInt(stored.discount) + BigInt(stored.tax)).toBe(
        BigInt(stored.total),
      );
      expect(sale.totalMinor).toBe(stored.total);

      // (4) And the server can still reproduce it from the snapshot alone.
      const check = await caller.sales.recomputeCheck({ saleId: sale.saleId });
      expect(check.mismatches).toEqual([]);
    }
  }, 180_000);
});
