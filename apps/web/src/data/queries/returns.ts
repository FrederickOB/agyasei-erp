/**
 * What can still come back of a sale — read LOCALLY, so a void or a return is
 * offered, priced and recorded with the radio off (08 §8.7; migration 0030).
 *
 * A sale has two lives on a device (printing/sources.ts says the same):
 *
 *  · JUST RUNG, NOT YET SYNCED — only the outbox row. The server has not
 *    priced it, so there are no lines to take back one by one. It can be
 *    VOIDED (the whole sale, in its own till): a void states no lines, and
 *    the server reverses exactly what it recorded.
 *  · SYNCED — the server's `sale`, `sale_line`, `sale_tax_line`,
 *    `sale_tender` rows. Now it can also be RETURNED, line by line, priced
 *    from those snapshotted rows by the same `@erp/money` `returnSlice` the
 *    server runs, so the refund shown is the refund recorded.
 *
 * What has ALREADY come back is the server's `sale_return*` rows plus this
 * device's own queued returns the server has not echoed yet — never counted
 * twice (a queued return whose id has synced is the synced one), and never a
 * dead-lettered one (the server did not record it).
 *
 * Every money and quantity figure is read through CAST(… AS TEXT) and becomes
 * bigint exactly once, here (§8.3).
 */
import { returnSlice } from '@erp/money';
import type { DbExecutor, DbRow } from '../db';
import { readDeviceLocation } from './session';

export interface ReturnableTax {
  readonly code: string;
  readonly rateBp: bigint;
  readonly baseMinor: bigint;
  readonly taxMinor: bigint;
}

export interface ReturnableLine {
  readonly lineNo: number;
  readonly saleLineId: string;
  readonly productId: string;
  readonly name: string;
  readonly uomLabel: string;
  readonly qtySold: bigint;
  readonly qtyScale: number;
  readonly unitPriceE4: bigint;
  readonly netMinor: bigint;
  readonly discountMinor: bigint;
  readonly qtyStock: bigint;
  readonly taxes: readonly ReturnableTax[];
  /** Already back: synced returns plus this device's queued ones. */
  readonly returnedQty: bigint;
  readonly remainingQty: bigint;
}

export interface ReturnableTender {
  readonly methodId: string;
  readonly name: string;
  readonly amountMinor: bigint;
  readonly reference: string | null;
  readonly isCash: boolean;
  readonly isOnAccount: boolean;
}

export interface ReturnableSale {
  /** The idempotency key the sale was recorded under — what the wire names it by. */
  readonly key: string;
  readonly serverId: string | null;
  readonly receiptNo: string;
  readonly cashSessionId: string | null;
  readonly totalMinor: bigint;
  readonly customerId: string | null;
  /** True once the server's lines are on this device: a RETURN needs them. */
  readonly synced: boolean;
  readonly pricesIncludeTax: boolean;
  readonly lines: readonly ReturnableLine[];
  readonly tenders: readonly ReturnableTender[];
  /** What the sale put on account, and what of it has already been credited back. */
  readonly onAccountMinor: bigint;
  readonly accountCreditedMinor: bigint;
  /** Cash the sale put in the drawer — what a void takes back out of it. */
  readonly drawerCashMinor: bigint;
  readonly alreadyVoided: boolean;
  readonly anyReturned: boolean;
}

const big = (v: unknown): bigint => (v === null || v === undefined ? 0n : BigInt(String(v)));
const flag = (v: unknown): boolean => v === 1 || v === '1' || v === true;

interface QueuedReturn {
  readonly id: string;
  readonly kind: 'VOID' | 'RETURN';
  readonly lines: readonly { originalLineNo: number; qty: bigint }[];
  readonly onAccountMinor: bigint;
}

/** This device's queued, not-yet-echoed, not-dead-lettered returns of one sale. */
async function queuedReturns(db: DbExecutor, refs: readonly string[]): Promise<QueuedReturn[]> {
  const rows = await db.getAll(
    `SELECT o.id, o.payload FROM outbox o
      WHERE o.kind = 'sale_return' AND o.rejected_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM sale_return r WHERE r.id = o.id)`,
  );
  const out: QueuedReturn[] = [];
  for (const r of rows) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(String(r['payload'])) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof p['originalSaleId'] !== 'string' || !refs.includes(p['originalSaleId'])) continue;
    const lines = Array.isArray(p['lines'])
      ? (p['lines'] as { originalLineNo?: unknown; qty?: unknown }[]).flatMap((l) =>
          typeof l.originalLineNo === 'number' && typeof l.qty === 'string' ? [{ originalLineNo: l.originalLineNo, qty: BigInt(l.qty) }] : [],
        )
      : [];
    const refund = p['refund'] as { onAccountClaimMinor?: unknown } | undefined;
    out.push({
      id: String(r['id']),
      kind: p['kind'] === 'VOID' ? 'VOID' : 'RETURN',
      lines,
      onAccountMinor: typeof refund?.onAccountClaimMinor === 'string' ? BigInt(refund.onAccountClaimMinor) : 0n,
    });
  }
  return out;
}

