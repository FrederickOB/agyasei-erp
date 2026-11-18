/**
 * Where a ReceiptDocument's facts come from — every one of them LOCAL, so a
 * receipt is never waiting on a socket.
 *
 * Two sources, because a sale has two lives on a device:
 *
 *  1. JUST RUNG, NOT YET SYNCED. The only local record is the `outbox` row (what
 *     was sold, the receipt number, the total, the tender). The server has not
 *     priced it, so there are no `sale_line` / `sale_tax_line` rows yet, and the
 *     cart that held the product names was deleted by checkout. The document is
 *     therefore built from the committed outbox facts PLUS the priced cart the
 *     counter was looking at (`documentForCommittedSale`). The total always
 *     comes from the committed row, never from the screen: if the priced cart
 *     disagrees with it the tax split is dropped rather than shown wrong.
 *
 *  2. SYNCED. The server's own `sale`, `sale_line`, `sale_tax_line` rows stream
 *     back. A reprint then renders from THOSE (`documentFromSyncedSale`), with
 *     the sale's snapshotted `currency_code`/`money_scale` and the tax rate rows
 *     the sale was actually taxed with — never today's rates (ADR-0002) and
 *     never the live pack's scale (§8.3).
 *
 * The tenders array is produced by exactly one function
 * (`tendersFromLegacySale` in document.ts) so the move to tenant-defined tender
 * lines touches one place.
 */
import type { CurrencySpec } from '@erp/money';
import type { DbExecutor, LocalDb } from '../data/db';
import { readDeviceLocation } from '../data/queries/session';
import { lineTotalMinor, type CartPricing, type CartPricingBasis } from '../data/pricing/cart-pricing';
import type { CartLineRow } from '../data/queries/cart';
import {
  buildReceiptDocument,
  tendersFromLegacySale,
  UNCONFIGURED_PACK_SLOT,
  type ReceiptDocument,
  type ReceiptLabels,
  type ReceiptLineInput,
  type ReceiptPackSlot,
  type ReceiptTaxLine,
} from './document';

export const CONFIG_KEY_RECEIPT_BRANDING = 'receipt_branding';
export const CONFIG_KEY_RECEIPT_PACK_SLOT = 'receipt_pack_slot';

// ---------------------------------------------------------------------------
// Tenant branding and the pack slot — configuration, never constants (§8.9)
// ---------------------------------------------------------------------------

export interface ReceiptContext {
  readonly businessName: string | null;
  readonly headerLines: readonly string[];
  readonly footerLines: readonly string[];
  readonly labels: Partial<ReceiptLabels>;
  readonly pack: ReceiptPackSlot;
  readonly locationName: string | null;
  readonly timeZone: string | null;
}

