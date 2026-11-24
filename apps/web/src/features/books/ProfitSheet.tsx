/**
 * THE P&L SHEET — "calculate our actual P&L", in the founder's words.
 *
 * A MANAGEMENT profit and loss, computed by the server from operational
 * records: sales (ex-tax, after discounts, net of voids and returns), the cost
 * of what was sold (weighted-average cost from costed deliveries, else the
 * stated cost price), and the expenses people record here. It is NOT the
 * audited ledger — the ledger's own statements sit on the other tabs and wait
 * for the accountant — and the sheet says so in plain words, every time.
 *
 * Three honesty rules:
 *  1. WHAT IS ESTIMATED IS SAID. The part of the cost of goods sold that came
 *     from a stated cost price is named, with its amount.
 *  2. WHAT IS MISSING IS LISTED, NEVER GUESSED. A product sold with no cost at
 *     all is listed by name with what to do about it; the profit above it is
 *     overstated and the sheet says so rather than quietly using zero.
 *  3. AN EMPTY PERIOD IS A STATE. Nothing sold and nothing spent is a sentence,
 *     not an error and not a table of zeros that reads like a quiet month.
 *
 * Money is bigint from the wire to the <Money> boundary; the margin is an
 * integer × 10⁴ formatted once (lib/ratio). Nothing here does arithmetic on a
 * float.
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { ApiCallOptions } from '../../data/api/client';
import {
  fetchExpenses,
  fetchProfitSheet,
  PAID_FROM_TEXT,
  voidExpense,
  type ExpenseEntry,
  type ProfitFigures,
  type ProfitSheet,
} from '../../data/api/expenses';
import {
  CAPABILITY,
  holdsCapability,
  holdsCapabilityAt,
  type PermissionsState,
} from '../../data/api/session';
import { useApiQuery } from '../../data/api/use-api-query';
import { formatQtyScaled } from '../../lib/quantity';
import { formatPercentE4 } from '../../lib/ratio';
import { uuidv7 } from '../../lib/uuidv7';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';
import { FetchedAt, ServerPending, ServerUnavailable } from '../shell/ServerAnswer';
import { ExpenseForm, type ExpenseLocationChoice } from './ExpenseForm';

type Preset = 'this-month' | 'last-month' | 'custom';

const PRESETS: readonly { readonly id: Preset; readonly label: string }[] = [
  { id: 'this-month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'custom', label: 'Custom' },
];

const ALL = 'all';

const pad = (n: number): string => String(n).padStart(2, '0');

/** This device's calendar date. A default for a picker, never a trading day. */
function localToday(): string {
  const d = new Date();
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthStart(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

/** The first and last day of the month before the one `ymd` falls in. */
function previousMonth(ymd: string): { from: string; to: string } {
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(5, 7)); // 1–12
  const py = month === 1 ? year - 1 : year;
  const pm = month === 1 ? 12 : month - 1;
  const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return { from: `${String(py)}-${pad(pm)}-01`, to: `${String(py)}-${pad(pm)}-${pad(last)}` };
}

function inclusiveDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** A signed amount as a statement shows it: a loss is a positive figure under a "loss" label. */
function Magnitude({ amount }: { readonly amount: bigint }): ReactNode {
  return <Money amount={amount < 0n ? -amount : amount} />;
}

function Statement({
  figures,
  wholeBusinessMinor,
  locationPicked,
  sheet,
}: {
  readonly figures: ProfitFigures;
  /** Expenses booked to no location, when they are inside `figures`. */
  readonly wholeBusinessMinor: bigint | null;
  readonly locationPicked: boolean;
  readonly sheet: ProfitSheet;
}): ReactNode {
  const empty =
    figures.netSalesMinor === 0n && figures.cogsMinor === 0n && figures.totalExpensesMinor === 0n && figures.missingCostCount === 0;
  if (empty) {
    return (
      <div className="books-pl-empty" role="status">
        <Icon name="chart" size={22} />
        <p>
          <strong>Nothing was sold and no expenses were recorded in this period.</strong> Pick another
          period, or record an expense below.
        </p>
      </div>
    );
  }
  const loss = figures.netProfitMinor < 0n;
  const grossLoss = figures.grossProfitMinor < 0n;
  // At one location, each product's OWN quantity there; across all, the total.
  const missing = locationPicked
    ? sheet.missingCost.flatMap((m) => {
        const here = m.byLocation.find((b) => sheet.locations.some((l) => l.locationId === b.locationId));
        return here === undefined ? [] : [{ ...m, qtySold: here.qtySold }];
      })
    : sheet.missingCost;
  return (
    <>
      <table className="books-pl-table">
        <caption className="visually-hidden">Profit and loss for the period</caption>
        <tbody>
          <tr>
            <th scope="row">Sales</th>
            <td className="numeric"><Money amount={figures.netSalesMinor} /></td>
          </tr>
          <tr>
            <th scope="row">
              Cost of goods sold
              {figures.cogsComplete ? null : <span className="tile-pill tile-pill-warn books-pl-flag">incomplete</span>}
            </th>
            <td className="numeric books-pl-less"><Money amount={figures.cogsMinor} /></td>
          </tr>
          <tr className="books-pl-subtotal">
            <th scope="row">
              {grossLoss ? 'Gross loss' : 'Gross profit'}
              <small>
                {figures.grossMarginPctE4 === null
                  ? 'margin unavailable — no sales'
                  : `margin ${formatPercentE4(figures.grossMarginPctE4)}%`}
              </small>
            </th>
            <td className="numeric"><Magnitude amount={figures.grossProfitMinor} /></td>
          </tr>
          <tr className="books-pl-section">
            <th scope="rowgroup" colSpan={2}>Operating expenses</th>
          </tr>
          {figures.expenses.length === 0 ? (
            <tr className="books-pl-indent">
              <th scope="row" className="books-pl-none">No expenses recorded</th>
              <td className="numeric"><Money amount={0n} /></td>
            </tr>
          ) : (
            figures.expenses.map((e) => (
              <tr key={e.categoryId} className="books-pl-indent">
                <th scope="row">{e.categoryName}</th>
                <td className="numeric books-pl-less"><Money amount={e.amountMinor} /></td>
              </tr>
            ))
          )}
          <tr className="books-pl-subtotal">
            <th scope="row">Total expenses</th>
            <td className="numeric"><Money amount={figures.totalExpensesMinor} /></td>
          </tr>
          <tr className={`books-pl-result ${loss ? 'books-pl-result-loss' : 'books-pl-result-profit'}`}>
            <th scope="row">{loss ? 'Net loss' : 'Net profit'}</th>
            <td className="numeric"><Magnitude amount={figures.netProfitMinor} /></td>
          </tr>
        </tbody>
      </table>

      <ul className="books-pl-notes">
        {wholeBusinessMinor !== null && wholeBusinessMinor > 0n ? (
          <li>
            Includes <Money amount={wholeBusinessMinor} /> of expenses booked to the whole business rather than to one
            location.
          </li>
        ) : null}
        {locationPicked && sheet.wholeBusiness !== null && sheet.wholeBusiness.totalExpensesMinor > 0n ? (
          <li>
            Expenses booked to the whole business (<Money amount={sheet.wholeBusiness.totalExpensesMinor} />) belong to
            no single location, so they count only under All locations.
          </li>
        ) : null}
        {figures.cogsAtStatedCostMinor > 0n ? (
          <li>
            <Money amount={figures.cogsAtStatedCostMinor} /> of the cost of goods sold uses the cost price stated in
            Products, because those items have no costed delivery at that location yet.
          </li>
        ) : null}
        {!figures.cogsComplete ? (
          <li className="books-pl-note-warn" role="note">
            <strong>
              {figures.missingCostCount} product{figures.missingCostCount === 1 ? ' was' : 's were'} sold with no
              cost at all
            </strong>
            , so the cost of goods sold is understated and the profit above is overstated by what they cost. Add a cost
            price in Products for:
            <ul className="books-pl-missing">
              {missing.map((m) => (
                <li key={m.productId}>
                  {m.productName} <span className="tabular">({m.skuCode})</span> —{' '}
                  <span className="tabular">
                    {formatQtyScaled(m.qtySold, m.qtyScale)} {m.uomCode}
                  </span>{' '}
                  sold
                </li>
              ))}
            </ul>
          </li>
        ) : null}
      </ul>
    </>
  );
}

function ExpenseRow({
  entry,
  canVoid,
  apiOptions,
  onVoided,
}: {
  readonly entry: ExpenseEntry;
  readonly canVoid: boolean;
  readonly apiOptions: ApiCallOptions;
  readonly onVoided: () => void;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  // Minted when the person starts a void and held across retries of it.
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const start = (): void => {
    setConfirming(true);
    setKey(uuidv7());
    setFailure(null);
  };
  const confirm = async (): Promise<void> => {
    if (key === null || reason.trim() === '') return;
    setBusy(true);
    setFailure(null);
    const r = await voidExpense({ idempotencyKey: key, expenseId: entry.expenseId, reason: reason.trim() }, apiOptions);
    setBusy(false);
    if (!r.ok) {
      setFailure(r.failure.detail === null ? r.failure.message : `${r.failure.message} ${r.failure.detail}`);
      return;
    }
    onVoided();
  };

  return (
    <>
      <tr className={entry.voided ? 'books-expense-voided' : undefined}>
        <td className="tabular">{entry.expenseDate}</td>
        <td>
          {entry.categoryName}
          {entry.voided ? (
            <small className="books-expense-void-note">Voided — {entry.voidReason ?? 'no reason given'}</small>
          ) : entry.note !== null ? (
            <small>{entry.note}</small>
          ) : null}
        </td>
        <td>{entry.locationId === null ? 'Whole business' : (entry.locationCode ?? '')}</td>
        <td>
          {entry.payee ?? '—'}
          {entry.reference !== null ? <small className="tabular">{entry.reference}</small> : null}
        </td>
        <td>{PAID_FROM_TEXT[entry.paidFrom]}</td>
        <td className="numeric">
          <Money amount={entry.amountMinor} />
        </td>
        <td className="books-expense-act">
          {canVoid && !entry.voided && !confirming ? (
            <button type="button" className="tile-link pressable" onClick={start} aria-label={`Void ${entry.categoryName} expense of ${entry.expenseDate}`}>
              Void
            </button>
          ) : null}
        </td>
      </tr>
      {confirming ? (
        <tr className="books-expense-confirm">
          <td colSpan={7}>
            <form
              className="books-expense-confirm-form"
              onSubmit={(e) => {
                e.preventDefault();
                void confirm();
              }}
            >
              <label className="books-expense-reason">
                Why is this expense void?
                <input
                  value={reason}
                  maxLength={200}
                  placeholder="e.g. entered twice, wrong amount"
                  onChange={(e) => setReason(e.target.value)}
                  autoFocus
                />
              </label>
              <button type="submit" className="office-btn pressable books-expense-void-btn" disabled={busy || reason.trim() === ''}>
                {busy ? 'Voiding…' : 'Void expense'}
              </button>
              <button type="button" className="office-btn office-btn-soft pressable" onClick={() => setConfirming(false)} disabled={busy}>
                Keep it
              </button>
              <span className="books-expense-confirm-help">
                A void cannot be undone. If the amount was wrong, void it and record it again.
              </span>
              {failure !== null ? (
                <span className="books-expense-confirm-failure" role="alert">
                  {failure}
                </span>
              ) : null}
            </form>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function ProfitSheetView({
  apiOptions,
  permissions,
}: {
  readonly apiOptions: ApiCallOptions;
  readonly permissions?: PermissionsState | undefined;
}): ReactNode {
  const today = useMemo(localToday, []);
  const [preset, setPreset] = useState<Preset>('this-month');
  const [customFrom, setCustomFrom] = useState(() => monthStart(today));
  const [customTo, setCustomTo] = useState(today);
  const [where, setWhere] = useState<string>(ALL);
  const [reload, setReload] = useState(0);
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<string | null>(null);

  const range = useMemo(() => {
    if (preset === 'this-month') return { from: monthStart(today), to: today };
    if (preset === 'last-month') return previousMonth(today);
    return { from: customFrom, to: customTo };
  }, [preset, customFrom, customTo, today]);
  const valid =
    /^\d{4}-\d{2}-\d{2}$/.test(range.from) &&
    /^\d{4}-\d{2}-\d{2}$/.test(range.to) &&
    range.from <= range.to &&
    inclusiveDays(range.from, range.to) <= 400;

  const sheet = useApiQuery(
    () =>
      valid
        ? fetchProfitSheet({ from: range.from, to: range.to }, apiOptions)
        : Promise.resolve({ ok: false as const, failure: { kind: 'invalid-request' as const, message: 'Choose a valid period.', detail: null, status: null } }),
    [range.from, range.to, valid, apiOptions, reload],
  );
  const list = useApiQuery(
    () =>
      valid
        ? fetchExpenses({ from: range.from, to: range.to }, apiOptions)
        : Promise.resolve({ ok: false as const, failure: { kind: 'invalid-request' as const, message: 'Choose a valid period.', detail: null, status: null } }),
    [range.from, range.to, valid, apiOptions, reload],
  );

  const canRecord = permissions !== undefined && holdsCapability(permissions, CAPABILITY.expenseRecord);
  const canRecordAt = (locationId: string | null): boolean =>
    permissions !== undefined &&
    (locationId === null
      ? holdsCapability(permissions, CAPABILITY.expenseRecord)
      : holdsCapabilityAt(permissions, CAPABILITY.expenseRecord, locationId));

  const data = sheet.state.status === 'ready' ? sheet.state.data : null;
  const picked = data === null || where === ALL ? null : (data.locations.find((l) => l.locationId === where) ?? null);
  const formLocations: ExpenseLocationChoice[] =
    data === null
      ? []
      : data.locations
          .filter((l) => canRecordAt(l.locationId))
          .map((l) => ({ locationId: l.locationId, label: `${l.locationCode} · ${l.locationName}` }));

  const afterWrite = (message: string): void => {
    setRecorded(message);
    setReload((n) => n + 1);
  };

  return (
    <section className="books-pl" aria-label="P&L sheet">
      <div className="books-pl-controls">
        <div className="books-pl-period" role="group" aria-label="Period">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="office-tab pressable"
              aria-pressed={preset === p.id}
              onClick={() => setPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
          {preset === 'custom' ? (
            <span className="reports-custom">
              <label>
                From <input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} />
              </label>
              <label>
                To <input type="date" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} />
              </label>
            </span>
          ) : null}
        </div>
        <label className="books-pl-where">
          Location
          <select value={where} onChange={(e) => setWhere(e.target.value)}>
            <option value={ALL}>All locations</option>
            {(data?.locations ?? []).map((l) => (
              <option key={l.locationId} value={l.locationId}>
                {l.locationCode} · {l.locationName}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!valid ? (
        <p className="tile-sub" role="status">
          Choose a period that ends after it starts and covers at most 400 days.
        </p>
      ) : null}

      <article className="tile books-pl-card">
        <div className="tile-head">
          <h2>{picked === null ? 'Profit & loss · all locations' : `Profit & loss · ${picked.locationCode}`}</h2>
          {data !== null ? (
            <span className={`tile-pill ${(picked ?? data.consolidated).netProfitMinor < 0n ? 'tile-pill-bad' : 'tile-pill-ok'}`}>
              {(picked ?? data.consolidated).netProfitMinor < 0n ? 'Net loss' : 'Net profit'}
            </span>
          ) : null}
        </div>
        <p className="books-pl-basis">
          <Icon name="book" size={16} />
          <span>
            {data?.note ?? 'Management figures from your sales, costs and recorded expenses — not the audited ledger.'}{' '}
            <span className="books-pl-period-label tabular">
              {range.from} to {range.to}
            </span>
          </span>
        </p>
        {valid && sheet.state.status === 'loading' ? (
          <ServerPending shape="table" what="The P&L sheet" rows={6} slow={sheet.state.slow} />
        ) : null}
        {valid && sheet.state.status === 'failed' ? (
          <ServerUnavailable what="The P&L sheet" failure={sheet.state.failure} onRetry={sheet.refresh} />
        ) : null}
        {data !== null ? (
          <>
            <Statement
              figures={picked ?? data.consolidated}
              wholeBusinessMinor={picked === null ? (data.wholeBusiness?.totalExpensesMinor ?? null) : null}
              locationPicked={picked !== null}
              sheet={picked === null ? data : { ...data, locations: [picked] }}
            />
            <p className="tile-foot">
              {data.method} <FetchedAt atMs={sheet.state.status === 'ready' ? sheet.state.fetchedAtMs : 0} />
            </p>
          </>
        ) : null}
      </article>

      <article className="tile books-expenses-card">
        <div className="tile-head">
          <h2>Expenses</h2>
          {canRecord ? (
            <button
              type="button"
              className="office-btn pressable books-expenses-add"
              onClick={() => {
                setRecorded(null);
                setRecording(true);
              }}
            >
              <Icon name="plus" size={18} /> Record expense
            </button>
          ) : null}
        </div>
        {recorded !== null ? (
          <p className="books-ok" role="status">
            {recorded}
          </p>
        ) : null}
        {valid && list.state.status === 'loading' ? (
          <ServerPending shape="table" what="The expense list" rows={3} slow={list.state.slow} />
        ) : null}
        {valid && list.state.status === 'failed' ? (
          <ServerUnavailable what="The expense list" failure={list.state.failure} onRetry={list.refresh} />
        ) : null}
        {list.state.status === 'ready'
          ? (() => {
              const rows = list.state.data.expenses.filter((e) => where === ALL || e.locationId === where);
              if (rows.length === 0) {
                return (
                  <p className="tile-sub">
                    No expenses recorded {where === ALL ? '' : 'at this location '}in this period.
                    {canRecord ? ' Rent, fuel, electricity, wages paid in cash — record them here and the P&L above counts them.' : ''}
                  </p>
                );
              }
              return (
                <div className="office-table-scroll">
                  <table className="office-table books-expense-table">
                    <thead>
                      <tr>
                        <th scope="col">Date</th>
                        <th scope="col">Category</th>
                        <th scope="col">Location</th>
                        <th scope="col">Paid to</th>
                        <th scope="col">Paid from</th>
                        <th scope="col" className="numeric">Amount</th>
                        <th scope="col"><span className="visually-hidden">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((e) => (
                        <ExpenseRow
                          key={e.expenseId}
                          entry={e}
                          canVoid={canRecordAt(e.locationId)}
                          apiOptions={apiOptions}
                          onVoided={() => afterWrite(`Voided the ${e.categoryName} expense of ${e.expenseDate}.`)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()
          : null}
      </article>

      {recording ? (
        <ExpenseForm
          apiOptions={apiOptions}
          today={today}
          locations={formLocations}
          initialLocationId={picked?.locationId ?? null}
          onClose={() => setRecording(false)}
          onRecorded={() => {
            setRecording(false);
            afterWrite('Expense recorded. The P&L above now counts it.');
          }}
        />
      ) : null}
    </section>
  );
}
