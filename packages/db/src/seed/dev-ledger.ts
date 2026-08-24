/**
 * A DRAFT CHART OF ACCOUNTS — dev fixture and review artifact, NOT template
 * content.
 *
 * ── WHY THIS FILE IS ALLOWED TO EXIST, STATED BEFORE WHAT IT DOES ─────────
 * The Phase 2 gate's commit-point (docs/phase2-gate.md §4.3) blocks
 * accounting CONTENT — specifically naming "a chart-of-accounts module in
 * packages/db/src/seed/template.ts" — until a qualified accountant is
 * recorded per 05 §5.12. This file honours both the letter and the spirit:
 *
 *   * It is NEVER called by `applyTemplate`. No tenant provisioned through
 *     the product acquires an account from it. The template still ships a
 *     ledger the way it ships a price list: structure, no content.
 *   * It follows the `dev-prices.ts` precedent exactly — the bootstrap seeds
 *     it into the DEV tenants so the machinery can be exercised, the way dev
 *     prices let a counter ring sales from a template that deliberately
 *     ships none.
 *   * Every account carries `template_ref = 'draft:dev-ledger@1'` and the
 *     whole set is documented in docs/draft-chart-of-accounts.md as a
 *     PROPOSAL — the thing the §2.8 reviewer tears apart, so their review
 *     happens against a running system instead of a blank page. A reviewed
 *     chart reaching the template is Track B, with their name on the commit.
 *
 * ── WHAT IS DELIBERATELY WRONG WITH IT, SAID OUT LOUD ─────────────────────
 * Three decisions in here are PLACEHOLDERS awaiting humans, and the draft
 * document flags each: the facility-fee account and its tax treatment
 * (Q4/Q18, G-3); every COGS posting is absent until a costing method exists
 * (Q16 — the sweep posts cost 0 and says so); and no opening balances are
 * seeded (Q20, shaped by Q21). A reviewer finding these is the review
 * working, not failing.
 */
import { uuidv7 } from '../ids.js';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface DraftAccount {
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
  control?: 'AR' | 'AP' | 'INVENTORY' | 'BANK' | 'MOMO' | 'TILL';
  /** Posting roles this account answers for, tenant-scoped. */
  roles?: readonly string[];
}

/**
 * The draft. Codes follow the 05 §5.4.4 illustrative extract's numbering
 * (1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx income, 5xxx cost of
 * sales, 6xxx expenses) so the reviewer meets a familiar shape.
 */
