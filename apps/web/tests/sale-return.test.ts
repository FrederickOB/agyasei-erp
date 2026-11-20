/**
 * Voids and returns at the counter — the PWA's own builders over its real
 * local SQLite (migration 0030). Category 1 (money): the refund is priced by the
 * server's rule from the sale's own snapshot, pieces sum back exactly, cash
 * refunds come off the till's expected cash, an on-account sale's return is a
 * credit, never cash. Category 2 (offline): every one of these runs with no
 * network, a queued return counts against what is left before it syncs, and a
 * synced return is never counted twice. Refusals are paired with positive
 * controls.
 */
import { describe, expect, it } from 'vitest';
import { createSaleReturnInput } from '@erp/contracts';
import { cumulativeSlice } from '@erp/money';
import type { LocalDb } from '../src/data/db';
import { addProductToCart, createCart } from '../src/data/mutations/cart';
import { checkout } from '../src/data/mutations/checkout';
import { recordReturn, recordVoid, SaleReturnError } from '../src/data/mutations/saleReturn';
import { readOpenTill, tillExpectedCash } from '../src/data/mutations/till';
import { loadActiveProducts } from '../src/data/queries/products';
import { loadReturnableSale, priceReturn } from '../src/data/queries/returns';
import { WIRE_KINDS } from '../src/data/sync/transport';
import { layoutReceipt } from '../src/printing/layout';
import { CODE_PAGES } from '../src/printing/codepage';
import { documentForReturn } from '../src/printing/sources';
import { fixedHlc, provisionDevice, seedProduct, seedTenderMethods } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';
import { uuidv7 } from '../src/lib/uuidv7';

const K = { old: uuidv7(), today: uuidv7(), k1: uuidv7(), acct: uuidv7(), pr: uuidv7() };

const CURRENCY = { code: 'XTS', symbol: 'X$', scale: 2 } as const;

async function device(floatMinor = 0n) {
  const db = openTestDb();
  const d = await provisionDevice(db);
  if (floatMinor > 0n) {
    await db.execute(`UPDATE till_session SET opening_float_minor = CAST(? AS INTEGER) WHERE id = ?`, [floatMinor.toString(), d.tillId]);
  }
  const methods = await seedTenderMethods(db);
  return { db, d, methods };
}

async function ringOffline(db: LocalDb, priceListId: string, units = 2) {
  const p = await seedProduct(db, { code: 'P-1', name: 'Bag', unitPriceE4: 55_000_000n, priceListId });
  const cartId = await createCart(db);
  const row = (await loadActiveProducts(db)).find((x) => x.id === p.id)!;
  for (let i = 0; i < units; i += 1) await addProductToCart(db, cartId, row);
  return checkout(db, { cartId, hlc: fixedHlc(Date.now()) });
}

/** A sale as the server's rows deliver it: 3 units at 55.00, two tax components. */
async function syncedSale(
  db: LocalDb,
  opts: { key: string; tillId: string; method: string; tenderMinor: bigint; total?: bigint; receiptNo?: string },
) {
  const serverId = `srv-${opts.key}`;
  await db.execute(
    `INSERT INTO sale (id, write_id, location_id, receipt_no, business_date, cash_session_id, currency_code, money_scale,
                       subtotal_net_minor, discount_minor, tax_total_minor, total_minor)
     VALUES (?, ?, NULL, ?, '2026-12-01', ?, 'XTS', 100, 16500, 0, 2889, 19389)`,
    [serverId, opts.key, opts.receiptNo ?? `R-${opts.key.slice(-4)}`, opts.tillId],
  );
  await db.execute(
    `INSERT INTO sale_line (id, sale_id, line_no, product_id, qty_sell, qty_sell_scale, unit_price_e4,
                            qty_stock, qty_stock_scale, line_discount_minor, line_net_minor, tax_minor)
     VALUES (?, ?, 1, 'p', 3, 0, 55000000, 3, 0, 0, 16500, 2889)`,
    [`${serverId}-l1`, serverId],
  );
  for (const [seq, code, rate, tax] of [[1, 'VAT', 1500, 2475], [2, 'LEVY', 250, 414]] as const) {
    await db.execute(
      `INSERT INTO sale_tax_line (id, sale_id, sale_line_id, seq, tax_code, rate_bp, base_minor, tax_minor, tax_rate_id)
       VALUES (?, ?, ?, ?, ?, ?, 16500, ?, 'tr')`,
      [`${serverId}-t${String(seq)}`, serverId, `${serverId}-l1`, seq, code, rate, tax],
    );
  }
  await db.execute(
    `INSERT INTO sale_tender (id, sale_id, seq, method_id, amount_minor, location_id) VALUES (?, ?, 1, ?, ?, NULL)`,
    [`${serverId}-tn`, serverId, opts.method, (opts.total ?? opts.tenderMinor).toString()],
  );
  return serverId;
}

