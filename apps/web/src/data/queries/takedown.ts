/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TAKE-DOWN — the only thing about buying this device keeps, and the
 * rules that make keeping it honest rather than a stale figure
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `app.purchase_order` and `app.supplier` are in NO sync bucket. A yard in a
 * district town is offline for days, the truck arrives anyway, and CLAUDE.md
 * §2.2 is unambiguous that the location must be able to record what physically
 * happened. `goods.record_receipt` is registered as a device-uploadable
 * operation for exactly that reason — but a receipt names a supplier and,
 * usually, an order, and neither is on the device.
 *
 * So the yard TAKES THE ORDERS DOWN while it has a connection, exactly as it
 * would take a printed copy out to the gate, and the receipt it writes against
 * that copy is queued locally and drains later. This module is that copy.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR RULES THAT KEEP IT FROM BECOMING A LIE
 * ---------------------------------------------------------------------------
 * 1. **It is stamped, and the stamp is rendered.** Every screen that shows a
 *    taken-down order shows the minute it was taken and says it is a copy.
 *    §8.4's rule is that a stale figure must never be shown AS CURRENT; a
 *    document labelled with the moment it was taken is not a current figure,
 *    it is a document. Nothing derived from it is ever labelled "now".
 * 2. **It holds no figure that is only true on the server.** Ordered
 *    quantities, units and conversions are properties OF THE ORDER and do not
 *    change once it is approved (0008 freezes the lines). `qtyOutstanding` is
 *    the one field that CAN move behind the yard's back — another receipt
 *    against the same order — so it is carried explicitly as
 *    `qtyOutstandingAtTakeDown` and is never spelled "outstanding" in a
 *    component. The server recomputes it at apply time and is the authority.
 * 3. **It is keyed to the location this device is bound to.** A take-down for
 *    another yard is discarded, not used, exactly as the permission cache
 *    discards another user's grants.
 * 4. **It authorises nothing.** `goods.receive` at the receiving location is
 *    checked by the server on every drain, days later, from the database.
 *
 * All magnitudes are stored as DECIMAL STRINGS and parsed with the shared
 * `deserializeMoney` on the way out, so a corrupt cache is a loud refusal
 * rather than a `NaN` in a quantity (ADR-0004).
 */
import { deserializeMoney } from '@erp/money';
import { uuidv7 } from '../../lib/uuidv7';
import type { DbExecutor, LocalDb } from '../db';
import type { PurchaseOrderDetail } from '../api/procurement';
import type { Supplier } from '../api/procurement';

/** Device-local, never synced. One row; replaced whole, never merged. */
export const CONFIG_KEY_TAKEDOWN = 'receiving_takedown';

/** A party a receipt may name. IDENTITY ONLY — no terms, no prices. */
export interface TakenDownSupplier {
  readonly supplierId: string;
  readonly code: string;
  readonly name: string;
}

export interface TakenDownLine {
  readonly purchaseOrderLineId: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly skuCode: string;
  readonly productName: string;
  /** The SUPPLIER's unit, and its scale. Frozen with the order. */
  readonly uomId: string;
  readonly uomCode: string;
  readonly qtyScale: number;
  readonly qtyOrdered: bigint;
  /**
   * What was still outstanding WHEN THIS WAS TAKEN DOWN. Named for what it is
   * because it is the one figure another yard can move; the server recomputes
   * it from the receipt lines when the write lands.
   */
  readonly qtyOutstandingAtTakeDown: bigint;
  readonly stockingUomCode: string;
  readonly qtyStockScale: number;
  readonly unitPriceE4: bigint;
}

export interface TakenDownOrder {
  readonly purchaseOrderId: string;
  readonly supplierId: string;
  readonly supplierCode: string;
  readonly supplierName: string;
  readonly deliverToLocationId: string;
  readonly locationCode: string;
  /** The order's status when it was taken down. Re-checked at apply time. */
  readonly statusAtTakeDown: string;
  readonly orderDate: string;
  readonly expectedAt: string | null;
  readonly lines: readonly TakenDownLine[];
}

