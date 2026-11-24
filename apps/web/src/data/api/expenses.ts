/**
 * Business expenses and the MANAGEMENT P&L sheet, from the client side
 * (migration 0033; apps/api/src/routers/expenses.ts). ONLINE ONLY.
 *
 * An expense is an office act against a live server: the expense tables are
 * in no sync bucket and none of this rides the outbox — with the radio off,
 * every call here refuses out loud and nothing is queued. A recorded expense
 * is an OPERATIONAL record, not a journal entry; nothing here touches the
 * ledger.
 *
 * Money arrives as decimal strings and becomes `bigint` at this boundary
 * (ADR-0004) — `asScaled` throws on a JSON number, which is what catches a
 * server regression before it reaches a screen. An amount a person types goes
 * OUT as the text they typed, in major units, and is parsed exactly on the
 * server against the jurisdiction pack; this module never does arithmetic on
 * it.
 */
import {
  listExpensesInput,
  profitSheetInput,
  recordExpenseInput,
  voidExpenseInput,
  type ExpensePaidFrom,
  type ListExpensesInput,
  type ProfitSheetInput,
  type RecordExpenseInput,
  type VoidExpenseInput,
} from '@erp/contracts';
import {
  ApiShapeError,
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

/** Words for where the money came from — product chrome, never tenant vocabulary. */
export const PAID_FROM_TEXT: Readonly<Record<ExpensePaidFrom, string>> = {
  CASH: 'Cash',
  BANK: 'Bank',
  MOBILE_MONEY: 'Mobile money',
  OTHER: 'Other',
};

export interface ExpenseCategory {
  readonly categoryId: string;
  readonly code: string | null;
  readonly name: string;
}

export interface CategoryAmount {
  readonly categoryId: string;
  readonly categoryName: string;
  readonly amountMinor: bigint;
}

export interface ProfitFigures {
  /** Ex-tax, after discounts, net of voids and returns. */
  readonly netSalesMinor: bigint;
  readonly cogsMinor: bigint;
  /** The part of COGS valued at the stated cost price (no costed receipt). */
  readonly cogsAtStatedCostMinor: bigint;
  /** False when something sold has no cost at all — COGS is understated. */
  readonly cogsComplete: boolean;
  readonly missingCostCount: number; // lint-money-ignore — a count of products, not minor units
  readonly grossProfitMinor: bigint;
  /** Percent × 10⁴; null when there were no sales to divide by. Never 0 for "unknown". */
  readonly grossMarginPctE4: bigint | null;
  readonly expenses: readonly CategoryAmount[];
  readonly totalExpensesMinor: bigint;
  readonly netProfitMinor: bigint;
}

export interface ProfitSheetLocation extends ProfitFigures {
  readonly locationId: string;
  readonly locationCode: string;
  readonly locationName: string;
}

export interface MissingCostLine {
  readonly productId: string;
  readonly skuCode: string;
  readonly productName: string;
  readonly uomCode: string;
  readonly qtyScale: number;
  /** Net quantity sold in the period, scaled at `qtyScale`, in the stocking unit. */
  readonly qtySold: bigint;
  /** The same, per location it sold at with no cost. */
  readonly byLocation: readonly { readonly locationId: string; readonly qtySold: bigint }[];
}

export interface ProfitSheet {
  readonly from: string;
  readonly to: string;
  /** The server's own words for what these figures are — shown on the sheet. */
  readonly note: string;
  readonly wholeBusinessIncluded: boolean;
  readonly consolidated: ProfitFigures;
  readonly wholeBusiness: { readonly expenses: readonly CategoryAmount[]; readonly totalExpensesMinor: bigint } | null;
  readonly locations: readonly ProfitSheetLocation[];
  readonly missingCost: readonly MissingCostLine[];
  readonly method: string;
}

export interface ExpenseEntry {
  readonly expenseId: string;
  readonly expenseDate: string;
  /** Null = the whole business. */
  readonly locationId: string | null;
  readonly locationCode: string | null;
  readonly locationName: string | null;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly amountMinor: bigint;
  readonly paidFrom: ExpensePaidFrom;
  readonly payee: string | null;
  readonly reference: string | null;
  readonly note: string | null;
  readonly recordedByName: string | null;
  readonly voided: boolean;
  readonly voidReason: string | null;
}

export interface ExpenseList {
  readonly from: string;
  readonly to: string;
  readonly wholeBusinessIncluded: boolean;
  readonly expenses: readonly ExpenseEntry[];
}

export interface RecordedExpense {
  readonly expenseId: string;
  readonly categoryName: string;
  readonly categoryCreated: boolean;
  readonly amountMinor: bigint;
}

export interface VoidedExpense {
  readonly voidId: string;
  readonly expenseId: string;
}

function asPaidFrom(value: unknown, what: string): ExpensePaidFrom {
  const s = asString(value, what);
  if (s in PAID_FROM_TEXT) return s as ExpensePaidFrom;
  throw new ApiShapeError(`${what}: unknown paid-from "${s}"`);
}

function mapAmounts(value: unknown, what: string): CategoryAmount[] {
  return asArray(value, what).map((x, i) => {
    const r = asRecord(x, `${what}[${i}]`);
    return {
      categoryId: asString(r['categoryId'], 'categoryId'),
      categoryName: asString(r['categoryName'], 'categoryName'),
      amountMinor: asScaled(r['amountMinor'], 'amountMinor'),
    };
  });
}

function mapFigures(r: Record<string, unknown>, what: string): ProfitFigures {
  return {
    netSalesMinor: asScaled(r['netSalesMinor'], `${what}.netSalesMinor`),
    cogsMinor: asScaled(r['cogsMinor'], `${what}.cogsMinor`),
    cogsAtStatedCostMinor: asScaled(r['cogsAtStatedCostMinor'], `${what}.cogsAtStatedCostMinor`),
    cogsComplete: asBoolean(r['cogsComplete'], `${what}.cogsComplete`),
    missingCostCount: asCount(r['missingCostCount'], `${what}.missingCostCount`),
    grossProfitMinor: asScaled(r['grossProfitMinor'], `${what}.grossProfitMinor`),
    grossMarginPctE4: asOptionalScaled(r['grossMarginPctE4'], `${what}.grossMarginPctE4`),
    expenses: mapAmounts(r['expenses'], `${what}.expenses`),
    totalExpensesMinor: asScaled(r['totalExpensesMinor'], `${what}.totalExpensesMinor`),
    netProfitMinor: asScaled(r['netProfitMinor'], `${what}.netProfitMinor`),
  };
}

function mapProfitSheet(json: unknown): ProfitSheet {
  const r = asRecord(json, 'expenses.profitSheet');
  const wb = r['wholeBusiness'] === null || r['wholeBusiness'] === undefined ? null : asRecord(r['wholeBusiness'], 'wholeBusiness');
  return {
    from: asString(r['from'], 'from'),
    to: asString(r['to'], 'to'),
    note: asString(r['note'], 'note'),
    wholeBusinessIncluded: asBoolean(r['wholeBusinessIncluded'], 'wholeBusinessIncluded'),
    consolidated: mapFigures(asRecord(r['consolidated'], 'consolidated'), 'consolidated'),
    wholeBusiness:
      wb === null
        ? null
        : {
            expenses: mapAmounts(wb['expenses'], 'wholeBusiness.expenses'),
            totalExpensesMinor: asScaled(wb['totalExpensesMinor'], 'wholeBusiness.totalExpensesMinor'),
          },
    locations: asArray(r['locations'], 'locations').map((x, i) => {
      const l = asRecord(x, `locations[${i}]`);
      return {
        locationId: asString(l['locationId'], 'locationId'),
        locationCode: asString(l['locationCode'], 'locationCode'),
        locationName: asString(l['locationName'], 'locationName'),
        ...mapFigures(l, `locations[${i}]`),
      };
    }),
    missingCost: asArray(r['missingCost'], 'missingCost').map((x, i) => {
      const m = asRecord(x, `missingCost[${i}]`);
      return {
        productId: asString(m['productId'], 'productId'),
        skuCode: asString(m['skuCode'], 'skuCode'),
        productName: asString(m['productName'], 'productName'),
        uomCode: asString(m['uomCode'], 'uomCode'),
        qtyScale: asCount(m['qtyScale'], 'qtyScale'),
        qtySold: asScaled(m['qtySold'], 'qtySold'),
        byLocation: asArray(m['byLocation'], 'byLocation').map((y, j) => {
          const b = asRecord(y, `missingCost[${i}].byLocation[${j}]`);
          return { locationId: asString(b['locationId'], 'locationId'), qtySold: asScaled(b['qtySold'], 'qtySold') };
        }),
      };
    }),
    method: asString(r['method'], 'method'),
  };
}

function mapExpenses(json: unknown): ExpenseList {
  const r = asRecord(json, 'expenses.list');
  return {
    from: asString(r['from'], 'from'),
    to: asString(r['to'], 'to'),
    wholeBusinessIncluded: asBoolean(r['wholeBusinessIncluded'], 'wholeBusinessIncluded'),
    expenses: asArray(r['expenses'], 'expenses').map((x, i) => {
      const e = asRecord(x, `expenses[${i}]`);
      return {
        expenseId: asString(e['expenseId'], 'expenseId'),
        expenseDate: asString(e['expenseDate'], 'expenseDate'),
        locationId: asOptionalString(e['locationId'], 'locationId'),
        locationCode: asOptionalString(e['locationCode'], 'locationCode'),
        locationName: asOptionalString(e['locationName'], 'locationName'),
        categoryId: asString(e['categoryId'], 'categoryId'),
        categoryName: asString(e['categoryName'], 'categoryName'),
        amountMinor: asScaled(e['amountMinor'], 'amountMinor'),
        paidFrom: asPaidFrom(e['paidFrom'], 'paidFrom'),
        payee: asOptionalString(e['payee'], 'payee'),
        reference: asOptionalString(e['reference'], 'reference'),
        note: asOptionalString(e['note'], 'note'),
        recordedByName: asOptionalString(e['recordedByName'], 'recordedByName'),
        voided: asBoolean(e['voided'], 'voided'),
        voidReason: asOptionalString(e['voidReason'], 'voidReason'),
      };
    }),
  };
}

export function fetchProfitSheet(
  input: ProfitSheetInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<ProfitSheet>> {
  const bad = guard(profitSheetInput, 'expenses.profitSheet', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiQuery('expenses.profitSheet', input, mapProfitSheet, options);
}

export function fetchExpenses(
  input: ListExpensesInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<ExpenseList>> {
  const bad = guard(listExpensesInput, 'expenses.list', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiQuery('expenses.list', input, mapExpenses, options);
}

export function fetchExpenseCategories(options: ApiCallOptions = {}): Promise<ApiResult<readonly ExpenseCategory[]>> {
  return apiQuery(
    'expenses.categories',
    undefined,
    (json) =>
      asArray(asRecord(json, 'expenses.categories')['categories'], 'categories').map((x, i) => {
        const c = asRecord(x, `categories[${i}]`);
        return {
          categoryId: asString(c['categoryId'], 'categoryId'),
          code: asOptionalString(c['code'], 'code'),
          name: asString(c['name'], 'name'),
        };
      }),
    options,
  );
}

export function recordExpense(
  input: RecordExpenseInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<RecordedExpense>> {
  const bad = guard(recordExpenseInput, 'expenses.record', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate(
    'expenses.record',
    input,
    (json) => {
      const r = asRecord(json, 'expenses.record');
      return {
        expenseId: asString(r['expenseId'], 'expenseId'),
        categoryName: asString(r['categoryName'], 'categoryName'),
        categoryCreated: asBoolean(r['categoryCreated'], 'categoryCreated'),
        amountMinor: asScaled(r['amountMinor'], 'amountMinor'),
      };
    },
    options,
  );
}

export function voidExpense(
  input: VoidExpenseInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<VoidedExpense>> {
  const bad = guard(voidExpenseInput, 'expenses.void', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate(
    'expenses.void',
    input,
    (json) => {
      const r = asRecord(json, 'expenses.void');
      return { voidId: asString(r['voidId'], 'voidId'), expenseId: asString(r['expenseId'], 'expenseId') };
    },
    options,
  );
}