describe('a VOID at the counter, offline', () => {
  it('reverses an unsynced sale in its own till: the cash comes back out of the expected figure', async () => {
    const { db, d } = await device(10_000n);
    const till = (await readOpenTill(db))!;
    const sale = await ringOffline(db, d.priceListId);
    const withSale = await tillExpectedCash(db, till);
    expect(withSale).toBe(10_000n + sale.totalMinor);

    const v = await recordVoid(db, { saleKey: sale.saleId, reason: 'Rung in error', hlc: fixedHlc(Date.now()) });
    expect(v).toMatchObject({ kind: 'VOID', totalMinor: sale.totalMinor, cashOutMinor: sale.totalMinor });
    expect(await tillExpectedCash(db, till)).toBe(10_000n);

    const row = (await db.getAll(
      `SELECT kind, payload, CAST(drawer_minor AS TEXT) AS drawer, cash_session_id FROM outbox WHERE id = ?`, [v.returnId]))[0]!;
    expect(row['kind']).toBe('sale_return');
    expect(WIRE_KINDS['sale_return']).toBe('sale.return');
    expect(row['drawer']).toBe((-sale.totalMinor).toString());
    const parsed = createSaleReturnInput.parse(JSON.parse(String(row['payload'])));
    expect(parsed).toMatchObject({ kind: 'VOID', originalSaleId: sale.saleId, cashSessionId: till.id });
    expect(parsed.lines).toBeUndefined();

    // Once is enough: the second void is refused at the counter, before money moves.
    await expect(recordVoid(db, { saleKey: sale.saleId, reason: 'again', hlc: fixedHlc(Date.now()) }))
      .rejects.toThrow(/already been voided/);
  });

  it('is refused for a sale from an earlier till — positive control: the same sale, its own till', async () => {
    const { db, d, methods } = await device();
    const till = (await readOpenTill(db))!;
    await syncedSale(db, { key: K.old, tillId: 'an-earlier-till', method: methods.cash.id, tenderMinor: 19389n });
    await expect(recordVoid(db, { saleKey: K.old, reason: 'x', hlc: fixedHlc(Date.now()) })).rejects.toThrow(/Return items/);
    await syncedSale(db, { key: K.today, tillId: till.id, method: methods.cash.id, tenderMinor: 19389n });
    const ok = await recordVoid(db, { saleKey: K.today, reason: 'x', hlc: fixedHlc(Date.now()) });
    expect(ok.totalMinor).toBe(19389n);
    void d;
  });

  it('needs a reason', async () => {
    const { db, d } = await device();
    const sale = await ringOffline(db, d.priceListId);
    await expect(recordVoid(db, { saleKey: sale.saleId, reason: '  ', hlc: fixedHlc(Date.now()) })).rejects.toThrow(SaleReturnError);
  });
});

