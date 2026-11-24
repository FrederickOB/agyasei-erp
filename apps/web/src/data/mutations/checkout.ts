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
 * HOW THE CUSTOMER PAID is on the wire now, one tender line per method (04
 * §4.8; migration 0021): part cash and part mobile money is two lines, a
 * transfer or a cheque carries its reference, and an on-account line names
 * the customer. The note handed over and the change stay DEVICE-LOCAL, in
 * outbox columns, because they are receipt facts: the drawer keeps the
 * APPLIED amount (`drawer_minor`), which is what cash-up adds up.
 *
 * THERE IS NO PATH TO A SALE WITHOUT AN OPEN TILL (08 §8.2a). The sale names
 * it (`cashSessionId`) and its business date IS the till's — the device never
 * asserts one of its own, and a till left open past local midnight refuses
 * the sale until the counter has closed it and opened the new day's.
 *
 * Money: totals are computed in TypeScript over bigint via @erp/money — never
 * in SQL, where SUM() would come back as float64 (§8.3).
 */
import {
  createSaleInput,
  type CreateSaleInput,
  type SaleTenderInput,
} from '@erp/contracts';
import { compare, serializeMoney, sub } from '@erp/money';
import { deviceNodeFromClaimedHlc, type ClaimedHlcClock } from '../../lib/hlc';
import type { ReceiptNumberFormat } from '../../lib/receipt-number';
import { uuidv7 } from '../../lib/uuidv7';
import type { DbExecutor, LocalDb } from '../db';
import { cartTotalMinor, UNTAXED_BASIS, type CartPricingBasis } from '../pricing/cart-pricing';
import { readPricingBasis } from '../pricing/cart-basis';
import { getCartLines, getOpenCart, type CartLineRow, type CartRow } from '../queries/cart';
import { readDeviceLocation, readReceiptFormat } from '../queries/session';
import { defaultCashMethod, type TenderMethod } from '../queries/tender-methods';
import { resolveCartPriceList } from '../session/device-price-list';
import { allocateReceiptNumber } from '../sequence';
import { nextQueueSeq } from '../sync/queue-seq';
import { readOpenTill, tillIsStale, type Till } from './till';

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
  constructor(message = 'cash received is less than the amount due') {
    super(message);
    this.name = 'ShortTenderError';
  }
}

/**
 * The device cannot name where it is, what list it priced against, which
 * till it is ringing into, or who the credit sale is for. Recording anyway
 * would file the sale against the wrong outlet, the wrong day or the wrong
 * list — so the sale is refused BEFORE the cart is cleared. The cart
 * survives, in front of a human, with a sentence a counter can act on.
 */
export class SaleContextIncompleteError extends Error {
  constructor(readonly missing: string) {
    super(missing);
    this.name = 'SaleContextIncompleteError';
  }
}

/** No till is open: the counter's answer is the open-till screen (§8.2a). */
export class TillNotOpenError extends SaleContextIncompleteError {
  constructor() {
    super('No till is open. Open the till before taking a sale.');
    this.name = 'TillNotOpenError';
  }
}

/**
 * The till belongs to an earlier day: local midnight has passed. The counter
 * closes it (uncounted) and offers the new day's till — it never files today's
 * sale under yesterday's date (§8.2a).
 */
export class TillClosedAtMidnightError extends SaleContextIncompleteError {
  constructor(readonly businessDate: string) {
    super(`The till for ${businessDate} closed at midnight. Open today's till to keep selling.`);
    this.name = 'TillClosedAtMidnightError';
  }
}

/**
 * The cart is not what the cashier was looking at. A tap that was still being
 * written when payment was taken lands in the cart a moment later: recording
 * it would charge the customer for more (or less) than the amount due on the
 * screen, and the change the screen worked out would be wrong. Refused BEFORE
 * anything is written — the cart survives, the screen catches up, and the
 * cashier takes payment against the real figure.
 */
