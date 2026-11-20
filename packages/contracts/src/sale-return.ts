/**
 * The void-and-return wire contract — `sale.return` (migration 0030).
 *
 * ONE op for both kinds, because they are one document with one identity
 * (`app.sale_return`), one till, one outbox and one replay rule. The kind
 * decides the capability (`sale.void` or `sale.return`) and what the device
 * may say:
 *
 *   VOID    the whole sale, in the till it was rung in. The device names the
 *           sale and gives a reason; it states NO lines and NO refund split,
 *           because a void reverses exactly what the server recorded — every
 *           line, and the money back the way it came (the original's own
 *           tender rows, mirrored). Nothing for the device to get wrong.
 *   RETURN  some lines, some quantity, in today's open till at the SAME
 *           location. The device names the original's line numbers and the
 *           quantity in the original's SELLING unit and scale, says whether each
 *           goes back on the shelf or is written off as damaged, and claims the
 *           refund split it paid out. The server re-prices from the original's
 *           snapshots (`@erp/money` `returnSlice`) and decides the split by one
 *           stated rule: ON ACCOUNT FIRST, up to what the sale put on account
 *           and has not already credited back; the rest through the one
 *           immediate method the device chose. An on-account sale's return is a
 *           credit note, never cash.
 *
 * What the wire does NOT carry, and why: prices, tax amounts, line totals.
 * The device computes them (the customer is standing there) and sends ONE
 * figure, `clientTotalMinor`, as a detector — never a source (the sale
 * contract's rule, ./sale.ts).
 */
import { z } from 'zod';
import { mutationEnvelope, zScaledIntNonNeg, zScaledIntPos, zUuid } from './wire.js';

export const SALE_RETURN_KINDS = ['VOID', 'RETURN'] as const;
export type SaleReturnKind = (typeof SALE_RETURN_KINDS)[number];

/** Where a returned item goes. Platform vocabulary; the reason codes it maps to are the server's. */
export const RETURN_DISPOSITIONS = ['RESTOCK', 'DAMAGED'] as const;
export type ReturnDisposition = (typeof RETURN_DISPOSITIONS)[number];

export const MAX_RETURN_LINES = 200;

export const saleReturnLineInput = z
  .object({
    /** `sale_line.line_no` of the ORIGINAL sale. */
    originalLineNo: z.number().int().min(1).max(32767),
    /** Scaled integer in the ORIGINAL line's selling unit, at its scale. */
    qty: zScaledIntPos,
    disposition: z.enum(RETURN_DISPOSITIONS),
  })
  .strict();

export const saleReturnRefundInput = z
  .object({
    /** The IMMEDIATE method (cash, mobile money, transfer) any non-account part goes back through. */
    methodId: zUuid,
    reference: z.string().trim().min(1).max(64).optional(),
    /** What the device credited to the account / paid out — claims, compared with the server's. */
    onAccountClaimMinor: zScaledIntNonNeg,
    immediateClaimMinor: zScaledIntNonNeg,
  })
  .strict();

export const createSaleReturnInput = z
  .object({
    ...mutationEnvelope,
    kind: z.enum(SALE_RETURN_KINDS),
    /**
     * The sale being reversed: its server id, OR the idempotency key it was
     * recorded under (`write_id`). A till voiding a sale it rang minutes ago
     * offline knows only the key; the server resolves either.
     */
    originalSaleId: zUuid,
    locationId: zUuid,
    /** The till the money leaves. A VOID's must be the original's own. */
    cashSessionId: zUuid,
    /** Printed on the return slip; drawn from the device's receipt series (03 §3.7.5). */
    returnNo: z.string().min(1).max(64),
    reason: z.string().trim().min(1).max(200),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    lines: z.array(saleReturnLineInput).max(MAX_RETURN_LINES).optional(),
    refund: saleReturnRefundInput.optional(),
    /** The device's own refund total — the detector, never the source. */
    clientTotalMinor: zScaledIntNonNeg.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind === 'VOID') {
      if (v.lines !== undefined || v.refund !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'a VOID states no lines and no refund: it reverses the whole sale the way it was paid',
        });
      }
      return;
    }
    if (v.lines === undefined || v.lines.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines'], message: 'a RETURN names at least one line' });
    } else if (new Set(v.lines.map((l) => l.originalLineNo)).size !== v.lines.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines'], message: 'each original line at most once' });
    }
    if (v.refund === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['refund'], message: 'a RETURN says how the money goes back' });
    }
  });

export type CreateSaleReturnInput = z.input<typeof createSaleReturnInput>;
export type CreateSaleReturnParsed = z.output<typeof createSaleReturnInput>;
export type SaleReturnLineInput = z.input<typeof saleReturnLineInput>;
