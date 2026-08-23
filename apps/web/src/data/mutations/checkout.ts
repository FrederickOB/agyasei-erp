/**
 * Checkout: the ONE transaction that promotes a draft cart into a recorded
 * sale (§8.2). Inside a single local write transaction it
 *
 *   1. reads the cart and its lines,
 *   2. refuses a replayed idempotency key,
 *   3. draws the next receipt number from this device's block (03 §3.7.5),
 *   4. builds the upload payload and PARSES IT against the wire contract,
 *   5. inserts the outbox row (the pending write destined for the one write
 *      registry, `app.write_log`),
 *   6. deletes the cart and its lines.
 *
 * All-or-nothing: a crash or a mid-transaction failure leaves EITHER the cart
 * (nothing recorded) OR the sale (cart gone) — never both, never neither.
 * That atomicity, plus the idempotency key minted at cart creation, is the
 * design that makes double-ringing structurally hard. Nothing here awaits a
 * socket; completion is single-digit milliseconds.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SERVER IS THE PRICING AUTHORITY — and this file used to deny it.
 * ═══════════════════════════════════════════════════════════════════════════
 * The previous payload was invented here rather than imported: `kind`,
 * `sale_id`, `price_list_id`, `total_minor`, `unit_price_e4`,
 * `line_total_minor`, a nested `tender` object. The API's `.strict()` schema
 * required `locationId`, `priceListCode`, `receiptNo`, `businessDate` and a
 * `'CASH' | 'CREDIT'` tender and rejected everything else — so EVERY sale this
 * PWA uploaded was a BAD_REQUEST, and no test caught it because the sync
 * drills built their own API-shaped payloads instead of the client's.
 *
 * The payload is now constructed as `CreateSaleInput` from `@erp/contracts` —
 * the same declaration the API parses. A future divergence is a compile error
 * here, not a rejection at a till in Techiman with no developer nearby.
 *
 * What the wire carries: WHAT WAS SOLD — product, quantity, unit, location,
 * receipt number, business date, tender kind. What it does NOT carry: unit
 * prices, line totals or a sale total as FACTS. The server reprices from the
 * price list in force on the business date and computes tax from the
 * effective-dated rate rows in force on that same date (CLAUDE.md §2.5). A
 * device four days offline holds a price list that may have moved; its
 * arithmetic is a claim, never a source.
 *
 * What the counter still does locally, because it must: compute WHAT THE
 * CUSTOMER HANDS OVER and the change, with the radio off, in bigint — the
 * customer is standing there. On a tax-inclusive list that means de-grossing
 * the shelf price against the pack's declared composition, and on a
 * tax-exclusive one composing the tax onto it (../pricing/cart-pricing.ts);
 * either way the total is the gross, which is the same figure the server's
 * repricing produces. That figure goes on the wire in exactly one
 * place, `clientTotalMinor`, which the contract defines as the stale-price-list
 * DETECTOR: the server compares it against its own repriced total, records the
 * comparison, and writes its own figure regardless.
 *
 * Cash tendered and change stay DEVICE-LOCAL, in outbox columns. The contract
 * refuses them today because the server has nowhere to put them until
 * `app.cash_session` and `app.sale_tender` land, and a field the server
 * silently drops is worse than one it refuses.
 *
 * Money: totals are computed in TypeScript over bigint via @erp/money — never
 * in SQL, where SUM() would come back as float64 (§8.3).
 */
import { createSaleInput, type CreateSaleInput } from '@erp/contracts';
import { compare, serializeMoney, sub } from '@erp/money';
import { assertBusinessDate, businessDateFor } from '../../lib/business-date';
import { deviceNodeFromClaimedHlc, type ClaimedHlcClock } from '../../lib/hlc';
import type { ReceiptNumberFormat } from '../../lib/receipt-number';
import { uuidv7 } from '../../lib/uuidv7';
import type { DbExecutor, LocalDb } from '../db';
import { cartTotalMinor, UNTAXED_BASIS, type CartPricingBasis } from '../pricing/cart-pricing';
import { readPricingBasis } from '../pricing/cart-basis';
import { getCartLines, getOpenCart, type CartLineRow, type CartRow } from '../queries/cart';
import { readDeviceLocation, readReceiptFormat } from '../queries/session';
import { resolveCartPriceList } from '../session/device-price-list';
import { allocateReceiptNumber } from '../sequence';
import { nextQueueSeq } from '../sync/queue-seq';

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

