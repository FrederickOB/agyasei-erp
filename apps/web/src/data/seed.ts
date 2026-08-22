/**
 * DEV-ONLY seed for local-only mode (no sync endpoint configured). In
 * production every one of these rows arrives through the sync stream from the
 * tenant's own configuration; nothing in this file is product behaviour.
 *
 * The CurrencySpec is a deliberate PLACEHOLDER: ISO test currency code and the
 * generic currency sign, so no real jurisdiction's symbol or scale is baked
 * into the client (§8.9, ADR-0007). The real spec is tenant configuration.
 */
import type { CurrencySpec } from '@erp/money';
import { uuidv7 } from '../lib/uuidv7';
import type { LocalDb } from './db';
import { CONFIG_KEY_CURRENCY_SPEC } from './queries/config';
import {
  CONFIG_KEY_LOCATION_CODE,
  CONFIG_KEY_LOCATION_ID,
  CONFIG_KEY_PRICE_LIST_ID,
} from './queries/session';

async function writeConfigValue(db: LocalDb, key: string, value: string): Promise<void> {
  await db.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
    uuidv7(),
    key,
    value,
  ]);
}

/** '¤' is the generic currency sign — a placeholder, never a real symbol. */
export const DEV_PLACEHOLDER_CURRENCY: CurrencySpec = {
  code: 'XTS', // ISO 4217 code reserved for testing
  symbol: '¤',
  scale: 2,
};

interface SeedProduct {
  readonly code: string;
  readonly name: string;
  readonly aliases: string;
  readonly category: string;
  readonly uomLabel: string;
  readonly qtyScale: number;
  /** minor units per selling unit × 10^4, as a decimal string (money stays out of `number`). */
  readonly unitPriceE4: string;
}

// Names and aliases are demo fixture data shaped like a builders'-merchant
// catalogue; aliases mirror how people actually ask at a counter (§8.7).
const DEV_PRODUCTS: readonly SeedProduct[] = [
  {
    code: 'CEM-425-50KG',
    name: 'Cement 42.5N 50kg bag',
    aliases: 'cement,opc,bag',
    category: 'Cement',
    uomLabel: 'bag',
    qtyScale: 0,
    unitPriceE4: '620000000', // 62000 minor units per bag
  },
  {
    code: 'REB-12-12M',
    name: 'Rebar 12mm x 12m length',
    aliases: 'half-inch rod,iron rod,rod,12mm',
    category: 'Steel',
    uomLabel: 'length',
    qtyScale: 0,
    unitPriceE4: '1850000000',
  },
  {
    code: 'WIRE-BIND-KG',
    name: 'Binding wire (per kg)',
    aliases: 'wire,tie wire',
    category: 'Steel',
    uomLabel: 'kg',
    qtyScale: 3, // sold in fractional kg: 2500n = 2.500 kg
    unitPriceE4: '97500000',
  },
  {
    code: 'SHEET-030',
    name: 'Roofing sheet 0.30mm',
    aliases: 'zinc,sheet',
    category: 'Roofing',
    uomLabel: 'sheet',
    qtyScale: 0,
    unitPriceE4: '480000000',
  },
  {
    code: 'TIM-2X3-12',
    name: 'Timber 2" x 3" x 12ft',
    aliases: '2x3,two by three',
    category: 'Timber',
    uomLabel: 'piece',
    qtyScale: 0,
    unitPriceE4: '150000000',
  },
];

