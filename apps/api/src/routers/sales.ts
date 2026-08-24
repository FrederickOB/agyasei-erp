/**
 * Sales: createSale — the Phase 1 write path's centrepiece.
 *
 * One idempotent unit of work writes the sale header, its lines, its tax
 * lines and its stock movements (and, for a credit tender, the credit
 * entry) in ONE transaction, all rows FK-tied to one app.write_log marker.
 *
 * The INPUT SHAPE is not defined here. It lives in `@erp/contracts`
 * (`packages/contracts/src/sale.ts`), which `apps/web` imports too, so the
 * client cannot build a payload this router will reject without `tsc` saying
 * so first. Read that file for the wire contract and for the two design
 * decisions it records: the till's claimed total is accepted and compared
 * (never trusted), and cash tender detail is refused until there is a table
 * to record it in.
 *
 * Pricing: lines price from the named price list's items in force on the
 * BUSINESS DATE (never current_date). The extended line amount is
 * `lineNetMinor` — rounded once, on the extended amount, never on the unit
 * price (04 §4.13 row 3). Tax lines come from the effective-dated
 * platform.tax_rate rows in force on the business date with base_kind
 * honoured (07 §7.2.4), each component rounded once at its declared mode.
 * Totals are exact bigint sums of the rounded parts; the schema's
 * sale_total_identity CHECK is the backstop.
 *
 * ============================================================================
 * TAX-INCLUSIVE PRICE LISTS (04 §4.13 rows 6 and 10)
 * ============================================================================
 * `price_list.is_tax_inclusive` says whether the stored `unit_price_e4` is a
 * NET price or the SHELF price the customer reads off the bag. Counter retail
 * is quoted inclusive and contractor wholesale exclusive (§4.6), which is why
 * the flag is per list and why tenant #1's best-ranked list is the inclusive
 * one — a till that cannot price it cannot trade.
 *
 * Both kinds price through the same three steps and store the SAME SHAPE:
 *
 *   1. extend once, half-up, on the extended amount (row 3). On an inclusive
 *      list that figure is the extended GROSS — the shelf price × quantity;
 *   2. take the operator's discount off THAT figure (row 10 for the inclusive
 *      case: discount the gross, then de-gross — the customer negotiates
 *      against the price they were quoted, and de-grossing first would move
 *      the tax and produce a receipt whose arithmetic they cannot follow);
 *   3. net and tax lines: forward from the net (row 5) on an exclusive list,
 *      carved OUT of the gross (row 6) on an inclusive one.
 *
 * Extraction is not one division. It inverts whatever composition the pack
 * declares — `base_kind`, `base_includes`, `rounding_level`, `rounding_mode`
 * — via `@erp/money`, which derives the gross-up as an exact rational from the
 * component set. Ghana's two regimes differ only in composition (20% effective
 * on the flat set, 21.9% on the pre-2026 cascade) with no rate changing, so a
 * constant or a jurisdiction branch here would be an ADR-0002/ADR-0007
 * violation as well as simply wrong for one of the two dates.
 *
 * THE ROUNDING DECISION the de-grossed net needs — §4.13 row 6 states a formula
 * and no mode for it — is `netRoundingModeFor` in ../tax.ts. Read that comment
 * before changing anything here: the counter derives the same mode by the same
 * rule while offline, and the two must not drift apart.
 *
 * WHAT COMES OUT is a net, its tax lines and a total — and nothing that names
 * the kind of list. `app.sale` has no inclusive/exclusive column and gets
 * none: the same cart on two lists whose prices are equivalent stores byte-
 * identical figures. The flag stays a property of the price list, reachable
 * from a sale only through the `price_list_id` it already pins (which is how
 * `recomputeCheck` below re-derives the right direction, and the only place
 * that is allowed to care).
 * ============================================================================
 *
 * Authorisation: the capability follows the TENDER — `sale.record` for cash,
 * `sale.record.credit` for credit — at the request's location, resolved from
 * the database per request and never from the token (see `SALE_PERMISSION`
 * below). A credit sale is checked TWICE: once by the middleware for the
 * capability, and again inside the plan for the bound, against the server's
 * own repriced total. The reads are `sale.view`, at the sale's own location.
 *
 * ============================================================================
 * Q8 SEAM — Ghana e-VAT clearance (docs/open-questions.md Q8, UNRESOLVED).
 * ============================================================================
 * This router captures the SALE and computes its TAX only. It deliberately
 * issues NO invoice: no clearance call, no fiscal invoice number, no SDC/QR
 * fields — the schema carries none and this code must not invent them. If
 * Q8 resolves to a clearance regime, issuance becomes a SEPARATE document
 * and workflow (see the seam note in @erp/db migration 0004). DO NOT add
 * clearance behaviour here.
 * ============================================================================
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { comparePriceCheck, createSaleInput, type CreateSaleParsed } from '@erp/contracts';
import { deterministicUuid, type PermissionCode } from '@erp/db';
import { lineNetMinor, mulBps, mulDiv, type RoundingMode } from '@erp/money';
import { emergencyNumber } from '@erp/sequence';
import type { Queryable } from '../db.js';
import { runIdempotent, type JsonValue } from '../pipeline.js';
import {
  assertPackPriceable,
  computeLineTaxes,
  extractLineTaxes,
  taxComponentsInForce,
  type ComputedTaxLine,
  type TaxComponentRow,
} from '../tax.js';
import { assertLocationInScope, requiresPermission, router, tenantProcedure } from '../trpc.js';
import {
  SEQUENCE_REVIEW_PERMISSION,
  SEVERITY_BLOCKING,
  openConflictReview,
} from './sequence.js';
import { addCalendarDays, wire, zUuid } from '../wire.js';

export interface TenantJurisdiction {
  jurisdictionCode: string;
  currencyCode: string;
  minorUnitsPerMajor: bigint;
}

/**
 * The tenant's jurisdiction pack: currency and minor-unit scale, read from
 * `platform.jurisdiction` and NEVER assumed (CLAUDE.md §2.5, §2.3).
 *
 * Exported because a purchase order snapshots exactly what a sale snapshots,
 * and a second copy of this read is a second place for "100" to creep back in.
 */
