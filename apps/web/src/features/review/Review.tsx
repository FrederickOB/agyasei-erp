/**
 * THE REVIEW QUEUE — the screen that finally takes rows out of it.
 *
 * CLAUDE.md §2.2 requires that every conflict which cannot be resolved
 * automatically reaches a human. Until this screen existed they reached a
 * table: three writers filled `app.conflict_review` from Phase 1 onward and
 * nothing could ever read it, claim a row or resolve one. The Phase 2 gate
 * found six rows on the live database, every one `open`, none ever touched.
 *
 * ── THREE RULES THIS SCREEN FOLLOWS ──────────────────────────────────────
 *
 * 1. STRICTLY ONLINE, AND IT SAYS SO. Nothing here queues. Deciding which of
 *    two divergent facts is true is exactly what a partitioned device cannot
 *    do — that is why the row exists — so with the radio off this screen shows
 *    a refusal instead of a stale queue somebody might work twice.
 *
 * 2. IT NEVER RENDERS A FIGURE IT PARSED. Money and quantities inside
 *    `proposals` / `pendingValue` are decimal STRINGS (ADR-0004) and are
 *    printed as given. A conflict screen is the one place a human reads a
 *    number off a screen and re-enters it, so a float64 round-trip here would
 *    be a wrong figure with a person's signature on it.
 *
 * 3. IT NEVER CLAIMS TO HAVE FIXED ANYTHING. Resolving RECORDS a decision; it
 *    does not write the value back onto the conflicted row, and the server
 *    returns `entityRewritten: false` to say so. The copy says the same. A
 *    screen that implied the underlying record had been corrected would be
 *    the most expensive lie in the product.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  claimReview,
  fetchReviews,
  resolveReview,
  type Review as ReviewRow,
  type ReviewChoice,
} from '../../data/api/review';
import type { ApiCallOptions } from '../../data/api/client';
import { useApiQuery } from '../../data/api/use-api-query';
import { uuidv7 } from '../../lib/uuidv7';
import { Icon } from '../../ui/Icon';
import { conflictSummary, conflictTitle, entityLabel, escalationLabel } from './labels';
import { FetchedAt, ServerPending, ServerUnavailable } from '../shell/ServerAnswer';

const WHAT = 'Items needing a decision';

/**
 * Severity is a NUMBER on the wire and a sentence here. 1 is blocking — a
 * receipt-number regression stalls an outlet's uploads — and 4 is a note.
 * Product chrome, never tenant vocabulary.
 */
function severityLabel(severity: number): string {
  switch (severity) {
    case 1:
      return 'Blocking';
    case 2:
      return 'Urgent';
    case 3:
      return 'Normal';
    default:
      return 'For information';
  }
}

function whenLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Opaque JSON, printed. Deliberately NOT a table of parsed fields: the shape
 * differs per conflict class, and a renderer that understood three of them
 * would silently show nothing for the fourth.
 */
