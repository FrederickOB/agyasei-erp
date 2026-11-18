/**
 * CASH-UP — closing the till (08 §8.2a; 05 §5.6.2 rules 11 and 11b).
 *
 * The rule this screen exists to keep: EXPECTED, COUNTED AND VARIANCE ARE
 * SHOWN BEFORE THE CLOSE IS CONFIRMED, never after. Expected is computed on
 * this device from the till's own float and the cash applied to every sale
 * rung into it — every sale, synced or not, because the money is in the drawer
 * either way. The server recomputes its own expected figure from what it
 * recorded and keeps both; a disagreement is visible, never silently
 * preferred.
 *
 * "Taken to the bank" is the cash that leaves the drawer at close (rule 11).
 * What stays is tomorrow's float. The close is a queued write like a sale: it
 * completes with the radio off and reaches the server after the last sale
 * rung into the till, because the outbox is ordered.
 */
import { useState, type ReactNode } from 'react';
import { format } from '@erp/money';
import type { LocalDb } from '../../data/db';
import {
  closeTill,
  TillError,
  tillExpectedCash,
  tillVariance,
  type ClosedTill,
  type Till,
} from '../../data/mutations/till';
import { useLiveQuery } from '../../data/use-live-query';
import type { ClaimedHlcClock } from '../../lib/hlc';
import { useCurrencySpec } from '../../money/CurrencyContext';
import { Money } from '../../money/Money';
import { parseMoneyOrNull } from '../../money/parse-input';
import { Icon } from '../../ui/Icon';
import { longDate } from './OpenTill';

export function CashUp({
  db,
  till,
  hlc,
  canClose,
  onClosed,
  onBack,
}: {
  readonly db: LocalDb;
  readonly till: Till;
  readonly hlc: () => ClaimedHlcClock | null;
  readonly canClose: boolean;
  readonly onClosed: (closed: ClosedTill) => void;
  readonly onBack: () => void;
}): ReactNode {
  const spec = useCurrencySpec();
  const expected = useLiveQuery(db, (d) => tillExpectedCash(d, till), [till.id]);
  const [countedText, setCountedText] = useState('');
  const [bankedText, setBankedText] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const counted = parseMoneyOrNull(countedText, spec);
  const bankedEntered = bankedText.trim().length > 0;
  const banked = bankedEntered ? parseMoneyOrNull(bankedText, spec) : 0n;
  const variance = expected === undefined || counted === null ? null : tillVariance(expected, counted);
  const bankedTooMuch = counted !== null && banked !== null && banked > counted;
  const ready =
    canClose && !busy && counted !== null && banked !== null && !bankedTooMuch && expected !== undefined;

  const confirm = async (): Promise<void> => {
    const clock = hlc();
    if (!ready || clock === null || counted === null || banked === null) return;
    setBusy(true);
    setRefusal(null);
    try {
      const closed = await closeTill(db, {
        tillId: till.id,
        countedMinor: counted,
        ...(banked > 0n ? { bankedMinor: banked } : {}),
        hlc: clock,
      });
      onClosed(closed);
    } catch (err) {
      setRefusal(err instanceof TillError ? err.message : `The till did not close: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const varianceClass =
    variance === null ? '' : variance === 0n ? ' matched' : variance < 0n ? ' short' : ' over';

  return (
    <section className="tender-panel till-cashup" aria-label="Cash up the till">
      <div className="tender-due">
        <span className="total-label">Cashing up the till for</span>
        <span className="till-date">{longDate(till.businessDate)}</span>
      </div>

      {!canClose ? (
        <p className="sale-refused" role="alert">
          <Icon name="alert" size={22} />
          <span>Cashing up is not part of what you are allowed to do here. Ask a manager.</span>
        </p>
      ) : null}

      <div className="till-figures">
        <div className="total-row">
          <span className="total-label">Opening float</span>
          <Money amount={till.openingFloatMinor} className="money" />
        </div>
        <div className="total-row">
          <span className="total-label">Expected in the drawer</span>
          {expected === undefined ? <span>…</span> : <Money amount={expected} className="money total-value" />}
        </div>
      </div>

      <label className="tender-label" htmlFor="till-counted">
        Counted cash in the drawer
      </label>
      <input
        id="till-counted"
        className="tender-input money"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder={format(0n, spec)}
        value={countedText}
        onChange={(e) => setCountedText(e.target.value)}
      />

      <div className={`till-variance${varianceClass}`} role="status" aria-live="polite">
        <span className="total-label">
          {variance === null ? 'Variance' : variance === 0n ? 'Counted to the minor unit' : variance < 0n ? 'Short' : 'Over'}
        </span>
        {variance === null ? (
          <span className="total-value">—</span>
        ) : (
          <Money amount={variance < 0n ? -variance : variance} className="money total-value" />
        )}
      </div>

      <label className="tender-label" htmlFor="till-banked">
        Taken out for the bank (optional)
      </label>
      <input
        id="till-banked"
        className="tender-input money"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder={format(0n, spec)}
        value={bankedText}
        onChange={(e) => setBankedText(e.target.value)}
      />
      {bankedTooMuch ? (
        <p className="tender-hint" role="alert">You cannot bank more than you counted.</p>
      ) : null}

      {refusal !== null ? (
        <p className="sale-refused" role="alert">
          <Icon name="alert" size={22} />
          <span>{refusal}</span>
        </p>
      ) : null}

      <div className="tender-actions">
        <button type="button" className="secondary-action pressable" onClick={onBack}>
          <Icon name="back" size={20} />
          Back to the counter
        </button>
        <button
          type="button"
          className="primary-action pressable"
          disabled={!ready}
          onClick={() => void confirm()}
        >
          <Icon name="check" size={20} />
          {busy ? 'Closing…' : 'Close the till'}
        </button>
      </div>
    </section>
  );
}
