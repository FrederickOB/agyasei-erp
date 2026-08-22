/**
 * Receiving — goods receipts, matched against purchase orders.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * SCOPE: `app.goods_receipt`, `app.goods_receipt_line`, and the
 *        `app.stock_movement` rows a receipt APPENDS.
 * ═════════════════════════════════════════════════════════════════════════
 *
 * ---------------------------------------------------------------------------
 * THE ONE CONTROL THIS ROUTER EXISTS TO HOLD
 * ---------------------------------------------------------------------------
 * `goods.receive` IS NOT `purchase.order.approve`. One person who can both
 * authorise an order and sign for its goods can fabricate a receipt against an
 * order they invented: the stock ledger records inventory that never arrived
 * and accounts payable pays for it. Migration 0009 states it, migration 0008
 * backs it (a receipt is refused against anything but an APPROVED or
 * PARTIALLY_RECEIVED order), and the template puts the two capabilities in
 * different roles. Nothing here undoes any of that.
 *
 * `goods.receive` is also NOT `stock.receive`. `stock.receive` guards a
 * RECEIPT-kind movement written DIRECTLY through `inventory.recordMovement` —
 * an opening balance, stock that arrived with no document. `goods.receive`
 * guards the receipt DOCUMENT, which appends the movements itself.
 *
 * ---------------------------------------------------------------------------
 * SHORT, OVER AND SUBSTITUTE DELIVERIES ARE NORMAL TRADE, NOT ERRORS
 * ---------------------------------------------------------------------------
 * Ten tonnes ordered, nine and a half delivered, 190 bags counted off the
 * truck are THREE FACTS, not one fact and two mistakes. A receipt that does
 * not match its order is recorded, with the variance visible on every line and
 * summarised on the response — because refusing it means the yard writes it on
 * paper and the system is wrong by lunchtime. The only things refused here are
 * the ones that would corrupt the ledger: a unit the product cannot be bought
 * in, a quantity that disagrees with its own conversion and nobody signed for,
 * an order that was never authorised.
 *
 * ---------------------------------------------------------------------------
 * TWO QUANTITIES, AND NEITHER IS DERIVED FROM THE OTHER
 * ---------------------------------------------------------------------------
 * `qtyReceived` is what the supplier invoiced, in THEIR unit; `qtyStock` is
 * what entered the yard, in the product's stocking unit, and is the only
 * figure the movement ledger sees. The server computes `qty_stock_computed`
 * from the SNAPSHOTTED conversion factor; where the yard's count differs, the
 * line needs `confirmConversion` and the server stamps
 * `conversion_confirmed_by` (04 §4.4.4). The column CHECK refuses the row
 * otherwise, so this is not optional politeness.
 *
 * ---------------------------------------------------------------------------
 * A SIGNATURE IS NOT A BLANK CHEQUE: `product_uom.tolerance_bp` IS READ
 * ---------------------------------------------------------------------------
 * 04 §4.4.4 makes `tolerance_bp` the bound on how far a confirmed quantity may
 * sit from the computed conversion, and gives the excess a name:
 * `CONVERSION_OUT_OF_TOLERANCE`, a review item. Without that half, one tap of
 * `confirmConversion` admits 290 bars against a computed 281 — the invoice
 * says three tonnes, the ledger says nine bars more than three tonnes can be,
 * and nothing anywhere says so. The excess is NOT refused (the goods are in
 * the yard either way, and a refusal is how a yard learns to keep its own
 * book); it is recorded and it opens a review, routed by the catalogued
 * `sync.conflict.review` capability — never a code minted here, which is
 * `docs/phase1-status.md` §0 row 7 verbatim.
 *
 * The test is CROSS-MULTIPLIED, never a division:
 * `|qtyStock − computed| × 10000 ≤ tolerance_bp × computed`. Dividing first
 * would round the deviation, and the template's own rule for authoring a
 * tolerance — `ceil(10000 / computed)`, one stocking unit of slack — sits
 * exactly on the boundary a rounded comparison gets wrong.
 *
 * ---------------------------------------------------------------------------
 * UNITS GO THROUGH THE SAME `product_uom` MACHINERY AS SELLING (04 §4.10)
 * ---------------------------------------------------------------------------
 * Cement bought by the tonne and sold by the 50 kg bag is the same conversion
 * problem as rebar stocked by the 12 m bar and sold by the tonne, in the
 * opposite direction. A purchase unit is a live `product_uom` row with
 * `can_buy`; the rational factor is resolved once and SNAPSHOTTED onto the
 * receipt line, exactly as `sale_line` snapshots a selling conversion, so
 * correcting a factor tomorrow cannot restate a historical document.
 *
 * ---------------------------------------------------------------------------
 * OFFLINE: THIS IS AN OUTBOX WRITE, AND IT HAD TO BE
 * ---------------------------------------------------------------------------
 * Stock arrives at a yard whose connectivity is unreliable for days. The goods
 * are PHYSICALLY THERE; refusing to record them until the radio comes back
 * teaches staff to write it on paper, and paper never reaches the ledger.
 * `goods.record_receipt` is therefore registered in `DEVICE_OP_KINDS` against
 * `recordGoodsReceiptInput` and dispatched by `apps/api/src/sync.ts`, so a
 * queued receipt rides the same ordered outbox, the same client idempotency
 * key and the same `runIdempotent` pipeline as a stock adjustment. A byte
 * identical retry replays the stored response and appends NO second movement —
 * which is the double-count CLAUDE.md §2.2 forbids, closed by the pipeline
 * rather than by a counter somebody remembers to check.
 *
 * What is NOT offline, and why: nothing in this file reads a price list, a
 * credit bound or an approval ceiling, so there is no stale server-side figure
 * a partitioned device could disagree with. The one thing a device cannot know
 * offline is whether the order is still APPROVED — and that is checked by the
 * DATABASE at apply time, when the write finally lands, not by the device.
 */