async function readConfigJson(db: DbExecutor, key: string): Promise<Record<string, unknown> | null> {
  try {
    const rows = await db.getAll('SELECT value FROM local_config WHERE key = ? LIMIT 1', [key]);
    const value = rows[0]?.['value'];
    if (typeof value !== 'string') return null;
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Read branding and the pack's statutory slot from this device's configuration.
 *
 * GAP, stated: nothing syncs these two records to a device yet. The keys are the
 * seam; when tenant branding and the pack's receipt requirements (Q8) have a
 * synced home, this is the only reader to re-point. Until then a device with no
 * record prints a receipt with no header and an UNCONFIGURED pack slot — which
 * is the honest state, not a guess at what the authority requires.
 */
export async function readReceiptContext(db: DbExecutor): Promise<ReceiptContext> {
  const branding = await readConfigJson(db, CONFIG_KEY_RECEIPT_BRANDING);
  const packRaw = await readConfigJson(db, CONFIG_KEY_RECEIPT_PACK_SLOT);
  const location = await readDeviceLocation(db);
  let locationName: string | null = null;
  if (location !== null) {
    const rows = await db.getAll('SELECT name FROM location WHERE id = ? LIMIT 1', [location.id]);
    const n = rows[0]?.['name'];
    locationName = typeof n === 'string' && n.length > 0 ? n : null;
  }
  const labels: Partial<ReceiptLabels> = {};
  const rawLabels = branding?.['labels'];
  if (typeof rawLabels === 'object' && rawLabels !== null) {
    for (const [k, v] of Object.entries(rawLabels)) {
      if (typeof v === 'string') (labels as Record<string, string>)[k] = v;
    }
  }
  let pack: ReceiptPackSlot = UNCONFIGURED_PACK_SLOT;
  if (packRaw !== null) {
    const fields = Array.isArray(packRaw['fields'])
      ? (packRaw['fields'] as unknown[]).flatMap((f) =>
          typeof f === 'object' && f !== null && typeof (f as { label?: unknown }).label === 'string' && typeof (f as { value?: unknown }).value === 'string'
            ? [{ label: (f as { label: string }).label, value: (f as { value: string }).value }]
            : [],
        )
      : [];
    const qrPayload = (packRaw['qr'] as { payload?: unknown } | null | undefined)?.payload;
    pack = {
      slot: 'configured',
      fields,
      qr: typeof qrPayload === 'string' && qrPayload.length > 0 ? { payload: qrPayload } : null,
    };
  }
  const businessName = branding?.['businessName'];
  return {
    businessName: typeof businessName === 'string' && businessName.length > 0 ? businessName : null,
    headerLines: strings(branding?.['headerLines']),
    footerLines: strings(branding?.['footerLines']),
    labels,
    pack,
    locationName,
    timeZone: location?.timeZone ?? null,
  };
}

async function taxNames(db: DbExecutor): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    for (const r of await db.getAll('SELECT code, name FROM tax_code')) {
      if (typeof r['code'] === 'string' && typeof r['name'] === 'string') out.set(r['code'], r['name']);
    }
  } catch {
    // names are a nicety; the code is shown instead
  }
  return out;
}

// ---------------------------------------------------------------------------
// The committed facts of a just-rung sale (outbox)
// ---------------------------------------------------------------------------

export interface CommittedSaleFacts {
  readonly saleId: string;
  readonly receiptNo: string;
  readonly createdAt: string;
  readonly totalMinor: bigint;
  readonly tenderedMinor: bigint | null;
  readonly changeMinor: bigint | null;
  readonly tender: 'CASH' | 'CREDIT';
  readonly customerId: string | null;
  readonly businessDate: string;
}

