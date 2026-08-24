/**
 * Per-tenant credit policy — the Q4 gate seam (06-customer-credit §6.4.5;
 * docs/open-questions.md Q4).
 *
 * The five fee decisions (basis, compounding, day-count, cadence, GL
 * account) are NEEDS-HUMAN: they carry provisional template defaults so the
 * mechanism is testable, and THE ACCRUAL REFUSES TO POST while no human
 * with the Accounts role has confirmed them. It fails loudly; it does not
 * skip quietly. Shadow computation (preview) is allowed and every figure it
 * produces is labelled "provisional — not chargeable".
 *
 * NOTE for the integrator: the architecture's app.credit_policy table
 * (effective-dated, one active row per tenant — §6.1) is not yet in
 * @erp/db's migrations. This store is the seam standing in for that row:
 * same fields, same gate, same defaults. When the migration lands, the
 * store's backing moves to the table and nothing above this interface
 * changes. Until then the DEFAULT STATE IS UNCONFIRMED — fail closed.
 */

export type FeeBasis = 'overdue_balance' | 'outstanding_balance' | 'drawn_amount';
export type FeeDayCount = 'thirty_e_360' | 'actual_365' | 'whole_calendar_month';

export interface CreditPolicy {
  /** D-1 — what the fee accrues on. Provisional default: overdue only. */
  feeBasis: FeeBasis;
  /** D-2 — simple vs compounding; provisional default: simple. */
  feeCompounds: boolean;
  /** D-2 — do unpaid accruals themselves enter the basis? Default: no. */
  feeOnFee: boolean;
  /** D-3 — day count; provisional default: 30E/360 pro-rata. */
  feeDayCount: FeeDayCount;
  /** Days past due before accrual starts — a day COUNT, not a money amount. */
  feeGraceDays: number; // lint-money-ignore — calendar-day count, not minor units
  /** Ageing bucket upper bounds in days past due. Template: [30, 60, 90]. */
  ageingBucketDays: readonly number[];
  /** The §6.4.5 gate. null = UNCONFIRMED = the accrual refuses to post. */
  confirmedBy: string | null;
  confirmedAt: string | null;
  confirmationNote: string | null;
}

export const PROVISIONAL_TEMPLATE_POLICY: CreditPolicy = {
  feeBasis: 'overdue_balance',
  feeCompounds: false,
  feeOnFee: false,
  feeDayCount: 'thirty_e_360',
  feeGraceDays: 0,
  ageingBucketDays: [30, 60, 90],
  confirmedBy: null,
  confirmedAt: null,
  confirmationNote: null,
};

export interface CreditPolicyStore {
  get(tenantId: string): Promise<CreditPolicy>;
  /** Records the Accounts confirmation (identity + note). Test/ops path. */
  confirm(tenantId: string, by: string, note: string): Promise<void>;
  /**
   * Set the five decisions themselves — what the accountant actually answered.
   * Separate from `confirm` because they are separate acts: recording an
   * answer, and attesting to it. Test/ops path until the effective-dated
   * `app.credit_policy` table lands.
   */
  set(tenantId: string, policy: Partial<CreditPolicy>): Promise<void>;
}

/** In-memory store: every tenant starts on the UNCONFIRMED provisional
 *  defaults, so the gate is closed by default — never open by accident. */
export function createMemoryPolicyStore(): CreditPolicyStore {
  const byTenant = new Map<string, CreditPolicy>();
  return {
    async get(tenantId) {
      return byTenant.get(tenantId) ?? PROVISIONAL_TEMPLATE_POLICY;
    },
    async set(tenantId, patch) {
      const cur = byTenant.get(tenantId) ?? PROVISIONAL_TEMPLATE_POLICY;
      byTenant.set(tenantId, { ...cur, ...patch });
    },
    async confirm(tenantId, by, note) {
      const cur = byTenant.get(tenantId) ?? PROVISIONAL_TEMPLATE_POLICY;
      byTenant.set(tenantId, {
        ...cur,
        confirmedBy: by,
        confirmedAt: new Date().toISOString(),
        confirmationNote: note,
      });
    },
  };
}

/**
 * 30E/360 day count, day-of-month clamped to 30 (§6.4.3):
 *   days30(d1, d2) = 360·(y2−y1) + 30·(m2−m1) + (min(day2,30) − min(day1,30))
 * The DUE DATE uses calendar days (a promise made in real days); the FEE
 * uses 30E/360 so "2%/month" costs the same in February as in March. The
 * two conventions do different jobs and must never be unified.
 */
