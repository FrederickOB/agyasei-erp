/**
 * THE PAYROLL REGISTER — what we send, and what comes back.
 *
 * CLAUDE.md §2.4: capture -> export -> the bureau computes -> re-import ->
 * net pay is ENTERED, not calculated. This module owns the two ends of that
 * arrow and nothing in between.
 *
 * ── THE EXPORT CARRIES NO DEDUCTION COLUMNS ───────────────────────────────
 * Not even blank ones. 05 §5.8.2 is explicit, and its reasoning is worth
 * keeping: a blank column named after a statutory deduction is an invitation
 * to fill it in from the wrong place. A register with an empty deductions
 * column is one spreadsheet away from becoming a register with a guessed one.
 *
 * (The original sentence quoted the deduction by name, and the boundary lint
 * stopped on it. Rewording was the right answer rather than an exemption: the
 * rule is that the vocabulary does not appear, and a doc comment is not a
 * special case.)
 *
 * ── THE IMPORT VALIDATES AND REJECTS; IT NEVER FILLS IN ───────────────────
 * The line, stated once and applied everywhere below:
 *
 *   **The system may verify an identity. It may never solve for an unknown.**
 *
 * Checking that figures the bureau supplied are internally consistent is
 * arithmetic on data we were given. Supplying a missing figure — from a rate,
 * a bracket, a table, or last month's number — is calculation, and is
 * prohibited. So a file missing one employee's tax figure is REJECTED WHOLE;
 * it is never completed by rearranging the identity to solve for it, even
 * though the arithmetic would be trivial. That triviality is the trap.
 */
import type { Queryable } from '../testing/harness.js';

/** Scale is carried, never assumed: 7.50 hours is 750 at scale 2 (ADR-0004). */
export interface RegisterLine {
  readonly employeeId: string;
  readonly staffRef: string;
  readonly displayName: string;
  readonly locationId: string;
  readonly hoursWorkedScaled: bigint;
  readonly hoursScale: number;
  readonly basePayMinor: bigint;
  readonly overtimeMinor: bigint;
  readonly commissionMinor: bigint;
  readonly allowancesMinor: bigint;
  readonly grossPayMinor: bigint;
}

export interface Register {
  readonly payPeriodId: string;
  readonly code: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly lines: readonly RegisterLine[];
  readonly totalGrossMinor: bigint;
}

/**
 * The register, exactly as it goes to the bureau.
 *
 * Note what this SELECT does not name: no `bureau_*` column appears in it at
 * all. That is not an oversight to be corrected later.
 */
export async function buildRegister(tx: Queryable, payPeriodId: string): Promise<Register> {
  const head = await tx.query<{ id: string; code: string; starts_on: string; ends_on: string }>(
    `select id, code, starts_on::text, ends_on::text from app.pay_period where id = $1`,
    [payPeriodId],
  );
  const period = head.rows[0];
  if (period === undefined) throw new Error(`no pay period ${payPeriodId}`);

  const res = await tx.query<{
    employee_id: string; staff_ref: string; display_name: string; location_id: string;
    hours_worked_scaled: string; hours_scale: number; base_pay_minor: string;
    overtime_minor: string; commission_minor: string; allowances_minor: string;
    gross_pay_minor: string;
  }>(
    `select pe.employee_id, e.staff_ref, e.display_name, pe.location_id,
            pe.hours_worked_scaled::text, pe.hours_scale, pe.base_pay_minor::text,
            pe.overtime_minor::text, pe.commission_minor::text,
            pe.allowances_minor::text, pe.gross_pay_minor::text
       from app.payroll_entry pe
       join app.employee e on e.tenant_id = pe.tenant_id and e.id = pe.employee_id
      where pe.pay_period_id = $1
      order by e.staff_ref`,
    [payPeriodId],
  );

  const lines = res.rows.map((r) => ({
    employeeId: r.employee_id,
    staffRef: r.staff_ref,
    displayName: r.display_name,
    locationId: r.location_id,
    hoursWorkedScaled: BigInt(r.hours_worked_scaled),
    hoursScale: r.hours_scale,
    basePayMinor: BigInt(r.base_pay_minor),
    overtimeMinor: BigInt(r.overtime_minor),
    commissionMinor: BigInt(r.commission_minor),
    allowancesMinor: BigInt(r.allowances_minor),
    grossPayMinor: BigInt(r.gross_pay_minor),
  }));

  return {
    payPeriodId: period.id,
    code: period.code,
    startsOn: period.starts_on,
    endsOn: period.ends_on,
    lines,
    totalGrossMinor: lines.reduce((a, l) => a + l.grossPayMinor, 0n),
  };
}

/** One employee's figures, exactly as the bureau stated them. */
export interface BureauLine {
  readonly employeeId: string;
  readonly employeeTaxMinor: bigint;
  readonly employeeSocialMinor: bigint;
  readonly otherDeductionsMinor: bigint;
  readonly employerSocialMinor: bigint;
  readonly netPayMinor: bigint;
}

