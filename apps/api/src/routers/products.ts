/**
 * THE PRODUCT LIST, FROM A SPREADSHEET — `products.*` (migration 0032).
 *
 *   importSetup    what the template needs: the tenant's units, categories,
 *                  price lists, tax codes and suppliers (query)
 *   list           the live catalogue with prices, stated cost and supplier
 *                  (query)
 *   previewImport  every row's verdict — ready, duplicate, or a problem —
 *                  and what would be created alongside (writes nothing)
 *   commitImport   the ready rows created, the rest handed back with their
 *                  reasons, in ONE idempotent write
 *   removeAll      archive the whole catalogue, confirmed against the count
 *                  the person was shown
 *   setSellable    switch ONE product off for sale, or back on — it keeps its
 *                  prices, stock and history; counters stop offering it
 *
 * Taking a product off (either way) never strands a device's record of it:
 * a sale, adjustment or receipt made before the device heard still lands,
 * with a review (../retired-product.ts).
 *
 * ── ROW BY ROW ────────────────────────────────────────────────────────────
 * Unlike opening stock, a product list is not all-or-nothing (see 0032's
 * header): the good rows land, the refused ones are named. The commit RE-
 * CHECKS the file inside its transaction rather than trusting the preview —
 * a product created by somebody else in between is a duplicate at commit
 * time, whatever the preview said.
 *
 * ── WHAT A ROW CREATES ────────────────────────────────────────────────────
 * One `app.product` (stocked, purchasable, sellable unless its "On sale"
 * cell says No), its stocking unit as the
 * default selling unit at 1/1 (exact, so tolerance 0 — 0003's header), one
 * `price_list_item` per price given, an `app.product_cost` when a cost is
 * given, and a preferred `supplier_product` when a supplier is named. A
 * category or supplier the tenant does not have yet is created once, however
 * many rows name it. Every row carries write_id = the import's key.
 *
 * ── NOTHING HERE IS TENANT VOCABULARY ────────────────────────────────────
 * Price lists, units, categories and tax codes are matched by the tenant's
 * own names and codes (CLAUDE.md §2.9). A bare "Price" column is the price
 * list with the lowest `priority` — the tenant's own resolution order, not a
 * name anybody typed into this file. A blank tax cell takes the tax code the
 * tenant's own catalogue uses most; with no catalogue history, it is
 * required.
 *
 * ── MONEY ─────────────────────────────────────────────────────────────────
 * Prices and costs are parsed from decimal TEXT straight into minor units ×
 * 10⁴ (app.rate_e4) at the scale the jurisdiction pack gives the currency —
 * never through a float, never assuming 100 (ADR-0004; CLAUDE.md §2.3). A
 * figure with more decimals than that is refused, not rounded.
 *
 * ── WHO ────────────────────────────────────────────────────────────────────
 * `catalogue.manage`, tenant-wide — the catalogue belongs to the tenant, not
 * to an outlet. Setting prices additionally needs
 * `catalogue.price_list.manage` and creating a supplier `supplier.manage`:
 * a row needing one its importer lacks is refused by name, never created
 * half-way.
 */
import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import {
  canonicalProductRows,
  commitProductImportInput,
  parseProductCsv,
  parseScaledDecimal,
  previewProductImportInput,
  productNameKey,
  removeAllProductsInput,
  setProductSellableInput,
  type ParsedProductFile,
  type ParsedProductRow,
  type ProductRowIssue,
} from '@erp/contracts';
import { deterministicUuid } from '@erp/db';
import type { Queryable } from '../db.js';
import { runIdempotent, type JsonValue } from '../pipeline.js';
import { permissionProcedure, router, type PermissionState } from '../trpc.js';
import { wire } from '../wire.js';
import { loadJurisdiction } from './sales.js';

const CODE = 'catalogue.manage';
const PRICE_CODE = 'catalogue.price_list.manage';
const SUPPLIER_CODE = 'supplier.manage';
const GENERATED_CODE_PREFIX = 'P-';
const INSERT_CHUNK = 500;

const manageProcedure = permissionProcedure({ code: CODE, at: 'tenant' });

// ---------------------------------------------------------------------------
// What the tenant already has
// ---------------------------------------------------------------------------

