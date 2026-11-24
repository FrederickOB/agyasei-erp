/**
 * The product list from a spreadsheet, and archiving the catalogue
 * (apps/api/src/routers/products.ts; migration 0032). ONLINE ONLY, like
 * opening stock: this is configuration done at a laptop against a live
 * server, and deliberately NOT an outbox kind (`outbox-surface.test.ts`).
 *
 * Prices and costs come back as decimal strings of minor units × 10⁴ and
 * become bigint in the mappers below, never `Number` (ADR-0004).
 */
import {
  commitProductImportInput,
  previewProductImportInput,
  removeAllProductsInput,
  type CommitProductImportInput,
  type PreviewProductImportInput,
  type ProductRowIssue,
  type RemoveAllProductsInput,
} from '@erp/contracts';
import {
  apiMutate,
  apiQuery,
  asArray,
  asBoolean,
  asCount,
  asOptionalScaled,
  asOptionalString,
  asRecord,
  asScaled,
  asString,
  type ApiCallOptions,
  type ApiResult,
} from './client';
import { guard } from './guard';

export interface ProductImportSetup {
  readonly currencyCode: string;
  /** The pack's divisor — never assumed. */
  readonly minorUnitsPerMajor: bigint;
  readonly units: readonly { readonly code: string; readonly name: string; readonly qtyScale: number }[];
  readonly categories: readonly string[];
  readonly priceLists: readonly { readonly id: string; readonly code: string; readonly name: string; readonly isTaxInclusive: boolean }[];
  readonly taxCodes: readonly { readonly code: string; readonly name: string }[];
  readonly defaultTaxCode: string | null;
  readonly suppliers: readonly string[];
  readonly productCount: number;
}

export interface CatalogueProduct {
  readonly productId: string;
  readonly code: string;
  readonly name: string;
  readonly category: string | null;
  readonly unit: string;
  /** Minor units × 10⁴ per ONE stocking unit. */
  readonly costE4: bigint | null;
  readonly supplier: string | null;
  readonly prices: readonly { readonly priceListId: string; readonly priceE4: bigint }[];
}

export type ImportRowStatus = 'ready' | 'duplicate' | 'problem';

export interface ImportPreviewRow {
  readonly lineNo: number;
  readonly name: string;
  readonly code: string;
  readonly category: string;
  readonly categoryIsNew: boolean;
  readonly unit: string;
  readonly supplier: string | null;
  readonly supplierIsNew: boolean;
  readonly taxCode: string | null;
  readonly costE4: bigint | null;
  readonly prices: readonly { readonly priceListId: string; readonly priceListName: string; readonly priceE4: bigint }[];
  readonly status: ImportRowStatus;
  readonly issues: readonly ProductRowIssue[];
}

export interface ImportPreview {
  readonly fileError: string | null;
  readonly ignoredColumns: readonly string[];
  readonly priceColumns: readonly { readonly priceListId: string; readonly name: string }[];
  readonly summary: {
    readonly rowCount: number;
    readonly readyCount: number;
    readonly duplicateCount: number;
    readonly problemCount: number;
    readonly newCategories: readonly string[];
    readonly newSuppliers: readonly string[];
  } | null;
  readonly rows: readonly ImportPreviewRow[];
}

export interface ImportResult {
  readonly importId: string;
  readonly rowCount: number;
  readonly importedCount: number;
  readonly rejectedCount: number;
  readonly createdCategoryCount: number;
  readonly createdSupplierCount: number;
  readonly rejected: readonly { readonly lineNo: number; readonly issues: readonly ProductRowIssue[] }[];
}