export async function loadJurisdiction(tx: Queryable): Promise<TenantJurisdiction> {
  const res = await tx.query<{
    jurisdiction_code: string;
    currency_code: string;
    minor_units_per_major: string;
  }>(
    `select t.jurisdiction_code, j.currency_code, j.minor_units_per_major::text
     from platform.tenant t
     join platform.jurisdiction j on j.code = t.jurisdiction_code
     where t.id = app.current_tenant()`,
  );
  const row = res.rows[0];
  if (!row) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'tenant jurisdiction unresolved' });
  return {
    jurisdictionCode: row.jurisdiction_code,
    currencyCode: row.currency_code,
    // The divisor itself, from the pack — NEVER assumed 100 (CLAUDE.md §2.3).
    minorUnitsPerMajor: BigInt(row.minor_units_per_major),
  };
}

interface PricedLine {
  lineNo: number;
  productId: string;
  taxCode: string;
  sellingUomId: string;
  qtySell: bigint;
  qtySellScale: number;
  unitPriceE4: bigint;
  stockingUomId: string;
  qtyStock: bigint;
  qtyStockScale: number;
  factorNum: bigint;
  factorDen: bigint;
  discountMinor: bigint;
  lineNetMinor: bigint;
  stockTracking: string;
  taxes: ComputedTaxLine[];
  lineTaxMinor: bigint;
}

/**
 * One line off a tax-INCLUSIVE list, priced into the shape an exclusive line
 * produces: an undiscounted NET, a discount, and the component tax lines.
 *
 * ── THE INVARIANT ────────────────────────────────────────────────────────
 *   net − discount + Σ taxes === extendedGross − grossDiscount
 * exactly, for every input. With no discount that reads: the line total IS the
 * shelf price × quantity, to the minor unit. The tax is carved OUT of what the
 * customer was quoted, never added to it. @erp/money guarantees the
 * `net + Σ tax === gross` half and asserts it internally; the discount half is
 * arithmetic on top of it and is exact by construction below.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHAT THE DISCOUNT IS DENOMINATED IN, and why it is not what was typed.
 *
 * The operator grants a discount against the INCLUSIVE price, because that is
 * the number on the shelf and the number being negotiated — §4.13 row 10 is
 * explicit that the gross is discounted first. But `sale_line.line_net_minor`
 * is the REVENUE figure and `line_discount_minor` is its contra (07 §7.3.2:
 * "the revenue figure is gross of discount and the tax base is net of it";
 * 05 §5.6.2 rule 1b posts gross revenue plus a SALES_DISCOUNT contra). Revenue
 * and a revenue contra are tax-EXCLUSIVE accounts. Storing the typed gross
 * discount in `line_discount_minor` would post the tax inside the discount to
 * a revenue contra, and inflate `line_net_minor` by the same amount to keep the
 * document footing — two wrong figures whose errors cancel in the total.
 *
 * So both stored figures are net-of-tax: `line_net_minor` is the de-grossed
 * extended shelf price and `line_discount_minor` is the net the discount
 * actually gave away — the difference between de-grossing before and after it.
 * The customer's total is identical either way (see the invariant); what
 * changes is that the books receive two figures that are true separately, not
 * only in sum. The till still prints the gross discount it took, which is what
 * the customer can follow; that is a receipt-rendering fact, not a stored one.
 *
 * NEEDS A HUMAN (CLAUDE.md §2.8): an accountant should confirm this on the
 * chart-of-accounts review, because it is the one place where the figure
 * stored is not the figure typed. With no line discount — every sale the pilot
 * actually rings today — the question does not arise: `discountMinor` is `0n`
 * by construction and one extraction runs, not two.
 */
function priceInclusive(
  extendedGrossMinor: bigint,
  grossDiscountMinor: bigint,
  components: readonly TaxComponentRow[],
): { net: bigint; discountMinor: bigint; taxes: ComputedTaxLine[] } {
  // Row 10: discount the gross, THEN de-gross. This is the taxable side —
  // the base every component computes on, and the tax that prints.
  const taxed = extractLineTaxes(extendedGrossMinor - grossDiscountMinor, components);
  if (grossDiscountMinor === 0n) {
    return { net: taxed.netMinor, discountMinor: 0n, taxes: taxed.taxes };
  }
  // The revenue side: the same shelf price de-grossed WITHOUT the discount.
  const full = extractLineTaxes(extendedGrossMinor, components);
  const discountMinor = full.netMinor - taxed.netMinor;
  if (discountMinor < 0n || discountMinor > full.netMinor) {
    // Unreachable for any real pack: de-grossing is monotone in the gross for
    // non-negative rates, so a smaller gross cannot yield a larger net. It is
    // checked rather than assumed because the alternative is a negative
    // discount reaching the books silently.
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message:
        `de-grossing is not monotone for this component set: gross ${extendedGrossMinor} → net ` +
        `${full.netMinor}, gross ${extendedGrossMinor - grossDiscountMinor} → net ${taxed.netMinor}`,
    });
  }
  return { net: full.netMinor, discountMinor, taxes: taxed.taxes };
}

/**
 * WHICH CAPABILITY A SALE NEEDS (02 §2.4; CLAUDE.md §2.6).
 *
 * The boundary the brief draws through the sale path is the TENDER, not the
 * amount and not the counter: "outlet staff … POS" versus "outlet manager …
 * credit sales up to a set limit". Cash takes money in; credit hands out the
 * tenant's own working capital and creates an exposure that outlives the
 * transaction. Two different acts, two different capabilities.
 *
 * `tender` is PLATFORM vocabulary — a closed `z.enum(['CASH','CREDIT'])` in
 * `@erp/contracts`, the same declaration both sides of the wire parse with.
 * It is emphatically NOT a tenant's word: deriving authority from tenant
 * vocabulary (a payment-method name a tenant can edit, a role label) would
 * let a tenant rename its way out of a control, which CLAUDE.md §2.9 forbids.
 * The same rule is why `movementPermission` in inventory.ts reads `sourceKind`
 * and refuses to read `reasonCode`.
 *
 * The map is TOTAL over the contract's union and TypeScript proves it: adding
 * a tender to `createSaleInput` without deciding which capability guards it is
 * a compile error here, not a sale that silently needs nothing.
 */
export type SaleTender = CreateSaleParsed['tender'];

export const SALE_PERMISSION: Record<SaleTender, PermissionCode> = {
  CASH: 'sale.record',
  CREDIT: 'sale.record.credit',
};

