/**
 * The sale wire contract — `sale.create`.
 *
 * ONE definition, imported by `apps/api` (which parses it) and by `apps/web`
 * (which builds it). Previously the API owned a private zod schema in
 * `src/routers/sales.ts` and the PWA hand-rolled an unrelated snake_case
 * object in `src/data/mutations/checkout.ts`; every sale the PWA uploaded was
 * rejected BAD_REQUEST and no test caught it, because `packages/sync-drills`
 * built its own API-shaped payloads instead of the client's. That class of
 * bug is closed by this file existing: the client cannot construct a payload
 * of the wrong shape without `tsc` saying so.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SERVER IS THE PRICING AUTHORITY. This is the load-bearing rule.
 * ─────────────────────────────────────────────────────────────────────────
 * The client sends WHAT WAS SOLD — product, quantity, unit, discount,
 * location, receipt number, the till it was rung in, and how it was paid. It
 * does NOT send unit prices, line totals or a sale total as facts. The
 * business date is the TILL's (`cashSessionId` → `app.cash_session`), never
 * a field of its own (03 §3.4.2). The server reprices
 * from the price list in force on the BUSINESS DATE and computes tax from
 * the effective-dated `platform.tax_rate` rows in force on that same date
 * (CLAUDE.md §2.5 — a historical transaction always reprices against the
 * rate row in effect on its transaction date). A device that has been
 * offline for four days holds a price list that may have moved; its
 * arithmetic is a claim, never a source.
 *
 * `.strict()` is therefore not a strictness preference to be loosened when a
 * client sends extra keys — it is the mechanism that stops a device asserting
 * a price. Adding `unitPriceE4` or `lineTotalMinor` to these schemas would
 * hand pricing authority to the till. Do not.
 *
 * Money and quantity cross as decimal STRINGS of scaled integer units and are
 * transformed to `bigint` here (ADR-0004). No JSON number ever carries a
 * monetary or quantity magnitude in either direction.
 *
 * ============================================================================
 * Q8 SEAM — Ghana e-VAT clearance (docs/open-questions.md Q8, UNRESOLVED).
 * ============================================================================
 * This contract captures the SALE and its computed tax. It deliberately
 * carries NO invoice-issuance surface: no clearance call, no fiscal invoice
 * number, no SDC/QR fields. If Q8 resolves to a clearance regime, issuance
 * becomes a SEPARATE document, workflow and contract (see the seam notes in
 * `apps/api/src/routers/sales.ts` and `@erp/db` migration 0004). Do not add
 * clearance fields here.
 * ============================================================================
 */
import { z } from 'zod';
import {
  mutationEnvelope,
  wire,
  zScaledIntNonNeg,
  zScaledIntPos,
  zUuid,
} from './wire.js';

/**
 * One line of a sale: what was sold, in what unit, how much of it.
 *
 * Note what is absent: no `name`, no `uomLabel`, no `unitPriceE4`, no
 * `lineTotalMinor`. Names and labels are presentation the server already
 * holds and would only have to distrust; prices and totals are the server's
 * to compute. A line is an INTENT (03 §3.7.2 — model intent, not outcome).
 */
export const saleLineInput = z
  .object({
    productId: zUuid,
    /** Scaled integer in the SELLING unit's scale, as a decimal string. */
    qty: zScaledIntPos,
    /** Selling unit code; defaults to the product's default sell unit. */
    uomCode: z.string().min(1).optional(),
    /** Operator-granted discount on the extended line amount, minor units. */
    lineDiscountMinor: zScaledIntNonNeg.default('0'),
  })
  .strict();

/**
 * HOW THE MONEY WAS SETTLED — platform vocabulary, per tender line.
 *
 * A tender line names a TENANT's method (`methodId` → `app.tender_method`,
 * whose code and name are the tenant's words and are never read) and DECLARES
 * which of the two platform kinds of settlement it is:
 *
 *   IMMEDIATE  — the money was received now: cash, mobile money, a transfer,
 *                a cheque. Needs `sale.record`.
 *   ON_ACCOUNT — the money is the customer's debt. Needs `sale.record.credit`,
 *                bounded by its `max_order_value_minor` against the SERVER's
 *                figure for that line.
 *
 * Why the device declares it rather than the server simply looking it up: the
 * capability check runs BEFORE the plan reads anything (it is what refuses a
 * principal who may not sell at all), so the authority a request needs has to
 * be derivable from the validated payload — exactly as the old
 * `tender: 'CASH' | 'CREDIT'` was. The plan then resolves each method and
 * REFUSES a line whose method's posting role disagrees with what it declared,
 * so a device cannot dress an on-account line up as cash to dodge the bound.
 * Two independent answers, and they must agree.
 */
