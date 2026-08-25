/**
 * STATEMENTS — everything derives from the lines.
 *
 * 05 §5.9.1: the trial balance, the P&L and the balance sheet are one query
 * shape. Drop `location_id` from the projection and the GROUP BY and the same
 * query is the consolidated statement. That equivalence is the payoff of the
 * location dimension, and §5.9.1 is explicit that it must be **asserted as a
 * test, not assumed** — so it is, in `posting-statements.test.ts`.
 *
 * ── SIGN CONVENTION, STATED ONCE AND ONLY ONCE ────────────────────────────
 * The ledger stores two non-negative columns. Everything below derives from
 * `Σ debit − Σ credit`, which is the ONLY primitive: for an ASSET or EXPENSE
 * that is the natural balance, and for INCOME, LIABILITY or EQUITY the natural
 * balance is its negation.
 *
 * `netDebitMinor` is therefore raw and unopinionated, and `amountMinor` is the
 * figure a reader expects — revenue positive on a P&L, a payable positive on a
 * balance sheet. Both are returned. Presenting only the second would hide the
 * primitive; presenting only the first makes every caller re-derive the
 * convention, and §5.2.1 rejects a signed-amount ledger precisely because "one
 * of them will get it wrong".
 *
 * ── NO MATERIALISED ROLLUP YET, DELIBERATELY ──────────────────────────────
 * §5.9.1 specifies `gl_balance` for report performance and immediately records
 * the correction that matters: as designed it was refreshed nightly while
 * reports read it, so between a posting and the job every report was stale and
 * the rollup WAS authoritative in practice. It is not built here. These
 * queries read the lines, which is correct by construction and fast enough for
 * a ledger with no rows in it. When it is built it must be maintained inside
 * the posting transaction, with the nightly recompute demoted to a
 * verification pass that alerts on a difference — and arbitrary date ranges
 * must still read the lines, because a report spanning 12 March to 4 April is
 * not a rollup query and must not silently become one.
 */
import type { Queryable } from '../testing/harness.js';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

export interface StatementRow {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly accountType: AccountType;
  readonly reportLineKey: string;
  /** null on a consolidated statement — the same query without the grouping. */
  readonly locationId: string | null;
  /**
   * The location's own code, when the statement is grouped by location.
   *
   * Carried because a per-location trial balance renders the SAME account
   * once per outlet, and a reader looking at three rows reading "Till cash"
   * with no way to tell them apart cannot use the statement at all. Found by
   * generating a month of demo data — an empty ledger could never have shown
   * it, which is most of the argument for generating one.
   */
  readonly locationCode: string | null;
  /** Σ debit − Σ credit. The primitive; sign is the ledger's, not a reader's. */
  readonly netDebitMinor: bigint;
  /** The same figure in the account's NATURAL direction. Revenue positive. */
  readonly amountMinor: bigint;
}

export interface StatementQuery {
  /** Periods to include. Empty means every period. */
  readonly periodIds?: readonly string[];
  /** Narrow to these locations. Empty or absent means all. */
  readonly locationIds?: readonly string[];
  /** Group by location. False gives the consolidated statement. */
  readonly byLocation?: boolean;
}

function naturalSign(type: AccountType): bigint {
  return type === 'ASSET' || type === 'EXPENSE' ? 1n : -1n;
}

