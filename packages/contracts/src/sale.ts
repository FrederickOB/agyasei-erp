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
 * location, receipt number, business date, tender kind. It does NOT send
 * unit prices, line totals or a sale total as facts. The server reprices
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
  zBusinessDate,
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

export const createSaleInput = z
  .object({
    ...mutationEnvelope,
    locationId: zUuid,
    priceListCode: z.string().min(1),
    /** Device-allocated per-outlet receipt number (03 §3.7.5). */
    receiptNo: z.string().min(1).max(64),
    businessDate: zBusinessDate,
    occurredAt: z.string().datetime({ offset: true }).optional(),
    tender: z.enum(['CASH', 'CREDIT']),
    customerId: zUuid.optional(),
    lines: z.array(saleLineInput).min(1).max(200),

    /**
     * ── DESIGN DECISION (b): ACCEPTED — the stale-price-list detector ──────
     *
     * The till's own belief about what this sale came to, in minor units, as
     * a decimal string. OPTIONAL, and NEVER authoritative.
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
     * ── DESIGN DECISION (a): REJECTED, for now, with a named unblock ───────
     *
     * The PWA computes `tendered_minor` and `change_minor` for a cash sale
     * and its payload carried both. They are NOT in this contract, and the
     * reason is not that they are pricing authority (they are not — the
     * argument for accepting them is a good one and it will win later).
     *
     * The reason is that THE SERVER HAS NOWHERE TO PUT THEM. `app.sale` is
     * append-only and has no tender columns; there is no `app.sale_tender`
     * table; there is no `app.cash_session` — migration 0004 defers it
     * explicitly ("§4.8a: cash_session_id lands with the POS migration").
     * `app.write_log` stores a request HASH, not the request body. A field
     * accepted here today would be parsed, validated, and dropped.
     *
     * A contract field the server silently discards is worse than one it
     * refuses. The till would show the sale as recorded and cash-up would
     * find nothing — the failure mode 03 §3.7.5 argues against in so many
     * words when it refuses to claim a gaplessness it cannot deliver. The
     * current loud rejection is at least honest.
     *
     * The asymmetry with (b) is deliberate and principled:
     *   (b) is a SIGNAL. Its whole value is delivered by reporting it back to
     *       the device and recording it in `write_log.response_body`; the
     *       authoritative number lives in `app.sale` either way.
     *   (a) is a RECORD. Its value is a query — "cash tendered at this till
     *       today" — that a per-write jsonb response body cannot serve.
     *       A record's home is a table, and that table does not exist.
     *
     * UNBLOCK: when the POS work-package lands `app.cash_session` and
     * `app.sale_tender`, add `cashTenderedMinor` here (tendered ONLY —
     * change is `tendered − serverTotal` and belongs in the response,
     * computed from the server's total, never sent by the client) and persist
     * it in the same transaction as the sale. Until then the device keeps
     * tendered/change in its own local record, which is where cash-up reads
     * them from today anyway.
     */
  })
  .strict();

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
