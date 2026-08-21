/**
 * The block a device sees when it cannot name the counter it is standing on.
 *
 * §8.1: a device failing a hard gate gets a full-screen, plainly-worded block
 * naming the specific failure and the fix. It never degrades into a
 * half-working till. Which failure it is matters — "your sign-in covers four
 * locations, pick one" and "your sign-in covers none, ask for one" call for
 * different actions by different people, and a single generic sentence sends
 * whoever is standing there off to do the wrong one.
 *
 * The choice list is the minimal selection path required for the ambiguous
 * case. It offers ONLY the locations the session already covers, so a wrong
 * tap is impossible rather than merely discouraged, and it re-reads the
 * candidates live: the codes and names fill themselves in as the tenant's
 * `location` rows arrive over the sync stream.
 */
import { useCallback, useState, type ReactNode } from 'react';
import type { LocalDb } from '../../data/db';
import {
  chooseDeviceLocation,
  readLocationChoices,
  type DeviceLocationState,
  type LocationChoice,
} from '../../data/session/device-location';
import { useLiveQuery } from '../../data/use-live-query';

function labelFor(choice: LocationChoice): { primary: string; secondary: string | null } {
  if (choice.name !== null) {
    return { primary: choice.name, secondary: choice.code.length > 0 ? choice.code : null };
  }
  if (choice.code.length > 0) return { primary: choice.code, secondary: null };
  // The row has not synced yet. The id is not a nice label, but it is the
  // truth, and it is enough to match against a list someone was given.
  return { primary: choice.id, secondary: 'details still arriving' };
}

export interface DeviceLocationGateProps {
  readonly db: LocalDb;
  readonly state: DeviceLocationState;
  readonly bearerToken: string | null;
  readonly onChosen: (next: DeviceLocationState) => void;
}

export function DeviceLocationGate({
  db,
  state,
  bearerToken,
  onChosen,
}: DeviceLocationGateProps): ReactNode {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ids = state.choices.map((c) => c.id);
  const key = ids.join(',');
  // Re-read the candidate rows as they arrive, so a list that opened as bare
  // ids becomes a list of names without anyone reloading the till.
  const live = useLiveQuery(db, (d) => readLocationChoices(d, ids), [key]);
  const choices = live ?? state.choices;

  const onChoose = useCallback(
    (locationId: string) => {
      setBusy(locationId);
      setError(null);
      void chooseDeviceLocation(db, bearerToken, locationId)
        .then(onChosen)
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setBusy(null));
    },
    [db, bearerToken, onChosen],
  );

  return (
    <main className="device-gate">
      <h1>This till is not set up yet</h1>
      <p className="device-gate-message">{state.message}</p>
      {state.status === 'ambiguous' ? (
        <>
          <h2>Which counter is this?</h2>
          <ul className="device-gate-choices">
            {choices.map((choice) => {
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
            Choose the counter this device stands at. A sale recorded against the wrong one moves
            stock and cash at a counter that never saw it.
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
