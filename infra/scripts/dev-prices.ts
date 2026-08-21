/**
 * DEV-STACK PRICES — the second thing a bootstrapped tenant has none of.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THE STACK IS UNUSABLE WITHOUT THIS, AND WHY IT IS NOT TEMPLATE CONTENT
 * ════════════════════════════════════════════════════════════════════════════
 * `applyTemplate` seeds a tenant's price list STRUCTURE and deliberately seeds
 * no prices at all (packages/db/src/seed/template.ts): what a business charges
 * is the most tenant-owned number there is, it is commercially sensitive, and
 * a template that shipped one would be handing every new tenant somebody
 * else's margin. That rule is right and this file does not change it.
 *
 * The consequence for a DEV stack is a counter with 219 products, none of
 * which has a price, so nothing can be rung and nothing can be demonstrated.
 * The bootstrap already plays the onboarding operator for principals (step 5,
 * bootstrap.ts) for exactly the same reason; this is the same move for prices,
 * and it lives in infra/ — not in the seed package — so it can never be
 * mistaken for template data.
 *
 * WHAT THESE PRICES ARE. Deterministic fixtures, derived from a band per
 * top-level category and the sku code's hash, rounded to something a counter
 * would actually print. They are plausible, not real: `docs/source-of-truth/
 * skus.csv` carries no prices and the financial model carries only aggregates
 * (CLAUDE.md §2.10), so there is nothing to reproduce here and inventing
 * precision would be worse than being obviously synthetic. Same seed → same
 * prices on every `pnpm stack:reset`.
 *
 * Money is minor units end to end (ADR-0004): the bands below are pesewas and
 * the column is `unit_price_e4` — minor units per selling unit × 10⁴. Tenant
 * A's pack happens to have 100 minor units to the major unit; nothing here
 * assumes that of any other tenant, because nothing here converts.
 *
 * Writes take the ONE write path: a SERVER-origin `app.write_log` row first,
 * then the items, under the tenant's own RLS context. Idempotent by
 * construction — every id is derived, so a re-run inserts nothing.
 */
import {
  createHlcClock,
  deterministicUuid,
  hlcNodeFromName,
  sha256Hex,
  type SqlClient,
} from '@erp/db';

const SEED_NS = 'infra-dev-prices';

/**
 * Price bands in MINOR UNITS per selling unit, keyed by the top-level segment
 * of the template's category codes. A bag of cement and a box of screws do not
 * belong in the same band, and a demo where they do reads as broken.
 */
const BANDS: Readonly<Record<string, readonly [number, number]>> = {
  'CEMENT-AND-BINDERS': [4_000, 12_000],
  'AGGREGATES-BLOCKS-AND-MASONRY': [500, 9_000],
  'STEEL-AND-REINFORCEMENT': [6_000, 90_000],
  'TIMBER-AND-BOARDS': [3_000, 26_000],
  'ROOFING-AND-RAINWATER-GOODS': [4_500, 38_000],
  'PLUMBING-AND-SANITARY': [800, 55_000],
  'ELECTRICAL': [600, 45_000],
  'PAINTS-ADHESIVES-AND-SEALANTS': [1_500, 42_000],
  'DOORS-WINDOWS-AND-IRONMONGERY': [2_500, 120_000],
  'TILES-AND-FLOORING': [1_800, 16_000],
  'HARDWARE-AND-TOOLS': [700, 85_000],
  'SITE-CONSUMABLES-AND-MISC': [400, 14_000],
};
const DEFAULT_BAND: readonly [number, number] = [1_000, 20_000];

/** Round to something a price tag would carry, never below the band floor. */
function tidy(minor: number, floor: number): number {
  const step = minor >= 10_000 ? 500 : minor >= 2_000 ? 100 : 50;
  return Math.max(floor, Math.round(minor / step) * step);
}

/**
 * A stable price for one sku inside its band. The hash is the whole mechanism:
 * the same catalogue always produces the same shelf, so a screenshot taken
 * today still matches the stack tomorrow.
 */
export function devPriceMinor(skuCode: string, categoryCode: string): number {
  const top = categoryCode.split(':')[0] ?? '';
  const [lo, hi] = BANDS[top] ?? DEFAULT_BAND;
  const digest = sha256Hex(`${SEED_NS}:${skuCode}`);
  const position = Number.parseInt(digest.slice(0, 8), 16) / 0xffff_ffff;
  return tidy(lo + position * (hi - lo), lo);
}

/** The trade price the same sku carries on a wholesale list. */
function tradePriceMinor(retailMinor: number, floor: number): number {
  return tidy(retailMinor * 0.88, floor);
}

interface PricedProduct {
  readonly product_id: string;
  readonly sku_code: string;
  readonly category_code: string;
  readonly uom_id: string;
}