import { TRPCError } from '@trpc/server';
import {
  goodsReceiptInput,
  purchaseOrderReceiptStatusInput,
  recordGoodsReceiptInput,
} from '@erp/contracts';
import { deterministicUuid } from '@erp/db';
import { divRound, lineNetMinor, mulDiv } from '@erp/money';
import type { Queryable } from '../db.js';
import { runIdempotent } from '../pipeline.js';
import {
  assertLocationInScope,
  permissionProcedure,
  requiresPermission,
  router,
  tenantProcedure,
} from '../trpc.js';
import { wire } from '../wire.js';
import { openConflictReview } from './sequence.js';

/**
 * The PLATFORM document kind an inbound receipt movement carries — one of
 * `app.stock_movement.source_kind`'s closed enum values (04 §4.7.1).
 *
 * It is also the code of the `app.movement_reason` row a receipt attaches to,
 * and that deserves a sentence because the alternative looks tempting.
 * `reason_id` is NOT NULL and the wire contract carries no reason: a receipt
 * is a document, and which document produced a movement is platform structure,
 * not a yard's choice of words. So the reason row is derived from the PLATFORM
 * source kind — never from a tenant's own reason vocabulary, which is editable
 * data no platform code may branch on (CLAUDE.md §2.9). This is the same shape
 * `sales.ts` uses for its SALE-sourced movements, and the row is created once,
 * deterministically, so a tenant that renames it keeps its own name.
 */
const RECEIPT_SOURCE_KIND = 'RECEIPT';

/**
 * The conflict class 04 §4.4.4 names for a confirmed quantity that sits
 * further from its own conversion than the unit's tolerance allows, and
 * §4.12 lists as one of this section's two contributed classes.
 */
const CONVERSION_CLASS = 'CONVERSION_OUT_OF_TOLERANCE';
/**
 * Severity 2, not 1. The goods are in the yard and the movement stands, so
 * nothing is blocked; but somebody is being invoiced for a quantity the yard
 * did not count, and that is a claim against a supplier which goes stale.
 */
const CONVERSION_SEVERITY = 2;
/**
 * Routed by a code that EXISTS in `platform.permission` — the same one
 * `sequence.ts` and `sales.ts` route their reviews by. A queue keyed on a
 * capability no tenant can grant is a queue nobody reads (phase1-status §0).
 */
const REVIEW_PERMISSION = 'sync.conflict.review';

/** How a receipt line stands against the order line it was matched to. */
type LineVariance = 'MATCHED' | 'SHORT' | 'OVER' | 'UNMATCHED_EXTRA' | 'NO_ORDER';

/**
 * Is a counted quantity within the unit's stated tolerance of the computed
 * conversion? Cross-multiplied, so nothing rounds: `tolerance_bp` is authored
 * as `ceil(10000 / computed)` — one stocking unit of slack — and a rounded
 * deviation lands on the wrong side of exactly that boundary.
 */
function withinTolerance(counted: bigint, computed: bigint, toleranceBp: bigint): boolean {
  const deviation = counted > computed ? counted - computed : computed - counted;
  return deviation * 10000n <= toleranceBp * computed;
}

/** Deviation in basis points, for a human to read. Reported, never compared. */
function deviationBp(counted: bigint, computed: bigint): bigint {
  const deviation = counted > computed ? counted - computed : computed - counted;
  return computed === 0n ? 0n : divRound(deviation * 10000n, computed, 'half-up');
}

interface PurchaseOrderHead {
  id: string;
  supplierId: string;
  deliverToLocationId: string;
  status: string;
}

interface OrderLineStatus {
  purchaseOrderLineId: string;
  lineNo: number;
  productId: string;
  uomId: string;
  qtyScale: number;
  qtyOrdered: bigint;
  /** Summed from receipt lines ALREADY matched to it. Never a counter. */
  qtyReceivedBefore: bigint;
}

/**
 * The order this receipt is being matched against.
 *
 * `forUpdate` is passed on the WRITE path and nowhere else, and it is not
 * decoration. Two receipts against one order, each completing a different
 * line, both read `purchase_order_line_status` before either commits: each
 * sees the other's line outstanding, each writes PARTIALLY_RECEIVED, and an
 * order that is fully received reads as part-delivered until somebody notices.
 * The same window makes `qtyReceivedBefore` on the response stale. Taking the
 * order row's lock serialises receipts against ONE order — receipts against
 * different orders never contend — and leaves the derived view, which is the
 * truth either way, and the cached status agreeing.
 *
 * It is still a READ: `plan()` may not write (03 §3.3.3), and a row lock is
 * not a write.
 */
async function loadOrderHead(
  tx: Queryable,
  purchaseOrderId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<PurchaseOrderHead | undefined> {
  const res = await tx.query<{
    id: string;
    supplier_id: string;
    deliver_to_location_id: string;
    status: string;
  }>(
    `select id, supplier_id, deliver_to_location_id, status
       from app.purchase_order
      where id = $1 and deleted_at is null${opts.forUpdate === true ? ' for update' : ''}`,
    [purchaseOrderId],
  );
  const row = res.rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    supplierId: row.supplier_id,
    deliverToLocationId: row.deliver_to_location_id,
    status: row.status,
  };
}

/**
 * Ordered versus received per line, from `app.purchase_order_line_status` —
 * the DERIVED view (0008), which sums matched receipt lines and caches
 * nothing. The matching trigger guarantees every summed line is in the order
 * line's own unit at its own scale, so this is a comparison of like with like.
 */
