/**
 * Taking payment — one or more TENDER LINES (04 §4.8).
 *
 * The layout still answers the three questions in the order a cashier asks
 * them: what is owed, how it is being paid, what goes back. Amount due is
 * stated once, prominently, and never has to be remembered.
 *
 * HOW A SPLIT WORKS, because it is how a split is actually tendered:
 * every line but the last carries the amount the customer said ("50 by mobile
 * money"); the LAST line takes the rest. So a one-method sale is one line that
 * takes everything, and nobody types the total twice. A momo, transfer or
 * cheque line asks for its reference when the tenant's method requires one,
 * and a cash line asks what was handed over and shows the change.
 *
 * The methods, their names and their order are the TENANT's rows
 * (`tender_method`); this file renders them and reads only the platform flags
 * the server derives — is it drawer cash, is it on account, does it need a
 * reference. It never compares a method's code or name to anything (§8.9).
 *
 * Every figure is bigint minor units parsed through @erp/money against the
 * configured CurrencySpec; the arithmetic that decides whether the sale can
 * complete is `settleTenders`, the same function checkout runs, so the screen
 * and the record cannot disagree about whether the payments add up.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { compare, format, sub } from '@erp/money';
import { settleTenders, type TenderDraft } from '../../data/mutations/checkout';
import { lineTotalMinor, type CartPricing } from '../../data/pricing/cart-pricing';
import type { CartLineRow } from '../../data/queries/cart';
import type { CreditCustomer } from '../../data/queries/customers';
import type { TenderMethod } from '../../data/queries/tender-methods';
import { useCurrencySpec } from '../../money/CurrencyContext';
import { Money } from '../../money/Money';
import { parseMoneyOrNull } from '../../money/parse-input';
import { suggestedTenders } from '../../money/quick-cash';
import { formatQtyScaled } from '../../lib/quantity';
import { Icon, type IconName } from '../../ui/Icon';

export interface TenderSubmission {
  readonly tenders: readonly TenderDraft[];
  readonly customerId?: string;
}

interface LineState {
  readonly key: number;
  readonly methodId: string;
  /** What the customer said this line pays. Ignored on the last line. */
  readonly amountText: string;
  readonly reference: string;
  /** Cash lines: what was handed over. */
  readonly receivedText: string;
}

/** Drawn from the method's platform flags — never its code or name (§8.9). */
function methodIcon(m: TenderMethod): IconName {
  if (m.isCash) return 'cash';
  if (m.isOnAccount) return 'user';
  return 'card';
}

let lineKey = 0;
function newLine(methodId: string): LineState {
  lineKey += 1;
  return { key: lineKey, methodId, amountText: '', reference: '', receivedText: '' };
}

