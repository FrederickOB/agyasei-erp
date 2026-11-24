/**
 * The product-list import contract (migration 0032; apps/api/src/routers/products.ts).
 *
 * A person downloads a template, fills it in a spreadsheet, and uploads it as
 * CSV or Excel. The screen turns an Excel file into CSV text in the browser,
 * so the server only ever reads ONE format — this one — through the SAME pure
 * parser the screen uses to show the file's shape before upload.
 *
 * ROW BY ROW, NOT ALL OR NOTHING. Opening stock (0031) refuses a whole file
 * for one bad row, because a half-loaded opening balance is a position nobody
 * can reason about. A product list is the opposite case: a duplicate on line
 * 40 says nothing about line 41. So every row gets its own verdict, the good
 * rows are created, and the refused rows go back to the person with a reason
 * each, ready to fix and upload again.
 *
 * THE COLUMNS. Headers are matched by meaning, not by exact spelling, because
 * they are typed by people: "Product name *", "product_name" and "Name" are
 * the same column. Required: product name, category, unit, and at least one
 * selling price. A price column names the tenant's OWN price list ("Price:
 * Counter retail", "Wholesale price"); which lists exist is the server's to
 * resolve — this file never names one (CLAUDE.md §2.9). A bare "Price" column
 * is the tenant's first-priority list.
 *
 * MONEY IS TEXT HERE. Costs and prices stay decimal strings until the server
 * parses them exactly, at the scale the tenant's jurisdiction pack gives its
 * currency (ADR-0004; CLAUDE.md §2.3). Nothing in this file turns one into a
 * number.
 */
import { z } from 'zod';
import { mutationEnvelope } from './wire.js';

export const PRODUCT_IMPORT_MAX_ROWS = 5_000;
export const PRODUCT_IMPORT_MAX_CHARS = 3_000_000;
export const PRODUCT_NAME_MAX = 120;
export const PRODUCT_CODE_MAX = 40;
export const PRODUCT_TEXT_MAX = 500;

/** Why a row cannot be created. Platform vocabulary; the screen words each one. */
export const PRODUCT_ROW_ISSUES = [
  // Found from the row alone.
  'MISSING_NAME',
  'MISSING_CATEGORY',
  'MISSING_UNIT',
  'NAME_TOO_LONG',
  'BAD_CODE',
  'TEXT_TOO_LONG',
  'BAD_COST',
  'BAD_PRICE',
  'NO_PRICE',
  'DUPLICATE_IN_FILE',
  // Found against the tenant's own catalogue.
  'DUPLICATE_CODE',
  'DUPLICATE_NAME',
  'UNKNOWN_UNIT',
  'UNKNOWN_TAX_CODE',
  'NO_TAX_CODE',
  'COST_TOO_PRECISE',
  'PRICE_TOO_PRECISE',
  'PRICE_NOT_PERMITTED',
  'SUPPLIER_NOT_PERMITTED',
] as const;
export type ProductRowIssue = (typeof PRODUCT_ROW_ISSUES)[number];

/** The import's own column keys. Product chrome, never tenant vocabulary. */
export type ProductColumn = 'name' | 'code' | 'category' | 'unit' | 'supplier' | 'cost' | 'tax' | 'notes';

/** Header spellings people actually type, normalised (see `normaliseHeader`). */
const ALIASES: Readonly<Record<ProductColumn, readonly string[]>> = {
  name: ['product name', 'name', 'product', 'item', 'item name', 'product description'],
  code: ['product code', 'code', 'sku', 'sku code', 'item code'],
  category: ['category', 'product category', 'department', 'group'],
  unit: ['unit', 'unit of measure', 'uom', 'selling unit', 'unit of sale'],
  supplier: ['supplier', 'supplier name', 'vendor'],
  cost: ['cost price', 'cost', 'unit cost', 'buying price', 'purchase price', 'cost per unit'],
  tax: ['tax', 'tax code', 'vat', 'tax rate'],
  notes: ['notes', 'note', 'description', 'remarks'],
};
/** A price column that names no list means the tenant's first-priority list. */
const BARE_PRICE = ['price', 'selling price', 'sale price', 'unit price', 'sales price'];
const REQUIRED: readonly ProductColumn[] = ['name', 'category', 'unit'];

