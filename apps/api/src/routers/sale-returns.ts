/**
 * VOIDS AND RETURNS — `returns.record` (migration 0030; 04 §4.8; 03 §3.6 #5;
 * 05 §5.6.2 rule 10; 08 §8.7).
 *
 * A void or a return is a NEW DOCUMENT, `app.sale_return`, written through the
 * one idempotent pipeline exactly like the sale it reverses: client
 * idempotency key (which IS the document id), claimed HLC kept untrusted, the
 * same ordered outbox (`sale.return`). The original sale is never touched.
 *
 * ── WHAT THE SERVER DECIDES ────────────────────────────────────────────────
 *  · THE FIGURES, from the ORIGINAL's snapshotted rows — price, discount, each
 *    tax component at the rate row it was charged at, stocking quantity — by
 *    cumulative pro-rata (`@erp/money` `returnSlice`). Never today's price list
 *    and never today's rate (ADR-0002; 05 §5.14 #23).
 *  · THE SPLIT: a void gives the money back the way it came (the original's
 *    own tender rows, mirrored). A return goes ON ACCOUNT FIRST, up to what the
 *    sale put on account and has not already been credited back; the rest
 *    through the one immediate method the device chose. An on-account sale's
 *    return is a credit note — a negative ADJUSTMENT applied to the original
 *    CHARGE for as much as is still outstanding — never cash.
 *  · THE BOUND, for a return: `sale.return`'s `max_refund_minor`, measured
 *    against the SERVER's figure, never the device's.
 *
 * ── WHAT IT DOES NOT DO: REFUSE A REFUND THAT HAS ALREADY HAPPENED ────────
 * A device offline for a day may have handed cash back across the counter
 * before the server heard of the sale's other returns. Refusing the document
 * then would lose a refund the drawer has already paid (CLAUDE.md §2.2). So
 * what physics permits LANDS, and what only a person can judge goes to the
 * review queue:
 *   · 03 §3.6 CLASS #5, severity 1, never auto-resolved — the sale was already
 *     reversed or settled elsewhere: a second void, a void after a return, a
 *     return beyond what is left, or a credit note larger than the customer's
 *     outstanding charge (they paid it elsewhere; the account goes into
 *     credit). Money moved; no automatic answer exists.
 *   · severity 2 — the device's claimed split or total differs from the
 *     server's (a stale view of the account), or the refund reached a till
 *     that had already closed.
 * What is REFUSED is only what no honest device builds: a cross-outlet return,
 * a void in a different till, a line number the sale does not have, more of a
 * line in ONE document than the line sold, an account credit on a sale that
 * charged no account.
 */
import { TRPCError } from '@trpc/server';
import { comparePriceCheck, createSaleReturnInput, type CreateSaleReturnParsed } from '@erp/contracts';
import { deterministicUuid, isSettlementRole, type HlcClock, type PermissionCode } from '@erp/db';
import { returnSlice } from '@erp/money';
import { emergencyNumber } from '@erp/sequence';
import type { VerifiedIdentity } from '../auth.js';
import type { Queryable } from '../db.js';
import { documentNumberHolder } from '../document-numbers.js';
import { runIdempotent, type JsonValue } from '../pipeline.js';
import { ROLE_SETTLEMENT } from '../tender.js';
import {
  assertLocationInScope,
  requiresPermission,
  router,
  tenantProcedure,
  type PermissionState,
} from '../trpc.js';
import { wire } from '../wire.js';
import { SALE_AFTER_TILL_CLOSED_CLASS } from './sales.js';
import { SEQUENCE_REVIEW_PERMISSION, SEVERITY_BLOCKING, openConflictReview } from './sequence.js';

/** 03 §3.6 class #5. Severity 1 — never auto-resolved. */
export const SALE_VOID_VS_SETTLED_CLASS = 'SALE_VOID_VS_SETTLED';
/** The device's refund split or total disagreed with the server's. Severity 2. */
export const RETURN_REFUND_RECONCILED_CLASS = 'SALE_RETURN_REFUND_RECONCILED';
const SEVERITY_REVIEW = 2;

/** Platform-guaranteed movement reasons, created on first use like 'SALE'. */
const REASON = {
  RESTOCK: { code: 'RETURN_RESTOCK', name: 'Returned by customer — back on the shelf' },
  DAMAGED: { code: 'RETURN_DAMAGED', name: 'Returned by customer — damaged, written off' },
} as const;