export function TenderPanel({
  pricing,
  methods,
  customers,
  canSellOnAccount,
  onAccountCeilingMinor = null,
  onComplete,
  onBack,
  summaryLines,
}: {
  /**
   * What the customer hands over, and the tax split when this device can state
   * one. The SAME object the cart footer rendered — the amount due is never
   * recomputed here.
   */
  readonly pricing: CartPricing;
  /** The tenant's active tender methods, in the tenant's order. */
  readonly methods: readonly TenderMethod[];
  /** Customers who buy on account — offered only for an on-account line. */
  readonly customers: readonly CreditCustomer[];
  /** Whether this session may put a sale on account at all. A courtesy, not a control. */
  readonly canSellOnAccount: boolean;
  /**
   * The most this session may put on account here, or null for no ceiling.
   * The server measures the same bound against ITS figure regardless; this
   * only stops a clerk queuing a sale the server will refuse.
   */
  readonly onAccountCeilingMinor?: bigint | null;
  readonly onComplete: (submission: TenderSubmission) => void;
  readonly onBack: () => void;
  /**
   * The sale's lines, for a read-only summary beside the payment on a wide
   * screen — what the customer is paying for, in view while the cash is
   * counted. Omitted on a narrow screen, where the payment needs the room.
   */
  readonly summaryLines?: readonly CartLineRow[];
}): ReactNode {
  const spec = useCurrencySpec();
  const totalMinor = pricing.grossMinor;
  const taxNoted =
    pricing.isTaxInclusive && pricing.breakdown !== null && pricing.breakdown.taxTotalMinor !== 0n
      ? pricing.breakdown.taxTotalMinor
      : null;

  const offered = useMemo(
    () => methods.filter((m) => canSellOnAccount || !m.isOnAccount),
    [methods, canSellOnAccount],
  );
  const firstMethod = offered.find((m) => m.isCash) ?? offered[0];
  const [lines, setLines] = useState<LineState[]>(() =>
    firstMethod === undefined ? [] : [newLine(firstMethod.id)],
  );
  const [customerId, setCustomerId] = useState<string>('');
  const byId = useMemo(() => new Map(offered.map((m) => [m.id, m])), [offered]);

  const update = (key: number, patch: Partial<LineState>): void =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  // The drafts `settleTenders` judges — the same function checkout runs.
  const drafts: TenderDraft[] = [];
  let incomplete = false;
  lines.forEach((l, i) => {
    const method = byId.get(l.methodId);
    if (method === undefined) {
      incomplete = true;
      return;
    }
    const last = i === lines.length - 1;
    const amount = last ? null : parseMoneyOrNull(l.amountText, spec);
    if (!last && amount === null) incomplete = true;
    const received = method.isCash ? parseMoneyOrNull(l.receivedText, spec) : null;
    // Cash is counted INTO the hand before the drawer opens: a cash line is
    // not complete until somebody has said what was handed over ("Exact" is
    // one tap). This is the behaviour the single-tender screen always had.
    if (method.isCash && received === null) incomplete = true;
    drafts.push({
      method,
      amountMinor: amount,
      ...(l.reference.trim().length > 0 ? { reference: l.reference } : {}),
      ...(received === null ? {} : { tenderedMinor: received }),
    });
  });
  const statedMinor = drafts.reduce((a, d) => a + (d.amountMinor ?? 0n), 0n);
  const restMinor = sub(totalMinor, statedMinor);
  const needsCustomer = drafts.some((d) => d.method.isOnAccount);

  let settled: ReturnType<typeof settleTenders> | null = null;
  let problem: string | null = null;
  if (!incomplete) {
    try {
      settled = settleTenders(drafts, totalMinor);
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
  }
  if (settled !== null && onAccountCeilingMinor !== null) {
    const onAccount = settled.lines
      .filter((l) => l.method.isOnAccount)
      .reduce((a, l) => a + l.appliedMinor, 0n);
    if (onAccount > onAccountCeilingMinor) {
      problem = `That is more than you may put on account here (${format(onAccountCeilingMinor, spec)}). Ask a manager, or take part of it another way.`;
      settled = null;
    }
  }
  const ready = settled !== null && (!needsCustomer || customerId.length > 0);

  if (offered.length === 0) {
    return (
      <section className="tender-panel" aria-label="Payment">
        <p className="sale-refused" role="alert">
          <Icon name="alert" size={22} />
          <span>This device has no payment methods yet — waiting for setup data to arrive.</span>
        </p>
        <button type="button" className="secondary-action pressable" onClick={onBack}>
          <Icon name="back" size={20} />
          Back to cart
        </button>
      </section>
    );
  }

  const hint =
    problem !== null
      ? problem
      : needsCustomer && customerId.length === 0
        ? 'Choose the customer this goes on account to.'
        : incomplete
          ? lines.length === 1
            ? 'Tap an amount, or type what the customer handed over.'
            : 'Enter an amount for each payment except the last, which takes the rest.'
          : 'Ready when the payments cover the amount due.';

  return (
    <section className={`tender-panel pay-panel${summaryLines === undefined ? '' : ' with-summary'}`} aria-label="Payment">
      <header className="tender-head">
        <button type="button" className="tender-back pressable" onClick={onBack}>
          <Icon name="back" size={20} />
          Back to cart
        </button>
        <h2 className="tender-title">Payment</h2>
      </header>

      <div className="tender-body">
        <div className="tender-summary">
          <div className="tender-due">
            <span className="total-label">Amount due</span>
            <Money amount={totalMinor} className="money total-value tender-total" />
            {/* On an inclusive list the shelf price IS the amount due; saying so
                here is what lets a cashier answer "is tax on top of that?". */}
            {taxNoted !== null ? (
              <p className="total-note">
                Includes tax <Money amount={taxNoted} className="money tender-tax" />
              </p>
            ) : null}
          </div>
          {summaryLines === undefined || summaryLines.length === 0 ? null : (
            <ul className="tender-order" aria-label="In this sale">
              {summaryLines.map((line) => (
                <li key={line.id} className="tender-order-line">
                  <span className="tender-order-qty tabular">
                    {formatQtyScaled(line.qtyScaled, line.qtyScale)} {line.uomLabel}
                  </span>
                  <span className="tender-order-name">{line.name}</span>
                  <Money amount={lineTotalMinor(line)} className="money tender-order-amount" />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="tender-pay">
          {lines.map((l, i) => {
            const method = byId.get(l.methodId);
            const last = i === lines.length - 1;
            const appliedMinor = last ? restMinor : (parseMoneyOrNull(l.amountText, spec) ?? 0n);
            const received = method?.isCash === true ? parseMoneyOrNull(l.receivedText, spec) : null;
            const change =
              received !== null && compare(received, appliedMinor) >= 0 ? sub(received, appliedMinor) : null;
            const quick = method?.isCash === true ? suggestedTenders(appliedMinor, spec.scale) : [];
            const labelId = `tender-line-${l.key}`;
            return (
              <fieldset key={l.key} className="tender-line" aria-labelledby={labelId}>
                <legend id={labelId} className="tender-label">
                  {lines.length === 1 ? 'Paying by' : `Payment ${String(i + 1)}`}
                </legend>
                <div className="tender-methods" role="group" aria-label="Payment method">
                  {offered.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className="method-tile pressable"
                      aria-pressed={m.id === l.methodId}
                      onClick={() => update(l.key, { methodId: m.id })}
                    >
                      <Icon name={methodIcon(m)} size={24} />
                      <span>{m.name}</span>
                    </button>
                  ))}
                </div>

                {last ? (
                  <p className="tender-rest">
                    <span>{lines.length === 1 ? 'Amount' : 'Takes the rest'}</span>
                    <Money amount={restMinor < 0n ? 0n : restMinor} className="money" />
                  </p>
                ) : (
                  <label className="tender-field">
                    <span>Amount</span>
                    <input
                      className="tender-input money"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder={format(0n, spec)}
                      value={l.amountText}
                      onChange={(e) => update(l.key, { amountText: e.target.value })}
                    />
                  </label>
                )}

                {method?.requiresReference === true ? (
                  <label className="tender-field">
                    <span>Reference (transaction id or cheque number)</span>
                    <input
                      className="tender-reference"
                      type="text"
                      autoComplete="off"
                      autoCapitalize="characters"
                      maxLength={64}
                      value={l.reference}
                      onChange={(e) => update(l.key, { reference: e.target.value })}
                    />
                  </label>
                ) : null}

                {method?.isCash === true ? (
                  <>
                    <label className="tender-field">
                      <span>Cash received</span>
                      <input
                        className="tender-input money"
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder={format(0n, spec)}
                        value={l.receivedText}
                        onChange={(e) => update(l.key, { receivedText: e.target.value })}
                      />
                    </label>
                    <div className="tender-quick" role="group" aria-label="Quick amounts">
                      <button
                        type="button"
                        className="quick-tile quick-exact pressable"
                        aria-pressed={received !== null && received === (appliedMinor < 0n ? 0n : appliedMinor)}
                        onClick={() => update(l.key, { receivedText: format(appliedMinor < 0n ? 0n : appliedMinor, spec) })}
                      >
                        Exact
                      </button>
                      {quick.map((amount) => (
                        <button
                          key={amount.toString()}
                          type="button"
                          aria-pressed={received !== null && received === amount}
                          className="quick-tile pressable money"
                          onClick={() => update(l.key, { receivedText: format(amount, spec) })}
                        >
                          {format(amount, spec)}
                        </button>
                      ))}
                    </div>
                    <div className={`tender-change${change !== null ? ' ready' : ''}`}>
                      <span className="total-label">Change</span>
                      {change !== null ? (
                        <Money amount={change} className="money total-value tender-change-value" />
                      ) : (
                        <span className="total-value tender-change-placeholder" aria-label="No change yet">
                          —
                        </span>
                      )}
                    </div>
                  </>
                ) : null}

                {method?.isOnAccount === true ? (
                  <label className="tender-field">
                    <span>Customer</span>
                    <select
                      className="tender-customer"
                      value={customerId}
                      onChange={(e) => setCustomerId(e.target.value)}
                    >
                      <option value="">Choose the customer…</option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {lines.length > 1 ? (
                  <button
                    type="button"
                    className="secondary-action pressable tender-remove"
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  >
                    <Icon name="trash" size={18} />
                    Remove this payment
                  </button>
                ) : null}
              </fieldset>
            );
          })}

          {firstMethod !== undefined ? (
            <button
              type="button"
              className="secondary-action tender-split pressable"
              onClick={() => setLines((ls) => [...ls, newLine(firstMethod.id)])}
            >
              <Icon name="plus" size={20} />
              Split the payment
            </button>
          ) : null}
        </div>
      </div>

      {/* The one action, always in view however long a split grows, with the
          reason it is not ready yet sitting right above it — helper text that
          persists, rather than a placeholder that vanishes (§ input-helper-text). */}
      <div className="tender-actions">
        <p className={`tender-hint${ready ? ' ready' : ''}`} role="status">
          {hint}
        </p>
        <button
          type="button"
          className="primary-action complete-action pressable"
          disabled={!ready}
          onClick={() => {
            if (!ready) return;
            onComplete({ tenders: drafts, ...(needsCustomer ? { customerId } : {}) });
          }}
        >
          <Icon name="check" size={22} />
          Complete sale
        </button>
      </div>
    </section>
  );
}
