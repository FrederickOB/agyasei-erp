/**
 * THE COUNTER CAN RING A TAX-INCLUSIVE PRICE LIST.
 *
 * The blocker this file closes, in one sentence: the pilot tenant's
 * best-ranked list quotes shelf prices that already contain tax, the client
 * refused to bind such a list at all, and its own arithmetic treated every
 * unit price as a NET one — so the till could not trade, and the drills only
 * passed because the dev stack flipped the list to tax-exclusive behind them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INVARIANT EVERY TEST BELOW SERVES (CLAUDE.md §2.7 category 1).
 * ═══════════════════════════════════════════════════════════════════════════
 *   net + Σ tax === gross, EXACTLY — and on an inclusive list `gross` is the
 *   shelf price extended by the quantity, to the minor unit.
 * Not to a tolerance. A shelf price is what the customer hands over; if the
 * parts do not sum to it, either the customer is short-changed or the books do
 * not reconcile.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY TWO COMPOSITIONS APPEAR IN EVERY SWEEP.
 * ═══════════════════════════════════════════════════════════════════════════
 * Extraction is not one division. The two component sets below are the two
 * real, dated shapes of ONE jurisdiction's regime: three charges on the same
 * net (an effective 20%), and the same three charges with the headline one
 * levied on a base that already contains the other two (an effective 21.9%).
 * NO RATE DIFFERS BETWEEN THEM. A de-grossing that divided by a constant, or
 * that read a rate rather than a composition, passes the first and fails the
 * second — so both run, from data, through the same code path, and nothing in
 * `src/` names either regime.
 */
import { comparePriceCheck, createSaleInput } from '@erp/contracts';
import { composeTaxFromNet, type TaxComponent } from '@erp/money';
import { describe, expect, it } from 'vitest';
import type { LocalDb } from '../src/data/db';
import { addProductToCart, createCart } from '../src/data/mutations/cart';
import { checkout, ShortTenderError } from '../src/data/mutations/checkout';
import { readCartPricingBasis } from '../src/data/pricing/cart-basis';
import {
  cartTotalMinor,
  priceCart,
  UNTAXED_BASIS,
  type CartPricingBasis,
} from '../src/data/pricing/cart-pricing';
import {
  parseBaseIncludes,
  rangeCoversDate,
  readTaxComponentsInForce,
} from '../src/data/pricing/tax-components';
import { getCartLines, type CartLineRow } from '../src/data/queries/cart';
import { loadActiveProducts } from '../src/data/queries/products';
import {
  CONFIG_KEY_LOCATION_CODE,
  CONFIG_KEY_LOCATION_ID,
  readActivePriceListId,
} from '../src/data/queries/session';
import { getRecordedSale } from '../src/data/queries/sales';
import { reconcileDevicePriceList } from '../src/data/session/device-price-list';
import { readPendingOps } from '../src/data/sync/upload';
import { uuidv7 } from '../src/lib/uuidv7';
import { ensureOpenTill, fixedHlc, seedProduct } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const TODAY = '2026-08-21';
const NOW = `${TODAY}T09:00:00.000Z`;
/** A date inside the PRIOR regime's window — nothing else about it matters. */
const LONG_AGO = '2024-03-05';
const LONG_AGO_NOW = `${LONG_AGO}T09:00:00.000Z`;

// ---------------------------------------------------------------------------
// Fixtures — pack rows exactly as the sync stream delivers them
// ---------------------------------------------------------------------------

interface RateFixture {
  readonly code: string;
  readonly rateBp: number;
  readonly baseKind: 'net' | 'net_plus';
  readonly baseIncludes?: string;
  readonly from: string;
  readonly to?: string | null;
  readonly roundingLevel?: 'line' | 'document';
  readonly roundingMode?: string;
}

/**
 * The wire shape: `effective` is the pack's own half-open daterange serialised,
 * `base_includes` its array column serialised. Both are text on the device and
 * neither is invented here — the seed writes what `platform.tax_rate` holds.
 */
