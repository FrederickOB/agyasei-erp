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
import { lineNetMinor, mulBps, mulDiv } from '@erp/money';
import { emergencyNumber } from '@erp/sequence';
import type { Queryable } from '../db.js';
import { runIdempotent, type JsonValue } from '../pipeline.js';
import { computeLineTaxes, taxComponentsInForce, type ComputedTaxLine } from '../tax.js';
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
          if (priceList.is_tax_inclusive) {
            // Exact tax EXTRACTION from inclusive shelf prices is the POS
            // pricing work-package; refusing beats approximating (ADR-0004:
            // rounding explicit at every boundary, never improvised here).
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'tax-inclusive price lists are not yet supported by sales.createSale',
            });
          }

          const components = await taxComponentsInForce(tx, jur.jurisdictionCode, input.businessDate);
          if (components.length === 0) {
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'no tax rates in force on the business date' });
          }

          const pricedLines: PricedLine[] = [];
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

            // §4.13 row 3: rounded ONCE on the extended amount, half-up.
            const net = lineNetMinor(line.qty, sell.qty_scale, unitPriceE4, 'half-up');
            if (line.lineDiscountMinor > net) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'line discount exceeds line amount' });
            }
            const taxable = net - line.lineDiscountMinor;
            const taxes = computeLineTaxes(taxable, components);
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
              discountMinor: line.lineDiscountMinor,
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

        let subtotal = 0n;
        let discount = 0n;
        let taxTotal = 0n;
        for (const line of sale.lines) {
          const recomputedNet = lineNetMinor(
            BigInt(line.qty),
            line.qtyScale,
            BigInt(line.unitPriceE4),
            'half-up',
          );
          if (wire(recomputedNet) !== line.lineNetMinor) {
            mismatches.push(`line ${line.lineNo}: net ${line.lineNetMinor} != recomputed ${wire(recomputedNet)}`);
          }
          let lineTax = 0n;
          for (const t of line.taxLines) {
            const mode =
              t.roundingMode === 'half_up' ? 'half-up' : t.roundingMode === 'half_even' ? 'half-even' : 'down';
            const recomputedTax = mulBps(BigInt(t.baseMinor), BigInt(t.rateBp), mode);
            if (wire(recomputedTax) !== t.taxMinor) {
              mismatches.push(
                `line ${line.lineNo} ${t.taxCode}: tax ${t.taxMinor} != recomputed ${wire(recomputedTax)}`,
              );
            }
            lineTax += BigInt(t.taxMinor);
          }
          if (wire(lineTax) !== line.taxMinor) {
            mismatches.push(`line ${line.lineNo}: tax_minor ${line.taxMinor} != Σ components ${wire(lineTax)}`);
          }
          subtotal += BigInt(line.lineNetMinor);
          discount += BigInt(line.lineDiscountMinor);
          taxTotal += lineTax;
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
    rounding_mode: string;
    base_minor: string;
    tax_minor: string;
    tax_rate_id: string;
  }>(
    `select sale_line_id, seq, tax_code, rate_bp::text, base_kind, rounding_mode,
            base_minor::text, tax_minor::text, tax_rate_id
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
        roundingMode: t.rounding_mode,
        baseMinor: t.base_minor,
        taxMinor: t.tax_minor,
        taxRateId: t.tax_rate_id,
      })),
    })),
  };
}