/**
 * Read the required code out of the VALIDATED input. Anything unrecognised
 * returns undefined, which the middleware turns into a refusal — never into a
 * default capability and never into the weaker of the two.
 *
 * zod has already rejected an unknown tender by the time this runs, so this
 * is the second of two independent refusals rather than the only one. It is
 * written anyway: the middleware contract is "an unrecognised intent denies",
 * and a map lookup that fell through to `sale.record` would make a future
 * third tender authorise itself against the cash capability on the day it was
 * added to the contract and forgotten here.
 */
export function salePermission(input: Record<string, unknown>): PermissionCode | undefined {
  const tender = input['tender'];
  if (typeof tender !== 'string') return undefined;
  return SALE_PERMISSION[tender as SaleTender];
}

export const salesRouter = router({
  /**
   * The permission requirement sits AFTER `.input()` deliberately: the
   * location it checks and the capability it derives both come from a payload
   * zod has already validated, so a malformed payload is a BAD_REQUEST rather
   * than a FORBIDDEN that tells the till the wrong thing about why it failed.
   *
   * The middleware has already refused unless the caller holds the derived
   * capability AT `input.locationId`. What it CANNOT do is enforce the bound
   * on `sale.record.credit`, because the only honest figure to measure a
   * credit sale against is the server's own repriced total — and that does not
   * exist until the pricing pipeline has run. See the bound check inside the
   * plan below.
   */
  createSale: tenantProcedure
    .input(createSaleInput)
    .use(requiresPermission({ code: salePermission, at: 'input' }))
    .mutation(async ({ ctx, input }) => {
      assertLocationInScope(ctx.identity, input.locationId);
      if (input.tender === 'CREDIT' && !input.customerId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'a credit sale requires customerId' });
      }
      const tenantId = ctx.identity.tenantId;
      const key = input.idempotencyKey;

      const result = await runIdempotent(
        { runner: ctx.deps.runner, clock: ctx.deps.clock },
        ctx.identity,
        {
          op: 'sale.create',
          idempotencyKey: key,
          claimedHlc: input.claimedHlc,
          clientWallAt: input.clientWallAt,
          locationId: input.locationId,
        },
        input,
        async (tx) => {
          // ---- plan: reads and arithmetic only --------------------------------
          const jur = await loadJurisdiction(tx);

          const loc = await tx.query<{ id: string; kind: string }>(
            `select id, kind from app.location where id = $1 and deleted_at is null`,
            [input.locationId],
          );
          if (!loc.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'location not found' });
          if (loc.rows[0].kind !== 'OUTLET') {
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'sales are recorded at OUTLET locations' });
          }

          const pl = await tx.query<{ id: string; is_tax_inclusive: boolean }>(
            `select id, is_tax_inclusive from app.price_list
             where code = $1 and deleted_at is null
               and effective_from <= $2::date
               and (effective_to is null or effective_to > $2::date)`,
            [input.priceListCode, input.businessDate],
          );
          const priceList = pl.rows[0];
          if (!priceList) {
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `no price list ${input.priceListCode} in force` });
          }
          // Whether `unit_price_e4` on this list is a net price or the shelf
          // price. It selects the DIRECTION of step 3 below and nothing else:
          // it is never stored on the sale and never leaves in a response.
          const taxInclusive = priceList.is_tax_inclusive;

          const components = await taxComponentsInForce(tx, jur.jurisdictionCode, input.businessDate);
          if (components.length === 0) {
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'no tax rates in force on the business date' });
          }
          // Fail closed, once, before any line is priced (07 §7.2.4 M12).
          assertPackPriceable(components, input.businessDate);

          const pricedLines: PricedLine[] = [];
          // The steepest discount any single line carries, in basis points of
          // that line's own extended amount. Accumulated here because the
          // bound below must be measured against the SERVER's extended figure
          // and the operator's stated discount — never against anything the
          // till computed for itself.
          let maxDiscountBps = 0n;
          for (let i = 0; i < input.lines.length; i += 1) {
            const line = input.lines[i]!;
            const prod = await tx.query<{
              id: string;
              tax_code: string;
              is_sellable: boolean;
              stock_tracking: string;
              stocking_uom_id: string;
              stocking_scale: number;
            }>(
              `select p.id, p.tax_code, p.is_sellable, p.stock_tracking,
                      p.stocking_uom_id, u.qty_scale as stocking_scale
               from app.product p
               join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
               where p.id = $1 and p.deleted_at is null`,
              [line.productId],
            );
            const product = prod.rows[0];
            if (!product) throw new TRPCError({ code: 'NOT_FOUND', message: 'product not found' });
            if (!product.is_sellable) {
              throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `product ${line.productId} is not sellable` });
            }
            if (!components.some((c) => c.taxCode === product.tax_code)) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: `no ${product.tax_code} rate in force on ${input.businessDate} — cannot produce a statutory receipt`,
              });
            }

            const puom = await tx.query<{
              uom_id: string;
              factor_num: string;
              factor_den: string;
              qty_scale: number;
              code: string;
            }>(
              `select pu.uom_id, pu.factor_num::text, pu.factor_den::text, u.qty_scale, u.code
               from app.product_uom pu
               join app.unit_of_measure u on u.tenant_id = pu.tenant_id and u.id = pu.uom_id
               where pu.product_id = $1 and pu.deleted_at is null and pu.can_sell
                 and (($2::text is not null and u.code = $2) or ($2::text is null and pu.is_default_sell))`,
              [line.productId, line.uomCode ?? null],
            );
            const sell = puom.rows[0];
            if (!sell) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: `product has no sellable unit ${line.uomCode ?? '(default)'}`,
              });
            }

            const item = await tx.query<{ unit_price_e4: string }>(
              `select unit_price_e4::text from app.price_list_item
               where price_list_id = $1 and product_id = $2 and uom_id = $3 and deleted_at is null
                 and effective_from <= $4::date
                 and (effective_to is null or effective_to > $4::date)
                 and min_qty <= $5
               order by min_qty desc, effective_from desc
               limit 1`,
              [priceList.id, line.productId, sell.uom_id, input.businessDate, wire(line.qty)],
            );
            const priced = item.rows[0];
            if (!priced) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: `no price for product ${line.productId} on list ${input.priceListCode} on ${input.businessDate}`,
              });
            }
            const unitPriceE4 = BigInt(priced.unit_price_e4);

            // §4.13 row 3: rounded ONCE on the extended amount, half-up. On an
            // inclusive list this is the extended SHELF price — what the
            // customer hands over, before any discount.
            const extendedMinor = lineNetMinor(line.qty, sell.qty_scale, unitPriceE4, 'half-up');
            if (line.lineDiscountMinor > extendedMinor) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'line discount exceeds line amount' });
            }
            if (line.lineDiscountMinor > 0n) {
              // PER LINE, never per document. A full write-off on one line of
              // ten averages to 10% across the document and would pass a 3%
              // document-wide cap while giving that whole line away.
              //
              // The ratio is the fraction the operator actually negotiated
              // whichever way the price list is composed: on an inclusive list
              // both figures are gross of tax, on an exclusive list both are
              // net of it, and the quotient is the same discount either way.
              // That is why this is computed from the TYPED discount and the
              // extended price rather than from `discountMinor`, which
              // priceInclusive() has already re-denominated into the net terms
              // the ledger stores (see its header).
              //
              // Rounded UP so a discount fractionally over the bound is
              // refused rather than truncated underneath it. `extendedMinor`
              // cannot be zero here: a zero extended amount fails the
              // exceeds-line-amount guard above for any non-zero discount.
              const bps = mulDiv(line.lineDiscountMinor, 10_000n, extendedMinor, 'up');
              if (bps > maxDiscountBps) maxDiscountBps = bps;
            }
            const { net, discountMinor, taxes } = taxInclusive
              ? priceInclusive(extendedMinor, line.lineDiscountMinor, components)
              : {
                  net: extendedMinor,
                  discountMinor: line.lineDiscountMinor,
                  taxes: computeLineTaxes(extendedMinor - line.lineDiscountMinor, components),
                };
            const lineTax = taxes.reduce((acc, t) => acc + t.taxMinor, 0n);

            // What LEFT THE YARD: rational conversion snapshot, rounded once.
            const factorNum = BigInt(sell.factor_num);
            const factorDen = BigInt(sell.factor_den);
            const qtyStock = mulDiv(
              line.qty,
              factorNum * 10n ** BigInt(product.stocking_scale),
              factorDen * 10n ** BigInt(sell.qty_scale),
              'half-up',
            );
            if (product.stock_tracking === 'STOCKED' && qtyStock <= 0n) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'quantity converts to zero stocking units' });
            }

            pricedLines.push({
              lineNo: i + 1,
              productId: product.id,
              taxCode: product.tax_code,
              sellingUomId: sell.uom_id,
              qtySell: line.qty,
              qtySellScale: sell.qty_scale,
              unitPriceE4,
              stockingUomId: product.stocking_uom_id,
              qtyStock,
              qtyStockScale: product.stocking_scale,
              factorNum,
              factorDen,
              discountMinor,
              lineNetMinor: net,
              stockTracking: product.stock_tracking,
              taxes,
              lineTaxMinor: lineTax,
            });
          }

          // Exact bigint totals — sums of the once-rounded parts.
          const subtotalNet = pricedLines.reduce((a, l) => a + l.lineNetMinor, 0n);
          const discountTotal = pricedLines.reduce((a, l) => a + l.discountMinor, 0n);
          const taxTotal = pricedLines.reduce((a, l) => a + l.lineTaxMinor, 0n);
          const total = subtotalNet - discountTotal + taxTotal;

          // ── THE BOUND (02 §2.4; the template's "credit sales up to a set
          // limit"). ────────────────────────────────────────────────────────
          //
          // `sale.record.credit` is never a bare capability: the template
          // grants it to counter staff bounded at `max_order_value_minor:
          // "0"` and to an outlet manager at `"500000"` (GH₵5,000). Until
          // this call existed those figures were data nothing read, and a
          // clerk could open unbounded credit exposure through this path.
          //
          // MEASURED AGAINST `total` — the SERVER's repriced figure, gross of
          // tax and net of discount, which is the exact amount that lands in
          // `app.credit_entry` below and therefore the exact exposure this
          // sale creates. Never `input.clientTotalMinor`: that is the till's
          // claim, it is optional, and a device that could set the number the
          // bound is measured against would have no bound at all. (The claim
          // is still recorded, and compared, further down.)
          //
          // SYNCHRONOUS, against the snapshot `requiresPermission` already
          // resolved from the database for this request. It must stay that
          // way: `loadPermissionState` opens its own `withTenant`, and doing
          // that here — inside runIdempotent's transaction — deadlocks the
          // single-connection PGlite harness and takes a second connection on
          // a pooled runner (see the transaction-discipline header in
          // ../permissions.ts).
          //
          // Throwing here rolls the whole transaction back, marker included,
          // and applies nothing — so a refused credit sale leaves no sale, no
          // stock movement and no credit entry behind.
          if (input.tender === 'CREDIT') {
            ctx.permissions.requireWithinAmount('sale.record.credit', input.locationId, total);
          }

          // ── THE DISCOUNT BOUND (02 §2.4; CLAUDE.md §2.6). ────────────────
          //
          // `lineDiscountMinor` used to be authorised by NOTHING. The template
          // withholds `sale.discount.apply` from counter staff and grants it to
          // an outlet manager at `max_bps: 300`, and both facts were data no
          // code read — so any principal who could ring a sale at all could
          // discount it to zero, and the `sale.record.credit` bound above could
          // be walked under by discounting the total beneath it. Migration 0005
          // says the two hard prohibitions are enforced "by the counter role
          // simply NOT HOLDING" the capability; that is only true once
          // something asks. This is the ask.
          //
          // ONLY WHEN A DISCOUNT WAS ACTUALLY TAKEN. An undiscounted sale must
          // not require a discount capability — that is every sale the pilot
          // rings today, and demanding the grant for them would take the
          // counter down rather than secure it.
          //
          // `requireWithinBound` refuses in both directions: not held at this
          // location at all, or held with a bound this act exceeds. An absent
          // bound is unbounded, which is what makes the owner role work.
          //
          // Synchronous against the already-resolved snapshot, and inside the
          // same transaction as everything else, for the reasons the credit
          // bound above sets out: a refusal here rolls back the sale, its stock
          // movements and its credit entry together, leaving nothing behind.
          if (maxDiscountBps > 0n) {
            ctx.permissions.requireWithinBound(
              'sale.discount.apply',
              input.locationId,
              'max_bps',
              maxDiscountBps,
            );
          }

          // Credit tender: resolve the account BEFORE committing to anything.
          let credit: { accountId: string; termsDays: number; dueDate: string } | null = null;
          if (input.tender === 'CREDIT') {
            const acc = await tx.query<{ id: string; terms_days: number; status: string }>(
              `select id, terms_days, status from app.customer_account
               where customer_id = $1 and deleted_at is null`,
              [input.customerId!],
            );
            const account = acc.rows[0];
            if (!account) {
              throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'customer has no credit account' });
            }
            if (account.status !== 'ACTIVE') {
              throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `credit account is ${account.status}` });
            }
            credit = {
              accountId: account.id,
              termsDays: account.terms_days,
              dueDate: addCalendarDays(input.businessDate, account.terms_days),
            };
          }

          const saleId = deterministicUuid(key, 'sale');
          const saleReasonId = deterministicUuid(tenantId, 'api', 'movement_reason:SALE');
          const occurredAt = input.occurredAt ?? new Date().toISOString();

          // ---- conflict class #14, landing (03 §3.7.5) ------------------------
          // A device whose local database was wiped keeps trading OFFLINE before
          // it can report anything, so it arrives here having already PRINTED
          // numbers another sale holds. Prevention (sequence.syncBlock) closes
          // the window going forward; it cannot close it retroactively.
          //
          // Neither cheap answer is acceptable. Refusing the sale dead-letters a
          // real transaction — §3.3.4's loss path, with the cash already in the
          // till. Renumbering silently gives this customer a number another
          // customer holds and tells nobody.
          //
          // So: the sale LANDS, under the emergency form §3.7.5 already defines
          // for offline block exhaustion (device-derived suffix, marked as such
          // on the record); `receipt_no_claimed` preserves what the customer's
          // paper actually says; and a severity-1 review names both documents.
          // The op acks `applied`, so the outbox drains and the till keeps
          // trading — the discrepancy is visible work, not a stalled queue.
          const clash = await tx.query<{ id: string; receipt_no: string }>(
            `select id, receipt_no from app.sale
              where location_id = $1 and receipt_no = $2`,
            [input.locationId, input.receiptNo],
          );
          const collidesWith = clash.rows[0] ?? null;
          let storedReceiptNo = input.receiptNo;
          if (collidesWith !== null) {
            const emergency = emergencyNumber(input.receiptNo, ctx.identity.deviceId, saleId);
            const taken = await tx.query<{ id: string }>(
              `select id from app.sale where location_id = $1 and receipt_no = $2`,
              [input.locationId, emergency],
            );
            // Vanishingly unlikely, but a second collision here would raise the
            // same raw unique violation and stall the queue all over again. The
            // fallback is unique BY CONSTRUCTION: one sale row per sale id.
            storedReceiptNo = taken.rows.length === 0 ? emergency : `${input.receiptNo}-${saleId}`;
          }
          const claimedReceiptNo = collidesWith === null ? null : input.receiptNo;

          // ── Contract decision (b): the till's total is COMPARED, never trusted.
          // `total` above is the server's own repricing against the price list
          // and tax rates in force on the BUSINESS DATE, and it is what gets
          // written to app.sale — unconditionally, whatever the device claims.
          // When the device sent its own figure we record the comparison in the
          // response, which the pipeline stores verbatim in
          // write_log.response_body (jsonb; money as decimal strings, 03 §3.6.2)
          // and hands back to the till. That is what makes a device trading on a
          // stale price list stop being silent. A mismatch is REPORTED, never a
          // rejection: the goods have already left the yard, and refusing the
          // write would lose the sale to make a point.
          // Omitted entirely when the client did not send one, so a payload
          // without it gets a byte-identical response to before this existed.
          const priceCheck =
            input.clientTotalMinor === undefined
              ? undefined
              : comparePriceCheck(input.clientTotalMinor, total);
          const response = {
            saleId,
            receiptNo: storedReceiptNo,
            /** What the customer's paper says, when it could not be stored. */
            receiptNoClaimed: claimedReceiptNo,
            /** Set when this sale landed under the #14 emergency form. */
            receiptCollisionWithSaleId: collidesWith?.id ?? null,
            businessDate: input.businessDate,
            currencyCode: jur.currencyCode,
            moneyScale: wire(jur.minorUnitsPerMajor),
            priceListCode: input.priceListCode,
            tender: input.tender,
            subtotalNetMinor: wire(subtotalNet),
            discountMinor: wire(discountTotal),
            taxTotalMinor: wire(taxTotal),
            totalMinor: wire(total),
            lines: pricedLines.map((l) => ({
              lineNo: l.lineNo,
              productId: l.productId,
              qty: wire(l.qtySell),
              qtyScale: l.qtySellScale,
              unitPriceE4: wire(l.unitPriceE4),
              lineNetMinor: wire(l.lineNetMinor),
              lineDiscountMinor: wire(l.discountMinor),
              taxMinor: wire(l.lineTaxMinor),
              taxLines: l.taxes.map((t) => ({
                seq: t.seq,
                taxCode: t.taxCode,
                rateBp: wire(t.rateBp),
                baseKind: t.baseKind,
                baseMinor: wire(t.baseMinor),
                // `ROUND(baseMinor × rateBp / 10000)` — the figure a re-verifier
                // reproduces — and the de-grossing leftover placed on top of it,
                // reported separately so `taxMinor` is checkable rather than
                // merely trusted. `app.sale_tax_line` has no column for either
                // yet (see the note on the insert below), so the write log's
                // response body is where they survive.
                computedMinor: wire(t.computedMinor),
                residualMinor: wire(t.residualMinor),
                taxMinor: wire(t.taxMinor),
                taxRateId: t.taxRateId,
              })),
            })),
            credit: credit
              ? { accountId: credit.accountId, dueDate: credit.dueDate, chargeMinor: wire(total) }
              : null,
            ...(priceCheck === undefined ? {} : { priceCheck }),
          } satisfies JsonValue & Record<string, unknown>;

          return {
            response,
            apply: async (atx) => {
              const clock = ctx.deps.clock;
              await atx.query(
                `insert into app.sale
                   (tenant_id, id, write_id, hlc, location_id, customer_id, price_list_id,
                    receipt_no, receipt_no_claimed, business_date, occurred_at,
                    currency_code, money_scale,
                    subtotal_net_minor, discount_minor, tax_total_minor, total_minor)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11,$12,$13,$14,$15,$16,$17)`,
                [
                  tenantId,
                  saleId,
                  key,
                  clock.next(),
                  input.locationId,
                  input.customerId ?? null,
                  priceList.id,
                  storedReceiptNo,
                  claimedReceiptNo,
                  input.businessDate,
                  occurredAt,
                  jur.currencyCode,
                  wire(jur.minorUnitsPerMajor),
                  wire(subtotalNet),
                  wire(discountTotal),
                  wire(taxTotal),
                  wire(total),
                ],
              );

              for (const l of pricedLines) {
                const lineId = deterministicUuid(key, 'sale_line', String(l.lineNo));
                await atx.query(
                  `insert into app.sale_line
                     (tenant_id, id, write_id, hlc, sale_id, line_no, product_id,
                      selling_uom_id, qty_sell, qty_sell_scale, unit_price_e4,
                      stocking_uom_id, qty_stock, qty_stock_scale, factor_num, factor_den,
                      line_discount_minor, line_net_minor, tax_code, tax_minor)
                   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
                  [
                    tenantId,
                    lineId,
                    key,
                    clock.next(),
                    saleId,
                    l.lineNo,
                    l.productId,
                    l.sellingUomId,
                    wire(l.qtySell),
                    l.qtySellScale,
                    wire(l.unitPriceE4),
                    l.stockingUomId,
                    wire(l.qtyStock),
                    l.qtyStockScale,
                    wire(l.factorNum),
                    wire(l.factorDen),
                    wire(l.discountMinor),
                    wire(l.lineNetMinor),
                    l.taxCode,
                    wire(l.lineTaxMinor),
                  ],
                );
                for (const t of l.taxes) {
                  // KNOWN GAP, recorded where it bites: `tax_minor` here is
                  // `computed + residual`, and the table has no column for the
                  // split. On a de-grossed line the residual is commonly ±1
                  // minor unit, so a reader recomputing `ROUND(base × rate)`
                  // straight off this row will disagree with `tax_minor` on
                  // roughly one inclusive line in six under a 20% set. That is
                  // the correct FIGURE — it is what makes net + tax equal the
                  // shelf price — but it is not independently checkable from
                  // this row alone. `recomputeCheck` below re-derives it
                  // properly, and the write log keeps the split; the durable
                  // fix is `computed_minor`/`residual_minor` columns on
                  // app.sale_tax_line, which is a packages/db change.
                  await atx.query(
                    `insert into app.sale_tax_line
                       (tenant_id, id, write_id, hlc, sale_id, sale_line_id, seq, tax_code,
                        rate_bp, base_kind, base_includes, rounding_level, rounding_mode,
                        base_minor, tax_minor, tax_rate_id)
                     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                             case when $11 = '' then '{}'::text[] else string_to_array($11, ',') end,
                             $12,$13,$14,$15,$16)`,
                    [
                      tenantId,
                      deterministicUuid(key, 'sale_tax_line', String(l.lineNo), String(t.seq)),
                      key,
                      clock.next(),
                      saleId,
                      lineId,
                      t.seq,
                      t.taxCode,
                      wire(t.rateBp),
                      t.baseKind,
                      t.baseIncludes.join(','),
                      t.roundingLevel,
                      t.roundingMode.replace('-', '_'),
                      wire(t.baseMinor),
                      wire(t.taxMinor),
                      t.taxRateId,
                    ],
                  );
                }
              }

              // Stock movements: outflow negative, source SALE. The 'SALE'
              // reason row is tenant vocabulary the API guarantees exists.
              const stockedLines = pricedLines.filter((l) => l.stockTracking === 'STOCKED');
              if (stockedLines.length > 0) {
                await atx.query(
                  `insert into app.movement_reason (tenant_id, id, write_id, hlc, code, name)
                   values ($1, $2, $3, $4, 'SALE', 'Sold to customer')
                   on conflict do nothing`,
                  [tenantId, saleReasonId, key, clock.next()],
                );
                const reason = await atx.query<{ id: string }>(
                  `select id from app.movement_reason where code = 'SALE' and deleted_at is null`,
                );
                const reasonId = reason.rows[0]!.id;
                for (const l of stockedLines) {
                  await atx.query(
                    `insert into app.stock_movement
                       (tenant_id, id, write_id, hlc, location_id, product_id, qty_delta, qty_scale,
                        uom_id, reason_id, source_kind, source_id, occurred_at, business_date)
                     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'SALE',$11,$12,$13::date)`,
                    [
                      tenantId,
                      deterministicUuid(key, 'stock_movement', String(l.lineNo)),
                      key,
                      clock.next(),
                      input.locationId,
                      l.productId,
                      wire(-l.qtyStock),
                      l.qtyStockScale,
                      l.stockingUomId,
                      reasonId,
                      saleId,
                      occurredAt,
                      input.businessDate,
                    ],
                  );
                }
              }

              if (credit) {
                await atx.query(
                  `insert into app.credit_entry
                     (tenant_id, id, write_id, hlc, account_id, kind, amount_minor,
                      business_date, due_date, source_kind, source_id)
                   values ($1,$2,$3,$4,$5,'CHARGE',$6,$7::date,$8::date,'SALE',$9)`,
                  [
                    tenantId,
                    deterministicUuid(key, 'credit_entry'),
                    key,
                    clock.next(),
                    credit.accountId,
                    wire(total),
                    input.businessDate,
                    credit.dueDate,
                    saleId,
                  ],
                );
              }

              // The #14 review. Opened LAST, in the same transaction as the sale
              // it describes: if the sale does not land, there is nothing to
              // review, and if it does, a human hears about it before anyone
              // reconciles a till.
              if (collidesWith !== null) {
                await openConflictReview(atx, {
                  tenantId,
                  writeId: key,
                  hlc: clock.next(),
                  reviewId: deterministicUuid(key, 'conflict_review', 'receipt_collision'),
                  conflictClass: 'RECEIPT_NUMBER_COLLISION',
                  severity: SEVERITY_BLOCKING,
                  entityTable: 'app.sale',
                  entityId: saleId,
                  fieldPath: 'receipt_no',
                  proposals: [
                    {
                      party: 'existing',
                      detail: 'the sale already holding this receipt number',
                      saleId: collidesWith.id,
                      receiptNo: collidesWith.receipt_no,
                    },
                    {
                      party: 'arriving',
                      detail: 'the sale that printed the same number and landed under the emergency form',
                      saleId,
                      receiptNoPrinted: input.receiptNo,
                      receiptNoStored: storedReceiptNo,
                      deviceId: ctx.identity.deviceId,
                      userId: ctx.identity.userId,
                      locationId: input.locationId,
                      claimedHlc: input.claimedHlc ?? null,
                      totalMinor: wire(total),
                    },
                  ],
                  pendingState: 'first_applied',
                  pendingValue: {
                    receiptNoStored: storedReceiptNo,
                    receiptNoPrinted: input.receiptNo,
                    totalMinor: wire(total),
                    note:
                      'Two customers hold receipts printed with the same number. Both sales are ' +
                      'recorded; the arriving one carries the emergency-form number and keeps the ' +
                      'printed number in receipt_no_claimed. Reconcile the paper copies.',
                  },
                  requiredPermission: SEQUENCE_REVIEW_PERMISSION,
                  locationIds: [input.locationId],
                });
              }
            },
          };
        },
      );
      return result.response;
    }),

  /**
   * `sale.view`, in two steps, because the request names a SALE and not a
   * place.
   *
   * The declaration is `at: 'any'` — the caller must hold the capability
   * somewhere in the tenant — and that is deliberately not the whole check.
   * A sale is a location's document, so once the row is loaded and its
   * location is known, the precise question is asked against the SAME
   * snapshot the middleware already resolved: `sale.view` AT THIS SALE'S
   * LOCATION. A counter clerk in Techiman does not get to read Wenchi's
   * takings by guessing a uuid.
   *
   * It is `at: 'any'` rather than `at: 'input'` because `at: 'input'` also
   * requires the location to be in the TOKEN's `locs`, and `locs` is a DEVICE
   * scope — which counter this tablet is standing at. Requiring it on a read
   * would refuse a head-office browser session that legitimately holds
   * `sale.view` across the network and is standing at no counter at all
   * (02 §2.5; the same asymmetry `requiresPermission` documents).
   */
  get: tenantProcedure
    .input(z.object({ saleId: zUuid }).strict())
    .use(requiresPermission({ code: 'sale.view', at: 'any' }))
    .query(async ({ ctx, input }) => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const sale = await loadSale(tx, input.saleId);
        ctx.permissions.requireAt('sale.view', sale.locationId);
        return sale;
      });
    }),

  /**
   * Server recompute against the snapshotted basis (03 §3.4.2, 07 §7.3):
   * re-derives every line amount and tax component from the row's own
   * snapshots and compares byte for byte. Equality is an invariant; any
   * inequality is reported, never silently corrected.
   */
  recomputeCheck: tenantProcedure
    .input(z.object({ saleId: zUuid }).strict())
    .use(requiresPermission({ code: 'sale.view', at: 'any' }))
    .query(async ({ ctx, input }) => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const sale = await loadSale(tx, input.saleId);
        // Same two-step check as `get`, and for a stronger reason: this route
        // returns every line amount, unit price and tax component of the sale.
        ctx.permissions.requireAt('sale.view', sale.locationId);
        const mismatches: string[] = [];

        // The ONE place a sale is allowed to ask which kind of list priced it,
        // and it asks the list — through the `price_list_id` the sale already
        // pins — not the sale. Recompute has to invert the same direction the
        // original pricing ran in; everything else downstream reads the figures
        // and is entitled to know nothing about the difference.
        const basis = await tx.query<{ is_tax_inclusive: boolean }>(
          `select pl.is_tax_inclusive
             from app.sale s
             join app.price_list pl on pl.id = s.price_list_id
            where s.id = $1`,
          [input.saleId],
        );
        const taxInclusive = basis.rows[0]?.is_tax_inclusive ?? false;
        if (!basis.rows[0]) mismatches.push('price list for this sale is unresolvable');

        let subtotal = 0n;
        let discount = 0n;
        let taxTotal = 0n;
        for (const line of sale.lines) {
          const extendedMinor = lineNetMinor(
            BigInt(line.qty),
            line.qtyScale,
            BigInt(line.unitPriceE4),
            'half-up',
          );
          const storedNet = BigInt(line.lineNetMinor);
          const storedDiscount = BigInt(line.lineDiscountMinor);
          const storedTax = line.taxLines.reduce((s, t) => s + BigInt(t.taxMinor), 0n);
          // Rebuilt from the SALE's own snapshot — rate, base composition,
          // rounding level and mode as applied — never from today's pack.
          const snapshot = line.taxLines.map(componentFromSnapshot);

          if (taxInclusive) {
            // The revenue figure: the extended shelf price, de-grossed.
            const full = extractLineTaxes(extendedMinor, snapshot);
            if (wire(full.netMinor) !== line.lineNetMinor) {
              mismatches.push(
                `line ${line.lineNo}: net ${line.lineNetMinor} != de-grossed ${wire(full.netMinor)}`,
              );
            }
            // The taxable side, re-derived from the stored parts and required to
            // de-gross back to exactly those parts: net + Σ tax is the gross the
            // customer paid, and extracting it must return that same net and
            // those same component amounts, residual placement included.
            const taxable = storedNet - storedDiscount;
            const again = extractLineTaxes(taxable + storedTax, snapshot);
            if (again.netMinor !== taxable) {
              mismatches.push(
                `line ${line.lineNo}: taxable net ${wire(taxable)} != de-grossed ${wire(again.netMinor)}`,
              );
            }
            for (let i = 0; i < line.taxLines.length; i += 1) {
              const t = line.taxLines[i]!;
              const r = again.taxes[i];
              if (!r || r.taxCode !== t.taxCode) {
                mismatches.push(`line ${line.lineNo} ${t.taxCode}: component missing on recompute`);
                continue;
              }
              if (wire(r.baseMinor) !== t.baseMinor) {
                mismatches.push(
                  `line ${line.lineNo} ${t.taxCode}: base ${t.baseMinor} != recomputed ${wire(r.baseMinor)}`,
                );
              }
              if (wire(r.taxMinor) !== t.taxMinor) {
                mismatches.push(
                  `line ${line.lineNo} ${t.taxCode}: tax ${t.taxMinor} != recomputed ${wire(r.taxMinor)}`,
                );
              }
            }
          } else {
            if (wire(extendedMinor) !== line.lineNetMinor) {
              mismatches.push(
                `line ${line.lineNo}: net ${line.lineNetMinor} != recomputed ${wire(extendedMinor)}`,
              );
            }
            for (const t of line.taxLines) {
              const recomputedTax = mulBps(BigInt(t.baseMinor), BigInt(t.rateBp), roundingModeOf(t.roundingMode));
              if (wire(recomputedTax) !== t.taxMinor) {
                mismatches.push(
                  `line ${line.lineNo} ${t.taxCode}: tax ${t.taxMinor} != recomputed ${wire(recomputedTax)}`,
                );
              }
            }
          }

          if (wire(storedTax) !== line.taxMinor) {
            mismatches.push(`line ${line.lineNo}: tax_minor ${line.taxMinor} != Σ components ${wire(storedTax)}`);
          }
          subtotal += storedNet;
          discount += storedDiscount;
          taxTotal += storedTax;
        }
        if (wire(subtotal) !== sale.subtotalNetMinor) mismatches.push('subtotal mismatch');
        if (wire(taxTotal) !== sale.taxTotalMinor) mismatches.push('tax total mismatch');
        if (wire(subtotal - discount + taxTotal) !== sale.totalMinor) mismatches.push('total identity mismatch');

        return { saleId: input.saleId, matches: mismatches.length === 0, mismatches };
      });
    }),
});

async function loadSale(tx: Queryable, saleId: string) {
  const head = await tx.query<{
    id: string;
    location_id: string;
    receipt_no: string;
    business_date: string;
    currency_code: string;
    money_scale: string;
    subtotal_net_minor: string;
    discount_minor: string;
    tax_total_minor: string;
    total_minor: string;
  }>(
    `select id, location_id, receipt_no, business_date::text, currency_code,
            money_scale::text, subtotal_net_minor::text, discount_minor::text,
            tax_total_minor::text, total_minor::text
     from app.sale where id = $1`,
    [saleId],
  );
  const s = head.rows[0];
  if (!s) throw new TRPCError({ code: 'NOT_FOUND', message: 'sale not found' });

  const lines = await tx.query<{
    id: string;
    line_no: number;
    product_id: string;
    qty_sell: string;
    qty_sell_scale: number;
    unit_price_e4: string;
    line_discount_minor: string;
    line_net_minor: string;
    tax_code: string;
    tax_minor: string;
  }>(
    `select id, line_no, product_id, qty_sell::text, qty_sell_scale, unit_price_e4::text,
            line_discount_minor::text, line_net_minor::text, tax_code, tax_minor::text
     from app.sale_line where sale_id = $1 order by line_no`,
    [saleId],
  );
  const taxLines = await tx.query<{
    sale_line_id: string;
    seq: number;
    tax_code: string;
    rate_bp: string;
    base_kind: string;
    base_includes: string[];
    rounding_level: string;
    rounding_mode: string;
    base_minor: string;
    tax_minor: string;
    tax_rate_id: string;
  }>(
    `select sale_line_id, seq, tax_code, rate_bp::text, base_kind, base_includes,
            rounding_level, rounding_mode, base_minor::text, tax_minor::text, tax_rate_id
     from app.sale_tax_line where sale_id = $1 order by sale_line_id, seq`,
    [saleId],
  );
  const byLine = new Map<string, typeof taxLines.rows>();
  for (const t of taxLines.rows) {
    const list = byLine.get(t.sale_line_id) ?? [];
    list.push(t);
    byLine.set(t.sale_line_id, list);
  }
  return {
    saleId: s.id,
    locationId: s.location_id,
    receiptNo: s.receipt_no,
    businessDate: s.business_date,
    currencyCode: s.currency_code,
    moneyScale: s.money_scale,
    subtotalNetMinor: s.subtotal_net_minor,
    discountMinor: s.discount_minor,
    taxTotalMinor: s.tax_total_minor,
    totalMinor: s.total_minor,
    lines: lines.rows.map((l) => ({
      lineNo: l.line_no,
      productId: l.product_id,
      qty: l.qty_sell,
      qtyScale: l.qty_sell_scale,
      unitPriceE4: l.unit_price_e4,
      lineDiscountMinor: l.line_discount_minor,
      lineNetMinor: l.line_net_minor,
      taxCode: l.tax_code,
      taxMinor: l.tax_minor,
      taxLines: (byLine.get(l.id) ?? []).map((t) => ({
        seq: t.seq,
        taxCode: t.tax_code,
        rateBp: t.rate_bp,
        baseKind: t.base_kind,
        // The full basis, not just the rate (07 §7.3.3) — a reprint and a
        // recompute both need the composition that was actually applied.
        baseIncludes: t.base_includes,
        roundingLevel: t.rounding_level,
        roundingMode: t.rounding_mode,
        baseMinor: t.base_minor,
        taxMinor: t.tax_minor,
        taxRateId: t.tax_rate_id,
      })),
    })),
  };
}

/** `platform.tax_rate.rounding_mode`'s three values, as @erp/money's. The
 * column is CHECK-constrained to exactly these, so the fallback is `'down'`
 * rather than a throw. */
function roundingModeOf(stored: string): RoundingMode {
  return stored === 'half_up' ? 'half-up' : stored === 'half_even' ? 'half-even' : 'down';
}

/**
 * One persisted `app.sale_tax_line` back as the pack component it was applied
 * from. This is what makes a reprice reproduce a document years later without
 * consulting the pack at all (07 §7.3.3): rate, `base_kind`, `base_includes`,
 * `rounding_level` and `rounding_mode` are all snapshotted on the row, so the
 * composition that priced the sale is reconstructible even if the pack row it
 * came from has since been superseded.
 */
function componentFromSnapshot(t: {
  seq: number;
  taxCode: string;
  rateBp: string;
  baseKind: string;
  baseIncludes: string[];
  roundingLevel: string;
  roundingMode: string;
  taxRateId: string;
}): TaxComponentRow {
  if (t.baseKind !== 'net' && t.baseKind !== 'net_plus') {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `sale_tax_line ${t.taxCode}: unknown base_kind ${t.baseKind}`,
    });
  }
  if (t.roundingLevel !== 'line' && t.roundingLevel !== 'document') {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `sale_tax_line ${t.taxCode}: unknown rounding_level ${t.roundingLevel}`,
    });
  }
  return {
    taxRateId: t.taxRateId,
    taxCode: t.taxCode,
    rateBp: BigInt(t.rateBp),
    baseKind: t.baseKind,
    baseIncludes: t.baseIncludes,
    roundingLevel: t.roundingLevel,
    roundingMode: roundingModeOf(t.roundingMode),
    seq: t.seq,
  };
}