function mapTender(r: DbRow): ReturnableTender {
  return {
    methodId: String(r['method_id']),
    name: typeof r['name'] === 'string' ? r['name'] : 'Payment',
    amountMinor: big(r['amount']),
    reference: typeof r['reference'] === 'string' ? r['reference'] : null,
    isCash: flag(r['is_cash']),
    isOnAccount: flag(r['is_on_account']),
  };
}

/**
 * One sale, by the key it was recorded under (its outbox id on the device
 * that rang it, its `write_id` everywhere). Null when this device knows
 * nothing of it.
 */
export async function loadReturnableSale(db: DbExecutor, key: string): Promise<ReturnableSale | null> {
  const synced = (
    await db.getAll(
      `SELECT s.id, s.write_id, s.receipt_no, s.cash_session_id, s.customer_id,
              CAST(s.total_minor AS TEXT) AS total, COALESCE(pl.is_tax_inclusive, 0) AS inclusive
         FROM sale s LEFT JOIN price_list pl ON pl.id = s.price_list_id
        WHERE s.write_id = ? LIMIT 1`,
      [key],
    )
  )[0];
  const queued = (
    await db.getAll(
      `SELECT id, receipt_no, cash_session_id, payload,
              CAST(total_minor AS TEXT) AS total, CAST(drawer_minor AS TEXT) AS drawer
         FROM outbox WHERE kind = 'sale' AND id = ? LIMIT 1`,
      [key],
    )
  )[0];
  if (synced === undefined && queued === undefined) return null;

  const serverId = synced === undefined ? null : String(synced['id']);
  const refs = serverId === null ? [key] : [key, serverId];
  const pending = await queuedReturns(db, refs);

  if (serverId === null) {
    // Not echoed yet: the device's own figures, and only a void is possible.
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(String(queued!['payload'])) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const total = big(queued!['total']);
    const stated = Array.isArray(payload['tenders']) ? (payload['tenders'] as Record<string, unknown>[]) : [];
    const tenders: ReturnableTender[] = [];
    let statedSum = 0n;
    for (const t of stated) statedSum += typeof t['amountMinor'] === 'string' ? BigInt(t['amountMinor']) : 0n;
    for (const t of stated) {
      const m = (
        await db.getAll(`SELECT id, name, is_cash, is_on_account FROM tender_method WHERE id = ? LIMIT 1`, [String(t['methodId'] ?? '')])
      )[0];
      tenders.push({
        methodId: String(t['methodId'] ?? ''),
        name: typeof m?.['name'] === 'string' ? m['name'] : 'Payment',
        amountMinor: typeof t['amountMinor'] === 'string' ? BigInt(t['amountMinor']) : total - statedSum,
        reference: typeof t['reference'] === 'string' ? t['reference'] : null,
        isCash: flag(m?.['is_cash']),
        isOnAccount: flag(m?.['is_on_account']),
      });
    }
    const onAccount = tenders.filter((t) => t.isOnAccount).reduce((a, t) => a + t.amountMinor, 0n);
    return {
      key,
      serverId: null,
      receiptNo: String(queued!['receipt_no'] ?? key.slice(-6).toUpperCase()),
      cashSessionId: typeof queued!['cash_session_id'] === 'string' ? queued!['cash_session_id'] : null,
      totalMinor: total,
      customerId: typeof payload['customerId'] === 'string' ? payload['customerId'] : null,
      synced: false,
      pricesIncludeTax: false,
      lines: [],
      tenders,
      onAccountMinor: onAccount,
      accountCreditedMinor: pending.reduce((a, p) => a + (p.kind === 'VOID' ? onAccount : p.onAccountMinor), 0n),
      drawerCashMinor: big(queued!['drawer']),
      alreadyVoided: pending.some((p) => p.kind === 'VOID'),
      anyReturned: pending.length > 0,
    };
  }

  const lineRows = await db.getAll(
    `SELECT sl.id, sl.line_no, sl.product_id, p.name AS product_name, COALESCE(u.name, u.code) AS uom_label,
            CAST(sl.qty_sell AS TEXT) AS qty, sl.qty_sell_scale AS scale, CAST(sl.unit_price_e4 AS TEXT) AS unit_e4,
            CAST(sl.line_net_minor AS TEXT) AS net, CAST(sl.line_discount_minor AS TEXT) AS disc,
            CAST(sl.qty_stock AS TEXT) AS stock
       FROM sale_line sl
       LEFT JOIN product p ON p.id = sl.product_id
       LEFT JOIN unit_of_measure u ON u.id = sl.selling_uom_id
      WHERE sl.sale_id = ? ORDER BY sl.line_no`,
    [serverId],
  );
  const taxRows = await db.getAll(
    `SELECT sale_line_id, tax_code, rate_bp, CAST(base_minor AS TEXT) AS base, CAST(tax_minor AS TEXT) AS tax
       FROM sale_tax_line WHERE sale_id = ? ORDER BY sale_line_id, seq`,
    [serverId],
  );
  const returnedRows = await db.getAll(
    `SELECT rl.original_sale_line_id AS line_id, CAST(SUM(rl.qty_sell) AS TEXT) AS qty
       FROM sale_return_line rl JOIN sale_return r ON r.id = rl.return_id
      WHERE r.original_sale_id = ? GROUP BY rl.original_sale_line_id`,
    [serverId],
  );
  const syncedReturns = await db.getAll(`SELECT id, kind FROM sale_return WHERE original_sale_id = ?`, [serverId]);
  const tenderRows = await db.getAll(
    `SELECT st.method_id, COALESCE(m.name, 'Payment') AS name, CAST(st.amount_minor AS TEXT) AS amount, st.reference,
            m.is_cash, m.is_on_account
       FROM sale_tender st LEFT JOIN tender_method m ON m.id = st.method_id
      WHERE st.sale_id = ? ORDER BY st.seq`,
    [serverId],
  );
  const creditedRows = await db.getAll(
    `SELECT CAST(COALESCE(SUM(rf.amount_minor), 0) AS TEXT) AS credited
       FROM sale_return r JOIN sale_return_refund rf ON rf.return_id = r.id
       JOIN tender_method m ON m.id = rf.method_id
      WHERE r.original_sale_id = ? AND m.is_on_account = 1`,
    [serverId],
  );

  const returnedBy = new Map(returnedRows.map((r) => [String(r['line_id']), big(r['qty'])]));
  const voidedNow = syncedReturns.some((r) => r['kind'] === 'VOID') || pending.some((p) => p.kind === 'VOID');
  const lines: ReturnableLine[] = lineRows.map((r) => {
    const lineNo = Number(r['line_no']);
    const sold = big(r['qty']);
    const queuedBack = pending.reduce(
      (a, p) => a + (p.kind === 'VOID' ? sold : p.lines.filter((l) => l.originalLineNo === lineNo).reduce((x, l) => x + l.qty, 0n)),
      0n,
    );
    const back = voidedNow ? sold : (returnedBy.get(String(r['id'])) ?? 0n) + queuedBack;
    return {
      lineNo,
      saleLineId: String(r['id']),
      productId: String(r['product_id']),
      name: typeof r['product_name'] === 'string' ? r['product_name'] : 'Item',
      uomLabel: typeof r['uom_label'] === 'string' ? r['uom_label'] : '',
      qtySold: sold,
      qtyScale: Number(r['scale'] ?? 0),
      unitPriceE4: big(r['unit_e4']),
      netMinor: big(r['net']),
      discountMinor: big(r['disc']),
      qtyStock: big(r['stock']),
      taxes: taxRows
        .filter((t) => t['sale_line_id'] === r['id'])
        .map((t) => ({ code: String(t['tax_code']), rateBp: big(t['rate_bp']), baseMinor: big(t['base']), taxMinor: big(t['tax']) })),
      returnedQty: back > sold ? sold : back,
      remainingQty: back >= sold ? 0n : sold - back,
    };
  });
  const tenders = tenderRows.map(mapTender);
  const onAccount = tenders.filter((t) => t.isOnAccount).reduce((a, t) => a + t.amountMinor, 0n);
  return {
    key,
    serverId,
    receiptNo: String(synced!['receipt_no']),
    cashSessionId: typeof synced!['cash_session_id'] === 'string' ? synced!['cash_session_id'] : null,
    totalMinor: big(synced!['total']),
    customerId: typeof synced!['customer_id'] === 'string' ? synced!['customer_id'] : null,
    synced: true,
    pricesIncludeTax: flag(synced!['inclusive']),
    lines,
    tenders,
    onAccountMinor: onAccount,
    accountCreditedMinor:
      big(creditedRows[0]?.['credited']) +
      pending.reduce((a, p) => a + (p.kind === 'VOID' ? onAccount : p.onAccountMinor), 0n),
    drawerCashMinor: tenders.filter((t) => t.isCash).reduce((a, t) => a + t.amountMinor, 0n),
    alreadyVoided: voidedNow,
    anyReturned: syncedReturns.length > 0 || pending.length > 0,
  };
}