export const TENDER_SETTLEMENTS = ['IMMEDIATE', 'ON_ACCOUNT'] as const;
export type TenderSettlement = (typeof TENDER_SETTLEMENTS)[number];

/** A split tender rarely has more than three parts; eight is generous. */
export const MAX_TENDER_LINES = 8;

export const saleTenderInput = z
  .object({
    /** The tenant's tender method (synced to the device in the reference bucket). */
    methodId: zUuid,
    settlement: z.enum(TENDER_SETTLEMENTS),
    /**
     * The amount this line settles, minor units, as a decimal string — the
     * part of the DEVICE's total paid this way. For cash it is the amount
     * applied, never the note handed over: change is the device's to give and
     * the drawer only keeps the applied amount.
     *
     * A claim, like `clientTotalMinor`: if the server's repriced total
     * differs, the server reconciles the split onto its own figure by a stated
     * rule, keeps this value as `claimed_minor`, and opens a review
     * (apps/api/src/tender.ts). The sale is never refused for it.
     *
     * OMITTED on at most one line: the BALANCE line, which settles whatever
     * the stated lines do not — "50.00 by mobile money, the rest in cash". It
     * claims nothing, so the server giving it its own remainder overwrites
     * nothing and opens no review.
     */
    amountMinor: zScaledIntNonNeg.optional(),
    /** A momo transaction id, a bank reference, a cheque number. */
    reference: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export type SaleTenderInput = z.input<typeof saleTenderInput>;
export type SaleTenderParsed = z.output<typeof saleTenderInput>;

const createSaleObject = z
  .object({
    ...mutationEnvelope,
    locationId: zUuid,
    /**
     * The till this sale was rung in — the open's idempotency key
     * (`./cash-session.ts`). The business date the server prices and taxes
     * against is THE SESSION'S. There is no path to a sale without a session
     * (03 §3.4.2), and no `businessDate` field for a device to assert one.
     */
    cashSessionId: zUuid,
    priceListCode: z.string().min(1),
    /** Device-allocated per-outlet receipt number (03 §3.7.5). */
    receiptNo: z.string().min(1).max(64),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    /**
     * How the customer paid — one line per method, so part cash and part
     * mobile money is two lines. Σ amountMinor is the device's total.
     */
    tenders: z.array(saleTenderInput).min(1).max(MAX_TENDER_LINES),
    /** Required when any tender is ON_ACCOUNT; optional for a known cash customer. */
    customerId: zUuid.optional(),
    lines: z.array(saleLineInput).min(1).max(200),

    /**
     * ── DESIGN DECISION (b): ACCEPTED — the stale-price-list detector ──────
     *
     * The till's own belief about what this sale came to, in minor units, as
     * a decimal string. OPTIONAL, and NEVER authoritative. When present it
     * must equal Σ tenders — the device is asserting one total, not two.
     *
     * Why it is here: a device that has traded offline for days against a
     * superseded price list produces correct-looking receipts at the wrong
     * prices, and today that is SILENT — the server reprices, writes its own
     * figure, and nobody learns the device was wrong. The customer already
     * walked out with a receipt showing the client's number. That divergence
     * is exactly what an offline-first POS must surface.
     *
     * What the server does with it: compares it against its OWN repriced
     * total and records the comparison in the response (`PriceCheck` below).
     * The server's figure is what is written to `app.sale`, unconditionally.
     * A mismatch is REPORTED, never obeyed and never a rejection — the goods
     * have left the yard; refusing the write would lose the sale to make a
     * point. See `comparePriceCheck()`.
     *
     * What it must never become: an input to any calculation. If you find
     * yourself reading this value anywhere other than the comparison, stop.
     */
    clientTotalMinor: zScaledIntNonNeg.optional(),

    /**
     * ── DESIGN DECISION (a): RESOLVED by the tender lines above ────────────
     *
     * This contract used to refuse tendered/change detail because "THE SERVER
     * HAS NOWHERE TO PUT THEM" — there was no `app.sale_tender` and no
     * `app.cash_session`. Both exist now (migrations 0020, 0021), and the
     * record cash-up needs — the cash APPLIED to each sale in each session —
     * is `tenders[].amountMinor` on an IMMEDIATE cash line, persisted in
     * `app.sale_tender` in the same transaction as the sale.
     *
     * The note the customer handed over, and the change, are still NOT on the
     * wire, and now for a better reason than before: they are receipt-printing
     * facts with no ledger or drawer consequence (the drawer keeps the applied
     * amount; the change left with the customer). The device keeps them on
     * its own record for the receipt. A field the server would only parse and
     * drop stays refused (`.strict()`).
     */
  })
  .strict();

export const createSaleInput = createSaleObject.superRefine((v, ctx) => {
  const onAccount = v.tenders.filter((t) => t.settlement === 'ON_ACCOUNT');
  if (onAccount.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tenders'],
      message: 'at most one on-account tender: a sale charges one account once',
    });
  }
  if (onAccount.length > 0 && v.customerId === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['customerId'],
      message: 'an on-account tender needs the customer it is charged to',
    });
  }
  const balanceLines = v.tenders.filter((t) => t.amountMinor === undefined).length;
  if (balanceLines > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tenders'],
      message: 'at most one tender line may leave its amount to the balance',
    });
  }
  if (v.clientTotalMinor !== undefined) {
    let stated = 0n;
    for (const t of v.tenders) stated += t.amountMinor ?? 0n;
    const ok = balanceLines === 0 ? stated === v.clientTotalMinor : stated <= v.clientTotalMinor;
    if (!ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tenders'],
        message: `the stated tenders sum to ${stated.toString(10)} against the device's total of ${v.clientTotalMinor.toString(10)}`,
      });
    }
  }
});

