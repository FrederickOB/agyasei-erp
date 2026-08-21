/**
 * Inventory: the append-only movement ledger and the derived on-hand.
 *
 * recordMovement writes app.stock_movement through the idempotent pipeline.
 * The ledger's rules are the schema's (04 §4.7.1): qty_delta is a SIGNED
 * scaled integer in the STOCKING unit, outflow is negative (sm_sign), and
 * there is no UPDATE path — corrections are compensating rows.
 *
 * onHand is SUM(qty_delta), never a counter (CLAUDE.md §2.2): two offline
 * outlets appending movements converge in any arrival order.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { deterministicUuid } from '@erp/db';
import type { Queryable } from '../db.js';
import { runIdempotent } from '../pipeline.js';
import { assertLocationInScope, router, tenantProcedure } from '../trpc.js';
import { mutationEnvelope, wire, zBusinessDate, zScaledInt, zScaledIntPos, zUuid } from '../wire.js';

/** Device-recordable movement kinds. SALE / SALE_RETURN movements are
 *  written by the sales document, never directly. */
const DIRECT_KINDS = [
  'OPENING',
  'RECEIPT',
  'RETURN_TO_SUPPLIER',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'COUNT_ADJUST',
  'WRITE_OFF',
  'CORRECTION',
] as const;

const recordMovementInput = z
  .object({
    ...mutationEnvelope,
    locationId: zUuid,
    productId: zUuid,
    /** SIGNED scaled integer in the product's STOCKING unit. */
    qtyDelta: zScaledInt.refine((v) => v !== 0n, 'qty_delta must be non-zero'),
    sourceKind: z.enum(DIRECT_KINDS),
    /** Tenant-defined reason vocabulary — resolved, never branched on. */
    reasonCode: z.string().min(1),
    businessDate: zBusinessDate,
    occurredAt: z.string().datetime({ offset: true }).optional(),
    /** Inbound unit cost, e4 (minor units × 10⁴). */
    unitCostE4: zScaledIntPos.optional(),
  })
  .strict();

export interface ProductStockInfo {
  productId: string;
  stockingUomId: string;
  qtyScale: number;
  uomCode: string;
  stockTracking: string;
}

export async function loadProductStockInfo(
  tx: Queryable,
  productId: string,
): Promise<ProductStockInfo> {
  const res = await tx.query<{
    id: string;
    stocking_uom_id: string;
    qty_scale: number;
    uom_code: string;
    stock_tracking: string;
  }>(
    `select p.id, p.stocking_uom_id, u.qty_scale, u.code as uom_code, p.stock_tracking
     from app.product p
     join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
     where p.id = $1 and p.deleted_at is null`,
    [productId],
  );
  const row = res.rows[0];
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'product not found' });
  return {
    productId: row.id,
    stockingUomId: row.stocking_uom_id,
    qtyScale: row.qty_scale,
    uomCode: row.uom_code,
    stockTracking: row.stock_tracking,
  };
}

export const inventoryRouter = router({
  recordMovement: tenantProcedure.input(recordMovementInput).mutation(async ({ ctx, input }) => {
    assertLocationInScope(ctx.identity, input.locationId);
    const result = await runIdempotent(
      { runner: ctx.deps.runner, clock: ctx.deps.clock },
      ctx.identity,
      {
        op: 'stock.record_movement',
        idempotencyKey: input.idempotencyKey,
        claimedHlc: input.claimedHlc,
        clientWallAt: input.clientWallAt,
        locationId: input.locationId,
      },
      input,
      async (tx) => {
        const product = await loadProductStockInfo(tx, input.productId);
        if (product.stockTracking !== 'STOCKED') {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'product is not stock-tracked' });
        }
        const loc = await tx.query<{ id: string }>(
          `select id from app.location where id = $1 and deleted_at is null`,
          [input.locationId],
        );
        if (!loc.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'location not found' });
        const reason = await tx.query<{ id: string }>(
          `select id from app.movement_reason where code = $1 and deleted_at is null`,
          [input.reasonCode],
        );
        const reasonId = reason.rows[0]?.id;
        if (!reasonId) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `unknown movement reason ${input.reasonCode}` });
        }

        const movementId = deterministicUuid(input.idempotencyKey, 'stock_movement');
        const tenantId = ctx.identity.tenantId;
        const response = {
          movementId,
          locationId: input.locationId,
          productId: input.productId,
          qtyDelta: wire(input.qtyDelta),
          qtyScale: product.qtyScale,
          uomCode: product.uomCode,
          sourceKind: input.sourceKind,
          businessDate: input.businessDate,
        };
        return {
          response,
          apply: async (atx) => {
            await atx.query(
              `insert into app.stock_movement
                 (tenant_id, id, write_id, hlc, location_id, product_id, qty_delta, qty_scale,
                  uom_id, reason_id, source_kind, source_id, unit_cost_e4, occurred_at, business_date)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, null, $12, $13, $14::date)`,
              [
                tenantId,
                movementId,
                input.idempotencyKey,
                ctx.deps.clock.next(),
                input.locationId,
                input.productId,
                wire(input.qtyDelta),
                product.qtyScale,
                product.stockingUomId,
                reasonId,
                input.sourceKind,
                input.unitCostE4 !== undefined ? wire(input.unitCostE4) : null,
                input.occurredAt ?? new Date().toISOString(),
                input.businessDate,
              ],
            );
          },
        };
      },
    );
    return result.response;
  }),

  /** Derived on-hand: SUM over the ledger. Never a stored counter. */
  onHand: tenantProcedure
    .input(z.object({ locationId: zUuid, productId: zUuid }).strict())
    .query(async ({ ctx, input }) => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const product = await loadProductStockInfo(tx, input.productId);
        const res = await tx.query<{ qty: string }>(
          `select coalesce(sum(qty_delta), 0)::bigint::text as qty
           from app.stock_movement
           where location_id = $1 and product_id = $2`,
          [input.locationId, input.productId],
        );
        return {
          locationId: input.locationId,
          productId: input.productId,
          qtyOnHand: res.rows[0]!.qty, // decimal string, stocking-unit scale
          qtyScale: product.qtyScale,
          uomCode: product.uomCode,
        };
      });
    }),
});