const DRAFT: readonly DraftAccount[] = [
  // Assets
  { code: '1000', name: 'Till cash', type: 'ASSET', control: 'TILL', roles: ['TILL_CASH'] },
  { code: '1010', name: 'Mobile money float', type: 'ASSET', control: 'MOMO', roles: ['MOMO_WALLET'] },
  { code: '1200', name: 'Bank', type: 'ASSET', control: 'BANK', roles: ['BANK'] },
  { code: '1250', name: 'Cash in transit', type: 'ASSET', roles: ['CASH_IN_TRANSIT'] },
  { code: '1300', name: 'Inventory', type: 'ASSET', control: 'INVENTORY', roles: ['INVENTORY'] },
  { code: '1350', name: 'Inventory in transit', type: 'ASSET', roles: ['INVENTORY_IN_TRANSIT'] },
  { code: '1400', name: 'Trade receivables', type: 'ASSET', control: 'AR', roles: ['AR_TRADE'] },
  // Q4/Q18 PLACEHOLDER: the fee's account and tax treatment are the
  // accountant's decisions (G-3). The mapping exists so the mechanism is
  // reviewable; the fee cannot post regardless until the policy is confirmed.
  { code: '1450', name: 'Facility fee receivable — DRAFT, Q4', type: 'ASSET', control: 'AR', roles: ['FACILITY_FEE_AR'] },
  { code: '1500', name: 'Input tax recoverable', type: 'ASSET', roles: ['INPUT_TAX'] },
  { code: '1600', name: 'Fixed assets — accumulated depreciation (contra)', type: 'ASSET', roles: ['ACCUM_DEPRECIATION'] },
  { code: '1900', name: 'Inter-location clearing', type: 'ASSET', roles: ['INTERLOC_CLEARING'] },
  // Liabilities
  { code: '2100', name: 'Trade payables', type: 'LIABILITY', control: 'AP', roles: ['AP_TRADE'] },
  { code: '2150', name: 'Goods received not invoiced', type: 'LIABILITY', roles: ['GRNI'] },
  { code: '2200', name: 'Output tax payable', type: 'LIABILITY', roles: ['OUTPUT_TAX'] },
  { code: '2310', name: 'Employee tax payable', type: 'LIABILITY', roles: ['EMPLOYEE_TAX_PAYABLE'] },
  { code: '2320', name: 'Employee social security payable', type: 'LIABILITY', roles: ['EMPLOYEE_SOCIAL_PAYABLE'] },
  { code: '2330', name: 'Employer social security payable', type: 'LIABILITY', roles: ['EMPLOYER_SOCIAL_PAYABLE'] },
  { code: '2340', name: 'Other payroll deductions payable', type: 'LIABILITY', roles: ['OTHER_DEDUCTIONS_PAYABLE'] },
  { code: '2350', name: 'Net pay payable', type: 'LIABILITY', roles: ['NET_PAY_PAYABLE'] },
  { code: '2400', name: 'Corporate tax payable', type: 'LIABILITY', roles: ['TAX_PAYABLE'] },
  { code: '2500', name: 'Loan payable', type: 'LIABILITY', roles: ['LOAN_PAYABLE'] },
  // Equity
  { code: '3900', name: 'Retained earnings', type: 'EQUITY', roles: ['RETAINED_EARNINGS'] },
  // Income
  { code: '4100', name: 'Sales revenue', type: 'INCOME', roles: ['SALES_REVENUE'] },
  { code: '4190', name: 'Sales discounts (contra)', type: 'INCOME', roles: ['SALES_DISCOUNT'] },
  { code: '4195', name: 'Sales returns (contra)', type: 'INCOME', roles: ['SALES_RETURNS'] },
  { code: '4200', name: 'Facility fee income — DRAFT, Q4/Q18', type: 'INCOME', roles: ['FACILITY_FEE_INCOME'] },
  // Cost of sales
  { code: '5000', name: 'Cost of goods sold', type: 'EXPENSE', roles: ['COGS'] },
  { code: '5100', name: 'Purchase price variance', type: 'EXPENSE', roles: ['PPV'] },
  { code: '5200', name: 'Stock adjustments', type: 'EXPENSE', roles: ['STOCK_ADJ'] },
  // Expenses
  { code: '6100', name: 'Bank and provider charges', type: 'EXPENSE', roles: ['BANK_CHARGES'] },
  { code: '6110', name: 'Cash over/short', type: 'EXPENSE', roles: ['CASH_OVER_SHORT'] },
  { code: '6200', name: 'Distribution cost — third-party haulage', type: 'EXPENSE', roles: ['DISTRIBUTION_COST'] },
  { code: '6300', name: 'Staff costs — gross pay', type: 'EXPENSE', roles: ['STAFF_COST_GROSS'] },
  { code: '6310', name: 'Staff costs — commission', type: 'EXPENSE', roles: ['STAFF_COST_COMMISSION'] },
  { code: '6320', name: 'Staff costs — employer social security', type: 'EXPENSE', roles: ['STAFF_COST_EMPLOYER_SOCIAL'] },
  { code: '6400', name: 'Depreciation', type: 'EXPENSE', roles: ['DEPRECIATION'] },
  { code: '6500', name: 'Interest expense', type: 'EXPENSE', roles: ['INTEREST_EXPENSE'] },
  { code: '6900', name: 'Corporate tax expense', type: 'EXPENSE', roles: ['TAX_EXPENSE'] },
];

