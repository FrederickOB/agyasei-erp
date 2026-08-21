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
import { recordMovementInput, type DirectMovementKind } from '@erp/contracts';
import { deterministicUuid, type PermissionCode } from '@erp/db';
import type { Queryable } from '../db.js';
import { runIdempotent } from '../pipeline.js';
import { assertLocationInScope, requiresPermission, router, tenantProcedure } from '../trpc.js';
import { wire, zUuid } from '../wire.js';

/**
 * The INPUT SHAPE is not defined here. `recordMovementInput` lives in
 * `@erp/contracts`, the one declaration both sides of the wire import, so a
 * device builder cannot be written against a shape this router will reject
 * (see `packages/contracts/src/device-ops.ts` for why that rule exists).
 */

/**
 * WHICH CAPABILITY A MOVEMENT NEEDS (02 §2.4).
 *
 * The ledger has one write path but several role boundaries run through it:
 * plenty of distributors let a yard hand book an inbound transfer in and
 * nobody else touch the count. So the required permission is derived from
 * `sourceKind` — a PLATFORM document vocabulary, closed and enumerated in
 * `@erp/contracts` (`DIRECT_MOVEMENT_KINDS`).
 *
 * It is emphatically NOT derived from `reasonCode`. Reason codes are the
 * TENANT's editable vocabulary (`app.movement_reason`); branching authority
 * on one would make the platform read a tenant's words, which CLAUDE.md §2.9
 * forbids and which would let a tenant rename its way out of a control.
 *
 * The map is total over the union, and TypeScript proves it: adding a kind to
 * the contract without deciding which capability guards it is a compile
 * error, not a movement that silently needs nothing.
 */
const MOVEMENT_PERMISSION: Record<DirectMovementKind, PermissionCode> = {
  // Corrections to what is physically there. The audited, reason-coded one.
  OPENING: 'stock.adjust',
  WRITE_OFF: 'stock.adjust',
  CORRECTION: 'stock.adjust',
  RETURN_TO_SUPPLIER: 'stock.adjust',
  // Goods arriving from a supplier.
  RECEIPT: 'stock.receive',
  // The two halves of an inter-location transfer, separately grantable: the
  // outlet that SENDS stock and the outlet that RECEIVES it are different
  // people with different authority in most org charts.
  TRANSFER_OUT: 'stock.transfer',
  TRANSFER_IN: 'stock.transfer.receive',
  // A physical count.
  COUNT_ADJUST: 'stock.count.perform',
};

/**
 * Read the required code out of the VALIDATED input. Anything unrecognised
 * returns undefined, which the middleware turns into a refusal — never into
 * a default capability.
 */
function movementPermission(input: Record<string, unknown>): PermissionCode | undefined {
  const kind = input['sourceKind'];
  if (typeof kind !== 'string') return undefined;
  return MOVEMENT_PERMISSION[kind as DirectMovementKind];
}

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
  /**
   * The permission requirement sits AFTER .input() deliberately: the location
   * it checks and the capability it derives both come from a payload zod has
   * already validated, and a malformed payload is a BAD_REQUEST rather than a
   * FORBIDDEN that tells the device the wrong thing about why it failed.
   *
   * The middleware has already refused unless the caller holds the derived
   * capability AT input.locationId, so a manager scoped to Techiman cannot
   * adjust Wenchi's stock even though the token, the payload and the schema
   * are all perfectly well-formed.
   */
  recordMovement: tenantProcedure
    .input(recordMovementInput)
    .use(requiresPermission({ code: movementPermission, at: 'input' }))
    .mutation(async ({ ctx, input }) => {
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

  /**
   * Derived on-hand: SUM over the ledger. Never a stored counter.
   *
   * Location-scoped like the write: `stock.view` at THE LOCATION ASKED ABOUT.
   * A stock position is commercially sensitive — it is what a competitor or a
   * departing manager would most like — so the read gets the same treatment
   * as the write rather than the weaker "holds it somewhere" test.
   */
  onHand: tenantProcedure
    .input(z.object({ locationId: zUuid, productId: zUuid }).strict())
    .use(requiresPermission({ code: 'stock.view', at: 'input' }))
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