describe('a RETURN at the counter, priced from the sale’s own snapshot', () => {
  it('prices by the server’s cumulative rule; queued returns count against what is left; pieces sum exactly', async () => {
    const { db, methods } = await device(50_000n);
    const till = (await readOpenTill(db))!;
    await syncedSale(db, { key: K.k1, tillId: 'tuesday', method: methods.cash.id, tenderMinor: 19389n });
    const sale = (await loadReturnableSale(db, K.k1))!;
    expect(sale).toMatchObject({ synced: true, receiptNo: `R-${K.k1.slice(-4)}`, totalMinor: 19389n });

    const one = priceReturn(sale, [{ lineNo: 1, qty: 1n, disposition: 'RESTOCK' }]);
    expect(one.subtotalMinor).toBe(cumulativeSlice(16500n, 0n, 1n, 3n));
    expect(one.taxMinor).toBe(cumulativeSlice(2475n, 0n, 1n, 3n) + cumulativeSlice(414n, 0n, 1n, 3n));

    const r1 = await recordReturn(db, {
      saleKey: K.k1, reason: 'Changed mind', hlc: fixedHlc(Date.now()), method: methods.cash,
      picks: [{ lineNo: 1, qty: 1n, disposition: 'RESTOCK' }],
    });
    expect(await tillExpectedCash(db, till)).toBe(50_000n - r1.totalMinor);
    // The queued return already counts: two are left, not three.
    const after = (await loadReturnableSale(db, K.k1))!;
    expect(after.lines[0]!.remainingQty).toBe(2n);
    await expect(recordReturn(db, {
      saleKey: K.k1, reason: 'x', hlc: fixedHlc(Date.now()), method: methods.cash,
      picks: [{ lineNo: 1, qty: 3n, disposition: 'RESTOCK' }],
    })).rejects.toThrow(/Only 2/);
    const r2 = await recordReturn(db, {
      saleKey: K.k1, reason: 'x', hlc: fixedHlc(Date.now()), method: methods.cash,
      picks: [{ lineNo: 1, qty: 2n, disposition: 'DAMAGED' }],
    });
    expect(r1.totalMinor + r2.totalMinor).toBe(19389n);

    // Once the server echoes the first return, it is counted ONCE, not twice.
    await db.execute(
      `INSERT INTO sale_return (id, kind, original_sale_id, location_id, total_minor) VALUES (?, 'RETURN', ?, NULL, ?)`,
      [r1.returnId, `srv-${K.k1}`, r1.totalMinor.toString()],
    );
    await db.execute(
      `INSERT INTO sale_return_line (id, return_id, line_no, original_sale_line_id, qty_sell) VALUES ('rl1', ?, 1, ?, 1)`,
      [r1.returnId, `srv-${K.k1}-l1`],
    );
    expect((await loadReturnableSale(db, K.k1))!.lines[0]!.remainingQty).toBe(0n);

    const payload = createSaleReturnInput.parse(JSON.parse(String((await db.getAll(`SELECT payload FROM outbox WHERE id = ?`, [r2.returnId]))[0]!['payload'])));
    expect(payload).toMatchObject({ kind: 'RETURN', originalSaleId: K.k1, lines: [{ originalLineNo: 1, qty: 2n, disposition: 'DAMAGED' }] });
    expect(payload.refund).toMatchObject({ onAccountClaimMinor: 0n, immediateClaimMinor: r2.totalMinor });
  });

  it('an on-account sale’s return is credited to the account, never paid out of the drawer', async () => {
    const { db, methods } = await device(1_000n);
    const till = (await readOpenTill(db))!;
    await syncedSale(db, { key: K.acct, tillId: 'tuesday', method: methods.account.id, tenderMinor: 19389n });
    const r = await recordReturn(db, {
      saleKey: K.acct, reason: 'x', hlc: fixedHlc(Date.now()), method: methods.cash,
      picks: [{ lineNo: 1, qty: 1n, disposition: 'RESTOCK' }],
    });
    expect(r.onAccountMinor).toBe(r.totalMinor);
    expect(r.cashOutMinor).toBe(0n);
    expect(await tillExpectedCash(db, till)).toBe(1_000n);
    // Positive control on the method rule: an account method is never the refund method.
    await expect(recordReturn(db, {
      saleKey: K.acct, reason: 'x', hlc: fixedHlc(Date.now()), method: methods.account,
      picks: [{ lineNo: 1, qty: 1n, disposition: 'RESTOCK' }],
    })).rejects.toThrow(/account credit is decided/);
  });

  it('a sale not yet synced cannot be returned in part — it can be voided', async () => {
    const { db, d } = await device();
    const sale = await ringOffline(db, d.priceListId);
    const s = (await loadReturnableSale(db, sale.saleId))!;
    expect(s.synced).toBe(false);
    expect(() => priceReturn(s, [{ lineNo: 1, qty: 1n, disposition: 'RESTOCK' }])).toThrow(/voided, not returned/);
  });

  it('prints a RETURN slip: negative lines and refund, the heading, and the receipt it reverses', async () => {
    const { db, methods } = await device();
    await syncedSale(db, { key: K.pr, tillId: 'tuesday', method: methods.cash.id, tenderMinor: 19389n, receiptNo: 'R-pr' });
    const before = (await loadReturnableSale(db, K.pr))!;
    const r = await recordReturn(db, {
      saleKey: K.pr, reason: 'x', hlc: fixedHlc(Date.now()), method: methods.cash,
      picks: [{ lineNo: 1, qty: 1n, disposition: 'RESTOCK' }],
    });
    const doc = await documentForReturn(db, {
      returnId: r.returnId, returnNo: r.returnNo, kind: 'RETURN', createdAt: new Date().toISOString(),
      businessDate: '2026-12-02', sale: before, priced: r.priced, method: { name: methods.cash.name }, reference: null,
    }, CURRENCY);
    expect(doc).toMatchObject({ kind: 'RETURN', saleId: r.returnId, originalReceiptNo: 'R-pr', totalMinor: -r.totalMinor });
    expect(doc.lines.every((l) => l.amountMinor < 0n)).toBe(true);
    expect(doc.tenders).toEqual([{ method: methods.cash.name, amountMinor: -r.totalMinor, reference: null }]);
    const text = layoutReceipt(doc, { columns: 32, page: CODE_PAGES.cp437 })
      .flatMap((l) => (l.kind === 'text' ? [l.text] : []))
      .join('\n');
    expect(text).toContain('RETURN');
    expect(text).toContain('Original receipt');
    expect(text).toContain('R-pr');
  });
});
