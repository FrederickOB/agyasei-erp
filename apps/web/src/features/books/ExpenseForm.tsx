/**
 * RECORD AN EXPENSE — a modal sheet over the P&L sheet. Online only.
 *
 * What it is: an operational record of money paid out (rent, fuel, the
 * electricity bill), booked at one outlet or warehouse or to the whole
 * business. What it is NOT: a journal entry — nothing here touches the books'
 * ledger, which waits for the accountant (Track B).
 *
 * Three rules this form keeps:
 *  1. THE IDEMPOTENCY KEY IS MINTED WHEN THE FORM OPENS and held across every
 *     retry: a double tap, or a retry after a timeout, is ONE expense, never
 *     two (the server replays the stored answer for a key it has seen).
 *  2. THE AMOUNT GOES OUT AS THE TEXT TYPED. It is checked here against the
 *     currency's own number of decimal places — the same exact parser the
 *     server runs — so "12.505" is caught before it is sent, but the server is
 *     the authority and the arithmetic is never done in a float.
 *  3. A CATEGORY IS PICKED OR TYPED. A typed name that matches an existing one
 *     (any capitalisation) files under it; a new name creates the category.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EXPENSE_PAID_FROM, parseMajorAmount, type ExpensePaidFrom } from '@erp/contracts';
import type { ApiCallOptions } from '../../data/api/client';
import {
  fetchExpenseCategories,
  PAID_FROM_TEXT,
  recordExpense,
  type ExpenseCategory,
} from '../../data/api/expenses';
import { uuidv7 } from '../../lib/uuidv7';
import { useCurrencySpec } from '../../money/CurrencyContext';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';

export interface ExpenseLocationChoice {
  readonly locationId: string;
  readonly label: string;
}

const WHOLE_BUSINESS = '';

export function ExpenseForm({
  apiOptions,
  today,
  locations,
  initialLocationId,
  onRecorded,
  onClose,
}: {
  readonly apiOptions: ApiCallOptions;
  /** The default expense date, YYYY-MM-DD. */
  readonly today: string;
  /** Places this person may book an expense at. "Whole business" is always offered. */
  readonly locations: readonly ExpenseLocationChoice[];
  readonly initialLocationId: string | null;
  readonly onRecorded: () => void;
  readonly onClose: () => void;
}): ReactNode {
  const spec = useCurrencySpec();
  // Rule 1: minted once, when the form opens; held across retries.
  const [key] = useState(() => uuidv7());
  const [expenseDate, setExpenseDate] = useState(today);
  const [locationId, setLocationId] = useState<string>(initialLocationId ?? WHOLE_BUSINESS);
  const [categoryText, setCategoryText] = useState('');
  const [amount, setAmount] = useState('');
  const [paidFrom, setPaidFrom] = useState<ExpensePaidFrom>('CASH');
  const [payee, setPayee] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [categories, setCategories] = useState<readonly ExpenseCategory[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void fetchExpenseCategories(apiOptions).then((r) => {
      if (alive && r.ok) setCategories(r.data);
    });
    return () => {
      alive = false;
    };
  }, [apiOptions]);

  // Focus in on open, Escape to close, focus back where it came from.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    sheetRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => before?.focus?.();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Rule 2: the currency's minor units per major unit, from the PACK's scale.
  const minorPerMajor = useMemo(() => 10n ** BigInt(spec.scale), [spec.scale]);
  const amountTrimmed = amount.trim();
  const parsed = amountTrimmed === '' ? null : parseMajorAmount(amountTrimmed, minorPerMajor);
  const amountProblem =
    amountTrimmed === ''
      ? null
      : parsed === null
        ? `Type the amount as a plain number with at most ${String(spec.scale)} decimal place${spec.scale === 1 ? '' : 's'}, e.g. 1250${spec.scale > 0 ? `.${'5'.padEnd(spec.scale, '0')}` : ''}.`
        : parsed <= 0n
          ? 'An expense is an amount above zero.'
          : null;

  const categoryName = categoryText.trim();
  const matched = categories.find((c) => c.name.toLowerCase() === categoryName.toLowerCase());
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(expenseDate);
  const ready = !busy && dateOk && categoryName.length > 0 && parsed !== null && parsed > 0n;

  const submit = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    setFailure(null);
    const r = await recordExpense(
      {
        idempotencyKey: key,
        expenseDate,
        locationId: locationId === WHOLE_BUSINESS ? null : locationId,
        category: matched === undefined ? { name: categoryName } : { id: matched.categoryId },
        amount: amountTrimmed,
        paidFrom,
        ...(payee.trim() === '' ? {} : { payee: payee.trim() }),
        ...(reference.trim() === '' ? {} : { reference: reference.trim() }),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      },
      apiOptions,
    );
    setBusy(false);
    if (!r.ok) {
      const said = r.failure.detail === null ? r.failure.message : `${r.failure.message} ${r.failure.detail}`;
      // The device ceiling (trpc.ts assertLocationInScope): this device is not
      // set up for that location. Say what to do, not what the token says.
      setFailure(
        /outside this token/i.test(said)
          ? 'This device is not set up for that location, so it cannot book expenses there. Choose “Whole business”, or record it from a device at that location.'
          : said,
      );
      return;
    }
    onRecorded();
  };

  return (
    <>
      <div className="sheet-scrim" aria-hidden="true" onClick={onClose} />
      <div ref={sheetRef} className="modal-sheet expense-sheet" role="dialog" aria-modal="true" aria-label="Record an expense">
        <span className="sheet-grip" aria-hidden="true" />
        <div className="modal-sheet-head">
          <h2 className="modal-sheet-title">Record an expense</h2>
          <button type="button" className="sheet-close pressable" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>
        <form
          className="modal-sheet-body expense-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="expense-form-note">
            Money the business paid out. It counts in the P&amp;L sheet; it is not a ledger entry.
          </p>
          <div className="expense-form-grid">
            <label className="tender-field">
              Date paid
              <input className="expense-input" type="date" value={expenseDate} max={today} onChange={(e) => setExpenseDate(e.target.value)} />
            </label>
            <label className="tender-field">
              Where
              <select className="expense-input" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value={WHOLE_BUSINESS}>Whole business</option>
                {locations.map((l) => (
                  <option key={l.locationId} value={l.locationId}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="tender-field">
            Category
            <input
              className="expense-input"
              list="expense-category-options"
              value={categoryText}
              placeholder="Pick one, or type a new one (e.g. Rent, Fuel)"
              maxLength={80}
              autoComplete="off"
              data-autofocus
              onChange={(e) => setCategoryText(e.target.value)}
            />
            <datalist id="expense-category-options">
              {categories.map((c) => (
                <option key={c.categoryId} value={c.name} />
              ))}
            </datalist>
            {categoryName.length > 0 && matched === undefined ? (
              <span className="expense-form-hint">New category — it will be added when you record this.</span>
            ) : null}
          </label>
          <div className="expense-form-grid">
            <label className="tender-field">
              Amount
              <input
                className="expense-input tabular"
                inputMode="decimal"
                value={amount}
                placeholder="0"
                aria-invalid={amountProblem !== null}
                aria-describedby="expense-amount-help"
                onChange={(e) => setAmount(e.target.value)}
              />
              <span id="expense-amount-help" className={amountProblem === null ? 'expense-form-hint' : 'expense-form-problem'}>
                {amountProblem ?? (parsed !== null && parsed > 0n ? <>Records <Money amount={parsed} /></> : ' ')}
              </span>
            </label>
            <label className="tender-field">
              Paid from
              <select className="expense-input" value={paidFrom} onChange={(e) => setPaidFrom(e.target.value as ExpensePaidFrom)}>
                {EXPENSE_PAID_FROM.map((p) => (
                  <option key={p} value={p}>
                    {PAID_FROM_TEXT[p]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="expense-form-grid">
            <label className="tender-field">
              Paid to <span className="expense-form-optional">(optional)</span>
              <input className="expense-input" value={payee} maxLength={120} onChange={(e) => setPayee(e.target.value)} />
            </label>
            <label className="tender-field">
              Reference <span className="expense-form-optional">(optional)</span>
              <input className="expense-input" value={reference} maxLength={80} placeholder="Receipt or invoice no." onChange={(e) => setReference(e.target.value)} />
            </label>
          </div>
          <label className="tender-field">
            Note <span className="expense-form-optional">(optional)</span>
            <textarea className="expense-input expense-textarea" value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} />
          </label>

          {failure !== null ? (
            <p className="sale-refused" role="alert">
              <Icon name="alert" size={22} />
              <span>{failure}</span>
            </p>
          ) : null}

          <div className="expense-form-actions">
            <button type="button" className="office-btn office-btn-soft pressable" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="office-btn pressable" disabled={!ready}>
              <Icon name="check" size={18} /> {busy ? 'Recording…' : 'Record expense'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
