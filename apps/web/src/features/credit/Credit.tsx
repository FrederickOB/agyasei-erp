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
 * 1. THIS SCREEN IS ONLINE-ONLY AND SAYS SO. NO EXCEPTIONS, NO CACHE.
 * ---------------------------------------------------------------------------
 * `app.customer_account` and `app.credit_entry` are in no sync bucket — the
 * sync rules chose no bucket over an ungated one, deliberately and
 * fail-closed. A partitioned device therefore does not know what a customer
 * owes, and the only honest thing it can do is say that.
 *
 * There is no last-known balance anywhere in this feature. **A stale credit
 * balance is how a counter extends credit that is not there**, and it is
 * indistinguishable on screen from a live one. So when the server cannot be
 * reached this screen shows the reason and NOTHING ELSE — not an old figure,
 * not a zero, not an empty ageing table (`features/shell/ServerAnswer.tsx`).
 *
 * The device remembers NOTHING about credit — not a figure, and no longer even
 * an identifier. It used to keep an account reference in `local_config`
 * because no route mapped a customer to their account and a person had to type
 * a UUID; `credit.accountForCustomer` now answers that question, so the note
 * and the module that held it are gone. One less thing that can be wrong.
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
 * **The queued payment shows its receipt and NEVER a resulting balance.** The
 * balance stays behind a server answer, always. Nothing on this screen
 * subtracts a payment from a figure — `drill:credit` proved balance = Σ(entries)
 * and Σ(buckets) = balance, and a second computation on the device is a second
 * thing that can disagree.
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
import { loadCreditCustomers, type CreditCustomer } from '../../data/queries/customers';
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
  type QueuedRepayment,
} from './CreditForms';

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
function CustomerPicker({
  customers,
  customerId,
  onPick,
}: {
  readonly customers: readonly CreditCustomer[];
  readonly customerId: string;
  readonly onPick: (id: string) => void;
}): ReactNode {
  return (
    <label className="threshold-form-field">
      <span>Which customer</span>
      <select value={customerId} onChange={(e) => onPick(e.currentTarget.value)}>
        <option value="">Choose a customer…</option>
        {customers.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} · {c.code}
          </option>
        ))}
      </select>
    </label>
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
                  <td className="tabular">{String(inv.daysPastDue)}</td>
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
            customerId={customerId}
            onPick={(id) => setCustomerId(id)}
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
  const [opening, setOpening] = useState(false);

  // A courtesy over-approximation, and named as one: the server requires both
  // of these at the ROOT of the tenant's location tree, which is stricter than
  // "held somewhere". An outlet manager holds neither and sees the account
  // without the forms; Accounts holds both. Nothing here reads a role name.
  const canManage = holdsCapability(permissions, CAPABILITY.creditAccountManage);
  const canSetLimit = holdsCapability(permissions, CAPABILITY.creditLimitChange);

  return (
    <>
      <div className="report-panel-head">
        {state.status === 'ready' ? <FetchedAt atMs={state.fetchedAtMs} /> : null}
      </div>

      {state.status === 'loading' ? <ServerPending what={WHAT} slow={state.slow} rows={3} /> : null}
      {state.status === 'failed' ? (
        <ServerUnavailable what={WHAT} failure={state.failure} onRetry={refresh} />
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
  const [changingLimit, setChangingLimit] = useState(false);
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

      {state.status === 'loading' ? <ServerPending what={WHAT} slow={state.slow} rows={3} /> : null}
      {state.status === 'failed' ? (
        <ServerUnavailable what={WHAT} failure={state.failure} onRetry={refresh} />
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