function Payload({ label, value }: { readonly label: string; readonly value: unknown }): ReactNode {
  if (value === null || value === undefined) return null;
  return (
    <div className="review-payload">
      <span className="review-payload-label">{label}</span>
      <pre className="review-payload-body tabular">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

const CHOICES: readonly { readonly id: ReviewChoice; readonly label: string; readonly help: string }[] = [
  {
    id: 'keep_pending',
    label: 'Keep what is recorded',
    help: 'The value currently on the record stands. The other version is rejected.',
  },
  {
    id: 'accept_proposal',
    label: 'Accept one version',
    help: 'Name the party whose version is correct.',
  },
  {
    id: 'enter_value',
    label: 'Neither — state the value',
    help: 'You give the correct value yourself.',
  },
  {
    id: 'no_action',
    label: 'Nothing to decide',
    help: 'Opened in error, or already handled somewhere else.',
  },
];

function ReviewCard({
  review,
  apiOptions,
  onChanged,
}: {
  readonly review: ReviewRow;
  readonly apiOptions: ApiCallOptions;
  readonly onChanged: () => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<ReviewChoice>('keep_pending');
  const [proposalKey, setProposalKey] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** Party names off the row itself, so the picker cannot offer a key the server will refuse. */
  const parties = useMemo(() => {
    const proposals = review.proposals;
    if (Array.isArray(proposals)) {
      return proposals.map((p, i) =>
        typeof p === 'object' && p !== null && 'party' in p
          ? String((p as { party: unknown }).party)
          : String(i),
      );
    }
    if (typeof proposals === 'object' && proposals !== null) return Object.keys(proposals);
    return [];
  }, [review.proposals]);

  const act = useCallback(
    async (run: () => Promise<{ ok: boolean; failure?: { detail: string | null } }>) => {
      setBusy(true);
      setProblem(null);
      const result = (await run()) as { ok: boolean; failure?: { detail: string | null } };
      setBusy(false);
      if (result.ok) {
        onChanged();
        return;
      }
      // Nothing was queued — see rule 1. "Nothing was saved" leads the
      // sentence and is never conditional on the failure kind: it is the
      // difference between "try again in a moment" and somebody walking away
      // believing this item is done.
      const why =
        (result.failure as { detail?: string | null; message?: string } | undefined)?.detail ??
        (result.failure as { message?: string } | undefined)?.message ??
        null;
      setProblem(`Nothing was saved. ${why ?? 'The office did not accept that; it can be tried again.'}`);
    },
    [onChanged],
  );

  const claimed = review.claimedBy !== null;

  return (
    <li className={`review-card review-sev-${review.severity}`}>
      <div className="review-head">
        <span className={`review-severity review-severity-${review.severity}`}>
          {severityLabel(review.severity)}
        </span>
        <span className="review-class">{conflictTitle(review.conflictClass)}</span>
        <span className="review-when">{whenLabel(review.openedAt)}</span>
      </div>

      {conflictSummary(review.conflictClass) === null ? null : (
        <p className="review-summary">{conflictSummary(review.conflictClass)}</p>
      )}

      <p className="review-entity">
        {entityLabel(review.entityTable)} · {escalationLabel(review.escalateAt, Date.now())}
        <span className="review-code tabular">
          {review.conflictClass}
          {review.fieldPath === null ? '' : ` · ${review.fieldPath}`}
        </span>
      </p>

      {claimed ? (
        <p className="review-claimed" role="status">
          <Icon name="clock" size={16} /> Someone is already working on this.
        </p>
      ) : null}

      <button
        type="button"
        className="secondary-action pressable"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? 'Hide the detail' : 'Show the detail'}
      </button>

      {open ? (
        <div className="review-detail">
          <Payload label="What the record says now" value={review.pendingValue} />
          <Payload label="What each side says" value={review.proposals} />
          <Payload label="Last agreed value" value={review.ancestorValue} />

          <fieldset className="review-decision">
            <legend>Your decision</legend>
            {CHOICES.map((c) => (
              <label key={c.id} className="review-choice">
                <input
                  type="radio"
                  name={`choice-${review.reviewId}`}
                  value={c.id}
                  checked={choice === c.id}
                  onChange={() => setChoice(c.id)}
                />
                <span className="review-choice-label">{c.label}</span>
                <span className="review-choice-help">{c.help}</span>
              </label>
            ))}

            {choice === 'accept_proposal' ? (
              <label className="review-field">
                <span>Whose version is correct?</span>
                <select value={proposalKey} onChange={(e) => setProposalKey(e.target.value)}>
                  <option value="">Choose…</option>
                  {parties.map((party) => (
                    <option key={party} value={party}>
                      {party}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="review-field">
              <span>Why (this is kept with the record)</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="What you checked, and what you decided."
              />
            </label>

            <p className="review-caveat">
              This records your decision against the item. It does <strong>not</strong> change the
              original record — if something needs correcting, that is a separate job.
            </p>

            {problem === null ? null : (
              <p className="review-problem" role="alert">
                {problem}
              </p>
            )}

            <div className="review-actions">
              {claimed ? (
                <button
                  type="button"
                  className="secondary-action pressable"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      claimReview(
                        { idempotencyKey: uuidv7(), reviewId: review.reviewId, release: true },
                        apiOptions,
                      ),
                    )
                  }
                >
                  Hand it back
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary-action pressable"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      claimReview(
                        { idempotencyKey: uuidv7(), reviewId: review.reviewId },
                        apiOptions,
                      ),
                    )
                  }
                >
                  I am working on this
                </button>
              )}
              <button
                type="button"
                className="primary-action pressable"
                disabled={
                  busy ||
                  note.trim().length < 3 ||
                  (choice === 'accept_proposal' && proposalKey === '')
                }
                onClick={() =>
                  void act(() =>
                    resolveReview(
                      {
                        idempotencyKey: uuidv7(),
                        reviewId: review.reviewId,
                        choice,
                        ...(choice === 'accept_proposal' ? { proposalKey } : {}),
                        note: note.trim(),
                      },
                      apiOptions,
                    ),
                  )
                }
              >
                Record this decision
              </button>
            </div>
          </fieldset>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Stable identity for the default. An inline `= {}` default is a NEW object
 * every render, the query below lists it as a dependency, so every answer
 * re-rendered, re-fetched and re-rendered again — thousands of requests a
 * minute on a metered connection while this screen was open.
 */
const NO_OPTIONS: ApiCallOptions = {};

export function Review({ apiOptions = NO_OPTIONS }: { readonly apiOptions?: ApiCallOptions }): ReactNode {
  const { state, refresh } = useApiQuery(() => fetchReviews({}, apiOptions), [apiOptions]);

  if (state.status === 'loading') return <ServerPending shape="cards" what={WHAT} rows={3} slow={state.slow} />;
  if (state.status === 'failed') {
    return <ServerUnavailable what={WHAT} failure={state.failure} onRetry={refresh} />;
  }

  const { reviews, hiddenCount } = state.data;

  return (
    <section className="review-screen">
      <header className="review-screen-head">
        <h2>Items needing a decision</h2>
        <p className="review-screen-note">
          These are things the system could not settle on its own. Nothing here is guessed at, and
          nothing is thrown away.
        </p>
      </header>

      {reviews.length === 0 ? (
        <div className="empty-state empty-good" role="status">
          <Icon name="check" size={40} />
          <span className="empty-title">All clear</span>
          <p className="empty-body">
            Nothing is waiting on you. When the system meets something it cannot settle on its own,
            it lands here.
          </p>
        </div>
      ) : (
        <ul className="review-list">
          {reviews.map((review) => (
            <ReviewCard
              key={review.reviewId}
              review={review}
              apiOptions={apiOptions}
              onChanged={refresh}
            />
          ))}
        </ul>
      )}

      {hiddenCount > 0 ? (
        // Never swallowed: "nothing is waiting on you" and "there are items
        // nobody at your level may touch" are different sentences, and the
        // second reads as the first without this line — which is how a queue
        // quietly stops being worked.
        <p className="review-hidden" role="status">
          {hiddenCount === 1
            ? '1 more item is waiting for someone with different access.'
            : `${hiddenCount} more items are waiting for someone with different access.`}
        </p>
      ) : null}

      <FetchedAt atMs={state.fetchedAtMs} />
    </section>
  );
}