/** What each refusal means, in the words a person fixing a spreadsheet needs. */
export const PRODUCT_ISSUE_TEXT: Readonly<Record<ProductRowIssue, string>> = {
  MISSING_NAME: 'No product name',
  MISSING_CATEGORY: 'No category',
  MISSING_UNIT: 'No unit',
  NAME_TOO_LONG: 'Name is too long (120 characters at most)',
  BAD_CODE: 'Product code is too long or has odd characters',
  TEXT_TOO_LONG: 'A cell is too long (500 characters at most)',
  BAD_COST: 'Cost price is not a number',
  BAD_PRICE: 'A price is not a number',
  NO_PRICE: 'No selling price',
  DUPLICATE_IN_FILE: 'Appears earlier in this file',
  DUPLICATE_CODE: 'A product with this code already exists',
  DUPLICATE_NAME: 'A product with this name already exists',
  UNKNOWN_UNIT: 'Unit not recognised — use one from the template’s Lists sheet',
  UNKNOWN_TAX_CODE: 'Tax not recognised — use one from the template’s Lists sheet',
  NO_TAX_CODE: 'No tax given, and there is no usual one to assume',
  COST_TOO_PRECISE: 'Cost price has too many decimal places',
  PRICE_TOO_PRECISE: 'A price has too many decimal places',
  PRICE_NOT_PERMITTED: 'You may not set prices',
  SUPPLIER_NOT_PERMITTED: 'New supplier — you may not add suppliers',
};

function mapSetup(json: unknown): ProductImportSetup {
  const r = asRecord(json, 'products.importSetup');
  return {
    currencyCode: asString(r['currencyCode'], 'currencyCode'),
    minorUnitsPerMajor: asScaled(r['minorUnitsPerMajor'], 'minorUnitsPerMajor'),
    units: asArray(r['units'], 'units').map((raw) => {
      const u = asRecord(raw, 'unit');
      return { code: asString(u['code'], 'unit.code'), name: asString(u['name'], 'unit.name'), qtyScale: asCount(u['qtyScale'], 'unit.qtyScale') };
    }),
    categories: asArray(r['categories'], 'categories').map((c) => asString(c, 'category')),
    priceLists: asArray(r['priceLists'], 'priceLists').map((raw) => {
      const l = asRecord(raw, 'priceList');
      return {
        id: asString(l['id'], 'priceList.id'),
        code: asString(l['code'], 'priceList.code'),
        name: asString(l['name'], 'priceList.name'),
        isTaxInclusive: asBoolean(l['isTaxInclusive'], 'priceList.isTaxInclusive'),
      };
    }),
    taxCodes: asArray(r['taxCodes'], 'taxCodes').map((raw) => {
      const t = asRecord(raw, 'taxCode');
      return { code: asString(t['code'], 'taxCode.code'), name: asString(t['name'], 'taxCode.name') };
    }),
    defaultTaxCode: asOptionalString(r['defaultTaxCode'], 'defaultTaxCode'),
    suppliers: asArray(r['suppliers'], 'suppliers').map((s) => asString(s, 'supplier')),
    productCount: asCount(r['productCount'], 'productCount'),
  };
}

function mapList(json: unknown): readonly CatalogueProduct[] {
  const r = asRecord(json, 'products.list');
  return asArray(r['products'], 'products').map((raw) => {
    const p = asRecord(raw, 'product');
    return {
      productId: asString(p['productId'], 'productId'),
      code: asString(p['code'], 'code'),
      name: asString(p['name'], 'name'),
      category: asOptionalString(p['category'], 'category'),
      unit: asString(p['unit'], 'unit'),
      costE4: asOptionalScaled(p['costE4'], 'costE4'),
      supplier: asOptionalString(p['supplier'], 'supplier'),
      prices: asArray(p['prices'], 'prices').map((x) => {
        const pr = asRecord(x, 'price');
        return { priceListId: asString(pr['priceListId'], 'priceListId'), priceE4: asScaled(pr['priceE4'], 'priceE4') };
      }),
    };
  });
}

function mapIssues(value: unknown): ProductRowIssue[] {
  return asArray(value, 'issues').map((i) => asString(i, 'issue') as ProductRowIssue);
}