/**
 * Ids are real UUIDs because the wire contract requires UUIDs: `locationId`
 * and `productId` are `z.string().uuid()`. The old `'dev-location'` /
 * `'dev-price-list'` placeholders could never have produced a payload the API
 * would accept, and nothing noticed — a dev seed that cannot round-trip
 * through the real contract is a rehearsal of the wrong play.
 *
 * They are also FIXED, not `uuidv7()` at module load. A value minted afresh on
 * every page load cannot be backfilled coherently: the id written into
 * `local_config` on Tuesday named no row that existed on Monday, so a device
 * that healed half of its configuration ended up pointing at nothing. Fixed
 * placeholders make this file idempotent — run it a hundred times and the
 * device converges on the same rows.
 *
 * Codes are neutral placeholders. A location code and a price-list code are
 * TENANT data; these are stand-ins for a device whose configuration has not
 * arrived, and carry no tenant's vocabulary (§8.9).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PLACEHOLDER PRICE LIST IS STRICTLY LOCAL-ONLY, AND HERE IS WHAT MAKES
 * IT SO.
 * ═══════════════════════════════════════════════════════════════════════════
 * `DEFAULT` is not a price list any tenant has. It exists so local-only mode
 * has something to price against with zero backend. It must NEVER be the list
 * a synced sale is priced against — a device that rings against it puts
 * `priceListCode: 'DEFAULT'` on the wire and the API answers
 * PRECONDITION_FAILED (`no price list DEFAULT in force`), so the counter
 * believes it sold and the sale is rejected hours later.
 *
 * What keeps it local-only is STRUCTURAL, not a convention: the row below is
 * written with `tenant_id = NULL`, and every row that arrives over the sync
 * stream carries one (`app.price_list.tenant_id` is `not null` server-side and
 * sync_rules.yaml selects `WHERE tenant_id = bucket.tenant_id`). Provisioning
 * only ever considers rows WITH a tenant_id — see
 * `data/session/device-price-list.ts` — so a device that holds a session
 * cannot resolve to this row, whatever its code or ranking.
 *
 * Do not give this row a tenant_id, and do not "fix" its NULL effective dates
 * by filling them in. Both are what disqualify it, deliberately.
 */
const DEV_PRICE_LIST_ID = '01900000-0000-7000-8000-000000000002';
const DEV_PRICE_LIST_CODE = 'DEFAULT';
const DEV_LOCATION_ID = '01900000-0000-7000-8000-000000000001';
const DEV_LOCATION_CODE = 'LOC1';

async function hasConfigKey(db: LocalDb, key: string): Promise<boolean> {
  const rows = await db.getAll('SELECT 1 AS hit FROM local_config WHERE key = ? LIMIT 1', [key]);
  return rows.length > 0;
}

/**
 * Adopt the placeholder row this seed already created on an earlier run, if it
 * is there, rather than minting a second one beside it.
 *
 * Matching is by CODE, not by id: a database created by an older build carries
 * a row with a randomly generated id, and its products' prices hang off that
 * row. Adopting it is what lets such a device sell after it heals; inserting a
 * fresh price list next to it would leave every seeded product priceless in
 * the list the device was pointed at.
 */
async function adoptOrInsert(
  db: LocalDb,
  table: 'location' | 'price_list',
  code: string,
  fallbackId: string,
  insert: (id: string) => Promise<void>,
): Promise<string> {
  const rows = await db.getAll(`SELECT id FROM ${table} WHERE code = ? LIMIT 1`, [code]);
  const existing = rows[0]?.['id'];
  if (typeof existing === 'string' && existing.length > 0) return existing;
  await insert(fallbackId);
  return fallbackId;
}

