/**
 * The ledger, from the client side. READ-ONLY, ONLINE-ONLY.
 *
 * No journal table is in any sync bucket (05 §5.2.6) and none of this rides
 * the outbox: the books are the server's, a partitioned device holds none of
 * them, and with the radio off this module refuses out loud like every other
 * online-only read. Nothing is queued when a call fails.
 *
 * Money arrives as decimal strings and becomes `bigint` at this boundary
 * (ADR-0004) — `asScaled` throws on a JSON number, which is what catches a
 * server regression before it reaches a screen.
 */
import { listPostingExceptionsInput, statementQueryInput, type StatementQueryInput } from '@erp/contracts';
import {
  apiQuery,
  asArray,
  asBoolean,
  asCount,
  asOptionalString,
  asRecord,
  asScaled,
  asString,
  type ApiCallOptions,
  type ApiResult,
} from './client';
import { guard } from './guard';

export interface StatementRow {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly accountType: string;
  readonly reportLineKey: string;
  readonly locationId: string | null;
  /** The outlet's own code — without it a per-location statement is unreadable. */
  readonly locationCode: string | null;
  /** Σ debit − Σ credit: the ledger's raw primitive. */
  readonly netDebitMinor: bigint;
  /** The natural-direction figure a reader expects. Revenue positive. */
  readonly amountMinor: bigint;
}

export interface TrialBalance {
  readonly accountCount: number;
  readonly rows: readonly StatementRow[];
  readonly debitMinor: bigint;
  readonly creditMinor: bigint;
  readonly balanced: boolean;
  readonly byLocation: readonly {
    readonly locationId: string;
    readonly debitMinor: bigint;
    readonly creditMinor: bigint;
    readonly balanced: boolean;
  }[];
}

export interface ProfitAndLoss {
  readonly accountCount: number;
  readonly rows: readonly StatementRow[];
  readonly revenueMinor: bigint;
  readonly expenseMinor: bigint;
  readonly resultMinor: bigint;
}

export interface BalanceSheet {
  readonly accountCount: number;
  readonly rows: readonly StatementRow[];
  readonly assetMinor: bigint;
  readonly liabilityMinor: bigint;
  readonly equityMinor: bigint;
  /** NOT zero mid-year — the unclosed profit. See the screen's copy. */
  readonly gapMinor: bigint;
  /** gap === P&L result over the same scope: the identity that holds daily. */
  readonly reconciles: boolean;
  readonly resultMinor: bigint;
}

export interface PostingException {
  readonly exceptionId: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly locationId: string;
  readonly documentDate: string;
  readonly postingRole: string | null;
  readonly errorCode: string;
  readonly errorDetail: string | null;
  readonly severity: number;
  readonly openedAt: string;
  readonly resolvedAt: string | null;
}

export interface PostingExceptionList {
  readonly openCount: number;
  readonly exceptions: readonly PostingException[];
}

function mapRow(entry: unknown, what: string): StatementRow {
  const r = asRecord(entry, what);
  return {
    accountId: asString(r['accountId'], `${what}.accountId`),
    code: asString(r['code'], `${what}.code`),
    name: asString(r['name'], `${what}.name`),
    accountType: asString(r['accountType'], `${what}.accountType`),
    reportLineKey: asString(r['reportLineKey'], `${what}.reportLineKey`),
    locationId: asOptionalString(r['locationId'], `${what}.locationId`),
    locationCode: asOptionalString(r['locationCode'], `${what}.locationCode`),
    netDebitMinor: asScaled(r['netDebitMinor'], `${what}.netDebitMinor`),
    amountMinor: asScaled(r['amountMinor'], `${what}.amountMinor`),
  };
}