/** Find a sale at THIS device's location by the number on the customer's paper. */
export async function findSaleKeyByReceiptNo(db: DbExecutor, receiptNo: string): Promise<string | null> {
  const wanted = receiptNo.trim();
  if (wanted.length === 0) return null;
  const location = await readDeviceLocation(db);
  const own = await db.getAll(`SELECT id FROM outbox WHERE kind = 'sale' AND receipt_no = ? LIMIT 1`, [wanted]);
  if (own[0] !== undefined) return String(own[0]['id']);
  const synced = await db.getAll(
    `SELECT write_id FROM sale WHERE receipt_no = ? AND (? IS NULL OR location_id = ?) LIMIT 1`,
    [wanted, location?.id ?? null, location?.id ?? null],
  );
  const w = synced[0]?.['write_id'];
  return typeof w === 'string' && w.length > 0 ? w : null;
}

// ---------------------------------------------------------------------------
// Pricing a return — the server's rule, run here so the counter shows it
// ---------------------------------------------------------------------------

export interface ReturnPick {
  readonly lineNo: number;
  /** In the original line's selling unit, at its scale. */
  readonly qty: bigint;
  readonly disposition: 'RESTOCK' | 'DAMAGED';
}

export interface PricedReturnLine {
  readonly line: ReturnableLine;
  readonly qty: bigint;
  readonly disposition: 'RESTOCK' | 'DAMAGED';
  readonly netMinor: bigint;
  readonly discountMinor: bigint;
  readonly taxes: readonly ReturnableTax[];
  readonly taxMinor: bigint;
  readonly totalMinor: bigint;
}

