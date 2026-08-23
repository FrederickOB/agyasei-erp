/**
 * The units a product may be BOUGHT in, read from this device's own synced
 * rows — and the conversion that turns a supplier's unit into the stocking
 * unit the ledger is denominated in.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SAME `product_uom` MACHINERY SELLING USES, IN THE OPPOSITE DIRECTION
 * ═══════════════════════════════════════════════════════════════════════════
 * 04 §4.10 is explicit: a material bought by the tonne and stocked in sacks is
 * the same conversion problem as one stocked by the bar and sold by the tonne,
 * with the factors swapped. It would be absurd to solve it twice, and a second
 * solution is a second answer. So this reads `product_uom` — the same table
 * the counter's selling units come from — filtered on `can_buy` rather than
 * `can_sell`, and `toStockQty` below is `apps/api`'s own expression, digit for
 * digit.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A LOCAL READ WHEN EVERYTHING ELSE IN BUYING IS A SERVER READ
 * ---------------------------------------------------------------------------
 * `product`, `product_uom` and `unit_of_measure` are in the `tenant_reference`
 * sync bucket, so a partitioned device genuinely HOLDS them. That is what lets
 * a yard record a receipt with the tower down: the conversion, the scales and
 * the tolerance are all on the device, and the receipt payload can be built
 * and checked without asking anybody. Suppliers and orders are not synced, and
 * the receiving screen says so rather than pretending otherwise.
 *
 * Every factor and scale is a `bigint` or a digit count read through
 * `CAST(col AS TEXT)`, never a JS number carrying a magnitude (§8.3, ADR-0004).
 */
import { mulDiv } from '@erp/money';
import type { DbExecutor } from '../db';

export interface PurchaseUnit {
  /** `product_uom.uom_id` — what the wire calls `uomId` on a receipt line. */
  readonly uomId: string;
  readonly uomCode: string;
  readonly uomLabel: string;
  /** Digit count for the PURCHASE unit. Not a magnitude. */
  readonly buyScale: number;
  /** Stocking units per ONE purchase unit, exact, as the pair it really is. */
  readonly factorNum: bigint;
  readonly factorDen: bigint;
  /**
   * How far a counted quantity may sit from the computed conversion before
   * the server opens a review. Read so the screen can WARN before the write,
   * never to decide anything: the server re-derives it and is the authority.
   */
  readonly toleranceBp: bigint;
  readonly stockingUomId: string;
  readonly stockingUomCode: string;
  readonly stockScale: number;
}

export interface PurchasableProduct {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly stockingUomId: string;
  readonly stockingUomCode: string;
  readonly stockScale: number;
}

/**
 * Products this device may build a receipt line for.
 *
 * Two narrowings, each stopping a refusal the outbox would class RETRYABLE and
 * therefore retry rather than dead-letter (`data/sync/upload.ts`):
 *
 *  · `is_purchasable` — the server answers `PRECONDITION_FAILED: product … is
 *    not purchasable` otherwise;
 *  · at least one `can_buy` unit — without one there is no conversion into the
 *    stocking unit and `PRECONDITION_FAILED: unit … is not a buyable unit`
 *    is the only possible outcome.
 *
 * `stock_tracking` is deliberately NOT narrowed on: a receipt for a
 * non-stocked product is legal — it appends no movement and the server says so
 * — and refusing it here would make a real purchase unrecordable.
 */
export async function loadPurchasableProducts(db: DbExecutor): Promise<PurchasableProduct[]> {
  const rows = await db.getAll(
    `SELECT p.id, p.sku_code AS code, p.name,
            p.stocking_uom_id, su.code AS stocking_uom_code, su.qty_scale AS stock_scale
       FROM product p
       JOIN unit_of_measure su ON su.id = p.stocking_uom_id
      WHERE p.is_purchasable = 1
        AND EXISTS (SELECT 1 FROM product_uom pu
                     WHERE pu.product_id = p.id AND pu.can_buy = 1)
      ORDER BY p.name`,
  );
  return rows.map((row) => ({
    id: String(row['id']),
    code: String(row['code'] ?? ''),
    name: String(row['name']),
    stockingUomId: String(row['stocking_uom_id']),
    stockingUomCode: String(row['stocking_uom_code']),
    stockScale: Number(row['stock_scale']),
  }));
}

/** Every unit this product may be bought in, with its conversion snapshot. */
export async function loadPurchaseUnits(
  db: DbExecutor,
  productId: string,
): Promise<PurchaseUnit[]> {
  const rows = await db.getAll(
    `SELECT pu.uom_id,
            u.code AS uom_code,
            COALESCE(u.name, u.code) AS uom_label,
            u.qty_scale AS buy_scale,
            CAST(pu.factor_num AS TEXT) AS factor_num,
            CAST(pu.factor_den AS TEXT) AS factor_den,
            CAST(pu.tolerance_bp AS TEXT) AS tolerance_bp,
            p.stocking_uom_id,
            su.code AS stocking_uom_code,
            su.qty_scale AS stock_scale
       FROM product_uom pu
       JOIN unit_of_measure u ON u.id = pu.uom_id
       JOIN product p ON p.id = pu.product_id
       JOIN unit_of_measure su ON su.id = p.stocking_uom_id
      WHERE pu.product_id = ? AND pu.can_buy = 1
      ORDER BY pu.sort_order, u.code`,
    [productId],
  );
  return rows.map((row) => ({
    uomId: String(row['uom_id']),
    uomCode: String(row['uom_code']),
    uomLabel: String(row['uom_label']),
    buyScale: Number(row['buy_scale']),
    factorNum: BigInt(String(row['factor_num'])),
    factorDen: BigInt(String(row['factor_den'])),
    toleranceBp: BigInt(String(row['tolerance_bp'] ?? '0')),
    stockingUomId: String(row['stocking_uom_id']),
    stockingUomCode: String(row['stocking_uom_code']),
    stockScale: Number(row['stock_scale']),
  }));
}

/**
 * What the conversion SAYS entered the yard, in the stocking unit.
 *
 * Digit for digit the expression `apps/api/src/routers/receiving.ts` runs when
 * the receipt finally lands, and `apps/api/src/routers/procurement.ts` runs
 * when the order is priced: rounded ONCE, half-up, at the stocking scale
 * (04 §4.13 row 1). The point of matching it exactly is that the yard sees the
 * figure the server will compute — if the two disagreed, every line would look
 * like a variance the moment it uploaded.
 *
 * This is what the conversion says. It is NOT what was counted: those are two
 * facts, and the receipt carries both.
 */
export function toStockQty(qtyBuy: bigint, unit: PurchaseUnit): bigint {
  return mulDiv(
    qtyBuy,
    unit.factorNum * 10n ** BigInt(unit.stockScale),
    unit.factorDen * 10n ** BigInt(unit.buyScale),
    'half-up',
  );
}

/**
 * Is a counted quantity within the unit's stated tolerance of the computed
 * conversion?
 *
 * CROSS-MULTIPLIED, never a division — the same test the server runs.
 * Dividing first would round the deviation, and a tolerance authored as one
 * stocking unit of slack sits exactly on the boundary a rounded comparison
 * gets wrong.
 *
 * Advisory here and authoritative there: past this bound the server still
 * RECORDS the line — the goods are in the yard either way — and opens a
 * review. This function exists so the screen can say so before the tap, not
 * to decide anything.
 */
export function withinTolerance(counted: bigint, computed: bigint, toleranceBp: bigint): boolean {
  const deviation = counted > computed ? counted - computed : computed - counted;
  return deviation * 10000n <= toleranceBp * computed;
}
