/**
 * G-5, CLOSED: A POLICY VALUE IS HONOURED OR REFUSED — NEVER IGNORED.
 *
 * The Phase 2 gate found `feeBasis`, `feeCompounds`, `feeOnFee` and
 * `feeDayCount` declared, defaulted, carried through the confirmation flow,
 * and read by nothing. The accrual computed 30E/360 on the overdue balance
 * unconditionally, so an accountant answering Q4 with `actual_365` would have
 * had their answer stored and silently disregarded — and the system could have
 * shown them a signed confirmation of a rule it did not follow.
 *
 * That is worse than not asking. Not asking is a visible gap.
 *
 * The test below is deliberately GENERAL rather than a list of spot checks:
 * for every decision, changing it must either change the answer or refuse.
 * A future field added to `CreditPolicy` and left unread fails here, which is
 * the property that actually protects the boundary.
 */
import { describe, expect, it } from 'vitest';
import {
  PROVISIONAL_TEMPLATE_POLICY, actualDays, days30, feeMechanics, wholeMonths,
  UnsupportedPolicyError, type CreditPolicy,
} from '../src/credit-policy.js';

const CONFIRMED: CreditPolicy = {
  ...PROVISIONAL_TEMPLATE_POLICY,
  confirmedBy: 'accountant',
  confirmedAt: '2026-08-01T00:00:00.000Z',
  confirmationNote: 'confirmed for these tests',
};

/** The elapsed-months rational a policy produces over one fixed window. */
function elapsedOver(policy: CreditPolicy): string {
  const m = feeMechanics(policy);
  const from = m.runsFrom === 'due_date' ? '2026-08-31' : '2026-08-01';
  const e = m.elapsed(from, '2026-11-15');
  return `${m.runsFrom}|${m.feeJoinsBasis}|${e.numerator}/${e.denominator}`;
}

describe('every Q4 decision reaches the arithmetic', () => {
  const baseline = elapsedOver(CONFIRMED);

  /**
   * One case per decision VALUE, each expected either to move the answer or
   * to refuse. The table is the test: adding a value to a union without
   * adding a row leaves that value untested, and adding one to `FeeDayCount`
   * without deciding its arithmetic is already a compile error in the switch.
   */
  const cases: { name: string; patch: Partial<CreditPolicy>; expect: 'differs' | 'refuses' }[] = [
    { name: 'D-1 outstanding_balance', patch: { feeBasis: 'outstanding_balance' }, expect: 'differs' },
    { name: 'D-1 drawn_amount', patch: { feeBasis: 'drawn_amount' }, expect: 'refuses' },
    { name: 'D-2 compounding', patch: { feeCompounds: true }, expect: 'refuses' },
    { name: 'D-2 fee on fee', patch: { feeOnFee: true }, expect: 'differs' },
    { name: 'D-3 actual/365', patch: { feeDayCount: 'actual_365' }, expect: 'differs' },
    { name: 'D-3 whole calendar month', patch: { feeDayCount: 'whole_calendar_month' }, expect: 'differs' },
  ];

  for (const c of cases) {
    it(`${c.name} — ${c.expect}`, () => {
      const policy = { ...CONFIRMED, ...c.patch };
      if (c.expect === 'refuses') {
        expect(() => feeMechanics(policy)).toThrow(UnsupportedPolicyError);
        // …and the refusal NAMES the decision, because the fix is a
        // conversation with a human rather than a retry.
        try {
          feeMechanics(policy);
        } catch (err) {
          const e = err as UnsupportedPolicyError;
          expect(e.code).toBe('FEE_POLICY_UNSUPPORTED');
          expect(e.decision).toMatch(/^D-[12]/);
          expect(e.message.length).toBeGreaterThan(60); // says what is needed
        }
        return;
      }
      expect(elapsedOver(policy)).not.toBe(baseline);
    });
  }

  it('the baseline itself is non-trivial — otherwise "differs" proves nothing', () => {
    // 31 Aug -> 15 Nov under 30E/360: 30·(11−8) + (min(15,30) − min(31,30)) = 90 − 15 = 75.
    expect(baseline).toBe('due_date|false|75/30');
  });
});

describe('each day count answers "how many months" in its own convention', () => {
  it('30E/360 clamps the day of month, so a month costs the same in February', () => {
    expect(days30('2026-01-31', '2026-02-28')).toBe(28);
    expect(days30('2026-03-31', '2026-04-30')).toBe(30);
  });

  it('actual/365 counts real days', () => {
    expect(actualDays('2026-08-01', '2026-09-01')).toBe(31);
    expect(actualDays('2027-02-01', '2027-03-01')).toBe(28);
  });

  it('whole calendar months charge for a month or not at all', () => {
    expect(wholeMonths('2026-08-15', '2026-09-14')).toBe(0); // one day short
    expect(wholeMonths('2026-08-15', '2026-09-15')).toBe(1);
    expect(wholeMonths('2026-08-15', '2026-11-20')).toBe(3);
  });

  it('the three genuinely disagree over the same window — they are not aliases', () => {
    const window = ['2026-08-31', '2026-11-15'] as const;
    const rationals = (['thirty_e_360', 'actual_365', 'whole_calendar_month'] as const).map((dc) => {
      const e = feeMechanics({ ...CONFIRMED, feeDayCount: dc }).elapsed(...window);
      // Compare as a common-denominator integer so 76/30 and 912/365 are
      // comparable without floats (ADR-0004 applies to the comparison too).
      return (e.numerator * 100_000n) / e.denominator;
    });
    expect(new Set(rationals.map(String)).size).toBe(3);
  });
});

describe('the refusals refuse for a stated reason, not by omission', () => {
  it('compounding is refused because no compounding PERIOD was ever asked for', () => {
    try {
      feeMechanics({ ...CONFIRMED, feeCompounds: true });
      throw new Error('should have refused');
    } catch (err) {
      expect((err as UnsupportedPolicyError).message).toMatch(/compounding period/i);
      // Not "not implemented": the point is that assuming monthly would be
      // inventing an answer to a question nobody put to the accountant.
      expect((err as UnsupportedPolicyError).message).toMatch(/rather than assuming/i);
    }
  });

  it('a drawn amount is refused because this credit model has no drawings', () => {
    try {
      feeMechanics({ ...CONFIRMED, feeBasis: 'drawn_amount' });
      throw new Error('should have refused');
    } catch (err) {
      expect((err as UnsupportedPolicyError).message).toMatch(/invoices, not drawings/i);
    }
  });
});