/**
 * The device cannot name where it is, what list it priced against, or who the
 * credit sale is for. Recording anyway would file the sale against the wrong
 * outlet or have the server reprice it from the wrong list — so the sale is
 * refused BEFORE the cart is cleared. The cart survives, in front of a human,
 * with a sentence a counter can act on.
 */
export class SaleContextIncompleteError extends Error {
  constructor(readonly missing: string) {
    super(missing);
    this.name = 'SaleContextIncompleteError';
  }
}

/**
 * The payload does not satisfy the wire contract. Thrown BEFORE the outbox
 * insert, so the malformed sale is caught at the counter — where it can be
 * re-rung with the customer still there — rather than silently rejected hours
 * later at sync. The cart is untouched: nothing is dropped.
 */
export class SalePayloadInvalidError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`sale payload does not match the wire contract: ${issues.join('; ')}`);
    this.name = 'SalePayloadInvalidError';
  }
}

/**
 * The cart's money lives in `../pricing/cart-pricing.ts`, which owns the one
 * rule that matters here: the total is what the CUSTOMER HANDS OVER, on a
 * tax-inclusive list and a tax-exclusive one alike. Re-exported so the counter
 * keeps importing its total from the module that also builds the payload.
 */
export {
  cartTotalMinor,
  lineTotalMinor,
  priceCart,
  UNTAXED_BASIS,
  type CartPricing,
  type CartPricingBasis,
} from '../pricing/cart-pricing';

/** Cash or credit. The contract's enum, spelled once. */
export type TenderKind = CreateSaleInput['tender'];

export interface SalePayloadInput {
  /** The cart id — the sale id AND the idempotency key (§8.2). */
  readonly saleId: string;
  readonly locationId: string;
  /** The price list's CODE. The API names lists by code, not by row id. */
  readonly priceListCode: string;
  /** Device-allocated, per-location, minted offline (03 §3.7.5). */
  readonly receiptNo: string;
  /** The trading day this sale reprices and taxes against. */
  readonly businessDate: string;
  readonly tender: TenderKind;
  /** Required for a credit sale; absent for a walk-in. */
  readonly customerId?: string | undefined;
  /** The device's untrusted clock assertion for this write. */
  readonly claimedHlc?: string | undefined;
  readonly createdAt: string;
  readonly lines: readonly CartLineRow[];
  readonly tenderedMinor: bigint;
  /**
   * The list's tax convention and the pack rows in force on `businessDate`.
   * Omitted means the neutral basis — a tax-exclusive list with no pack rows,
   * which is local-only mode and is the behaviour every caller had before an
   * inclusive list could be rung.
   */
  readonly pricingBasis?: CartPricingBasis;
}

export interface BuiltSalePayload {
  /** The exact bytes the outbox stores and the transport ships. */
  readonly payloadJson: string;
  /** The same value, typed as the contract's input. */
  readonly payload: CreateSaleInput;
  readonly totalMinor: bigint;
  readonly changeMinor: bigint;
}

/**
 * Build the upload payload and prove it against the contract.
 *
 * ─── Q8 SEAM (docs/open-questions.md Q8 — e-invoice clearance regime,
 * NEEDS-HUMAN) ─────────────────────────────────────────────────────────────
 * This payload captures the SALE. It deliberately carries no invoice issuance
 * or clearance surface: no certified-invoicing identifiers, no device/SDC
 * fields, no QR payload, no clearance status — the contract has none either,
 * for the same reason. When Q8 resolves, issuance is a SEPARATE document and
 * contract; extend it there, not here.
 * ──────────────────────────────────────────────────────────────────────────
 */
