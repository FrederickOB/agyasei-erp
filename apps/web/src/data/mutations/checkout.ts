/**
 * Checkout: the ONE transaction that promotes a draft cart into a recorded
 * sale (§8.2). Inside a single local write transaction it
 *
 *   1. reads the cart and its lines,
 *   2. refuses a replayed idempotency key,
 *   3. inserts the outbox row (the pending write destined for the one write
 *      registry, `app.write_log`),
 *   4. deletes the cart and its lines.
 *
 * All-or-nothing: a crash or a mid-transaction failure leaves EITHER the cart
 * (nothing recorded) OR the sale (cart gone) — never both, never neither.
 * That atomicity, plus the idempotency key minted at cart creation, is the
 * design that makes double-ringing structurally hard. Nothing here awaits a
 * socket; completion is single-digit milliseconds.
 *
 * Money: totals are computed in TypeScript over bigint via @erp/money — never
 * in SQL, where SUM() would come back as float64 (§8.3).
 */
import { add, compare, lineNetMinor, serializeMoney, sub } from '@erp/money';
import type { ClaimedHlcClock } from '../../lib/hlc';
import type { DbExecutor, LocalDb } from '../db';
import { getCartLines, getOpenCart, type CartLineRow } from '../queries/cart';

export class EmptyCartError extends Error {
  constructor() {
    super('cart has no lines');
    this.name = 'EmptyCartError';
  }
}

export class DuplicateSaleError extends Error {
  constructor(readonly saleId: string) {
    super(`sale ${saleId} is already recorded — never re-ring it`);
    this.name = 'DuplicateSaleError';
  }
}

export class ShortTenderError extends Error {
  constructor() {
    super('cash received is less than the amount due');
    this.name = 'ShortTenderError';
  }
}

/** Extended line amount, rounded ONCE on the extended amount (§4.13 via @erp/money). */
export function lineTotalMinor(line: CartLineRow): bigint {
  return lineNetMinor(line.qtyScaled, line.qtyScale, line.unitPriceE4, 'half-up');
}

/** Cart total: exact bigint sum of line totals. */
export function cartTotalMinor(lines: readonly CartLineRow[]): bigint {
  let sum = 0n;
  for (const line of lines) sum = add(sum, lineTotalMinor(line));
  return sum;
}

export interface SalePayloadInput {
  readonly saleId: string;
  readonly priceListId: string | null;
  readonly createdAt: string;
  readonly lines: readonly CartLineRow[];
  readonly tenderedMinor: bigint;
}

export interface BuiltSalePayload {
  readonly payloadJson: string;
  readonly totalMinor: bigint;
  readonly changeMinor: bigint;
}

/**
 * The upload payload. Every monetary value crosses JSON as a decimal STRING of
 * minor units (@erp/money serializeMoney) — a JSON number is a float64 in
 * every consumer and never carries money (ADR-0004).
 *
 * ─── Q8 SEAM (docs/open-questions.md Q8 — e-invoice clearance regime,
 * NEEDS-HUMAN) ─────────────────────────────────────────────────────────────
 * This payload captures the sale and has room for computed tax lines
 * (`tax_lines`, populated from the jurisdiction pack's effective-dated rate
 * rows once they sync to the device). It deliberately carries NO invoice
 * issuance or clearance surface: no certified-invoicing identifiers, no
 * device/SDC fields, no QR payload, no clearance status. When Q8 resolves,
 * issuance belongs in the jurisdiction-pack / POS document layer — extend the
 * payload there, not here.
 * ──────────────────────────────────────────────────────────────────────────
 */
export function buildSalePayload(input: SalePayloadInput): BuiltSalePayload {
  if (input.lines.length === 0) throw new EmptyCartError();
  const totalMinor = cartTotalMinor(input.lines);
  if (compare(input.tenderedMinor, totalMinor) < 0) throw new ShortTenderError();
  const changeMinor = sub(input.tenderedMinor, totalMinor);
  const payload = {
    kind: 'sale',
    sale_id: input.saleId,
    price_list_id: input.priceListId,
    created_at: input.createdAt,
    lines: input.lines.map((line) => ({
      seq: line.seq,
      product_id: line.productId,
      name: line.name,
      uom_label: line.uomLabel,
      qty_scale: line.qtyScale, // digit count — not a monetary magnitude
      qty_scaled: line.qtyScaled.toString(),
      unit_price_e4: line.unitPriceE4.toString(),
      line_total_minor: serializeMoney(lineTotalMinor(line)),
    })),
    tax_lines: [] as const, // Q8 seam — see the comment block above
    total_minor: serializeMoney(totalMinor),
    tender: {
      kind: 'cash',
      tendered_minor: serializeMoney(input.tenderedMinor),
      change_minor: serializeMoney(changeMinor),
    },
  };
  return { payloadJson: JSON.stringify(payload), totalMinor, changeMinor };
}

export interface CheckoutInput {
  readonly cartId: string;
  readonly tenderedMinor: bigint;
  readonly hlc: ClaimedHlcClock;
  readonly nowIso?: string;
}

export interface CheckoutResult {
  readonly saleId: string;
  readonly totalMinor: bigint;
  readonly changeMinor: bigint;
}

export async function checkout(db: LocalDb, input: CheckoutInput): Promise<CheckoutResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const claimedHlc = input.hlc.next();

  const result = await db.writeTransaction(async (tx: DbExecutor) => {
    const cart = await getOpenCart(tx);
    if (cart === null || cart.id !== input.cartId) {
      throw new Error(`no open cart with id ${input.cartId}`);
    }
    const lines = await getCartLines(tx, input.cartId);
    if (lines.length === 0) throw new EmptyCartError();

    // The cart id IS the sale id IS the idempotency key (§8.2). A replay is
    // refused here as defence in depth; the authoritative guard is the
    // per-tenant primary key of app.write_log at ingest.
    const duplicate = await tx.getAll('SELECT 1 AS hit FROM outbox WHERE idempotency_key = ?', [
      input.cartId,
    ]);
    if (duplicate.length > 0) throw new DuplicateSaleError(input.cartId);

    const built = buildSalePayload({
      saleId: input.cartId,
      priceListId: cart.priceListId,
      createdAt: nowIso,
      lines,
      tenderedMinor: input.tenderedMinor,
    });

    await tx.execute(
      `INSERT INTO outbox
         (id, idempotency_key, claimed_hlc, kind, payload, total_minor,
          created_at, server_ack_at, rejected_at, reject_reason)
       VALUES (?, ?, ?, 'sale', ?, CAST(? AS INTEGER), ?, NULL, NULL, NULL)`,
      [
        input.cartId,
        input.cartId,
        claimedHlc,
        built.payloadJson,
        built.totalMinor.toString(),
        nowIso,
      ],
    );
    await tx.execute('DELETE FROM cart_line WHERE cart_id = ?', [input.cartId]);
    await tx.execute('DELETE FROM cart WHERE id = ?', [input.cartId]);

    return {
      saleId: input.cartId,
      totalMinor: built.totalMinor,
      changeMinor: built.changeMinor,
    };
  });

  db.changes.notify();
  return result;
}
