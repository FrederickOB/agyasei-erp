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
  feeGraceDays: number;
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
}

/** In-memory store: every tenant starts on the UNCONFIRMED provisional
 *  defaults, so the gate is closed by default — never open by accident. */
export function createMemoryPolicyStore(): CreditPolicyStore {
  const byTenant = new Map<string, CreditPolicy>();
  return {
    async get(tenantId) {
      return byTenant.get(tenantId) ?? PROVISIONAL_TEMPLATE_POLICY;
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
