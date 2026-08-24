/**
 * BANK AND MOBILE MONEY RECONCILIATION.
 *
 * CLAUDE.md §2.8 makes this required, and the brief's reason is the right one:
 * it is where undetected errors in a home-grown GL surface first, because it
 * is the only routine control that compares the ledger against a document the
 * system did not produce. Every other check in this codebase is the ledger
 * agreeing with itself.
 *
 * ── THIS MODULE CANNOT EDIT THE LEDGER, AND THAT IS THE POINT ─────────────
 * Nothing here writes to `journal_entry` or `journal_line`. There is no
 * "adjust the books to agree with the bank" function, and there must never be
 * one: a control that can rewrite the thing it is checking is not a control.
 * An unmatched statement line that turns out to be genuine — a bank charge,
 * credit interest, a customer's direct transfer — becomes a NEW journal entry
 * raised through the ordinary posting path, with its own source document.
 *
 * ── AUTO-MATCHING IS CONSERVATIVE ON PURPOSE ──────────────────────────────
 * Exact amount AND a date inside a window AND a matching reference. **Amount
 * alone never auto-matches.** In a business selling bagged cement at a fixed
 * price, identical amounts on the same day are routine — a confident wrong
 * match is worse than no match, because it closes the difference that was the
 * only evidence something was wrong.
 */
import type { Queryable } from '../testing/harness.js';

export interface StatementLine {
  readonly id: string;
  readonly lineNo: number;
  readonly valueDate: string;
  readonly description: string | null;
  readonly reference: string | null;
  readonly amountMinor: bigint;
  /** 'I' money arrived, 'O' money left — the bank's words, not the ledger's. */
  readonly direction: 'I' | 'O';
}

export interface BookLine {
  readonly journalEntryId: string;
  readonly lineNo: number;
  readonly documentDate: string;
  readonly memo: string | null;
  /** Positive when the cash account was DEBITED (money in), negative when credited. */
  readonly netDebitMinor: bigint;
  readonly reference: string | null;
}

export interface MatchProposal {
  readonly statementLineId: string;
  readonly journalEntryId: string;
  readonly journalLineNo: number;
  readonly method: 'auto';
}

export interface MatchOptions {
  /** How many days apart a value date and a document date may be. */
  readonly dateWindowDays?: number;
}

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 86_400_000);
}

