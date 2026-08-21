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

const DEV_PRICE_LIST_ID = 'dev-price-list';
const DEV_LOCATION_ID = 'dev-location';

export async function seedDevDataIfEmpty(db: LocalDb): Promise<void> {
  const config = await db.getAll('SELECT 1 AS hit FROM local_config WHERE key = ? LIMIT 1', [
    CONFIG_KEY_CURRENCY_SPEC,
  ]);
  const products = await db.getAll('SELECT 1 AS hit FROM product LIMIT 1');
  if (config.length > 0 && products.length > 0) return;

  await db.writeTransaction(async (tx) => {
    if (config.length === 0) {
      await tx.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
        uuidv7(),
        CONFIG_KEY_CURRENCY_SPEC,
        JSON.stringify(DEV_PLACEHOLDER_CURRENCY),
      ]);
    }
    if (products.length === 0) {
      for (const p of DEV_PRODUCTS) {
        const productId = uuidv7();
        await tx.execute(
          `INSERT INTO product (id, code, name, aliases, category, uom_label, qty_scale, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          [productId, p.code, p.name, p.aliases, p.category, p.uomLabel, p.qtyScale],
        );
        await tx.execute(
          `INSERT INTO price (id, product_id, price_list_id, unit_price_e4)
           VALUES (?, ?, ?, CAST(? AS INTEGER))`,
          [uuidv7(), productId, DEV_PRICE_LIST_ID, p.unitPriceE4],
        );
        await tx.execute(
          `INSERT INTO stock_snapshot (id, product_id, location_id, qty_scaled, as_of)
           VALUES (?, ?, ?, CAST(? AS INTEGER), ?)`,
          [
            uuidv7(),
            productId,
            DEV_LOCATION_ID,
            (100n * 10n ** BigInt(p.qtyScale)).toString(),
            new Date().toISOString(),
          ],
        );
      }
    }
  });
  db.changes.notify();
}
