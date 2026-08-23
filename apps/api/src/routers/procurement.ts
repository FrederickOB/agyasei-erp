/**
 * Procurement — suppliers, multi-source supply records, and purchase orders.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * SCOPE: `supplier`, `supplier_capability_type`, `supplier_capability`,
 *        `supplier_product`, `purchase_order`, `purchase_order_line`, and the
 *        `app.purchase_order_line_status` view — plus the REORDER SUGGESTION
 *        that ties all of it to the Phase 1 low-stock alert (CLAUDE.md §3).
 * NOT HERE: goods receipts (`./receiving.ts`) and deliveries
 *        (`./logistics.ts`). Separate routers because they are separate
 *        CAPABILITIES, and a router is where a reviewer looks to see which
 *        one guards what.
 * ═════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ADR-0001: THERE IS NO VEHICLE IN THIS FILE
 * ─────────────────────────────────────────────────────────────────────────
 * A haulier is a SUPPLIER holding a capability whose `kind` is HAULAGE — it
 * invoices and is paid on terms, which is a supplier in every way the books
 * care about, and it puts haulage spend in AP where distribution cost as a
 * percentage of revenue can actually be measured. `listSuppliers({kind:
 * 'HAULAGE'})` is how a screen finds the carriers, and it reads the PLATFORM
 * `kind` column, never the tenant's own capability `code`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FIVE RULES THIS FILE DOES NOT RE-DECIDE
 * ─────────────────────────────────────────────────────────────────────────
 * 1. INPUT SHAPES COME FROM `@erp/contracts`. Not one zod object is declared
 *    here. A shape declared privately in a router is a shape only one side of
 *    the wire has ever seen — the single most expensive bug class in this
 *    repository's history (docs/phase1-status.md §0).
 *
 * 2. PERMISSIONS ARE DECLARED ON THE PROCEDURE (`requiresPermission` /
 *    `permissionProcedure`), never called at the top of a handler. Two
 *    procedures here take their subject's location from the DATABASE rather
 *    than from the payload — `updatePurchaseOrder` and
 *    `changePurchaseOrderStatus` name only an order id — so their declaration
 *    is the coarse gate (`at: 'any'`) and the authoritative check is
 *    `requireAt(code, order.deliverToLocationId)` once the order is loaded,
 *    plus `assertLocationInScope`. That is the documented shape for a check a
 *    declaration cannot express (see ../permissions.ts); it is a SYNCHRONOUS
 *    call against the snapshot the middleware already resolved, never a
 *    second transaction inside `runIdempotent`'s.
 *
 * 3. THE STATE MACHINE IS THE DATABASE'S. `app.purchase_order_legal_transitions()`
 *    is the canonical table and a trigger enforces it on every UPDATE. This
 *    file CALLS it (`app.purchase_order_transition_allowed`) so an illegal
 *    move is a clean PRECONDITION_FAILED instead of a raw constraint error,
 *    and serves it (`purchaseOrder.legalNextStatuses`) so a screen greys out
 *    buttons from the server's answer instead of a second, drifting copy.
 *
 * 4. EVERY WRITE GOES THROUGH `runIdempotent`, so it lands in `app.write_log`
 *    with the client's idempotency key and a server-stamped HLC. There is no
 *    second write path.
 *
 * 5. UNITS GO THROUGH `product_uom` — THE SAME MACHINERY SELLING USES. A
 *    material bought by the tonne and stocked in sacks is the rebar problem
 *    in the opposite direction (04 §4.10), and solving it twice would give
 *    the two directions two answers.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MONEY AND QUANTITY, ONCE
 * ─────────────────────────────────────────────────────────────────────────
 * Every magnitude is `bigint` in code and a DECIMAL STRING on the wire
 * (ADR-0004). Rounding happens exactly once per computed figure, at a named
 * mode, and every site says which:
 *
 *   line_net_minor       `lineNetMinor(qty, qtyScale, unitPriceE4, 'half-up')`
 *                        — 04 §4.13 row 3: once, on the EXTENDED amount,
 *                        never on the unit price.
 *   qty_ordered_stock    `mulDiv(qty, num·10^stockScale, den·10^buyScale,
 *                        'half-up')` — the same expression the sale path uses
 *                        for what leaves the yard, with the factors swapped.
 *   comparison price     `mulDiv(priceE4, den, num, 'half-up')` — see
 *                        `pricePerStockUnitE4` below. DISPLAY only; the
 *                        ORDERING is done on exact rationals so no supplier
 *                        is ever ranked by a rounding artefact.
 *   suggested quantity   `mulDiv(short, den·10^buyScale, num·10^stockScale,
 *                        'up')` — rounded UP. Rounding a shortfall down
 *                        leaves the shelf below the level the tenant asked
 *                        for, which is the whole thing the threshold exists
 *                        to prevent.
 *
 * An order carries NO stored total: `purchase_order` has no total column, so
 * the total is Σ(lines) by construction and cannot disagree with its parts.
 * The write path sums bigints in TypeScript; the read path sums the same
 * column in SQL. Two implementations, one identity, asserted in the tests.
 */
import { TRPCError } from '@trpc/server';
import {
  changePurchaseOrderStatusInput,
  createPurchaseOrderInput,
  listPurchaseOrdersInput,
  listSuppliersInput,
  lowStockInput,
  purchaseOrderInput,
  suppliersForProductInput,
  updatePurchaseOrderInput,
  upsertSupplierInput,
  upsertSupplierProductInput,
  type PurchaseOrderLineParsed,
  type PurchaseOrderStatus,
} from '@erp/contracts';
import { deterministicUuid, type PermissionCode } from '@erp/db';
import { lineNetMinor, mulDiv } from '@erp/money';
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
import { selectLowStockRows } from './inventory.js';
// The jurisdiction pack read is the SAME read the sale path does — one
// implementation, because a purchase order snapshots exactly what a sale
// snapshots (currency and minor-unit scale, NEVER assumed; CLAUDE.md §2.5).
// It lives in ./sales.ts because that is where it was first needed; importing
// it beats a second copy that drifts the day a pack gains a field.
import { loadJurisdiction } from './sales.js';
import { resolveLocationScope } from './scope.js';

// ═══════════════════════════════════════════════════════════════════════════
// WHICH CAPABILITY A STATE TRANSITION NEEDS
// ═══════════════════════════════════════════════════════════════════════════
//
// CREATING AND APPROVING ARE DIFFERENT CAPABILITIES, and this map is where
// that separation is enforced on the wire. One person who can both raise an
// order and authorise it can commit the business to a spend nobody else saw;
// one who can both approve an order and receive its goods can fabricate a
// receipt against an order they invented (migration 0009's header). The
// template puts them in different roles — and nothing here reads a role name.
//
// Total over `PurchaseOrderStatus`, and TypeScript proves it: adding a status
// to the contract without deciding which capability guards it is a COMPILE
// ERROR, never a transition that silently needs nothing. Same shape as
// `MOVEMENT_PERMISSION` in ./inventory.ts, for the same reason.
//
// PARTIALLY_RECEIVED and RECEIVED are ordinarily driven by the receiving
// router as receipts land. Reaching them from here changes the ORDER's status
// and nothing else: it appends no stock movement and creates no receipt
// document, so it cannot put inventory in the ledger that never arrived.
const PURCHASE_ORDER_STATUS_PERMISSION: Record<PurchaseOrderStatus, PermissionCode> = {
  DRAFT: 'purchase.order.create',
  SUBMITTED: 'purchase.order.create',
  APPROVED: 'purchase.order.approve',
  PARTIALLY_RECEIVED: 'purchase.order.create',
  RECEIVED: 'purchase.order.create',
  CANCELLED: 'purchase.order.create',
  CLOSED: 'purchase.order.create',
};

/** Read the required code out of the VALIDATED input; unknown ⇒ deny. */
function statusPermission(input: Record<string, unknown>): PermissionCode | undefined {
  const to = input['toStatus'];
  if (typeof to !== 'string') return undefined;
  return PURCHASE_ORDER_STATUS_PERMISSION[to as PurchaseOrderStatus];
}

// ═══════════════════════════════════════════════════════════════════════════
// UNITS — the one conversion, used in both directions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A buyable unit of a product, with the conversion into its stocking unit.
 *
 * `factorNum / factorDen` is STOCKING UNITS PER ONE PURCHASE UNIT, in natural
 * units (04 §4.4.1) — the identical column pair the selling path reads. One
 * tonne of a material stocked in 50 kg sacks is 20/1; a sack is 1/1.
 */
interface BuyableUnit {
  uomId: string;
  uomCode: string;
  /** Scaled-integer denomination of a quantity in the PURCHASE unit. */
  buyScale: number;
  factorNum: bigint;
  factorDen: bigint;
  stockingUomId: string;
  stockingUomCode: string;
  stockScale: number;
}

async function loadBuyableUnit(
  tx: Queryable,
  productId: string,
  uomId: string,
): Promise<BuyableUnit> {
  const res = await tx.query<{
    uom_id: string;
    uom_code: string;
    buy_scale: number;
    factor_num: string;
    factor_den: string;
    stocking_uom_id: string;
    stocking_uom_code: string;
    stock_scale: number;
  }>(
    `select pu.uom_id, u.code as uom_code, u.qty_scale as buy_scale,
            pu.factor_num::text, pu.factor_den::text,
            p.stocking_uom_id, su.code as stocking_uom_code, su.qty_scale as stock_scale
       from app.product_uom pu
       join app.product p on p.tenant_id = pu.tenant_id and p.id = pu.product_id
       join app.unit_of_measure u  on u.tenant_id  = pu.tenant_id and u.id  = pu.uom_id
       join app.unit_of_measure su on su.tenant_id = p.tenant_id  and su.id = p.stocking_uom_id
      where pu.product_id = $1 and pu.uom_id = $2
        and pu.can_buy and pu.deleted_at is null and p.deleted_at is null`,
    [productId, uomId],
  );
  const row = res.rows[0];
  if (!row) {
    // Refusing beats guessing: a purchase unit that is not a declared buyable
    // unit of the product has NO conversion factor, so nothing could turn a
    // receipt in it into the stocking units the movement ledger is
    // denominated in (§4.10). The 0008 trigger says the same thing one layer
    // down; this is the message a buyer can act on.
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        `unit ${uomId} is not a buyable unit of product ${productId} — a purchase unit must be a ` +
        `live product_uom row with can_buy, so what arrives has a conversion into the stocking unit`,
    });
  }
  return {
    uomId: row.uom_id,
    uomCode: row.uom_code,
    buyScale: row.buy_scale,
    factorNum: BigInt(row.factor_num),
    factorDen: BigInt(row.factor_den),
    stockingUomId: row.stocking_uom_id,
    stockingUomCode: row.stocking_uom_code,
    stockScale: row.stock_scale,
  };
}