/**
 * DEV/LOCAL-ONLY BACKFILL — and the second half of the bug this file caused.
 *
 * The old guard was a single sentinel: if `currency_spec` was present the whole
 * config block was skipped. The location keys were added to this seed LATER, so
 * every device whose local database had been created by an earlier build — and
 * a browser's OPFS database outlives any number of rebuilds — could never
 * acquire them. It had a currency and no location, forever, and every checkout
 * was refused. That is the live symptom the user reported.
 *
 * So each key is now checked and inserted INDEPENDENTLY. Nothing is skipped on
 * behalf of anything else, and an older database heals on next load.
 *
 * Existing values are never overwritten: this is a floor under a device with
 * nothing, not an authority over a device with something. In sync mode the
 * session's location overwrites whatever this wrote — see main.tsx.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND ON A DEVICE THAT SYNCS, THIS SEED WRITES NO SYNCED TABLE AT ALL.
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FREEZE THIS RULE EXISTS FOR. `product`, `price`, `stock_snapshot`,
 * `location` and `price_list` are `localOnly: false` (data/schema.ts) — they
 * belong to the sync stream, and the device is a READER of them. A local
 * INSERT into one of those tables does two things at once: it enqueues a row
 * in PowerSync's own write queue (`ps_crud`) and it parks
 * `ps_buckets.$local.target_op` at MAX. The sync core then refuses to APPLY
 * any downloaded checkpoint for as long as that queue is non-empty.
 *
 * Our connector never drains that queue — every real write goes through the
 * local `outbox` to the API (data/sync/upload.ts), and PowerSync itself is
 * download-only here (infra/powersync/sync_rules.yaml). So a single seeded row
 * froze downloads permanently: the tenant's catalogue, its price lists, its
 * jurisdiction pack all streamed to the device and none of it was ever
 * applied. What a counter SAW was the price-list gate, forever — "still
 * receiving its price lists … leave it connected" — while the rows it was
 * waiting for sat undelivered a few bytes away. Nothing timed out, nothing
 * errored, and the device looked patient rather than broken.
 *
 * So in sync mode the only thing seeded is the placeholder CurrencySpec, which
 * lives in `local_config` — a local-only table, invisible to `ps_crud`. The
 * rest is provisioned by the reconcilers from the verified session and the
 * tenant's own synced configuration (data/session/*), which is where those
 * answers belong anyway. See `discardStrayCrud` (data/sync/crud-guard.ts) for
 * the backstop that keeps any future stray write from freezing a till again.
 */
export interface DevSeedOptions {
  /**
   * True when this device has a sync stack configured (`syncConfigured()`,
   * data/powersync.ts). Not "is this production": the question is whether a
   * local write to a synced table would be seen by PowerSync's write queue,
   * and the answer to that is exactly whether a sync stack is attached.
   */
  readonly syncConfigured?: boolean;
}