export interface BureauFile {
  readonly payPeriodId: string;
  readonly bureauRef: string;
  readonly fileName?: string | undefined;
  readonly fileDigest: string;
  readonly lines: readonly BureauLine[];
  /** The bureau's own control totals. Checked, never derived from the lines. */
  readonly statedTotals: {
    readonly grossMinor: bigint;
    readonly employeeTaxMinor: bigint;
    readonly employeeSocialMinor: bigint;
    readonly otherMinor: bigint;
    readonly employerSocialMinor: bigint;
    readonly netMinor: bigint;
  };
}

export interface ImportRejection {
  readonly code:
    | 'IDENTITY_FAILS' | 'TOTALS_DISAGREE' | 'EMPLOYEE_MISSING'
    | 'EMPLOYEE_DUPLICATED' | 'EMPLOYEE_UNKNOWN' | 'NEGATIVE_FIGURE';
  readonly employeeId?: string;
  readonly detail: string;
}

export type ImportResult =
  | { readonly status: 'imported'; readonly importId: string; readonly lineCount: number }
  | { readonly status: 'rejected'; readonly rejections: readonly ImportRejection[] };

/**
 * Validate a bureau file against the register, and reject it WHOLE if anything
 * fails.
 *
 * Nothing is part-imported and nothing is inferred. Four checks, all of them
 * verifying an identity rather than solving one:
 *
 *   1. per employee: gross − (tax + social + other) === net
 *   2. the bureau's stated totals tie to the sum of its own lines
 *   3. every employee in the period is present, exactly once
 *   4. no employee appears who was not in the exported register
 *
 * Check 1 is the one that matters most, and it is worth being precise about
 * why it is not a loophole. We are told five numbers and confirm they are
 * consistent. We are never told four and compute the fifth — even though the
 * arithmetic is a subtraction a child could do. **The system may verify an
 * identity; it may never solve for an unknown.**
 */
export function validateBureauFile(register: Register, file: BureauFile): ImportRejection[] {
  const rejections: ImportRejection[] = [];
  const expected = new Map(register.lines.map((l) => [l.employeeId, l]));
  const seen = new Set<string>();

  for (const line of file.lines) {
    if (seen.has(line.employeeId)) {
      rejections.push({
        code: 'EMPLOYEE_DUPLICATED', employeeId: line.employeeId,
        detail: `employee ${line.employeeId} appears more than once in the file`,
      });
      continue;
    }
    seen.add(line.employeeId);

    const reg = expected.get(line.employeeId);
    if (reg === undefined) {
      rejections.push({
        code: 'EMPLOYEE_UNKNOWN', employeeId: line.employeeId,
        detail: `employee ${line.employeeId} was not in the exported register`,
      });
      continue;
    }

    const figures = [
      line.employeeTaxMinor, line.employeeSocialMinor, line.otherDeductionsMinor,
      line.employerSocialMinor, line.netPayMinor,
    ];
    if (figures.some((f) => f < 0n)) {
      rejections.push({
        code: 'NEGATIVE_FIGURE', employeeId: line.employeeId,
        detail: `employee ${line.employeeId} carries a negative figure`,
      });
      continue;
    }

    const deductions = line.employeeTaxMinor + line.employeeSocialMinor + line.otherDeductionsMinor;
    if (reg.grossPayMinor - deductions !== line.netPayMinor) {
      rejections.push({
        code: 'IDENTITY_FAILS', employeeId: line.employeeId,
        detail:
          `gross ${reg.grossPayMinor} − deductions ${deductions} = ` +
          `${reg.grossPayMinor - deductions}, but the file states net ${line.netPayMinor}`,
      });
    }
  }

  for (const employeeId of expected.keys()) {
    if (!seen.has(employeeId)) {
      rejections.push({
        code: 'EMPLOYEE_MISSING', employeeId,
        detail: `employee ${employeeId} is in the period but not in the file`,
      });
    }
  }

  const summed = file.lines.reduce(
    (a, l) => ({
      tax: a.tax + l.employeeTaxMinor,
      social: a.social + l.employeeSocialMinor,
      other: a.other + l.otherDeductionsMinor,
      employer: a.employer + l.employerSocialMinor,
      net: a.net + l.netPayMinor,
    }),
    { tax: 0n, social: 0n, other: 0n, employer: 0n, net: 0n },
  );
  const stated = file.statedTotals;
  const mismatches: string[] = [];
  if (stated.grossMinor !== register.totalGrossMinor) mismatches.push(`gross stated ${stated.grossMinor} vs register ${register.totalGrossMinor}`);
  if (stated.employeeTaxMinor !== summed.tax) mismatches.push(`tax stated ${stated.employeeTaxMinor} vs lines ${summed.tax}`);
  if (stated.employeeSocialMinor !== summed.social) mismatches.push(`employee social stated ${stated.employeeSocialMinor} vs lines ${summed.social}`);
  if (stated.otherMinor !== summed.other) mismatches.push(`other stated ${stated.otherMinor} vs lines ${summed.other}`);
  if (stated.employerSocialMinor !== summed.employer) mismatches.push(`employer social stated ${stated.employerSocialMinor} vs lines ${summed.employer}`);
  if (stated.netMinor !== summed.net) mismatches.push(`net stated ${stated.netMinor} vs lines ${summed.net}`);
  if (mismatches.length > 0) {
    rejections.push({ code: 'TOTALS_DISAGREE', detail: mismatches.join('; ') });
  }

  return rejections;
}
