/**
 * THE PAYROLL BOUNDARY — CLAUDE.md §2.4, tested as a prohibition.
 *
 * Most tests in this repository assert that something works. These mostly
 * assert that something is IMPOSSIBLE, because §2.4 is a prohibition and the
 * failure it prevents is silent: a wrong withholding figure does not surface
 * on a receipt or in a balance that will not tie. It surfaces months later, at
 * somebody else's filing deadline, discovered by a third party.
 *
 * Three mechanisms are under test, and they are deliberately redundant:
 *   1. the CI lint (tools/lint-payroll.mjs) — catches intent, in review
 *   2. the database trigger — catches the write, at runtime, always
 *   3. the import validator — verifies an identity, never solves for one
 *
 * A lint can be bypassed by cleverness and cannot read a runtime value. A
 * trigger cannot read intent. Neither is sufficient; both together are hard to
 * get around by accident, which is the realistic threat.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '../src/ids.js';
import { payrollEntry } from '../src/posting/rules.js';
import { buildRegister, validateBureauFile, type BureauFile, type Register } from '../src/payroll/register.js';
import type { Queryable, TestDb } from '../src/testing/harness.js';
import { makeLocation } from './rbac-fixtures.js';
import { newWrite, setupDb, setupTwoTenants, TENANT_A, TENANT_B } from './util.js';

let db: TestDb;
let outlet: string;
let periodId: string;
let alice: string;
let kofi: string;
const IMPORTER = '018f0000-0000-8000-8000-0000000000ee';

/** Gross for each: base + overtime + commission + allowances. */
const ALICE_GROSS = 180_000n;
const KOFI_GROSS = 240_000n;

async function employee(tx: Queryable, tenantId: string, staffRef: string, locationId: string): Promise<string> {
  const id = uuidv7();
  // The shared write-spine helper, not a speculative insert: a failed
  // statement aborts the whole Postgres transaction, so try/catch around SQL
  // inside `withTenant` cannot be a fallback strategy. (This cost one debug
  // cycle and is worth writing down.)
  const writeId = await newWrite(tx, tenantId, 'test.employee');
  await tx.query(
    `insert into app.employee (tenant_id, id, write_id, hlc, staff_ref, display_name,
                               location_id, started_on)
     values ($1,$2,$3,$4,$5,$6,$7,'2026-08-01')`,
    [tenantId, id, writeId, `${Date.now()}-00002-${'0'.repeat(32)}`, staffRef, staffRef, locationId],
  );
  return id;
}

