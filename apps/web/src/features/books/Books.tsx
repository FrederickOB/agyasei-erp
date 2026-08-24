/**
 * THE BOOKS — trial balance, P&L, balance sheet, and the close gate's queue.
 *
 * Three rules, in order of how expensive they are to break:
 *
 * 1. AN EMPTY LEDGER IS A STATE, NOT AN ERROR. Until a qualified accountant
 *    has reviewed and seeded the chart of accounts (CLAUDE.md §2.8;
 *    open-questions Q6), every tenant's ledger is empty, and this screen says
 *    exactly that — including WHY, because "no data" with no reason reads as
 *    a bug and trains people to refresh instead of to act.
 *
 * 2. THE MID-YEAR BALANCE SHEET DOES NOT BALANCE, AND THE COPY SAYS SO. The
 *    period's profit sits in income and expense until year-end close, so
 *    assets − (liabilities + equity) equals the P&L result — the identity
 *    that DOES hold every day. A screen that hid the gap, or worse "fixed"
 *    it, would be lying about the one number the §2.8 reviewer will check
 *    first.
 *
 * 3. OPEN POSTING EXCEPTIONS ARE THE HEADLINE, NOT A FOOTNOTE. Each one is a
 *    settled document with no journal entry — revenue missing from the books
 *    — and the close gate refuses while any exists. They render above the
 *    statements because a statement over an incomplete ledger is quietly
 *    wrong, and quietly wrong is this project's recorded defect class.
 */
import { useState, type ReactNode } from 'react';
import {
  fetchBalanceSheet,
  fetchPostingExceptions,
  fetchProfitAndLoss,
  fetchTrialBalance,
  type StatementRow,
} from '../../data/api/ledger';
import type { ApiCallOptions } from '../../data/api/client';
import { useApiQuery } from '../../data/api/use-api-query';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';
import { FetchedAt, ServerPending, ServerUnavailable } from '../shell/ServerAnswer';

const WHAT = 'The books';

type Tab = 'trial-balance' | 'profit-and-loss' | 'balance-sheet';

function EmptyLedger({ openExceptions }: { readonly openExceptions: number }): ReactNode {
  return (
    <section className="books-empty" role="status">
      <Icon name="tag" size={24} />
      <h3>There is no chart of accounts yet</h3>
      <p>
        The ledger machinery is ready, but the accounts themselves are set up together with a
        qualified accountant, and that review has not happened yet. Until it does, nothing posts
        and these statements stay empty — that is deliberate, not a fault.
      </p>
      {openExceptions > 0 ? (
        <p className="books-empty-warn">
          {openExceptions} document(s) are already waiting to be posted when the accounts exist.
        </p>
      ) : null}
    </section>
  );
}