/** Which capability each kind needs. Anything else is refused by the middleware. */
export function returnPermission(input: Record<string, unknown>): PermissionCode | undefined {
  const kind = input['kind'];
  if (kind === 'VOID') return 'sale.void';
  if (kind === 'RETURN') return 'sale.return';
  return undefined;
}

interface OriginalSale {
  id: string;
  location_id: string;
  customer_id: string | null;
  cash_session_id: string | null;
  currency_code: string;
  money_scale: string;
  subtotal_net_minor: string;
  discount_minor: string;
  tax_total_minor: string;
  total_minor: string;
}

interface OriginalLine {
  id: string;
  line_no: number;
  product_id: string;
  qty_sell: string;
  qty_sell_scale: number;
  unit_price_e4: string;
  stocking_uom_id: string;
  qty_stock: string;
  qty_stock_scale: number;
  line_net_minor: string;
  line_discount_minor: string;
  stock_tracking: string;
  returned_qty: string;
}

interface OriginalTaxLine {
  id: string;
  sale_line_id: string;
  seq: number;
  tax_code: string;
  rate_bp: string;
  base_minor: string;
  tax_minor: string;
  tax_rate_id: string;
}

interface PlannedLine {
  lineNo: number;
  original: OriginalLine;
  qtySell: bigint;
  disposition: 'RESTOCK' | 'DAMAGED';
  netMinor: bigint;
  discountMinor: bigint;
  qtyStock: bigint;
  taxMinor: bigint;
  taxes: { original: OriginalTaxLine; baseMinor: bigint; taxMinor: bigint }[];
  /** True when this line came back beyond what was left of it (class #5). */
  overReturned: boolean;
}

interface PlannedRefund {
  seq: number;
  methodId: string;
  role: string;
  amountMinor: bigint;
  claimedMinor: bigint | null;
  reference: string | null;
}

/**
 * The sale, by its server id OR by the idempotency key it was recorded under.
 * A till that voids a sale it rang five minutes ago, offline, has never seen
 * the server's id for it — only its own key, which is the sale's `write_id`.
 * Both are unforgeable across tenants: RLS hides another tenant's rows either
 * way, and a miss answers RETRY_LATER exactly as a sale still in flight does.
 */
async function loadOriginal(tx: Queryable, saleRef: string): Promise<OriginalSale | null> {
  const r = await tx.query<OriginalSale>(
    `select id, location_id, customer_id, cash_session_id, currency_code, money_scale::text,
            subtotal_net_minor::text, discount_minor::text, tax_total_minor::text, total_minor::text
       from app.sale where id = $1 or write_id = $1
      order by (id = $1) desc limit 1`,
    [saleRef],
  );
  return r.rows[0] ?? null;
}

export const saleReturnsRouter = router({
  record: tenantProcedure
    .input(createSaleReturnInput)
    .use(requiresPermission({ code: returnPermission, at: 'input' }))
    .mutation(async ({ ctx, input }) => {
      assertLocationInScope(ctx.identity, input.locationId);
      const tenantId = ctx.identity.tenantId;
      const key = input.idempotencyKey;
      const returnId = key;

      const result = await runIdempotent(
        { runner: ctx.deps.runner, clock: ctx.deps.clock },
        ctx.identity,
        {
          op: 'sale.return',
          idempotencyKey: key,
          claimedHlc: input.claimedHlc,
          clientWallAt: input.clientWallAt,
          locationId: input.locationId,
        },
        input,
        async (tx) =>
          planReturn(tx, { identity: ctx.identity, permissions: ctx.permissions, clock: ctx.deps.clock }, input, returnId),
      );
      return result.response;
    }),
});

interface PlanCtx {
  readonly identity: VerifiedIdentity;
  readonly permissions: PermissionState;
  readonly clock: HlcClock;
}

