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
import {
  lowStockInput,
  recordMovementInput,
  setReorderPointInput,
  type DirectMovementKind,
} from '@erp/contracts';
import { deterministicUuid, type PermissionCode } from '@erp/db';
import { applyReorderPoints } from '@erp/db/seed';
import type { Queryable } from '../db.js';
import { runIdempotent } from '../pipeline.js';
import { openProductTakenOffReview } from '../retired-product.js';
import {
  assertLocationInScope,
  permissionProcedure,
  requiresPermission,
  router,
  tenantProcedure,
} from '../trpc.js';
import { wire, zUuid } from '../wire.js';
import { resolveLocationScope } from './scope.js';

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
  skuCode: string;
  name: string;
  stockingUomId: string;
  qtyScale: number;
  uomCode: string;
  stockTracking: string;
  /** When the product was removed (text), or null. Only ever set under `asRecorded`. */
  removedAt: string | null;
}

/**
 * The product and its stocking unit. A REMOVED product is NOT_FOUND — unless
 * `asRecorded`, for a write a device already made: the stock moved whether or
 * not the office has since removed the product (../retired-product.ts).
 */
export async function loadProductStockInfo(
  tx: Queryable,
  productId: string,
  opts: { readonly asRecorded?: boolean } = {},
): Promise<ProductStockInfo> {
  const res = await tx.query<{
    id: string;
    sku_code: string;
    name: string;
    stocking_uom_id: string;
    qty_scale: number;
    uom_code: string;
    stock_tracking: string;
    removed_at: string | null;
  }>(
    `select p.id, p.sku_code, p.name, p.stocking_uom_id, u.qty_scale, u.code as uom_code, p.stock_tracking,
            p.deleted_at::text as removed_at
     from app.product p
     join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
     where p.id = $1${opts.asRecorded === true ? '' : ' and p.deleted_at is null'}`,
    [productId],
  );
  const row = res.rows[0];
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'product not found' });
  return {
    productId: row.id,
    skuCode: row.sku_code,
    name: row.name,
    stockingUomId: row.stocking_uom_id,
    qtyScale: row.qty_scale,
    uomCode: row.uom_code,
    stockTracking: row.stock_tracking,
    removedAt: row.removed_at,
  };
}

/**
 * ONE low-stock row, as the query below returns it. Every quantity is a
 * decimal string in the product's STOCKING unit at `qty_scale`.
 */
export interface LowStockRow {
  location_id: string;
  reorder_point_id: string;
  product_id: string;
  sku_code: string;
  product_name: string;
  qty_on_hand: string;
  reorder_point_qty: string;
  reorder_up_to_qty: string | null;
  shortfall_qty: string;
  lead_time_days: number | null;
  qty_scale: number;
  uom_code: string;
  coverage_bp: string | null;
}

/**
 * THE low-stock query — the one CLAUDE.md §3 ties Phase 2's reorder points to.
 *
 * Extracted from `lowStock` below and exported so
 * `procurement.reorderSuggestions` runs THIS query rather than a second one
 * that agrees with it today and drifts next quarter. "Reorder points tied to
 * the Phase 1 alerts" is only true if both read the same rows through the
 * same predicate: same `is_active and is_low`, same at-or-below comparison in
 * the stocking unit, same urgency ordering.
 *
 * It does NOT resolve scope. The caller resolves the readable location set
 * first (`resolveLocationScope`) and passes the ids in, so the authorisation
 * decision stays in one place and this stays a plain read.
 */
