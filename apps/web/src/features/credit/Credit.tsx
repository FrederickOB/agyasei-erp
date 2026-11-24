/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CUSTOMER CREDIT — what one customer owes, what is left, and how old it is
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase 1 acceptance criterion 3: *"A customer's credit balance, ageing and
 * facility fee are all visible and correct after a mix of cash and credit
 * sales across multiple locations."* This is the screen for it, and the
 * figures are the ones `drill:credit` proved over real HTTP.
 *
 * ---------------------------------------------------------------------------
 * 1. TWO PROVENANCES, NEVER MIXED — AND STILL NO CACHE
 * ---------------------------------------------------------------------------
 * This screen used to be online-only, because `app.customer_account` and
 * `app.credit_entry` were in no sync bucket. Migration 0013 and the
 * `tenant_credit` bucket changed the input, not the rule: a device whose
 * holder has `credit.view` now receives a bounded, SERVER-DERIVED position,
 * and criterion 3's "visible and correct" is answerable with the radio off.
 *
 * The rule that did not change is the important one. **A stale credit balance
 * is how a counter extends credit that is not there**, and it is
 * indistinguishable on screen from a live one — so it is never allowed to look
 * like one. There are exactly two provenances and they never share a rendering:
 *
 *   `verified_online` — `useApiQuery` + `BalancePanel`. Says "Balance". Still
 *                       DISCARDS its previous answer before every re-run; there
 *                       is still no cache of any figure in this feature.
 *   `synced_as_of`    — `SyncedPositionPanel`, a different component taking a
 *                       DIFFERENT TYPE, whose every label carries its own age
 *                       ("Balance as at 06:40 today"). It appears only when the
 *                       server could not be reached, and never in place of a
 *                       verified figure.
 *
 * A device holding no snapshot — a counter till, or anyone without
 * `credit.view` — still sees the reason and NOTHING ELSE: not an old figure,
 * not a zero, not an empty ageing table (`features/shell/ServerAnswer.tsx`).
 *
 * Nothing on this device computes a credit balance or an ageing bucket. The
 * synced entry log is WINDOWED, so Σ(local entries) ≠ balance by construction
 * (`data/queries/credit-position.ts` sets out the arithmetic).
 *
 * ---------------------------------------------------------------------------
 * 2. THE BREAKDOWN HAS TO ADD UP TO THE HEADLINE, AND IT IS CHECKED
 * ---------------------------------------------------------------------------
 * The balance and the ageing are two reads over the same append-only ledger.
 * `exposure = Σ buckets − on-account credit + fee outstanding`, exactly, in
 * `bigint`. `checkAgreement` (data/api/credit.ts) evaluates it and this screen
 * renders the composition line either way — because a headline total with a
 * breakdown under it that does not add up is worse than no breakdown, and
 * quietly showing only the headline would hide the disagreement.
 *
 * ---------------------------------------------------------------------------
 * 3. THE FEE IS THE SERVER'S WORDS, AND THE GATE IS NOT AN ERROR
 * ---------------------------------------------------------------------------
 * The fee figure is a SHADOW computation while the tenant's policy is
 * unconfirmed, and the server labels it. This screen renders that label
 * verbatim and never re-words it. Posting is refused with `412
 * FEE_POLICY_UNCONFIRMED` until a qualified human confirms the five decisions
 * (CLAUDE.md §2.8, open-questions Q4), and that refusal is presented as the
 * plain fact that somebody has to decide — with no "Try again", because trying
 * again is not what is missing.
 *
 * ---------------------------------------------------------------------------
 * 4. THE THREE WRITES, AND WHY THEY ARE NOT ALL THE SAME KIND OF WRITE
 * ---------------------------------------------------------------------------
 * This screen now opens an account, changes a limit and takes a payment
 * (`features/credit/CreditForms.tsx`), because until it did, a customer could
 * be put INTO debt from a screen and taken out of it from nowhere at all.
 *
 * Two of the three are refused offline and one is queued, and the split is the
 * whole design. Opening an account and changing a limit both SET A CREDIT
 * LIMIT — a risk judgement 06 §6.6.3(7) requires connectivity for, and a
 * partitioned device cannot even see the version it would be superseding. A
 * repayment is trade: the money is in the drawer either way, `credit_entry` is
 * append-only signed integers so two offline batches commute (§6.2), and a
 * payment only ever reduces exposure.
 *
 * **The queued payment shows its receipt and NEVER a resulting balance.**
 * Nothing on this screen subtracts a payment from a figure — not from a server
 * answer and not from a synced one. `drill:credit` proved balance = Σ(entries)
 * and Σ(buckets) = balance on the SERVER; a second computation on the device is
 * a second thing that can disagree, and a payment recorded after the snapshot
 * was taken is LISTED beside the figure rather than folded into it.
 *
 * WHAT THIS SCREEN STILL DOES NOT DO: it does not offer an ADJUSTMENT or a
 * WRITE_OFF. Both are real device-uploadable kinds and both are accounting
 * judgements somebody signs for, not trade — an ordered upload queue on a
 * tablet is not where a bad debt gets authorised.
 *
 * It also does not put remaining headroom on the counter's tender panel. The
 * counter has no credit-sale path today (it rings cash), and even when it
 * gains one an offline till cannot know a limit: §8.4 forbids claiming a
 * verification that could not happen, and the D6/D9 evidence is that the
 * server's own repriced total is the only figure a bound may be checked
 * against. When that path is built, the honest surface is the balance's
 * `as_of` plus "not verified now" — never a confident number.
 *
 * Money is `bigint` minor units and reaches the screen only through `<Money>`
 * against the tenant's CurrencySpec (ADR-0004, §8.9).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ApiCallOptions } from '../../data/api/client';