export interface DevLedgerResult {
  accounts: number;
  mappings: number;
  periods: number;
  /** Roles the catalogue requires (for the given features) with no mapping. */
  unmappedRequired: string[];
}

/**
 * Seed the draft into ONE tenant. Idempotent by account code. The fiscal
 * year is tenant #1's (1 Aug – 31 Jul, CLAUDE.md §6.1) — a dev fixture
 * value, not a platform assumption.
 */
export async function seedDevLedger(tx: Queryable, tenantId: string): Promise<DevLedgerResult> {
  const existing = await tx.query<{ n: string }>(
    `select count(*)::text n from app.gl_account where tenant_id = $1`, [tenantId]);
  if (Number(existing.rows[0]!.n) > 0) {
    const m = await tx.query<{ n: string }>(
      `select count(*)::text n from app.gl_account_mapping where tenant_id = $1`, [tenantId]);
    return { accounts: Number(existing.rows[0]!.n), mappings: Number(m.rows[0]!.n), periods: 0, unmappedRequired: [] };
  }

  let mappings = 0;
  for (const a of DRAFT) {
    const id = uuidv7();
    await tx.query(
      `insert into app.gl_account (tenant_id, id, code, name, account_type, normal_balance,
                                   is_postable, control_account_kind, report_line_key, template_ref)
       values ($1,$2,$3,$4,$5,$6,true,$7,$8,'draft:dev-ledger@1')`,
      [tenantId, id, a.code, a.name, a.type,
       a.type === 'ASSET' || a.type === 'EXPENSE' ? 'D' : 'C',
       a.control ?? null, `line:${a.code}`],
    );
    for (const role of a.roles ?? []) {
      await tx.query(
        `insert into app.gl_account_mapping
           (tenant_id, id, posting_role, scope_kind, account_id, mapping_set_version, effective_from)
         values ($1,$2,$3,'tenant',$4,1,'2026-08-01')`,
        [tenantId, uuidv7(), role, id],
      );
      mappings += 1;
    }
  }

  // FY27: 1 Aug 2026 – 31 Jul 2027, twelve monthly periods.
  await tx.query(
    `insert into app.fiscal_year (tenant_id, fy_code, starts_on, ends_on)
     values ($1,'FY27','2026-08-01','2027-07-31') on conflict do nothing`, [tenantId]);
  await tx.query(
    `insert into app.gl_counter (tenant_id, fy_code) values ($1,'FY27') on conflict do nothing`,
    [tenantId]);
  let periods = 0;
  for (let m = 0; m < 12; m += 1) {
    const start = new Date(Date.UTC(2026, 7 + m, 1));
    const end = new Date(Date.UTC(2026, 8 + m, 0));
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    await tx.query(
      `insert into app.accounting_period (tenant_id, id, fy_code, seq, starts_on, ends_on)
       values ($1,$2,'FY27',$3,$4,$5)`,
      [tenantId, uuidv7(), m + 1, iso(start), iso(end)],
    );
    periods += 1;
  }

  // Self-check against the catalogue: the draft must satisfy the onboarding
  // completeness gate for every feature the dev stack exercises, or the
  // sweep will open exceptions the seed itself caused.
  const gaps = await tx.query<{ posting_role: string }>(
    `select c.posting_role from platform.posting_role_catalog c
      where (c.required_when_feature is null
             or c.required_when_feature = any($2::text[]))
        and not exists (
          select 1 from app.gl_account_mapping gm
           where gm.tenant_id = $1 and gm.posting_role = c.posting_role)
      order by c.posting_role`,
    [tenantId, ['CREDIT_SALES', 'FACILITY_FEE', 'PAYROLL', 'MOBILE_MONEY', 'FIXED_ASSETS', 'BORROWING']],
  );

  return {
    accounts: DRAFT.length,
    mappings,
    periods,
    unmappedRequired: gaps.rows.map((g) => g.posting_role),
  };
}