export async function selectLowStockRows(
  tx: Queryable,
  params: {
    locationIds: readonly string[];
    productIds?: readonly string[] | undefined;
    limit?: number | undefined;
  },
): Promise<LowStockRow[]> {
  const res = await tx.query<LowStockRow>(
    `select rs.location_id, rs.reorder_point_id, rs.product_id,
            p.sku_code, p.name as product_name,
            rs.qty_on_hand::text, rs.reorder_point_qty::text,
            rs.reorder_up_to_qty::text, rs.shortfall_qty::text,
            rs.lead_time_days, rs.qty_scale, u.code as uom_code,
            case when rs.reorder_point_qty > 0
                 then ((rs.qty_on_hand * 10000) / rs.reorder_point_qty)::text
                 else null end as coverage_bp
       from app.reorder_status rs
       join app.product p on p.tenant_id = rs.tenant_id and p.id = rs.product_id
       join app.unit_of_measure u on u.tenant_id = rs.tenant_id and u.id = rs.uom_id
      where rs.location_id = any($1::uuid[])
        and rs.is_active
        and rs.is_low
        and ($2::uuid[] is null or rs.product_id = any($2::uuid[]))
        and p.deleted_at is null
      order by (case when rs.reorder_point_qty > 0
                     then (rs.qty_on_hand * 10000) / rs.reorder_point_qty
                     else null end) asc nulls first,
               p.sku_code
      limit $3`,
    [
      [...params.locationIds],
      params.productIds ? [...params.productIds] : null,
      params.limit ?? 200,
    ],
  );
  return res.rows;
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
          // A device's movement of a product the office has since REMOVED still
          // lands, with a review. Switched off is not taken off for stock: an
          // outlet still counts and adjusts what it holds.
          const product = await loadProductStockInfo(tx, input.productId, { asRecorded: true });
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
              if (product.removedAt !== null) {
                await openProductTakenOffReview(atx, {
                  tenantId,
                  writeId: input.idempotencyKey,
                  hlc: ctx.deps.clock.next(),
                  entityTable: 'app.stock_movement',
                  entityId: movementId,
                  locationId: input.locationId,
                  recorded: 'A stock movement',
                  products: [
                    {
                      productId: product.productId,
                      skuCode: product.skuCode,
                      name: product.name,
                      removedAt: product.removedAt,
                      switchedOff: false,
                      lineNo: null,
                    },
                  ],
                });
              }
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

  // ═══════════════════════════════════════════════════════════════════════
  // LOW-STOCK ALERTS (CLAUDE.md §3, Phase 1) — and the Phase 2 seam
  // ═══════════════════════════════════════════════════════════════════════
  //
  // "Reorder points tied to Phase 1 alerts" is Phase 2's line in CLAUDE.md
  // §3, and the way to make that true is for both to be the SAME ROWS.
  // `app.reorder_point` (migration 0007) carries the Phase 1 threshold and,
  // unread until Phase 2, the order-up-to level and the supplier lead time.
  // There is no second notion of "how low is low" for procurement to invent.
  //
  // THE UNIT RULE, once, because it is the whole difficulty here: a threshold
  // is denominated in the product's STOCKING unit, which is the unit the
  // movement ledger is in (04 §4.4.3). 12 m rebar is stocked as countable
  // bars and sold either by the bar OR by the tonne at exactly 13500/d² bars
  // per tonne, so a threshold that followed "whichever unit was last sold"
  // would compare quantities ninety-three times apart. The wire contract
  // carries no unit, the server resolves it from the product, and 0007's
  // constraint trigger refuses a row that drifts from it. The comparison at
  // read time is therefore a bare integer comparison — no conversion, and so
  // no rounding, where an alert is decided.

  /**
   * Set (or replace) the reorder point for one product at one location.
   *
   * `stock.reorder.manage` AT THE LOCATION: the person who lives with the
   * stock-out tunes the alert. It is a capability of its own rather than a
   * reuse of `stock.adjust`, because saying what IS on the shelf and saying
   * when to shout about it are different jobs in plenty of org charts
   * (02 §2.4 granularity rule).
   *
   * Goes through the idempotent pipeline like every other write, so a
   * device that retries gets the stored response and not a second effect.
   */
  setReorderPoint: tenantProcedure
    .input(setReorderPointInput)
    .use(requiresPermission({ code: 'stock.reorder.manage', at: 'input' }))
    .mutation(async ({ ctx, input }) => {
      assertLocationInScope(ctx.identity, input.locationId);
      if (input.reorderUpToQty !== undefined && input.reorderUpToQty < input.reorderPointQty) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'reorderUpToQty must not be below reorderPointQty — Phase 2 would order a negative quantity',
        });
      }
      const result = await runIdempotent(
        { runner: ctx.deps.runner, clock: ctx.deps.clock },
        ctx.identity,
        {
          op: 'stock.set_reorder_point',
          idempotencyKey: input.idempotencyKey,
          claimedHlc: input.claimedHlc,
          clientWallAt: input.clientWallAt,
          locationId: input.locationId,
        },
        input,
        async (tx) => {
          // The unit is the SERVER'S answer, resolved from the product. The
          // client never names one, so it can never name the wrong one.
          const product = await loadProductStockInfo(tx, input.productId);
          if (product.stockTracking !== 'STOCKED') {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'a non-stocked product has no stock to run low',
            });
          }
          const loc = await tx.query<{ id: string; kind: string }>(
            `select id, kind from app.location where id = $1 and deleted_at is null`,
            [input.locationId],
          );
          const location = loc.rows[0];
          if (!location) throw new TRPCError({ code: 'NOT_FOUND', message: 'location not found' });
          if (location.kind !== 'OUTLET' && location.kind !== 'WAREHOUSE') {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'reorder points belong to locations that hold stock',
            });
          }

          const existing = await tx.query<{ id: string }>(
            `select id from app.reorder_point
              where location_id = $1 and product_id = $2 and deleted_at is null`,
            [input.locationId, input.productId],
          );
          const created = existing.rows.length === 0;
          const rowId = existing.rows[0]?.id ?? deterministicUuid(input.idempotencyKey, 'reorder_point');
          const isActive = input.isActive ?? true;

          const response = {
            reorderPointId: rowId,
            created,
            locationId: input.locationId,
            productId: input.productId,
            reorderPointQty: wire(input.reorderPointQty),
            reorderUpToQty: input.reorderUpToQty === undefined ? null : wire(input.reorderUpToQty),
            leadTimeDays: input.leadTimeDays ?? null,
            isActive,
            /** The server's unit, echoed so a client can label the number. */
            qtyScale: product.qtyScale,
            uomCode: product.uomCode,
          };
          return {
            response,
            apply: async (atx) => {
              await atx.query(
                `insert into app.reorder_point
                   (tenant_id, id, write_id, hlc, location_id, product_id, uom_id, qty_scale,
                    reorder_point_qty, reorder_up_to_qty, lead_time_days, is_active, notes)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                 on conflict (tenant_id, location_id, product_id) where deleted_at is null
                 do update set reorder_point_qty = excluded.reorder_point_qty,
                               reorder_up_to_qty = excluded.reorder_up_to_qty,
                               lead_time_days    = excluded.lead_time_days,
                               is_active         = excluded.is_active,
                               notes             = excluded.notes,
                               write_id          = excluded.write_id,
                               hlc               = excluded.hlc,
                               updated_at        = transaction_timestamp()`,
                [
                  ctx.identity.tenantId,
                  rowId,
                  input.idempotencyKey,
                  ctx.deps.clock.next(),
                  input.locationId,
                  input.productId,
                  product.stockingUomId,
                  product.qtyScale,
                  wire(input.reorderPointQty),
                  input.reorderUpToQty === undefined ? null : wire(input.reorderUpToQty),
                  input.leadTimeDays ?? null,
                  isActive,
                  input.notes ?? null,
                ],
              );
            },
          };
        },
      );
      return result.response;
    }),

  /**
   * Seed thresholds for the SKUs a location DEMONSTRABLY CARRIES, from its
   * own ledger (see `applyReorderPoints` in `@erp/db/seed` for why this is
   * not a row per location × catalogue, and for the honest provenance of the
   * level it seeds). Additive and idempotent: a threshold somebody has since
   * tuned is never overwritten, and a SKU that arrives later gets its row on
   * the next run.
   */
  ensureReorderPoints: tenantProcedure
    .input(z.object({ locationId: zUuid }).strict())
    .use(requiresPermission({ code: 'stock.reorder.manage', at: 'input' }))
    .mutation(async ({ ctx, input }) => {
      assertLocationInScope(ctx.identity, input.locationId);
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, (tx) =>
        applyReorderPoints(tx, ctx.identity.tenantId, { locationId: input.locationId }),
      );
    }),

  /** The thresholds configured at one location — the management list. */
  reorderPoints: tenantProcedure
    .input(z.object({ locationId: zUuid }).strict())
    .use(requiresPermission({ code: 'stock.view', at: 'input' }))
    .query(async ({ ctx, input }) => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const res = await tx.query<{
          reorder_point_id: string;
          product_id: string;
          sku_code: string;
          product_name: string;
          reorder_point_qty: string;
          reorder_up_to_qty: string | null;
          lead_time_days: number | null;
          qty_scale: number;
          uom_code: string;
          qty_on_hand: string;
          is_low: boolean;
          is_active: boolean;
        }>(
          `select rs.reorder_point_id, rs.product_id, p.sku_code, p.name as product_name,
                  rs.reorder_point_qty::text, rs.reorder_up_to_qty::text, rs.lead_time_days,
                  rs.qty_scale, u.code as uom_code, rs.qty_on_hand::text, rs.is_low,
                  rs.is_active
             from app.reorder_status rs
             join app.product p on p.tenant_id = rs.tenant_id and p.id = rs.product_id
             join app.unit_of_measure u on u.tenant_id = rs.tenant_id and u.id = rs.uom_id
            where rs.location_id = $1
            order by p.sku_code`,
          [input.locationId],
        );
        return {
          locationId: input.locationId,
          points: res.rows.map((r) => ({
            reorderPointId: r.reorder_point_id,
            productId: r.product_id,
            skuCode: r.sku_code,
            productName: r.product_name,
            /** Every quantity below is in the STOCKING unit at qtyScale. */
            reorderPointQty: r.reorder_point_qty,
            reorderUpToQty: r.reorder_up_to_qty,
            leadTimeDays: r.lead_time_days,
            qtyOnHand: r.qty_on_hand,
            isLow: r.is_low,
            /**
             * A switched-off threshold raises no alert but STAYS ON THIS
             * LIST. Filtering it here would make it unfindable and therefore
             * impossible to switch back on.
             */
            isActive: r.is_active,
            qtyScale: r.qty_scale,
            uomCode: r.uom_code,
          })),
        };
      });
    }),

  /**
   * THE LOW-STOCK ALERT: what is at or below its reorder point, per location,
   * most urgent first.
   *
   * Guarded by `stock.view`, not by a reporting capability, and scoped the
   * same way every other cross-location read is — resolved per request from
   * `app.effective_permission`. Counter staff hold `stock.view` at their own
   * outlet and therefore see their own outlet's alerts, which is the point:
   * the person who has to tell a customer "we're out of cement" should see it
   * coming. A grant at a region node expands down the closure, so a regional
   * manager gets every outlet under them and a head of operations gets the
   * network — with no code anywhere asking how deep a region is.
   *
   * URGENCY is `coverageBp` — on-hand as basis points of the threshold — and
   * NOT the raw shortfall, because shortfalls in different units are not
   * comparable: 40 bars short and 40 tonnes short are not the same emergency.
   * A ratio is dimensionless, so it orders correctly across the whole
   * catalogue. It is an integer ratio computed by truncating division; it is
   * an ORDERING KEY and nothing is ever costed or ordered from it.
   *
   * `coverageBp` is null when the threshold is zero ("tell me only when it is
   * actually gone"), and null sorts FIRST because that product is gone.
   */
  lowStock: permissionProcedure({ code: 'stock.view', at: 'any' })
    .input(lowStockInput)
    .query(async ({ ctx, input }) => {
      const scope = await resolveLocationScope(ctx, {
        code: 'stock.view',
        requested: input.locationIds,
        kinds: ['OUTLET', 'WAREHOUSE'],
      });

      const rows = await ctx.deps.runner.withTenant(ctx.identity.tenantId, (tx) =>
        selectLowStockRows(tx, {
          locationIds: scope.locationIds,
          productIds: input.productIds,
          limit: input.limit,
        }),
      );

      const byLocation = new Map<string, typeof rows>();
      for (const r of rows) {
        const list = byLocation.get(r.location_id) ?? [];
        list.push(r);
        byLocation.set(r.location_id, list);
      }

      return {
        scope: { locationCount: scope.locations.length },
        alertCount: rows.length,
        /** Flat, already in urgency order — the list a manager reads top-down. */
        alerts: rows.map((r) => ({
          locationId: r.location_id,
          reorderPointId: r.reorder_point_id,
          productId: r.product_id,
          skuCode: r.sku_code,
          productName: r.product_name,
          /** All quantities in the STOCKING unit at qtyScale (decimal strings). */
          qtyOnHand: r.qty_on_hand,
          reorderPointQty: r.reorder_point_qty,
          reorderUpToQty: r.reorder_up_to_qty,
          shortfallQty: r.shortfall_qty,
          leadTimeDays: r.lead_time_days,
          qtyScale: r.qty_scale,
          uomCode: r.uom_code,
          /** On-hand as basis points of the threshold. Ordering key only. */
          coverageBp: r.coverage_bp,
        })),
        locations: scope.locations.map((l) => ({
          locationId: l.id,
          locationCode: l.code,
          locationName: l.name,
          alertCount: (byLocation.get(l.id) ?? []).length,
        })),
      };
    }),
});