interface Named {
  id: string;
  code: string;
  name: string;
}
interface Unit extends Named {
  qtyScale: number;
}
interface PriceList extends Named {
  isTaxInclusive: boolean;
  priority: number;
  effectiveFrom: string;
}

interface Setup {
  currencyCode: string;
  minorUnitsPerMajor: bigint;
  /** Decimal places of the currency's minor unit; null when the pack's divisor is not a power of ten. */
  moneyDigits: number | null;
  units: Unit[];
  categories: Named[];
  priceLists: PriceList[];
  taxCodes: { code: string; name: string }[];
  defaultTaxCode: string | null;
  suppliers: Named[];
  productCount: number;
}

function digitsOf(divisor: bigint): number | null {
  let d = 0;
  let v = divisor;
  while (v > 1n && v % 10n === 0n) {
    v /= 10n;
    d += 1;
  }
  return v === 1n ? d : null;
}

async function loadSetup(tx: Queryable): Promise<Setup> {
  const j = await loadJurisdiction(tx);
  const units = (
    await tx.query<{ id: string; code: string; name: string; qty_scale: number }>(
      `select id, code, name, qty_scale from app.unit_of_measure where deleted_at is null order by name, code`,
    )
  ).rows.map((u) => ({ id: u.id, code: u.code, name: u.name, qtyScale: Number(u.qty_scale) }));
  const categories = (
    await tx.query<Named>(`select id, code, name from app.product_category where deleted_at is null order by name, code`)
  ).rows;
  // Tenant-wide lists in force today. A location's own list prices only that
  // location and is managed there, not from a tenant-wide file.
  const priceLists = (
    await tx.query<{ id: string; code: string; name: string; is_tax_inclusive: boolean; priority: number; effective_from: string }>(
      `select id, code, name, is_tax_inclusive, priority, effective_from::text
         from app.price_list
        where deleted_at is null and location_id is null
          and (effective_to is null or effective_to >= current_date)
        order by priority, code`,
    )
  ).rows.map((l) => ({
    id: l.id,
    code: l.code,
    name: l.name,
    isTaxInclusive: l.is_tax_inclusive,
    priority: Number(l.priority),
    effectiveFrom: l.effective_from,
  }));
  const taxCodes = (
    await tx.query<{ code: string; name: string }>(
      `select code, name from platform.tax_code where jurisdiction_code = $1 order by code`,
      [j.jurisdictionCode],
    )
  ).rows;
  // Archived products count: a tenant that cleared its catalogue to load a
  // new one still has a habit, and the habit is the best default there is.
  const usual = await tx.query<{ tax_code: string }>(
    `select tax_code from app.product group by tax_code order by count(*) desc, tax_code limit 1`,
  );
  const suppliers = (
    await tx.query<Named>(`select id, code, name from app.supplier where deleted_at is null order by name, code`)
  ).rows;
  const count = await tx.query<{ n: string }>(`select count(*)::text n from app.product where deleted_at is null`);
  return {
    currencyCode: j.currencyCode,
    minorUnitsPerMajor: j.minorUnitsPerMajor,
    moneyDigits: digitsOf(j.minorUnitsPerMajor),
    units,
    categories,
    priceLists,
    taxCodes,
    defaultTaxCode: usual.rows[0]?.tax_code ?? null,
    suppliers,
    productCount: Number(count.rows[0]!.n),
  };
}

const lc = (s: string): string => s.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();

/** Index rows by lower-cased code AND name; the first row wins a clash. */
function byCodeOrName<T extends { code: string; name: string }>(rows: readonly T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) {
    if (!m.has(lc(r.code))) m.set(lc(r.code), r);
  }
  for (const r of rows) {
    if (!m.has(lc(r.name))) m.set(lc(r.name), r);
  }
  return m;
}

function findUnit(units: Map<string, Unit>, text: string): Unit | undefined {
  const k = lc(text);
  return units.get(k) ?? (k.endsWith('es') ? units.get(k.slice(0, -2)) : undefined) ?? (k.endsWith('s') ? units.get(k.slice(0, -1)) : undefined);
}