/** Loose enough to survive a bank's formatting, strict enough to mean something. */
function referencesAgree(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const norm = (s: string) => s.replace(/[^a-z0-9]/gi, '').toUpperCase();
  const x = norm(a);
  const y = norm(b);
  if (x.length < 4 || y.length < 4) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * Propose matches. THREE conditions, all required.
 *
 * The direction check is the one that is easy to get backwards, and it is the
 * classic reconciliation error: the bank's inbound line must correspond to a
 * DEBIT of the cash account in our books. The bank says "credit" for the same
 * event, from its own side of the relationship. Hence `netDebitMinor > 0` for
 * `direction === 'I'`, written out rather than inferred.
 */
export function proposeMatches(
  statementLines: readonly StatementLine[],
  bookLines: readonly BookLine[],
  opts: MatchOptions = {},
): MatchProposal[] {
  const window = opts.dateWindowDays ?? 3;
  const proposals: MatchProposal[] = [];
  const takenBook = new Set<string>();

  for (const s of statementLines) {
    const wanted = s.direction === 'I' ? s.amountMinor : -s.amountMinor;
    const candidates = bookLines.filter((b) => {
      const key = `${b.journalEntryId}:${b.lineNo}`;
      if (takenBook.has(key)) return false;
      if (b.netDebitMinor !== wanted) return false;
      if (daysBetween(s.valueDate, b.documentDate) > window) return false;
      return referencesAgree(s.reference, b.reference);
    });

    // AMBIGUITY IS NOT A MATCH. Two candidates that both satisfy all three
    // conditions means the reference is not discriminating, and picking the
    // first would be the confident wrong match this whole design avoids.
    if (candidates.length !== 1) continue;

    const b = candidates[0]!;
    takenBook.add(`${b.journalEntryId}:${b.lineNo}`);
    proposals.push({
      statementLineId: s.id,
      journalEntryId: b.journalEntryId,
      journalLineNo: b.lineNo,
      method: 'auto',
    });
  }
  return proposals;
}

export interface MonthlyView {
  readonly cashAccountId: string;
  /** Closing balance the bank stated. */
  readonly statementClosingMinor: bigint;
  /** In the books, not yet on the statement. */
  readonly depositsInTransitMinor: bigint;
  readonly outstandingPaymentsMinor: bigint;
  /** On the statement, not yet in the books. MUST be nil at close. */
  readonly statementItemsNotInBooksMinor: bigint;
  /** statement + in transit − outstanding + not-in-books. */
  readonly adjustedBalanceMinor: bigint;
  /** What the ledger says this account holds at this location. */
  readonly ledgerBalanceMinor: bigint;
  /** Adjusted − ledger. Zero, or the control has found something. */
  readonly unexplainedMinor: bigint;
  readonly unmatchedStatementLines: number;
  readonly unmatchedBookLines: number;
}

/**
 * The monthly view, in the shape §5.7.3 lays out.
 *
 * The last line is the only one that matters: an unexplained difference of
 * zero, or a number somebody has to account for. Everything above it exists to
 * turn "the bank and the books disagree" into "they disagree BY THIS, and here
 * is what is sitting between them".
 */
export async function monthlyView(
  tx: Queryable,
  cashAccountId: string,
  periodEnd: string,
): Promise<MonthlyView> {
  const acc = await tx.query<{ account_id: string; location_id: string; opening_balance_minor: string }>(
    `select account_id, location_id, opening_balance_minor::text
       from app.cash_account where id = $1`,
    [cashAccountId],
  );
  const account = acc.rows[0];
  if (account === undefined) throw new Error(`no cash account ${cashAccountId}`);

  const stmt = await tx.query<{ closing_balance_minor: string }>(
    `select closing_balance_minor::text
       from app.bank_statement
      where cash_account_id = $1 and period_end <= $2::date
      order by period_end desc limit 1`,
    [cashAccountId, periodEnd],
  );
  const statementClosing = BigInt(stmt.rows[0]?.closing_balance_minor ?? '0');

  // In the books and unmatched: a debit is a deposit in transit, a credit an
  // outstanding payment.
  const book = await tx.query<{ in_transit: string; outstanding: string; n: string }>(
    `select
        coalesce(sum(case when l.debit_minor > 0 then l.debit_minor else 0 end), 0)::text as in_transit,
        coalesce(sum(case when l.credit_minor > 0 then l.credit_minor else 0 end), 0)::text as outstanding,
        count(*)::text as n
       from app.journal_line l
       join app.journal_entry e on e.tenant_id = l.tenant_id and e.id = l.journal_entry_id
      where e.status = 'posted'
        and l.account_id = $1 and l.location_id = $2
        and e.document_date <= $3::date
        and not exists (
          select 1 from app.reconciliation_match m
           where m.journal_entry_id = l.journal_entry_id
             and m.journal_line_no = l.line_no)`,
    [account.account_id, account.location_id, periodEnd],
  );
  const inTransit = BigInt(book.rows[0]?.in_transit ?? '0');
  const outstanding = BigInt(book.rows[0]?.outstanding ?? '0');
  const unmatchedBook = Number(book.rows[0]?.n ?? '0');

  // On the statement and unmatched. Signed in the BOOKS' direction, so it can
  // be added to the reconciliation without a reader translating twice.
  const unmatchedStmt = await tx.query<{ net: string; n: string }>(
    `select coalesce(sum(case when sl.direction = 'I' then sl.amount_minor
                              else -sl.amount_minor end), 0)::text as net,
            count(*)::text as n
       from app.bank_statement_line sl
       join app.bank_statement s on s.tenant_id = sl.tenant_id and s.id = sl.statement_id
      where s.cash_account_id = $1 and sl.value_date <= $2::date
        and not exists (
          select 1 from app.reconciliation_match m where m.statement_line_id = sl.id)`,
    [cashAccountId, periodEnd],
  );
  const notInBooks = BigInt(unmatchedStmt.rows[0]?.net ?? '0');
  const unmatchedStatement = Number(unmatchedStmt.rows[0]?.n ?? '0');

  const ledger = await tx.query<{ net: string }>(
    `select coalesce(sum(l.debit_minor) - sum(l.credit_minor), 0)::text as net
       from app.journal_line l
       join app.journal_entry e on e.tenant_id = l.tenant_id and e.id = l.journal_entry_id
      where e.status = 'posted' and l.account_id = $1 and l.location_id = $2
        and e.document_date <= $3::date`,
    [account.account_id, account.location_id, periodEnd],
  );
  const ledgerBalance = BigInt(ledger.rows[0]?.net ?? '0') + BigInt(account.opening_balance_minor);

  const adjusted = statementClosing + inTransit - outstanding + notInBooks;
  return {
    cashAccountId,
    statementClosingMinor: statementClosing,
    depositsInTransitMinor: inTransit,
    outstandingPaymentsMinor: outstanding,
    statementItemsNotInBooksMinor: notInBooks,
    adjustedBalanceMinor: adjusted,
    ledgerBalanceMinor: ledgerBalance,
    unexplainedMinor: adjusted - ledgerBalance,
    unmatchedStatementLines: unmatchedStatement,
    unmatchedBookLines: unmatchedBook,
  };
}

export interface CloseBlocker {
  readonly code:
    | 'UNEXPLAINED_DIFFERENCE' | 'STALE_UNMATCHED_LINE' | 'CLEARING_NOT_ZERO'
    | 'TRIAL_BALANCE_OFF' | 'LOCATION_TRIAL_BALANCE_OFF' | 'OPEN_POSTING_EXCEPTION';
  readonly detail: string;
}

/**
 * THE CLOSE GATE — §5.7.4.
 *
 * "This is what makes reconciliation required, not optional, in a way a user
 * cannot skip on a busy month-end: the close button refuses and names the
 * reason."
 *
 * Returns every blocker rather than the first, because a month-end where you
 * fix one problem and discover another is a month-end nobody finishes.
 *
 * A note on what is NOT checked here: unsynced documents at a location
 * (§5.2.6's fifth condition). That question belongs to the sync layer and this
 * module has no honest way to ask it — asserting a "no unsynced documents"
 * check that actually returned true unconditionally would be worse than an
 * absent one, so it is absent, named here, and owed.
 */
export async function closeBlockers(
  tx: Queryable,
  periodId: string,
  periodEnd: string,
): Promise<CloseBlocker[]> {
  const blockers: CloseBlocker[] = [];

  const accounts = await tx.query<{ id: string; stale_after_days: number }>(
    `select id, stale_after_days from app.cash_account where is_active`,
  );
  for (const acc of accounts.rows) {
    const view = await monthlyView(tx, acc.id, periodEnd);
    if (view.unexplainedMinor !== 0n) {
      blockers.push({
        code: 'UNEXPLAINED_DIFFERENCE',
        detail: `cash account ${acc.id} has an unexplained difference of ${view.unexplainedMinor}`,
      });
    }
    const stale = await tx.query<{ n: string }>(
      `select count(*)::text n
         from app.bank_statement_line sl
         join app.bank_statement s on s.tenant_id = sl.tenant_id and s.id = sl.statement_id
        where s.cash_account_id = $1
          and sl.value_date < ($2::date - ($3::int || ' days')::interval)
          and not exists (select 1 from app.reconciliation_match m where m.statement_line_id = sl.id)`,
      [acc.id, periodEnd, acc.stale_after_days],
    );
    const n = Number(stale.rows[0]?.n ?? '0');
    if (n > 0) {
      blockers.push({
        code: 'STALE_UNMATCHED_LINE',
        detail: `cash account ${acc.id} has ${n} statement line(s) unmatched for more than ${acc.stale_after_days} days`,
      });
    }
  }

  const clearing = await tx.query<{ account_id: string; net: string }>(
    `select l.account_id, (sum(l.debit_minor) - sum(l.credit_minor))::text as net
       from app.journal_line l
       join app.journal_entry e on e.tenant_id = l.tenant_id and e.id = l.journal_entry_id
       join app.gl_account_mapping m on m.tenant_id = l.tenant_id and m.account_id = l.account_id
      where e.status = 'posted' and m.posting_role = 'INTERLOC_CLEARING'
      group by l.account_id
     having sum(l.debit_minor) <> sum(l.credit_minor)`,
  );
  for (const row of clearing.rows) {
    blockers.push({
      code: 'CLEARING_NOT_ZERO',
      detail: `inter-location clearing account ${row.account_id} nets to ${row.net} across the tenant`,
    });
  }

  const tb = await tx.query<{ location_id: string | null; net: string }>(
    `select l.location_id, (sum(l.debit_minor) - sum(l.credit_minor))::text as net
       from app.journal_line l
       join app.journal_entry e on e.tenant_id = l.tenant_id and e.id = l.journal_entry_id
      where e.status = 'posted' and e.period_id = $1
      group by rollup (l.location_id)
     having sum(l.debit_minor) <> sum(l.credit_minor)`,
    [periodId],
  );
  for (const row of tb.rows) {
    blockers.push({
      code: row.location_id === null ? 'TRIAL_BALANCE_OFF' : 'LOCATION_TRIAL_BALANCE_OFF',
      detail:
        row.location_id === null
          ? `the trial balance for this period is out by ${row.net}`
          : `location ${row.location_id} is out by ${row.net}`,
    });
  }

  const exceptions = await tx.query<{ n: string }>(
    `select count(*)::text n from app.posting_exception
      where resolved_at is null and document_date <= $1::date`,
    [periodEnd],
  );
  const openExceptions = Number(exceptions.rows[0]?.n ?? '0');
  if (openExceptions > 0) {
    blockers.push({
      code: 'OPEN_POSTING_EXCEPTION',
      detail: `${openExceptions} settled document(s) dated in or before this period have no journal entry`,
    });
  }

  return blockers;
}