/** The outbox row for this sale, or null if no such sale has been committed on this device. */
export async function readCommittedSale(db: DbExecutor, saleId: string): Promise<CommittedSaleFacts | null> {
  const rows = await db.getAll(
    `SELECT id, receipt_no, created_at, payload,
            CAST(total_minor AS TEXT) AS total_minor,
            CAST(tendered_minor AS TEXT) AS tendered_minor,
            CAST(change_minor AS TEXT) AS change_minor
       FROM outbox WHERE kind = 'sale' AND id = ? LIMIT 1`,
    [saleId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(String(row['payload'])) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const opt = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(String(v)));
  return {
    saleId,
    receiptNo: row['receipt_no'] === null ? saleId.slice(-6).toUpperCase() : String(row['receipt_no']),
    createdAt: String(row['created_at']),
    totalMinor: BigInt(String(row['total_minor'])),
    tenderedMinor: opt(row['tendered_minor']),
    changeMinor: opt(row['change_minor']),
    tender: payload['tender'] === 'CREDIT' ? 'CREDIT' : 'CASH',
    customerId: typeof payload['customerId'] === 'string' ? payload['customerId'] : null,
    businessDate: typeof payload['businessDate'] === 'string' ? payload['businessDate'] : row['created_at'] === null ? '' : String(row['created_at']).slice(0, 10),
  };
}

async function customerName(db: DbExecutor, id: string | null): Promise<string | null> {
  if (id === null) return null;
  const rows = await db.getAll('SELECT name FROM customer WHERE id = ? LIMIT 1', [id]);
  const n = rows[0]?.['name'];
  return typeof n === 'string' && n.length > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Source 1: a committed, not-yet-synced sale + the priced cart it was rung from
// ---------------------------------------------------------------------------

export interface PricedCartForReceipt {
  readonly lines: readonly CartLineRow[];
  readonly pricing: CartPricing;
  readonly basis: CartPricingBasis;
}

export async function documentForCommittedSale(
  db: DbExecutor,
  facts: CommittedSaleFacts,
  cart: PricedCartForReceipt,
  currency: CurrencySpec,
): Promise<ReceiptDocument> {
  const ctx = await readReceiptContext(db);
  const names = await taxNames(db);

  // The committed total is the truth. If what the counter was showing does not
  // add up to it (the price list moved between render and commit, say), the
  // line detail is still real but the tax split is not provably this sale's, so
  // it is left off rather than printed wrong.
  const agrees = cart.pricing.grossMinor === facts.totalMinor && cart.pricing.breakdown !== null;
  const breakdown = agrees ? cart.pricing.breakdown : null;
  const rateByCode = new Map(cart.basis.components.map((c) => [c.code, c.rateBp] as const));
  const taxLines: ReceiptTaxLine[] =
    breakdown === null
      ? []
      : breakdown.taxes.map((t) => ({
          code: t.code,
          name: names.get(t.code) ?? t.code,
          rateBp: rateByCode.get(t.code) ?? null,
          baseMinor: t.baseMinor,
          taxMinor: t.taxMinor,
        }));
  const lines: ReceiptLineInput[] = cart.lines.map((l) => ({
    name: l.name,
    qtyScaled: l.qtyScaled,
    qtyScale: l.qtyScale,
    uomLabel: l.uomLabel,
    unitPriceE4: l.unitPriceE4,
    amountMinor: lineTotalMinor(l),
  }));
  const tenders = tendersFromLegacySale({
    tender: facts.tender,
    totalMinor: facts.totalMinor,
    tenderedMinor: facts.tenderedMinor,
    changeMinor: facts.changeMinor,
  });
  return buildReceiptDocument({
    saleId: facts.saleId,
    receiptNo: facts.receiptNo,
    issuedAtIso: facts.createdAt,
    timeZone: ctx.timeZone,
    businessDate: facts.businessDate,
    currency,
    businessName: ctx.businessName,
    headerLines: ctx.headerLines,
    locationName: ctx.locationName,
    customerName: await customerName(db, facts.customerId),
    pricesIncludeTax: cart.basis.isTaxInclusive,
    lines,
    netMinor: breakdown === null ? null : breakdown.netMinor,
    taxLines,
    totalMinor: facts.totalMinor,
    tenders: tenders.tenders,
    changeMinor: tenders.changeMinor,
    pack: ctx.pack,
    footerLines: ctx.footerLines,
    labels: ctx.labels,
  });
}

// ---------------------------------------------------------------------------
// Source 2: the server's own rows, once they have streamed back
// ---------------------------------------------------------------------------

function big(v: unknown): bigint {
  return BigInt(String(v ?? 0));
}

function scaleDigits(v: unknown): 0 | 1 | 2 | 3 | 4 | null {
  const n = Number(v);
  return n === 0 || n === 1 || n === 2 || n === 3 || n === 4 ? n : null;
}

/**
 * Render from the synced `sale`, `sale_line`, `sale_tax_line` rows. Returns null
 * when they have not arrived (or the sale is unknown), so the caller can say so
 * instead of printing a partial receipt.
 *
 * The sale is found by its device-allocated receipt number (unique per
 * location), which is the one key the outbox row and the server row share.
 */
export async function documentFromSyncedSale(db: LocalDb, saleId: string): Promise<ReceiptDocument | null> {
  const facts = await readCommittedSale(db, saleId);
  if (facts === null) return null;
  const sales = await db.getAll(
    `SELECT id, price_list_id, business_date, occurred_at, currency_code, money_scale,
            CAST(subtotal_net_minor AS TEXT) AS net, CAST(tax_total_minor AS TEXT) AS tax,
            CAST(total_minor AS TEXT) AS total, customer_id
       FROM sale WHERE receipt_no = ? LIMIT 1`,
    [facts.receiptNo],
  );
  const sale = sales[0];
  if (sale === undefined) return null;
  const scale = scaleDigits(sale['money_scale']);
  if (scale === null || typeof sale['currency_code'] !== 'string') return null;

  const lineRows = await db.getAll(
    `SELECT sl.line_no, p.name AS product_name, COALESCE(u.name, u.code) AS uom_label,
            CAST(sl.qty_sell AS TEXT) AS qty, sl.qty_sell_scale AS qty_scale,
            CAST(sl.unit_price_e4 AS TEXT) AS unit_e4,
            CAST(sl.line_net_minor AS TEXT) AS net, CAST(sl.tax_minor AS TEXT) AS tax
       FROM sale_line sl
       LEFT JOIN product p ON p.id = sl.product_id
       LEFT JOIN unit_of_measure u ON u.id = sl.selling_uom_id
      WHERE sl.sale_id = ? ORDER BY sl.line_no ASC`,
    [String(sale['id'])],
  );
  if (lineRows.length === 0) return null;

  const listRows = await db.getAll('SELECT is_tax_inclusive FROM price_list WHERE id = ? LIMIT 1', [
    String(sale['price_list_id'] ?? ''),
  ]);
  const inclusive = Number(listRows[0]?.['is_tax_inclusive'] ?? 0) === 1;

  const lines: ReceiptLineInput[] = lineRows.map((r) => ({
    name: typeof r['product_name'] === 'string' ? r['product_name'] : 'Item',
    qtyScaled: big(r['qty']),
    qtyScale: Number(r['qty_scale'] ?? 0),
    uomLabel: typeof r['uom_label'] === 'string' ? r['uom_label'] : '',
    unitPriceE4: big(r['unit_e4']),
    // On a tax-inclusive list the printed line is the gross the customer saw.
    amountMinor: inclusive ? big(r['net']) + big(r['tax']) : big(r['net']),
  }));

  const taxRows = await db.getAll(
    `SELECT tax_code, rate_bp, CAST(base_minor AS TEXT) AS base, CAST(tax_minor AS TEXT) AS tax
       FROM sale_tax_line WHERE sale_id = ? ORDER BY seq ASC`,
    [String(sale['id'])],
  );
  const names = await taxNames(db);
  const merged = new Map<string, ReceiptTaxLine>();
  for (const r of taxRows) {
    const code = String(r['tax_code']);
    const prev = merged.get(code);
    merged.set(code, {
      code,
      name: names.get(code) ?? code,
      // The rate the SALE was taxed with, from the sale's own row.
      rateBp: r['rate_bp'] === null ? null : big(r['rate_bp']),
      baseMinor: (prev?.baseMinor ?? 0n) + big(r['base']),
      taxMinor: (prev?.taxMinor ?? 0n) + big(r['tax']),
    });
  }

  // Symbol is presentation only: take the pack's sign for THIS sale's currency
  // code if the device has it, else the code stands in for it.
  const jur = await db.getAll('SELECT currency_symbol FROM jurisdiction WHERE currency_code = ? LIMIT 1', [
    String(sale['currency_code']),
  ]);
  const symbol = typeof jur[0]?.['currency_symbol'] === 'string' ? jur[0]['currency_symbol'] : String(sale['currency_code']);
  const ctx = await readReceiptContext(db);
  const tenders = tendersFromLegacySale({
    tender: facts.tender,
    totalMinor: big(sale['total']),
    tenderedMinor: facts.tenderedMinor,
    changeMinor: facts.changeMinor,
  });
  return buildReceiptDocument({
    saleId,
    receiptNo: facts.receiptNo,
    issuedAtIso: typeof sale['occurred_at'] === 'string' ? sale['occurred_at'] : facts.createdAt,
    timeZone: ctx.timeZone,
    businessDate: typeof sale['business_date'] === 'string' ? sale['business_date'] : facts.businessDate,
    currency: { code: String(sale['currency_code']), symbol, scale },
    businessName: ctx.businessName,
    headerLines: ctx.headerLines,
    locationName: ctx.locationName,
    customerName: await customerName(db, typeof sale['customer_id'] === 'string' ? sale['customer_id'] : facts.customerId),
    pricesIncludeTax: inclusive,
    lines,
    netMinor: taxRows.length === 0 ? null : big(sale['net']),
    taxLines: [...merged.values()],
    totalMinor: big(sale['total']),
    tenders: tenders.tenders,
    changeMinor: tenders.changeMinor,
    pack: ctx.pack,
    footerLines: ctx.footerLines,
    labels: ctx.labels,
  });
}