/** Resolve each price column to one of the tenant's lists, or explain why not. */
function resolvePriceColumns(
  file: ParsedProductFile,
  lists: readonly PriceList[],
): { lists: PriceList[]; error: string | null } {
  const out: PriceList[] = [];
  const names = lists.map((l) => `“${l.name}”`).join(', ');
  if (lists.length === 0) {
    return { lists: [], error: 'There is no price list to put prices on. A price list must exist before products can be priced.' };
  }
  for (const col of file.priceColumns) {
    let hit: PriceList | undefined;
    if (col.listKey === '') {
      hit = lists[0];
    } else {
      const key = lc(col.listKey);
      hit = lists.find((l) => lc(l.name) === key || lc(l.code) === key);
      if (!hit) {
        const partial = lists.filter((l) => lc(l.name).includes(key) || lc(l.code).includes(key) || key.includes(lc(l.name)));
        if (partial.length === 1) hit = partial[0];
      }
    }
    if (!hit) {
      return { lists: [], error: `The column “${col.header}” does not name one of your price lists (${names}).` };
    }
    if (out.some((l) => l.id === hit!.id)) {
      return { lists: [], error: `Two columns set the price for “${hit.name}”. Keep one of them.` };
    }
    out.push(hit);
  }
  return { lists: out, error: null };
}