import {
  accrueFacilityFee,
  fetchAccountForCustomer,
  fetchCreditPosition,
  type CreditPosition,
  type FeePreview,
} from '../../data/api/credit';
import {
  CAPABILITY,
  holdsCapability,
  holdsCapabilityForQueuedWrite,
  type PermissionsState,
} from '../../data/api/session';
import { useApiQuery } from '../../data/api/use-api-query';
import type { LocalDb } from '../../data/db';
import { getOrCreateDeviceNode } from '../../data/queries/config';
import {
  loadAccountIdForCustomer,
  loadSyncedCreditPosition,
} from '../../data/queries/credit-position';
import { loadCreditCustomers, type CreditCustomer } from '../../data/queries/customers';
import { loadDebtors, type Debtor } from '../../data/queries/debtors';
import { readDeviceLocation } from '../../data/queries/session';
import { useLiveQuery } from '../../data/use-live-query';
import { businessDateFor } from '../../lib/business-date';
import { createClaimedHlcClock, type ClaimedHlcClock } from '../../lib/hlc';
import { uuidv7 } from '../../lib/uuidv7';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';
import { FetchedAt, ServerPending, ServerUnavailable } from '../shell/ServerAnswer';
import {
  LimitForm,
  OpenAccountForm,
  QueuedRepaymentReceipt,
  RepaymentForm,
  StatusForm,
  type QueuedRepayment,
} from './CreditForms';
import { asAtWords, SyncedPositionPanel } from './SyncedPosition';

const WHAT = 'A customer’s credit position';

/** Stable identity, so a screen with no test seam does not refetch on render. */
const EMPTY_OPTIONS: ApiCallOptions = {};

// ---------------------------------------------------------------------------
// Choosing who
// ---------------------------------------------------------------------------

/**
 * The customer list is LOCAL and works offline — `tenant_customers` carries
 * identity only, no balances and no limits — so somebody can find who they
 * mean with the radio off and then be told plainly that the money question
 * needs a connection. Those are two different facts and the screen keeps them
 * apart rather than blanking the whole page.
 */
const PICKER_LIMIT = 30;
const DEBTORS_LIMIT = 50;

/**
 * The staleness of a whole list of synced figures is the staleness of its
 * OLDEST: "as at 06:40 today" must be true of every row under it.
 */
function oldestAsAt(debtors: readonly Debtor[], nowMs: number): string {
  let oldest: Debtor | null = null;
  for (const d of debtors) {
    if (oldest === null) oldest = d;
    else if (d.computedAtMs === null) {
      if (oldest.computedAtMs !== null || d.asOf < oldest.asOf) oldest = d;
    } else if (oldest.computedAtMs !== null && d.computedAtMs < oldest.computedAtMs) oldest = d;
  }
  return oldest === null ? '' : asAtWords(oldest.computedAtMs, oldest.asOf, nowMs);
}

/**
 * Who owes, most overdue first — the list Accounts opens Credit to work
 * through. Every figure is the SYNCED one, so the "as at" sits in the heading
 * and in each figure's own label (R3: never a bare "balance"). Tapping a row
 * opens that customer, where the live figure is asked for.
 */
