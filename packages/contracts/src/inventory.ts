/**
 * The stock-movement wire contract — `stock.record_movement`.
 *
 * This schema lived privately in `apps/api/src/routers/inventory.ts`. Nothing
 * on the client had ever seen it, which is the exact condition that produced
 * the sale-payload bug: a shape declared on one side of the wire only. There
 * is no PWA builder for this op *yet* — the counter records sales and nothing
 * else today — and that is precisely why the declaration belongs here now,
 * before someone writes one against a schema they cannot import.
 *
 * The ledger's rules are the schema's (04 §4.7.1): `qtyDelta` is a SIGNED
 * scaled integer in the product's STOCKING unit, outflow negative, and there
 * is no update path — corrections are compensating rows.
 *
 * Money and quantity cross as decimal STRINGS and become `bigint` here
 * (ADR-0004). `.strict()`, so a forged `tenant_id` fails loudly and a client
 * cannot assert a figure the server owns (CLAUDE.md §2.1).
 */
import { z } from 'zod';
import {
  mutationEnvelope,
  zBusinessDate,
  zScaledInt,
  zScaledIntNonNeg,
  zScaledIntPos,
  zUuid,
} from './wire.js';

/**
 * Movement kinds a DEVICE may record directly.
 *
 * These are platform document kinds, not tenant vocabulary: the tenant's own
 * editable vocabulary is `reasonCode`, which is resolved against the tenant's
 * `movement_reason` rows and never branched on (CLAUDE.md §2.9). SALE and
 * SALE_RETURN are absent deliberately — those movements are written by the
 * sales document, never by a direct call.
 */
export const DIRECT_MOVEMENT_KINDS = [
  'OPENING',
  'RECEIPT',
  'RETURN_TO_SUPPLIER',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'COUNT_ADJUST',
  'WRITE_OFF',
  'CORRECTION',
] as const;
export type DirectMovementKind = (typeof DIRECT_MOVEMENT_KINDS)[number];

export const recordMovementInput = z
  .object({
    ...mutationEnvelope,
    locationId: zUuid,
    productId: zUuid,
    /** SIGNED scaled integer in the product's STOCKING unit. */
    qtyDelta: zScaledInt.refine((v) => v !== 0n, 'qty_delta must be non-zero'),
    sourceKind: z.enum(DIRECT_MOVEMENT_KINDS),
    /** Tenant-defined reason vocabulary — resolved, never branched on. */
    reasonCode: z.string().min(1),
    businessDate: zBusinessDate,
    occurredAt: z.string().datetime({ offset: true }).optional(),
    /** Inbound unit cost, e4 (minor units × 10⁴). */
    unitCostE4: zScaledIntPos.optional(),
  })
  .strict();

export type RecordMovementInput = z.input<typeof recordMovementInput>;
export type RecordMovementParsed = z.output<typeof recordMovementInput>;

/**
 * The reorder-point wire contract — `inventory.setReorderPoint`.
 *
 * ---------------------------------------------------------------------------
 * THE QUANTITY IS IN THE PRODUCT'S STOCKING UNIT. THERE IS NO `uomCode` HERE.
 * ---------------------------------------------------------------------------
 * That omission is the contract's whole point. 12 m rebar is STOCKED as
 * countable bars and SOLD either by the bar or by the tonne, at exactly
 * 13500/d² bars per tonne (04 §4.4.1) — so "reorder at 10" means one thing in
 * bars and something ninety-three times larger in tonnes. A caller that could
 * name a unit could name the one the last customer happened to buy in, and
 * the alert would compare a tonne against a bar forever after.
 *
 * The movement ledger is denominated in the stocking unit (04 §4.4.3), the
 * threshold is denominated in the stocking unit, and the comparison is
 * therefore a bare integer comparison with no conversion and no rounding at
 * read time. The server resolves the unit from the product and snapshots it;
 * migration 0007's constraint trigger refuses any row that drifts from it.
 *
 * Quantities cross as decimal STRINGS and become `bigint` (ADR-0004): a
 * 400-tonne threshold at scale 3 is 400_000_000 scaled units, and a JSON
 * number is a float64 in every consumer.
 */
export const setReorderPointInput = z
  .object({
    ...mutationEnvelope,
    locationId: zUuid,
    productId: zUuid,
    /**
     * At or below this, the product is low. Scaled integer in the product's
     * STOCKING unit. Zero is meaningful and allowed: "tell me only when it is
     * actually gone".
     */
    reorderPointQty: zScaledIntNonNeg,
    /**
     * PHASE 2 SEAM: the level an order brings stock back up to. Unread by the
     * Phase 1 alert, read by reorder management, stored on the same row so a
     * tenant enters its numbers once. Must not be below reorderPointQty.
     */
    reorderUpToQty: zScaledIntNonNeg.optional(),
    /** PHASE 2 SEAM: supplier lead time in calendar days. */
    leadTimeDays: z.number().int().min(0).max(3650).optional(),
    /** Set false to retire a threshold without losing the numbers on it. */
    isActive: z.boolean().optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict();

export type SetReorderPointInput = z.input<typeof setReorderPointInput>;
export type SetReorderPointParsed = z.output<typeof setReorderPointInput>;