export function buildSalePayload(input: SalePayloadInput): BuiltSalePayload {
  if (input.lines.length === 0) throw new EmptyCartError();

  // WHAT THE CUSTOMER HANDS OVER — gross, under the list's own convention.
  // On a tax-inclusive list that is the shelf price extended by the quantity;
  // on a tax-exclusive one it is the extension plus the composed tax. Both
  // come from the same module and the same pack data (../pricing/).
  const totalMinor = cartTotalMinor(input.lines, input.pricingBasis ?? UNTAXED_BASIS);
  // Cash is counted against the LOCAL total: the customer is standing there
  // and the server is not reachable. The server's repriced figure may differ,
  // which is precisely what `clientTotalMinor` exists to surface.
  const isCash = input.tender === 'CASH';
  if (isCash && compare(input.tenderedMinor, totalMinor) < 0) throw new ShortTenderError();
  const changeMinor = isCash ? sub(input.tenderedMinor, totalMinor) : 0n;

  // TYPED AS THE CONTRACT. Add a key the API does not accept, or drop one it
  // requires, and this stops compiling — which is the entire point of the
  // annotation. Do not widen it.
  const payload: CreateSaleInput = {
    idempotencyKey: input.saleId,
    ...(input.claimedHlc !== undefined ? { claimedHlc: input.claimedHlc } : {}),
    clientWallAt: input.createdAt,
    locationId: input.locationId,
    priceListCode: input.priceListCode,
    receiptNo: input.receiptNo,
    businessDate: input.businessDate,
    occurredAt: input.createdAt,
    tender: input.tender,
    ...(input.customerId !== undefined && input.customerId !== null
      ? { customerId: input.customerId }
      : {}),
    lines: input.lines.map((line) => ({
      productId: line.productId,
      // Scaled integer in the selling unit's scale, as a decimal STRING —
      // a JSON number is a float64 in every consumer (ADR-0004).
      qty: line.qtyScaled.toString(),
      // uomCode is deliberately OMITTED: the device's catalogue projection
      // carries a unit LABEL, not a unit code, and shipping a label where the
      // server expects a code is a silent mispricing. Omitted means "the
      // product's default sell unit", which is the unit this cart was priced
      // in. It starts being sent when the catalogue read layer is re-pointed
      // at product_uom / unit_of_measure (see the note in data/schema.ts).
      lineDiscountMinor: '0',
    })),
    // The till's BELIEF, never authoritative — the contract's stale-price-list
    // detector. The server compares it with its own repriced total, records
    // the comparison and writes its own figure regardless.
    clientTotalMinor: serializeMoney(totalMinor),
  };

  // Prove the exact BYTES, not the object: round-tripping through JSON is
  // what the server receives, and it is where an undefined, a bigint or a
  // non-finite number would show up.
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(payload);
  } catch (err) {
    throw new SalePayloadInvalidError([
      `payload is not serialisable: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  const parsed = createSaleInput.safeParse(JSON.parse(payloadJson));
  if (!parsed.success) {
    throw new SalePayloadInvalidError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }

  return { payloadJson, payload, totalMinor, changeMinor };
}

// ---------------------------------------------------------------------------
// The sale's context — read from local state, never invented
// ---------------------------------------------------------------------------

export interface SaleContext {
  readonly locationId: string;
  readonly locationCode: string;
  readonly priceListCode: string;
  readonly businessDate: string;
  readonly receiptFormat: ReceiptNumberFormat;
  /**
   * The list's convention and the pack rows in force ON THIS SALE'S BUSINESS
   * DATE — resolved together, from the same day, so a sale filed under one
   * date can never be taxed against the rows of another. A device that holds
   * no pack rows yet still sells: the total is the list's own extension, the
   * split is reported as unavailable, and the server reprices (§4.13 row 6).
   */
  readonly pricingBasis: CartPricingBasis;
}

/**
 * Gather what the contract requires from what the device already holds. Each
 * failure names the missing piece in words a counter can act on — the sale is
 * refused, not guessed at, and the cart is still intact when it throws.
 */
export async function loadSaleContext(
  tx: DbExecutor,
  cart: CartRow,
  occurredAt: string,
  businessDateOverride?: string,
): Promise<SaleContext> {
  const location = await readDeviceLocation(tx);
  if (location === null) {
    throw new SaleContextIncompleteError(
      'This device has no location assigned. It must be set up before it can record a sale.',
    );
  }
  if (location.code.length === 0) {
    throw new SaleContextIncompleteError(
      'This location has no code yet — waiting for setup data to arrive.',
    );
  }
  // The trading day is settled BEFORE the price list is judged, and then the
  // list is judged against that same day. A sale filed under one date and
  // priced against a list in force on another is exactly the disagreement the
  // server resolves by refusing.
  const businessDate =
    businessDateOverride === undefined
      ? businessDateFor(occurredAt, location.timeZone)
      : assertBusinessDate(businessDateOverride);
  // Not "does this id match a row" but "is this a list this counter may sell
  // from today" (data/session/device-price-list.ts). A list that lapsed
  // overnight resolves perfectly well and is then refused by the API hours
  // later, after the customer has gone; this catches it here, with the cart
  // still on the screen and the refusal still actionable.
  const priceList = await resolveCartPriceList(tx, cart.priceListId, occurredAt, businessDate);
  if (priceList.code === null) {
    throw new SaleContextIncompleteError(
      priceList.message ?? 'This cart cannot be sold: its price list cannot be named.',
    );
  }
  return {
    locationId: location.id,
    locationCode: location.code,
    priceListCode: priceList.code,
    businessDate,
    receiptFormat: await readReceiptFormat(tx),
    pricingBasis: await readPricingBasis(tx, priceList.isTaxInclusive, businessDate),
  };
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export interface CheckoutInput {
  readonly cartId: string;
  readonly tenderedMinor: bigint;
  readonly hlc: ClaimedHlcClock;
  readonly nowIso?: string;
  /** Defaults to CASH — the walk-in counter's overwhelming case. */
  readonly tender?: TenderKind;
  /** Required for CREDIT; the customer the sale is billed to. */
  readonly customerId?: string;
  /** An asserted trading day (a day-open control); derived from the location otherwise. */
  readonly businessDate?: string;
  /** Id minter for a newly issued sequence block. Injected for deterministic tests. */
  readonly newId?: () => string;
}

export interface CheckoutResult {
  readonly saleId: string;
  /** The number printed on the customer's copy. */
  readonly receiptNo: string;
  readonly totalMinor: bigint;
  readonly changeMinor: bigint;
}

export async function checkout(db: LocalDb, input: CheckoutInput): Promise<CheckoutResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const claimedHlc = input.hlc.next();
  const tender: TenderKind = input.tender ?? 'CASH';
  const newId = input.newId ?? uuidv7;

  if (tender === 'CREDIT' && input.customerId === undefined) {
    throw new SaleContextIncompleteError('A credit sale needs a customer.');
  }

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

    const context = await loadSaleContext(tx, cart, nowIso, input.businessDate);

    // The number is drawn INSIDE this transaction: a checkout that rolls back
    // burns none, a checkout that commits can never re-issue one.
    const receipt = await allocateReceiptNumber(tx, {
      locationId: context.locationId,
      locationCode: context.locationCode,
      deviceNode: deviceNodeFromClaimedHlc(claimedHlc),
      format: context.receiptFormat,
      nowIso,
      newId,
    });

    const built = buildSalePayload({
      saleId: input.cartId,
      locationId: context.locationId,
      priceListCode: context.priceListCode,
      receiptNo: receipt.receiptNo,
      businessDate: context.businessDate,
      tender,
      customerId: input.customerId,
      claimedHlc,
      createdAt: nowIso,
      lines,
      tenderedMinor: input.tenderedMinor,
      pricingBasis: context.pricingBasis,
    });

    // The queue position, taken inside the SAME transaction that writes the
    // sale and clears the cart. The sale's id is the CART's id, minted when
    // the cart was opened — which is why the queue key cannot be the id
    // (data/sync/queue-seq.ts): a block report queued after this sale but
    // before the drain must still reach the server first, and it will, because
    // this is the order they entered the queue in.
    const queueSeq = await nextQueueSeq(tx);

    await tx.execute(
      `INSERT INTO outbox
         (id, idempotency_key, claimed_hlc, kind, payload, total_minor, receipt_no,
          tendered_minor, change_minor, created_at, queue_seq,
          server_ack_at, rejected_at, reject_reason)
       VALUES (?, ?, ?, 'sale', ?, CAST(? AS INTEGER), ?,
               CAST(? AS INTEGER), CAST(? AS INTEGER), ?, ?, NULL, NULL, NULL)`,
      [
        input.cartId,
        input.cartId,
        claimedHlc,
        built.payloadJson,
        built.totalMinor.toString(),
        receipt.receiptNo,
        input.tenderedMinor.toString(),
        built.changeMinor.toString(),
        nowIso,
        queueSeq,
      ],
    );
    await tx.execute('DELETE FROM cart_line WHERE cart_id = ?', [input.cartId]);
    await tx.execute('DELETE FROM cart WHERE id = ?', [input.cartId]);

    return {
      saleId: input.cartId,
      receiptNo: receipt.receiptNo,
      totalMinor: built.totalMinor,
      changeMinor: built.changeMinor,
    };
  });

  db.changes.notify();
  return result;
}