export class CartChangedError extends Error {
  constructor(
    readonly shownMinor: bigint,
    readonly cartMinor: bigint,
  ) {
    super('The cart changed while payment was being taken.');
    this.name = 'CartChangedError';
  }
}

/** The tender lines do not settle the sale — too little, too much, or a missing reference. */
export class TenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenderError';
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

/**
 * One way the customer is paying, as the counter captured it.
 *
 * `amountMinor` null makes it the BALANCE line — "the rest" — which settles
 * whatever the other lines do not. A single-method sale is one balance line;
 * "50.00 by mobile money, the rest in cash" is a stated line and a balance
 * line. On the wire the balance line carries no amount: it makes no claim, so
 * the server giving it its own remainder overwrites nothing.
 */
export interface TenderDraft {
  readonly method: TenderMethod;
  readonly amountMinor: bigint | null;
  /** A transaction id, a bank reference, a cheque number. */
  readonly reference?: string;
  /**
   * CASH lines only: what the customer handed over, when more than the line
   * applies. Change is the difference. Never on the wire.
   */
  readonly tenderedMinor?: bigint;
}

/** A tender line with its applied amount resolved against the device's total. */
export interface AppliedTender {
  readonly method: TenderMethod;
  readonly appliedMinor: bigint;
  /** True for the balance line: on the wire without an amount. */
  readonly isBalance: boolean;
  readonly reference?: string;
}

export interface SettledTenders {
  readonly lines: readonly AppliedTender[];
  /** Cash that goes IN THE DRAWER: Σ applied over cash lines. */
  readonly drawerMinor: bigint;
  /** Notes handed over for the cash lines (≥ drawerMinor). */
  readonly cashTenderedMinor: bigint;
  readonly changeMinor: bigint;
}

/**
 * Resolve the counter's tender lines against the DEVICE's total, exactly, in
 * bigint. Pure. Refuses rather than guesses:
 *  - more than one balance line, or none and the lines do not sum to the total;
 *  - stated lines that exceed the total;
 *  - a method that needs a reference without one;
 *  - cash handed over that does not cover the cash applied.
 */
export function settleTenders(drafts: readonly TenderDraft[], totalMinor: bigint): SettledTenders {
  if (drafts.length === 0) throw new TenderError('Choose how the customer is paying.');
  const balances = drafts.filter((d) => d.amountMinor === null);
  if (balances.length > 1) throw new TenderError('Only one payment can take the rest of the amount.');
  let stated = 0n;
  for (const d of drafts) {
    if (d.amountMinor !== null) {
      if (d.amountMinor < 0n) throw new TenderError('A payment cannot be negative.');
      stated += d.amountMinor;
    }
    if (d.method.requiresReference && (d.reference === undefined || d.reference.trim().length === 0)) {
      throw new TenderError(`${d.method.name} needs a reference — a transaction id or cheque number.`);
    }
  }
  const rest = totalMinor - stated;
  if (balances.length === 0 && rest !== 0n) {
    throw new TenderError(
      rest > 0n ? 'The payments do not cover the amount due.' : 'The payments add up to more than the amount due.',
    );
  }
  if (rest < 0n) throw new TenderError('The payments add up to more than the amount due.');

  const lines: AppliedTender[] = drafts.map((d) => ({
    method: d.method,
    appliedMinor: d.amountMinor ?? rest,
    isBalance: d.amountMinor === null,
    ...(d.reference === undefined || d.reference.trim().length === 0 ? {} : { reference: d.reference.trim() }),
  }));
  let drawer = 0n;
  let handed = 0n;
  drafts.forEach((d, i) => {
    if (!d.method.isCash) return;
    const applied = lines[i]!.appliedMinor;
    drawer += applied;
    handed += d.tenderedMinor ?? applied;
  });
  if (compare(handed, drawer) < 0) throw new ShortTenderError();
  return { lines, drawerMinor: drawer, cashTenderedMinor: handed, changeMinor: sub(handed, drawer) };
}