/**
 * A quantity in the PURCHASE unit → the same quantity in the STOCKING unit.
 * Rounded once, half-up — the same expression `sales.createSale` uses for
 * what leaves the yard, with the factor the other way up.
 */
function toStockQty(qtyBuy: bigint, u: BuyableUnit): bigint {
  return mulDiv(
    qtyBuy,
    u.factorNum * 10n ** BigInt(u.stockScale),
    u.factorDen * 10n ** BigInt(u.buyScale),
    'half-up',
  );
}

/**
 * A quantity in the STOCKING unit → the PURCHASE unit, rounded UP.
 *
 * UP, explicitly, and only ever used for a SUGGESTION: half-up here would let
 * a shortfall of 0.4 sacks round to nothing and leave the alert firing
 * forever. Nothing is priced or committed from this figure — a human puts it
 * on an order, and the order line does its own arithmetic.
 */
function toBuyQtyRoundedUp(qtyStock: bigint, u: BuyableUnit): bigint {
  return mulDiv(
    qtyStock,
    u.factorDen * 10n ** BigInt(u.buyScale),
    u.factorNum * 10n ** BigInt(u.stockScale),
    'up',
  );
}

/**
 * THE COMMON-UNIT PRICE — the whole point of "multi-source".
 *
 * `last_price_e4` is minor units per ONE PURCHASE unit. One supplier quoting
 * by the tonne and another by the 50 kg sack are quoting two different things,
 * and comparing the two raw figures picks the wrong supplier every time — it
 * would rank a tonne at GH₵1,000 as twenty times DEARER than a sack at
 * GH₵52, when it is in fact GH₵50 a sack and the cheaper of the two.
 *
 * One purchase unit is `factorNum/factorDen` stocking units, so the price per
 * stocking unit is `price × factorDen / factorNum`. Both sides of every
 * comparison are then denominated in the product's own stocking unit — the
 * unit the movement ledger, the reorder point and the alert are already in —
 * so there is exactly one common unit and no third one to choose.
 *
 * Rounded half-up at e4, i.e. to a ten-thousandth of a minor unit, and used
 * for DISPLAY. `compareSources` below orders on the exact rationals instead,
 * so the ranking never depends on this rounding.
 */
function pricePerStockUnitE4(lastPriceE4: bigint, u: {
  factorNum: bigint;
  factorDen: bigint;
}): bigint {
  return mulDiv(lastPriceE4, u.factorDen, u.factorNum, 'half-up');
}

// ═══════════════════════════════════════════════════════════════════════════
// MULTI-SOURCE — one query, one comparison, used by two routes
// ═══════════════════════════════════════════════════════════════════════════

interface SourceRow {
  supplier_product_id: string;
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  payment_terms_days: number;
  supplier_is_active: boolean;
  product_id: string;
  sku_code: string;
  product_name: string;
  supplier_sku: string | null;
  purchase_uom_id: string;
  purchase_uom_code: string;
  buy_scale: number;
  lead_time_days: number | null;
  last_price_e4: string | null;
  last_price_on: string | null;
  is_preferred: boolean;
  is_active: boolean;
  factor_num: string;
  factor_den: string;
  stocking_uom_id: string;
  stocking_uom_code: string;
  stock_scale: number;
}

/**
 * Every recorded source for a set of products, with the conversion factor
 * already joined. The `product_uom` join is INNER on purpose: a supply record
 * whose purchase unit stopped being buyable is not comparable to anything and
 * must not appear as if it were. (0008's trigger refuses to create one; a
 * later edit to `product_uom` could still retire the unit underneath it.)
 */
async function selectSources(
  tx: Queryable,
  productIds: readonly string[],
  includeInactive: boolean,
): Promise<SourceRow[]> {
  if (productIds.length === 0) return [];
  const res = await tx.query<SourceRow>(
    `select sp.id as supplier_product_id, sp.supplier_id,
            s.code as supplier_code, s.name as supplier_name,
            s.payment_terms_days, s.is_active as supplier_is_active,
            sp.product_id, p.sku_code, p.name as product_name,
            sp.supplier_sku,
            sp.purchase_uom_id, u.code as purchase_uom_code, u.qty_scale as buy_scale,
            sp.lead_time_days, sp.last_price_e4::text, sp.last_price_on::text,
            sp.is_preferred, sp.is_active,
            pu.factor_num::text, pu.factor_den::text,
            p.stocking_uom_id, su.code as stocking_uom_code, su.qty_scale as stock_scale
       from app.supplier_product sp
       join app.supplier s on s.tenant_id = sp.tenant_id and s.id = sp.supplier_id
       join app.product  p on p.tenant_id = sp.tenant_id and p.id = sp.product_id
       join app.unit_of_measure u  on u.tenant_id  = sp.tenant_id and u.id  = sp.purchase_uom_id
       join app.unit_of_measure su on su.tenant_id = p.tenant_id  and su.id = p.stocking_uom_id
       join app.product_uom pu
         on pu.tenant_id = sp.tenant_id and pu.product_id = sp.product_id
        and pu.uom_id = sp.purchase_uom_id and pu.can_buy and pu.deleted_at is null
      where sp.product_id = any($1::uuid[])
        and sp.deleted_at is null and s.deleted_at is null and p.deleted_at is null
        and ($2::boolean or (sp.is_active and s.is_active))
      order by p.sku_code, s.code`,
    [[...productIds], includeInactive],
  );
  return res.rows;
}

/**
 * One source, priced into the product's stocking unit.
 *
 * EXPORTED because `compared()` appears in the inferred return type of two
 * procedures, and tRPC's `AppRouter` type cannot be named without it — an
 * un-exported shape here is a `tsc` error at every importer of the router.
 */
export interface ComparedSource {
  supplierProductId: string;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  paymentTermsDays: number;
  supplierSku: string | null;
  leadTimeDays: number | null;
  isPreferred: boolean;
  isActive: boolean;
  supplierIsActive: boolean;
  purchaseUomId: string;
  purchaseUomCode: string;
  buyScale: number;
  /** Stocking units per ONE purchase unit, exact, as the pair it really is. */
  stockUnitsPerPurchaseUnitNum: string;
  stockUnitsPerPurchaseUnitDen: string;
  /** The supplier's own quote, per ONE PURCHASE unit, ×10⁴. */
  lastPriceE4: string | null;
  lastPriceOn: string | null;
  /** THE COMPARABLE FIGURE: per ONE STOCKING unit, ×10⁴. Null when unpriced. */
  pricePerStockUnitE4: string | null;
  priceComparable: boolean;
  priceUnavailableReason: string | null;
}

interface SourceWithUnit extends BuyableUnit {
  row: SourceRow;
  priceE4: bigint | null;
}

function toSourceWithUnit(row: SourceRow): SourceWithUnit {
  return {
    row,
    priceE4: row.last_price_e4 === null ? null : BigInt(row.last_price_e4),
    uomId: row.purchase_uom_id,
    uomCode: row.purchase_uom_code,
    buyScale: row.buy_scale,
    factorNum: BigInt(row.factor_num),
    factorDen: BigInt(row.factor_den),
    stockingUomId: row.stocking_uom_id,
    stockingUomCode: row.stocking_uom_code,
    stockScale: row.stock_scale,
  };
}

/**
 * Cheapest-first IN THE COMMON UNIT, then unpriced sources by supplier code.
 *
 * The comparison is `pa·db·nb  ?  pb·da·na`, which is
 * `(pa·db/na) ? (pb·da/nb)` cross-multiplied — exact bigint arithmetic on the
 * true rational prices per stocking unit, so two sources are never
 * transposed by the half-up rounding that `pricePerStockUnitE4` does for
 * display. Denominators are `> 0` by the schema's own CHECK.
 */
function compareSources(a: SourceWithUnit, b: SourceWithUnit): number {
  if (a.priceE4 === null && b.priceE4 === null) {
    return a.row.supplier_code < b.row.supplier_code ? -1 : a.row.supplier_code > b.row.supplier_code ? 1 : 0;
  }
  if (a.priceE4 === null) return 1;
  if (b.priceE4 === null) return -1;
  const left = a.priceE4 * a.factorDen * b.factorNum;
  const right = b.priceE4 * b.factorDen * a.factorNum;
  if (left < right) return -1;
  if (left > right) return 1;
  return a.row.supplier_code < b.row.supplier_code ? -1 : a.row.supplier_code > b.row.supplier_code ? 1 : 0;
}

