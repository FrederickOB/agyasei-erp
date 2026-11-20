/**
 * ReceiptDocument -> a list of already-fitted lines for a given column width.
 *
 * Pure and deterministic: the same document and options always produce the same
 * lines, which is what lets the ESC/POS encoder be pinned with golden bytes and
 * the on-screen / system-print views show exactly what the printer prints.
 *
 * Every string that leaves here has been through `toPrintable`, so the encoder
 * never has to decide what to do with a character the printer lacks. Money is
 * formatted HERE, once, from the DOCUMENT's own currency and scale — never from
 * the live pack (§8.3) — and the currency sign is shown only if the printer's
 * code page can actually print it; otherwise the pack's display code is used.
 */
import { format } from '@erp/money';
import { canEncode, toPrintable, type CodePage } from './codepage';
import { documentHeading, rateBpText, type ReceiptCurrency, type ReceiptDocument } from './document';

export type Align = 'left' | 'center' | 'right';

export type LayoutLine =
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly align: Align;
      readonly bold: boolean;
      /** Character width multiplier. A 2x line has half the columns. */
      readonly wide: 1 | 2;
      readonly tall: 1 | 2;
    }
  | { readonly kind: 'rule'; readonly char: string }
  | { readonly kind: 'qr'; readonly payload: string }
  | { readonly kind: 'blank' };

export interface LayoutOptions {
  readonly columns: number;
  readonly page: CodePage;
  /** Mark the output as a reprint. The tax lines and totals are untouched. */
  readonly isCopy?: boolean;
}

/** 58 mm paper is 32 columns of the standard font, 80 mm is 48. */
export const COLUMNS_FOR_PAPER_MM = { 58: 32, 80: 48 } as const;
export type PaperWidthMm = keyof typeof COLUMNS_FOR_PAPER_MM;

// ---------------------------------------------------------------------------
// Text helpers (exported: the encoder tests and the system-print view use them)
// ---------------------------------------------------------------------------

/** Word-wrap to `width` columns; a word longer than a line is hard-broken. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  let current = '';
  const flush = (): void => {
    lines.push(current);
    current = '';
  };
  for (const raw of text.split(/\s+/)) {
    let word = raw;
    if (word.length === 0) continue;
    while (word.length > w) {
      if (current.length > 0) flush();
      lines.push(word.slice(0, w));
      word = word.slice(w);
    }
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= w) current += ' ' + word;
    else {
      flush();
      current = word;
    }
  }
  if (current.length > 0 || lines.length === 0) flush();
  return lines;
}

/**
 * A two-column line: `left` flush left, `right` flush right, padded between.
 * If they cannot share a row, `left` wraps and `right` rides the last row when
 * it fits there, otherwise on a row of its own, right-aligned.
 */
export function pairLines(left: string, right: string, columns: number): string[] {
  if (right.length >= columns) return [...wrapText(left, columns), right.slice(-columns)];
  if (left.length + 1 + right.length <= columns) {
    return [left + ' '.repeat(columns - left.length - right.length) + right];
  }
  const rows = wrapText(left, columns - right.length - 1);
  const last = rows[rows.length - 1] ?? '';
  rows[rows.length - 1] = last + ' '.repeat(columns - last.length - right.length) + right;
  return rows;
}

/** The currency label the printer can honestly show: the pack's sign if encodable, else its code. */
export function currencyLabel(currency: ReceiptCurrency, page: CodePage): string {
  const symbolOk = currency.symbol.length > 0 && [...currency.symbol].every((c) => canEncode(page, c));
  return symbolOk ? currency.symbol : currency.code + ' ';
}

/** Plain amount at the DOCUMENT's scale. */
export function plainAmount(amountMinor: bigint, currency: ReceiptCurrency): string {
  return format(amountMinor, currency);
}

/** Amount with the currency label the printer can show. */
export function labelledAmount(amountMinor: bigint, currency: ReceiptCurrency, page: CodePage): string {
  const text = plainAmount(amountMinor, currency);
  const label = currencyLabel(currency, page);
  return text.startsWith('-') ? `-${label}${text.slice(1)}` : `${label}${text}`;
}

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