/**
 * "Product name *", "product_name", " Cost price (per unit) " → "product name",
 * "product name", "cost price". Lower case, no required-marker, no hint in
 * brackets, underscores and runs of space collapsed.
 */
export function normaliseHeader(header: string): string {
  return header
    .replace(/^﻿/, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\*/g, ' ')
    .replace(/[_\s]+/g, ' ')
    .trim();
}

/** The comparison key for "is this the same product?" — case and spacing never make two. */
export function productNameKey(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
}

/**
 * RFC 4180 CSV, including quoted fields that hold commas, doubled quotes and
 * line breaks (a "Notes" cell from Excel often has one). The delimiter is
 * read off the header line: comma, or semicolon / tab where a spreadsheet's
 * locale saved it that way.
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const delimiter = detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field.trim() === '') {
      field = '';
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((f) => f.trim()));
}

function detectDelimiter(src: string): string {
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const count = (d: string): number => firstLine.split(d).length - 1;
  const commas = count(',');
  if (commas > 0) return ',';
  if (count(';') > 0) return ';';
  if (count('\t') > 0) return '\t';
  return ',';
}

/** One CSV line from fields, quoting only where a field needs it. */
export function toCsvLine(fields: readonly string[]): string {
  return fields
    .map((f) => (/[",\r\n;\t]/.test(f) || /^\s|\s$/.test(f) ? `"${f.replace(/"/g, '""')}"` : f))
    .join(',');
}

/** A whole CSV document, CRLF-terminated as spreadsheets expect. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map(toCsvLine).join('\r\n') + '\r\n';
}

const DECIMAL_RE = /^\d+(\.\d+)?$/;
const GROUPED_RE = /^\d{1,3}(,\d{3})+(\.\d+)?$/;

/**
 * A money cell as plain decimal text, or null when it is not one. Thousands
 * separators ("1,250.50") are accepted and removed — that is how people type
 * money — and nothing else is: a currency sign, a minus or a second point is
 * a typo, and guessing at it would put a wrong price on the counter.
 */
export function decimalCell(text: string): string | null {
  const t = text.replace(/\s+/g, '');
  if (DECIMAL_RE.test(t)) return t;
  if (GROUPED_RE.test(t)) return t.replace(/,/g, '');
  return null;
}

/** A price column, by the list it names (empty = the tenant's first-priority list). */
export interface PriceColumn {
  /** The header exactly as the file gave it — what the person sees. */
  readonly header: string;
  /** The words that name a price list, normalised; '' for a bare "Price". */
  readonly listKey: string;
}

/** Which import column a header is, if any. */
export function classifyHeader(raw: string): { column: ProductColumn } | { price: PriceColumn } | null {
  const h = normaliseHeader(raw);
  if (h === '') return null;
  for (const [column, names] of Object.entries(ALIASES) as [ProductColumn, readonly string[]][]) {
    if (names.includes(h)) return { column };
  }
  if (BARE_PRICE.includes(h)) return { price: { header: raw.trim(), listKey: '' } };
  // "price: counter retail", "price - wholesale", "price wholesale"
  const lead = /^(?:selling )?price\s*[:\-–—]?\s*(.+)$/.exec(h);
  if (lead) return { price: { header: raw.trim(), listKey: lead[1]!.trim() } };
  // "wholesale price", "counter retail selling price"
  const trail = /^(.+?)\s+(?:selling |sale |sales |unit )?price$/.exec(h);
  if (trail) return { price: { header: raw.trim(), listKey: trail[1]!.trim() } };
  return null;
}

export interface ParsedProductRow {
  /** 1-based line in the file, header included — what a person finds in a spreadsheet. */
  readonly lineNo: number;
  readonly name: string;
  readonly code: string;
  readonly category: string;
  readonly unit: string;
  readonly supplier: string;
  /** Plain decimal text, or '' when the cell is empty. Exactness is the server's. */
  readonly costText: string;
  readonly tax: string;
  readonly notes: string;
  /** One entry per price column that has a value, in column order. */
  readonly prices: readonly { readonly column: number; readonly text: string }[];
  /** Shape problems found without any lookup. */
  readonly issues: readonly ProductRowIssue[];
  /** The cells as the file gave them — handed back on a refused row. */
  readonly raw: readonly string[];
}

export interface ParsedProductFile {
  /** Non-null when the file cannot be read as a product list at all. */
  readonly fileError: string | null;
  /** The header row as given. */
  readonly headers: readonly string[];
  readonly priceColumns: readonly PriceColumn[];
  /** Headers that are not an import column — reported, never silently used. */
  readonly ignoredColumns: readonly string[];
  readonly rows: readonly ParsedProductRow[];
}

const EMPTY_FILE = (fileError: string): ParsedProductFile => ({
  fileError,
  headers: [],
  priceColumns: [],
  ignoredColumns: [],
  rows: [],
});

export function parseProductCsv(csv: string): ParsedProductFile {
  const table = parseCsv(csv);
  const headerAt = table.findIndex((r) => r.some((c) => c !== ''));
  if (headerAt < 0) return EMPTY_FILE('The file is empty.');
  const headers = table[headerAt]!;

  const at = new Map<ProductColumn, number>();
  const priceAt: { index: number; column: PriceColumn }[] = [];
  const ignored: string[] = [];
  headers.forEach((raw, index) => {
    const c = classifyHeader(raw);
    if (c === null) {
      if (raw.trim() !== '') ignored.push(raw.trim());
    } else if ('column' in c) {
      if (!at.has(c.column)) at.set(c.column, index);
      else ignored.push(raw.trim());
    } else {
      priceAt.push({ index, column: c.price });
    }
  });

  const missing = REQUIRED.filter((c) => !at.has(c));
  if (missing.length > 0) {
    const words: Record<ProductColumn, string> = {
      name: 'Product name', code: 'Product code', category: 'Category', unit: 'Unit',
      supplier: 'Supplier', cost: 'Cost price', tax: 'Tax', notes: 'Notes',
    };
    return EMPTY_FILE(
      `The first row must name the columns. Missing: ${missing.map((m) => words[m]).join(', ')}. ` +
        'Download the template to see them.',
    );
  }
  if (priceAt.length === 0) {
    return EMPTY_FILE('The file has no selling price column. Add one — e.g. “Price” — or download the template.');
  }

  const cell = (fields: readonly string[], column: ProductColumn): string => {
    const i = at.get(column);
    return i === undefined ? '' : (fields[i] ?? '').trim();
  };

  const rows: ParsedProductRow[] = [];
  const seenNames = new Set<string>();
  const seenCodes = new Set<string>();
  for (let i = headerAt + 1; i < table.length; i += 1) {
    const fields = table[i]!;
    if (fields.every((f) => f === '')) continue;
    const name = cell(fields, 'name').replace(/\s+/g, ' ');
    const code = cell(fields, 'code');
    const category = cell(fields, 'category').replace(/\s+/g, ' ');
    const unit = cell(fields, 'unit');
    const supplier = cell(fields, 'supplier').replace(/\s+/g, ' ');
    const costRaw = cell(fields, 'cost');
    const tax = cell(fields, 'tax');
    const notes = cell(fields, 'notes');
    const issues: ProductRowIssue[] = [];

    if (name === '') issues.push('MISSING_NAME');
    else if (name.length > PRODUCT_NAME_MAX) issues.push('NAME_TOO_LONG');
    if (category === '') issues.push('MISSING_CATEGORY');
    if (unit === '') issues.push('MISSING_UNIT');
    if (code.length > PRODUCT_CODE_MAX || /[\u0000-\u001f]/.test(code)) issues.push('BAD_CODE');
    if ([category, supplier, notes, unit, tax].some((t) => t.length > PRODUCT_TEXT_MAX)) issues.push('TEXT_TOO_LONG');

    let costText = '';
    if (costRaw !== '') {
      const d = decimalCell(costRaw);
      if (d === null) issues.push('BAD_COST');
      else costText = d;
    }
    const prices: { column: number; text: string }[] = [];
    let badPrice = false;
    priceAt.forEach(({ index }, column) => {
      const raw = (fields[index] ?? '').trim();
      if (raw === '') return;
      const d = decimalCell(raw);
      if (d === null) badPrice = true;
      else prices.push({ column, text: d });
    });
    if (badPrice) issues.push('BAD_PRICE');
    else if (prices.length === 0) issues.push('NO_PRICE');

    const nameKey = productNameKey(name);
    const codeKey = code.toUpperCase();
    if ((name !== '' && seenNames.has(nameKey)) || (code !== '' && seenCodes.has(codeKey))) {
      issues.push('DUPLICATE_IN_FILE');
    }
    if (name !== '') seenNames.add(nameKey);
    if (code !== '') seenCodes.add(codeKey);

    rows.push({
      lineNo: i + 1,
      name,
      code,
      category,
      unit,
      supplier,
      costText,
      tax,
      notes,
      prices,
      issues,
      raw: fields,
    });
    if (rows.length > PRODUCT_IMPORT_MAX_ROWS) {
      return EMPTY_FILE(`A file holds at most ${PRODUCT_IMPORT_MAX_ROWS} products; split it into smaller files.`);
    }
  }
  if (rows.length === 0) return EMPTY_FILE('The file has a header row and no products under it.');
  return {
    fileError: null,
    headers,
    priceColumns: priceAt.map((p) => p.column),
    ignoredColumns: ignored,
    rows,
  };
}

/**
 * The canonical text an import's content hash is taken over: the parsed
 * rows, order-independent, so a re-saved file with its rows sorted
 * differently is recognised as the same list.
 */
export function canonicalProductRows(file: ParsedProductFile): string {
  return file.rows
    .map((r) =>
      [
        productNameKey(r.name), r.code, r.category, r.unit, r.supplier, r.costText, r.tax, r.notes,
        ...r.prices.map((p) => `${file.priceColumns[p.column]?.listKey ?? ''}=${p.text}`),
      ].join('\t'),
    )
    .sort()
    .join('\n');
}

/**
 * The template's header row for a tenant whose price lists have these names,
 * in the order a person fills a row. Required columns carry a `*`, which the
 * parser ignores.
 */
export function productTemplateHeaders(priceListNames: readonly string[]): string[] {
  return [
    'Product name *',
    'Category *',
    'Unit *',
    ...(priceListNames.length === 0 ? ['Price *'] : priceListNames.map((n, i) => `Price: ${n}${i === 0 ? ' *' : ''}`)),
    'Cost price',
    'Supplier',
    'Product code',
    'Tax',
    'Notes',
  ];
}

const fileFields = {
  csv: z.string().min(1).max(PRODUCT_IMPORT_MAX_CHARS),
  fileName: z.string().trim().min(1).max(200).optional(),
};

export const previewProductImportInput = z.object(fileFields).strict();
export const commitProductImportInput = z.object({ ...mutationEnvelope, ...fileFields }).strict();
/**
 * Archive every product in the catalogue. `expectedCount` is the number the
 * person was shown and confirmed: if the catalogue changed since, the server
 * refuses rather than archive something nobody looked at.
 */
export const removeAllProductsInput = z
  .object({ ...mutationEnvelope, expectedCount: z.number().int().min(1).max(1_000_000) })
  .strict();

export type PreviewProductImportInput = z.input<typeof previewProductImportInput>;
export type CommitProductImportInput = z.input<typeof commitProductImportInput>;
export type RemoveAllProductsInput = z.input<typeof removeAllProductsInput>;