function compared(s: SourceWithUnit): ComparedSource {
  return {
    supplierProductId: s.row.supplier_product_id,
    supplierId: s.row.supplier_id,
    supplierCode: s.row.supplier_code,
    supplierName: s.row.supplier_name,
    paymentTermsDays: s.row.payment_terms_days,
    supplierSku: s.row.supplier_sku,
    leadTimeDays: s.row.lead_time_days,
    isPreferred: s.row.is_preferred,
    isActive: s.row.is_active,
    supplierIsActive: s.row.supplier_is_active,
    purchaseUomId: s.uomId,
    purchaseUomCode: s.uomCode,
    buyScale: s.buyScale,
    stockUnitsPerPurchaseUnitNum: s.factorNum.toString(10),
    stockUnitsPerPurchaseUnitDen: s.factorDen.toString(10),
    lastPriceE4: s.priceE4 === null ? null : wire(s.priceE4),
    lastPriceOn: s.row.last_price_on,
    pricePerStockUnitE4: s.priceE4 === null ? null : wire(pricePerStockUnitE4(s.priceE4, s)),
    priceComparable: s.priceE4 !== null,
    // Never a zero. A zero price reads as free, and a supplier we have never
    // bought from is not a supplier that gives it away (seed/suppliers.ts).
    priceUnavailableReason: s.priceE4 === null ? 'NO_RECORDED_PRICE' : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// REORDER SUGGESTION — the response shapes, named rather than inferred
// ═══════════════════════════════════════════════════════════════════════════
//
// These are declared instead of letting `unknown[]` fall out of the handler.
// `unknown[]` typechecks perfectly and tells a client NOTHING: every field
// access needs a cast, so the compiler cannot catch a renamed field and the
// "a disagreement is a tsc error" guarantee the contracts package exists for
// stops at this route's boundary. The INPUT is `lowStockInput` from
// `@erp/contracts`; the OUTPUT is inferred through `AppRouter`, and it can
// only be inferred into something useful if it has a name here.

/** The Phase 1 alert's own figures, unchanged, in the STOCKING unit. */
export interface LowStockFigures {
  locationId: string;
  reorderPointId: string;
  productId: string;
  skuCode: string;
  productName: string;
  qtyOnHand: string;
  reorderPointQty: string;
  reorderUpToQty: string | null;
  shortfallQty: string;
  qtyScale: number;
  uomCode: string;
  coverageBp: string | null;
  reorderLeadTimeDays: number | null;
}

/**
 * Low here, and nobody recorded as able to supply it. The most actionable
 * line on the page, so it is a first-class part of the answer rather than a
 * row quietly dropped for having no source.
 */
export interface UnsourcedLowStockItem extends LowStockFigures {
  reason: 'NO_ACTIVE_SUPPLIER';
}

/** What to order, from whom, in whose unit — and why, or why not. */
export interface ReorderRecommendation {
  /**
   * PREFERRED — a source is flagged preferred.
   * ONLY_SOURCE — exactly one source exists, so there is nothing to choose.
   * AMBIGUOUS — several sources, none preferred: a human chooses, and the
   * alternatives below are what they choose from.
   */
  basis: 'PREFERRED' | 'ONLY_SOURCE' | 'AMBIGUOUS';
  supplierId: string | null;
  supplierCode: string | null;
  supplierName: string | null;
  supplierSku: string | null;
  leadTimeDays: number | null;
  paymentTermsDays: number | null;
  purchaseUomId: string | null;
  purchaseUomCode: string | null;
  buyScale: number | null;
  /** ORDER_UP_TO when the threshold names a level; REORDER_POINT_ONLY when not. */
  qtyBasis: 'ORDER_UP_TO' | 'REORDER_POINT_ONLY';
  /** In the STOCKING unit — the view's own shortfall, untouched. */
  qtyToOrderStock: string;
  /** In the PURCHASE unit, rounded UP. Null carries a stated reason. */
  qtyToOrder: string | null;
  qtyUnavailableReason: 'NO_SINGLE_SOURCE_TO_PRICE_IT_IN' | 'NO_ORDER_UP_TO_LEVEL' | null;
  /** From what we LAST PAID. An estimate; the order line prices itself. */
  estimatedCostMinor: string | null;
  estimateUnavailableReason:
    | 'NO_SINGLE_SOURCE_TO_PRICE_IT_IN'
    | 'NO_QUANTITY_TO_COST'
    | 'NO_RECORDED_PRICE'
    | null;
}

export interface ReorderSuggestion extends LowStockFigures {
  recommendation: ReorderRecommendation;
  alternativeCount: number;
  /** Every source, cheapest-first IN THE COMMON UNIT. */
  alternatives: ComparedSource[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Purchase-order helpers
// ═══════════════════════════════════════════════════════════════════════════

interface OrderHeaderRow {
  id: string;
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  deliver_to_location_id: string;
  location_code: string;
  location_name: string;
  order_no: string | null;
  status: string;
  order_date: string;
  expected_at: string | null;
  currency_code: string;
  money_scale: string;
  submitted_at: string | null;
  approved_at: string | null;
  approved_by_user_id: string | null;
  closed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  notes: string | null;
  line_count: string;
  total_minor: string;
}

const ORDER_HEADER_SQL = `
  select po.id, po.supplier_id, s.code as supplier_code, s.name as supplier_name,
         po.deliver_to_location_id, l.code as location_code, l.name as location_name,
         po.order_no, po.status, po.order_date::text, po.expected_at::text,
         po.currency_code, po.money_scale::text,
         po.submitted_at::text, po.approved_at::text, po.approved_by_user_id,
         po.closed_at::text, po.cancelled_at::text, po.cancel_reason, po.notes,
         (select count(*) from app.purchase_order_line pol
           where pol.tenant_id = po.tenant_id and pol.purchase_order_id = po.id
             and pol.deleted_at is null)::text as line_count,
         -- Σ(lines), in SQL. There is no stored total to disagree with.
         (select coalesce(sum(pol.line_net_minor), 0) from app.purchase_order_line pol
           where pol.tenant_id = po.tenant_id and pol.purchase_order_id = po.id
             and pol.deleted_at is null)::bigint::text as total_minor
    from app.purchase_order po
    join app.supplier s on s.tenant_id = po.tenant_id and s.id = po.supplier_id
    join app.location l on l.tenant_id = po.tenant_id and l.id = po.deliver_to_location_id
`;

async function loadOrderHeader(tx: Queryable, purchaseOrderId: string): Promise<OrderHeaderRow> {
  const res = await tx.query<OrderHeaderRow>(
    `${ORDER_HEADER_SQL} where po.id = $1 and po.deleted_at is null`,
    [purchaseOrderId],
  );
  const row = res.rows[0];
  // A foreign tenant's id and a nonexistent id are INDISTINGUISHABLE: RLS
  // means the first never resolves, and telling a caller "that order exists
  // but is not yours" is itself a fact about somebody else's business.
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'purchase order not found' });
  return row;
}

function headerDto(row: OrderHeaderRow) {
  return {
    purchaseOrderId: row.id,
    supplierId: row.supplier_id,
    supplierCode: row.supplier_code,
    supplierName: row.supplier_name,
    deliverToLocationId: row.deliver_to_location_id,
    locationCode: row.location_code,
    locationName: row.location_name,
    orderNo: row.order_no,
    status: row.status,
    orderDate: row.order_date,
    expectedAt: row.expected_at,
    currencyCode: row.currency_code,
    /** The pack's minor units per major. NEVER assumed to be 100. */
    moneyScale: row.money_scale,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    approvedByUserId: row.approved_by_user_id,
    closedAt: row.closed_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    notes: row.notes,
    lineCount: Number(row.line_count),
    /** Σ(lines), exactly. Minor units, decimal string. */
    totalMinor: row.total_minor,
  };
}

/** The legal next steps, read from the DATABASE's own transition table. */
async function legalNextStatuses(tx: Queryable, from: string): Promise<string[]> {
  const res = await tx.query<{ to_status: string }>(
    `select to_status from app.purchase_order_legal_transitions()
      where from_status = $1 order by to_status`,
    [from],
  );
  return res.rows.map((r) => r.to_status);
}

interface PlannedLine {
  lineNo: number;
  productId: string;
  skuCode: string;
  unit: BuyableUnit;
  qtyOrdered: bigint;
  qtyOrderedStock: bigint;
  unitPriceE4: bigint;
  lineNetMinor: bigint;
  notes: string | null;
}

/**
 * Price and convert every line of an order. Reads only; no writes, no clock.
 *
 * Refuses rather than improvises: a duplicate line number (the unique index
 * would otherwise surface as a 500), a product that is not purchasable, a
 * unit that is not buyable, and a quantity that converts to zero stocking
 * units — which is a real hazard when buying in a unit far larger than the
 * stocking one and it must not become a line the yard can never receive.
 */
async function planLines(
  tx: Queryable,
  lines: readonly PurchaseOrderLineParsed[],
): Promise<PlannedLine[]> {
  const seen = new Set<number>();
  const planned: PlannedLine[] = [];
  for (const line of lines) {
    if (seen.has(line.lineNo)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `duplicate line number ${line.lineNo} — line numbers identify a line on the order`,
      });
    }
    seen.add(line.lineNo);

    const prod = await tx.query<{ id: string; sku_code: string; is_purchasable: boolean }>(
      `select id, sku_code, is_purchasable from app.product
        where id = $1 and deleted_at is null`,
      [line.productId],
    );
    const product = prod.rows[0];
    if (!product) throw new TRPCError({ code: 'NOT_FOUND', message: 'product not found' });
    if (!product.is_purchasable) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `product ${product.sku_code} is not purchasable`,
      });
    }

    const unit = await loadBuyableUnit(tx, line.productId, line.uomId);
    const qtyStock = toStockQty(line.qtyOrdered, unit);
    if (qtyStock <= 0n) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          `line ${line.lineNo}: ${wire(line.qtyOrdered)} ${unit.uomCode} converts to zero ` +
          `${unit.stockingUomCode} — the yard could never receive it`,
      });
    }

    planned.push({
      lineNo: line.lineNo,
      productId: product.id,
      skuCode: product.sku_code,
      unit,
      qtyOrdered: line.qtyOrdered,
      qtyOrderedStock: qtyStock,
      unitPriceE4: line.unitPriceE4,
      // 04 §4.13 row 3: once, on the extended amount, never on the unit price.
      lineNetMinor: lineNetMinor(line.qtyOrdered, unit.buyScale, line.unitPriceE4, 'half-up'),
      notes: line.notes ?? null,
    });
  }
  return planned;
}