export interface SalePayloadInput {
  /** The cart id — the sale id AND the idempotency key (§8.2). */
  readonly saleId: string;
  readonly locationId: string;
  /** The price list's CODE. The API names lists by code, not by row id. */
  readonly priceListCode: string;
  /** Device-allocated, per-location, minted offline (03 §3.7.5). */
  readonly receiptNo: string;
  /** The till this sale is rung into. Its business date is the sale's. */
  readonly cashSessionId: string;
  readonly tenders: readonly TenderDraft[];
  /** Required for an on-account line; optional for a known cash customer. */
  readonly customerId?: string | undefined;
  /** The device's untrusted clock assertion for this write. */
  readonly claimedHlc?: string | undefined;
  readonly createdAt: string;
  readonly lines: readonly CartLineRow[];
  /**
   * The list's tax convention and the pack rows in force on the TILL's date.
   * Omitted means the neutral basis — a tax-exclusive list with no pack rows,
   * which is local-only mode.
   */
  readonly pricingBasis?: CartPricingBasis;
}

export interface BuiltSalePayload {
  /** The exact bytes the outbox stores and the transport ships. */
  readonly payloadJson: string;
  /** The same value, typed as the contract's input. */
  readonly payload: CreateSaleInput;
  readonly totalMinor: bigint;
  readonly settled: SettledTenders;
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
  const totalMinor = cartTotalMinor(input.lines, input.pricingBasis ?? UNTAXED_BASIS);
  // Settled against the LOCAL total: the customer is standing there and the
  // server is not reachable. The server's repriced figure may differ, which is
  // precisely what `clientTotalMinor` exists to surface.
  const settled = settleTenders(input.tenders, totalMinor);

  const tenders: SaleTenderInput[] = settled.lines.map((t) => ({
    methodId: t.method.id,
    settlement: t.method.settlement,
    ...(t.isBalance ? {} : { amountMinor: serializeMoney(t.appliedMinor) }),
    ...(t.reference === undefined ? {} : { reference: t.reference }),
  }));

  // TYPED AS THE CONTRACT. Add a key the API does not accept, or drop one it
  // requires, and this stops compiling — which is the entire point of the
  // annotation. Do not widen it.
  const payload: CreateSaleInput = {
    idempotencyKey: input.saleId,
    ...(input.claimedHlc !== undefined ? { claimedHlc: input.claimedHlc } : {}),
    clientWallAt: input.createdAt,
    locationId: input.locationId,
    cashSessionId: input.cashSessionId,
    priceListCode: input.priceListCode,
    receiptNo: input.receiptNo,
    occurredAt: input.createdAt,
    tenders,
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

  return { payloadJson, payload, totalMinor, settled };
}

// ---------------------------------------------------------------------------
// The sale's context — read from local state, never invented
// ---------------------------------------------------------------------------

export interface SaleContext {
  readonly locationId: string;
  readonly locationCode: string;
  readonly priceListCode: string;
  /** The open till's — the only business date a sale is filed under. */
  readonly till: Till;
  readonly businessDate: string;
  readonly receiptFormat: ReceiptNumberFormat;
  /**
   * The list's convention and the pack rows in force ON THE TILL'S DATE —
   * resolved together, from the same day, so a sale filed under one date can
   * never be taxed against the rows of another.
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
  // The TILL settles the trading day (§8.2a): no open till, no sale; a till
  // from before local midnight, no sale until the new day's is open.
  const till = await readOpenTill(tx);
  if (till === null) throw new TillNotOpenError();
  if (await tillIsStale(tx, till, occurredAt)) throw new TillClosedAtMidnightError(till.businessDate);
  const businessDate = till.businessDate;
  // Not "does this id match a row" but "is this a list this counter may sell
  // from on the till's day" (data/session/device-price-list.ts).
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
    till,
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
  readonly hlc: ClaimedHlcClock;
  readonly nowIso?: string;
  /**
   * How the customer paid. Omitted means ONE cash line taking the whole
   * amount — the walk-in counter's overwhelming case — with `tenderedMinor`
   * as the note handed over.
   */
  readonly tenders?: readonly TenderDraft[];
  /** For the omitted-`tenders` case: the cash handed over. */
  readonly tenderedMinor?: bigint;
  /** Required for an on-account line; the customer the sale is charged to. */
  readonly customerId?: string;
  /**
   * The amount due the cashier was SHOWN. When given, a cart that no longer
   * comes to it is refused (`CartChangedError`) instead of recorded. The
   * counter always passes it; omitted only by callers with no screen.
   */
  readonly expectedTotalMinor?: bigint;
  /** Id minter for a newly issued sequence block. Injected for deterministic tests. */
  readonly newId?: () => string;
}

export interface CheckoutResult {
  readonly saleId: string;
  /** The number printed on the customer's copy. */
  readonly receiptNo: string;
  readonly totalMinor: bigint;
  readonly changeMinor: bigint;
  readonly cashSessionId: string;
  readonly businessDate: string;
  /**
   * The lines and the pricing basis this sale was RECORDED with — read inside
   * the transaction that wrote it. The receipt is built from these, never from
   * a screen's copy of the cart, which can be a tap behind.
   */
  readonly lines: readonly CartLineRow[];
  readonly pricingBasis: CartPricingBasis;
}

export async function checkout(db: LocalDb, input: CheckoutInput): Promise<CheckoutResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const claimedHlc = input.hlc.next();
  const newId = input.newId ?? uuidv7;

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