const BASE_SQL = (byLocation: boolean) => `
  select a.id as account_id, a.code, a.name, a.account_type, a.report_line_key,
         ${byLocation ? 'l.location_id' : 'null::uuid as location_id'},
         ${byLocation ? 'loc.code as location_code' : 'null::text as location_code'},
         (sum(l.debit_minor) - sum(l.credit_minor))::text as net_debit_minor
    from app.journal_line l
    join app.journal_entry e on e.tenant_id = l.tenant_id and e.id = l.journal_entry_id
    join app.gl_account a    on a.tenant_id = l.tenant_id and a.id = l.account_id
    ${byLocation ? 'join app.location loc on loc.tenant_id = l.tenant_id and loc.id = l.location_id' : ''}
   -- 'posted' is the ONLY posted state (§5.3). There is no 'reversed' value to
   -- be accidentally excluded: a reversal is its own posted entry sitting
   -- alongside the original, and both belong in the answer.
   where e.status = 'posted'
     and ($1::uuid[] is null or e.period_id = any($1::uuid[]))
     and ($2::uuid[] is null or l.location_id = any($2::uuid[]))
   group by a.id, a.code, a.name, a.account_type, a.report_line_key
            ${byLocation ? ', l.location_id, loc.code' : ''}
   order by a.code${byLocation ? ', loc.code' : ''}
`;

async function statementRows(tx: Queryable, q: StatementQuery): Promise<StatementRow[]> {
  const res = await tx.query<{
    account_id: string; code: string; name: string; account_type: AccountType;
    report_line_key: string; location_id: string | null; location_code: string | null;
    net_debit_minor: string;
  }>(BASE_SQL(q.byLocation === true), [
    q.periodIds !== undefined && q.periodIds.length > 0 ? [...q.periodIds] : null,
    q.locationIds !== undefined && q.locationIds.length > 0 ? [...q.locationIds] : null,
  ]);
  return res.rows.map((r) => {
    const netDebitMinor = BigInt(r.net_debit_minor);
    return {
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      accountType: r.account_type,
      reportLineKey: r.report_line_key,
      locationId: r.location_id,
      locationCode: r.location_code,
      netDebitMinor,
      amountMinor: netDebitMinor * naturalSign(r.account_type),
    };
  });
}

export interface LocationBalance {
  readonly locationId: string;
  readonly debitMinor: bigint;
  readonly creditMinor: bigint;
  readonly balanced: boolean;
}

export interface TrialBalance {
  readonly rows: readonly StatementRow[];
  readonly debitMinor: bigint;
  readonly creditMinor: bigint;
  /** Σ debit = Σ credit across everything in scope. */
  readonly balanced: boolean;
  /**
   * Per location — only possible because entries balance per location
   * (§5.5.3), and §5.9.2 calls it "the single most useful diagnostic in the
   * system": an out-of-balance location names the entry that broke it.
   */
  readonly byLocation: readonly LocationBalance[];
}

export async function trialBalance(tx: Queryable, q: StatementQuery = {}): Promise<TrialBalance> {
  // Always grouped by location: the per-location answer contains the
  // consolidated one, and computing them from one read is what makes it
  // impossible for the two to disagree.
  const rows = await statementRows(tx, { ...q, byLocation: true });

  let debit = 0n;
  let credit = 0n;
  const per = new Map<string, { dr: bigint; cr: bigint }>();
  for (const row of rows) {
    const at = per.get(row.locationId ?? '') ?? { dr: 0n, cr: 0n };
    if (row.netDebitMinor >= 0n) {
      debit += row.netDebitMinor;
      at.dr += row.netDebitMinor;
    } else {
      credit += -row.netDebitMinor;
      at.cr += -row.netDebitMinor;
    }
    per.set(row.locationId ?? '', at);
  }

  return {
    rows,
    debitMinor: debit,
    creditMinor: credit,
    balanced: debit === credit,
    byLocation: [...per.entries()]
      .map(([locationId, v]) => ({
        locationId,
        debitMinor: v.dr,
        creditMinor: v.cr,
        balanced: v.dr === v.cr,
      }))
      .sort((a, b) => (a.locationId < b.locationId ? -1 : 1)),
  };
}

export interface ProfitAndLoss {
  readonly rows: readonly StatementRow[];
  readonly revenueMinor: bigint;
  readonly expenseMinor: bigint;
  /** Revenue less expenses, in minor units. Negative is a loss. */
  readonly resultMinor: bigint;
}

