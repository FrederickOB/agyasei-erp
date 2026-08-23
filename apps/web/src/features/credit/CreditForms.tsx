/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE THINGS A PERSON CAN DO TO A CUSTOMER'S CREDIT ACCOUNT
 * ═══════════════════════════════════════════════════════════════════════════
 * Open one · change what it is worth · take a payment against it.
 *
 * Until these forms existed the platform could put a customer INTO debt from a
 * screen — a credit sale writes a CHARGE server-side — and could not open the
 * account it sold against, could not correct a limit once typed, and could not
 * record a single cedi coming back. `credit.openAccount` and
 * `credit.recordEntry` were guarded, tested, contracted and clientless
 * (phase1-status §6 item 10).
 *
 * ---------------------------------------------------------------------------
 * TWO OF THESE ARE REFUSED OFFLINE AND ONE IS QUEUED. THE SPLIT IS THE DESIGN.
 * ---------------------------------------------------------------------------
 * Opening an account and changing a limit both SET A CREDIT LIMIT, which is a
 * risk judgement (06 §6.6). A partitioned device cannot see the version it
 * would be superseding, so it cannot state one, and a write with no claim is
 * last-write-wins — CLAUDE.md §2.2's canonical hard case, manufactured. Both
 * go over tRPC, both are refused out loud, and neither queues anything.
 *
 * A repayment is trade. The money is in the drawer whether or not the tower is
 * up. It rides the outbox, exactly as a sale does, and the receipt below says
 * "recorded here, not yet sent" — and never, ever a resulting balance, because
 * the device does not hold the ledger that balance comes from.
 *
 * ---------------------------------------------------------------------------
 * HIDING A CONTROL IS A COURTESY, NOT A BOUNDARY
 * ---------------------------------------------------------------------------
 * Every capability read here decides which CONTROL a person is offered. The
 * server re-authorises at ingest, tenant-wide, and refuses regardless. Nothing
 * in this file reads a role name (CLAUDE.md §2.6, §2.9).
 *
 * Money is typed at the tenant's own precision, parsed once by `@erp/money`
 * against the tenant's `CurrencySpec`, and is a `bigint` from the moment it
 * stops being text (ADR-0004). No arithmetic is done on a displayed value.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { MoneyError, parse } from '@erp/money';
import type { ApiCallOptions } from '../../data/api/client';
import {
  openCreditAccount,
  setCreditLimit,
  type CreditExposure,
} from '../../data/api/credit';
import type { LocalDb } from '../../data/db';
import type { ClaimedHlcClock } from '../../lib/hlc';
import {
  DuplicateRepaymentError,
  RepaymentAmountError,
  RepaymentContextIncompleteError,
  RepaymentPayloadInvalidError,
  recordRepayment,
} from '../../data/mutations/recordRepayment';
import type { AgedInvoice } from '../../data/api/credit';
import { uuidv7 } from '../../lib/uuidv7';
import { useCurrencySpec } from '../../money/CurrencyContext';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';

/**
 * ONE ATTEMPT'S IDENTITY — the key AND the wall clock, minted together.
 *
 * The server hashes the canonical form of the WHOLE input alongside the
 * idempotency key (`apps/api/src/canonical.ts`), and `clientWallAt` is part of
 * that input. A retry that keeps the key but stamps a fresh clock is "same
 * key, different payload" — refused `409 IDEMPOTENCY_KEY_REUSE`, the server
 * being right and the client being wrong. So both are minted once, when the
 * form opens, and held until the save actually succeeds.
 */
interface Attempt {
  readonly idempotencyKey: string;
  readonly clientWallAt: string;
}

function newAttempt(): Attempt {
  return { idempotencyKey: uuidv7(), clientWallAt: new Date().toISOString() };
}

/**
 * What a refusal reads as. Offline is calm, specific, and says the two things
 * a person needs: nothing was saved, and nothing is waiting to be.
 */
function refusalText(kind: string, detail: string | null, message: string, what: string): string {
  return kind === 'offline'
    ? `Not saved. ${what} is decided at the office and this device cannot reach it. Nothing was queued and nothing was changed — the account is exactly as it was.`
    : `Not saved. ${detail ?? message}`;
}