export interface DevPriceResult {
  readonly items: number;
  readonly lists: readonly string[];
  /** Lists this had to make tax-EXCLUSIVE to be sellable. See below. */
  readonly madeExclusive: readonly string[];
}

/**
 * Price every sellable product on every list this tenant has, in its default
 * selling unit — the same unit `sales.createSale` prices in when the wire
 * carries no `uomCode`, which is what a counter sends.
 */
export async function applyDevPrices(tx: SqlClient, tenantId: string): Promise<DevPriceResult> {
  const clock = createHlcClock(hlcNodeFromName(`${SEED_NS}:${tenantId}`));

  // ── THE TAX-INCLUSIVE GAP, STATED RATHER THAN PAPERED OVER ───────────────
  // Neither this client nor `sales.createSale` can ring a list whose shelf
  // prices already contain tax: nothing extracts tax back out of a gross
  // price, and both refuse rather than approximate it (ADR-0004 — rounding is
  // explicit at every boundary). The construction template marks its counter
  // list tax-inclusive, which is what a Ghanaian retail shelf price actually
  // is, so a bootstrapped dev tenant resolves to a list the platform cannot
  // sell from and the till stops at its price-list gate.
  //
  // A DEV DATABASE gets the flip so the counter runs. This is a fixture, not a
  // fix: the shipped template is untouched, `pnpm stack:reset` re-applies it
  // inclusive, and the real answer is inclusive-price support in the pricing
  // work-package (a jurisdiction question, not a data-entry one). When that
  // lands, delete this block — the loud line it prints is the reminder.
  const inclusive = await tx.query<{ id: string; code: string }>(
    `select id, code from app.price_list where deleted_at is null and is_tax_inclusive`,
  );
  for (const list of inclusive.rows) {
    await tx.query(
      `update app.price_list set is_tax_inclusive = false, updated_at = transaction_timestamp()
        where tenant_id = $1 and id = $2`,
      [tenantId, list.id],
    );
  }

  const lists = await tx.query<{ id: string; code: string }>(
    `select id, code from app.price_list where deleted_at is null order by priority, code`,
  );
  const products = await tx.query<PricedProduct>(
    `select p.id as product_id, p.sku_code, c.code as category_code, pu.uom_id
       from app.product p
       join app.product_category c on c.tenant_id = p.tenant_id and c.id = p.category_id
       join app.product_uom pu on pu.tenant_id = p.tenant_id and pu.product_id = p.id
                              and pu.is_default_sell and pu.can_sell and pu.deleted_at is null
      where p.deleted_at is null and p.is_sellable
      order by p.sku_code`,
  );

  let items = 0;
  for (const list of lists.rows) {
    // One write-spine row per list, the shape bootstrap.ts already uses for a
    // batch: nothing reaches an app table without its write_log row.
    const writeId = deterministicUuid(tenantId, SEED_NS, 'write', list.code);
    await tx.query(
      `insert into app.write_log
         (tenant_id, id, origin, hlc, op, schema_version, request_hash)
       values ($1, $2, 'SERVER', $3, 'dev-prices.apply', 1, decode($4, 'hex'))
       on conflict (tenant_id, id) do nothing`,
      [tenantId, writeId, clock.next(), sha256Hex(`${SEED_NS}:${tenantId}:${list.code}`)],
    );

    for (const p of products.rows) {
      const top = p.category_code.split(':')[0] ?? '';
      const floor = (BANDS[top] ?? DEFAULT_BAND)[0];
      const retail = devPriceMinor(p.sku_code, p.category_code);
      // Low priority wins at the counter (device-price-list.ts), so the
      // best-ranked list is the walk-in one and anything ranked below it is a
      // trade list. Naming no code keeps this tenant-agnostic.
      const minor = list.id === lists.rows[0]?.id ? retail : tradePriceMinor(retail, floor);
      const unitPriceE4 = (BigInt(minor) * 10_000n).toString(10);
      const result = await tx.query(
        `insert into app.price_list_item
           (tenant_id, id, write_id, hlc, price_list_id, product_id, uom_id,
            unit_price_e4, min_qty, effective_from)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 0, '2026-08-01'::date)
         -- Untargeted on purpose: the derived id is not the only way this row
         -- can already exist. price_list_item_uq also holds one price per
         -- (list, product, unit, min_qty, effective_from), and a drill or an
         -- earlier hand-seed may own that slot. A dev fixture never clobbers a
         -- price something else put there.
         on conflict do nothing
         returning id`,
        [
          tenantId,
          deterministicUuid(tenantId, SEED_NS, 'item', `${list.code}:${p.product_id}:${p.uom_id}`),
          writeId,
          clock.next(),
          list.id,
          p.product_id,
          p.uom_id,
          unitPriceE4,
        ],
      );
      items += result.rows.length;
    }
  }

  return {
    items,
    lists: lists.rows.map((l) => l.code),
    madeExclusive: inclusive.rows.map((l) => l.code),
  };
}