export type SaleLineInput = z.input<typeof saleLineInput>;
export type SaleLineParsed = z.output<typeof saleLineInput>;
export type CreateSaleInput = z.input<typeof createSaleInput>;
export type CreateSaleParsed = z.output<typeof createSaleInput>;

/**
 * The recorded comparison between the till's claimed total and the server's
 * repriced one. Present in the sale response ONLY when the client supplied
 * `clientTotalMinor`, so a payload without it gets a byte-identical response
 * to before this field existed.
 *
 * Money as decimal strings, including inside jsonb: `write_log.response_body`
 * is jsonb and `JSON.parse('{"total":5000000}')` yields a float64 (03 §3.6.2).
 */
// A type alias, not an interface, so it carries an implicit index signature
// and drops straight into the API's JSON-safe response DTO.
export type PriceCheck = {
  /** What the device believed, echoed back verbatim. Not authoritative. */
  readonly clientTotalMinor: string;
  /** What the server computed and WROTE. Authoritative. */
  readonly serverTotalMinor: string;
  /** server − client, signed. Zero iff they agree. */
  readonly deltaMinor: string;
  readonly matches: boolean;
};

/**
 * Compare a client-claimed total against the server's authoritative one.
 *
 * Exact bigint arithmetic, no rounding, no tolerance band: a tolerance would
 * be a threshold below which a stale price list stays invisible, and the
 * whole point of the field is that it stops being invisible. One pesewa of
 * divergence is a divergence.
 *
 * The server's figure is returned as `serverTotalMinor` and is the one
 * written to `app.sale`. This function CANNOT change that; it only describes.
 */
export function comparePriceCheck(clientTotalMinor: bigint, serverTotalMinor: bigint): PriceCheck {
  const delta = serverTotalMinor - clientTotalMinor;
  return {
    clientTotalMinor: wire(clientTotalMinor),
    serverTotalMinor: wire(serverTotalMinor),
    deltaMinor: wire(delta),
    matches: delta === 0n,
  };
}
