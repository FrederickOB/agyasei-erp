/**
 * The block a device sees when it cannot name the price list it sells from.
 *
 * §8.1: a device failing a hard gate gets a full-screen, plainly-worded block
 * naming the specific failure and the fix. It never degrades into a
 * half-working till. Which failure it is matters enormously here, because the
 * three of them belong to three different people:
 *
 *   awaiting-config → nobody. The rows are on their way; leave it connected.
 *                     This screen dismisses itself when they land.
 *   ambiguous       → whoever is standing at the counter, right now.
 *   unconfigured    → whoever maintains the tenant's price lists, not the
 *                     counter. Telling a cashier to "choose a price list"
 *                     when none exists sends them off to do the impossible.
 *
 * The choice list offers ONLY lists the tenant's configuration already covers
 * this counter with, so a wrong tap is impossible rather than merely
 * discouraged. Its words — codes and names — are the tenant's own (§8.9).
 */
import { useCallback, useState, type ReactNode } from 'react';
import type { LocalDb } from '../../data/db';
import {
  chooseDevicePriceList,
  type DevicePriceListState,
  type PriceListChoice,
} from '../../data/session/device-price-list';

function labelFor(choice: PriceListChoice): { primary: string; secondary: string | null } {
  if (choice.name !== null) {
    return { primary: choice.name, secondary: choice.code.length > 0 ? choice.code : null };
  }
  if (choice.code.length > 0) return { primary: choice.code, secondary: null };
  // The row is here but unnamed. The id is not a nice label, but it is the
  // truth, and it is enough to match against a list someone was given.
  return { primary: choice.id, secondary: 'details still arriving' };
}

export interface DevicePriceListGateProps {
  readonly db: LocalDb;
  readonly state: DevicePriceListState;
  readonly bearerToken: string | null;
  readonly onChosen: (next: DevicePriceListState) => void;
}

export function DevicePriceListGate({
  db,
  state,
  bearerToken,
  onChosen,
}: DevicePriceListGateProps): ReactNode {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onChoose = useCallback(
    (priceListId: string) => {
      setBusy(priceListId);
      setError(null);
      void chooseDevicePriceList(db, bearerToken, priceListId)
        .then(onChosen)
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setBusy(null));
    },
    [db, bearerToken, onChosen],
  );

  const waiting = state.status === 'awaiting-config';

  return (
    <main className="device-gate">
      <h1>{waiting ? 'Getting this till ready' : 'This till is not set up yet'}</h1>
      <p className="device-gate-message">{state.message}</p>
      {state.status === 'ambiguous' ? (
        <>
          <h2>Which prices does this counter charge?</h2>
          <ul className="device-gate-choices">
            {state.choices.map((choice) => {
              const label = labelFor(choice);
              return (
                <li key={choice.id}>
                  <button
                    type="button"
                    className="device-gate-choice"
                    disabled={busy !== null}
                    onClick={() => onChoose(choice.id)}
                  >
                    <span className="device-gate-choice-name">{label.primary}</span>
                    {label.secondary !== null ? (
                      <span className="device-gate-choice-code">{label.secondary}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="device-gate-note">
            Choose the prices this counter charges a walk-in customer. The wrong list charges every
            customer the wrong amount until someone notices.
          </p>
        </>
      ) : null}
      {error !== null ? (
        <p className="device-gate-error" role="alert">
          {error}
        </p>
      ) : null}
    </main>
  );
}