async function payEntry(
  tx: Queryable, tenantId: string, employeeId: string, locationId: string,
  parts: { base: bigint; overtime?: bigint; commission?: bigint; allowances?: bigint },
): Promise<void> {
  const overtime = parts.overtime ?? 0n;
  const commission = parts.commission ?? 0n;
  const allowances = parts.allowances ?? 0n;
  await tx.query(
    `insert into app.payroll_entry
       (tenant_id, pay_period_id, employee_id, location_id, hours_worked_scaled,
        base_pay_minor, overtime_minor, commission_minor, allowances_minor, gross_pay_minor)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [tenantId, periodId, employeeId, locationId, '16000',
     parts.base.toString(10), overtime.toString(10), commission.toString(10),
     allowances.toString(10), (parts.base + overtime + commission + allowances).toString(10)],
  );
}

beforeAll(async () => {
  db = await setupDb();
  await setupTwoTenants(db);
  await db.withTenant(TENANT_A, async (tx) => {
    outlet = await makeLocation(tx, TENANT_A, { code: 'PAY-01' });
    periodId = uuidv7();
    await tx.query(
      `insert into app.pay_period (tenant_id, id, code, starts_on, ends_on)
       values ($1,$2,'2026-08','2026-08-01','2026-08-31')`, [TENANT_A, periodId]);
    alice = await employee(tx, TENANT_A, 'EMP-001', outlet);
    kofi = await employee(tx, TENANT_A, 'EMP-002', outlet);
    await payEntry(tx, TENANT_A, alice, outlet, { base: 150_000n, overtime: 20_000n, allowances: 10_000n });
    await payEntry(tx, TENANT_A, kofi, outlet, { base: 200_000n, commission: 40_000n });
  });
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe('the register we send carries NO deduction columns', () => {
  it('every field is something the system captured', async () => {
    const register = await db.withTenant(TENANT_A, (tx) => buildRegister(tx, periodId));
    expect(register.lines).toHaveLength(2);
    const keys = Object.keys(register.lines[0]!);
    // Not "the deduction columns are blank" — they are absent. A blank column
    // named after a statutory deduction is an invitation to fill it in.
    for (const k of keys) {
      expect(k).not.toMatch(/tax|social|deduction|net|bureau/i);
    }
    expect(keys).toContain('grossPayMinor');
    expect(keys).toContain('hoursScale'); // scale is carried, never assumed
    expect(register.totalGrossMinor).toBe(ALICE_GROSS + KOFI_GROSS);
  });
});

describe('the import VERIFIES an identity and never solves for an unknown', () => {
  function file(over: Partial<BureauFile> = {}, lineOver: Record<string, Partial<Record<string, bigint>>> = {}): BureauFile {
    const mk = (employeeId: string, gross: bigint) => {
      const tax = gross / 10n;
      const social = gross / 20n;
      const other = 0n;
      const base = {
        employeeId,
        employeeTaxMinor: tax,
        employeeSocialMinor: social,
        otherDeductionsMinor: other,
        employerSocialMinor: gross / 8n,
        netPayMinor: gross - tax - social - other,
      };
      return { ...base, ...(lineOver[employeeId] ?? {}) };
    };
    const lines = [mk(alice, ALICE_GROSS), mk(kofi, KOFI_GROSS)];
    const sum = (f: (l: (typeof lines)[number]) => bigint) => lines.reduce((a, l) => a + f(l), 0n);
    return {
      payPeriodId: periodId, bureauRef: 'BUREAU-1', fileDigest: 'abc',
      lines,
      statedTotals: {
        grossMinor: ALICE_GROSS + KOFI_GROSS,
        employeeTaxMinor: sum((l) => l.employeeTaxMinor),
        employeeSocialMinor: sum((l) => l.employeeSocialMinor),
        otherMinor: sum((l) => l.otherDeductionsMinor),
        employerSocialMinor: sum((l) => l.employerSocialMinor),
        netMinor: sum((l) => l.netPayMinor),
      },
      ...over,
    };
  }

  let register: Register;
  beforeAll(async () => {
    register = await db.withTenant(TENANT_A, (tx) => buildRegister(tx, periodId));
  }, 60_000);

  it('a consistent file is accepted — the positive control', () => {
    expect(validateBureauFile(register, file())).toEqual([]);
  });

  it('a file where gross − deductions ≠ net is REJECTED, not corrected', () => {
    // The system could trivially rearrange the identity to "fix" this. It must
    // not: solving for an unknown is calculation, and the arithmetic being
    // easy is exactly the trap.
    const bad = file({}, { [alice]: { netPayMinor: 1n } });
    const rejections = validateBureauFile(register, bad);
    expect(rejections.some((r) => r.code === 'IDENTITY_FAILS')).toBe(true);
    expect(rejections.find((r) => r.code === 'IDENTITY_FAILS')?.employeeId).toBe(alice);
  });

  it('a MISSING employee is rejected — never filled in from last month', () => {
    const short = file();
    const rejections = validateBureauFile(register, { ...short, lines: [short.lines[0]!] });
    expect(rejections.some((r) => r.code === 'EMPLOYEE_MISSING')).toBe(true);
    // …and the totals check catches it a second time, independently.
    expect(rejections.some((r) => r.code === 'TOTALS_DISAGREE')).toBe(true);
  });

  it('a DUPLICATED employee is rejected', () => {
    const dup = file();
    const rejections = validateBureauFile(register, { ...dup, lines: [...dup.lines, dup.lines[0]!] });
    expect(rejections.some((r) => r.code === 'EMPLOYEE_DUPLICATED')).toBe(true);
  });

  it('an employee who was never in the register is rejected', () => {
    const extra = file();
    const rejections = validateBureauFile(register, {
      ...extra,
      lines: [...extra.lines, { ...extra.lines[0]!, employeeId: uuidv7() }],
    });
    expect(rejections.some((r) => r.code === 'EMPLOYEE_UNKNOWN')).toBe(true);
  });

  it('stated totals that do not tie to the file’s own lines are rejected', () => {
    const wrong = file();
    const rejections = validateBureauFile(register, {
      ...wrong,
      statedTotals: { ...wrong.statedTotals, netMinor: wrong.statedTotals.netMinor + 1n },
    });
    expect(rejections.some((r) => r.code === 'TOTALS_DISAGREE')).toBe(true);
  });

  it('a negative figure is rejected', () => {
    const neg = file({}, { [kofi]: { employeeTaxMinor: -1n } });
    expect(validateBureauFile(register, neg).some((r) => r.code === 'NEGATIVE_FIGURE')).toBe(true);
  });
});

describe('the DATABASE refuses a bureau figure that did not arrive with an import', () => {
  it('an UPDATE setting a bureau figure with no import is refused', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(
          `update app.payroll_entry set bureau_employee_tax_minor = 1
            where pay_period_id = $1 and employee_id = $2`,
          [periodId, alice],
        ),
      ),
    ).rejects.toThrow(/PR0001/);
  });

  it('…and one naming an import from an EARLIER transaction is refused', async () => {
    // The path this closes: import the file correctly, then come back later
    // and "just fix one number". That is where a system that records starts
    // calculating.
    const importId = await db.withTenant(TENANT_A, async (tx) => {
      const id = uuidv7();
      await tx.query(
        `insert into app.payroll_bureau_import
           (tenant_id, id, pay_period_id, bureau_ref, file_digest, imported_by,
            stated_gross_minor, stated_employee_tax_minor, stated_employee_social_minor,
            stated_other_minor, stated_employer_social_minor, stated_net_minor)
         values ($1,$2,$3,'B','d',$4,0,0,0,0,0,0)`,
        [TENANT_A, id, periodId, IMPORTER],
      );
      return id;
    });

    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(
          `update app.payroll_entry
              set bureau_import_id = $3, bureau_employee_tax_minor = 1,
                  bureau_employee_social_minor = 1, bureau_other_deductions_minor = 0,
                  bureau_employer_social_minor = 1, bureau_net_pay_minor = 1
            where pay_period_id = $1 and employee_id = $2`,
          [periodId, alice, importId],
        ),
      ),
    ).rejects.toThrow(/PR0003/);
  });

  it('…while the SAME transaction as the import succeeds — the positive control', async () => {
    const applied = await db.withTenant(TENANT_A, async (tx) => {
      const id = uuidv7();
      await tx.query(
        `insert into app.payroll_bureau_import
           (tenant_id, id, pay_period_id, bureau_ref, file_digest, imported_by,
            stated_gross_minor, stated_employee_tax_minor, stated_employee_social_minor,
            stated_other_minor, stated_employer_social_minor, stated_net_minor)
         values ($1,$2,$3,'B','d',$4,$5,$6,$7,0,$8,$9)`,
        [TENANT_A, id, periodId, IMPORTER, (ALICE_GROSS).toString(10), '18000', '9000', '22500', '153000'],
      );
      await tx.query(
        `update app.payroll_entry
            set bureau_import_id = $3, bureau_employee_tax_minor = 18000,
                bureau_employee_social_minor = 9000, bureau_other_deductions_minor = 0,
                bureau_employer_social_minor = 22500, bureau_net_pay_minor = 153000
          where pay_period_id = $1 and employee_id = $2`,
        [periodId, alice, id],
      );
      const r = await tx.query<{ n: string }>(
        `select bureau_net_pay_minor::text n from app.payroll_entry
          where pay_period_id = $1 and employee_id = $2`, [periodId, alice]);
      return r.rows[0]!.n;
    });
    expect(applied).toBe('153000');
  });

  it('a PARTIAL return cannot land — four figures out of five is not a return', async () => {
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const id = uuidv7();
        await tx.query(
          `insert into app.payroll_bureau_import
             (tenant_id, id, pay_period_id, bureau_ref, file_digest, imported_by,
              stated_gross_minor, stated_employee_tax_minor, stated_employee_social_minor,
              stated_other_minor, stated_employer_social_minor, stated_net_minor)
           values ($1,$2,$3,'B','d',$4,0,0,0,0,0,0)`,
          [TENANT_A, id, periodId, IMPORTER],
        );
        await tx.query(
          `update app.payroll_entry
              set bureau_import_id = $3, bureau_employee_tax_minor = 1
            where pay_period_id = $1 and employee_id = $2`,
          [periodId, kofi, id],
        );
      }),
    ).rejects.toThrow(/pe_bureau_complete/);
  });
});

describe('rule 9 — booking figures somebody else computed', () => {
  const line = {
    employeeId: '018f0000-0000-8000-8000-00000000e001',
    locationId: '018f0000-0000-8000-8000-00000000a001',
    nonCommissionGrossMinor: 180_000n,
    commissionMinor: 0n,
    bureauEmployeeTaxMinor: 18_000n,
    bureauEmployeeSocialMinor: 9_000n,
    bureauOtherDeductionsMinor: 0n,
    bureauEmployerSocialMinor: 22_500n,
    bureauNetPayMinor: 153_000n,
  };

  it('the employer contribution gets its OWN expense AND its own payable', () => {
    // Not netted into an employee deduction. §2.4 prohibits computing the
    // figure, not booking it, and omitting the account understates staff cost.
    const entry = payrollEntry({
      payPeriodId: 'p', businessDate: '2026-08-31', lines: [line],
    });
    const expense = entry.lines.find((l) => l.role === 'STAFF_COST_EMPLOYER_SOCIAL');
    const payable = entry.lines.find((l) => l.role === 'EMPLOYER_SOCIAL_PAYABLE');
    expect(expense?.debitMinor).toBe(22_500n);
    expect(payable?.creditMinor).toBe(22_500n);
  });

  it('it balances IF AND ONLY IF the bureau’s own identity holds', () => {
    // The shape does the work: gross === tax + social + other + net is the
    // condition for balance, so a file that slipped past validation cannot
    // post. Two independent chances to catch the same error.
    expect(() => payrollEntry({ payPeriodId: 'p', businessDate: '2026-08-31', lines: [line] }))
      .not.toThrow();

    expect(() =>
      payrollEntry({
        payPeriodId: 'p', businessDate: '2026-08-31',
        lines: [{ ...line, bureauNetPayMinor: 153_001n }],
      }),
    ).toThrow(/do not balance/);
  });

  it('net pay is the bureau’s figure, credited exactly as given', () => {
    const entry = payrollEntry({ payPeriodId: 'p', businessDate: '2026-08-31', lines: [line] });
    const net = entry.lines.find((l) => l.role === 'NET_PAY_PAYABLE');
    expect(net?.creditMinor).toBe(153_000n);
    expect(net?.counterpartyId).toBe(line.employeeId);
  });
});

describe('the boundary lint is a real gate, not a decoration', () => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const probe = join(repoRoot, 'packages', 'db', 'src', 'payroll', '__lint_probe__.ts');

  function lint(): { ok: boolean; out: string } {
    try {
      return { ok: true, out: execFileSync('node', ['tools/lint-payroll.mjs'], { cwd: repoRoot, encoding: 'utf8' }) };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  }

  afterEach(() => {
    if (existsSync(probe)) rmSync(probe);
  });

  it('FAILS on a computed bureau figure — the check that proves it is not vacuous', () => {
    // A lint asserted only to pass is a lint that would pass if it checked
    // nothing. This writes the exact violation §5.8.1 names — "if a reviewer
    // sees bureau_employee_tax_minor = gross * something, the build fails" —
    // and requires the build to fail.
    writeFileSync(probe, 'export const x = 1;\nlet bureau_employee_tax_minor = 0;\nbureau_employee_tax_minor = gross * 0.05;\n');
    const r = lint();
    expect(r.ok).toBe(false);
    expect(r.out).toContain('COMPUTED expression');
  });

  it('FAILS on statutory withholding vocabulary anywhere in the tree', () => {
    // lint-payroll-ignore — writes the banned vocabulary in order to prove the lint stops on it
    writeFileSync(probe, 'export const bands = [{ upTo: 490, r' + 'ate: 0 }]; // P' + 'AYE band table\n');
    const r = lint();
    expect(r.ok).toBe(false);
    expect(r.out).toContain('statutory withholding vocabulary');
  });

  it('FAILS on a bureau figure written outside the import module', () => {
    writeFileSync(probe, 'export function f(e: { bureauNetPayMinor: bigint }) {\n  e.bureauNetPayMinor = 1n;\n}\n');
    const r = lint();
    expect(r.ok).toBe(false);
    expect(r.out).toContain('outside payroll/import.ts');
  });

  it('passes on this repository', () => {
    // fileURLToPath, not URL.pathname: this repository's directory contains a
    // space, and `pathname` leaves it percent-encoded — which spawns node in a
    // directory that does not exist and reports ENOENT.
    const out = execFileSync('node', ['tools/lint-payroll.mjs'], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      encoding: 'utf8',
    });
    expect(out).toContain('payroll lint: clean');
  });
});

describe('tenant isolation on payroll — §2.7 category 3', () => {
  it('tenant B sees no employee, no period and no payroll entry of A’s', async () => {
    const seen = await db.withTenant(TENANT_B, async (tx) => {
      const e = await tx.query<{ n: string }>(`select count(*)::text n from app.employee`);
      const p = await tx.query<{ n: string }>(`select count(*)::text n from app.pay_period`);
      const pe = await tx.query<{ n: string }>(`select count(*)::text n from app.payroll_entry`);
      return { employees: Number(e.rows[0]!.n), periods: Number(p.rows[0]!.n), entries: Number(pe.rows[0]!.n) };
    });
    expect(seen).toEqual({ employees: 0, periods: 0, entries: 0 });

    // The positive control that makes those zeroes mean something.
    const aSeen = await db.withTenant(TENANT_A, async (tx) => {
      const e = await tx.query<{ n: string }>(`select count(*)::text n from app.employee`);
      return Number(e.rows[0]!.n);
    });
    expect(aSeen).toBe(2);
  });

  it('the payroll REGISTER EXPORT, asked from B for A’s period, refuses exactly as for a period that does not exist', async () => {
    // Positive control: the export really produces A's register.
    const own = await db.withTenant(TENANT_A, (tx) => buildRegister(tx, periodId));
    expect(own.lines.length).toBe(2);

    const refusal = async (id: string) => {
      try {
        await db.withTenant(TENANT_B, (tx) => buildRegister(tx, id));
        return 'answered';
      } catch (err) {
        return (err as Error).message.split(id).join('<id>');
      }
    };
    const foreign = await refusal(periodId);
    expect(foreign).toBe(await refusal(uuidv7()));
    expect(foreign).toBe('no pay period <id>');

    // …and the refusal depends on RLS: with pay_period's policy disabled the
    // same call from B hands over A's register. Restored in finally.
    await db.asAdmin((tx) => tx.query('alter table app.pay_period disable row level security'));
    try {
      expect(await refusal(periodId)).toBe('answered');
    } finally {
      await db.asAdmin((tx) => tx.query('alter table app.pay_period enable row level security'));
    }
    expect(await refusal(periodId)).toBe('no pay period <id>');
  });
});