function DebtorsList({
  debtors,
  onPick,
  nowMs,
}: {
  readonly debtors: readonly Debtor[];
  readonly onPick: (customerId: string) => void;
  readonly nowMs: number;
}): ReactNode {
  const asAt = oldestAsAt(debtors, nowMs);
  if (debtors.length === 0) {
    return (
      <p className="report-note" data-provenance="synced_as_of">
        Nobody owes anything on the book this device last received. Search above to open any
        customer&rsquo;s account.
      </p>
    );
  }
  const shown = debtors.slice(0, DEBTORS_LIMIT);
  const late = debtors.filter((d) => d.oldestOverdue !== null).length;
  return (
    <section className="debtors" data-provenance="synced_as_of" aria-labelledby="debtors-head">
      <header className="debtors-head">
        <h3 id="debtors-head">Who owes, most overdue first</h3>
        <span className="scope-chip scope-partial">
          <Icon name="clock" size={16} />
          Synced, {asAt}
        </span>
      </header>
      <p className="report-note">
        {String(debtors.length)} {debtors.length === 1 ? 'customer owes' : 'customers owe'}
        {late === 0 ? ', none of it overdue' : `; ${String(late)} ${late === 1 ? 'is' : 'are'} overdue`}.
        These are the office&rsquo;s figures {asAt} &mdash; open a customer for the figure now.
      </p>
      <ul className="debtor-list" aria-label="Customers who owe">
        {shown.map((d) => {
          const over = d.availableMinor < 0n;
          return (
            <li key={d.accountId}>
              <button
                type="button"
                className="debtor-row pressable"
                data-overdue={d.oldestOverdue === null ? 'no' : 'yes'}
                onClick={() => onPick(d.customerId)}
              >
                <span className="debtor-who">
                  <b>{d.name}</b>
                  <small className="tabular">
                    {d.code}
                    {d.phone === null ? '' : ` · ${d.phone}`}
                  </small>
                </span>
                <span className="debtor-figures">
                  <span className="debtor-owed">
                    <small>Owed {asAt}</small>
                    <Money amount={d.balanceMinor} />
                  </span>
                  {d.oldestOverdue === null ? (
                    <small className="debtor-age">Not yet due</small>
                  ) : (
                    <small className="debtor-age debtor-late">
                      <Money amount={d.oldestOverdue.amountMinor} /> {d.oldestOverdue.label} days
                      overdue
                    </small>
                  )}
                </span>
                {over || d.status !== 'ACTIVE' ? (
                  <span className="debtor-flags">
                    {over ? <span className="debtor-flag">Over limit</span> : null}
                    {d.status !== 'ACTIVE' ? (
                      <span className="debtor-flag">{d.status.replace(/_/g, ' ').toLowerCase()}</span>
                    ) : null}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {debtors.length > shown.length ? (
        <p className="report-note">
          Showing the {String(shown.length)} most urgent of {String(debtors.length)}. Search above
          to find anyone else.
        </p>
      ) : null}
    </section>
  );
}

/** Lower-case and strip spacing, so "0244 123 456" finds "0244123456". */
function fold(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

function CustomerPicker({
  customers,
  debtors,
  customerId,
  onPick,
  nowMs,
}: {
  readonly customers: readonly CreditCustomer[];
  /**
   * The synced book as a worklist; null on a device that holds no book;
   * undefined while that is still being read — the landing waits rather than
   * flashing the plain list and swapping it out from under a finger.
   */
  readonly debtors: readonly Debtor[] | null | undefined;
  readonly customerId: string;
  readonly onPick: (id: string) => void;
  readonly nowMs: number;
}): ReactNode {
  // A dropdown of every account holder does not survive contact with a real
  // book of customers: a native <select> of four hundred names cannot be
  // searched on an Android tablet. Type any part of a name, the tenant's code
  // or a phone number; the first matches are shown before anything is typed,
  // so the screen is never a blank page with a control on it.
  const [query, setQuery] = useState('');
  const picked = customers.find((c) => c.id === customerId) ?? null;

  if (picked !== null) {
    return (
      <div className="customer-picked">
        <span className="customer-picked-label">Which customer</span>
        <span className="customer-picked-who">
          <b>{picked.name}</b>
          <small className="tabular">
            {picked.code}
            {picked.phone === null ? '' : ` · ${picked.phone}`}
          </small>
        </span>
        <button
          type="button"
          className="secondary-action pressable"
          onClick={() => {
            setQuery('');
            onPick('');
          }}
        >
          Change
        </button>
      </div>
    );
  }

  const needle = fold(query);
  const matches =
    needle.length === 0
      ? customers
      : customers.filter(
          (c) =>
            fold(c.name).includes(needle) ||
            fold(c.code).includes(needle) ||
            (c.phone !== null && fold(c.phone).includes(needle)),
        );
  const shown = matches.slice(0, PICKER_LIMIT);
  // Before anything is typed: the debtors worklist on a device holding the
  // book, the plain list on one that does not, and nothing while that is
  // still unknown. Once something is typed: matches across every customer.
  const landing: 'waiting' | 'debtors' | 'list' =
    needle.length > 0 || debtors === null ? 'list' : debtors === undefined ? 'waiting' : 'debtors';

  return (
    <div className="customer-picker">
      <label className="threshold-form-field">
        <span>Which customer</span>
        <input
          type="search"
          value={query}
          placeholder="Name, code or phone"
          autoComplete="off"
          enterKeyHint="go"
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            // Enter takes the only match — a typed code is usually exact.
            if (e.key === 'Enter' && matches.length === 1) onPick(matches[0]!.id);
          }}
        />
      </label>
      {landing === 'waiting' ? null : landing === 'debtors' ? (
        <DebtorsList debtors={debtors ?? []} onPick={onPick} nowMs={nowMs} />
      ) : shown.length === 0 ? (
        needle.length === 0 ? null : <p className="report-note">No customer matches &ldquo;{query}&rdquo;.</p>
      ) : (
        <ul className="customer-list" aria-label="Customers">
          {shown.map((c) => (
            <li key={c.id}>
              <button type="button" className="customer-row pressable" onClick={() => onPick(c.id)}>
                <b>{c.name}</b>
                <small className="tabular">
                  {c.code}
                  {c.phone === null ? '' : ` · ${c.phone}`}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {landing === 'list' && matches.length > shown.length ? (
        <p className="report-note">
          Showing {String(shown.length)} of {String(matches.length)}. Type more to narrow it down.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The position
// ---------------------------------------------------------------------------

function BalancePanel({ position }: { readonly position: CreditPosition }): ReactNode {
  const { exposure, ageing, agreement } = position;
  const overLimit = exposure.availableMinor < 0n;
  return (
    <section className="report-panel">
      <header className="report-panel-head">
        <h3>What this customer owes</h3>
        <span className="scope-chip scope-partial">
          <Icon name="live" size={16} />
          Asked of the office just now
        </span>
      </header>
      <dl className="credit-figures">
        <div>
          <dt>Balance</dt>
          <dd>
            <Money amount={exposure.exposureMinor} />
          </dd>
        </div>
        <div>
          <dt>Limit</dt>
          <dd>
            <Money amount={exposure.creditLimitMinor} />
          </dd>
        </div>
        <div className={overLimit ? 'credit-over' : ''}>
          <dt>{overLimit ? 'Over the limit by' : 'Left to spend'}</dt>
          <dd>
            <Money
              amount={overLimit ? -exposure.availableMinor : exposure.availableMinor}
            />
          </dd>
        </div>
        <div>
          <dt>Account status</dt>
          <dd className="credit-status">{exposure.status}</dd>
        </div>
      </dl>
      {overLimit ? (
        <p className="credit-warn" role="status">
          <Icon name="alert" size={18} />
          This account is already past its limit. Anything further is a decision somebody has to
          make, not a sale to ring.
        </p>
      ) : null}
      {/* The composition, shown either way. See the header, point 2. */}
      {agreement.kind === 'agrees' ? (
        <p className="report-note">
          Balance = what is still owed on invoices, less payments not yet put against an invoice,
          plus fee already posted. Those three add up to the figure above, exactly.
        </p>
      ) : (
        <p className="device-gate-error" role="alert">
          <Icon name="alert" size={20} />
          <span>
            The balance and the breakdown below do not add up — the balance says{' '}
            <Money amount={agreement.balanceMinor} /> and the breakdown comes to{' '}
            <Money amount={agreement.compositionMinor} />. These are two answers taken a moment
            apart, so an entry may have landed between them. Ask again before acting on either.
          </span>
        </p>
      )}
      <p className="report-note">
        Aged by <span className="tabular">{ageing.agedBy.replace(/_/g, ' ')}</span> as at{' '}
        <span className="tabular">{ageing.asOf}</span>, against the terms in force when each
        invoice was charged.
      </p>
    </section>
  );
}

function AgeingPanel({ position }: { readonly position: CreditPosition }): ReactNode {
  const { ageing } = position;
  return (
    <section className="report-panel">
      <header className="report-panel-head">
        <h3>How old it is</h3>
      </header>
      <div className="report-table-scroll">
        <table className="report-table">
          <caption className="visually-hidden">
            Amounts owed by how many days past due they are
          </caption>
          <thead>
            <tr>
              <th scope="col">Days past due</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {ageing.buckets.map((b) => (
              <tr key={b.label}>
                <th scope="row" className="tabular">
                  {b.label}
                </th>
                <td>
                  <Money amount={b.amountMinor} />
                </td>
              </tr>
            ))}
            <tr className="credit-aside">
              <th scope="row">Paid, not yet put against an invoice</th>
              <td>
                <Money amount={ageing.onAccountCreditMinor} />
              </td>
            </tr>
            <tr className="credit-aside">
              <th scope="row">Fee already posted</th>
              <td>
                <Money amount={ageing.feeOutstandingMinor} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="report-note">
        Money paid but not yet put against a particular invoice sits on its own line and is never
        quietly taken off the oldest one.
      </p>
      {ageing.invoices.length === 0 ? null : (
        <div className="report-table-scroll">
          <table className="report-table">
            <caption className="visually-hidden">Unpaid invoices</caption>
            <thead>
              <tr>
                <th scope="col">Due</th>
                <th scope="col">Days past due</th>
                <th scope="col">Still owed</th>
              </tr>
            </thead>
            <tbody>
              {ageing.invoices.map((inv) => (
                <tr key={inv.chargeId}>
                  <th scope="row" className="tabular">
                    {inv.dueDate ?? '—'}
                  </th>
                  <td className="tabular">
                    {/* The server's figure is negative before the due date;
                        "-26 days past due" makes a person do the sign. */}
                    {inv.daysPastDue > 0
                      ? String(inv.daysPastDue)
                      : inv.daysPastDue === 0
                        ? 'Due today'
                        : `Not due — ${String(-inv.daysPastDue)} ${inv.daysPastDue === -1 ? 'day' : 'days'} to go`}
                  </td>
                  <td>
                    <Money amount={inv.outstandingMinor} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

type AccrualState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'posting' }
  | { readonly kind: 'gated'; readonly detail: string }
  | { readonly kind: 'posted'; readonly count: number }
  | { readonly kind: 'refused'; readonly message: string };

function FeePanel({
  fee,
  accountId,
  asOf,
  canAccrue,
  apiOptions,
}: {
  readonly fee: FeePreview;
  readonly accountId: string;
  readonly asOf: string;
  readonly canAccrue: boolean;
  readonly apiOptions: ApiCallOptions;
}): ReactNode {
  const [state, setState] = useState<AccrualState>({ kind: 'idle' });

  const post = useCallback(() => {
    setState({ kind: 'posting' });
    void accrueFacilityFee(
      {
        idempotencyKey: uuidv7(),
        clientWallAt: new Date().toISOString(),
        accountId,
        asOf,
      },
      apiOptions,
    ).then((outcome) => {
      switch (outcome.kind) {
        case 'posted':
          setState({ kind: 'posted', count: outcome.result.postedCount });
          return;
        case 'policy-unconfirmed':
          setState({ kind: 'gated', detail: outcome.detail });
          return;
        case 'refused':
          setState({
            kind: 'refused',
            message: outcome.failure.detail ?? outcome.failure.message,
          });
      }
    });
  }, [accountId, apiOptions, asOf]);

  return (
    <section className="report-panel">
      <header className="report-panel-head">
        <h3>Fee on overdue invoices</h3>
        {/* THE SERVER'S OWN LABEL, VERBATIM. Not re-worded, not shortened, not
            translated into a friendlier phrase — somebody will quote this to a
            customer, and the server is the only thing that knows whether the
            policy behind it has been signed off. */}
        <span className={`scope-chip ${fee.provisional ? 'scope-partial' : 'scope-network'}`}>
          <Icon name={fee.provisional ? 'alert' : 'check'} size={16} />
          {fee.label}
        </span>
      </header>
      <dl className="credit-figures">
        <div>
          <dt>Would accrue to {asOf}</dt>
          <dd>
            <Money amount={fee.totalDeltaMinor} />
          </dd>
        </div>
        <div>
          <dt>Invoices it comes from</dt>
          <dd className="tabular">{String(fee.accruals.length)}</dd>
        </div>
      </dl>
      {fee.provisional ? (
        <p className="credit-warn" role="status">
          <Icon name="alert" size={18} />
          This figure is worked out but <strong>not charged and not chargeable</strong>. It is not
          on the customer&rsquo;s balance and must not be quoted as owing.
        </p>
      ) : null}

      {/* Posting is offered only where the capability is held — a courtesy.
          The server checks it again, tenant-wide, and checks the policy after
          that. */}
      {canAccrue && state.kind !== 'posted' ? (
        <div className="threshold-form-actions">
          <button
            type="button"
            className="secondary-action pressable"
            disabled={state.kind === 'posting' || state.kind === 'gated'}
            onClick={post}
          >
            {state.kind === 'posting' ? 'Posting…' : 'Post this to the account'}
          </button>
        </div>
      ) : null}

      {state.kind === 'gated' ? (
        // NOT AN ERROR AND NOT RETRYABLE. There is no "Try again" here on
        // purpose: nothing about the request was wrong, and pressing it again
        // cannot make a person decide something.
        <section className="server-answer server-answer-calm credit-gate" role="status">
          <Icon name="clock" size={28} />
          <div className="server-answer-body">
            <h4 className="server-answer-title">A person has to settle the fee rules first.</h4>
            <p className="server-answer-text">
              Nothing has been posted and nothing is waiting to be. How this fee is worked out is a
              decision the business has to make and have signed off before a single one is charged
              to a customer — the system will not decide it, and trying again will not change that.
              Until then the figure above stays a working number.
            </p>
            {state.detail.length === 0 ? null : (
              <p className="server-answer-detail">
                <span className="server-answer-detail-label">If you call someone, tell them:</span>{' '}
                <span className="tabular">{state.detail}</span>
              </p>
            )}
          </div>
        </section>
      ) : null}

      {state.kind === 'posted' ? (
        <p className="credit-warn" role="status">
          <Icon name="check" size={18} />
          Posted against {String(state.count)} invoice{state.count === 1 ? '' : 's'}. It is on the
          balance now.
        </p>
      ) : null}

      {state.kind === 'refused' ? (
        <p className="device-gate-error" role="alert">
          <Icon name="alert" size={20} />
          <span>Nothing was posted. {state.message}</span>
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export interface CreditProps {
  readonly db: LocalDb;
  readonly permissions: PermissionsState;
  readonly apiOptions?: ApiCallOptions;
}

export function Credit({ db, permissions, apiOptions }: CreditProps): ReactNode {
  const location = useLiveQuery(db, readDeviceLocation, []);
  const customers = useLiveQuery(db, loadCreditCustomers, []);
  const debtors = useLiveQuery(db, loadDebtors, []);
  const [customerId, setCustomerId] = useState('');
  const [asOfOverride, setAsOfOverride] = useState<string | null>(null);
  const options = useMemo<ApiCallOptions>(() => apiOptions ?? EMPTY_OPTIONS, [apiOptions]);

  // The trading day is the LOCATION's, never the tablet's calendar: ageing is
  // computed against a business date and a tablet that has wandered onto the
  // wrong zone must not age a customer's book by a day it never traded.
  const defaultAsOf = businessDateFor(new Date().toISOString(), location?.timeZone ?? null);
  const asOf = asOfOverride ?? defaultAsOf;

  const customer = (customers ?? []).find((c) => c.id === customerId) ?? null;

  return (
    <div className="credit-screen">
      <header className="report-panel-head">
        <h2>Customer credit</h2>
      </header>

      {customers !== undefined && customers.length === 0 ? (
        <div className="empty-state">
          <Icon name="tag" size={40} />
          <span className="empty-title">No customers buy on account here yet</span>
          <p className="empty-body">
            Customers set up to buy on account arrive with the rest of this counter&rsquo;s data.
            None have arrived.
          </p>
        </div>
      ) : (
        <form className="credit-chooser" onSubmit={(e) => e.preventDefault()}>
          <CustomerPicker
            customers={customers ?? []}
            debtors={debtors}
            customerId={customerId}
            onPick={(id) => setCustomerId(id)}
            nowMs={Date.now()}
          />
          <label className="report-range-field">
            <span>As at</span>
            <input
              type="date"
              value={asOf}
              onChange={(e) => setAsOfOverride(e.currentTarget.value)}
            />
          </label>
        </form>
      )}

      {customer === null ? null : (
        <CreditForCustomer
          // Remounted per customer, so nothing about one person's account —
          // a half-typed limit, a queued receipt — survives into another's.
          key={customer.id}
          db={db}
          customer={customer}
          asOf={asOf}
          today={defaultAsOf}
          permissions={permissions}
          apiOptions={options}
        />
      )}
    </div>
  );
}

/**
 * Which account, then what it says.
 *
 * The lookup is a SERVER read, and its three answers are three different
 * facts that this screen keeps apart:
 *
 *   ready + an account  — show the position.
 *   ready + null        — the server said this customer has no account. This
 *                         is the ONLY state in which opening one is offered.
 *   failed              — this device could not ask. It says so, and offers
 *                         nothing, because "no account" and "could not check"
 *                         look identical on a screen and are not the same.
 */
function CreditForCustomer({
  db,
  customer,
  asOf,
  today,
  permissions,
  apiOptions,
}: {
  readonly db: LocalDb;
  readonly customer: CreditCustomer;
  readonly asOf: string;
  readonly today: string;
  readonly permissions: PermissionsState;
  readonly apiOptions: ApiCallOptions;
}): ReactNode {
  const { state, refresh } = useApiQuery(
    () => fetchAccountForCustomer(customer.id, apiOptions),
    [customer.id, apiOptions],
  );
  /**
   * Which account this customer's is, as far as THIS DEVICE knows.
   *
   * `credit.accountForCustomer` is the authority and it needs the radio. The
   * `tenant_credit` bucket now also puts `customer_account` on devices whose
   * holder has `credit.view`, so when the office cannot be reached and this
   * device happens to hold the row, the screen can still find the account and
   * show the position it received — clearly labelled with its age.
   *
   * `undefined` = the local read has not finished. `null` = this device holds
   * no account for this customer, which is the answer for a counter till and
   * for anyone without `credit.view`: they see the refusal and no figures, as
   * they did before this existed.
   */
  const localAccountId = useLiveQuery(
    db,
    (d) => loadAccountIdForCustomer(d, customer.id),
    [customer.id],
  );
  const offlineAccountId =
    state.status === 'failed' && typeof localAccountId === 'string' ? localAccountId : null;
  const [opening, setOpening] = useState(false);

  // A courtesy over-approximation, and named as one: the server requires both
  // of these at the ROOT of the tenant's location tree, which is stricter than
  // "held somewhere". An outlet manager holds neither and sees the account
  // without the forms; Accounts holds both. Nothing here reads a role name.
  const canManage = holdsCapability(permissions, CAPABILITY.creditAccountManage);
  const canSetLimit = holdsCapability(permissions, CAPABILITY.creditLimitChange);

  return (
    <>
      {/* No "as at" here: this lookup finds WHICH account, and carries no
          figure. The position below states when its own figures were asked —
          two identical clocks one above the other read as a glitch. */}
      {state.status === 'loading' ? <ServerPending shape="figures" what={WHAT} slow={state.slow} rows={3} /> : null}
      {/* One refusal per screen: when the fallback below takes over, IT states
          the refusal, alongside the figures it is entitled to show. */}
      {state.status === 'failed' && offlineAccountId === null ? (
        <ServerUnavailable what={WHAT} failure={state.failure} onRetry={refresh} />
      ) : null}

      {offlineAccountId !== null ? (
        <CreditPositionFor
          db={db}
          accountId={offlineAccountId}
          asOf={asOf}
          today={today}
          permissions={permissions}
          apiOptions={apiOptions}
        />
      ) : null}

      {state.status === 'ready' && state.data === null ? (
        opening ? (
          <OpenAccountForm
            customerId={customer.id}
            customerName={customer.name}
            apiOptions={apiOptions}
            canSetLimit={canSetLimit}
            onOpened={() => {
              setOpening(false);
              refresh();
            }}
            onCancel={() => setOpening(false)}
          />
        ) : (
          <div className="empty-state">
            <Icon name="tag" size={40} />
            <span className="empty-title">{customer.name} buys for cash</span>
            <p className="empty-body">
              There is no credit account for this customer, so there is nothing to owe and nothing
              to age.{' '}
              {canManage
                ? 'Opening one sets what they may owe and how long they have to pay.'
                : 'Opening one is decided at the office, by somebody who sets credit terms.'}
            </p>
            {canManage ? (
              <div className="threshold-form-actions">
                <button
                  type="button"
                  className="primary-action pressable"
                  onClick={() => setOpening(true)}
                >
                  Open a credit account
                </button>
              </div>
            ) : null}
          </div>
        )
      ) : null}

      {state.status === 'ready' && state.data !== null ? (
        <CreditPositionFor
          db={db}
          accountId={state.data.accountId}
          asOf={asOf}
          today={today}
          permissions={permissions}
          apiOptions={apiOptions}
        />
      ) : null}
    </>
  );
}

function CreditPositionFor({
  db,
  accountId,
  asOf,
  today,
  permissions,
  apiOptions,
}: {
  readonly db: LocalDb;
  readonly accountId: string;
  readonly asOf: string;
  /** The LOCATION's trading day. A limit decision applies from this, not `asOf`. */
  readonly today: string;
  readonly permissions: PermissionsState;
  readonly apiOptions: ApiCallOptions;
}): ReactNode {
  const { state, refresh } = useApiQuery(
    () => fetchCreditPosition(accountId, asOf, apiOptions),
    [accountId, asOf, apiOptions],
  );
  /**
   * What this device already holds, from the `tenant_credit` bucket.
   *
   * It is read UNCONDITIONALLY and rendered ONLY when the server could not be
   * reached, and the asymmetry is deliberate. `useApiQuery` still discards its
   * previous answer on every re-run — nothing here weakens that — so what
   * replaces the vanished figures is not the old answer kept alive, it is a
   * DIFFERENT, server-derived one that says its own age in every label. A
   * device holding no snapshot (a counter till, or one that has never synced
   * the book) gets `unavailable` and sees only the refusal, exactly as before.
   */
  const synced = useLiveQuery(db, (d) => loadSyncedCreditPosition(d, accountId), [accountId]);
  const [changingLimit, setChangingLimit] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const [queued, setQueued] = useState<QueuedRepayment | null>(null);
  const [hlc, setHlc] = useState<ClaimedHlcClock | null>(null);

  useEffect(() => {
    let alive = true;
    void getOrCreateDeviceNode(db).then((node) => {
      if (alive) setHlc(createClaimedHlcClock(node));
    });
    return () => {
      alive = false;
    };
  }, [db]);

  // A courtesy over-approximation, and named as one: the server requires this
  // capability at the ROOT of the tenant's location tree, which is stricter
  // than "held somewhere". Offering the control to somebody the server will
  // refuse costs them one tap; hiding it from somebody who holds it would cost
  // them the feature.
  const canAccrue = holdsCapability(permissions, CAPABILITY.creditFeeAccrue);
  const canManage = holdsCapability(permissions, CAPABILITY.creditAccountManage);
  const canSetLimit = holdsCapability(permissions, CAPABILITY.creditLimitChange);

  /**
   * A repayment is the ONE control on this screen that is asked the strict
   * way, and the asymmetry is the point.
   *
   * Every other control here reads `holdsCapability`, which answers TRUE when
   * the device could not ask — hiding a read from somebody who holds it costs
   * them the feature, and offering one they do not hold costs them a refusal
   * they can read. A repayment is QUEUED, and a queued write the server
   * answers `FORBIDDEN` to is retried for ever at the head of an ORDERED
   * queue, so every sale behind it stops draining and the till merely looks
   * "stuck" (data/api/session.ts states this at length).
   */
  const canRecordPayment = holdsCapabilityForQueuedWrite(
    permissions,
    CAPABILITY.creditEntryRecord,
  );

  return (
    <>
      <div className="report-panel-head">
        {state.status === 'ready' ? <FetchedAt atMs={state.fetchedAtMs} /> : null}
      </div>

      {state.status === 'loading' ? <ServerPending shape="figures" what={WHAT} slow={state.slow} rows={3} /> : null}
      {state.status === 'failed' ? (
        <ServerUnavailable what={WHAT} failure={state.failure} onRetry={refresh} />
      ) : null}
      {state.status === 'failed' && synced !== undefined && synced.kind === 'synced_as_of' ? (
        <SyncedPositionPanel position={synced.position} />
      ) : null}

      {state.status === 'ready' ? (
        <>
          <BalancePanel position={state.data} />

          {/* ── What this customer may owe ─────────────────────────────── */}
          <section className="report-panel">
            <header className="report-panel-head">
              <h3>What they may owe</h3>
            </header>
            {changingLimit && canManage && canSetLimit ? (
              <LimitForm
                exposure={state.data.exposure}
                apiOptions={apiOptions}
                today={today}
                onChanged={() => {
                  setChangingLimit(false);
                  refresh();
                }}
                onCancel={() => setChangingLimit(false)}
              />
            ) : (
              <>
                <p className="report-note">
                  The limit is <Money amount={state.data.exposure.creditLimitMinor} /> and they
                  have <span className="tabular">{String(state.data.exposure.termsDays)}</span>{' '}
                  days to pay. Every change to it is kept, with who decided and why.
                </p>
                {canManage && canSetLimit ? (
                  <div className="threshold-form-actions">
                    <button
                      type="button"
                      className="secondary-action pressable"
                      onClick={() => setChangingLimit(true)}
                    >
                      Change the limit
                    </button>
                  </div>
                ) : (
                  <p className="adjust-kind-note">
                    What a customer may owe is decided at the office. You can see it here; changing
                    it is somebody else&rsquo;s decision.
                  </p>
                )}
              </>
            )}
          </section>

          {/* ── Stopping the account ───────────────────────────────────── */}
          {/*
            The switch behind a check that already existed: the till has always
            refused a credit sale on an account that is not ACTIVE, and until
            `credit.setStatus` nothing could move an account off ACTIVE.

            Whoever does not hold the capability still SEES the status — it is
            on the balance panel above and repeated here in words — and is told
            plainly whose decision it is. Hiding a control is a courtesy; the
            server re-authorises tenant-wide and refuses either way.
          */}
          <section className="report-panel">
            <header className="report-panel-head">
              <h3>Whether they may buy on account at all</h3>
            </header>
            {changingStatus && canManage ? (
              <StatusForm
                exposure={state.data.exposure}
                apiOptions={apiOptions}
                onChanged={() => {
                  setChangingStatus(false);
                  refresh();
                }}
                onCancel={() => setChangingStatus(false)}
              />
            ) : (
              <>
                <p className="report-note">
                  This account is{' '}
                  <span className="credit-status tabular">{state.data.exposure.status}</span>.{' '}
                  {state.data.exposure.status === 'ACTIVE'
                    ? 'Credit sales go through at the till.'
                    : 'The till will refuse a credit sale on it. Cash sales are unaffected, and the balance above is still owed.'}
                </p>
                {canManage ? (
                  <div className="threshold-form-actions">
                    <button
                      type="button"
                      className="secondary-action pressable"
                      onClick={() => setChangingStatus(true)}
                    >
                      {state.data.exposure.status === 'ACTIVE'
                        ? 'Stop this account'
                        : 'Change the account status'}
                    </button>
                  </div>
                ) : (
                  <p className="adjust-kind-note">
                    Stopping or reopening this account is somebody else&rsquo;s decision. You can
                    see where it stands here, and the till reads the same thing.
                  </p>
                )}
              </>
            )}
          </section>

          {/* ── Taking a payment ───────────────────────────────────────── */}
          <section className="report-panel">
            <header className="report-panel-head">
              <h3>Take a payment</h3>
            </header>
            {queued === null ? null : <QueuedRepaymentReceipt queued={queued} />}
            {canRecordPayment ? (
              hlc === null ? null : (
                <RepaymentForm
                  db={db}
                  accountId={accountId}
                  invoices={state.data.ageing.invoices}
                  hlc={hlc}
                  onQueued={(q) => setQueued(q)}
                />
              )
            ) : (
              <p className="adjust-kind-note">
                Taking a payment against an account is not part of what this device may do. The
                balance above is what the office holds.
              </p>
            )}
          </section>

          <AgeingPanel position={state.data} />
          {state.data.fee !== null ? (
            <FeePanel
              fee={state.data.fee}
              accountId={accountId}
              asOf={asOf}
              canAccrue={canAccrue}
              apiOptions={apiOptions}
            />
          ) : (
            <section className="report-panel">
              <header className="report-panel-head">
                <h3>Fee on overdue invoices</h3>
              </header>
              <ServerUnavailable
                what="The fee working"
                failure={
                  state.data.feeFailure ?? {
                    kind: 'malformed',
                    message: 'This device could not read the fee working.',
                    detail: null,
                    status: null,
                  }
                }
                onRetry={refresh}
              />
            </section>
          )}
        </>
      ) : null}
    </>
  );
}