function StatementTable({ rows }: { readonly rows: readonly StatementRow[] }): ReactNode {
  return (
    <table className="books-table">
      <thead>
        <tr>
          <th>Code</th>
          <th>Account</th>
          <th className="numeric">Amount</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.accountId}:${r.locationId ?? ''}`}>
            <td className="tabular">{r.code}</td>
            <td>{r.name}</td>
            <td className="numeric">
              <Money amount={r.amountMinor} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TrialBalanceView({ apiOptions }: { readonly apiOptions: ApiCallOptions }): ReactNode {
  const { state, refresh } = useApiQuery(() => fetchTrialBalance({}, apiOptions), [apiOptions]);
  if (state.status === 'loading') return <ServerPending what={WHAT} rows={4} slow={state.slow} />;
  if (state.status === 'failed') {
    return <ServerUnavailable what={WHAT} failure={state.failure} onRetry={refresh} />;
  }
  const tb = state.data;
  if (tb.accountCount === 0) return <EmptyLedger openExceptions={0} />;
  return (
    <div className="books-statement">
      <p className={tb.balanced ? 'books-ok' : 'books-attn'} role="status">
        {tb.balanced
          ? 'The trial balance sums to zero — for the whole business and at every location.'
          : 'THE TRIAL BALANCE DOES NOT SUM TO ZERO. Something is recorded wrongly, and closing is blocked until it is found.'}
      </p>
      {tb.byLocation.some((l) => !l.balanced) ? (
        <ul className="books-attn-list">
          {tb.byLocation
            .filter((l) => !l.balanced)
            .map((l) => (
              <li key={l.locationId} className="tabular">
                location {l.locationId}: Dr <Money amount={l.debitMinor} /> / Cr{' '}
                <Money amount={l.creditMinor} />
              </li>
            ))}
        </ul>
      ) : null}
      <StatementTable rows={tb.rows} />
      <FetchedAt atMs={state.fetchedAtMs} />
    </div>
  );
}

function ProfitAndLossView({ apiOptions }: { readonly apiOptions: ApiCallOptions }): ReactNode {
  const { state, refresh } = useApiQuery(() => fetchProfitAndLoss({}, apiOptions), [apiOptions]);
  if (state.status === 'loading') return <ServerPending what={WHAT} rows={4} slow={state.slow} />;
  if (state.status === 'failed') {
    return <ServerUnavailable what={WHAT} failure={state.failure} onRetry={refresh} />;
  }
  const pl = state.data;
  if (pl.accountCount === 0) return <EmptyLedger openExceptions={0} />;
  return (
    <div className="books-statement">
      <dl className="books-totals">
        <div>
          <dt>Income</dt>
          <dd>
            <Money amount={pl.revenueMinor} />
          </dd>
        </div>
        <div>
          <dt>Expenses</dt>
          <dd>
            <Money amount={pl.expenseMinor} />
          </dd>
        </div>
        <div className="books-result">
          <dt>{pl.resultMinor < 0n ? 'Loss' : 'Profit'}</dt>
          <dd>
            <Money amount={pl.resultMinor < 0n ? -pl.resultMinor : pl.resultMinor} />
          </dd>
        </div>
      </dl>
      <StatementTable rows={pl.rows} />
      <FetchedAt atMs={state.fetchedAtMs} />
    </div>
  );
}

function BalanceSheetView({ apiOptions }: { readonly apiOptions: ApiCallOptions }): ReactNode {
  const { state, refresh } = useApiQuery(() => fetchBalanceSheet({}, apiOptions), [apiOptions]);
  if (state.status === 'loading') return <ServerPending what={WHAT} rows={4} slow={state.slow} />;
  if (state.status === 'failed') {
    return <ServerUnavailable what={WHAT} failure={state.failure} onRetry={refresh} />;
  }
  const bs = state.data;
  if (bs.accountCount === 0) return <EmptyLedger openExceptions={0} />;
  return (
    <div className="books-statement">
      <dl className="books-totals">
        <div>
          <dt>Assets</dt>
          <dd>
            <Money amount={bs.assetMinor} />
          </dd>
        </div>
        <div>
          <dt>Liabilities</dt>
          <dd>
            <Money amount={bs.liabilityMinor} />
          </dd>
        </div>
        <div>
          <dt>Equity</dt>
          <dd>
            <Money amount={bs.equityMinor} />
          </dd>
        </div>
      </dl>
      {/* The gap is SHOWN, with its explanation — never hidden, never "fixed".
          It is the unclosed profit, and it must equal the P&L result. */}
      <p className={bs.reconciles ? 'books-ok' : 'books-attn'} role="status">
        {bs.reconciles ? (
          <>
            The difference of <Money amount={bs.gapMinor} /> is this year&rsquo;s unclosed{' '}
            {bs.gapMinor < 0n ? 'loss' : 'profit'}, and it agrees with the profit &amp; loss
            exactly. The statements describe one set of books.
          </>
        ) : (
          <>
            THE STATEMENTS DISAGREE: the balance sheet gap is <Money amount={bs.gapMinor} /> but
            the profit &amp; loss says <Money amount={bs.resultMinor} />. One of them is wrong,
            and this must be resolved before anything is closed.
          </>
        )}
      </p>
      <StatementTable rows={bs.rows} />
      <FetchedAt atMs={state.fetchedAtMs} />
    </div>
  );
}

export function Books({ apiOptions = {} }: { readonly apiOptions?: ApiCallOptions }): ReactNode {
  const [tab, setTab] = useState<Tab>('trial-balance');
  const exceptions = useApiQuery(() => fetchPostingExceptions(apiOptions), [apiOptions]);

  return (
    <section className="books-screen">
      <header className="books-head">
        <h2>The books</h2>
        <p className="books-note">
          Written by the system from settled documents. Nothing here can be edited — a correction
          is always a new, reversing entry.
        </p>
      </header>

      {exceptions.state.status === 'ready' && exceptions.state.data.openCount > 0 ? (
        <section className="books-exceptions" role="alert">
          <Icon name="alert" size={20} />
          <div>
            <strong>
              {exceptions.state.data.openCount} settled document(s) have no journal entry.
            </strong>{' '}
            The statements below are incomplete until these post, and the period cannot close.
            <ul>
              {exceptions.state.data.exceptions.slice(0, 5).map((e) => (
                <li key={e.exceptionId} className="tabular">
                  {e.sourceKind} · {e.documentDate} · {e.errorCode}
                  {e.errorDetail === null ? '' : ` — ${e.errorDetail}`}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      <nav className="books-tabs" aria-label="Statements">
        {(
          [
            ['trial-balance', 'Trial balance'],
            ['profit-and-loss', 'Profit & loss'],
            ['balance-sheet', 'Balance sheet'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`books-tab pressable${tab === id ? ' books-tab-active' : ''}`}
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'trial-balance' ? <TrialBalanceView apiOptions={apiOptions} /> : null}
      {tab === 'profit-and-loss' ? <ProfitAndLossView apiOptions={apiOptions} /> : null}
      {tab === 'balance-sheet' ? <BalanceSheetView apiOptions={apiOptions} /> : null}
    </section>
  );
}