async function loadOrderLineStatus(
  tx: Queryable,
  purchaseOrderId: string,
): Promise<OrderLineStatus[]> {
  const res = await tx.query<{
    purchase_order_line_id: string;
    line_no: number;
    product_id: string;
    uom_id: string;
    qty_scale: number;
    qty_ordered: string;
    qty_received: string;
  }>(
    `select purchase_order_line_id, line_no, product_id, uom_id, qty_scale,
            qty_ordered::text, qty_received::text
       from app.purchase_order_line_status
      where purchase_order_id = $1
      order by line_no`,
    [purchaseOrderId],
  );
  return res.rows.map((r) => ({
    purchaseOrderLineId: r.purchase_order_line_id,
    lineNo: r.line_no,
    productId: r.product_id,
    uomId: r.uom_id,
    qtyScale: r.qty_scale,
    qtyOrdered: BigInt(r.qty_ordered),
    qtyReceivedBefore: BigInt(r.qty_received),
  }));
}

export const receivingRouter = router({
  /**
   * Post a goods receipt: what the supplier invoiced, what entered the yard,
   * and the movements the yard's balance is the sum of.
   *
   * The permission requirement sits AFTER `.input()` so the location it checks
   * comes from a payload zod has already validated — a malformed payload is a
   * BAD_REQUEST, never a FORBIDDEN that tells a device the wrong thing about
   * why it failed. `goods.receive` is required AT THE RECEIVING LOCATION: a
   * manager who may sign for goods at Techiman may not sign for them at
   * Wenchi, and the same check runs whether the call arrives online or is
   * drained out of a device's outbox three days later.
   */
  recordReceipt: tenantProcedure
    .input(recordGoodsReceiptInput)
    .use(requiresPermission({ code: 'goods.receive', at: 'input' }))
    .mutation(async ({ ctx, input }) => {
      assertLocationInScope(ctx.identity, input.locationId);

      const lineNos = new Set(input.lines.map((l) => l.lineNo));
      if (lineNos.size !== input.lines.length) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'receipt line numbers must be distinct — two lines with one number is one line the yard cannot point at',
        });
      }

      const tenantId = ctx.identity.tenantId;
      const key = input.idempotencyKey;
      const clock = ctx.deps.clock;
      const receivedAt = input.receivedAt ?? new Date().toISOString();

      const result = await runIdempotent(
        { runner: ctx.deps.runner, clock },
        ctx.identity,
        {
          op: 'goods.record_receipt',
          idempotencyKey: key,
          claimedHlc: input.claimedHlc,
          clientWallAt: input.clientWallAt,
          locationId: input.locationId,
        },
        input,
        async (tx) => {
          // ---- the receiving location ------------------------------------
          const loc = await tx.query<{ id: string; kind: string }>(
            `select id, kind from app.location where id = $1 and deleted_at is null`,
            [input.locationId],
          );
          const location = loc.rows[0];
          if (!location) throw new TRPCError({ code: 'NOT_FOUND', message: 'location not found' });
          if (location.kind !== 'OUTLET' && location.kind !== 'WAREHOUSE') {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'goods can only be received where stock is held',
            });
          }

          // ---- the supplier ----------------------------------------------
          // A DEACTIVATED supplier is not refused here on purpose: the truck
          // arrived, the goods are in the yard, and refusing the record does
          // not send them back. Deactivation stops new ORDERS, not reality.
          const sup = await tx.query<{ id: string }>(
            `select id from app.supplier where id = $1 and deleted_at is null`,
            [input.supplierId],
          );
          if (!sup.rows[0]) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'supplier not found' });
          }

          // ---- the order, if there is one --------------------------------
          //
          // `purchaseOrderId` is optional because a receipt with no order
          // genuinely happens — an emergency collection, a returned delivery.
          // Where there IS one, it must be the same supplier's and must
          // already be authorised: a receipt cannot precede its own approval.
          let order: PurchaseOrderHead | undefined;
          let orderLines: OrderLineStatus[] = [];
          if (input.purchaseOrderId !== undefined) {
            order = await loadOrderHead(tx, input.purchaseOrderId, { forUpdate: true });
            if (!order) {
              throw new TRPCError({ code: 'NOT_FOUND', message: 'purchase order not found' });
            }
            if (order.supplierId !== input.supplierId) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: 'the receipt names a different supplier from the order — a receipt names the party that delivered it',
              });
            }
            if (order.status !== 'APPROVED' && order.status !== 'PARTIALLY_RECEIVED') {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message:
                  `purchase order is ${order.status} — goods may only be received against an APPROVED or ` +
                  'PARTIALLY_RECEIVED order. Approving an order and signing for its goods are separate acts ' +
                  'held by separate capabilities (purchase.order.approve, goods.receive)',
              });
            }
            orderLines = await loadOrderLineStatus(tx, order.id);
          }

          const byOrderLineId = new Map(orderLines.map((l) => [l.purchaseOrderLineId, l]));
          /** Received on THIS receipt, per order line, in the order line's unit. */
          const receivedNow = new Map<string, bigint>();

          const planned: {
            lineNo: number;
            goodsReceiptLineId: string;
            purchaseOrderLineId: string | null;
            productId: string;
            stockTracking: string;
            uomId: string;
            uomCode: string;
            qtyReceived: bigint;
            qtyReceivedScale: number;
            stockingUomId: string;
            stockingUomCode: string;
            qtyStock: bigint;
            qtyStockComputed: bigint;
            qtyStockScale: number;
            factorNum: bigint;
            factorDen: bigint;
            conversionConfirmed: boolean;
            toleranceBp: bigint;
            deviationBp: bigint;
            outOfTolerance: boolean;
            unitCostE4: bigint;
            stockUnitCostE4: bigint;
            lineNetMinor: bigint;
            stockValuationMinor: bigint;
            variance: LineVariance;
            qtyOrdered: bigint | null;
            qtyReceivedBefore: bigint | null;
            qtyOutstandingAfter: bigint | null;
          }[] = [];

          for (const line of input.lines) {
            // ---- the product and its stocking unit ------------------------
            const prod = await tx.query<{
              id: string;
              is_purchasable: boolean;
              stock_tracking: string;
              stocking_uom_id: string;
              stocking_scale: number;
              stocking_code: string;
            }>(
              `select p.id, p.is_purchasable, p.stock_tracking, p.stocking_uom_id,
                      u.qty_scale as stocking_scale, u.code as stocking_code
                 from app.product p
                 join app.unit_of_measure u
                   on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
                where p.id = $1 and p.deleted_at is null`,
              [line.productId],
            );
            const product = prod.rows[0];
            if (!product) {
              throw new TRPCError({ code: 'NOT_FOUND', message: `product ${line.productId} not found` });
            }
            if (!product.is_purchasable) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: `product ${line.productId} is not purchasable`,
              });
            }

            // ---- the purchase unit: THE SAME product_uom MACHINERY --------
            //
            // `can_buy`, not `can_sell`. A unit the product cannot be bought
            // in has no conversion factor into the stocking unit the ledger is
            // denominated in, so a receipt in it could not become a movement.
            const puom = await tx.query<{
              uom_id: string;
              factor_num: string;
              factor_den: string;
              tolerance_bp: string;
              qty_scale: number;
              code: string;
            }>(
              `select pu.uom_id, pu.factor_num::text, pu.factor_den::text,
                      pu.tolerance_bp::text, u.qty_scale, u.code
                 from app.product_uom pu
                 join app.unit_of_measure u on u.tenant_id = pu.tenant_id and u.id = pu.uom_id
                where pu.product_id = $1 and pu.uom_id = $2
                  and pu.deleted_at is null and pu.can_buy`,
              [line.productId, line.uomId],
            );
            const buy = puom.rows[0];
            if (!buy) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message:
                  `unit ${line.uomId} is not a buyable unit of product ${line.productId} — a purchase unit ` +
                  'must be a live product_uom row with can_buy (04 §4.10)',
              });
            }
            const factorNum = BigInt(buy.factor_num);
            const factorDen = BigInt(buy.factor_den);
            const toleranceBp = BigInt(buy.tolerance_bp);

            // ---- what the conversion SAYS entered the yard ----------------
            // §4.13 row 1: rounded once, half-up, at the stocking scale. The
            // identical expression sales.ts uses in the opposite direction.
            const qtyStockComputed = mulDiv(
              line.qtyReceived,
              factorNum * 10n ** BigInt(product.stocking_scale),
              factorDen * 10n ** BigInt(buy.qty_scale),
              'half-up',
            );
            if (qtyStockComputed <= 0n) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `line ${line.lineNo}: the received quantity converts to zero stocking units`,
              });
            }

            // ---- what the YARD counted, which is a different fact ---------
            const conversionConfirmed = line.qtyStock !== qtyStockComputed;
            if (conversionConfirmed && line.confirmConversion !== true) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message:
                  `line ${line.lineNo}: ${wire(line.qtyStock)} ${product.stocking_code} was counted but the ` +
                  `conversion from ${wire(line.qtyReceived)} ${buy.code} gives ${wire(qtyStockComputed)}. ` +
                  'Both figures are recorded, but somebody has to sign for the difference — resend with ' +
                  'confirmConversion (04 §4.4.4).',
              });
            }
            // A signature covers the unit's stated slack. Beyond it the line
            // is still recorded — the goods are in the yard — and a review is
            // opened below, in the same transaction as the receipt.
            const outOfTolerance =
              conversionConfirmed && !withinTolerance(line.qtyStock, qtyStockComputed, toleranceBp);

            // ---- cost ------------------------------------------------------
            // §4.13 row 3: the extended amount is rounded ONCE, on the
            // extended amount, never on the unit price.
            const netMinor = lineNetMinor(
              line.qtyReceived,
              buy.qty_scale,
              line.unitCostE4,
              'half-up',
            );
            // §4.13 row 9: purchase-unit cost → stocking-unit cost. One
            // purchase unit is factor_num/factor_den stocking units, so the
            // cost per stocking unit divides by that ratio. Cost per tonne →
            // cost per bar at 13500/d² does not divide evenly; it is rounded
            // once, half-up, at rate_e4, and the residual is reported below
            // rather than absorbed.
            const stockUnitCostE4 = divRound(line.unitCostE4 * factorDen, factorNum, 'half-up');
            const stockValuationMinor = lineNetMinor(
              line.qtyStock,
              product.stocking_scale,
              stockUnitCostE4,
              'half-up',
            );

            // ---- matching --------------------------------------------------
            let variance: LineVariance = order ? 'UNMATCHED_EXTRA' : 'NO_ORDER';
            let qtyOrdered: bigint | null = null;
            let qtyReceivedBefore: bigint | null = null;
            let qtyOutstandingAfter: bigint | null = null;

            if (line.purchaseOrderLineId !== undefined) {
              if (!order) {
                throw new TRPCError({
                  code: 'BAD_REQUEST',
                  message: `line ${line.lineNo}: the receipt names no purchase order, so it cannot match an order line`,
                });
              }
              const pol = byOrderLineId.get(line.purchaseOrderLineId);
              if (!pol) {
                throw new TRPCError({
                  code: 'PRECONDITION_FAILED',
                  message: `line ${line.lineNo}: order line ${line.purchaseOrderLineId} does not belong to this receipt's order`,
                });
              }
              if (pol.productId !== line.productId) {
                throw new TRPCError({
                  code: 'PRECONDITION_FAILED',
                  message: `line ${line.lineNo}: the order line is for a different product — record a substitute as an unmatched line instead`,
                });
              }
              if (pol.uomId !== line.uomId || pol.qtyScale !== buy.qty_scale) {
                throw new TRPCError({
                  code: 'PRECONDITION_FAILED',
                  message:
                    `line ${line.lineNo}: the order line is denominated in another unit — received cannot be ` +
                    'summed against ordered across two units (0008 goods_receipt_line_matches)',
                });
              }
              const already = receivedNow.get(pol.purchaseOrderLineId) ?? 0n;
              receivedNow.set(pol.purchaseOrderLineId, already + line.qtyReceived);
              qtyOrdered = pol.qtyOrdered;
              qtyReceivedBefore = pol.qtyReceivedBefore;
              qtyOutstandingAfter =
                pol.qtyOrdered - (pol.qtyReceivedBefore + already + line.qtyReceived);
              // Signed, never clamped: an over-delivery is the one an invoice
              // will be raised for, and hiding it is how it gets paid twice.
              variance =
                qtyOutstandingAfter === 0n ? 'MATCHED' : qtyOutstandingAfter > 0n ? 'SHORT' : 'OVER';
            }

            planned.push({
              lineNo: line.lineNo,
              goodsReceiptLineId: deterministicUuid(key, 'goods_receipt_line', String(line.lineNo)),
              purchaseOrderLineId: line.purchaseOrderLineId ?? null,
              productId: product.id,
              stockTracking: product.stock_tracking,
              uomId: buy.uom_id,
              uomCode: buy.code,
              qtyReceived: line.qtyReceived,
              qtyReceivedScale: buy.qty_scale,
              stockingUomId: product.stocking_uom_id,
              stockingUomCode: product.stocking_code,
              qtyStock: line.qtyStock,
              qtyStockComputed,
              qtyStockScale: product.stocking_scale,
              factorNum,
              factorDen,
              conversionConfirmed,
              toleranceBp,
              deviationBp: conversionConfirmed ? deviationBp(line.qtyStock, qtyStockComputed) : 0n,
              outOfTolerance,
              unitCostE4: line.unitCostE4,
              stockUnitCostE4,
              lineNetMinor: netMinor,
              stockValuationMinor,
              variance,
              qtyOrdered,
              qtyReceivedBefore,
              qtyOutstandingAfter,
            });
          }

          // ---- where the order stands AFTER this receipt -------------------
          //
          // Derived, in the plan, from the view's own figures plus this
          // receipt's lines — never from a stored counter, and computed here
          // because `runIdempotent` stores the response BEFORE the effect is
          // applied (the registry is append-only; there is no post-hoc UPDATE).
          let orderAfter: {
            purchaseOrderId: string;
            statusBefore: string;
            statusAfter: string;
            changed: boolean;
            lineCount: number;
            linesFullyReceived: number;
          } | null = null;
          if (order) {
            let fully = 0;
            let anyReceived = false;
            for (const pol of orderLines) {
              const total = pol.qtyReceivedBefore + (receivedNow.get(pol.purchaseOrderLineId) ?? 0n);
              if (total > 0n) anyReceived = true;
              if (total >= pol.qtyOrdered) fully += 1;
            }
            const allFully = orderLines.length > 0 && fully === orderLines.length;
            // A receipt carrying ONLY unordered extras advances nothing:
            // nothing on the order has arrived, and saying otherwise would
            // make "partially received" mean "somebody delivered something".
            const target = allFully
              ? 'RECEIVED'
              : anyReceived
                ? 'PARTIALLY_RECEIVED'
                : order.status;
            orderAfter = {
              purchaseOrderId: order.id,
              statusBefore: order.status,
              statusAfter: target,
              changed: target !== order.status,
              lineCount: orderLines.length,
              linesFullyReceived: fully,
            };
          }

          const goodsReceiptId = deterministicUuid(key, 'goods_receipt');
          const reasonId = deterministicUuid(tenantId, 'api', `movement_reason:${RECEIPT_SOURCE_KIND}`);
          const userId = ctx.identity.userId;
          const stocked = planned.filter((l) => l.stockTracking === 'STOCKED');

          const response = {
            goodsReceiptId,
            purchaseOrderId: input.purchaseOrderId ?? null,
            supplierId: input.supplierId,
            locationId: input.locationId,
            businessDate: input.businessDate,
            receivedAt,
            supplierDeliveryNoteRef: input.supplierDeliveryNoteRef ?? null,
            supplierInvoiceRef: input.supplierInvoiceRef ?? null,
            /**
             * The truck can be diverted. A receipt at a location the order did
             * not name is recorded and FLAGGED, never refused — the goods are
             * there either way, and a flag is how somebody finds out.
             */
            deliveredToOrderedLocation:
              order === undefined ? null : order.deliverToLocationId === input.locationId,
            lines: planned.map((l) => ({
              goodsReceiptLineId: l.goodsReceiptLineId,
              lineNo: l.lineNo,
              purchaseOrderLineId: l.purchaseOrderLineId,
              productId: l.productId,
              /** What was INVOICED, in the supplier's unit, at its scale. */
              uomId: l.uomId,
              uomCode: l.uomCode,
              qtyReceived: wire(l.qtyReceived),
              qtyReceivedScale: l.qtyReceivedScale,
              /** What ENTERED THE YARD, in the stocking unit, at its scale. */
              stockingUomId: l.stockingUomId,
              stockingUomCode: l.stockingUomCode,
              qtyStock: wire(l.qtyStock),
              qtyStockComputed: wire(l.qtyStockComputed),
              qtyStockScale: l.qtyStockScale,
              factorNum: wire(l.factorNum),
              factorDen: wire(l.factorDen),
              /** True when the yard's count differed and a human signed for it. */
              conversionConfirmed: l.conversionConfirmed,
              /** The unit's stated slack, and how far this line actually sat. */
              toleranceBp: wire(l.toleranceBp),
              deviationBp: wire(l.deviationBp),
              /**
               * Signed for, recorded, AND flagged: past the unit's tolerance
               * the difference between what was invoiced and what was counted
               * is a claim against a supplier, and it opens a review rather
               * than resting on one tap (04 §4.4.4).
               */
              outOfTolerance: l.outOfTolerance,
              conversionReviewId: l.outOfTolerance
                ? deterministicUuid(key, 'conflict_review', `conversion:${l.lineNo}`)
                : null,
              unitCostE4: wire(l.unitCostE4),
              stockUnitCostE4: wire(l.stockUnitCostE4),
              lineNetMinor: wire(l.lineNetMinor),
              stockValuationMinor: wire(l.stockValuationMinor),
              /**
               * Invoiced value minus the value that entered stock. It is
               * non-zero whenever the delivery was short or over, or when the
               * unit-cost conversion did not divide evenly (§4.13 row 9). It
               * is REPORTED so Phase 3's GL can post it as a purchase price
               * variance; nothing here absorbs it.
               */
              conversionResidualMinor: wire(l.lineNetMinor - l.stockValuationMinor),
              variance: l.variance,
              qtyOrdered: l.qtyOrdered === null ? null : wire(l.qtyOrdered),
              qtyReceivedBefore: l.qtyReceivedBefore === null ? null : wire(l.qtyReceivedBefore),
              qtyOutstandingAfter:
                l.qtyOutstandingAfter === null ? null : wire(l.qtyOutstandingAfter),
              stockMovementId:
                l.stockTracking === 'STOCKED'
                  ? deterministicUuid(key, 'stock_movement', String(l.lineNo))
                  : null,
            })),
            totals: {
              lineCount: planned.length,
              /** Exact bigint sums of the once-rounded parts. */
              lineNetMinor: wire(planned.reduce((a, l) => a + l.lineNetMinor, 0n)),
              stockValuationMinor: wire(planned.reduce((a, l) => a + l.stockValuationMinor, 0n)),
              conversionResidualMinor: wire(
                planned.reduce((a, l) => a + (l.lineNetMinor - l.stockValuationMinor), 0n),
              ),
              shortLines: planned.filter((l) => l.variance === 'SHORT').length,
              overLines: planned.filter((l) => l.variance === 'OVER').length,
              unmatchedLines: planned.filter((l) => l.variance === 'UNMATCHED_EXTRA').length,
              /** Lines a human signed for beyond the unit's stated tolerance. */
              outOfToleranceLines: planned.filter((l) => l.outOfTolerance).length,
            },
            movementCount: stocked.length,
            order: orderAfter,
          };

          return {
            response,
            apply: async (atx) => {
              await atx.query(
                `insert into app.goods_receipt
                   (tenant_id, id, write_id, hlc, purchase_order_id, supplier_id, location_id,
                    business_date, received_at, supplier_delivery_note_ref, supplier_invoice_ref,
                    received_by_user_id, notes)
                 values ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13)`,
                [
                  tenantId,
                  goodsReceiptId,
                  key,
                  clock.next(),
                  input.purchaseOrderId ?? null,
                  input.supplierId,
                  input.locationId,
                  input.businessDate,
                  receivedAt,
                  input.supplierDeliveryNoteRef ?? null,
                  input.supplierInvoiceRef ?? null,
                  userId,
                  input.notes ?? null,
                ],
              );

              for (const l of planned) {
                await atx.query(
                  `insert into app.goods_receipt_line
                     (tenant_id, id, write_id, hlc, goods_receipt_id, line_no,
                      purchase_order_line_id, product_id, uom_id, qty_received_scale, qty_received,
                      stocking_uom_id, qty_stock_scale, qty_stock, qty_stock_computed,
                      factor_num, factor_den, conversion_confirmed_by,
                      unit_cost_e4, stock_unit_cost_e4, line_net_minor, notes)
                   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
                  [
                    tenantId,
                    l.goodsReceiptLineId,
                    key,
                    clock.next(),
                    goodsReceiptId,
                    l.lineNo,
                    l.purchaseOrderLineId,
                    l.productId,
                    l.uomId,
                    l.qtyReceivedScale,
                    wire(l.qtyReceived),
                    l.stockingUomId,
                    l.qtyStockScale,
                    wire(l.qtyStock),
                    wire(l.qtyStockComputed),
                    wire(l.factorNum),
                    wire(l.factorDen),
                    l.conversionConfirmed ? userId : null,
                    wire(l.unitCostE4),
                    wire(l.stockUnitCostE4),
                    wire(l.lineNetMinor),
                    input.lines.find((i) => i.lineNo === l.lineNo)?.notes ?? null,
                  ],
                );
              }

              // ---- the movements: APPENDED, never a counter ---------------
              if (stocked.length > 0) {
                // The document reason row, guaranteed to exist by the API and
                // owned by the tenant thereafter (see RECEIPT_SOURCE_KIND).
                await atx.query(
                  `insert into app.movement_reason (tenant_id, id, write_id, hlc, code, name)
                   values ($1,$2,$3,$4,$5,'Goods received against a receipt')
                   on conflict do nothing`,
                  [tenantId, reasonId, key, clock.next(), RECEIPT_SOURCE_KIND],
                );
                const reason = await atx.query<{ id: string }>(
                  `select id from app.movement_reason where code = $1 and deleted_at is null`,
                  [RECEIPT_SOURCE_KIND],
                );
                const resolvedReasonId = reason.rows[0]?.id;
                if (!resolvedReasonId) {
                  throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'the receipt movement reason could not be resolved',
                  });
                }
                for (const l of stocked) {
                  await atx.query(
                    `insert into app.stock_movement
                       (tenant_id, id, write_id, hlc, location_id, product_id, qty_delta, qty_scale,
                        uom_id, reason_id, source_kind, source_id, unit_cost_e4, occurred_at, business_date)
                     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::date)`,
                    [
                      tenantId,
                      deterministicUuid(key, 'stock_movement', String(l.lineNo)),
                      key,
                      clock.next(),
                      input.locationId,
                      l.productId,
                      // Inflow is positive (sm_sign), in the STOCKING unit.
                      wire(l.qtyStock),
                      l.qtyStockScale,
                      l.stockingUomId,
                      resolvedReasonId,
                      RECEIPT_SOURCE_KIND,
                      goodsReceiptId,
                      // The cost the weighted-average replay reads (04 §4.7.4),
                      // per ONE stocking unit, derived once, here.
                      wire(l.stockUnitCostE4),
                      receivedAt,
                      input.businessDate,
                    ],
                  );
                }
              }

              // ---- the out-of-tolerance reviews --------------------------
              //
              // Opened in the SAME transaction as the receipt they describe:
              // if the receipt does not land there is nothing to review, and
              // if it does, somebody hears about it before the supplier's
              // invoice is paid. Routed by PERMISSION and scoped to the
              // receiving location, never broadcast to all 25 outlets.
              for (const l of planned.filter((x) => x.outOfTolerance)) {
                await openConflictReview(atx, {
                  tenantId,
                  writeId: key,
                  hlc: clock.next(),
                  reviewId: deterministicUuid(key, 'conflict_review', `conversion:${l.lineNo}`),
                  conflictClass: CONVERSION_CLASS,
                  severity: CONVERSION_SEVERITY,
                  entityTable: 'app.goods_receipt_line',
                  entityId: l.goodsReceiptLineId,
                  fieldPath: 'qty_stock',
                  // Money and quantities are decimal STRINGS inside jsonb —
                  // a human reads these figures and re-keys them (§3.6.2).
                  proposals: [
                    {
                      party: 'supplier',
                      detail: 'what the delivery note invoiced, converted at the snapshotted factor',
                      qtyReceived: wire(l.qtyReceived),
                      uomCode: l.uomCode,
                      qtyStockComputed: wire(l.qtyStockComputed),
                      factorNum: wire(l.factorNum),
                      factorDen: wire(l.factorDen),
                    },
                    {
                      party: 'yard',
                      detail: 'what was counted off the truck and signed for',
                      qtyStock: wire(l.qtyStock),
                      stockingUomCode: l.stockingUomCode,
                      confirmedByUserId: userId,
                      deviationBp: wire(l.deviationBp),
                      toleranceBp: wire(l.toleranceBp),
                    },
                  ],
                  // The counted figure is what the movement carries: the
                  // stock is on the ground and the ledger already says so.
                  pendingState: 'first_applied',
                  pendingValue: {
                    qtyStock: wire(l.qtyStock),
                    qtyStockComputed: wire(l.qtyStockComputed),
                    goodsReceiptId,
                    lineNo: l.lineNo,
                    productId: l.productId,
                    locationId: input.locationId,
                  },
                  requiredPermission: REVIEW_PERMISSION,
                  locationIds: [input.locationId],
                });
              }

              // ---- advance the order, in the SAME unit of work ------------
              if (orderAfter && orderAfter.changed) {
                await atx.query(
                  `update app.purchase_order
                      set status = $1, write_id = $2, hlc = $3,
                          updated_at = transaction_timestamp()
                    where id = $4`,
                  [orderAfter.statusAfter, key, clock.next(), orderAfter.purchaseOrderId],
                );
              }
            },
          };
        },
      );
      return result.response;
    }),

  /**
   * Read one receipt with its lines.
   *
   * Guarded by `purchase.order.view` — a goods receipt is a purchasing
   * document, and the catalogue has no separate receipt-read capability
   * (0009). Two steps, exactly as `sales.get` does it: the procedure requires
   * the capability SOMEWHERE, then the location is read off the row and
   * `requireAt` is asserted against it, because until the row is read there is
   * no location to check.
   */
  get: permissionProcedure({ code: 'purchase.order.view', at: 'any' })
    .input(goodsReceiptInput)
    .query(async ({ ctx, input }) => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const head = await tx.query<{
          id: string;
          purchase_order_id: string | null;
          supplier_id: string;
          supplier_name: string;
          location_id: string;
          business_date: string;
          received_at: string;
          supplier_delivery_note_ref: string | null;
          supplier_invoice_ref: string | null;
          received_by_user_id: string | null;
          notes: string | null;
        }>(
          `select gr.id, gr.purchase_order_id, gr.supplier_id, s.name as supplier_name,
                  gr.location_id, gr.business_date::text, gr.received_at,
                  gr.supplier_delivery_note_ref, gr.supplier_invoice_ref,
                  gr.received_by_user_id, gr.notes
             from app.goods_receipt gr
             join app.supplier s on s.tenant_id = gr.tenant_id and s.id = gr.supplier_id
            where gr.id = $1`,
          [input.goodsReceiptId],
        );
        const receipt = head.rows[0];
        if (!receipt) throw new TRPCError({ code: 'NOT_FOUND', message: 'goods receipt not found' });
        ctx.permissions.requireAt('purchase.order.view', receipt.location_id);

        const lines = await tx.query<{
          id: string;
          line_no: number;
          purchase_order_line_id: string | null;
          product_id: string;
          sku_code: string;
          product_name: string;
          uom_code: string;
          qty_received: string;
          qty_received_scale: number;
          stocking_uom_code: string;
          qty_stock: string;
          qty_stock_computed: string;
          qty_stock_scale: number;
          factor_num: string;
          factor_den: string;
          conversion_confirmed_by: string | null;
          unit_cost_e4: string;
          stock_unit_cost_e4: string;
          line_net_minor: string;
          notes: string | null;
        }>(
          `select grl.id, grl.line_no, grl.purchase_order_line_id, grl.product_id,
                  p.sku_code, p.name as product_name,
                  bu.code as uom_code, grl.qty_received::text, grl.qty_received_scale,
                  su.code as stocking_uom_code, grl.qty_stock::text,
                  grl.qty_stock_computed::text, grl.qty_stock_scale,
                  grl.factor_num::text, grl.factor_den::text, grl.conversion_confirmed_by,
                  grl.unit_cost_e4::text, grl.stock_unit_cost_e4::text,
                  grl.line_net_minor::text, grl.notes
             from app.goods_receipt_line grl
             join app.product p on p.tenant_id = grl.tenant_id and p.id = grl.product_id
             join app.unit_of_measure bu on bu.tenant_id = grl.tenant_id and bu.id = grl.uom_id
             join app.unit_of_measure su
               on su.tenant_id = grl.tenant_id and su.id = grl.stocking_uom_id
            where grl.goods_receipt_id = $1
            order by grl.line_no`,
          [input.goodsReceiptId],
        );

        return {
          goodsReceiptId: receipt.id,
          purchaseOrderId: receipt.purchase_order_id,
          supplierId: receipt.supplier_id,
          supplierName: receipt.supplier_name,
          locationId: receipt.location_id,
          businessDate: receipt.business_date,
          receivedAt: receipt.received_at,
          supplierDeliveryNoteRef: receipt.supplier_delivery_note_ref,
          supplierInvoiceRef: receipt.supplier_invoice_ref,
          receivedByUserId: receipt.received_by_user_id,
          notes: receipt.notes,
          lines: lines.rows.map((r) => ({
            goodsReceiptLineId: r.id,
            lineNo: r.line_no,
            purchaseOrderLineId: r.purchase_order_line_id,
            productId: r.product_id,
            skuCode: r.sku_code,
            productName: r.product_name,
            uomCode: r.uom_code,
            qtyReceived: r.qty_received,
            qtyReceivedScale: r.qty_received_scale,
            stockingUomCode: r.stocking_uom_code,
            qtyStock: r.qty_stock,
            qtyStockComputed: r.qty_stock_computed,
            qtyStockScale: r.qty_stock_scale,
            factorNum: r.factor_num,
            factorDen: r.factor_den,
            conversionConfirmedBy: r.conversion_confirmed_by,
            /**
             * Derived from the two STORED quantities, so it reads the same in
             * ten years. The tolerance it was judged against is deliberately
             * not re-derived here: `product_uom.tolerance_bp` is editable and
             * is not snapshotted on the line, so the figure that mattered
             * lives on the `CONVERSION_OUT_OF_TOLERANCE` review, not here.
             */
            deviationBp: wire(deviationBp(BigInt(r.qty_stock), BigInt(r.qty_stock_computed))),
            unitCostE4: r.unit_cost_e4,
            stockUnitCostE4: r.stock_unit_cost_e4,
            lineNetMinor: r.line_net_minor,
            notes: r.notes,
          })),
        };
      });
    }),

  /**
   * Ordered versus received, per line, for one order — the matching answer a
   * yard needs before it signs, and the answer AP needs before it pays.
   *
   * Served straight from `app.purchase_order_line_status`: DERIVED by summing
   * matched receipt lines, never a stored counter, and both sides in the order
   * line's own unit at its own scale. `qtyOutstanding` is SIGNED — an
   * over-delivery reads negative rather than being clamped away.
   */
  purchaseOrderReceiptStatus: permissionProcedure({ code: 'purchase.order.view', at: 'any' })
    .input(purchaseOrderReceiptStatusInput)
    .query(async ({ ctx, input }) => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const order = await loadOrderHead(tx, input.purchaseOrderId);
        if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: 'purchase order not found' });
        ctx.permissions.requireAt('purchase.order.view', order.deliverToLocationId);

        const rows = await tx.query<{
          purchase_order_line_id: string;
          line_no: number;
          product_id: string;
          sku_code: string;
          product_name: string;
          uom_code: string;
          qty_scale: number;
          qty_ordered: string;
          qty_received: string;
          qty_outstanding: string;
          stocking_uom_code: string;
          qty_stock_scale: number;
          qty_ordered_stock: string;
          qty_stock_received: string;
          is_fully_received: boolean;
          receipt_line_count: string;
        }>(
          `select st.purchase_order_line_id, st.line_no, st.product_id,
                  p.sku_code, p.name as product_name,
                  bu.code as uom_code, st.qty_scale,
                  st.qty_ordered::text, st.qty_received::text, st.qty_outstanding::text,
                  su.code as stocking_uom_code, st.qty_stock_scale,
                  st.qty_ordered_stock::text, st.qty_stock_received::text,
                  st.is_fully_received, st.receipt_line_count::text
             from app.purchase_order_line_status st
             join app.product p on p.tenant_id = st.tenant_id and p.id = st.product_id
             join app.unit_of_measure bu on bu.tenant_id = st.tenant_id and bu.id = st.uom_id
             join app.unit_of_measure su
               on su.tenant_id = st.tenant_id and su.id = st.stocking_uom_id
            where st.purchase_order_id = $1
            order by st.line_no`,
          [input.purchaseOrderId],
        );

        const receipts = await tx.query<{ id: string; business_date: string }>(
          `select id, business_date::text from app.goods_receipt
            where purchase_order_id = $1 order by business_date, id`,
          [input.purchaseOrderId],
        );

        return {
          purchaseOrderId: order.id,
          status: order.status,
          supplierId: order.supplierId,
          deliverToLocationId: order.deliverToLocationId,
          isFullyReceived: rows.rows.length > 0 && rows.rows.every((r) => r.is_fully_received),
          lines: rows.rows.map((r) => ({
            purchaseOrderLineId: r.purchase_order_line_id,
            lineNo: r.line_no,
            productId: r.product_id,
            skuCode: r.sku_code,
            productName: r.product_name,
            uomCode: r.uom_code,
            qtyScale: r.qty_scale,
            qtyOrdered: r.qty_ordered,
            qtyReceived: r.qty_received,
            /** Signed: negative is an over-delivery, and it is not clamped. */
            qtyOutstanding: r.qty_outstanding,
            stockingUomCode: r.stocking_uom_code,
            qtyStockScale: r.qty_stock_scale,
            qtyOrderedStock: r.qty_ordered_stock,
            qtyStockReceived: r.qty_stock_received,
            isFullyReceived: r.is_fully_received,
            receiptLineCount: r.receipt_line_count,
          })),
          receipts: receipts.rows.map((r) => ({
            goodsReceiptId: r.id,
            businessDate: r.business_date,
          })),
        };
      });
    }),
});