export function days30(d1: string, d2: string): number {
  const [y1, m1, day1] = d1.split('-').map(Number) as [number, number, number];
  const [y2, m2, day2] = d2.split('-').map(Number) as [number, number, number];
  return 360 * (y2 - y1) + 30 * (m2 - m1) + (Math.min(day2, 30) - Math.min(day1, 30));
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * G-5: A POLICY VALUE IS HONOURED OR REFUSED. IT IS NEVER IGNORED.
 * ─────────────────────────────────────────────────────────────────────────
 * The Phase 2 gate found that `feeBasis`, `feeCompounds`, `feeOnFee` and
 * `feeDayCount` were declared, defaulted, carried through the confirmation
 * flow — and read by nothing. The accrual computed 30E/360 on the overdue
 * balance unconditionally. So an accountant answering Q4 with `actual_365`
 * would have had their answer stored and silently disregarded.
 *
 * That is worse than not asking. Not asking is a visible gap; asking,
 * recording, and ignoring produces a system that can show you a signed
 * confirmation of a rule it does not follow.
 *
 * The fix is not "implement all twelve combinations speculatively". It is
 * this rule, applied without exception:
 *
 *   **Every policy value either changes the computation or refuses the
 *   computation. None may leave the result unchanged.**
 *
 * `feeMechanics()` below returns the mechanics for a policy, or throws
 * `UnsupportedPolicyError` naming the decision that cannot be honoured. The
 * switches are TOTAL over their unions with no `default`, so adding a
 * `FeeDayCount` without deciding its arithmetic is a COMPILE error — the same
 * shape `SALE_PERMISSION` uses on the sale path, for the same reason.
 */
export class UnsupportedPolicyError extends Error {
  readonly code = 'FEE_POLICY_UNSUPPORTED';
  constructor(
    readonly decision: string,
    readonly value: string,
    detail: string,
  ) {
    super(`FEE_POLICY_UNSUPPORTED: ${decision} = "${value}" — ${detail}`);
    this.name = 'UnsupportedPolicyError';
  }
}

/** Whole calendar months between two ISO dates, floored. */
export function wholeMonths(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = to.split('-').map(Number) as [number, number, number];
  const months = 12 * (y2 - y1) + (m2 - m1);
  return Math.max(0, d2 >= d1 ? months : months - 1);
}

/** Actual calendar days between two ISO dates. */
export function actualDays(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

/**
 * How a policy turns elapsed time into a fraction of a month, as an exact
 * rational, so the caller can divide LAST and never accumulate float error.
 *
 * A rate is basis points PER MONTH, so every day count answers the same
 * question — how many months have elapsed — and answers it differently:
 *
 *   thirty_e_360        30E/360, so 2%/month costs the same in February as
 *                       in March. numerator = days30, denominator = 30.
 *   actual_365          actual days on a 365-day year. numerator =
 *                       days × 12, denominator = 365.
 *   whole_calendar_month  no pro-rata at all: a fee is charged for a whole
 *                       month or not at all. numerator = months, den = 1.
 */
export interface ElapsedMonths {
  readonly numerator: bigint;
  readonly denominator: bigint;
  /** For the response, so a reader can see what was counted. */
  readonly elapsedLabel: string;
}

export interface FeeMechanics {
  /** Does an accrued, unpaid fee join the basis of the next accrual? */
  readonly feeJoinsBasis: boolean;
  /** From which date does time run — the due date, or the invoice date? */
  readonly runsFrom: 'due_date' | 'document_date';
  elapsed(from: string, asOf: string): ElapsedMonths;
}

export function feeMechanics(policy: CreditPolicy): FeeMechanics {
  // D-2, compounding. Refused rather than approximated: true compounding
  // needs a COMPOUNDING PERIOD, and the five Q4 decisions do not name one.
  // Picking monthly by analogy would be inventing an answer to a question
  // nobody asked the accountant.
  if (policy.feeCompounds) {
    throw new UnsupportedPolicyError(
      'D-2 feeCompounds',
      'true',
      'compounding needs a compounding period, which the Q4 decisions do not state. ' +
        'Ask the accountant for it before enabling this, rather than assuming monthly.',
    );
  }

  let runsFrom: FeeMechanics['runsFrom'];
  switch (policy.feeBasis) {
    case 'overdue_balance':
      runsFrom = 'due_date';
      break;
    case 'outstanding_balance':
      // Accrues from the invoice date: the customer pays for the whole
      // period they held the money, not only the overdue part.
      runsFrom = 'document_date';
      break;
    case 'drawn_amount':
      throw new UnsupportedPolicyError(
        'D-1 feeBasis',
        'drawn_amount',
        'a drawn amount needs a facility with a limit drawn against it, which this ' +
          'credit model does not have — an account has invoices, not drawings.',
      );
  }

  let elapsed: FeeMechanics['elapsed'];
  switch (policy.feeDayCount) {
    case 'thirty_e_360':
      elapsed = (from, asOf) => ({
        numerator: BigInt(Math.max(0, days30(from, asOf))),
        denominator: 30n,
        elapsedLabel: `${Math.max(0, days30(from, asOf))} days (30E/360)`,
      });
      break;
    case 'actual_365':
      elapsed = (from, asOf) => ({
        numerator: BigInt(actualDays(from, asOf)) * 12n,
        denominator: 365n,
        elapsedLabel: `${actualDays(from, asOf)} days (actual/365)`,
      });
      break;
    case 'whole_calendar_month':
      elapsed = (from, asOf) => ({
        numerator: BigInt(wholeMonths(from, asOf)),
        denominator: 1n,
        elapsedLabel: `${wholeMonths(from, asOf)} whole month(s)`,
      });
      break;
  }

  return { feeJoinsBasis: policy.feeOnFee, runsFrom, elapsed };
}
