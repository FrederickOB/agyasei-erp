/**
 * Opening stock from a file — HQ's one-time load before go-live (migration
 * 0031; open-questions Q20). ONLINE ONLY, by design: this is configuration of
 * the books' starting point, done at a laptop against a live server, and it is
 * deliberately NOT an outbox kind (`outbox-surface.test.ts` pins that surface).
 *
 * Two calls, both POST because a file does not fit in a query string:
 *   · previewOpeningStock — every row's verdict; writes nothing;
 *   · commitOpeningStock  — all or nothing, once. The idempotency key is the
 *     CALLER's, minted when the file is chosen and held across retries.
 *
 * Quantities come back as decimal strings of scaled integers and become bigint
 * in the mappers below, never `Number` (ADR-0004).
 */
import {
  commitOpeningStockInput,
  previewOpeningStockInput,
  type CommitOpeningStockInput,
  type OpeningRowIssue,
  type PreviewOpeningStockInput,
} from '@erp/contracts';
import {
  apiMutate,
  asArray,
  asBoolean,
  asCount,
  asOptionalCount,
  asOptionalScaled,
  asOptionalString,
  asRecord,
  asString,
  type ApiCallOptions,
  type ApiResult,
} from './client';
import { guard } from './guard';

export interface OpeningPreviewRow {
  readonly lineNo: number;
  readonly skuCode: string;
  readonly locationCode: string;
  readonly quantityText: string;
  /** The exact scaled integer that would be stored, at `qtyScale`. */
  readonly qtyScaled: bigint | null;
  readonly qtyScale: number | null;
  readonly uomCode: string | null;
  readonly unitCostMinor: string | null;
  readonly issues: readonly OpeningRowIssue[];
}

export interface OpeningPreview {
  readonly fileError: string | null;
  readonly asOfDate: string;
  readonly previous: { readonly importId: string; readonly asOfDate: string; readonly rowCount: number } | null;
  readonly summary: {
    readonly rowCount: number;
    readonly goodCount: number;
    readonly badCount: number;
    readonly locationCount: number;
    readonly productCount: number;
  } | null;
  readonly rows: readonly OpeningPreviewRow[];
}

export interface OpeningCommit {
  readonly importId: string;
  readonly alreadyImported: boolean;
  readonly asOfDate: string;
  readonly rowCount: number;
  readonly movementCount: number;
}

function mapPreview(json: unknown): OpeningPreview {
  const r = asRecord(json, 'openingStock.preview');
  const prev = r['previous'] === null || r['previous'] === undefined ? null : asRecord(r['previous'], 'previous');
  const sum = r['summary'] === null || r['summary'] === undefined ? null : asRecord(r['summary'], 'summary');
  return {
    fileError: asOptionalString(r['fileError'], 'fileError'),
    asOfDate: asString(r['asOfDate'], 'asOfDate'),
    previous:
      prev === null
        ? null
        : {
            importId: asString(prev['importId'], 'previous.importId'),
            asOfDate: asString(prev['asOfDate'], 'previous.asOfDate'),
            rowCount: asCount(prev['rowCount'], 'previous.rowCount'),
          },
    summary:
      sum === null
        ? null
        : {
            rowCount: asCount(sum['rowCount'], 'rowCount'),
            goodCount: asCount(sum['goodCount'], 'goodCount'),
            badCount: asCount(sum['badCount'], 'badCount'),
            locationCount: asCount(sum['locationCount'], 'locationCount'),
            productCount: asCount(sum['productCount'], 'productCount'),
          },
    rows: asArray(r['rows'], 'rows').map((raw) => {
      const row = asRecord(raw, 'row');
      return {
        lineNo: asCount(row['lineNo'], 'lineNo'),
        skuCode: asString(row['skuCode'], 'skuCode'),
        locationCode: asString(row['locationCode'], 'locationCode'),
        quantityText: asString(row['quantityText'], 'quantityText'),
        qtyScaled: asOptionalScaled(row['qtyScaled'], 'qtyScaled'),
        qtyScale: asOptionalCount(row['qtyScale'], 'qtyScale'),
        uomCode: asOptionalString(row['uomCode'], 'uomCode'),
        unitCostMinor: asOptionalString(row['unitCostMinor'], 'unitCostMinor'),
        issues: asArray(row['issues'], 'issues').map((i) => asString(i, 'issue') as OpeningRowIssue),
      };
    }),
  };
}

function mapCommit(json: unknown): OpeningCommit {
  const r = asRecord(json, 'openingStock.commit');
  return {
    importId: asString(r['importId'], 'importId'),
    alreadyImported: asBoolean(r['alreadyImported'], 'alreadyImported'),
    asOfDate: asString(r['asOfDate'], 'asOfDate'),
    rowCount: asCount(r['rowCount'], 'rowCount'),
    movementCount: asCount(r['movementCount'], 'movementCount'),
  };
}

export function previewOpeningStock(
  input: PreviewOpeningStockInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<OpeningPreview>> {
  const bad = guard(previewOpeningStockInput, 'openingStock.preview', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate('openingStock.preview', input, mapPreview, options);
}

export function commitOpeningStock(
  input: CommitOpeningStockInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<OpeningCommit>> {
  const bad = guard(commitOpeningStockInput, 'openingStock.commit', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate('openingStock.commit', input, mapCommit, options);
}

/** Words for each issue code — product chrome, never tenant vocabulary. */
export const OPENING_ISSUE_TEXT: Readonly<Record<OpeningRowIssue, string>> = {
  MISSING_FIELD: 'A column is empty',
  UNKNOWN_SKU: 'No product has this code',
  UNKNOWN_LOCATION: 'No location has this code',
  NOT_A_STOCK_LOCATION: 'This location does not hold stock',
  NOT_STOCKED: 'This product is not stock-tracked',
  BAD_QUANTITY: 'Not a positive quantity',
  BAD_QUANTITY_SCALE: 'More decimal places than this unit carries',
  BAD_UNIT_COST: 'Unit cost must be a whole number of minor units',
  DUPLICATE_ROW: 'Same product and location as an earlier row',
  ALREADY_OPENED: 'Already has opening stock — correct it with an adjustment',
  NOT_PERMITTED: 'You cannot load stock at this location',
};
