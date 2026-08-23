/**
 * The credit position THIS DEVICE ALREADY HOLDS, rendered as what it is.
 *
 * This is the `synced_as_of` state of `docs/credit-offline-plan.md` R3, and
 * everything about how it reads is downstream of one rule:
 *
 *   **The word "balance", unqualified, is reserved for a figure that
 *   round-tripped to the server in this interaction.**
 *
 * So nothing here says "Balance". It says *"Balance as at 06:40 today"* — the
 * age in the same sentence as the number, never in a tooltip, never in a
 * footnote, never in a colour. The panel has its own heading, its own chip and
 * its own class; it does not reuse `BalancePanel`, and it CANNOT, because a
 * `SyncedCreditPosition` is a different type from a `CreditPosition`. R3's
 * "never rendered in the place a verified figure uses" is enforced by the
 * compiler rather than by whoever reviews the next change.
 *
 * Three more things it must never do, all of them from R3:
 *  · imply a check that did not happen — there is no tick here, no "limit check
 *    passed", no approval of anything;
 *  · show a short statement as "no activity" — the opening balance and the
 *    window length are stated beside the list, always;
 *  · fold in movements the snapshot does not include — they are listed, and the
 *    sentence says they are not in the figure.
 */
import type { ReactNode } from 'react';
import { Money } from '../../money/Money';
import type { SyncedCreditPosition } from '../../data/queries/credit-position';
import { Icon } from '../../ui/Icon';

/** "as at 14:07 today" / "as at 2026-08-21" — never a bare clock time. */
function asAtPhrase(position: SyncedCreditPosition, nowMs: number): string {
  if (position.computedAtMs === null) return `as at ${position.asOf}`;
  const at = new Date(position.computedAtMs);
  const sameDay = new Date(nowMs).toDateString() === at.toDateString();
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return sameDay ? `as at ${hhmm} today` : `as at ${position.asOf}, ${hhmm}`;
}

export interface SyncedPositionPanelProps {
  readonly position: SyncedCreditPosition;
  /** Injected so the wording is testable without freezing the clock. */
  readonly nowMs?: number;
}

export function SyncedPositionPanel({
  position,
  nowMs = Date.now(),
}: SyncedPositionPanelProps): ReactNode {
  const asAt = asAtPhrase(position, nowMs);
  const overLimit = position.availableMinor < 0n;
  const since = position.movementsSince;

  return (
    <section className="report-panel credit-synced" data-provenance="synced_as_of">
      <header className="report-panel-head">
        <h3>What this device last received</h3>
        <span className="scope-chip scope-partial">
          <Icon name="clock" size={16} />
          Synced, {asAt}
        </span>
      </header>

      <p className="report-note">
        This is the office&rsquo;s figure {asAt} — it is not a check made just now, and other
        locations may have sold since.
      </p>

      <dl className="credit-figures">
        <div>
          <dt>Balance {asAt}</dt>
          <dd>
            <Money amount={position.balanceMinor} />
          </dd>
        </div>
        <div>
          <dt>Limit {asAt}</dt>
          <dd>
            <Money amount={position.creditLimitMinor} />
          </dd>
        </div>
        <div className={overLimit ? 'credit-over' : ''}>
          <dt>{overLimit ? 'Over the limit by' : 'Left to spend'} {asAt}</dt>
          <dd>
            <Money amount={overLimit ? -position.availableMinor : position.availableMinor} />
          </dd>
        </div>
        <div>
          <dt>Account status {asAt}</dt>
          <dd className="credit-status">{position.status}</dd>
        </div>
      </dl>

      {position.agreement.kind === 'disagrees' ? (
        <p className="device-gate-error" role="alert">
          <Icon name="alert" size={20} />
          <span>
            This position does not add up — the balance says{' '}
            <Money amount={position.agreement.balanceMinor} /> and the breakdown comes to{' '}
            <Money amount={position.agreement.compositionMinor} />. Do not act on either figure
            until the office has been asked again.
          </span>
        </p>
      ) : null}

      <h4 className="credit-subhead">How old it is, {asAt}</h4>
      <table>
        <caption className="visually-hidden">
          Ageing by {position.agedBy.replace(/_/g, ' ')} as at {position.asOf}
        </caption>
        <thead>
          <tr>
            <th scope="col">Age</th>
            <th scope="col" className="numeric">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {position.buckets.map((bucket) => (
            <tr key={bucket.label}>
              <th scope="row">{bucket.label}</th>
              <td className="numeric">
                <Money amount={bucket.amountMinor} />
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row">Payments not yet put against an invoice</th>
            <td className="numeric">
              <Money amount={position.onAccountCreditMinor} />
            </td>
          </tr>
          <tr>
            <th scope="row">Facility fee outstanding</th>
            <td className="numeric">
              <Money amount={position.feeOutstandingMinor} />
            </td>
          </tr>
        </tbody>
      </table>
      <p className="report-note">
        Aged by <span className="tabular">{position.agedBy.replace(/_/g, ' ')}</span> as at{' '}
        <span className="tabular">{position.asOf}</span>. These bands are the office&rsquo;s own —
        this device cannot work them out and has not tried.
        {position.feeProvisional
          ? ' The facility fee is provisional and not chargeable: nobody has confirmed the tenant’s fee policy yet.'
          : null}
      </p>

      {since.length > 0 ? (
        <div className="credit-since" role="status">
          <p className="credit-warn">
            <Icon name="alert" size={18} />
            {since.length === 1
              ? '1 movement has been recorded since that figure was taken, and it is NOT included in it:'
              : `${String(since.length)} movements have been recorded since that figure was taken, and they are NOT included in it:`}
          </p>
          <ul className="credit-since-list">
            {since.map((movement) => (
              <li key={movement.id}>
                <span className="tabular">{movement.businessDate}</span> {movement.kind.toLowerCase()}{' '}
                <Money amount={movement.amountMinor} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="report-note">
        This device holds the last {position.entryWindowDays} days of this account. Anything older
        is on the office&rsquo;s books, not missing:{' '}
        <Money amount={position.openingBeforeWindowMinor} /> was owed before the part shown here.
      </p>
    </section>
  );
}