export function fetchTrialBalance(
  input: StatementQueryInput = {},
  options: ApiCallOptions = {},
): Promise<ApiResult<TrialBalance>> {
  const bad = guard(statementQueryInput, 'ledger.trialBalance', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiQuery('ledger.trialBalance', input, (json) => {
    const r = asRecord(json, 'ledger.trialBalance');
    return {
      accountCount: asCount(r['accountCount'], 'accountCount'),
      rows: asArray(r['rows'], 'rows').map((x, i) => mapRow(x, `rows[${i}]`)),
      debitMinor: asScaled(r['debitMinor'], 'debitMinor'),
      creditMinor: asScaled(r['creditMinor'], 'creditMinor'),
      balanced: asBoolean(r['balanced'], 'balanced'),
      byLocation: asArray(r['byLocation'], 'byLocation').map((x, i) => {
        const l = asRecord(x, `byLocation[${i}]`);
        return {
          locationId: asString(l['locationId'], 'locationId'),
          debitMinor: asScaled(l['debitMinor'], 'debitMinor'),
          creditMinor: asScaled(l['creditMinor'], 'creditMinor'),
          balanced: asBoolean(l['balanced'], 'balanced'),
        };
      }),
    };
  }, options);
}

export function fetchProfitAndLoss(
  input: StatementQueryInput = {},
  options: ApiCallOptions = {},
): Promise<ApiResult<ProfitAndLoss>> {
  const bad = guard(statementQueryInput, 'ledger.profitAndLoss', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiQuery('ledger.profitAndLoss', input, (json) => {
    const r = asRecord(json, 'ledger.profitAndLoss');
    return {
      accountCount: asCount(r['accountCount'], 'accountCount'),
      rows: asArray(r['rows'], 'rows').map((x, i) => mapRow(x, `rows[${i}]`)),
      revenueMinor: asScaled(r['revenueMinor'], 'revenueMinor'),
      expenseMinor: asScaled(r['expenseMinor'], 'expenseMinor'),
      resultMinor: asScaled(r['resultMinor'], 'resultMinor'),
    };
  }, options);
}

export function fetchBalanceSheet(
  input: StatementQueryInput = {},
  options: ApiCallOptions = {},
): Promise<ApiResult<BalanceSheet>> {
  const bad = guard(statementQueryInput, 'ledger.balanceSheet', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiQuery('ledger.balanceSheet', input, (json) => {
    const r = asRecord(json, 'ledger.balanceSheet');
    return {
      accountCount: asCount(r['accountCount'], 'accountCount'),
      rows: asArray(r['rows'], 'rows').map((x, i) => mapRow(x, `rows[${i}]`)),
      assetMinor: asScaled(r['assetMinor'], 'assetMinor'),
      liabilityMinor: asScaled(r['liabilityMinor'], 'liabilityMinor'),
      equityMinor: asScaled(r['equityMinor'], 'equityMinor'),
      gapMinor: asScaled(r['gapMinor'], 'gapMinor'),
      reconciles: asBoolean(r['reconciles'], 'reconciles'),
      resultMinor: asScaled(r['resultMinor'], 'resultMinor'),
    };
  }, options);
}

export function fetchPostingExceptions(
  options: ApiCallOptions = {},
): Promise<ApiResult<PostingExceptionList>> {
  const input = {};
  const bad = guard(listPostingExceptionsInput, 'ledger.postingExceptions', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiQuery('ledger.postingExceptions', input, (json) => {
    const r = asRecord(json, 'ledger.postingExceptions');
    return {
      openCount: asCount(r['openCount'], 'openCount'),
      exceptions: asArray(r['exceptions'], 'exceptions').map((x, i) => {
        const e = asRecord(x, `exceptions[${i}]`);
        return {
          exceptionId: asString(e['exceptionId'], 'exceptionId'),
          sourceKind: asString(e['sourceKind'], 'sourceKind'),
          sourceId: asString(e['sourceId'], 'sourceId'),
          locationId: asString(e['locationId'], 'locationId'),
          documentDate: asString(e['documentDate'], 'documentDate'),
          postingRole: asOptionalString(e['postingRole'], 'postingRole'),
          errorCode: asString(e['errorCode'], 'errorCode'),
          errorDetail: asOptionalString(e['errorDetail'], 'errorDetail'),
          severity: asCount(e['severity'], 'severity'),
          openedAt: asString(e['openedAt'], 'openedAt'),
          resolvedAt: asOptionalString(e['resolvedAt'], 'resolvedAt'),
        };
      }),
    };
  }, options);
}