/**
 * INCOME and EXPENSE only.
 *
 * **No elimination step for transfers**, and none is needed: a transfer never
 * touches an income account at either end (§5.6.3), so moving stock between
 * outlets cannot inflate consolidated revenue however the report is grouped.
 * That is a structural guarantee rather than a reporting one, which is why
 * this function has no special case in it.
 */
export async function profitAndLoss(tx: Queryable, q: StatementQuery = {}): Promise<ProfitAndLoss> {
  const rows = (await statementRows(tx, q)).filter(
    (r) => r.accountType === 'INCOME' || r.accountType === 'EXPENSE',
  );
  let revenue = 0n;
  let expense = 0n;
  for (const r of rows) {
    if (r.accountType === 'INCOME') revenue += r.amountMinor;
    else expense += r.amountMinor;
  }
  return { rows, revenueMinor: revenue, expenseMinor: expense, resultMinor: revenue - expense };
}

export interface BalanceSheet {
  readonly rows: readonly StatementRow[];
  readonly assetMinor: bigint;
  readonly liabilityMinor: bigint;
  readonly equityMinor: bigint;
  /**
   * Assets − (liabilities + equity). Zero on a CLOSED set of books.
   *
   * It is NOT zero mid-year and that is not a defect: the period's profit sits
   * in income and expense accounts until year-end close moves it to retained
   * earnings (§5.9.4). `resultMinor` from the P&L over the same scope is
   * exactly the difference, and `reconciles` checks that identity — which is a
   * far stronger statement than "assets equal liabilities plus equity", and
   * the one that actually holds every day of the year.
   */
  readonly gapMinor: bigint;
}

export async function balanceSheet(tx: Queryable, q: StatementQuery = {}): Promise<BalanceSheet> {
  const rows = (await statementRows(tx, q)).filter(
    (r) => r.accountType === 'ASSET' || r.accountType === 'LIABILITY' || r.accountType === 'EQUITY',
  );
  let asset = 0n;
  let liability = 0n;
  let equity = 0n;
  for (const r of rows) {
    if (r.accountType === 'ASSET') asset += r.amountMinor;
    else if (r.accountType === 'LIABILITY') liability += r.amountMinor;
    else equity += r.amountMinor;
  }
  return {
    rows,
    assetMinor: asset,
    liabilityMinor: liability,
    equityMinor: equity,
    gapMinor: asset - (liability + equity),
  };
}

/**
 * The identity that holds on any day, closed or not:
 *
 *   assets − (liabilities + equity) === revenue − expenses
 *
 * Both sides derived from the same lines over the same scope. A difference
 * means the two statements disagree about one ledger, which is the failure a
 * home-grown GL produces most often and detects least.
 */
export async function statementsReconcile(
  tx: Queryable,
  q: StatementQuery = {},
): Promise<{ reconciles: boolean; gapMinor: bigint; resultMinor: bigint }> {
  const [bs, pl] = await Promise.all([balanceSheet(tx, q), profitAndLoss(tx, q)]);
  return {
    reconciles: bs.gapMinor === pl.resultMinor,
    gapMinor: bs.gapMinor,
    resultMinor: pl.resultMinor,
  };
}

/**
 * Σ INTERLOC_CLEARING across the tenant, which must be zero.
 *
 * On a per-location balance sheet the clearing account appears as "due
 * to/from other locations" and is what makes that sheet balance. On the
 * consolidated sheet it must sum to zero and drop out — if it does not, the
 * books are wrong and the close gate should already have blocked (§5.9.3).
 *
 * Takes the ACCOUNT rather than the role, because by report time the mapping
 * has already been applied and the ledger holds accounts.
 */
export async function clearingNet(
  tx: Queryable,
  clearingAccountId: string,
  q: StatementQuery = {},
): Promise<bigint> {
  const rows = await statementRows(tx, q);
  return rows
    .filter((r) => r.accountId === clearingAccountId)
    .reduce((a, r) => a + r.netDebitMinor, 0n);
}
