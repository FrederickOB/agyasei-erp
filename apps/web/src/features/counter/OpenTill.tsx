/**
 * OPEN THE TILL — the counter's first screen whenever no till is open
 * (08 §8.2a). There is no path to the cart from here except through this.
 *
 * What it asks for, and why each is a control rather than a form field:
 *
 *  · THE DATE, shown large and unabbreviated. It is prefilled from the
 *    device's best estimate in the LOCATION's timezone and the person
 *    confirms it — a tablet four days out shows a date anybody can see is
 *    wrong. Every sale rung into this till is filed, priced and taxed on it.
 *  · THE OPENING FLOAT, on the money keypad. After a midnight close the
 *    drawer the till left behind is offered as the float: a carry-over into a
 *    NEW till, never an extension of the old one.
 *
 * Online, the server is asked first — its own date at this location (±1 day)
 * and the accounting period's state — and its refusal is shown with its date.
 * Offline the till opens anyway and is marked opened offline, which the close
 * report and the outlet's reconciliation carry (§8.2a). The open itself is a
 * queued write; this screen never waits on a socket to let a till open.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { format } from '@erp/money';
import type { ApiCallOptions } from '../../data/api/client';
import { couldNotAsk, fetchOpenCheck } from '../../data/api/cash-session';
import type { LocalDb } from '../../data/db';
import { openTill, proposedBusinessDate, TillError, type Till } from '../../data/mutations/till';
import { readDeviceLocation } from '../../data/queries/session';
import type { ClaimedHlcClock } from '../../lib/hlc';
import { useCurrencySpec } from '../../money/CurrencyContext';
import { Money } from '../../money/Money';
import { parseMoneyOrNull } from '../../money/parse-input';
import { Icon } from '../../ui/Icon';

/** "Monday 4 January 2027" — rendered as a calendar date, never shifted by a zone. */
export function longDate(ymd: string): string {
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  if (Number.isNaN(ms)) return ymd;
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(ms));
}

/** How long the pre-open check waits before the till opens offline instead. */
const OPEN_CHECK_TIMEOUT_MS = 5_000;

export function OpenTill({
  db,
  hlc,
  canOpen,
  carriedOver,
  apiOptions,
  nowIso,
  onOpened,
}: {
  readonly db: LocalDb;
  readonly hlc: () => ClaimedHlcClock | null;
  /** Whether this session may open a till. A courtesy, never the control. */
  readonly canOpen: boolean;
  /** The till the midnight close just ended, and what its drawer should hold. */
  readonly carriedOver: { readonly till: Till; readonly drawerMinor: bigint } | null;
  readonly apiOptions?: ApiCallOptions;
  /** Test seam for "now". */
  readonly nowIso?: () => string;
  readonly onOpened: (till: Till) => void;
}): ReactNode {
  const spec = useCurrencySpec();
  const [date, setDate] = useState<string | null>(null);
  const [floatText, setFloatText] = useState(
    carriedOver === null ? '' : format(carriedOver.drawerMinor, spec),
  );
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const now = useMemo(() => nowIso ?? (() => new Date().toISOString()), [nowIso]);

  useEffect(() => {
    void proposedBusinessDate(db, now()).then(setDate);
  }, [db, now]);

  const floatMinor = parseMoneyOrNull(floatText, spec);

  const open = async (): Promise<void> => {
    const clock = hlc();
    if (date === null || floatMinor === null || clock === null || busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      const location = await readDeviceLocation(db);
      if (location === null) {
        setRefusal('This device has no location assigned yet.');
        return;
      }
      const check = await fetchOpenCheck(
        { locationId: location.id, businessDate: date },
        { timeoutMs: OPEN_CHECK_TIMEOUT_MS, ...(apiOptions ?? {}) },
      );
      let openedOffline: boolean;
      if (check.ok) {
        if (check.data.refusal !== null) {
          setRefusal(check.data.refusal);
          return;
        }
        openedOffline = false;
      } else if (couldNotAsk(check)) {
        openedOffline = true; // §8.2a: permitted, and flagged
      } else {
        setRefusal(check.failure.message);
        return;
      }
      const till = await openTill(db, {
        openingFloatMinor: floatMinor,
        businessDate: date,
        openedOffline,
        hlc: clock,
        nowIso: now(),
      });
      onOpened(till);
    } catch (err) {
      setRefusal(err instanceof TillError ? err.message : `The till did not open: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="tender-panel till-open" aria-label="Open the till">
      {carriedOver !== null ? (
        <div className="till-carry" role="status">
          <Icon name="clock" size={22} />
          <span>
            The till for {longDate(carriedOver.till.businessDate)} closed itself at midnight without
            a count. Its drawer should hold <Money amount={carriedOver.drawerMinor} className="money" />;
            count it into today’s float below.
          </span>
        </div>
      ) : null}

      <div className="tender-due">
        <span className="total-label">Opening the till for</span>
        <span className="till-date" aria-live="polite">
          {date === null ? '…' : longDate(date)}
        </span>
        <p className="total-note">
          If that is not today, stop and check this tablet’s date and time before opening.
        </p>
      </div>

      {!canOpen ? (
        <p className="sale-refused" role="alert">
          <Icon name="alert" size={22} />
          <span>Opening the till is not part of what you are allowed to do here. Ask a manager.</span>
        </p>
      ) : null}

      <label className="tender-label" htmlFor="till-float">
        Opening float — the cash in the drawer now
      </label>
      <input
        id="till-float"
        className="tender-input money"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder={format(0n, spec)}
        value={floatText}
        onChange={(e) => setFloatText(e.target.value)}
      />

      {refusal !== null ? (
        <p className="sale-refused" role="alert">
          <Icon name="alert" size={22} />
          <span>{refusal}</span>
        </p>
      ) : null}

      <button
        type="button"
        className="primary-action pressable"
        disabled={!canOpen || busy || date === null || floatMinor === null}
        onClick={() => void open()}
      >
        <Icon name="check" size={20} />
        {busy ? 'Opening…' : 'Open the till'}
      </button>
    </section>
  );
}