export function layoutReceipt(doc: ReceiptDocument, options: LayoutOptions): LayoutLine[] {
  const { columns, page } = options;
  const p = (s: string): string => toPrintable(page, s);
  const out: LayoutLine[] = [];
  const text = (
    s: string,
    o: { align?: Align; bold?: boolean; wide?: 1 | 2; tall?: 1 | 2 } = {},
  ): void => {
    const wide = o.wide ?? 1;
    for (const row of wrapText(p(s), Math.floor(columns / wide))) {
      out.push({ kind: 'text', text: row, align: o.align ?? 'left', bold: o.bold ?? false, wide, tall: o.tall ?? 1 });
    }
  };
  const pairs = (l: string, r: string, o: { bold?: boolean; tall?: 1 | 2 } = {}): void => {
    for (const row of pairLines(p(l), p(r), columns)) {
      out.push({ kind: 'text', text: row, align: 'left', bold: o.bold ?? false, wide: 1, tall: o.tall ?? 1 });
    }
  };
  const rule = (char = '-'): void => void out.push({ kind: 'rule', char });
  const money = (n: bigint): string => labelledAmount(n, doc.currency, page);
  const l = doc.labels;

  if (options.isCopy === true) {
    text(l.copy, { align: 'center', bold: true });
    rule('=');
  }

  // Header: whatever the tenant configured, nothing assumed.
  if (doc.businessName !== null) text(doc.businessName, { align: 'center', bold: true, wide: 2, tall: 2 });
  for (const h of doc.headerLines) text(h, { align: 'center' });
  if (doc.locationName !== null) text(doc.locationName, { align: 'center' });
  rule();

  // A reversing document says so first and loudest: nobody may read a refund
  // slip as a sale (migration 0030).
  const heading = documentHeading(doc);
  if (heading !== null) {
    text(heading, { align: 'center', bold: true, wide: 2, tall: 2 });
    rule('=');
  }

  // The number the customer will quote back: the biggest thing on the slip.
  text(`${l.receipt} ${doc.receiptNo}`, {
    align: 'center',
    bold: true,
    wide: doc.receiptNo.length + l.receipt.length + 1 <= Math.floor(columns / 2) ? 2 : 1,
  });
  pairs(l.date, doc.issuedAtText);
  if (doc.originalReceiptNo !== undefined && doc.originalReceiptNo !== null) {
    pairs(l.originalReceipt ?? 'Original receipt', doc.originalReceiptNo);
  }
  if (doc.customerName !== null) pairs(l.customer, doc.customerName);
  rule();

  for (const item of doc.lines) {
    text(item.name, { bold: true });
    const unit = plainAmount(item.unitPriceMinor, doc.currency);
    const qty = item.uomLabel.length > 0 ? `${item.qtyText} ${item.uomLabel}` : item.qtyText;
    pairs(`  ${qty} x ${unit}`, plainAmount(item.amountMinor, doc.currency));
  }
  rule();

  if (doc.taxLines.length > 0) {
    if (!doc.pricesIncludeTax && doc.netMinor !== null) pairs(l.subtotal, money(doc.netMinor));
    if (doc.pricesIncludeTax) text(`${l.includesTax}:`);
    for (const t of doc.taxLines) {
      const rate = t.rateBp === null ? '' : ` ${rateBpText(t.rateBp)}`;
      pairs(`${t.name}${rate}`, money(t.taxMinor));
    }
  }
  pairs(l.total, money(doc.totalMinor), { bold: true, tall: 2 });

  for (const t of doc.tenders) {
    pairs(t.method, money(t.amountMinor));
    if (t.reference !== null && t.reference.length > 0) text(`  ${l.reference}: ${t.reference}`);
  }
  if (doc.changeMinor > 0n) pairs(l.change, money(doc.changeMinor), { bold: true });

  // The jurisdiction pack's statutory slot (Q8). Empty until the pack fills it.
  if (doc.pack.fields.length > 0) {
    rule();
    for (const f of doc.pack.fields) pairs(f.label, f.value);
  }
  if (doc.pack.qr !== null) {
    out.push({ kind: 'blank' });
    out.push({ kind: 'qr', payload: doc.pack.qr.payload });
  }

  if (doc.footerLines.length > 0) {
    rule();
    for (const f of doc.footerLines) text(f, { align: 'center' });
  }
  return out;
}