export interface TakeDown {
  /** When the copy was taken. Rendered on every screen that reads it. */
  readonly takenDownAtMs: number;
  /** The yard this copy is for. A copy for another yard is discarded. */
  readonly locationId: string;
  readonly suppliers: readonly TakenDownSupplier[];
  readonly orders: readonly TakenDownOrder[];
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

interface StoredLine {
  readonly purchaseOrderLineId: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly skuCode: string;
  readonly productName: string;
  readonly uomId: string;
  readonly uomCode: string;
  readonly qtyScale: number;
  readonly qtyOrdered: string;
  readonly qtyOutstandingAtTakeDown: string;
  readonly stockingUomCode: string;
  readonly qtyStockScale: number;
  readonly unitPriceE4: string;
}

function storeLine(line: TakenDownLine): StoredLine {
  return {
    purchaseOrderLineId: line.purchaseOrderLineId,
    lineNo: line.lineNo,
    productId: line.productId,
    skuCode: line.skuCode,
    productName: line.productName,
    uomId: line.uomId,
    uomCode: line.uomCode,
    qtyScale: line.qtyScale,
    qtyOrdered: line.qtyOrdered.toString(),
    qtyOutstandingAtTakeDown: line.qtyOutstandingAtTakeDown.toString(),
    stockingUomCode: line.stockingUomCode,
    qtyStockScale: line.qtyStockScale,
    unitPriceE4: line.unitPriceE4.toString(),
  };
}

function readLine(raw: unknown): TakenDownLine {
  const row = raw as Record<string, unknown>;
  const text = (key: string): string => {
    const value = row[key];
    if (typeof value !== 'string') throw new Error(`take-down line: ${key} is not text`);
    return value;
  };
  const count = (key: string): number => {
    const value = row[key];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new Error(`take-down line: ${key} is not a whole number`);
    }
    return value;
  };
  // deserializeMoney refuses anything that is not an integer decimal string,
  // so a cache somebody edited by hand cannot become a float in a quantity.
  return {
    purchaseOrderLineId: text('purchaseOrderLineId'),
    lineNo: count('lineNo'),
    productId: text('productId'),
    skuCode: text('skuCode'),
    productName: text('productName'),
    uomId: text('uomId'),
    uomCode: text('uomCode'),
    qtyScale: count('qtyScale'),
    qtyOrdered: deserializeMoney(text('qtyOrdered')),
    qtyOutstandingAtTakeDown: deserializeMoney(text('qtyOutstandingAtTakeDown')),
    stockingUomCode: text('stockingUomCode'),
    qtyStockScale: count('qtyStockScale'),
    unitPriceE4: deserializeMoney(text('unitPriceE4')),
  };
}

/**
 * Turn a server-read order into the copy the yard carries.
 *
 * Nothing is invented: every field comes off the order the server just
 * answered with, and `qtyOutstanding` is renamed on the way in so no component
 * can accidentally render it as a live figure.
 */
export function orderToTakeDown(order: PurchaseOrderDetail): TakenDownOrder {
  return {
    purchaseOrderId: order.purchaseOrderId,
    supplierId: order.supplierId,
    supplierCode: order.supplierCode,
    supplierName: order.supplierName,
    deliverToLocationId: order.deliverToLocationId,
    locationCode: order.locationCode,
    statusAtTakeDown: order.status,
    orderDate: order.orderDate,
    expectedAt: order.expectedAt,
    lines: order.lines.map((l) => ({
      purchaseOrderLineId: l.purchaseOrderLineId,
      lineNo: l.lineNo,
      productId: l.productId,
      skuCode: l.skuCode,
      productName: l.productName,
      uomId: l.uomId,
      uomCode: l.uomCode,
      qtyScale: l.qtyScale,
      qtyOrdered: l.qtyOrdered,
      qtyOutstandingAtTakeDown: l.qtyOutstanding,
      stockingUomCode: l.stockingUomCode,
      qtyStockScale: l.qtyStockScale,
      unitPriceE4: l.unitPriceE4,
    })),
  };
}

