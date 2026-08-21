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