function plannedLineDto(l: PlannedLine) {
  return {
    lineNo: l.lineNo,
    productId: l.productId,
    skuCode: l.skuCode,
    uomId: l.unit.uomId,
    uomCode: l.unit.uomCode,
    qtyScale: l.unit.buyScale,
    qtyOrdered: wire(l.qtyOrdered),
    unitPriceE4: wire(l.unitPriceE4),
    stockingUomId: l.unit.stockingUomId,
    stockingUomCode: l.unit.stockingUomCode,
    qtyStockScale: l.unit.stockScale,
    qtyOrderedStock: wire(l.qtyOrderedStock),
    factorNum: l.unit.factorNum.toString(10),
    factorDen: l.unit.factorDen.toString(10),
    lineNetMinor: wire(l.lineNetMinor),
    notes: l.notes,
  };
}

const LINE_COLUMNS = `
  (tenant_id, id, write_id, hlc, purchase_order_id, line_no, product_id,
   uom_id, qty_scale, qty_ordered, unit_price_e4,
   stocking_uom_id, qty_stock_scale, qty_ordered_stock, factor_num, factor_den,
   line_net_minor, notes)`;

async function insertLines(
  tx: Queryable,
  args: {
    tenantId: string;
    writeId: string;
    hlc: () => string;
    purchaseOrderId: string;
    idPrefix: string;
    lines: readonly PlannedLine[];
  },
): Promise<void> {
  for (const l of args.lines) {
    await tx.query(
      `insert into app.purchase_order_line ${LINE_COLUMNS}
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        args.tenantId,
        deterministicUuid(args.writeId, args.idPrefix, String(l.lineNo)),
        args.writeId,
        args.hlc(),
        args.purchaseOrderId,
        l.lineNo,
        l.productId,
        l.unit.uomId,
        l.unit.buyScale,
        wire(l.qtyOrdered),
        wire(l.unitPriceE4),
        l.unit.stockingUomId,
        l.unit.stockScale,
        wire(l.qtyOrderedStock),
        l.unit.factorNum.toString(10),
        l.unit.factorDen.toString(10),
        wire(l.lineNetMinor),
        l.notes,
      ],
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// The router
// ═══════════════════════════════════════════════════════════════════════════

export const procurementRouter = router({
  // ─────────────────────────────────────────────────────────────────────────
  // SUPPLIERS
  //
  // A supplier belongs to the TENANT, not to an outlet — it has no location
  // of its own — so `supplier.manage` is required at the ROOT of the location
  // tree (`at: 'tenant'`), exactly as a customer's credit account is. A grant
  // made at a leaf expands DOWN the closure and therefore never reaches the
  // root, which is what stops outlet-scoped authority from editing payment
  // terms for the whole network.
  //
  // Reading is `at: 'any'`: an outlet manager holds `supplier.view` at their
  // own node and needs the supplier list to raise an order.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * The supplier list, with each supplier's capabilities — and the tenant's
   * capability TYPES alongside, because `upsertSupplier` names them by id and
   * a client with no way to discover those ids could never set one.
   *
   * `kind` narrows by the PLATFORM half of a capability (GOODS | HAULAGE), so
   * "list the carriers" is `{kind: 'HAULAGE'}` and needs nobody to know the
   * tenant's own word for haulage (ADR-0006, CLAUDE.md §2.9).
   */
  listSuppliers: permissionProcedure({ code: 'supplier.view', at: 'any' })
    .input(listSuppliersInput)
    .query(async ({ ctx, input }) => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const res = await tx.query<{
          id: string;
          code: string;
          name: string;
          payment_terms_days: number;
          currency_code: string;
          contact_name: string | null;
          contact_phone: string | null;
          contact_email: string | null;
          address_text: string | null;
          notes: string | null;
          is_active: boolean;
        }>(
          `select s.id, s.code, s.name, s.payment_terms_days, s.currency_code,
                  s.contact_name, s.contact_phone, s.contact_email, s.address_text,
                  s.notes, s.is_active
             from app.supplier s
            where s.deleted_at is null
              and ($1::boolean or s.is_active)
              and ($2::text is null or s.code ilike '%' || $2 || '%' or s.name ilike '%' || $2 || '%')
              and ($3::text is null or exists (
                    select 1 from app.supplier_capability sc
                      join app.supplier_capability_type sct
                        on sct.tenant_id = sc.tenant_id and sct.id = sc.capability_type_id
                     where sc.tenant_id = s.tenant_id and sc.supplier_id = s.id
                       and sc.deleted_at is null and sct.deleted_at is null
                       and sct.kind = $3))
            order by s.code
            limit $4`,
          [
            input.includeInactive ?? false,
            input.search ?? null,
            input.kind ?? null,
            input.limit ?? 200,
          ],
        );

        const ids = res.rows.map((r) => r.id);
        const caps = await tx.query<{
          supplier_id: string;
          capability_type_id: string;
          code: string;
          name: string;
          kind: string;
        }>(
          `select sc.supplier_id, sct.id as capability_type_id, sct.code, sct.name, sct.kind
             from app.supplier_capability sc
             join app.supplier_capability_type sct
               on sct.tenant_id = sc.tenant_id and sct.id = sc.capability_type_id
            where sc.supplier_id = any($1::uuid[])
              and sc.deleted_at is null and sct.deleted_at is null
            order by sct.code`,
          [ids],
        );
        const bySupplier = new Map<string, { capabilityTypeId: string; code: string; name: string; kind: string }[]>();
        for (const c of caps.rows) {
          const list = bySupplier.get(c.supplier_id) ?? [];
          list.push({ capabilityTypeId: c.capability_type_id, code: c.code, name: c.name, kind: c.kind });
          bySupplier.set(c.supplier_id, list);
        }

        const types = await tx.query<{ id: string; code: string; name: string; kind: string }>(
          `select id, code, name, kind from app.supplier_capability_type
            where deleted_at is null order by code`,
        );

        return {
          supplierCount: res.rows.length,
          suppliers: res.rows.map((r) => ({
            supplierId: r.id,
            code: r.code,
            name: r.name,
            paymentTermsDays: r.payment_terms_days,
            currencyCode: r.currency_code,
            contactName: r.contact_name,
            contactPhone: r.contact_phone,
            contactEmail: r.contact_email,
            addressText: r.address_text,
            notes: r.notes,
            isActive: r.is_active,
            capabilities: bySupplier.get(r.id) ?? [],
          })),
          /** The tenant's own taxonomy. `code`/`name` are its words; `kind` is ours. */
          capabilityTypes: types.rows.map((t) => ({
            capabilityTypeId: t.id,
            code: t.code,
            name: t.name,
            kind: t.kind,
          })),
        };
      });
    }),

  /**
   * Create or amend a supplier, and — when `capabilityTypeIds` is supplied —
   * REPLACE its capability set in the same idempotent unit of work.
   *
   * DEACTIVATION IS AN AMEND WITH `isActive: false`, not a delete. A supplier
   * with purchase orders and receipts against it must stay resolvable
   * forever, or every historical document loses the name of the party it was
   * with; and a delete that syncs is unrecoverable. Deactivated suppliers
   * drop out of `listSuppliers` unless `includeInactive` is asked for, and
   * out of the reorder suggestion entirely.
   *
   * The currency is NOT a parameter: it comes from the tenant's jurisdiction
   * pack, server-side, and 0008's trigger refuses anything else. A client
   * that could state a currency could state the wrong one.
   */
  upsertSupplier: permissionProcedure({ code: 'supplier.manage', at: 'tenant' })
    .input(upsertSupplierInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.identity.tenantId;
      const key = input.idempotencyKey;
      const result = await runIdempotent(
        { runner: ctx.deps.runner, clock: ctx.deps.clock },
        ctx.identity,
        { op: 'procurement.upsert_supplier', idempotencyKey: key, claimedHlc: input.claimedHlc, clientWallAt: input.clientWallAt },
        input,
        async (tx) => {
          const jur = await loadJurisdiction(tx);

          let supplierId = input.supplierId;
          let created = true;
          if (supplierId !== undefined) {
            const found = await tx.query<{ id: string }>(
              `select id from app.supplier where id = $1 and deleted_at is null`,
              [supplierId],
            );
            if (!found.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'supplier not found' });
            created = false;
          } else {
            supplierId = deterministicUuid(key, 'supplier');
          }
          const id = supplierId;

          // The code is the tenant's own human key and is unique among live
          // suppliers. Checking here turns a 23505 into a message a person
          // can act on; the partial unique index remains the real guarantee.
          const clash = await tx.query<{ id: string }>(
            `select id from app.supplier where code = $1 and deleted_at is null and id <> $2`,
            [input.code, id],
          );
          if (clash.rows[0]) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: `supplier code ${input.code} is already in use`,
            });
          }

          let capabilityTypeIds: string[] = [];
          if (input.capabilityTypeIds !== undefined) {
            const wanted = [...new Set(input.capabilityTypeIds)];
            if (wanted.length > 0) {
              const known = await tx.query<{ id: string }>(
                `select id from app.supplier_capability_type
                  where id = any($1::uuid[]) and deleted_at is null`,
                [wanted],
              );
              if (known.rows.length !== wanted.length) {
                throw new TRPCError({
                  code: 'NOT_FOUND',
                  message: 'one or more capability types do not exist in this tenant',
                });
              }
            }
            capabilityTypeIds = wanted;
          } else if (!created) {
            const existing = await tx.query<{ capability_type_id: string }>(
              `select capability_type_id from app.supplier_capability
                where supplier_id = $1 and deleted_at is null`,
              [id],
            );
            capabilityTypeIds = existing.rows.map((r) => r.capability_type_id);
          }

          const isActive = input.isActive ?? true;
          const response = {
            supplierId: id,
            created,
            code: input.code,
            name: input.name,
            paymentTermsDays: input.paymentTermsDays,
            /** The pack's, never the client's (CLAUDE.md §2.5). */
            currencyCode: jur.currencyCode,
            isActive,
            capabilityTypeIds,
            capabilitiesReplaced: input.capabilityTypeIds !== undefined,
          };

          return {
            response,
            apply: async (atx) => {
              if (created) {
                await atx.query(
                  `insert into app.supplier
                     (tenant_id, id, write_id, hlc, code, name, payment_terms_days, currency_code,
                      contact_name, contact_phone, contact_email, address_text, notes, is_active)
                   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
                  [
                    tenantId, id, key, ctx.deps.clock.next(),
                    input.code, input.name, input.paymentTermsDays, jur.currencyCode,
                    input.contactName ?? null, input.contactPhone ?? null,
                    input.contactEmail ?? null, input.addressText ?? null,
                    input.notes ?? null, isActive,
                  ],
                );
              } else {
                await atx.query(
                  `update app.supplier
                      set code = $2, name = $3, payment_terms_days = $4,
                          contact_name = $5, contact_phone = $6, contact_email = $7,
                          address_text = $8, notes = $9, is_active = $10,
                          write_id = $11, hlc = $12, updated_at = transaction_timestamp()
                    where id = $1 and deleted_at is null`,
                  [
                    id, input.code, input.name, input.paymentTermsDays,
                    input.contactName ?? null, input.contactPhone ?? null,
                    input.contactEmail ?? null, input.addressText ?? null,
                    input.notes ?? null, isActive, key, ctx.deps.clock.next(),
                  ],
                );
              }

              if (input.capabilityTypeIds === undefined) return;

              // REPLACE the set: retire what is no longer held, then add what
              // is missing. Soft delete, never DELETE — a capability somebody
              // removed by mistake is recoverable, and the partial unique
              // index is on live rows only, so a later re-add revives the row
              // rather than colliding with its ghost.
              await atx.query(
                `update app.supplier_capability
                    set deleted_at = transaction_timestamp(), write_id = $3, hlc = $4,
                        updated_at = transaction_timestamp()
                  where supplier_id = $1 and deleted_at is null
                    and not (capability_type_id = any($2::uuid[]))`,
                [id, capabilityTypeIds, key, ctx.deps.clock.next()],
              );
              for (const capId of capabilityTypeIds) {
                await atx.query(
                  `insert into app.supplier_capability
                     (tenant_id, id, write_id, hlc, supplier_id, capability_type_id)
                   select $1, $2, $3, $4, $5, $6
                    where not exists (
                      select 1 from app.supplier_capability
                       where tenant_id = $1 and supplier_id = $5
                         and capability_type_id = $6 and deleted_at is null)
                   on conflict (tenant_id, id) do update
                     set deleted_at = null, write_id = excluded.write_id,
                         hlc = excluded.hlc, updated_at = transaction_timestamp()`,
                  [
                    tenantId,
                    deterministicUuid(tenantId, 'supplier_capability', id, capId),
                    key,
                    ctx.deps.clock.next(),
                    id,
                    capId,
                  ],
                );
              }
            },
          };
        },
      );
      return result.response;
    }),

  // ─────────────────────────────────────────────────────────────────────────
  // MULTI-SOURCE
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Declare that a supplier can supply a product, in a stated purchase unit.
   * The same SKU from three manufacturers is three of these — which is what
   * makes multi-sourcing data rather than somebody's memory.
   *
   * `isPreferred` is a DEFAULT, never a restriction: ordering from a
   * non-preferred source needs no extra capability. At most one source per
   * product may be preferred (a partial unique index), so setting it clears
   * the incumbent in the same transaction rather than letting the index
   * refuse the write and leave the tenant unable to change its mind.
   */
  upsertSupplierProduct: permissionProcedure({ code: 'supplier.manage', at: 'tenant' })
    .input(upsertSupplierProductInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.identity.tenantId;
      const key = input.idempotencyKey;
      const result = await runIdempotent(
        { runner: ctx.deps.runner, clock: ctx.deps.clock },
        ctx.identity,
        { op: 'procurement.upsert_supplier_product', idempotencyKey: key, claimedHlc: input.claimedHlc, clientWallAt: input.clientWallAt },
        input,
        async (tx) => {
          const sup = await tx.query<{ id: string }>(
            `select id from app.supplier where id = $1 and deleted_at is null`,
            [input.supplierId],
          );
          if (!sup.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'supplier not found' });

          const prod = await tx.query<{ id: string; sku_code: string; is_purchasable: boolean }>(
            `select id, sku_code, is_purchasable from app.product where id = $1 and deleted_at is null`,
            [input.productId],
          );
          const product = prod.rows[0];
          if (!product) throw new TRPCError({ code: 'NOT_FOUND', message: 'product not found' });
          if (!product.is_purchasable) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: `product ${product.sku_code} is not purchasable`,
            });
          }

          // THE UNIT GUARD. Same machinery as selling, opposite direction.
          const unit = await loadBuyableUnit(tx, input.productId, input.purchaseUomId);

          const existing = await tx.query<{ id: string }>(
            `select id from app.supplier_product
              where supplier_id = $1 and product_id = $2 and deleted_at is null`,
            [input.supplierId, input.productId],
          );
          const created = existing.rows.length === 0;
          const rowId = existing.rows[0]?.id ?? deterministicUuid(key, 'supplier_product');
          const isPreferred = input.isPreferred ?? false;
          const isActive = input.isActive ?? true;

          const response = {
            supplierProductId: rowId,
            created,
            supplierId: input.supplierId,
            productId: input.productId,
            skuCode: product.sku_code,
            purchaseUomId: unit.uomId,
            purchaseUomCode: unit.uomCode,
            buyScale: unit.buyScale,
            stockingUomId: unit.stockingUomId,
            stockingUomCode: unit.stockingUomCode,
            stockUnitsPerPurchaseUnitNum: unit.factorNum.toString(10),
            stockUnitsPerPurchaseUnitDen: unit.factorDen.toString(10),
            supplierSku: input.supplierSku ?? null,
            leadTimeDays: input.leadTimeDays ?? null,
            lastPriceE4: input.lastPriceE4 === undefined ? null : wire(input.lastPriceE4),
            lastPriceOn: input.lastPriceOn ?? null,
            /** The comparable figure this row contributes, per STOCKING unit. */
            pricePerStockUnitE4:
              input.lastPriceE4 === undefined
                ? null
                : wire(pricePerStockUnitE4(input.lastPriceE4, unit)),
            isPreferred,
            isActive,
          };

          return {
            response,
            apply: async (atx) => {
              if (isPreferred) {
                await atx.query(
                  `update app.supplier_product
                      set is_preferred = false, write_id = $3, hlc = $4,
                          updated_at = transaction_timestamp()
                    where product_id = $1 and id <> $2
                      and is_preferred and deleted_at is null`,
                  [input.productId, rowId, key, ctx.deps.clock.next()],
                );
              }
              await atx.query(
                `insert into app.supplier_product
                   (tenant_id, id, write_id, hlc, supplier_id, product_id, supplier_sku,
                    purchase_uom_id, lead_time_days, last_price_e4, last_price_on,
                    is_preferred, is_active, notes)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13,$14)
                 on conflict (tenant_id, id) do update
                   set supplier_sku    = excluded.supplier_sku,
                       purchase_uom_id = excluded.purchase_uom_id,
                       lead_time_days  = excluded.lead_time_days,
                       last_price_e4   = excluded.last_price_e4,
                       last_price_on   = excluded.last_price_on,
                       is_preferred    = excluded.is_preferred,
                       is_active       = excluded.is_active,
                       notes           = excluded.notes,
                       write_id        = excluded.write_id,
                       hlc             = excluded.hlc,
                       updated_at      = transaction_timestamp()`,
                [
                  tenantId, rowId, key, ctx.deps.clock.next(),
                  input.supplierId, input.productId, input.supplierSku ?? null,
                  unit.uomId, input.leadTimeDays ?? null,
                  input.lastPriceE4 === undefined ? null : wire(input.lastPriceE4),
                  input.lastPriceOn ?? null,
                  isPreferred, isActive, input.notes ?? null,
                ],
              );
            },
          };
        },
      );
      return result.response;
    }),

  /**
   * WHO CAN SUPPLY THIS, AND AT WHAT PRICE IN A COMMON UNIT.
   *
   * Each source states its own purchase unit and its own quote in that unit;
   * `pricePerStockUnitE4` restates every one of them in the product's
   * STOCKING unit so they can be compared at all, and the list is ordered
   * cheapest-first on the exact rational — never on the rounded display
   * figure. Sources we have never bought from carry a null price and a stated
   * reason, and sort last: they are not "free", they are unknown.
   *
   * `cheapestSupplierId` is decision SUPPORT. Nothing orders from it.
   */
  suppliersForProduct: permissionProcedure({ code: 'supplier.view', at: 'any' })
    .input(suppliersForProductInput)
    .query(async ({ ctx, input }) => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const prod = await tx.query<{
          id: string;
          sku_code: string;
          name: string;
          stocking_uom_id: string;
          uom_code: string;
          qty_scale: number;
        }>(
          `select p.id, p.sku_code, p.name, p.stocking_uom_id, u.code as uom_code, u.qty_scale
             from app.product p
             join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
            where p.id = $1 and p.deleted_at is null`,
          [input.productId],
        );
        const product = prod.rows[0];
        if (!product) throw new TRPCError({ code: 'NOT_FOUND', message: 'product not found' });

        const rows = await selectSources(tx, [product.id], input.includeInactive ?? false);
        const sources = rows.map(toSourceWithUnit).sort(compareSources);
        const priced = sources.filter((s) => s.priceE4 !== null);

        return {
          productId: product.id,
          skuCode: product.sku_code,
          productName: product.name,
          /** Every comparable price below is per ONE of THIS unit, ×10⁴. */
          stockingUomId: product.stocking_uom_id,
          stockingUomCode: product.uom_code,
          qtyScale: product.qty_scale,
          sourceCount: sources.length,
          pricedSourceCount: priced.length,
          preferredSupplierId: sources.find((s) => s.row.is_preferred)?.row.supplier_id ?? null,
          /** Cheapest IN THE COMMON UNIT. Null when nothing is priced. */
          cheapestSupplierId: priced[0]?.row.supplier_id ?? null,
          sources: sources.map(compared),
        };
      });
    }),

  // ─────────────────────────────────────────────────────────────────────────
  // PURCHASE ORDERS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Raise a purchase order. It is created as a DRAFT — always; 0008's trigger
   * refuses any other insert status, because approval is a separate act by a
   * separate capability and it must leave a record.
   *
   * `purchase.order.create` AT THE DELIVER-TO LOCATION: the middleware checks
   * the capability there and, because this is a mutation, that the token is
   * scoped there too. A manager at one outlet cannot order goods into
   * another's yard.
   *
   * The order number is absent deliberately (03 §3.7.5): a network-wide
   * document number is coordination two offline outlets cannot do. The uuid
   * is identity; a tenant that wants numbers allocates them from a sequence
   * block the way receipts do.
   */
  createPurchaseOrder: tenantProcedure
    .input(createPurchaseOrderInput)
    .use(requiresPermission({
      code: 'purchase.order.create',
      at: 'input',
      locationField: 'deliverToLocationId',
    }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.identity.tenantId;
      const key = input.idempotencyKey;
      const result = await runIdempotent(
        { runner: ctx.deps.runner, clock: ctx.deps.clock },
        ctx.identity,
        {
          op: 'procurement.create_purchase_order',
          idempotencyKey: key,
          claimedHlc: input.claimedHlc,
          clientWallAt: input.clientWallAt,
          locationId: input.deliverToLocationId,
        },
        input,
        async (tx) => {
          const jur = await loadJurisdiction(tx);

          const sup = await tx.query<{ id: string; code: string; name: string; is_active: boolean }>(
            `select id, code, name, is_active from app.supplier where id = $1 and deleted_at is null`,
            [input.supplierId],
          );
          const supplier = sup.rows[0];
          if (!supplier) throw new TRPCError({ code: 'NOT_FOUND', message: 'supplier not found' });
          if (!supplier.is_active) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: `supplier ${supplier.code} is not active`,
            });
          }

          const loc = await tx.query<{ id: string; kind: string; code: string; name: string }>(
            `select id, kind, code, name from app.location where id = $1 and deleted_at is null`,
            [input.deliverToLocationId],
          );
          const location = loc.rows[0];
          if (!location) throw new TRPCError({ code: 'NOT_FOUND', message: 'location not found' });
          if (location.kind !== 'OUTLET' && location.kind !== 'WAREHOUSE') {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'goods can only be ordered to a location that holds stock',
            });
          }

          const lines = await planLines(tx, input.lines);
          // Exact bigint sum of the once-rounded parts. The order has no
          // stored total, so this cannot drift from Σ(lines) — it IS Σ(lines).
          const totalMinor = lines.reduce((a, l) => a + l.lineNetMinor, 0n);

          const orderId = deterministicUuid(key, 'purchase_order');
          const response = {
            purchaseOrderId: orderId,
            status: 'DRAFT',
            supplierId: supplier.id,
            supplierCode: supplier.code,
            supplierName: supplier.name,
            deliverToLocationId: location.id,
            locationCode: location.code,
            orderNo: null,
            orderDate: input.orderDate,
            expectedAt: input.expectedAt ?? null,
            currencyCode: jur.currencyCode,
            moneyScale: jur.minorUnitsPerMajor.toString(10),
            lineCount: lines.length,
            totalMinor: wire(totalMinor),
            lines: lines.map(plannedLineDto),
          };

          return {
            response,
            apply: async (atx) => {
              await atx.query(
                `insert into app.purchase_order
                   (tenant_id, id, write_id, hlc, supplier_id, deliver_to_location_id,
                    status, order_date, expected_at, currency_code, money_scale, notes)
                 values ($1,$2,$3,$4,$5,$6,'DRAFT',$7::date,$8::date,$9,$10,$11)`,
                [
                  tenantId, orderId, key, ctx.deps.clock.next(),
                  supplier.id, location.id, input.orderDate, input.expectedAt ?? null,
                  jur.currencyCode, jur.minorUnitsPerMajor.toString(10), input.notes ?? null,
                ],
              );
              await insertLines(atx, {
                tenantId,
                writeId: key,
                hlc: () => ctx.deps.clock.next(),
                purchaseOrderId: orderId,
                idPrefix: 'purchase_order_line',
                lines,
              });
            },
          };
        },
      );
      return result.response;
    }),

  /**
   * Amend a DRAFT order. Supplying `lines` REPLACES every line.
   *
   * The order names no location, so the declared requirement is the coarse
   * "holds `purchase.order.create` somewhere" and the real check is made at
   * THE ORDER'S OWN deliver-to location once it is loaded — together with
   * `assertLocationInScope`, which the middleware does for itself only when
   * the payload carries the location.
   *
   * Refused once the order leaves DRAFT, by 0008's trigger and by the check
   * here: freezing the status without freezing the lines would let an
   * approved order be retro-fitted to whatever turned up, which is precisely
   * the fabrication a purchase order exists to prevent.
   */
  updatePurchaseOrder: tenantProcedure
    .input(updatePurchaseOrderInput)
    .use(requiresPermission({ code: 'purchase.order.create', at: 'any' }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.identity.tenantId;
      const key = input.idempotencyKey;

      // Resolve the order's location BEFORE the pipeline opens its
      // transaction, so the authorisation decision is made against the
      // already-resolved permission snapshot and no transaction is opened
      // inside another one (see ../permissions.ts).
      const header = await ctx.deps.runner.withTenant(tenantId, (tx) =>
        loadOrderHeader(tx, input.purchaseOrderId),
      );
      ctx.permissions.requireAt('purchase.order.create', header.deliver_to_location_id);
      assertLocationInScope(ctx.identity, header.deliver_to_location_id);

      const result = await runIdempotent(
        { runner: ctx.deps.runner, clock: ctx.deps.clock },
        ctx.identity,
        {
          op: 'procurement.update_purchase_order',
          idempotencyKey: key,
          claimedHlc: input.claimedHlc,
          clientWallAt: input.clientWallAt,
          locationId: header.deliver_to_location_id,
        },
        input,
        async (tx) => {
          const order = await loadOrderHeader(tx, input.purchaseOrderId);
          if (order.status !== 'DRAFT') {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message:
                `purchase order is ${order.status} — lines and terms may only be changed while it is ` +
                `DRAFT. Correcting an issued order means cancelling or closing it and raising another`,
            });
          }

          const lines = input.lines === undefined ? null : await planLines(tx, input.lines);
          const totalMinor =
            lines === null
              ? BigInt(order.total_minor)
              : lines.reduce((a, l) => a + l.lineNetMinor, 0n);

          const response = {
            purchaseOrderId: order.id,
            status: order.status,
            expectedAt: input.expectedAt ?? order.expected_at,
            notes: input.notes ?? order.notes,
            linesReplaced: lines !== null,
            lineCount: lines === null ? Number(order.line_count) : lines.length,
            totalMinor: wire(totalMinor),
            lines: lines === null ? null : lines.map(plannedLineDto),
          };

          return {
            response,
            apply: async (atx) => {
              await atx.query(
                `update app.purchase_order
                    set expected_at = coalesce($2::date, expected_at),
                        notes = coalesce($3, notes),
                        write_id = $4, hlc = $5, updated_at = transaction_timestamp()
                  where id = $1 and status = 'DRAFT' and deleted_at is null`,
                [
                  order.id,
                  input.expectedAt ?? null,
                  input.notes ?? null,
                  key,
                  ctx.deps.clock.next(),
                ],
              );
              if (lines === null) return;
              // Soft delete, then re-insert. The line unique index is on LIVE
              // rows only, so the same line numbers may be reused, and the
              // replaced rows stay readable as history.
              await atx.query(
                `update app.purchase_order_line
                    set deleted_at = transaction_timestamp(), write_id = $2, hlc = $3,
                        updated_at = transaction_timestamp()
                  where purchase_order_id = $1 and deleted_at is null`,
                [order.id, key, ctx.deps.clock.next()],
              );
              await insertLines(atx, {
                tenantId,
                writeId: key,
                hlc: () => ctx.deps.clock.next(),
                purchaseOrderId: order.id,
                idPrefix: 'purchase_order_line_amended',
                lines,
              });
            },
          };
        },
      );
      return result.response;
    }),

  /**
   * Move an order along its state machine.
   *
   * ONE mutation rather than submit/approve/cancel/close verbs, because the
   * legality of a move is the DATABASE's answer and four endpoints would be
   * four places to forget to ask it. The CAPABILITY still differs per target
   * status (`PURCHASE_ORDER_STATUS_PERMISSION`), so approving remains a
   * permission that raising an order does not carry.
   *
   * ── THE BOUND ────────────────────────────────────────────────────────────
   * `purchase.order.approve` is never a bare capability: the template grants
   * it bounded at `max_order_value_minor` — a decimal STRING in minor units,
   * because a bigint inside jsonb becomes a float64 the instant JSON.parse
   * touches it. It is measured against the SERVER'S OWN Σ(lines), summed from
   * `purchase_order_line` inside this transaction. There is no client figure
   * to measure it against and there must never be one: a device that could
   * state the number its bound is checked against would have no bound at all.
   * Exceeding it throws, which rolls the whole transaction back — marker
   * included — so a refused approval leaves no approved order behind.
   */
  changePurchaseOrderStatus: tenantProcedure
    .input(changePurchaseOrderStatusInput)
    .use(requiresPermission({ code: statusPermission, at: 'any' }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.identity.tenantId;
      const key = input.idempotencyKey;
      const required = PURCHASE_ORDER_STATUS_PERMISSION[input.toStatus];

      const header = await ctx.deps.runner.withTenant(tenantId, (tx) =>
        loadOrderHeader(tx, input.purchaseOrderId),
      );
      ctx.permissions.requireAt(required, header.deliver_to_location_id);
      assertLocationInScope(ctx.identity, header.deliver_to_location_id);

      const result = await runIdempotent(
        { runner: ctx.deps.runner, clock: ctx.deps.clock },
        ctx.identity,
        {
          op: 'procurement.change_purchase_order_status',
          idempotencyKey: key,
          claimedHlc: input.claimedHlc,
          clientWallAt: input.clientWallAt,
          locationId: header.deliver_to_location_id,
        },
        input,
        async (tx) => {
          const order = await loadOrderHeader(tx, input.purchaseOrderId);
          const from = order.status;
          if (from === input.toStatus) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: `purchase order is already ${from}`,
            });
          }

          // ASK THE DATABASE. The trigger is the enforcement; this call is so
          // an illegal move reads as a refusal a person can act on rather than
          // as a constraint violation, and so the two can never disagree.
          const allowed = await tx.query<{ ok: boolean }>(
            `select app.purchase_order_transition_allowed($1, $2) as ok`,
            [from, input.toStatus],
          );
          if (allowed.rows[0]?.ok !== true) {
            const next = await legalNextStatuses(tx, from);
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message:
                `${from} -> ${input.toStatus} is not a legal transition; from ${from} the legal ` +
                `next steps are ${next.length === 0 ? '(none — terminal)' : next.join(', ')}`,
            });
          }

          const lineCount = Number(order.line_count);
          if (from === 'DRAFT' && lineCount === 0) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'an order for nothing is not an order — a draft cannot leave DRAFT with no lines',
            });
          }

          const totalMinor = BigInt(order.total_minor);
          if (input.toStatus === 'APPROVED') {
            ctx.permissions.requireWithinAmount(
              'purchase.order.approve',
              order.deliver_to_location_id,
              totalMinor,
            );
          }

          const now = new Date().toISOString();
          const response = {
            purchaseOrderId: order.id,
            fromStatus: from,
            status: input.toStatus,
            lineCount,
            /** The figure the bound was measured against. Σ(lines), exactly. */
            totalMinor: order.total_minor,
            currencyCode: order.currency_code,
            moneyScale: order.money_scale,
            approvedByUserId: input.toStatus === 'APPROVED' ? ctx.identity.userId : order.approved_by_user_id,
            cancelReason: input.toStatus === 'CANCELLED' ? (input.reason ?? null) : order.cancel_reason,
          };

          return {
            response,
            apply: async (atx) => {
              const res = await atx.query<{ id: string }>(
                `update app.purchase_order
                    set status = $2,
                        submitted_at = case when $2 = 'SUBMITTED' then $3::timestamptz else submitted_at end,
                        approved_at  = case when $2 = 'APPROVED'  then $3::timestamptz else approved_at end,
                        approved_by_user_id =
                          case when $2 = 'APPROVED' then $4::uuid else approved_by_user_id end,
                        closed_at    = case when $2 = 'CLOSED'    then $3::timestamptz else closed_at end,
                        cancelled_at = case when $2 = 'CANCELLED' then $3::timestamptz else cancelled_at end,
                        cancel_reason =
                          case when $2 = 'CANCELLED' then $5 else cancel_reason end,
                        write_id = $6, hlc = $7, updated_at = transaction_timestamp()
                  where id = $1 and status = $8 and deleted_at is null
                  returning id`,
                [
                  order.id, input.toStatus, now, ctx.identity.userId,
                  input.reason ?? null, key, ctx.deps.clock.next(), from,
                ],
              );
              if (res.rows.length === 0) {
                // Somebody else moved it between the read and the write.
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: `purchase order is no longer ${from} — re-read it and try again`,
                });
              }
            },
          };
        },
      );
      return result.response;
    }),

  /**
   * One order: header, lines, what is still outstanding on each, and the
   * legal next statuses READ FROM THE DATABASE so a screen greys out buttons
   * from the server's answer and never from a second copy of the table.
   *
   * `qtyOutstanding` comes from `app.purchase_order_line_status`, which
   * derives it by summing matched receipt lines — never a stored counter —
   * and does NOT clamp it: an over-delivery shows as a negative, because
   * hiding it hides the one an invoice will be raised for.
   */
  purchaseOrder: permissionProcedure({ code: 'purchase.order.view', at: 'any' })
    .input(purchaseOrderInput)
    .query(async ({ ctx, input }) => {
      const tenantId = ctx.identity.tenantId;
      const header = await ctx.deps.runner.withTenant(tenantId, (tx) =>
        loadOrderHeader(tx, input.purchaseOrderId),
      );
      // The capability at THE ORDER'S location, not merely somewhere.
      ctx.permissions.requireAt('purchase.order.view', header.deliver_to_location_id);

      return ctx.deps.runner.withTenant(tenantId, async (tx) => {
        const lines = await tx.query<{
          purchase_order_line_id: string;
          line_no: number;
          product_id: string;
          sku_code: string;
          product_name: string;
          uom_id: string;
          uom_code: string;
          qty_scale: number;
          qty_ordered: string;
          qty_received: string;
          qty_outstanding: string;
          is_fully_received: boolean;
          receipt_line_count: string;
          stocking_uom_id: string;
          stocking_uom_code: string;
          qty_stock_scale: number;
          qty_ordered_stock: string;
          qty_stock_received: string;
          factor_num: string;
          factor_den: string;
          unit_price_e4: string;
          line_net_minor: string;
          notes: string | null;
        }>(
          `select st.purchase_order_line_id, st.line_no, st.product_id,
                  p.sku_code, p.name as product_name,
                  st.uom_id, u.code as uom_code, st.qty_scale,
                  st.qty_ordered::text, st.qty_received::text, st.qty_outstanding::text,
                  st.is_fully_received, st.receipt_line_count::text,
                  st.stocking_uom_id, su.code as stocking_uom_code, st.qty_stock_scale,
                  st.qty_ordered_stock::text, st.qty_stock_received::text,
                  pol.factor_num::text, pol.factor_den::text,
                  pol.unit_price_e4::text, pol.line_net_minor::text, pol.notes
             from app.purchase_order_line_status st
             join app.purchase_order_line pol
               on pol.tenant_id = st.tenant_id and pol.id = st.purchase_order_line_id
             join app.product p on p.tenant_id = st.tenant_id and p.id = st.product_id
             join app.unit_of_measure u  on u.tenant_id  = st.tenant_id and u.id  = st.uom_id
             join app.unit_of_measure su on su.tenant_id = st.tenant_id and su.id = st.stocking_uom_id
            where st.purchase_order_id = $1
            order by st.line_no`,
          [input.purchaseOrderId],
        );

        return {
          ...headerDto(header),
          legalNextStatuses: await legalNextStatuses(tx, header.status),
          lines: lines.rows.map((r) => ({
            purchaseOrderLineId: r.purchase_order_line_id,
            lineNo: r.line_no,
            productId: r.product_id,
            skuCode: r.sku_code,
            productName: r.product_name,
            uomId: r.uom_id,
            uomCode: r.uom_code,
            qtyScale: r.qty_scale,
            qtyOrdered: r.qty_ordered,
            qtyReceived: r.qty_received,
            /** SIGNED: negative is an over-delivery, deliberately not clamped. */
            qtyOutstanding: r.qty_outstanding,
            isFullyReceived: r.is_fully_received,
            receiptLineCount: Number(r.receipt_line_count),
            stockingUomId: r.stocking_uom_id,
            stockingUomCode: r.stocking_uom_code,
            qtyStockScale: r.qty_stock_scale,
            qtyOrderedStock: r.qty_ordered_stock,
            qtyStockReceived: r.qty_stock_received,
            factorNum: r.factor_num,
            factorDen: r.factor_den,
            unitPriceE4: r.unit_price_e4,
            lineNetMinor: r.line_net_minor,
            notes: r.notes,
          })),
        };
      });
    }),

  /**
   * Orders across the locations this caller may see. `locationIds` NARROWS
   * and never widens: a requested location the caller does not hold
   * `purchase.order.view` at is REFUSED, not silently dropped — a list that
   * quietly excluded a yard is a wrong answer wearing a right one's clothes.
   */
  listPurchaseOrders: permissionProcedure({ code: 'purchase.order.view', at: 'any' })
    .input(listPurchaseOrdersInput)
    .query(async ({ ctx, input }) => {
      const scope = await resolveLocationScope(ctx, {
        code: 'purchase.order.view',
        requested: input.locationIds,
        kinds: ['OUTLET', 'WAREHOUSE'],
      });

      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const res = await tx.query<OrderHeaderRow>(
          `${ORDER_HEADER_SQL}
            where po.deleted_at is null
              and po.deliver_to_location_id = any($1::uuid[])
              and ($2::uuid is null or po.supplier_id = $2)
              and ($3::text[] is null or po.status = any($3::text[]))
              and ($4::date is null or po.order_date >= $4::date)
              and ($5::date is null or po.order_date <= $5::date)
            order by po.order_date desc, po.id desc
            limit $6`,
          [
            [...scope.locationIds],
            input.supplierId ?? null,
            input.statuses ? [...input.statuses] : null,
            input.from ?? null,
            input.to ?? null,
            input.limit ?? 100,
          ],
        );
        const orders = res.rows.map(headerDto);
        return {
          scope: { locationCount: scope.locations.length, network: scope.network },
          orderCount: orders.length,
          /** Σ over the SAME resolved set the rows came from. */
          totalMinor: wire(orders.reduce((a, o) => a + BigInt(o.totalMinor), 0n)),
          orders,
          locations: scope.locations.map((l) => ({
            locationId: l.id,
            locationCode: l.code,
            locationName: l.name,
          })),
        };
      });
    }),

  // ═════════════════════════════════════════════════════════════════════════
  // REORDER SUGGESTIONS — Phase 2's explicit tie to the Phase 1 alerts
  // ═════════════════════════════════════════════════════════════════════════
  //
  // CLAUDE.md §3 asks for "reorder points tied to Phase 1 alerts". The tie is
  // made by REUSING, not by re-deriving:
  //
  //   * the same INPUT — `lowStockInput`, the alert's own contract;
  //   * the same QUERY — `selectLowStockRows` from ./inventory.ts, so the
  //     at-or-below comparison, the active filter and the urgency ordering
  //     are one implementation. A second query agreeing today is a second
  //     query drifting next quarter;
  //   * the same ROWS — `app.reorder_point`, whose `reorder_up_to_qty` and
  //     `lead_time_days` were written in Phase 1 as unread seams and are read
  //     here for the first time. There is no second notion of "how low is
  //     low" for procurement to invent.
  //
  // IT SUGGESTS. IT NEVER ORDERS. Nothing in this procedure writes anything:
  // it is a query, it has no idempotency key, and there is no auto-order path
  // anywhere in this router. A suggestion built from a `last_price_e4` that
  // may be a year old, and from a threshold seeded with a flagged assumption,
  // is decision support for a person — turning it into a commitment would put
  // the tenant's money behind data nobody has confirmed.
  //
  // TWO CAPABILITIES, and the pair is the point. `stock.view` says you may
  // know what is low here. `supplier.view` says you may be told who supplies
  // it, on what terms and at what price — commercial facts the template
  // deliberately withholds from counter staff. Holding the first without the
  // second gets you the Phase 1 alert and no suggestion, which is exactly
  // right: the counter needs to know it is out of something; it does not need
  // to know what the business pays for it.

  reorderSuggestions: permissionProcedure({ code: 'stock.view', at: 'any' })
    .input(lowStockInput)
    .query(async ({ ctx, input }) => {
      // The second capability, against the snapshot already resolved for this
      // request — synchronous, so no transaction is opened inside another.
      ctx.permissions.requireAnywhere('supplier.view');

      const scope = await resolveLocationScope(ctx, {
        code: 'stock.view',
        requested: input.locationIds,
        kinds: ['OUTLET', 'WAREHOUSE'],
      });

      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const low = await selectLowStockRows(tx, {
          locationIds: scope.locationIds,
          productIds: input.productIds,
          limit: input.limit,
        });

        // WHY THE LIST IS EMPTY MATTERS MORE THAN THAT IT IS EMPTY.
        // "Nothing is below its threshold" and "nobody has set a threshold"
        // look identical as an empty array and mean opposite things — the
        // second is reassuring and false. Counting the ACTIVE thresholds in
        // scope is what lets the answer say which (docs/phase1-status.md §0a).
        const thresholds = await tx.query<{ n: string }>(
          `select count(*)::text as n from app.reorder_status rs
            where rs.location_id = any($1::uuid[]) and rs.is_active`,
          [[...scope.locationIds]],
        );
        const activeThresholdCount = Number(thresholds.rows[0]?.n ?? '0');

        const productIds = [...new Set(low.map((r) => r.product_id))];
        const sourceRows = await selectSources(tx, productIds, false);
        const byProduct = new Map<string, SourceWithUnit[]>();
        for (const row of sourceRows) {
          const list = byProduct.get(row.product_id) ?? [];
          list.push(toSourceWithUnit(row));
          byProduct.set(row.product_id, list);
        }
        for (const list of byProduct.values()) list.sort(compareSources);

        const suggestions: ReorderSuggestion[] = [];
        const unsourced: UnsourcedLowStockItem[] = [];

        for (const r of low) {
          const sources = byProduct.get(r.product_id) ?? [];
          const base: LowStockFigures = {
            locationId: r.location_id,
            reorderPointId: r.reorder_point_id,
            productId: r.product_id,
            skuCode: r.sku_code,
            productName: r.product_name,
            // Phase 1's own figures, unchanged, in the STOCKING unit.
            qtyOnHand: r.qty_on_hand,
            reorderPointQty: r.reorder_point_qty,
            reorderUpToQty: r.reorder_up_to_qty,
            shortfallQty: r.shortfall_qty,
            qtyScale: r.qty_scale,
            uomCode: r.uom_code,
            coverageBp: r.coverage_bp,
            /** The threshold's own lead time, if the tenant recorded one. */
            reorderLeadTimeDays: r.lead_time_days,
          };

          if (sources.length === 0) {
            // The most actionable line on the page: we are out of it and
            // nobody is recorded as selling it. Dropping it would make the
            // suggestion list silently incomplete.
            unsourced.push({ ...base, reason: 'NO_ACTIVE_SUPPLIER' });
            continue;
          }

          // WHICH SOURCE. Preferred if one is flagged; the only one if there
          // is only one; otherwise NONE — and the alternatives are handed to
          // the human instead. Picking the cheapest automatically would be an
          // auto-decision made from a decision-support price that may be
          // stale, which is the one thing this endpoint must not do.
          const preferred = sources.find((s) => s.row.is_preferred);
          const chosen = preferred ?? (sources.length === 1 ? sources[0]! : null);
          const basis = preferred ? 'PREFERRED' : sources.length === 1 ? 'ONLY_SOURCE' : 'AMBIGUOUS';

          const shortfallStock = BigInt(r.shortfall_qty);
          const hasOrderUpTo = r.reorder_up_to_qty !== null;
          const qtyBasis = hasOrderUpTo ? 'ORDER_UP_TO' : 'REORDER_POINT_ONLY';

          let qtyToOrder: string | null = null;
          let qtyUnavailableReason: ReorderRecommendation['qtyUnavailableReason'] = null;
          let estimatedCostMinor: string | null = null;
          let estimateUnavailableReason: ReorderRecommendation['estimateUnavailableReason'] = null;

          if (chosen === null) {
            qtyUnavailableReason = 'NO_SINGLE_SOURCE_TO_PRICE_IT_IN';
            estimateUnavailableReason = 'NO_SINGLE_SOURCE_TO_PRICE_IT_IN';
          } else if (shortfallStock <= 0n) {
            // At the threshold exactly, with no order-up-to level: there is
            // nothing that says how much to buy, and inventing a quantity
            // here would be the platform choosing a stocking policy.
            qtyUnavailableReason = 'NO_ORDER_UP_TO_LEVEL';
            estimateUnavailableReason = 'NO_QUANTITY_TO_COST';
          } else {
            const qty = toBuyQtyRoundedUp(shortfallStock, chosen);
            qtyToOrder = wire(qty);
            if (chosen.priceE4 === null) {
              estimateUnavailableReason = 'NO_RECORDED_PRICE';
            } else {
              // An ESTIMATE from what we last paid, rounded once. It is not a
              // quote and it commits nobody; the order line prices itself.
              estimatedCostMinor = wire(
                lineNetMinor(qty, chosen.buyScale, chosen.priceE4, 'half-up'),
              );
            }
          }

          suggestions.push({
            ...base,
            recommendation: {
              basis,
              supplierId: chosen?.row.supplier_id ?? null,
              supplierCode: chosen?.row.supplier_code ?? null,
              supplierName: chosen?.row.supplier_name ?? null,
              supplierSku: chosen?.row.supplier_sku ?? null,
              leadTimeDays: chosen?.row.lead_time_days ?? null,
              paymentTermsDays: chosen?.row.payment_terms_days ?? null,
              purchaseUomId: chosen?.uomId ?? null,
              purchaseUomCode: chosen?.uomCode ?? null,
              buyScale: chosen?.buyScale ?? null,
              qtyBasis,
              /** In the STOCKING unit — the view's own shortfall, untouched. */
              qtyToOrderStock: r.shortfall_qty,
              /** In the PURCHASE unit, rounded UP. Null with a stated reason. */
              qtyToOrder,
              qtyUnavailableReason,
              estimatedCostMinor,
              estimateUnavailableReason,
            },
            /** Every source, cheapest-first IN THE COMMON UNIT. */
            alternativeCount: sources.length,
            alternatives: sources.slice(0, 8).map(compared),
          });
        }

        const state =
          activeThresholdCount === 0
            ? 'NO_THRESHOLDS_CONFIGURED'
            : low.length === 0
              ? 'NOTHING_BELOW_REORDER_POINT'
              : 'SUGGESTIONS';

        const countAt = (id: string, list: readonly LowStockFigures[]): number =>
          list.filter((s) => s.locationId === id).length;

        return {
          scope: { locationCount: scope.locations.length, network: scope.network },
          /**
           * WHY the list is what it is. An empty `suggestions` array means
           * something different under each of these and a client must be able
           * to say which:
           *   NO_THRESHOLDS_CONFIGURED  nobody has set a reorder point here
           *   NOTHING_BELOW_REORDER_POINT  thresholds exist; nothing is low
           *   SUGGESTIONS               there is something to order
           */
          state,
          activeThresholdCount,
          lowStockCount: low.length,
          suggestionCount: suggestions.length,
          unsourcedCount: unsourced.length,
          suggestions,
          unsourced,
          locations: scope.locations.map((l) => ({
            locationId: l.id,
            locationCode: l.code,
            locationName: l.name,
            suggestionCount: countAt(l.id, suggestions),
            unsourcedCount: countAt(l.id, unsourced),
          })),
        };
      });
    }),
});