async function seedRate(db: LocalDb, rate: RateFixture): Promise<void> {
  const effective = rate.to === undefined || rate.to === null
    ? `[${rate.from},)`
    : `[${rate.from},${rate.to})`;
  await db.execute(
    `INSERT INTO tax_rate (id, jurisdiction_code, tax_code, rate_bp, base_kind, base_includes,
                           rounding_level, rounding_mode, effective, legal_reference,
                           confirmed_by, confirmed_at)
     VALUES (?, 'XX', ?, CAST(? AS INTEGER), ?, ?, ?, ?, ?, 'a statute', NULL, NULL)`,
    [
      uuidv7(),
      rate.code,
      String(rate.rateBp),
      rate.baseKind,
      rate.baseIncludes ?? '{}',
      rate.roundingLevel ?? 'line',
      rate.roundingMode ?? 'half_up',
      effective,
    ],
  );
}

/** Three charges on the SAME net — an effective 20%, current regime shape. */
async function seedFlatRegime(db: LocalDb): Promise<void> {
  await seedRate(db, { code: 'A.LEVY1', rateBp: 250, baseKind: 'net', from: '2026-01-01' });
  await seedRate(db, { code: 'A.LEVY2', rateBp: 250, baseKind: 'net', from: '2026-01-01' });
  await seedRate(db, { code: 'A.STD', rateBp: 1500, baseKind: 'net', from: '2026-01-01' });
}

/**
 * The SAME three rates, with the headline charge on a base that already
 * contains the other two — an effective 21.9%. Closed before the flat regime
 * opens, so a sale dated inside this window reprices against it.
 */
async function seedCascadeRegime(db: LocalDb): Promise<void> {
  await seedRate(db, {
    code: 'A.LEVY1', rateBp: 250, baseKind: 'net', from: '2019-01-01', to: '2026-01-01',
  });
  await seedRate(db, {
    code: 'A.LEVY2', rateBp: 250, baseKind: 'net', from: '2019-01-01', to: '2026-01-01',
  });
  await seedRate(db, {
    code: 'A.STD',
    rateBp: 1500,
    baseKind: 'net_plus',
    baseIncludes: '{A.LEVY1,A.LEVY2}',
    from: '2019-01-01',
    to: '2026-01-01',
  });
}

async function seedLocation(db: LocalDb, timeZone = 'UTC'): Promise<string> {
  const id = uuidv7();
  await db.execute(
    `INSERT INTO location (id, tenant_id, code, name, kind, location_type_id, parent_id,
                           is_active, timezone, hlc, updated_at)
     VALUES (?, ?, 'C-1', 'A counter', NULL, NULL, NULL, 1, ?, NULL, NULL)`,
    [id, uuidv7(), timeZone],
  );
  for (const [key, value] of [
    [CONFIG_KEY_LOCATION_ID, id],
    [CONFIG_KEY_LOCATION_CODE, 'C-1'],
  ] as const) {
    await db.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
      uuidv7(),
      key,
      value,
    ]);
  }
  return id;
}

async function seedList(
  db: LocalDb,
  opts: { code: string; inclusive: boolean; priority?: number },
): Promise<string> {
  const id = uuidv7();
  await db.execute(
    `INSERT INTO price_list (id, tenant_id, code, name, is_tax_inclusive, currency_code,
                             priority, location_id, effective_from, effective_to, hlc, updated_at)
     VALUES (?, ?, ?, ?, CAST(? AS INTEGER), 'XTS', CAST(? AS INTEGER), NULL,
             '2019-01-01', NULL, NULL, NULL)`,
    [id, uuidv7(), opts.code, `The ${opts.code} list`, opts.inclusive ? '1' : '0',
     String(opts.priority ?? 10)],
  );
  return id;
}

/** A cart line, without a database — the arithmetic under test needs no rows. */
function line(unitPriceE4: bigint, qtyScaled: bigint, qtyScale = 0): CartLineRow {
  return {
    id: uuidv7(),
    cartId: 'c',
    seq: 1,
    productId: uuidv7(),
    name: 'A product',
    uomLabel: 'each',
    qtyScale,
    qtyScaled,
    unitPriceE4,
  };
}

/** Shelf price in minor units -> the e4 unit price the catalogue carries. */
const shelf = (minor: bigint): bigint => minor * 10_000n;

const FLAT: readonly TaxComponent[] = [
  { code: 'A.LEVY1', rateBp: 250n, baseKind: 'net', baseIncludes: [], roundingLevel: 'line', roundingMode: 'half-up' },
  { code: 'A.LEVY2', rateBp: 250n, baseKind: 'net', baseIncludes: [], roundingLevel: 'line', roundingMode: 'half-up' },
  { code: 'A.STD', rateBp: 1500n, baseKind: 'net', baseIncludes: [], roundingLevel: 'line', roundingMode: 'half-up' },
];