export async function seedDevDataIfEmpty(
  db: LocalDb,
  options: DevSeedOptions = {},
): Promise<void> {
  let wrote = false;

  if (!(await hasConfigKey(db, CONFIG_KEY_CURRENCY_SPEC))) {
    await writeConfigValue(db, CONFIG_KEY_CURRENCY_SPEC, JSON.stringify(DEV_PLACEHOLDER_CURRENCY));
    wrote = true;
  }

  if (options.syncConfigured === true) {
    // Everything below this line writes a SYNCED table, or points the device
    // at a row in one. Neither is this seed's business on a device whose
    // configuration is arriving from its tenant — see the block above.
    if (wrote) db.changes.notify();
    return;
  }

  // The synced rows the sale payload resolves against: the location gives the
  // receipt number its code and the sale its trading-day timezone; the price
  // list gives the API the CODE it prices by.
  const locationId = await adoptOrInsert(db, 'location', DEV_LOCATION_CODE, DEV_LOCATION_ID, async (id) => {
    await db.execute(
      `INSERT INTO location (id, tenant_id, code, name, kind, location_type_id, parent_id,
                             is_active, timezone, hlc, updated_at)
       VALUES (?, NULL, ?, ?, NULL, NULL, NULL, 1, ?, NULL, NULL)`,
      [id, DEV_LOCATION_CODE, 'Development counter', 'UTC'],
    );
    wrote = true;
  });
  const priceListId = await adoptOrInsert(db, 'price_list', DEV_PRICE_LIST_CODE, DEV_PRICE_LIST_ID, async (id) => {
    // tenant_id NULL and no effective window: the two things that make this
    // row invisible to provisioning in sync mode. See the block comment above
    // DEV_PRICE_LIST_ID before changing either.
    await db.execute(
      `INSERT INTO price_list (id, tenant_id, code, name, is_tax_inclusive, currency_code,
                               priority, location_id, effective_from, effective_to, hlc, updated_at)
       VALUES (?, NULL, ?, ?, 0, ?, 0, NULL, NULL, NULL, NULL, NULL)`,
      [id, DEV_PRICE_LIST_CODE, 'Development price list', DEV_PLACEHOLDER_CURRENCY.code],
    );
    wrote = true;
  });

  // Which location this device trades at, and which list it prices from. In
  // production BOTH are provisioned rather than guessed: the location from the
  // VERIFIED SESSION (data/session/device-location.ts), the price list from
  // the tenant's own configuration (data/session/device-price-list.ts). What
  // is written here is a floor under a device that has neither, and in sync
  // mode reconciliation replaces both — see main.tsx.
  for (const [key, value] of [
    [CONFIG_KEY_LOCATION_ID, locationId],
    [CONFIG_KEY_LOCATION_CODE, DEV_LOCATION_CODE],
    [CONFIG_KEY_PRICE_LIST_ID, priceListId],
  ] as const) {
    if (!(await hasConfigKey(db, key))) {
      await writeConfigValue(db, key, value);
      wrote = true;
    }
  }

  const products = await db.getAll('SELECT 1 AS hit FROM product LIMIT 1');
  if (products.length === 0) {
    // The SAME SHAPE the sync stream delivers — product ⋈ product_uom ⋈
    // unit_of_measure ⋈ price_list_item — because the counter's projection
    // reads that shape and only that shape (queries/products.ts). A seed that
    // wrote its own parallel columns is how a device ended up displaying five
    // demo products while holding its tenant's 219.
    await db.writeTransaction(async (tx) => {
      const uomIds = new Map<string, string>();
      const categoryIds = new Map<string, string>();

      for (const p of DEV_PRODUCTS) {
        let uomId = uomIds.get(p.uomLabel);
        if (uomId === undefined) {
          uomId = uuidv7();
          uomIds.set(p.uomLabel, uomId);
          await tx.execute(
            `INSERT INTO unit_of_measure (id, tenant_id, code, name, dimension, qty_scale,
                                          hlc, updated_at)
             VALUES (?, NULL, ?, ?, NULL, CAST(? AS INTEGER), NULL, NULL)`,
            [uomId, p.uomLabel.toUpperCase(), p.uomLabel, p.qtyScale],
          );
        }
        let categoryId = categoryIds.get(p.category);
        if (categoryId === undefined) {
          categoryId = uuidv7();
          categoryIds.set(p.category, categoryId);
          await tx.execute(
            `INSERT INTO product_category (id, tenant_id, code, name, parent_id, hlc, updated_at)
             VALUES (?, NULL, ?, ?, NULL, NULL, NULL)`,
            [categoryId, p.category.toUpperCase(), p.category],
          );
        }

        const productId = uuidv7();
        await tx.execute(
          `INSERT INTO product (id, tenant_id, sku_code, name, aliases, category_id,
                                stocking_uom_id, tax_code, stock_tracking,
                                is_sellable, is_purchasable, hlc, updated_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, 'STOCKED', 1, 1, NULL, NULL)`,
          [productId, p.code, p.name, p.aliases, categoryId, uomId],
        );
        await tx.execute(
          `INSERT INTO product_uom (id, tenant_id, product_id, uom_id, factor_num, factor_den,
                                    can_sell, can_buy, is_default_sell, tolerance_bp, sort_order,
                                    hlc, updated_at)
           VALUES (?, NULL, ?, ?, 1, 1, 1, 1, 1, 0, 0, NULL, NULL)`,
          [uuidv7(), productId, uomId],
        );
        await tx.execute(
          // Effective from long ago and never ending: a placeholder catalogue
          // that expired would take the offline rehearsal down on a date
          // nobody chose.
          `INSERT INTO price_list_item (id, tenant_id, price_list_id, product_id, uom_id,
                                        unit_price_e4, min_qty, effective_from, effective_to,
                                        hlc, updated_at)
           VALUES (?, NULL, ?, ?, ?, CAST(? AS INTEGER), 0, '2000-01-01', NULL, NULL, NULL)`,
          [uuidv7(), priceListId, productId, uomId, p.unitPriceE4],
        );
        await tx.execute(
          `INSERT INTO stock_snapshot (id, product_id, location_id, qty_scaled, as_of)
           VALUES (?, ?, ?, CAST(? AS INTEGER), ?)`,
          [
            uuidv7(),
            productId,
            locationId,
            (100n * 10n ** BigInt(p.qtyScale)).toString(),
            new Date().toISOString(),
          ],
        );
      }
    });
    wrote = true;
  }

  if (wrote) db.changes.notify();
}