function Problem({ text }: { readonly text: string }): ReactNode {
  return (
    <p className="device-gate-error" role="alert">
      <Icon name="alert" size={20} />
      <span>{text}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// 1. Opening an account
// ---------------------------------------------------------------------------

export interface OpenAccountFormProps {
  readonly customerId: string;
  readonly customerName: string;
  readonly apiOptions: ApiCallOptions;
  /** Whether this session may set a NON-ZERO limit (`credit.limit.change`). */
  readonly canSetLimit: boolean;
  readonly onOpened: (accountId: string) => void;
  readonly onCancel: () => void;
}

/**
 * Open a credit account for a customer this device already knows.
 *
 * `credit.limit.change` is asked for separately, and only when the limit is
 * non-zero — exactly as the server asks for it. Opening an account with real
 * headroom IS setting a credit limit, and there must be no path to a limit
 * that does not pass through that capability.
 */
export function OpenAccountForm({
  customerId,
  customerName,
  apiOptions,
  canSetLimit,
  onOpened,
  onCancel,
}: OpenAccountFormProps): ReactNode {
  const spec = useCurrencySpec();
  const [limitText, setLimitText] = useState('0');
  const [termsText, setTermsText] = useState('30');
  const [feeText, setFeeText] = useState('0');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState<Attempt>(newAttempt);

  const submit = useCallback(() => {
    let limitMinor: bigint;
    try {
      limitMinor = parse(limitText.trim(), spec);
    } catch (err) {
      setProblem(
        err instanceof MoneyError
          ? 'That is not an amount. Type it in figures, with a decimal point if you need one.'
          : 'That is not an amount.',
      );
      return;
    }
    if (limitMinor < 0n) {
      setProblem('A credit limit cannot be negative. Use 0 for an account with no headroom.');
      return;
    }
    if (limitMinor !== 0n && !canSetLimit) {
      setProblem(
        'Setting a credit limit is a separate permission from opening the account. Open it at 0 and ask whoever holds that permission to set the limit.',
      );
      return;
    }
    const terms = Number(termsText);
    if (!Number.isInteger(terms) || terms < 0 || terms > 365) {
      setProblem('Terms are a whole number of days, from 0 (on delivery) to 365.');
      return;
    }
    const feeBp = Number(feeText);
    if (!Number.isInteger(feeBp) || feeBp < 0 || feeBp > 10_000) {
      setProblem('The fee rate is a whole number of basis points a month, from 0 to 10000.');
      return;
    }
    setProblem(null);
    setSaving(true);
    void openCreditAccount(
      {
        ...attempt,
        customerId,
        termsDays: terms,
        feeRateBpPerMonth: feeBp,
        // Minor units as a decimal STRING. A JSON number is a float64 in every
        // consumer (ADR-0004).
        creditLimitMinor: limitMinor.toString(),
      },
      apiOptions,
    ).then((result) => {
      setSaving(false);
      if (result.ok) {
        setAttempt(newAttempt());
        onOpened(result.data.accountId);
        return;
      }
      setProblem(
        refusalText(
          result.failure.kind,
          result.failure.detail,
          result.failure.message,
          'A credit account',
        ),
      );
    });
  }, [apiOptions, attempt, canSetLimit, customerId, feeText, limitText, onOpened, spec, termsText]);

  return (
    <form
      className="threshold-form"
      aria-label="Open a credit account"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="threshold-form-product">
        <span className="report-loc-name">{customerName}</span>
      </p>
      <label className="threshold-form-field">
        <span>Credit limit</span>
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={limitText}
          aria-label="Credit limit"
          onChange={(e) => setLimitText(e.currentTarget.value)}
        />
      </label>
      {canSetLimit ? null : (
        <p className="adjust-kind-note">
          You can open this account, but setting a limit above 0 is somebody else&rsquo;s decision.
          Leave it at 0 and the account will exist with no headroom until they set one.
        </p>
      )}
      <label className="threshold-form-field">
        <span>Days to pay (0 is on delivery)</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={365}
          value={termsText}
          aria-label="Terms in days"
          onChange={(e) => setTermsText(e.currentTarget.value)}
        />
      </label>
      <label className="threshold-form-field">
        <span>Fee on overdue invoices, basis points a month</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={10000}
          value={feeText}
          aria-label="Fee rate in basis points a month"
          onChange={(e) => setFeeText(e.currentTarget.value)}
        />
      </label>
      <p className="adjust-kind-note">
        This is kept at the office, not on this device, so it needs a connection. Nothing is
        queued: an account opened twice from two places is one customer with two books.
      </p>
      {problem === null ? null : <Problem text={problem} />}
      <div className="threshold-form-actions">
        <button type="button" className="secondary-action pressable" onClick={onCancel}>
          Not now
        </button>
        <button type="submit" className="primary-action pressable" disabled={saving}>
          {saving ? 'Opening…' : 'Open the account'}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// 2. Changing the limit — the compare-and-set, made visible
// ---------------------------------------------------------------------------

export interface LimitFormProps {
  /** The position this person is deciding against. Its version id IS the CAS. */
  readonly exposure: CreditExposure;
  readonly apiOptions: ApiCallOptions;
  /** The trading day the decision applies from. Never the tablet's calendar. */
  readonly today: string;
  readonly onChanged: () => void;
  readonly onCancel: () => void;
}

/**
 * Change what a customer may owe.
 *
 * ═══ THE CANONICAL HARD CASE, ANSWERED THE WAY §6.6 RULES ═══
 * Two people, both looking at the same account, each decide a different
 * number — one having seen a deposit arrive, one having heard the customer is
 * slow paying. The version this person was looking at goes up with the
 * decision as `supersedesId`. If somebody else decided first, the server
 * refuses with the figure that won and NOTHING is changed.
 *
 * The screen then says so and offers to look again. It does **not** offer to
 * re-send: 06 §6.6.3 deletes both last-write-wins and "lower wins" by name,
 * and a button that re-submitted the same number under a fresh claim would be
 * last-write-wins with an extra tap. The person reads the number that won and
 * decides again with it in front of them.
 */
export function LimitForm({
  exposure,
  apiOptions,
  today,
  onChanged,
  onCancel,
}: LimitFormProps): ReactNode {
  const spec = useCurrencySpec();
  const [limitText, setLimitText] = useState('');
  const [termsText, setTermsText] = useState(String(exposure.termsDays));
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [superseded, setSuperseded] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState<Attempt>(newAttempt);

  const submit = useCallback(() => {
    let limitMinor: bigint;
    try {
      limitMinor = parse(limitText.trim(), spec);
    } catch {
      setProblem('That is not an amount. Type it in figures, with a decimal point if you need one.');
      return;
    }
    if (limitMinor < 0n) {
      setProblem('A credit limit cannot be negative. Use 0 to stop this customer buying on account.');
      return;
    }
    const terms = Number(termsText);
    if (!Number.isInteger(terms) || terms < 0 || terms > 365) {
      setProblem('Terms are a whole number of days, from 0 (on delivery) to 365.');
      return;
    }
    if (reason.trim().length < 3) {
      setProblem('Say why. A limit that changed for no recorded reason cannot be explained later.');
      return;
    }
    setProblem(null);
    setSuperseded(null);
    setSaving(true);
    void setCreditLimit(
      {
        ...attempt,
        accountId: exposure.accountId,
        creditLimitMinor: limitMinor.toString(),
        termsDays: terms,
        effectiveFrom: today,
        reason: reason.trim(),
        // THE COMPARE-AND-SET. Omitted only for an account opened before the
        // decision log existed, which is the one case with nothing to claim.
        ...(exposure.limitVersionId === null
          ? {}
          : { supersedesId: exposure.limitVersionId }),
      },
      apiOptions,
    ).then((outcome) => {
      setSaving(false);
      switch (outcome.kind) {
        case 'changed':
          setAttempt(newAttempt());
          onChanged();
          return;
        case 'superseded':
          setSuperseded(outcome.detail);
          return;
        case 'refused':
          setProblem(
            refusalText(
              outcome.failure.kind,
              outcome.failure.detail,
              outcome.failure.message,
              'A credit limit',
            ),
          );
      }
    });
  }, [apiOptions, attempt, exposure, limitText, onChanged, reason, spec, termsText, today]);

  if (superseded !== null) {
    // NOT AN ERROR, AND NOT RETRYABLE. Somebody else's judgement is now the
    // one in force; the honest next step is to look at it, not to overwrite it.
    return (
      <section className="server-answer server-answer-calm credit-gate" role="status">
        <Icon name="alert" size={28} />
        <div className="server-answer-body">
          <h4 className="server-answer-title">Somebody else decided this limit first.</h4>
          <p className="server-answer-text">
            Nothing you typed has been saved and nothing has been changed. Their figure is the one
            in force now. Look at the account again and decide against what it says — this screen
            will not send your number over the top of theirs.
          </p>
          <p className="server-answer-detail">
            <span className="server-answer-detail-label">If you call someone, tell them:</span>{' '}
            <span className="tabular">{superseded}</span>
          </p>
          <div className="threshold-form-actions">
            <button type="button" className="primary-action pressable" onClick={onChanged}>
              Look at the account again
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <form
      className="threshold-form"
      aria-label="Change the credit limit"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="threshold-form-product">
        <span className="report-loc-name">Limit now</span>
        <span className="report-loc-code tabular">
          <Money amount={exposure.creditLimitMinor} />
        </span>
      </p>
      <label className="threshold-form-field">
        <span>New limit</span>
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={limitText}
          aria-label="New credit limit"
          onChange={(e) => setLimitText(e.currentTarget.value)}
        />
      </label>
      <label className="threshold-form-field">
        <span>Days to pay (0 is on delivery)</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={365}
          value={termsText}
          aria-label="Terms in days"
          onChange={(e) => setTermsText(e.currentTarget.value)}
        />
      </label>
      <label className="threshold-form-field">
        <span>Why</span>
        <input
          type="text"
          autoComplete="off"
          value={reason}
          aria-label="Why the limit is changing"
          onChange={(e) => setReason(e.currentTarget.value)}
        />
      </label>
      <p className="adjust-kind-note">
        Every decision about this limit is kept, with who made it and why — nothing is overwritten.
        It takes effect from <span className="tabular">{today}</span>. Invoices already raised keep
        the terms they were charged under.
      </p>
      <p className="adjust-kind-note">
        This needs a connection and nothing is queued. If somebody else changes it while you are
        deciding, you will be told and nothing of yours will be saved.
      </p>
      {problem === null ? null : <Problem text={problem} />}
      <div className="threshold-form-actions">
        <button type="button" className="secondary-action pressable" onClick={onCancel}>
          Leave it as it is
        </button>
        <button type="submit" className="primary-action pressable" disabled={saving}>
          {saving ? 'Saving…' : 'Change the limit'}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// 3. Taking a payment — the one credit write that is queued
// ---------------------------------------------------------------------------

/** What was QUEUED. Never a balance — see the note beside it in the render. */
export interface QueuedRepayment {
  readonly entryId: string;
  readonly amountMinor: bigint;
  readonly businessDate: string;
  readonly appliesToId: string | null;
}

export interface RepaymentFormProps {
  readonly db: LocalDb;
  readonly accountId: string;
  /** Unpaid invoices from the LAST server answer, for optional allocation. */
  readonly invoices: readonly AgedInvoice[];
  readonly hlc: ClaimedHlcClock;
  readonly onQueued: (queued: QueuedRepayment) => void;
}

/**
 * Record what a customer just handed over.
 *
 * ═══ THIS DOES NOT WAIT ON A SOCKET, AND IT DOES NOT SHOW A BALANCE ═══
 * The write is local, atomic and done in single-digit milliseconds. What comes
 * back is the RECEIPT — how much, on which trading day, and that it is still
 * on this device. The screen must never show what the customer owes afterwards,
 * because this device does not hold the ledger that figure comes from and a
 * client-side subtraction against an unknown base is exactly the confident
 * wrong number the whole credit feature is built to avoid.
 *
 * The person types what was HANDED OVER, positive. The sign convention (a
 * payment reduces what is owed, so it is negative) lives in
 * `data/mutations/recordRepayment.ts` and in the database's `ce_sign` CHECK,
 * and in neither case in a form.
 */
export function RepaymentForm({
  db,
  accountId,
  invoices,
  hlc,
  onQueued,
}: RepaymentFormProps): ReactNode {
  const spec = useCurrencySpec();
  const [amountText, setAmountText] = useState('');
  const [appliesTo, setAppliesTo] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The key IS the entry id and it is minted when the form opens, so a
  // double-tap, a retry and a resumed form are all the same write (§8.2).
  const [entryId, setEntryId] = useState<string>(uuidv7);

  const submit = useCallback(() => {
    let amountMinor: bigint;
    try {
      amountMinor = parse(amountText.trim(), spec);
    } catch {
      setProblem('That is not an amount. Type what the customer handed over, in figures.');
      return;
    }
    setProblem(null);
    setSaving(true);
    void recordRepayment(db, {
      entryId,
      accountId,
      amountReceivedMinor: amountMinor,
      ...(appliesTo === '' ? {} : { appliesToId: appliesTo }),
      hlc,
    })
      .then((result) => {
        setSaving(false);
        setAmountText('');
        setAppliesTo('');
        setEntryId(uuidv7());
        onQueued({
          entryId: result.entryId,
          amountMinor: result.amountMinor,
          businessDate: result.businessDate,
          appliesToId: result.appliesToId,
        });
      })
      .catch((err: unknown) => {
        setSaving(false);
        // Each of these is a refusal the DEVICE made, on purpose, so a payload
        // the server would reject never reaches an ordered queue that a
        // permanent refusal could wedge (see the module header).
        if (
          err instanceof RepaymentAmountError ||
          err instanceof RepaymentContextIncompleteError ||
          err instanceof DuplicateRepaymentError
        ) {
          setProblem(err.message);
          return;
        }
        if (err instanceof RepaymentPayloadInvalidError) {
          setProblem(`This device would not send that: ${err.issues.join('; ')}`);
          return;
        }
        setProblem('Nothing was recorded. Try again.');
      });
  }, [accountId, amountText, appliesTo, db, entryId, hlc, onQueued, spec]);

  return (
    <form
      className="threshold-form"
      aria-label="Record a payment"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="threshold-form-field">
        <span>Amount received</span>
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={amountText}
          aria-label="Amount received"
          onChange={(e) => setAmountText(e.currentTarget.value)}
        />
      </label>
      {invoices.length === 0 ? null : (
        <label className="threshold-form-field">
          <span>Against which invoice (optional)</span>
          <select
            value={appliesTo}
            aria-label="Against which invoice"
            onChange={(e) => setAppliesTo(e.currentTarget.value)}
          >
            <option value="">Leave it on account</option>
            {invoices.map((inv) => (
              <option key={inv.chargeId} value={inv.chargeId}>
                {inv.dueDate ?? '—'} · {String(inv.daysPastDue)} days past due
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="adjust-kind-note">
        Money not put against a particular invoice sits on its own line and is never quietly taken
        off the oldest one. This is saved on this device straight away and sent when there is a
        connection — the new balance comes from the office, so it is not shown here.
      </p>
      {problem === null ? null : <Problem text={problem} />}
      <div className="threshold-form-actions">
        <button type="submit" className="primary-action pressable" disabled={saving}>
          {saving ? 'Recording…' : 'Record the payment'}
        </button>
      </div>
    </form>
  );
}

/**
 * The receipt for a queued payment.
 *
 * It states the amount, the trading day and that it is still on this device.
 * There is no balance here and there must never be one: the device does not
 * hold the ledger, so any figure it produced would be a subtraction against a
 * base it cannot see.
 */
export function QueuedRepaymentReceipt({
  queued,
}: {
  readonly queued: QueuedRepayment;
}): ReactNode {
  return (
    <p className="adjust-saved" role="status">
      <Icon name="check" size={20} />
      <span>
        Recorded on this device: <Money amount={-queued.amountMinor} /> received on{' '}
        <span className="tabular">{queued.businessDate}</span>
        {queued.appliesToId === null ? ', left on account' : ', against one invoice'}. It is saved
        here and will be sent when there is a connection.{' '}
        <strong>
          The balance above was asked for before this and does not include it.
        </strong>{' '}
        What the customer owes now is a question for the office.
      </span>
    </p>
  );
}