export interface PricedReturn {
  readonly lines: readonly PricedReturnLine[];
  readonly subtotalMinor: bigint;
  readonly discountMinor: bigint;
  readonly taxMinor: bigint;
  readonly totalMinor: bigint;
  /** ON ACCOUNT FIRST, up to what the sale put there and has not had credited back. */
  readonly onAccountMinor: bigint;
  /** The rest, through the immediate method the counter chooses. */
  readonly immediateMinor: bigint;
}

export class ReturnPickError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReturnPickError';
  }
}

export function priceReturn(sale: ReturnableSale, picks: readonly ReturnPick[]): PricedReturn {
  if (!sale.synced) throw new ReturnPickError('This sale has not reached the office yet. It can be voided, not returned in part.');
  const chosen = picks.filter((p) => p.qty > 0n);
  if (chosen.length === 0) throw new ReturnPickError('Choose what is coming back.');
  const lines = chosen.map((p): PricedReturnLine => {
    const line = sale.lines.find((l) => l.lineNo === p.lineNo);
    if (line === undefined) throw new ReturnPickError(`This sale has no line ${p.lineNo}.`);
    if (p.qty > line.remainingQty) {
      throw new ReturnPickError(`Only ${line.remainingQty.toString()} of ${line.name} is left to come back.`);
    }
    const sold = line.qtySold;
    const before = line.returnedQty + p.qty > sold ? sold - p.qty : line.returnedQty;
    const slice = returnSlice(
      { qtySold: sold, netMinor: line.netMinor, discountMinor: line.discountMinor, qtyStock: line.qtyStock, taxes: line.taxes },
      before,
      p.qty,
    );
    return {
      line,
      qty: p.qty,
      disposition: p.disposition,
      netMinor: slice.netMinor,
      discountMinor: slice.discountMinor,
      taxes: line.taxes.map((t, i) => ({ ...t, baseMinor: slice.taxes[i]!.baseMinor, taxMinor: slice.taxes[i]!.taxMinor })),
      taxMinor: slice.taxMinor,
      totalMinor: slice.totalMinor,
    };
  });
  const subtotal = lines.reduce((a, l) => a + l.netMinor, 0n);
  const discount = lines.reduce((a, l) => a + l.discountMinor, 0n);
  const tax = lines.reduce((a, l) => a + l.taxMinor, 0n);
  const total = subtotal - discount + tax;
  const remainingAccount = sale.onAccountMinor - sale.accountCreditedMinor;
  const onAccount = remainingAccount > 0n ? (total < remainingAccount ? total : remainingAccount) : 0n;
  return {
    lines,
    subtotalMinor: subtotal,
    discountMinor: discount,
    taxMinor: tax,
    totalMinor: total,
    onAccountMinor: onAccount,
    immediateMinor: total - onAccount,
  };
}