function mapPreview(json: unknown): ImportPreview {
  const r = asRecord(json, 'products.previewImport');
  const sum = r['summary'] === null || r['summary'] === undefined ? null : asRecord(r['summary'], 'summary');
  return {
    fileError: asOptionalString(r['fileError'], 'fileError'),
    ignoredColumns: asArray(r['ignoredColumns'], 'ignoredColumns').map((c) => asString(c, 'ignoredColumn')),
    priceColumns: asArray(r['priceColumns'], 'priceColumns').map((raw) => {
      const c = asRecord(raw, 'priceColumn');
      return { priceListId: asString(c['priceListId'], 'priceListId'), name: asString(c['name'], 'name') };
    }),
    summary:
      sum === null
        ? null
        : {
            rowCount: asCount(sum['rowCount'], 'rowCount'),
            readyCount: asCount(sum['readyCount'], 'readyCount'),
            duplicateCount: asCount(sum['duplicateCount'], 'duplicateCount'),
            problemCount: asCount(sum['problemCount'], 'problemCount'),
            newCategories: asArray(sum['newCategories'], 'newCategories').map((c) => asString(c, 'newCategory')),
            newSuppliers: asArray(sum['newSuppliers'], 'newSuppliers').map((c) => asString(c, 'newSupplier')),
          },
    rows: asArray(r['rows'], 'rows').map((raw) => {
      const row = asRecord(raw, 'row');
      const status = asString(row['status'], 'status');
      return {
        lineNo: asCount(row['lineNo'], 'lineNo'),
        name: asString(row['name'], 'name'),
        code: asString(row['code'], 'code'),
        category: asString(row['category'], 'category'),
        categoryIsNew: asBoolean(row['categoryIsNew'], 'categoryIsNew'),
        unit: asString(row['unit'], 'unit'),
        supplier: asOptionalString(row['supplier'], 'supplier'),
        supplierIsNew: asBoolean(row['supplierIsNew'], 'supplierIsNew'),
        taxCode: asOptionalString(row['taxCode'], 'taxCode'),
        costE4: asOptionalScaled(row['costE4'], 'costE4'),
        prices: asArray(row['prices'], 'prices').map((x) => {
          const p = asRecord(x, 'price');
          return {
            priceListId: asString(p['priceListId'], 'priceListId'),
            priceListName: asString(p['priceListName'], 'priceListName'),
            priceE4: asScaled(p['priceE4'], 'priceE4'),
          };
        }),
        status: status === 'ready' || status === 'duplicate' ? status : 'problem',
        issues: mapIssues(row['issues']),
      };
    }),
  };
}

function mapResult(json: unknown): ImportResult {
  const r = asRecord(json, 'products.commitImport');
  return {
    importId: asString(r['importId'], 'importId'),
    rowCount: asCount(r['rowCount'], 'rowCount'),
    importedCount: asCount(r['importedCount'], 'importedCount'),
    rejectedCount: asCount(r['rejectedCount'], 'rejectedCount'),
    createdCategoryCount: asCount(r['createdCategoryCount'], 'createdCategoryCount'),
    createdSupplierCount: asCount(r['createdSupplierCount'], 'createdSupplierCount'),
    rejected: asArray(r['rejected'], 'rejected').map((raw) => {
      const x = asRecord(raw, 'rejected');
      return { lineNo: asCount(x['lineNo'], 'lineNo'), issues: mapIssues(x['issues']) };
    }),
  };
}

export function fetchProductImportSetup(options: ApiCallOptions = {}): Promise<ApiResult<ProductImportSetup>> {
  return apiQuery('products.importSetup', undefined, mapSetup, options);
}

export function fetchCatalogue(options: ApiCallOptions = {}): Promise<ApiResult<readonly CatalogueProduct[]>> {
  return apiQuery('products.list', undefined, mapList, options);
}

export function previewProductImport(
  input: PreviewProductImportInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<ImportPreview>> {
  const bad = guard(previewProductImportInput, 'products.previewImport', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate('products.previewImport', input, mapPreview, options);
}

export function commitProductImport(
  input: CommitProductImportInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<ImportResult>> {
  const bad = guard(commitProductImportInput, 'products.commitImport', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate('products.commitImport', input, mapResult, options);
}

export function removeAllProducts(
  input: RemoveAllProductsInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<{ readonly archivedCount: number }>> {
  const bad = guard(removeAllProductsInput, 'products.removeAll', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate(
    'products.removeAll',
    input,
    (json) => ({ archivedCount: asCount(asRecord(json, 'products.removeAll')['archivedCount'], 'archivedCount') }),
    options,
  );
}