    const context = await loadSaleContext(tx, cart, nowIso);

    // The amount on the cashier's screen is the amount the customer agreed
    // to. Checked FIRST — before tenders are judged against a figure nobody
    // was shown, and before a receipt number is drawn.
    if (input.expectedTotalMinor !== undefined) {
      const cartMinor = cartTotalMinor(lines, context.pricingBasis);
      if (cartMinor !== input.expectedTotalMinor) throw new CartChangedError(input.expectedTotalMinor, cartMinor);
    }

    let tenders = input.tenders;
    if (tenders === undefined) {
      const cash = await defaultCashMethod(tx);
      if (cash === null) {
        throw new SaleContextIncompleteError(
          'This device has no cash payment method yet — waiting for setup data to arrive.',
        );
      }
      tenders = [{
        method: cash,
        amountMinor: null,
        ...(input.tenderedMinor === undefined ? {} : { tenderedMinor: input.tenderedMinor }),
      }];
    }
    if (tenders.some((t) => t.method.isOnAccount) && input.customerId === undefined) {
      throw new SaleContextIncompleteError('A sale on account needs a customer.');
    }

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
      cashSessionId: context.till.id,
      tenders,
      customerId: input.customerId,
      claimedHlc,
      createdAt: nowIso,
      lines,
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
          tendered_minor, change_minor, cash_session_id, drawer_minor, created_at, queue_seq,
          server_ack_at, rejected_at, reject_reason)
       VALUES (?, ?, ?, 'sale', ?, CAST(? AS INTEGER), ?,
               CAST(? AS INTEGER), CAST(? AS INTEGER), ?, CAST(? AS INTEGER), ?, ?, NULL, NULL, NULL)`,
      [
        input.cartId,
        input.cartId,
        claimedHlc,
        built.payloadJson,
        built.totalMinor.toString(),
        receipt.receiptNo,
        built.settled.cashTenderedMinor.toString(),
        built.settled.changeMinor.toString(),
        context.till.id,
        built.settled.drawerMinor.toString(),
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
      changeMinor: built.settled.changeMinor,
      cashSessionId: context.till.id,
      businessDate: context.businessDate,
      lines,
      pricingBasis: context.pricingBasis,
    };
  });

  db.changes.notify();
  return result;
}