export function supplierToTakeDown(supplier: Supplier): TakenDownSupplier {
  return { supplierId: supplier.supplierId, code: supplier.code, name: supplier.name };
}

/**
 * Read this device's copy, or `null` when there is none.
 *
 * A copy taken for a DIFFERENT location answers `null` rather than being
 * offered: a receipt signed at the wrong yard moves stock at a counter that
 * never saw it, which is the same class of error as a sale filed against the
 * wrong outlet.
 */
export async function readTakeDown(
  db: DbExecutor,
  locationId: string,
): Promise<TakeDown | null> {
  const rows = await db.getAll('SELECT value FROM local_config WHERE key = ? LIMIT 1', [
    CONFIG_KEY_TAKEDOWN,
  ]);
  const raw = rows[0]?.['value'];
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as {
      takenDownAtMs?: unknown;
      locationId?: unknown;
      suppliers?: unknown;
      orders?: unknown;
    };
    if (parsed.locationId !== locationId) return null;
    const at = parsed.takenDownAtMs;
    const suppliers = Array.isArray(parsed.suppliers) ? parsed.suppliers : [];
    const orders = Array.isArray(parsed.orders) ? parsed.orders : [];
    return {
      takenDownAtMs: typeof at === 'number' ? at : 0,
      locationId,
      suppliers: suppliers.map((s) => {
        const row = s as Record<string, unknown>;
        return {
          supplierId: String(row['supplierId']),
          code: String(row['code']),
          name: String(row['name']),
        };
      }),
      orders: orders.map((o) => {
        const row = o as Record<string, unknown>;
        const lines = Array.isArray(row['lines']) ? (row['lines'] as unknown[]) : [];
        return {
          purchaseOrderId: String(row['purchaseOrderId']),
          supplierId: String(row['supplierId']),
          supplierCode: String(row['supplierCode']),
          supplierName: String(row['supplierName']),
          deliverToLocationId: String(row['deliverToLocationId']),
          locationCode: String(row['locationCode']),
          statusAtTakeDown: String(row['statusAtTakeDown']),
          orderDate: String(row['orderDate']),
          expectedAt: row['expectedAt'] === null ? null : String(row['expectedAt']),
          lines: lines.map(readLine),
        };
      }),
    };
  } catch {
    // A copy this build cannot read is treated as ABSENT, never as partially
    // usable. Half an order is how a line gets received against the wrong
    // product; the screen then says there is no copy, which is true.
    return null;
  }
}

/** Replace this device's copy, whole. Never merged — a merge is two answers. */
export async function writeTakeDown(db: LocalDb, takeDown: TakeDown): Promise<void> {
  const payload = JSON.stringify({
    takenDownAtMs: takeDown.takenDownAtMs,
    locationId: takeDown.locationId,
    suppliers: takeDown.suppliers,
    orders: takeDown.orders.map((o) => ({ ...o, lines: o.lines.map(storeLine) })),
  });
  await db.writeTransaction(async (tx) => {
    await tx.execute('DELETE FROM local_config WHERE key = ?', [CONFIG_KEY_TAKEDOWN]);
    await tx.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
      uuidv7(),
      CONFIG_KEY_TAKEDOWN,
      payload,
    ]);
  });
  db.changes.notify();
}

export async function clearTakeDown(db: LocalDb): Promise<void> {
  await db.writeTransaction(async (tx) => {
    await tx.execute('DELETE FROM local_config WHERE key = ?', [CONFIG_KEY_TAKEDOWN]);
  });
  db.changes.notify();
}
