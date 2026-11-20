/**
 * The opening-stock import contract (migration 0031; open-questions Q20).
 *
 * HQ uploads ONE CSV — a laptop job, online only — previews every row's
 * verdict, then commits the whole file as `OPENING` stock movements in one
 * idempotent import. Nothing here posts to the general ledger; the GL opening
 * balance is the accountant's (phase2-gate §4.3 (d)).
 *
 * THE FILE, stated once:
 *
 *   sku_code,location_code,quantity[,unit_cost_minor]
 *
 *   · `quantity` is a plain decimal in the product's STOCKING unit, e.g.
 *     `40` bags or `2.5` tonnes. It is parsed EXACTLY into a scaled integer at
 *     that unit's own scale (04 §4.4.3) — never through a float — and a value
 *     with more decimal places than the unit carries is refused, not rounded:
 *     "2.5005 t" against a scale of 3 is a typo or a unit mix-up, and a
 *     silently rounded opening balance is wrong forever.
 *   · `unit_cost_minor` (optional) is an integer in the currency's minor unit
 *     per stocking unit, kept on the movement for the costing decision Q16
 *     will make. Stored, not used.
 *
 * The parser below is PURE and browser-safe: the screen runs it to show a
 * file's shape before upload, and the server runs the SAME function before it
 * resolves a single code. Resolution (does this SKU exist here?) is the
 * server's alone.
 */
import { z } from 'zod';
import { mutationEnvelope, zBusinessDate } from './wire.js';

export const OPENING_STOCK_MAX_ROWS = 10_000;
export const OPENING_STOCK_MAX_CHARS = 1_000_000;

/** Why a row cannot be loaded. Platform vocabulary; the screen words each one. */
export const OPENING_ROW_ISSUES = [
  'MISSING_FIELD',
  'UNKNOWN_SKU',
  'UNKNOWN_LOCATION',
  'NOT_A_STOCK_LOCATION',
  'NOT_STOCKED',
  'BAD_QUANTITY',
  'BAD_QUANTITY_SCALE',
  'BAD_UNIT_COST',
  'DUPLICATE_ROW',
  'ALREADY_OPENED',
  'NOT_PERMITTED',
] as const;
export type OpeningRowIssue = (typeof OPENING_ROW_ISSUES)[number];

const fileFields = {
  csv: z.string().min(1).max(OPENING_STOCK_MAX_CHARS),
  fileName: z.string().trim().min(1).max(200).optional(),
  /** The cut-over date: every movement's business date. */
  asOfDate: zBusinessDate,
};

export const previewOpeningStockInput = z.object(fileFields).strict();
export const commitOpeningStockInput = z.object({ ...mutationEnvelope, ...fileFields }).strict();

export type PreviewOpeningStockInput = z.input<typeof previewOpeningStockInput>;
export type CommitOpeningStockInput = z.input<typeof commitOpeningStockInput>;

export interface ParsedOpeningRow {
  /** 1-based line number in the file, header included — what a person finds in a spreadsheet. */
  readonly lineNo: number;
  readonly skuCode: string;
  readonly locationCode: string;
  readonly quantityText: string;
  readonly unitCostText: string | null;
  /** Shape problems found without any lookup. */
  readonly issues: readonly OpeningRowIssue[];
}

export interface ParsedOpeningFile {
  /** Non-null when the file cannot be read as this format at all. */
  readonly fileError: string | null;
  readonly rows: readonly ParsedOpeningRow[];
}

/** Split one CSV line, honouring double quotes ("a,b" and "" escapes). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

const REQUIRED = ['sku_code', 'location_code', 'quantity'] as const;
const DECIMAL_RE = /^\d+(\.\d+)?$/;
const INT_RE = /^\d+$/;

export function parseOpeningStockCsv(csv: string): ParsedOpeningFile {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/);
  let headerAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trim().length > 0) {
      headerAt = i;
      break;
    }
  }
  if (headerAt < 0) return { fileError: 'The file is empty.', rows: [] };
  const header = splitCsvLine(lines[headerAt]!).map((h) => h.toLowerCase());
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return {
      fileError: `The first line must name the columns sku_code, location_code, quantity (and optionally unit_cost_minor). Missing: ${missing.join(', ')}.`,
      rows: [],
    };
  }
  const col = (name: string): number => header.indexOf(name);
  const sku = col('sku_code');
  const loc = col('location_code');
  const qty = col('quantity');
  const cost = col('unit_cost_minor');

  const rows: ParsedOpeningRow[] = [];
  const seen = new Set<string>();
  for (let i = headerAt + 1; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (raw.trim().length === 0) continue;
    const f = splitCsvLine(raw);
    const skuCode = f[sku] ?? '';
    const locationCode = f[loc] ?? '';
    const quantityText = f[qty] ?? '';
    const costText = cost < 0 ? '' : (f[cost] ?? '');
    const issues: OpeningRowIssue[] = [];
    if (skuCode === '' || locationCode === '' || quantityText === '') issues.push('MISSING_FIELD');
    if (quantityText !== '' && !DECIMAL_RE.test(quantityText)) issues.push('BAD_QUANTITY');
    if (costText !== '' && !INT_RE.test(costText)) issues.push('BAD_UNIT_COST');
    const key = `${locationCode}\u0000${skuCode}`;
    if (skuCode !== '' && locationCode !== '') {
      if (seen.has(key)) issues.push('DUPLICATE_ROW');
      seen.add(key);
    }
    rows.push({
      lineNo: i + 1,
      skuCode,
      locationCode,
      quantityText,
      unitCostText: costText === '' ? null : costText,
      issues,
    });
    if (rows.length > OPENING_STOCK_MAX_ROWS) {
      return { fileError: `A file holds at most ${OPENING_STOCK_MAX_ROWS} rows; split it.`, rows: [] };
    }
  }
  if (rows.length === 0) return { fileError: 'The file has a header and no rows.', rows: [] };
  return { fileError: null, rows };
}

/**
 * A plain decimal as a scaled integer at `scale` — EXACT, never via a float.
 * Returns null when the text carries a non-zero digit beyond the scale
 * ("2.5005" at scale 3); trailing zeros beyond it are exact and accepted.
 */
export function parseScaledDecimal(text: string, scale: number): bigint | null {
  if (!DECIMAL_RE.test(text) || !Number.isInteger(scale) || scale < 0) return null;
  const [whole, frac = ''] = text.split('.');
  const kept = frac.slice(0, scale);
  const dropped = frac.slice(scale);
  if (/[^0]/.test(dropped)) return null;
  return BigInt(whole! + kept.padEnd(scale, '0'));
}

/**
 * The canonical text an import's content hash is taken over: the rows, codes
 * trimmed, ORDER-INDEPENDENT, so the same stock re-saved with its rows sorted
 * differently or a trailing blank line is still recognised as the same file.
 */
export function canonicalOpeningRows(rows: readonly ParsedOpeningRow[]): string {
  return rows
    .map((r) => `${r.locationCode}\t${r.skuCode}\t${r.quantityText}\t${r.unitCostText ?? ''}`)
    .sort()
    .join('\n');
}
