/** Shared test fixtures. */
import type { ProductWithPrice } from '../../src/data/queries/products';
import { createClaimedHlcClock, type ClaimedHlcClock } from '../../src/lib/hlc';
import { uuidv7 } from '../../src/lib/uuidv7';
import type { LocalDb } from '../../src/data/db';

export const TEST_NODE = 'ab'.repeat(16);

export function fixedHlc(nowMs = 1_755_000_000_000): ClaimedHlcClock {
  return createClaimedHlcClock(TEST_NODE, () => nowMs);
}

export interface SeedProductInput {
  readonly code: string;
  readonly name: string;
  readonly aliases?: string;
  readonly category?: string;
  readonly uomLabel?: string;
  readonly qtyScale?: number;
  readonly unitPriceE4: bigint;
}

export async function seedProduct(db: LocalDb, input: SeedProductInput): Promise<ProductWithPrice> {
  const id = uuidv7();
  await db.execute(
    `INSERT INTO product (id, code, name, aliases, category, uom_label, qty_scale, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      id,
      input.code,
      input.name,
      input.aliases ?? null,
      input.category ?? null,
      input.uomLabel ?? 'each',
      input.qtyScale ?? 0,
    ],
  );
  await db.execute(
    `INSERT INTO price (id, product_id, price_list_id, unit_price_e4)
     VALUES (?, ?, 'test-list', CAST(? AS INTEGER))`,
    [uuidv7(), id, input.unitPriceE4.toString()],
  );
  return {
    id,
    code: input.code,
    name: input.name,
    aliases: input.aliases ?? null,
    category: input.category ?? null,
    uomLabel: input.uomLabel ?? 'each',
    qtyScale: input.qtyScale ?? 0,
    priceListId: 'test-list',
    unitPriceE4: input.unitPriceE4,
  };
}