async function planReturn(
  tx: Queryable,
  ctx: PlanCtx,
  input: CreateSaleReturnParsed,
  returnId: string,
) {
  const identity = ctx.identity;
  const tenantId = identity.tenantId;
  const key = input.idempotencyKey;

  // ── The sale being reversed. Not here yet ⇒ still in flight behind this
  // document on some device's ordered outbox: retryable, never a loss. A
  // sale of ANOTHER tenant is invisible under RLS and answers the same way.
  const sale = await loadOriginal(tx, input.originalSaleId);
  if (sale === null) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `RETRY_LATER: sale ${input.originalSaleId} is not recorded yet — the sale must land before its return`,
    });
  }
  if (sale.location_id !== input.locationId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'returns are taken at the location that made the sale (cross-outlet returns are not supported)',
    });
  }

  // ── The till the money leaves (04 §4.8a): its date is the document's.
  const sess = await tx.query<{ id: string; location_id: string; device_id: string | null; business_date: string; status: string }>(
    `select id, location_id, device_id, business_date::text, status from app.cash_session where id = $1`,
    [input.cashSessionId],
  );
  const session = sess.rows[0];
  if (!session) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `RETRY_LATER: cash session ${input.cashSessionId} is not recorded yet — the till's open must land first`,
    });
  }
  if (session.location_id !== input.locationId) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'this refund names a till at a different location' });
  }
  if (session.device_id !== null && session.device_id !== identity.deviceId) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'this refund names another device’s till' });
  }
  if (input.kind === 'VOID' && sale.cash_session_id !== input.cashSessionId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'a void is made in the till its sale was rung in; a refund from a later till is a return',
    });
  }
  const businessDate = session.business_date;

  // ── The original's lines, with what has come back of each already.
  const lineRes = await tx.query<OriginalLine>(
    `select l.id, l.line_no, l.product_id, l.qty_sell::text, l.qty_sell_scale, l.unit_price_e4::text,
            l.stocking_uom_id, l.qty_stock::text, l.qty_stock_scale, l.line_net_minor::text,
            l.line_discount_minor::text, p.stock_tracking,
            coalesce((select sum(rl.qty_sell) from app.sale_return_line rl
                       where rl.tenant_id = l.tenant_id and rl.original_sale_line_id = l.id), 0)::bigint::text
              as returned_qty
       from app.sale_line l
       join app.product p on p.tenant_id = l.tenant_id and p.id = l.product_id
      where l.sale_id = $1
      order by l.line_no`,
    [sale.id],
  );
  const taxRes = await tx.query<OriginalTaxLine>(
    `select id, sale_line_id, seq, tax_code, rate_bp::text, base_minor::text, tax_minor::text, tax_rate_id
       from app.sale_tax_line where sale_id = $1 order by sale_line_id, seq`,
    [sale.id],
  );
  const taxesByLine = new Map<string, OriginalTaxLine[]>();
  for (const t of taxRes.rows) {
    const list = taxesByLine.get(t.sale_line_id) ?? [];
    list.push(t);
    taxesByLine.set(t.sale_line_id, list);
  }
  const priorVoid = await tx.query<{ id: string }>(
    `select id from app.sale_return where original_sale_id = $1 and kind = 'VOID' limit 1`,
    [sale.id],
  );
  const alreadyVoided = priorVoid.rows.length > 0;
  const anyPrior = lineRes.rows.some((l) => BigInt(l.returned_qty) > 0n);

  // ── The figures, from the original's snapshots.
  const requests: { original: OriginalLine; qty: bigint; disposition: 'RESTOCK' | 'DAMAGED' }[] =
    input.kind === 'VOID'
      ? lineRes.rows.map((l) => ({ original: l, qty: BigInt(l.qty_sell), disposition: 'RESTOCK' as const }))
      : (input.lines ?? []).map((req) => {
          const original = lineRes.rows.find((l) => l.line_no === req.originalLineNo);
          if (!original) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: `sale has no line ${req.originalLineNo}` });
          }
          if (req.qty > BigInt(original.qty_sell)) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `line ${req.originalLineNo}: ${wire(req.qty)} is more than the ${original.qty_sell} it sold`,
            });
          }
          return { original, qty: req.qty, disposition: req.disposition };
        });

  const lines: PlannedLine[] = requests.map((req, i) => {
    const sold = BigInt(req.original.qty_sell);
    // A VOID reverses the whole line whatever came back before (that is the
    // class #5 case, flagged below). A RETURN takes the next `qty` units; if
    // the line is already (partly) back, it is priced as the LAST `qty` units
    // so the figures stay a true slice of what was charged.
    const returned = alreadyVoided ? sold : BigInt(req.original.returned_qty);
    const before = input.kind === 'VOID' ? 0n : returned + req.qty > sold ? sold - req.qty : returned;
    const originalTaxes = taxesByLine.get(req.original.id) ?? [];
    const slice = returnSlice(
      {
        qtySold: sold,
        netMinor: BigInt(req.original.line_net_minor),
        discountMinor: BigInt(req.original.line_discount_minor),
        qtyStock: BigInt(req.original.qty_stock),
        taxes: originalTaxes.map((t) => ({ baseMinor: BigInt(t.base_minor), taxMinor: BigInt(t.tax_minor) })),
      },
      before,
      req.qty,
    );
    return {
      lineNo: i + 1,
      original: req.original,
      qtySell: req.qty,
      disposition: req.disposition,
      netMinor: slice.netMinor,
      discountMinor: slice.discountMinor,
      qtyStock: slice.qtyStock,
      taxMinor: slice.taxMinor,
      taxes: originalTaxes.map((t, j) => ({
        original: t,
        baseMinor: slice.taxes[j]!.baseMinor,
        taxMinor: slice.taxes[j]!.taxMinor,
      })),
      overReturned: input.kind === 'VOID' ? returned > 0n : returned + req.qty > sold,
    };
  });

  const subtotal = lines.reduce((a, l) => a + l.netMinor, 0n);
  const discount = lines.reduce((a, l) => a + l.discountMinor, 0n);
  const tax = lines.reduce((a, l) => a + l.taxMinor, 0n);
  const total = subtotal - discount + tax;

  // ── The original's settlement, and what of its account part is still uncredited.
  const tenderRes = await tx.query<{ seq: number; method_id: string; posting_role: string; amount_minor: string; reference: string | null }>(
    `select st.seq, st.method_id, m.posting_role, st.amount_minor::text, st.reference
       from app.sale_tender st
       join app.tender_method m on m.tenant_id = st.tenant_id and m.id = st.method_id
      where st.sale_id = $1 order by st.seq`,
    [sale.id],
  );
  const originalOnAccount = tenderRes.rows
    .filter((t) => t.posting_role === 'AR_TRADE')
    .reduce((a, t) => a + BigInt(t.amount_minor), 0n);
  const priorOnAccountRes = await tx.query<{ credited: string }>(
    `select coalesce(sum(rf.amount_minor), 0)::bigint::text as credited
       from app.sale_return r
       join app.sale_return_refund rf on rf.tenant_id = r.tenant_id and rf.return_id = r.id
       join app.tender_method m on m.tenant_id = rf.tenant_id and m.id = rf.method_id
      where r.original_sale_id = $1 and m.is_on_account`,
    [sale.id],
  );
  const accountRemaining = originalOnAccount - BigInt(priorOnAccountRes.rows[0]!.credited);

  let refunds: PlannedRefund[];
  let splitDisagrees = false;
  if (input.kind === 'VOID') {
    // The money goes back the way it came: the original's own rows, mirrored.
    refunds = tenderRes.rows.map((t) => ({
      seq: t.seq,
      methodId: t.method_id,
      role: t.posting_role,
      amountMinor: BigInt(t.amount_minor),
      claimedMinor: null,
      reference: t.reference,
    }));
  } else {
    const refund = input.refund!;
    const methodRes = await tx.query<{ id: string; posting_role: string; requires_reference: boolean }>(
      `select id, posting_role, requires_reference from app.tender_method where id = $1 and deleted_at is null`,
      [refund.methodId],
    );
    const method = methodRes.rows[0];
    if (!method || !isSettlementRole(method.posting_role)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `unknown refund method ${refund.methodId}` });
    }
    if (ROLE_SETTLEMENT[method.posting_role] !== 'IMMEDIATE') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'the refund method names how money is handed back; an account credit is decided by the server',
      });
    }
    if (refund.onAccountClaimMinor > 0n && originalOnAccount === 0n) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'this sale charged no account, so its return cannot be credited to one',
      });
    }
    const onAccount = accountRemaining > 0n ? (total < accountRemaining ? total : accountRemaining) : 0n;
    const immediate = total - onAccount;
    if (method.requires_reference && immediate > 0n && refund.reference === undefined) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'this refund method needs a reference (a transaction id or a cheque number)',
      });
    }
    const accountMethod = tenderRes.rows.find((t) => t.posting_role === 'AR_TRADE')?.method_id ?? null;
    refunds = [];
    if (accountMethod !== null && (onAccount > 0n || refund.onAccountClaimMinor > 0n)) {
      refunds.push({
        seq: 1,
        methodId: accountMethod,
        role: 'AR_TRADE',
        amountMinor: onAccount,
        claimedMinor: refund.onAccountClaimMinor === onAccount ? null : refund.onAccountClaimMinor,
        reference: null,
      });
    }
    if (immediate > 0n || refund.immediateClaimMinor > 0n) {
      refunds.push({
        seq: refunds.length + 1,
        methodId: method.id,
        role: method.posting_role,
        amountMinor: immediate,
        claimedMinor: refund.immediateClaimMinor === immediate ? null : refund.immediateClaimMinor,
        reference: refund.reference ?? null,
      });
    }
    splitDisagrees = refunds.some((r) => r.claimedMinor !== null);
  }
  const onAccountRefund = refunds.filter((r) => r.role === 'AR_TRADE').reduce((a, r) => a + r.amountMinor, 0n);

  // ── THE BOUND, on the SERVER's figure (02 §2.4). Synchronous, against the
  // snapshot the middleware resolved (see sales.ts on why it must be).
  if (input.kind === 'RETURN') {
    ctx.permissions.requireWithinBound('sale.return', input.locationId, 'max_refund_minor', total);
  }

  // ── The credit note: applied to the original CHARGE up to what is still
  // outstanding on it; any excess is unapplied credit on the account — the
  // customer paid this sale elsewhere, which is class #5.
  let creditNote: { accountId: string; chargeId: string; applied: bigint; unapplied: bigint } | null = null;
  if (onAccountRefund > 0n) {
    const charge = await tx.query<{ id: string; account_id: string; outstanding: string }>(
      `select c.id, c.account_id,
              (c.amount_minor + coalesce((select sum(e.amount_minor) from app.credit_entry e
                                           where e.tenant_id = c.tenant_id and e.applies_to_id = c.id
                                             and e.kind not in ('FEE', 'CHARGE')), 0))::bigint::text as outstanding
         from app.credit_entry c
        where c.source_kind = 'SALE' and c.source_id = $1 and c.kind = 'CHARGE'
        order by c.id limit 1`,
      [sale.id],
    );
    const row = charge.rows[0];
    if (!row) {
      // 0022 makes an on-account tender without its CHARGE impossible.
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `sale ${sale.id} has an account tender and no charge` });
    }
    const outstanding = BigInt(row.outstanding) > 0n ? BigInt(row.outstanding) : 0n;
    const applied = onAccountRefund < outstanding ? onAccountRefund : outstanding;
    creditNote = { accountId: row.account_id, chargeId: row.id, applied, unapplied: onAccountRefund - applied };
  }

  const settledElsewhere: string[] = [];
  if (alreadyVoided) settledElsewhere.push('the sale was already voided');
  if (input.kind === 'VOID' && anyPrior && !alreadyVoided) settledElsewhere.push('part of the sale had already been returned');
  if (input.kind === 'RETURN' && lines.some((l) => l.overReturned) && !alreadyVoided) {
    settledElsewhere.push('more of a line came back than was left of it');
  }
  if (creditNote !== null && creditNote.unapplied > 0n) {
    settledElsewhere.push('the account credit exceeds what the customer still owed on this sale');
  }

  // ── The printed number: class #14 lands under the emergency form.
  const clash = await documentNumberHolder(tx, input.locationId, input.returnNo);
  let returnNo = input.returnNo;
  if (clash !== null) {
    const emergency = emergencyNumber(input.returnNo, identity.deviceId, returnId);
    returnNo = (await documentNumberHolder(tx, input.locationId, emergency)) === null ? emergency : `${input.returnNo}-${returnId}`;
  }
  const returnNoClaimed = clash === null ? null : input.returnNo;
  const occurredAt = input.occurredAt ?? new Date().toISOString();

  const reviews: string[] = [];
  if (settledElsewhere.length > 0) reviews.push(SALE_VOID_VS_SETTLED_CLASS);
  if (splitDisagrees) reviews.push(RETURN_REFUND_RECONCILED_CLASS);
  if (session.status !== 'OPEN') reviews.push(SALE_AFTER_TILL_CLOSED_CLASS);
  if (clash !== null) reviews.push('RECEIPT_NUMBER_COLLISION');

  const response = {
    returnId,
    kind: input.kind,
    originalSaleId: sale.id,
    returnNo,
    returnNoClaimed,
    businessDate,
    cashSessionId: input.cashSessionId,
    currencyCode: sale.currency_code,
    moneyScale: sale.money_scale,
    subtotalNetMinor: wire(subtotal),
    discountMinor: wire(discount),
    taxTotalMinor: wire(tax),
    totalMinor: wire(total),
    lines: lines.map((l) => ({
      lineNo: l.lineNo,
      originalLineNo: l.original.line_no,
      productId: l.original.product_id,
      qty: wire(l.qtySell),
      qtyScale: l.original.qty_sell_scale,
      qtyStock: wire(l.qtyStock),
      disposition: l.disposition,
      lineNetMinor: wire(l.netMinor),
      lineDiscountMinor: wire(l.discountMinor),
      taxMinor: wire(l.taxMinor),
    })),
    refunds: refunds.map((r) => ({
      seq: r.seq,
      methodId: r.methodId,
      settlement: isSettlementRole(r.role) ? ROLE_SETTLEMENT[r.role] : 'IMMEDIATE',
      amountMinor: wire(r.amountMinor),
      claimedMinor: r.claimedMinor === null ? null : wire(r.claimedMinor),
      reference: r.reference,
    })),
    creditNote:
      creditNote === null
        ? null
        : { accountId: creditNote.accountId, appliedMinor: wire(creditNote.applied), unappliedMinor: wire(creditNote.unapplied) },
    reviews,
    ...(input.clientTotalMinor === undefined ? {} : { priceCheck: comparePriceCheck(input.clientTotalMinor, total) }),
  } satisfies JsonValue & Record<string, unknown>;

  return {
    response,
    apply: async (atx: Queryable) => {
      const clock = ctx.clock;
      await atx.query(
        `insert into app.sale_return
           (tenant_id, id, write_id, hlc, kind, original_sale_id, location_id, cash_session_id,
            business_date, occurred_at, customer_id, return_no, return_no_claimed, reason,
            currency_code, money_scale, subtotal_net_minor, discount_minor, tax_total_minor, total_minor)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          tenantId, returnId, key, clock.next(), input.kind, sale.id, input.locationId, input.cashSessionId,
          businessDate, occurredAt, sale.customer_id, returnNo, returnNoClaimed, input.reason.trim(),
          sale.currency_code, sale.money_scale, wire(subtotal), wire(discount), wire(tax), wire(total),
        ],
      );

      for (const l of lines) {
        const lineId = deterministicUuid(key, 'sale_return_line', String(l.lineNo));
        await atx.query(
          `insert into app.sale_return_line
             (tenant_id, id, write_id, hlc, return_id, line_no, original_sale_line_id, product_id, location_id,
              qty_sell, qty_sell_scale, unit_price_e4, stocking_uom_id, qty_stock, qty_stock_scale,
              line_net_minor, line_discount_minor, tax_minor, disposition)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [
            tenantId, lineId, key, clock.next(), returnId, l.lineNo, l.original.id, l.original.product_id,
            input.locationId, wire(l.qtySell), l.original.qty_sell_scale, l.original.unit_price_e4,
            l.original.stocking_uom_id, wire(l.qtyStock), l.original.qty_stock_scale,
            wire(l.netMinor), wire(l.discountMinor), wire(l.taxMinor), l.disposition,
          ],
        );
        for (const t of l.taxes) {
          await atx.query(
            `insert into app.sale_return_tax_line
               (tenant_id, id, write_id, hlc, return_id, return_line_id, original_tax_line_id, location_id,
                seq, tax_code, rate_bp, base_minor, tax_minor, tax_rate_id)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              tenantId, deterministicUuid(key, 'sale_return_tax_line', String(l.lineNo), String(t.original.seq)),
              key, clock.next(), returnId, lineId, t.original.id, input.locationId, t.original.seq,
              t.original.tax_code, t.original.rate_bp, wire(t.baseMinor), wire(t.taxMinor), t.original.tax_rate_id,
            ],
          );
        }
      }

      for (const r of refunds) {
        await atx.query(
          `insert into app.sale_return_refund
             (tenant_id, id, write_id, hlc, return_id, seq, method_id, amount_minor, claimed_minor,
              reference, refunded_at, location_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            tenantId, deterministicUuid(key, 'sale_return_refund', String(r.seq)), key, clock.next(), returnId,
            r.seq, r.methodId, wire(r.amountMinor), r.claimedMinor === null ? null : wire(r.claimedMinor),
            r.reference, occurredAt, input.locationId,
          ],
        );
      }

      if (creditNote !== null) {
        if (creditNote.applied > 0n) {
          await atx.query(
            `insert into app.credit_entry
               (tenant_id, id, write_id, hlc, account_id, kind, amount_minor, business_date,
                source_kind, source_id, applies_to_id)
             values ($1,$2,$3,$4,$5,'ADJUSTMENT',$6,$7::date,'SALE_RETURN',$8,$9)`,
            [
              tenantId, deterministicUuid(key, 'credit_entry', 'applied'), key, clock.next(), creditNote.accountId,
              wire(-creditNote.applied), businessDate, returnId, creditNote.chargeId,
            ],
          );
        }
        if (creditNote.unapplied > 0n) {
          await atx.query(
            `insert into app.credit_entry
               (tenant_id, id, write_id, hlc, account_id, kind, amount_minor, business_date,
                source_kind, source_id, applies_to_id)
             values ($1,$2,$3,$4,$5,'ADJUSTMENT',$6,$7::date,'SALE_RETURN',$8,null)`,
            [
              tenantId, deterministicUuid(key, 'credit_entry', 'unapplied'), key, clock.next(), creditNote.accountId,
              wire(-creditNote.unapplied), businessDate, returnId,
            ],
          );
        }
      }

      // Stock comes back: SALE_RETURN (positive, in this till), and for a
      // damaged item a WRITE_OFF of the same quantity straight after — the
      // cost of the sale is reversed and the loss is recorded as a loss.
      const stocked = lines.filter((l) => l.original.stock_tracking === 'STOCKED' && l.qtyStock > 0n);
      if (stocked.length > 0) {
        const reasonIds = new Map<string, string>();
        for (const d of new Set(stocked.map((l) => l.disposition))) {
          const reason = REASON[d];
          await atx.query(
            `insert into app.movement_reason (tenant_id, id, write_id, hlc, code, name)
             values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
            [tenantId, deterministicUuid(tenantId, 'api', `movement_reason:${reason.code}`), key, clock.next(), reason.code, reason.name],
          );
          const got = await atx.query<{ id: string }>(
            `select id from app.movement_reason where code = $1 and deleted_at is null`,
            [reason.code],
          );
          reasonIds.set(d, got.rows[0]!.id);
        }
        for (const l of stocked) {
          const reasonId = reasonIds.get(l.disposition)!;
          await atx.query(
            `insert into app.stock_movement
               (tenant_id, id, write_id, hlc, location_id, product_id, qty_delta, qty_scale, uom_id, reason_id,
                source_kind, source_id, occurred_at, business_date, cash_session_id)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'SALE_RETURN',$11,$12,$13::date,$14)`,
            [
              tenantId, deterministicUuid(key, 'stock_movement', String(l.lineNo)), key, clock.next(),
              input.locationId, l.original.product_id, wire(l.qtyStock), l.original.qty_stock_scale,
              l.original.stocking_uom_id, reasonId, returnId, occurredAt, businessDate, input.cashSessionId,
            ],
          );
          if (l.disposition === 'DAMAGED') {
            await atx.query(
              `insert into app.stock_movement
                 (tenant_id, id, write_id, hlc, location_id, product_id, qty_delta, qty_scale, uom_id, reason_id,
                  source_kind, source_id, occurred_at, business_date)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'WRITE_OFF',$11,$12,$13::date)`,
              [
                tenantId, deterministicUuid(key, 'stock_movement', String(l.lineNo), 'write_off'), key, clock.next(),
                input.locationId, l.original.product_id, wire(-l.qtyStock), l.original.qty_stock_scale,
                l.original.stocking_uom_id, reasonId, returnId, occurredAt, businessDate,
              ],
            );
          }
        }
      }

      const common = {
        tenantId,
        writeId: key,
        requiredPermission: SEQUENCE_REVIEW_PERMISSION,
        locationIds: [input.locationId],
      };
      if (settledElsewhere.length > 0) {
        await openConflictReview(atx, {
          ...common,
          hlc: clock.next(),
          reviewId: deterministicUuid(key, 'conflict_review', 'void_vs_settled'),
          conflictClass: SALE_VOID_VS_SETTLED_CLASS,
          severity: SEVERITY_BLOCKING,
          entityTable: 'app.sale',
          entityId: sale.id,
          fieldPath: 'returns',
          proposals: [
            {
              party: 'arriving',
              detail: `a ${input.kind === 'VOID' ? 'void' : 'return'} that reached the server after the sale was already reversed or settled`,
              returnId,
              returnNo,
              totalMinor: wire(total),
              onAccountMinor: wire(onAccountRefund),
              deviceId: identity.deviceId,
              userId: identity.userId,
            },
          ],
          pendingState: 'first_applied',
          pendingValue: {
            findings: settledElsewhere,
            note:
              'Money has moved twice for the same goods, or back to a customer who had already paid. ' +
              'The refund is recorded as it happened at the counter. Decide what is owed, by whom, ' +
              'and check the till and the account.',
          },
        });
      }
      if (splitDisagrees) {
        await openConflictReview(atx, {
          ...common,
          hlc: clock.next(),
          reviewId: deterministicUuid(key, 'conflict_review', 'refund_reconciled'),
          conflictClass: RETURN_REFUND_RECONCILED_CLASS,
          severity: SEVERITY_REVIEW,
          entityTable: 'app.sale_return',
          entityId: returnId,
          fieldPath: 'refunds',
          proposals: [
            {
              party: 'device',
              detail: 'how the counter split the refund',
              onAccountMinor: wire(input.refund?.onAccountClaimMinor ?? 0n),
              immediateMinor: wire(input.refund?.immediateClaimMinor ?? 0n),
            },
            {
              party: 'server',
              detail: 'the split by the stated rule (account first, up to what is uncredited), as recorded',
              refunds: refunds.map((r) => ({ seq: r.seq, methodId: r.methodId, amountMinor: wire(r.amountMinor) })),
            },
          ],
          pendingState: 'safe_default',
          pendingValue: { note: 'Check the till count and the customer’s account against what was handed over.' },
        });
      }
      if (session.status !== 'OPEN') {
        await openConflictReview(atx, {
          ...common,
          hlc: clock.next(),
          reviewId: deterministicUuid(key, 'conflict_review', 'refund_after_till_closed'),
          conflictClass: SALE_AFTER_TILL_CLOSED_CLASS,
          severity: SEVERITY_REVIEW,
          entityTable: 'app.cash_session',
          entityId: session.id,
          fieldPath: 'expected_cash_minor',
          proposals: [
            {
              party: 'arriving',
              detail: 'a refund from this till that reached the server after its close',
              returnId,
              drawerCashMinor: wire(-refunds.filter((r) => r.role === 'TILL_CASH').reduce((a, r) => a + r.amountMinor, 0n)),
            },
          ],
          pendingState: 'first_applied',
          pendingValue: { sessionStatus: session.status, note: 'The close’s expected cash does not include this refund.' },
        });
      }
      if (clash !== null) {
        await openConflictReview(atx, {
          ...common,
          hlc: clock.next(),
          reviewId: deterministicUuid(key, 'conflict_review', 'receipt_collision'),
          conflictClass: 'RECEIPT_NUMBER_COLLISION',
          severity: SEVERITY_BLOCKING,
          entityTable: 'app.sale_return',
          entityId: returnId,
          fieldPath: 'return_no',
          proposals: [
            { party: 'existing', detail: 'the document already holding this number', table: clash.table, id: clash.id, number: clash.number },
            { party: 'arriving', detail: 'the return slip printed with the same number', returnId, printed: input.returnNo, stored: returnNo },
          ],
          pendingState: 'first_applied',
          pendingValue: { stored: returnNo, printed: input.returnNo, note: 'Two documents carry one printed number. Reconcile the paper copies.' },
        });
      }
    },
  };
}