const CASCADE: readonly TaxComponent[] = [
  FLAT[0]!,
  FLAT[1]!,
  { code: 'A.STD', rateBp: 1500n, baseKind: 'net_plus', baseIncludes: ['A.LEVY1', 'A.LEVY2'], roundingLevel: 'line', roundingMode: 'half-up' },
];

const inclusive = (components: readonly TaxComponent[]): CartPricingBasis => ({
  isTaxInclusive: true,
  components,
});
const exclusive = (components: readonly TaxComponent[]): CartPricingBasis => ({
  isTaxInclusive: false,
  components,
});

// ---------------------------------------------------------------------------
// Reading the pack off the device
// ---------------------------------------------------------------------------

describe('the tax components this device holds', () => {
  it('reads the rows in force and orders them the way the server does', async () => {
    const db = openTestDb();
    await seedCascadeRegime(db);
    await seedFlatRegime(db);

    const set = await readTaxComponentsInForce(db, TODAY);

    expect(set.problem).toBeNull();
    // Only the CURRENT regime is in force today, and every 'net' component
    // computes before any 'net_plus' one that would fold it into its base.
    expect(set.components.map((c) => c.code)).toEqual(['A.LEVY1', 'A.LEVY2', 'A.STD']);
    expect(set.components.map((c) => c.baseKind)).toEqual(['net', 'net', 'net']);
    expect(set.components.map((c) => c.rateBp)).toEqual([250n, 250n, 1500n]);
  });

  it('reprices a HISTORICAL day against the row in force on that day', async () => {
    // The whole reason composition is data: the prior regime cascades, the
    // current one does not, and NO RATE CHANGED between them.
    const db = openTestDb();
    await seedCascadeRegime(db);
    await seedFlatRegime(db);

    const then = await readTaxComponentsInForce(db, LONG_AGO);
    const now = await readTaxComponentsInForce(db, TODAY);

    expect(then.components.map((c) => c.baseKind)).toEqual(['net', 'net', 'net_plus']);
    expect(then.components.at(-1)?.baseIncludes).toEqual(['A.LEVY1', 'A.LEVY2']);
    expect(now.components.at(-1)?.baseKind).toBe('net');
    // Identical rates, different composition — the point of the exercise.
    expect(then.components.map((c) => c.rateBp)).toEqual(now.components.map((c) => c.rateBp));
  });

  it('treats a day outside every window as no components, without a fault', async () => {
    const db = openTestDb();
    await seedCascadeRegime(db);

    const set = await readTaxComponentsInForce(db, '2018-06-01');

    expect(set.components).toEqual([]);
    expect(set.problem).toBeNull();
  });

  it('refuses to guess at a rounding vocabulary it does not know, and does not throw', async () => {
    const db = openTestDb();
    await seedRate(db, {
      code: 'A.STD', rateBp: 1500, baseKind: 'net', from: '2019-01-01', roundingMode: 'banker',
    });

    const set = await readTaxComponentsInForce(db, TODAY);

    expect(set.components).toEqual([]);
    expect(set.problem).toContain('A.STD');
  });

  it('accepts the three encodings base_includes can arrive in', () => {
    expect(parseBaseIncludes('{A.LEVY1,A.LEVY2}')).toEqual(['A.LEVY1', 'A.LEVY2']);
    expect(parseBaseIncludes('["A.LEVY1","A.LEVY2"]')).toEqual(['A.LEVY1', 'A.LEVY2']);
    expect(parseBaseIncludes('A.LEVY1,A.LEVY2')).toEqual(['A.LEVY1', 'A.LEVY2']);
    expect(parseBaseIncludes('{}')).toEqual([]);
    expect(parseBaseIncludes(null)).toEqual([]);
  });

  it('reads the pack’s half-open window exactly, so a lapse day is not a trading day', () => {
    expect(rangeCoversDate('[2026-01-01,)', '2026-01-01')).toBe(true);
    expect(rangeCoversDate('[2026-01-01,)', '2025-12-31')).toBe(false);
    expect(rangeCoversDate('[2019-01-01,2026-01-01)', '2025-12-31')).toBe(true);
    // EXCLUSIVE upper bound: the day a regime ends is the first day it does not apply.
    expect(rangeCoversDate('[2019-01-01,2026-01-01)', '2026-01-01')).toBe(false);
    expect(rangeCoversDate('nonsense', '2026-01-01')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE INVARIANT
// ---------------------------------------------------------------------------

describe('an inclusive cart totals to the shelf price', () => {
  it('charges shelf price × quantity, exactly, for every quantity', () => {
    for (const components of [FLAT, CASCADE]) {
      for (const price of [1n, 7n, 99n, 1_250n, 620_000n, 999_999_999n]) {
        for (const qty of [1n, 2n, 3n, 7n, 13n, 250n]) {
          const total = cartTotalMinor([line(shelf(price), qty)], inclusive(components));
          expect(total).toBe(price * qty);
        }
      }
    }
  });

  it('splits that shelf price into parts that sum back to it, to the minor unit', () => {
    // A sweep, not three examples: every gross from 0 to 400 and a spread of
    // larger ones, under both compositions. The identity is not "close".
    const grosses: bigint[] = [];
    for (let g = 0n; g <= 400n; g++) grosses.push(g);
    for (const g of [1_001n, 12_345n, 620_000n, 7_000_003n, 123_456_789n]) grosses.push(g);

    for (const components of [FLAT, CASCADE]) {
      for (const gross of grosses) {
        const pricing = priceCart([line(shelf(gross), 1n)], inclusive(components));
        expect(pricing.grossMinor).toBe(gross);
        const breakdown = pricing.breakdown;
        expect(breakdown).not.toBeNull();
        if (breakdown === null) continue;
        const taxSum = breakdown.taxes.reduce((a, t) => a + t.taxMinor, 0n);
        expect(taxSum).toBe(breakdown.taxTotalMinor);
        expect(breakdown.netMinor + taxSum).toBe(gross);
        expect(breakdown.grossMinor).toBe(gross);
        // Never negative, and never a net larger than the price on the shelf.
        expect(breakdown.netMinor >= 0n).toBe(true);
        expect(breakdown.netMinor <= gross).toBe(true);
      }
    }
  });

  it('foots a MULTI-LINE cart to the sum of its shelf prices', () => {
    const lines = [line(shelf(1_299n), 3n), line(shelf(45n), 7n), line(shelf(620_000n), 1n)];
    const expected = 1_299n * 3n + 45n * 7n + 620_000n;

    for (const components of [FLAT, CASCADE]) {
      const pricing = priceCart(lines, inclusive(components));
      expect(pricing.grossMinor).toBe(expected);
      const breakdown = pricing.breakdown!;
      expect(breakdown.netMinor + breakdown.taxTotalMinor).toBe(expected);
      // The document tax total is the SUM of the once-rounded LINE amounts
      // (§4.13 row 5), never a recompute against the document base.
      const perLine = lines.map((l) => priceCart([l], inclusive(components)).breakdown!);
      expect(breakdown.taxTotalMinor).toBe(perLine.reduce((a, b) => a + b.taxTotalMinor, 0n));
      expect(breakdown.netMinor).toBe(perLine.reduce((a, b) => a + b.netMinor, 0n));
    }
  });

  it('inverts the COMPOSITION, not a rate: same total, different split', () => {
    // Identical rates in both sets. If extraction divided by a rate, or by a
    // constant, these two would agree — and one of them would be wrong.
    const cart = [line(shelf(120_000n), 1n)];

    const flat = priceCart(cart, inclusive(FLAT)).breakdown!;
    const cascade = priceCart(cart, inclusive(CASCADE)).breakdown!;

    expect(flat.grossMinor).toBe(120_000n);
    expect(cascade.grossMinor).toBe(120_000n);
    expect(flat.netMinor).not.toBe(cascade.netMinor);
    // The cascade takes MORE tax out of the same shelf price, because its
    // headline charge sits on a bigger base.
    expect(cascade.taxTotalMinor > flat.taxTotalMinor).toBe(true);
    expect(flat.netMinor + flat.taxTotalMinor).toBe(120_000n);
    expect(cascade.netMinor + cascade.taxTotalMinor).toBe(120_000n);
  });

  it('reports every component the pack declares, in the pack’s order', () => {
    const pricing = priceCart([line(shelf(100_000n), 2n)], inclusive(CASCADE));

    expect(pricing.breakdown!.taxes.map((t) => t.code)).toEqual(['A.LEVY1', 'A.LEVY2', 'A.STD']);
  });

  it('is zero for an empty cart, under any composition', () => {
    expect(cartTotalMinor([], inclusive(CASCADE))).toBe(0n);
    expect(cartTotalMinor([], exclusive(FLAT))).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// The other direction, and the agreement between them
// ---------------------------------------------------------------------------

describe('a tax-exclusive cart', () => {
  it('adds the tax the pack declares, so the total is still what the customer pays', () => {
    const pricing = priceCart([line(shelf(100_000n), 1n)], exclusive(FLAT));
    const expected = composeTaxFromNet(100_000n, FLAT);

    expect(pricing.breakdown!.netMinor).toBe(100_000n);
    expect(pricing.grossMinor).toBe(expected.grossMinor);
    expect(pricing.grossMinor).toBe(120_000n);
  });

  it('agrees EXACTLY with the same sale rung off a gross list', () => {
    // The same goods, the same pack, one list quoting net and one quoting the
    // gross that net composes to. A customer must pay the same either way, and
    // the component amounts must match line for line.
    for (const components of [FLAT, CASCADE]) {
      for (const net of [1n, 37n, 4_999n, 100_000n, 987_654n]) {
        const fromNet = priceCart([line(shelf(net), 1n)], exclusive(components)).breakdown!;
        const fromGross = priceCart(
          [line(shelf(fromNet.grossMinor), 1n)],
          inclusive(components),
        ).breakdown!;

        expect(fromGross.grossMinor).toBe(fromNet.grossMinor);
        expect(fromGross.netMinor).toBe(net);
        expect(fromGross.taxes.map((t) => t.taxMinor)).toEqual(
          fromNet.taxes.map((t) => t.taxMinor),
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// A device with no pack rows still trades
// ---------------------------------------------------------------------------

describe('when this device cannot state the split', () => {
  it('still charges the shelf price and reports no breakdown, rather than a zero one', () => {
    const pricing = priceCart([line(shelf(4_500n), 2n)], inclusive([]));

    expect(pricing.grossMinor).toBe(9_000n);
    // Not `taxTotalMinor: 0n`: a zero tax line is a filing CLAIM this device
    // has no basis for. Absent is the honest answer.
    expect(pricing.breakdown).toBeNull();
  });

  it('leaves the neutral basis behaving exactly as the counter always did', () => {
    const lines = [line(shelf(1_250n), 4n), line(shelf(99n), 1n)];

    expect(cartTotalMinor(lines, UNTAXED_BASIS)).toBe(1_250n * 4n + 99n);
    expect(cartTotalMinor(lines)).toBe(1_250n * 4n + 99n);
  });

  it('does not blow up a till over a pack it cannot compose with', () => {
    // `base_includes` naming a LATER component is an evaluation-order error the
    // pack's own publish-time assertions reject. If one reaches a device
    // anyway, the counter keeps trading and the split goes unstated.
    const broken: readonly TaxComponent[] = [
      { code: 'A.STD', rateBp: 1500n, baseKind: 'net_plus', baseIncludes: ['A.LEVY1'], roundingLevel: 'line', roundingMode: 'half-up' },
      { code: 'A.LEVY1', rateBp: 250n, baseKind: 'net', baseIncludes: [], roundingLevel: 'line', roundingMode: 'half-up' },
    ];

    const pricing = priceCart([line(shelf(5_000n), 1n)], inclusive(broken));

    expect(pricing.grossMinor).toBe(5_000n);
    expect(pricing.breakdown).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End to end at the counter
// ---------------------------------------------------------------------------

/** A bearer shaped like the API's. Only its PRESENCE is read here. */
function devBearer(): string {
  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    tid: uuidv7(),
    uid: uuidv7(),
    role: 'a tenant-defined role',
    locs: [],
  })}.not-a-real-signature`;
}

describe('a counter selling from an inclusive list', () => {
  async function counter(): Promise<{ db: LocalDb; listId: string }> {
    const db = openTestDb();
    await seedLocation(db);
    await seedFlatRegime(db);
    await seedCascadeRegime(db);
    const listId = await seedList(db, { code: 'RETAIL', inclusive: true, priority: 10 });
    await seedList(db, { code: 'WHOLESALE', inclusive: false, priority: 20 });
    await seedProduct(db, {
      code: 'P-1',
      name: 'A product',
      unitPriceE4: shelf(62_000n),
      priceListId: listId,
    });
    return { db, listId };
  }

  it('binds the inclusive list and prices the cart at the shelf price', async () => {
    const { db, listId } = await counter();

    const state = await reconcileDevicePriceList(db, devBearer(), NOW);
    expect(state.status).toBe('provisioned');
    expect(state.priceListId).toBe(listId);
    expect(await readActivePriceListId(db)).toBe(listId);

    const products = await loadActiveProducts(db);
    const cartId = await createCart(db, { nowIso: NOW });
    await addProductToCart(db, cartId, products[0]!);
    await addProductToCart(db, cartId, products[0]!);
    const lines = await getCartLines(db, cartId);

    const basis = await readCartPricingBasis(db, listId, NOW);
    const pricing = priceCart(lines, basis);

    expect(basis.isTaxInclusive).toBe(true);
    expect(pricing.grossMinor).toBe(124_000n);
    expect(pricing.breakdown!.netMinor + pricing.breakdown!.taxTotalMinor).toBe(124_000n);
  });

  it('records the shelf price as the sale total and claims it on the wire', async () => {
    const { db } = await counter();
    await reconcileDevicePriceList(db, devBearer(), NOW);

    const products = await loadActiveProducts(db);
    const cartId = await createCart(db, { nowIso: NOW });
    await addProductToCart(db, cartId, products[0]!);
    await ensureOpenTill(db, TODAY);
    const result = await checkout(db, {
      cartId,
      tenderedMinor: 100_000n,
      hlc: fixedHlc(),
      nowIso: NOW,
    });

    // What the customer hands over — the price on the shelf — is what the
    // receipt shows and what the outbox stores.
    expect(result.totalMinor).toBe(62_000n);
    expect(result.changeMinor).toBe(38_000n);
    const sale = await getRecordedSale(db, cartId);
    expect(sale?.totalMinor).toBe(62_000n);

    const payload = JSON.parse((await readPendingOps(db))[0]!.payloadJson) as Record<string, unknown>;
    expect(createSaleInput.safeParse(payload).success).toBe(true);
    expect(payload['priceListCode']).toBe('RETAIL');
    // The till's BELIEF, in the one field the contract defines for it.
    expect(payload['clientTotalMinor']).toBe('62000');
  });

  it('refuses a tender short of the SHELF price, not short of the net', async () => {
    // The bug this guards: with the old arithmetic the amount due on an
    // inclusive list would have been the net, and a cashier could complete a
    // sale having taken less than the price on the shelf.
    const { db } = await counter();
    await reconcileDevicePriceList(db, devBearer(), NOW);
    const products = await loadActiveProducts(db);
    const cartId = await createCart(db, { nowIso: NOW });
    await addProductToCart(db, cartId, products[0]!);

    await ensureOpenTill(db, TODAY);
    await expect(
      checkout(db, { cartId, tenderedMinor: 61_999n, hlc: fixedHlc(), nowIso: NOW }),
    ).rejects.toBeInstanceOf(ShortTenderError);
  });

  it('taxes a BACKDATED sale against the regime in force on its own day', async () => {
    const { db, listId } = await counter();

    const today = await readCartPricingBasis(db, listId, NOW);
    const then = await readCartPricingBasis(db, listId, LONG_AGO_NOW);
    const cart = [line(shelf(120_000n), 1n)];

    // Same shelf price, same customer payment, different split — because the
    // day decides the composition (07 §7.2.4), and nothing else does.
    expect(priceCart(cart, today).grossMinor).toBe(120_000n);
    expect(priceCart(cart, then).grossMinor).toBe(120_000n);
    expect(priceCart(cart, then).breakdown!.netMinor).not.toBe(
      priceCart(cart, today).breakdown!.netMinor,
    );
  });
});

// ---------------------------------------------------------------------------
// The other convention, end to end — and the divergence this closes
// ---------------------------------------------------------------------------

describe('a counter selling from an EXCLUSIVE list', () => {
  it('records what the customer pays, tax included, not the net', async () => {
    // THE OTHER HALF OF THE SAME BUG. The counter's total used to be the sum
    // of the net line amounts, while the server's repriced `total` is net less
    // discount PLUS tax. So every taxed sale from a tax-exclusive list shipped
    // a `clientTotalMinor` that was short by exactly the tax — a divergence
    // reported on every single sale, which is a detector that detects nothing,
    // and an amount due at the tender panel that was less than the customer
    // owed. Both sides now compute the gross.
    const db = openTestDb();
    await seedLocation(db);
    await seedFlatRegime(db);
    const listId = await seedList(db, { code: 'TRADE', inclusive: false, priority: 10 });
    await seedProduct(db, {
      code: 'P-1', name: 'A product', unitPriceE4: shelf(100_000n), priceListId: listId,
    });
    await reconcileDevicePriceList(db, devBearer(), NOW);

    const products = await loadActiveProducts(db);
    const cartId = await createCart(db, { nowIso: NOW });
    await addProductToCart(db, cartId, products[0]!);
    await ensureOpenTill(db, TODAY);
    const result = await checkout(db, {
      cartId, tenderedMinor: 120_000n, hlc: fixedHlc(), nowIso: NOW,
    });

    // 100,000 net + 20,000 tax, composed from the pack rows on this device —
    // the same arithmetic, from the same declaration, the server will run.
    expect(result.totalMinor).toBe(120_000n);
    expect(result.changeMinor).toBe(0n);
    const payload = JSON.parse((await readPendingOps(db))[0]!.payloadJson) as Record<string, unknown>;
    expect(payload['clientTotalMinor']).toBe('120000');
    expect(createSaleInput.safeParse(payload).success).toBe(true);
  });

  it('still totals the plain extension when this device holds no pack rows', async () => {
    // The offline rehearsal and any device still receiving its pack: no rows,
    // no invented rate, no refusal — the counter trades and the server settles.
    const db = openTestDb();
    await seedLocation(db);
    const listId = await seedList(db, { code: 'TRADE', inclusive: false, priority: 10 });
    await seedProduct(db, {
      code: 'P-1', name: 'A product', unitPriceE4: shelf(100_000n), priceListId: listId,
    });
    await reconcileDevicePriceList(db, devBearer(), NOW);

    const products = await loadActiveProducts(db);
    const cartId = await createCart(db, { nowIso: NOW });
    await addProductToCart(db, cartId, products[0]!);
    await ensureOpenTill(db, TODAY);
    const result = await checkout(db, {
      cartId, tenderedMinor: 100_000n, hlc: fixedHlc(), nowIso: NOW,
    });

    expect(result.totalMinor).toBe(100_000n);
  });
});

// ---------------------------------------------------------------------------
// The server is still the pricing authority
// ---------------------------------------------------------------------------

describe('the price check the client’s total feeds', () => {
  it('reports a divergence between the till’s claim and the server’s figure', async () => {
    const db = openTestDb();
    await seedLocation(db);
    await seedFlatRegime(db);
    const listId = await seedList(db, { code: 'RETAIL', inclusive: true, priority: 10 });
    await seedProduct(db, {
      code: 'P-1', name: 'A product', unitPriceE4: shelf(62_000n), priceListId: listId,
    });
    await reconcileDevicePriceList(db, devBearer(), NOW);
    const products = await loadActiveProducts(db);
    const cartId = await createCart(db, { nowIso: NOW });
    await addProductToCart(db, cartId, products[0]!);
    await ensureOpenTill(db, TODAY);
    await checkout(db, { cartId, tenderedMinor: 62_000n, hlc: fixedHlc(), nowIso: NOW });

    const payload = JSON.parse((await readPendingOps(db))[0]!.payloadJson) as Record<string, unknown>;
    const claimed = BigInt(String(payload['clientTotalMinor']));

    // A device days offline against a superseded list: the server reprices and
    // its figure WINS. The divergence is reported, never obeyed, never
    // swallowed — and one minor unit of it is a divergence.
    const stale = comparePriceCheck(claimed, 63_000n);
    expect(stale.matches).toBe(false);
    expect(stale.deltaMinor).toBe('1000');
    expect(stale.serverTotalMinor).toBe('63000');
    expect(stale.clientTotalMinor).toBe('62000');

    // And when the two agree — which is what an inclusive list ringing
    // correctly now produces — it says so.
    expect(comparePriceCheck(claimed, 62_000n).matches).toBe(true);
  });
});