function holdsTenantWide(permissions: PermissionState, code: string): boolean {
  try {
    permissions.requireTenantWide(code);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Checking a file
// ---------------------------------------------------------------------------

const DUPLICATE_ISSUES: ReadonlySet<ProductRowIssue> = new Set(['DUPLICATE_IN_FILE', 'DUPLICATE_CODE', 'DUPLICATE_NAME']);

type RowStatus = 'ready' | 'duplicate' | 'problem';

function statusOf(issues: readonly ProductRowIssue[]): RowStatus {
  if (issues.length === 0) return 'ready';
  return issues.every((i) => DUPLICATE_ISSUES.has(i)) ? 'duplicate' : 'problem';
}

interface CheckedRow {
  row: ParsedProductRow;
  issues: ProductRowIssue[];
  status: RowStatus;
  unit: Unit | null;
  category: { existing: Named | null; name: string };
  supplier: { existing: Named | null; name: string } | null;
  taxCode: string | null;
  costE4: bigint | null;
  prices: { list: PriceList; priceE4: bigint }[];
  /** The code the product will carry; '' until generated at commit. */
  code: string;
}

interface CheckedFile {
  fileError: string | null;
  contentSha256: string | null;
  rows: CheckedRow[];
  setup: Setup;
  lists: PriceList[];
}

async function checkFile(tx: Queryable, permissions: PermissionState, file: ParsedProductFile): Promise<CheckedFile> {
  const setup = await loadSetup(tx);
  const fail = (fileError: string): CheckedFile => ({ fileError, contentSha256: null, rows: [], setup, lists: [] });
  if (file.fileError !== null) return fail(file.fileError);
  if (setup.moneyDigits === null) {
    return fail('This currency’s minor unit is not a power of ten, so prices cannot be read from a file.');
  }
  const resolved = resolvePriceColumns(file, setup.priceLists);
  if (resolved.error !== null) return fail(resolved.error);

  const live = (await tx.query<{ sku_code: string; name: string }>(
    `select sku_code, name from app.product where deleted_at is null`,
  )).rows;
  const liveCodes = new Set(live.map((p) => p.sku_code.toUpperCase()));
  const liveNames = new Set(live.map((p) => productNameKey(p.name)));
  const units = byCodeOrName(setup.units);
  const categories = byCodeOrName(setup.categories);
  const suppliers = byCodeOrName(setup.suppliers);
  const taxes = byCodeOrName(setup.taxCodes.map((t) => ({ ...t, id: t.code })));
  const canPrice = holdsTenantWide(permissions, PRICE_CODE);
  const canSupplier = holdsTenantWide(permissions, SUPPLIER_CODE);
  const rateDigits = setup.moneyDigits + 4;

  const rows = file.rows.map((row): CheckedRow => {
    const issues: ProductRowIssue[] = [...row.issues];
    if (row.code !== '' && liveCodes.has(row.code.toUpperCase())) issues.push('DUPLICATE_CODE');
    if (row.name !== '' && liveNames.has(productNameKey(row.name))) issues.push('DUPLICATE_NAME');

    const unit = row.unit === '' ? undefined : findUnit(units, row.unit);
    if (row.unit !== '' && !unit) issues.push('UNKNOWN_UNIT');

    let taxCode: string | null = null;
    if (row.tax !== '') {
      const t = taxes.get(lc(row.tax));
      if (t) taxCode = t.code;
      else issues.push('UNKNOWN_TAX_CODE');
    } else if (setup.defaultTaxCode !== null) {
      taxCode = setup.defaultTaxCode;
    } else {
      issues.push('NO_TAX_CODE');
    }

    let costE4: bigint | null = null;
    if (row.costText !== '') {
      costE4 = parseScaledDecimal(row.costText, rateDigits);
      if (costE4 === null) issues.push('COST_TOO_PRECISE');
    }
    const prices: { list: PriceList; priceE4: bigint }[] = [];
    let tooPrecise = false;
    for (const p of row.prices) {
      const v = parseScaledDecimal(p.text, rateDigits);
      if (v === null) tooPrecise = true;
      else prices.push({ list: resolved.lists[p.column]!, priceE4: v });
    }
    if (tooPrecise) issues.push('PRICE_TOO_PRECISE');
    if (prices.length > 0 && !canPrice) issues.push('PRICE_NOT_PERMITTED');

    const existingCategory = row.category === '' ? null : (categories.get(lc(row.category)) ?? null);
    let supplier: CheckedRow['supplier'] = null;
    if (row.supplier !== '') {
      const existing = suppliers.get(lc(row.supplier)) ?? null;
      supplier = { existing, name: row.supplier };
      if (existing === null && !canSupplier) issues.push('SUPPLIER_NOT_PERMITTED');
    }

    return {
      row,
      issues,
      status: statusOf(issues),
      unit: unit ?? null,
      category: { existing: existingCategory, name: existingCategory?.name ?? row.category },
      supplier,
      taxCode,
      costE4,
      prices,
      code: row.code,
    };
  });

  return {
    fileError: null,
    contentSha256: createHash('sha256').update(canonicalProductRows(file)).digest('hex'),
    rows,
    setup,
    lists: resolved.lists,
  };
}

/** Distinct new names among READY rows, in first-appearance order. */
function newNames(rows: readonly CheckedRow[], pick: (r: CheckedRow) => { existing: Named | null; name: string } | null): string[] {
  const seen = new Map<string, string>();
  for (const r of rows) {
    if (r.status !== 'ready') continue;
    const p = pick(r);
    if (p === null || p.existing !== null || p.name === '') continue;
    if (!seen.has(lc(p.name))) seen.set(lc(p.name), p.name);
  }
  return [...seen.values()];
}

function summarise(rows: readonly CheckedRow[]) {
  return {
    rowCount: rows.length,
    readyCount: rows.filter((r) => r.status === 'ready').length,
    duplicateCount: rows.filter((r) => r.status === 'duplicate').length,
    problemCount: rows.filter((r) => r.status === 'problem').length,
    newCategories: newNames(rows, (r) => r.category),
    newSuppliers: newNames(rows, (r) => r.supplier),
  };
}

function rowView(r: CheckedRow) {
  return {
    lineNo: r.row.lineNo,
    name: r.row.name,
    code: r.row.code,
    category: r.category.name,
    categoryIsNew: r.category.existing === null && r.category.name !== '',
    unit: r.unit?.name ?? r.row.unit,
    supplier: r.supplier?.existing?.name ?? r.supplier?.name ?? null,
    supplierIsNew: r.supplier !== null && r.supplier.existing === null,
    taxCode: r.taxCode,
    /** False: the product loads switched off for sale. */
    onSale: r.row.onSale,
    /** Minor units × 10⁴ per ONE stocking unit, as a decimal string. */
    costE4: r.costE4 === null ? null : wire(r.costE4),
    prices: r.prices.map((p) => ({ priceListId: p.list.id, priceListName: p.list.name, priceE4: wire(p.priceE4) })),
    status: r.status,
    issues: r.issues,
  };
}

function setupView(s: Setup) {
  return {
    currencyCode: s.currencyCode,
    minorUnitsPerMajor: wire(s.minorUnitsPerMajor),
    units: s.units.map((u) => ({ code: u.code, name: u.name, qtyScale: u.qtyScale })),
    categories: s.categories.map((c) => c.name),
    priceLists: s.priceLists.map((l) => ({ id: l.id, code: l.code, name: l.name, isTaxInclusive: l.isTaxInclusive })),
    taxCodes: s.taxCodes,
    defaultTaxCode: s.defaultTaxCode,
    suppliers: s.suppliers.map((x) => x.name),
    productCount: s.productCount,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function slugCode(name: string): string {
  const s = name
    .normalize('NFKD')
    .toUpperCase()
    .replace(/&/g, 'AND')
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return s === '' ? 'ITEM' : s;
}

/** A code not in `taken`, derived from `name`; `taken` is updated. */
function freshCode(name: string, taken: Set<string>): string {
  const base = slugCode(name);
  let code = base;
  for (let n = 2; taken.has(code); n += 1) code = `${base}-${String(n)}`;
  taken.add(code);
  return code;
}

async function bulkInsert(tx: Queryable, table: string, columns: readonly string[], rows: readonly unknown[][]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => `(${row.map((v) => {
      params.push(v);
      return `$${String(params.length)}`;
    }).join(', ')})`);
    await tx.query(`insert into ${table} (${columns.join(', ')}) values ${tuples.join(', ')}`, params);
  }
}

export interface ProductImportResponse {
  [key: string]: JsonValue;
  importId: string;
  rowCount: number;
  importedCount: number;
  rejectedCount: number;
  createdCategoryCount: number;
  createdSupplierCount: number;
  /** One entry per refused row, so the person can fix exactly those. */
  rejected: { lineNo: number; issues: string[] }[];
  /** The code each created product carries, by line — generated ones included. */
  created: { lineNo: number; code: string }[];
}

export interface RemoveAllResponse {
  [key: string]: JsonValue;
  archivedCount: number;
}

export interface SetSellableResponse {
  [key: string]: JsonValue;
  productId: string;
  sellable: boolean;
  /** False when the product already stood that way — nothing was written but the log. */
  changed: boolean;
}

export const productsRouter = router({
  /** What the template and the preview need to know about this tenant. */
  importSetup: manageProcedure.query(async ({ ctx }) => {
    return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => setupView(await loadSetup(tx)));
  }),

  /**
   * The live catalogue as the office manages it: prices per tenant-wide list
   * in force, the stated cost and the preferred supplier. Cost is here and
   * not on any device (0032): this read is online, behind catalogue.manage.
   */
  list: manageProcedure.query(async ({ ctx }) => {
    return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
      const products = await tx.query<{
        id: string; sku_code: string; name: string; category: string | null; unit: string;
        cost_e4: string | null; supplier: string | null; created_at: string; is_sellable: boolean;
      }>(
        `select p.id, p.sku_code, p.name, c.name as category, coalesce(u.name, u.code) as unit, p.is_sellable,
                pc.cost_e4::text as cost_e4, s.name as supplier,
                to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
           from app.product p
           join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
           left join app.product_category c on c.tenant_id = p.tenant_id and c.id = p.category_id
           left join app.product_cost pc on pc.tenant_id = p.tenant_id and pc.product_id = p.id and pc.deleted_at is null
           left join app.supplier_product sp on sp.tenant_id = p.tenant_id and sp.product_id = p.id
                                            and sp.is_preferred and sp.deleted_at is null
           left join app.supplier s on s.tenant_id = sp.tenant_id and s.id = sp.supplier_id
          where p.deleted_at is null
          order by p.name, p.sku_code`,
      );
      const prices = await tx.query<{ product_id: string; price_list_id: string; unit_price_e4: string }>(
        `select distinct on (i.product_id, i.price_list_id) i.product_id, i.price_list_id, i.unit_price_e4::text
           from app.price_list_item i
           join app.product p on p.tenant_id = i.tenant_id and p.id = i.product_id and p.deleted_at is null
           join app.price_list l on l.tenant_id = i.tenant_id and l.id = i.price_list_id
                                and l.deleted_at is null and l.location_id is null
          where i.deleted_at is null and i.uom_id = p.stocking_uom_id
            and i.effective_from <= current_date and (i.effective_to is null or i.effective_to > current_date)
          order by i.product_id, i.price_list_id, i.min_qty, i.effective_from desc`,
      );
      const byProduct = new Map<string, { priceListId: string; priceE4: string }[]>();
      for (const p of prices.rows) {
        const list = byProduct.get(p.product_id) ?? [];
        list.push({ priceListId: p.price_list_id, priceE4: p.unit_price_e4 });
        byProduct.set(p.product_id, list);
      }
      return {
        products: products.rows.map((p) => ({
          productId: p.id,
          code: p.sku_code,
          name: p.name,
          category: p.category,
          unit: p.unit,
          costE4: p.cost_e4,
          supplier: p.supplier,
          /** False: switched off — kept, priced, not offered at the counter. */
          sellable: p.is_sellable,
          createdAt: p.created_at,
          prices: byProduct.get(p.id) ?? [],
        })),
      };
    });
  }),

  /** The dry run. A mutation only because a file does not fit in a query string. */
  previewImport: manageProcedure.input(previewProductImportInput).mutation(async ({ ctx, input }) => {
    const parsed = parseProductCsv(input.csv);
    return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
      const file = await checkFile(tx, ctx.permissions, parsed);
      return {
        fileError: file.fileError,
        ignoredColumns: parsed.ignoredColumns,
        priceColumns: file.lists.map((l) => ({ priceListId: l.id, name: l.name })),
        summary: file.fileError === null ? summarise(file.rows) : null,
        rows: file.rows.map(rowView),
      };
    });
  }),

  commitImport: manageProcedure.input(commitProductImportInput).mutation(async ({ ctx, input }) => {
    const parsed = parseProductCsv(input.csv);
    if (parsed.fileError !== null) throw new TRPCError({ code: 'BAD_REQUEST', message: parsed.fileError });
    const tenantId = ctx.identity.tenantId;
    const key = input.idempotencyKey;
    const result = await runIdempotent<ProductImportResponse>(
      { runner: ctx.deps.runner, clock: ctx.deps.clock },
      ctx.identity,
      { op: 'catalogue.import', idempotencyKey: key, claimedHlc: input.claimedHlc, clientWallAt: input.clientWallAt },
      input,
      async (tx) => {
        const file = await checkFile(tx, ctx.permissions, parsed);
        if (file.fileError !== null) throw new TRPCError({ code: 'BAD_REQUEST', message: file.fileError });
        const ready = file.rows.filter((r) => r.status === 'ready');

        // Codes: the file's own, else generated past every code this tenant
        // has EVER used (archived included) so history never reads ambiguous.
        const everCodes = new Set(
          (await tx.query<{ sku_code: string }>(`select sku_code from app.product`)).rows.map((r) => r.sku_code.toUpperCase()),
        );
        for (const r of ready) if (r.code !== '') everCodes.add(r.code.toUpperCase());
        let next = 1;
        for (const c of everCodes) {
          const m = /^P-(\d+)$/.exec(c);
          if (m) next = Math.max(next, Number(m[1]) + 1);
        }
        for (const r of ready) {
          if (r.code !== '') continue;
          let code = `${GENERATED_CODE_PREFIX}${String(next).padStart(5, '0')}`;
          while (everCodes.has(code)) {
            next += 1;
            code = `${GENERATED_CODE_PREFIX}${String(next).padStart(5, '0')}`;
          }
          everCodes.add(code);
          r.code = code;
          next += 1;
        }

        const summary = summarise(file.rows);
        const response: ProductImportResponse = {
          importId: key,
          rowCount: file.rows.length,
          importedCount: ready.length,
          rejectedCount: file.rows.length - ready.length,
          createdCategoryCount: summary.newCategories.length,
          createdSupplierCount: summary.newSuppliers.length,
          rejected: file.rows.filter((r) => r.status !== 'ready').map((r) => ({ lineNo: r.row.lineNo, issues: [...r.issues] })),
          created: ready.map((r) => ({ lineNo: r.row.lineNo, code: r.code })),
        };

        return {
          response,
          apply: async (atx) => {
            const clock = ctx.deps.clock;
            const id = (...parts: string[]): string => deterministicUuid(tenantId, key, ...parts);

            // New categories and suppliers, once each.
            const categoryCodes = new Set(
              (await atx.query<{ code: string }>(`select code from app.product_category`)).rows.map((r) => r.code),
            );
            const categoryId = new Map<string, string>();
            const catRows: unknown[][] = [];
            for (const name of summary.newCategories) {
              const cid = id('category', lc(name));
              categoryId.set(lc(name), cid);
              catRows.push([tenantId, cid, key, clock.next(), freshCode(name, categoryCodes), name]);
            }
            if (catRows.length > 0) {
              await bulkInsert(atx, 'app.product_category', ['tenant_id', 'id', 'write_id', 'hlc', 'code', 'name'], catRows);
            }
            const supplierCodes = new Set(
              (await atx.query<{ code: string }>(`select code from app.supplier`)).rows.map((r) => r.code),
            );
            const supplierId = new Map<string, string>();
            const supRows: unknown[][] = [];
            for (const name of summary.newSuppliers) {
              const sid = id('supplier', lc(name));
              supplierId.set(lc(name), sid);
              // Cash on delivery until somebody says otherwise: 0 days is a
              // real term (0008), and the supplier screen is where terms live.
              supRows.push([tenantId, sid, key, clock.next(), freshCode(name, supplierCodes), name, 0, file.setup.currencyCode]);
            }
            if (supRows.length > 0) {
              await bulkInsert(
                atx,
                'app.supplier',
                ['tenant_id', 'id', 'write_id', 'hlc', 'code', 'name', 'payment_terms_days', 'currency_code'],
                supRows,
              );
            }

            const productRows: unknown[][] = [];
            const uomRows: unknown[][] = [];
            const priceRows: unknown[][] = [];
            const costRows: unknown[][] = [];
            const linkRows: unknown[][] = [];
            for (const r of ready) {
              const line = String(r.row.lineNo);
              const pid = id('product', line);
              const catId = r.category.existing?.id ?? categoryId.get(lc(r.category.name))!;
              productRows.push([
                tenantId, pid, key, clock.next(), r.code, r.row.name, catId, r.unit!.id, r.taxCode!,
                r.row.notes === '' ? null : r.row.notes, r.row.onSale,
              ]);
              uomRows.push([tenantId, id('product_uom', line), key, clock.next(), pid, r.unit!.id, '1', '1', true, true, true, 0, 0]);
              for (const p of r.prices) {
                priceRows.push([
                  tenantId, id('price', line, p.list.id), key, clock.next(), p.list.id, pid, r.unit!.id,
                  wire(p.priceE4), '0', p.list.effectiveFrom,
                ]);
              }
              if (r.costE4 !== null) costRows.push([tenantId, id('cost', line), key, clock.next(), pid, wire(r.costE4)]);
              if (r.supplier !== null) {
                const sid = r.supplier.existing?.id ?? supplierId.get(lc(r.supplier.name))!;
                linkRows.push([tenantId, id('supplier_product', line), key, clock.next(), sid, pid, r.unit!.id, true, true]);
              }
            }
            await bulkInsert(
              atx,
              'app.product',
              ['tenant_id', 'id', 'write_id', 'hlc', 'sku_code', 'name', 'category_id', 'stocking_uom_id', 'tax_code', 'notes', 'is_sellable'],
              productRows,
            );
            await bulkInsert(
              atx,
              'app.product_uom',
              ['tenant_id', 'id', 'write_id', 'hlc', 'product_id', 'uom_id', 'factor_num', 'factor_den',
               'can_sell', 'can_buy', 'is_default_sell', 'tolerance_bp', 'sort_order'],
              uomRows,
            );
            await bulkInsert(
              atx,
              'app.price_list_item',
              ['tenant_id', 'id', 'write_id', 'hlc', 'price_list_id', 'product_id', 'uom_id', 'unit_price_e4', 'min_qty', 'effective_from'],
              priceRows,
            );
            await bulkInsert(atx, 'app.product_cost', ['tenant_id', 'id', 'write_id', 'hlc', 'product_id', 'cost_e4'], costRows);
            await bulkInsert(
              atx,
              'app.supplier_product',
              ['tenant_id', 'id', 'write_id', 'hlc', 'supplier_id', 'product_id', 'purchase_uom_id', 'is_preferred', 'is_active'],
              linkRows,
            );
            await atx.query(
              `insert into app.catalogue_import
                 (tenant_id, id, write_id, hlc, content_sha256, file_name, row_count, imported_count, rejected_count, imported_by)
               values ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                tenantId, key, clock.next(), file.contentSha256, input.fileName ?? null,
                response.rowCount, response.importedCount, response.rejectedCount, ctx.identity.userId,
              ],
            );
          },
        };
      },
    );
    return result.response;
  }),

  /**
   * Archive the whole catalogue. Products, their units, prices, costs,
   * supplier links and reorder points leave every device's sync bucket;
   * sales, returns and stock movements keep pointing at the archived rows,
   * so history reads exactly as it did. Refused when the live count is not
   * the one the person confirmed.
   */
  removeAll: manageProcedure.input(removeAllProductsInput).mutation(async ({ ctx, input }) => {
    const result = await runIdempotent<RemoveAllResponse>(
      { runner: ctx.deps.runner, clock: ctx.deps.clock },
      ctx.identity,
      { op: 'catalogue.archive_all', idempotencyKey: input.idempotencyKey, claimedHlc: input.claimedHlc, clientWallAt: input.clientWallAt },
      input,
      async (tx) => {
        const live = await tx.query<{ n: string }>(`select count(*)::text n from app.product where deleted_at is null`);
        const count = Number(live.rows[0]!.n);
        if (count !== input.expectedCount) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `CATALOGUE_CHANGED: the catalogue holds ${String(count)} products, not the ${String(input.expectedCount)} you confirmed. Nothing was removed — look again and confirm the new number.`,
          });
        }
        return {
          response: { archivedCount: count },
          apply: async (atx) => {
            const hlc = ctx.deps.clock.next();
            const key = input.idempotencyKey;
            const stamp = `deleted_at = transaction_timestamp(), updated_at = transaction_timestamp(), write_id = $1, hlc = $2`;
            const children = ['product_uom', 'price_list_item', 'product_cost', 'supplier_product', 'reorder_point'];
            for (const table of children) {
              await atx.query(
                `update app.${table} c set ${stamp}
                  where c.deleted_at is null
                    and exists (select 1 from app.product p
                                 where p.tenant_id = c.tenant_id and p.id = c.product_id and p.deleted_at is null)`,
                [key, hlc],
              );
            }
            await atx.query(`update app.product set ${stamp} where deleted_at is null`, [key, hlc]);
          },
        };
      },
    );
    return result.response;
  }),

  /**
   * Switch one product off for sale, or back on. Office-only and online
   * (catalogue.manage is never an offline capability), so this is a plain
   * last-write-wins edit of one flag, made under a key minted per press.
   *
   * Off reaches each counter at its next sync and the counter stops offering
   * the product. A sale a counter rang BEFORE it heard still lands — the
   * server never refuses it for this (sales.ts; ../retired-product.ts).
   * A removed product, or one this tenant does not hold, is NOT_FOUND.
   */
  setSellable: manageProcedure.input(setProductSellableInput).mutation(async ({ ctx, input }) => {
    const result = await runIdempotent<SetSellableResponse>(
      { runner: ctx.deps.runner, clock: ctx.deps.clock },
      ctx.identity,
      { op: 'catalogue.product.set_sellable', idempotencyKey: input.idempotencyKey, claimedHlc: input.claimedHlc, clientWallAt: input.clientWallAt },
      input,
      async (tx) => {
        const found = await tx.query<{ is_sellable: boolean }>(
          `select is_sellable from app.product where id = $1 and deleted_at is null`,
          [input.productId],
        );
        const current = found.rows[0];
        if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'product not found' });
        const changed = current.is_sellable !== input.sellable;
        return {
          response: { productId: input.productId, sellable: input.sellable, changed },
          apply: async (atx) => {
            if (!changed) return;
            await atx.query(
              `update app.product
                  set is_sellable = $2, updated_at = transaction_timestamp(), write_id = $3, hlc = $4
                where id = $1 and deleted_at is null`,
              [input.productId, input.sellable, input.idempotencyKey, ctx.deps.clock.next()],
            );
          },
        };
      },
    );
    return result.response;
  }),
});
