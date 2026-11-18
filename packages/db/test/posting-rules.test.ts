/**
 * THE POSTING RULES — §2.7 category 1, and the one place a wrong answer is
 * silent.
 *
 * These are pure functions, so they can be tested exhaustively rather than by
 * example. That matters more here than anywhere else in the system: an
 * unbalanced entry is caught by Postgres at COMMIT, but a rule that balances
 * and posts to the WRONG PLACE is caught by nothing. §5.6.2's own correction
 * is exactly that failure — five rules put a control-account line at the
 * location of the person handling the money rather than the location of the
 * obligation, and every trial balance still summed to zero.
 *
 * So the property tests below assert two different things:
 *   1. it balances, per location, for every input — the cheap property;
 *   2. it balances at the RIGHT locations — the expensive one, and the only
 *      one that would have caught the defect the architecture shipped.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  assertBalances,
  cashSessionCloseEntry,
  clearingNets,
  paymentEntry,
  saleEntry,
  stockAdjustmentEntry,
  transferEntry,
  UnbalancedRuleError,
  type ProposedLine,
} from '../src/posting/rules.js';
import { saleWith } from './util.js';

const LOC_A = '018f0000-0000-8000-8000-00000000a001';
const LOC_B = '018f0000-0000-8000-8000-00000000b001';
const CUSTOMER = '018f0000-0000-8000-8000-00000000c001';

/** Minor units, bounded well above any real transaction and far below 2^63. */
const minor = (max = 10_000_000) => fc.bigInt({ min: 0n, max: BigInt(max) });

function totals(lines: readonly ProposedLine[], locationId?: string) {
  let dr = 0n;
  let cr = 0n;
  for (const l of lines) {
    if (locationId !== undefined && l.locationId !== locationId) continue;
    dr += l.debitMinor;
    cr += l.creditMinor;
  }
  return { dr, cr };
}

function amountOn(lines: readonly ProposedLine[], role: string, locationId?: string): bigint {
  let net = 0n;
  for (const l of lines) {
    if (l.role !== role) continue;
    if (locationId !== undefined && l.locationId !== locationId) continue;
    net += l.debitMinor - l.creditMinor;
  }
  return net;
}

describe('a sale — rules 1, 1b, 2 and 3', () => {
  it('balances for EVERY combination of revenue, discount, tax and cost', () => {
    fc.assert(
      fc.property(
        minor(), minor(), fc.array(minor(200_000), { maxLength: 4 }), minor(),
        fc.constantFrom('CASH' as const, 'MOMO' as const, 'CREDIT' as const),
        (rawRevenue, rawDiscount, taxes, cost, tender) => {
          const revenue = rawRevenue === 0n && cost === 0n ? 1n : rawRevenue;
          // A discount cannot exceed the revenue it discounts; the sale path
          // refuses that upstream (`line discount exceeds line amount`).
          const discount = rawDiscount > revenue ? revenue : rawDiscount;
          const entry = saleWith({
            saleId: 'sale-1', locationId: LOC_A, businessDate: '2026-08-15', tender,
            ...(tender === 'CREDIT' ? { customerId: CUSTOMER } : {}),
            revenueMinor: revenue, discountMinor: discount,
            taxes: taxes.map((t, i) => ({ taxCode: `T${i}`, taxMinor: t })),
            costMinor: cost,
          });
          const { dr, cr } = totals(entry.lines);
          return dr === cr;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('the customer is debited EXACTLY what the sale totalled', () => {
    fc.assert(
      // Revenue is at least 1: a document with nothing on it is not a sale,
      // and has its own test below. The property test found that edge before
      // any reasoning did.
      fc.property(fc.bigInt({ min: 1n, max: 10_000_000n }), minor(), fc.array(minor(200_000), { maxLength: 4 }), (revenue, rawDiscount, taxes) => {
        const discount = rawDiscount > revenue ? revenue : rawDiscount;
        const taxTotal = taxes.reduce((a, b) => a + b, 0n);
        const entry = saleWith({
          saleId: 's', locationId: LOC_A, businessDate: '2026-08-15', tender: 'CASH',
          revenueMinor: revenue, discountMinor: discount,
          taxes: taxes.map((t, i) => ({ taxCode: `T${i}`, taxMinor: t })), costMinor: 0n,
        });
        // The figure app.sale.total_minor holds: revenue gross of discount,
        // less the discount, plus tax.
        return amountOn(entry.lines, 'TILL_CASH') === revenue - discount + taxTotal;
      }),
      { numRuns: 300 },
    );
  });

  it('REVENUE IS CREDITED GROSS OF DISCOUNT, with the discount as its own contra', () => {
    // 07 §7.3.2. Netting the discount into revenue would make a manager
    // granting approved overrides all day produce books indistinguishable
    // from lower list prices — and §5.6.4's stated purpose, preserving gross
    // sales for the margin metric, would fail silently.
    const entry = saleWith({
      saleId: 's', locationId: LOC_A, businessDate: '2026-08-15', tender: 'CASH',
      revenueMinor: 100_000n, discountMinor: 15_000n,
      taxes: [{ taxCode: 'VAT', taxMinor: 17_000n }], costMinor: 60_000n,
    });
    expect(amountOn(entry.lines, 'SALES_REVENUE')).toBe(-100_000n); // credit
    expect(amountOn(entry.lines, 'SALES_DISCOUNT')).toBe(15_000n); // debit, contra
    expect(amountOn(entry.lines, 'TILL_CASH')).toBe(102_000n); // 100k - 15k + 17k
  });

  it('TAX IS A LIABILITY, one credit per component — never revenue', () => {
    const entry = saleWith({
      saleId: 's', locationId: LOC_A, businessDate: '2026-08-15', tender: 'CASH',
      revenueMinor: 15_000n, discountMinor: 0n,
      taxes: [
        { taxCode: 'GH.VAT.STD', taxMinor: 2_250n },
        { taxCode: 'GH.NHIL', taxMinor: 375n },
        { taxCode: 'GH.GETFUND', taxMinor: 375n },
      ],
      costMinor: 0n,
    });
    const taxLines = entry.lines.filter((l) => l.role === 'OUTPUT_TAX');
    expect(taxLines).toHaveLength(3);
    expect(taxLines.every((l) => l.creditMinor > 0n && l.debitMinor === 0n)).toBe(true);
    expect(amountOn(entry.lines, 'OUTPUT_TAX')).toBe(-3_000n);
    // …and none of it landed on revenue.
    expect(amountOn(entry.lines, 'SALES_REVENUE')).toBe(-15_000n);
  });

  it('a CREDIT sale differs from a cash sale only in which account is debited', () => {
    const common = {
      saleId: 's', locationId: LOC_A, businessDate: '2026-08-15',
      revenueMinor: 50_000n, discountMinor: 0n,
      taxes: [{ taxCode: 'VAT', taxMinor: 10_000n }], costMinor: 30_000n,
    } as const;
    const cash = saleWith({ ...common, tender: 'CASH' });
    const credit = saleWith({ ...common, tender: 'CREDIT', customerId: CUSTOMER });

    expect(amountOn(cash.lines, 'TILL_CASH')).toBe(60_000n);
    expect(amountOn(credit.lines, 'AR_TRADE')).toBe(60_000n);
    expect(amountOn(credit.lines, 'TILL_CASH')).toBe(0n);
    // Revenue is recognised on the sale, not on payment — identical both ways.
    expect(amountOn(cash.lines, 'SALES_REVENUE')).toBe(amountOn(credit.lines, 'SALES_REVENUE'));
    // The receivable names the customer; a control account with no
    // counterparty is a balance nobody can chase.
    const ar = credit.lines.find((l) => l.role === 'AR_TRADE')!;
    expect(ar.counterpartyKind).toBe('customer');
    expect(ar.counterpartyId).toBe(CUSTOMER);
  });

  it('a sale with NOTHING on it is refused by name — found by the property test', () => {
    // Zero revenue, zero discount, no tax, no cost. Every line computes to
    // nil and there is no entry to make. The refusal is explicit so the
    // posting exception says something an operator can act on, rather than
    // complaining about a line count.
    expect(() =>
      saleWith({
        saleId: 's', locationId: LOC_A, businessDate: '2026-08-15', tender: 'CASH',
        revenueMinor: 0n, discountMinor: 0n, taxes: [], costMinor: 0n,
      }),
    ).toThrow(/nothing to post/);
  });

  it('…but a zero-revenue sale that still moved STOCK does post its cost', () => {
    // The positive control, and a real shape: a promotional line priced at
    // nothing still took goods off the shelf, and the cost belongs in COGS.
    const entry = saleWith({
      saleId: 's', locationId: LOC_A, businessDate: '2026-08-15', tender: 'CASH',
      revenueMinor: 0n, discountMinor: 0n, taxes: [], costMinor: 4_000n,
    });
    expect(amountOn(entry.lines, 'COGS')).toBe(4_000n);
    expect(amountOn(entry.lines, 'INVENTORY')).toBe(-4_000n);
    expect(totals(entry.lines).dr).toBe(totals(entry.lines).cr);
  });

  it('a sale with no discount and no cost emits neither line, rather than zeros', () => {
    const entry = saleWith({
      saleId: 's', locationId: LOC_A, businessDate: '2026-08-15', tender: 'CASH',
      revenueMinor: 1_000n, discountMinor: 0n, taxes: [], costMinor: 0n,
    });
    expect(entry.lines.map((l) => l.role)).toEqual(['TILL_CASH', 'SALES_REVENUE']);
  });
});

describe('rule 1 BY TENDER — the debit follows the method’s posting role, split or not', () => {
  // Since migration 0021 the tender is RECORDED per row. Before it, every
  // non-credit sale debited the till — so a mobile-money receipt sat in the
  // drawer account and momo reconciliation (05 §5.7.1) could never find it.
  const common = {
    saleId: 's', locationId: LOC_A, businessDate: '2026-08-15',
    revenueMinor: 50_000n, discountMinor: 0n,
    taxes: [{ taxCode: 'VAT', taxMinor: 10_000n }], costMinor: 0n,
  } as const;

  it('a momo sale debits MOMO_WALLET and a bank transfer debits BANK — never the till', () => {
    const momo = saleEntry({ ...common, tenders: [{ role: 'MOMO_WALLET', amountMinor: 60_000n }] });
    const bank = saleEntry({ ...common, tenders: [{ role: 'BANK', amountMinor: 60_000n }] });
    expect(amountOn(momo.lines, 'MOMO_WALLET')).toBe(60_000n);
    expect(amountOn(momo.lines, 'TILL_CASH')).toBe(0n);
    expect(amountOn(bank.lines, 'BANK')).toBe(60_000n);
    expect(amountOn(bank.lines, 'TILL_CASH')).toBe(0n);
    expect(momo.sourceKind).toBe('cash_sale');
  });

  it('a SPLIT tender is one entry with one debit per role, each for its own part', () => {
    const entry = saleEntry({
      ...common,
      customerId: CUSTOMER,
      tenders: [
        { role: 'TILL_CASH', amountMinor: 10_000n },
        { role: 'MOMO_WALLET', amountMinor: 20_000n },
        { role: 'AR_TRADE', amountMinor: 25_000n },
        { role: 'TILL_CASH', amountMinor: 5_000n }, // two cash rows aggregate
      ],
    });
    expect(amountOn(entry.lines, 'TILL_CASH')).toBe(15_000n);
    expect(amountOn(entry.lines, 'MOMO_WALLET')).toBe(20_000n);
    expect(amountOn(entry.lines, 'AR_TRADE')).toBe(25_000n);
    expect(entry.lines.filter((l) => l.role === 'TILL_CASH')).toHaveLength(1);
    // Only the receivable names the customer; the till and the wallet do not.
    expect(entry.lines.find((l) => l.role === 'AR_TRADE')!.counterpartyId).toBe(CUSTOMER);
    expect(entry.lines.find((l) => l.role === 'TILL_CASH')!.counterpartyId).toBeUndefined();
    // Anything on account makes it a credit sale — the classification the
    // sweep used before tenders were recorded, kept so old exceptions resolve.
    expect(entry.sourceKind).toBe('credit_sale');
  });

  it('a cash sale by a KNOWN customer debits the till, not the customer', () => {
    const entry = saleEntry({ ...common, customerId: CUSTOMER, tenders: [{ role: 'TILL_CASH', amountMinor: 60_000n }] });
    expect(amountOn(entry.lines, 'AR_TRADE')).toBe(0n);
    expect(entry.lines.every((l) => l.counterpartyId === undefined)).toBe(true);
  });

  it('balances for EVERY split of the total across the four roles', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        fc.array(fc.bigInt({ min: 0n, max: 200_000n }), { maxLength: 3 }),
        fc.array(fc.nat({ max: 1_000 }), { minLength: 4, maxLength: 4 }),
        (revenue, taxes, weights) => {
          const taxTotal = taxes.reduce((a, b) => a + b, 0n);
          const total = revenue + taxTotal;
          // Split the total by integer weights; the last part takes the
          // remainder so the parts are exact (ADR-0004 — no float shares).
          const w = weights.map((x) => BigInt(x));
          const wSum = w.reduce((a, b) => a + b, 0n) || 1n;
          const roles = ['TILL_CASH', 'MOMO_WALLET', 'BANK', 'AR_TRADE'] as const;
          let left = total;
          const tenders = roles.map((role, i) => {
            const amount = i === roles.length - 1 ? left : (total * w[i]!) / wSum;
            left -= amount;
            return { role, amountMinor: amount };
          });
          const entry = saleEntry({
            saleId: 's', locationId: LOC_A, businessDate: '2026-08-15', customerId: CUSTOMER,
            revenueMinor: revenue, discountMinor: 0n,
            taxes: taxes.map((t, i) => ({ taxCode: `T${i}`, taxMinor: t })), costMinor: 0n,
            tenders,
          });
          const { dr, cr } = totals(entry.lines);
          const settled = roles.reduce((a, r) => a + amountOn(entry.lines, r), 0n);
          return dr === cr && settled === total;
        },
      ),
      { numRuns: 400 },
    );
  });

  it('REFUSES tenders that do not sum to the total — no plug, no suspense line', () => {
    expect(() =>
      saleEntry({ ...common, tenders: [{ role: 'TILL_CASH', amountMinor: 59_999n }] }),
    ).toThrow(/tenders sum to 59999 but the sale's total is 60000/);
    // …and ZERO tenders against a non-zero total is the same refusal: the
    // case a trigger on sale_tender alone would never have seen (04 §4.8).
    expect(() => saleEntry({ ...common, tenders: [] })).toThrow(/tenders sum to 0/);
    // Positive control: the exact total posts.
    expect(() =>
      saleEntry({ ...common, tenders: [{ role: 'TILL_CASH', amountMinor: 60_000n }] }),
    ).not.toThrow();
  });

  it('REFUSES an on-account part with no customer — a receivable nobody owes', () => {
    expect(() =>
      saleEntry({ ...common, tenders: [{ role: 'AR_TRADE', amountMinor: 60_000n }] }),
    ).toThrow(/no customer/);
    expect(() =>
      saleEntry({ ...common, customerId: CUSTOMER, tenders: [{ role: 'AR_TRADE', amountMinor: 60_000n }] }),
    ).not.toThrow();
  });

  it('REFUSES a role that is not a settlement role, rather than dropping the part', () => {
    expect(() =>
      saleEntry({
        ...common,
        tenders: [{ role: 'SALES_REVENUE' as unknown as 'TILL_CASH', amountMinor: 60_000n }],
      }),
    ).toThrow(/not a settlement role/);
  });
});

describe('closing a till — rules 11 and 11b', () => {
  const close = (bankedMinor: bigint, varianceMinor: bigint) =>
    cashSessionCloseEntry({
      sessionId: 'cs-1', locationId: LOC_A, businessDate: '2026-08-15', bankedMinor, varianceMinor,
    });

  it('rule 11: banked cash moves from the till to CASH_IN_TRANSIT, at the outlet', () => {
    const entry = close(450_000n, 0n);
    expect(amountOn(entry.lines, 'CASH_IN_TRANSIT', LOC_A)).toBe(450_000n);
    expect(amountOn(entry.lines, 'TILL_CASH', LOC_A)).toBe(-450_000n);
    expect(entry.lines).toHaveLength(2);
    expect(entry.sourceKind).toBe('cash_session_close');
  });

  it('rule 11b: a SHORT count debits CASH_OVER_SHORT and credits the till', () => {
    const entry = close(0n, -1_250n);
    expect(amountOn(entry.lines, 'CASH_OVER_SHORT')).toBe(1_250n);
    expect(amountOn(entry.lines, 'TILL_CASH')).toBe(-1_250n);
  });

  it('rule 11b: an OVER count reverses the sign', () => {
    const entry = close(0n, 700n);
    expect(amountOn(entry.lines, 'CASH_OVER_SHORT')).toBe(-700n);
    expect(amountOn(entry.lines, 'TILL_CASH')).toBe(700n);
  });

  it('banking and a variance together are ONE entry — the close is one document', () => {
    const entry = close(300_000n, -50n);
    expect(amountOn(entry.lines, 'TILL_CASH')).toBe(-300_050n);
    expect(amountOn(entry.lines, 'CASH_IN_TRANSIT')).toBe(300_000n);
    expect(amountOn(entry.lines, 'CASH_OVER_SHORT')).toBe(50n);
  });

  it('balances, at the outlet, for every banked amount and every signed variance', () => {
    fc.assert(
      fc.property(minor(), fc.bigInt({ min: -5_000_000n, max: 5_000_000n }), (banked, variance) => {
        fc.pre(banked !== 0n || variance !== 0n);
        const entry = close(banked, variance);
        const { dr, cr } = totals(entry.lines, LOC_A);
        // The till moves by exactly −banked + variance: what left for the
        // bank, and what the count said was really there.
        return dr === cr && amountOn(entry.lines, 'TILL_CASH') === -banked + variance
          && entry.lines.every((l) => l.locationId === LOC_A);
      }),
      { numRuns: 400 },
    );
  });

  it('a till counted to the pesewa with nothing banked has nothing to post — refused by name', () => {
    expect(() => close(0n, 0n)).toThrow(/nothing to post/);
    expect(() => close(-1n, 0n)).toThrow(/negative/);
  });
});

describe('a payment — rule 4, and the correction that makes it right', () => {
  it('same location: two lines, and the AR clears where it was raised', () => {
    const entry = paymentEntry({
      paymentId: 'p', businessDate: '2026-08-20', receivingLocationId: LOC_A,
      obligationLocationId: LOC_A, customerId: CUSTOMER, amountMinor: 370_800n,
      instrument: 'CASH',
    });
    expect(entry.lines).toHaveLength(2);
    expect(amountOn(entry.lines, 'TILL_CASH', LOC_A)).toBe(370_800n);
    expect(amountOn(entry.lines, 'AR_TRADE', LOC_A)).toBe(-370_800n);
  });

  it('DIFFERENT locations: the AR clears at the OBLIGATION, not at the till', () => {
    // The defect §5.6.2 shipped: a contractor buys at Techiman and pays at
    // Sunyani. `Dr TILL(Sunyani) / Cr AR(Sunyani)` balances per location and
    // both trial balances still sum to zero — and Techiman's AR carries a
    // debit that will never clear while Sunyani's carries a permanent credit
    // on an asset account. Nothing detects it. This is the assertion that
    // would have.
    const entry = paymentEntry({
      paymentId: 'p', businessDate: '2026-08-20',
      receivingLocationId: LOC_B, // paid at Sunyani
      obligationLocationId: LOC_A, // bought at Techiman
      customerId: CUSTOMER, amountMinor: 500_000n, instrument: 'CASH',
    });

    expect(entry.lines).toHaveLength(4);
    // The AR is credited at the OBLIGATION's location and nowhere else.
    expect(amountOn(entry.lines, 'AR_TRADE', LOC_A)).toBe(-500_000n);
    expect(amountOn(entry.lines, 'AR_TRADE', LOC_B)).toBe(0n);
    // The cash is where the cash actually is.
    expect(amountOn(entry.lines, 'TILL_CASH', LOC_B)).toBe(500_000n);
    expect(amountOn(entry.lines, 'TILL_CASH', LOC_A)).toBe(0n);
    // Both locations balance…
    expect(totals(entry.lines, LOC_A).dr).toBe(totals(entry.lines, LOC_A).cr);
    expect(totals(entry.lines, LOC_B).dr).toBe(totals(entry.lines, LOC_B).cr);
    // …and the clearing account nets to zero across the tenant.
    expect(clearingNets(entry.lines)).toBe(true);
  });

  it('a provider charge is an EXPENSE, and AR still clears by the GROSS', () => {
    // Rule 4b. The customer paid 1,000 and 995 landed. Revenue — and the
    // receivable — is 1,000; the 5 is a cost. Treating it as a discount makes
    // momo never reconcile.
    const entry = paymentEntry({
      paymentId: 'p', businessDate: '2026-08-20', receivingLocationId: LOC_A,
      obligationLocationId: LOC_A, customerId: CUSTOMER,
      amountMinor: 100_000n, chargeMinor: 500n, instrument: 'MOMO',
    });
    expect(amountOn(entry.lines, 'MOMO_WALLET')).toBe(99_500n);
    expect(amountOn(entry.lines, 'BANK_CHARGES')).toBe(500n);
    expect(amountOn(entry.lines, 'AR_TRADE')).toBe(-100_000n);
  });

  it('balances at BOTH locations for every amount, charge and pairing', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        fc.bigInt({ min: 0n, max: 50_000n }),
        fc.boolean(),
        (amount, rawCharge, sameLocation) => {
          const charge = rawCharge > amount ? amount : rawCharge;
          const entry = paymentEntry({
            paymentId: 'p', businessDate: '2026-08-20',
            receivingLocationId: LOC_B,
            obligationLocationId: sameLocation ? LOC_B : LOC_A,
            customerId: CUSTOMER, amountMinor: amount, chargeMinor: charge,
            instrument: 'MOMO',
          });
          const a = totals(entry.lines, LOC_A);
          const b = totals(entry.lines, LOC_B);
          // The AR is always credited exactly the gross, at the obligation.
          const arAt = sameLocation ? LOC_B : LOC_A;
          return (
            a.dr === a.cr &&
            b.dr === b.cr &&
            clearingNets(entry.lines) &&
            amountOn(entry.lines, 'AR_TRADE', arAt) === -amount
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  it('a charge larger than the payment is refused rather than posted', () => {
    expect(() =>
      paymentEntry({
        paymentId: 'p', businessDate: '2026-08-20', receivingLocationId: LOC_A,
        obligationLocationId: LOC_A, customerId: CUSTOMER,
        amountMinor: 100n, chargeMinor: 101n, instrument: 'MOMO',
      }),
    ).toThrow(UnbalancedRuleError);
  });
});

describe('a stock adjustment — rules 7 and 7b', () => {
  it('a shortage expenses the loss and reduces stock', () => {
    const entry = stockAdjustmentEntry({
      movementId: 'm', businessDate: '2026-08-15', locationId: LOC_A,
      reasonCode: 'BREAKAGE', valueMinor: -12_000n,
    });
    expect(amountOn(entry.lines, 'STOCK_ADJ')).toBe(12_000n);
    expect(amountOn(entry.lines, 'INVENTORY')).toBe(-12_000n);
  });

  it('an overage reverses the sides', () => {
    const entry = stockAdjustmentEntry({
      movementId: 'm', businessDate: '2026-08-15', locationId: LOC_A,
      reasonCode: 'COUNT_UP', valueMinor: 4_000n,
    });
    expect(amountOn(entry.lines, 'INVENTORY')).toBe(4_000n);
    expect(amountOn(entry.lines, 'STOCK_ADJ')).toBe(-4_000n);
  });

  it('the REASON CODE never changes the rule — only the memo it carries', () => {
    // CLAUDE.md §2.9: the reason list is tenant data, and a rule that branched
    // on it would be tenant vocabulary deciding how money is recorded. The
    // account comes from the mapping, scoped by location or category.
    const a = stockAdjustmentEntry({
      movementId: 'm', businessDate: '2026-08-15', locationId: LOC_A,
      reasonCode: 'BREAKAGE', valueMinor: -1_000n,
    });
    const b = stockAdjustmentEntry({
      movementId: 'm', businessDate: '2026-08-15', locationId: LOC_A,
      reasonCode: 'A-TENANT-INVENTED-THIS-ONE', valueMinor: -1_000n,
    });
    expect(a.lines.map((l) => ({ role: l.role, dr: l.debitMinor, cr: l.creditMinor })))
      .toEqual(b.lines.map((l) => ({ role: l.role, dr: l.debitMinor, cr: l.creditMinor })));
  });

  it('a nil adjustment is refused — there is nothing to post', () => {
    expect(() =>
      stockAdjustmentEntry({
        movementId: 'm', businessDate: '2026-08-15', locationId: LOC_A,
        reasonCode: 'X', valueMinor: 0n,
      }),
    ).toThrow(UnbalancedRuleError);
  });
});

describe('a transfer — rules 6 and 6b', () => {
  it('touches NO income account at either end', () => {
    // The structural half of §5.6.3: moving stock between outlets cannot
    // inflate consolidated revenue, whatever a report does.
    const entry = transferEntry({
      transferId: 't', businessDate: '2026-08-15',
      fromLocationId: LOC_A, toLocationId: LOC_B, costMinor: 250_000n,
    });
    const roles = new Set(entry.lines.map((l) => l.role));
    expect(roles.has('SALES_REVENUE')).toBe(false);
    expect(roles.has('SALES_DISCOUNT')).toBe(false);
    expect(roles.has('SALES_RETURNS')).toBe(false);
    expect(roles.has('COGS')).toBe(false);
  });

  it('stock leaves one location and arrives in transit at the other, both balanced', () => {
    const entry = transferEntry({
      transferId: 't', businessDate: '2026-08-15',
      fromLocationId: LOC_A, toLocationId: LOC_B, costMinor: 250_000n,
    });
    expect(amountOn(entry.lines, 'INVENTORY', LOC_A)).toBe(-250_000n);
    expect(amountOn(entry.lines, 'INVENTORY_IN_TRANSIT', LOC_B)).toBe(250_000n);
    expect(totals(entry.lines, LOC_A).dr).toBe(totals(entry.lines, LOC_A).cr);
    expect(totals(entry.lines, LOC_B).dr).toBe(totals(entry.lines, LOC_B).cr);
    expect(clearingNets(entry.lines)).toBe(true);
  });

  it('a transfer to the same location is refused', () => {
    expect(() =>
      transferEntry({
        transferId: 't', businessDate: '2026-08-15',
        fromLocationId: LOC_A, toLocationId: LOC_A, costMinor: 1n,
      }),
    ).toThrow(UnbalancedRuleError);
  });
});

describe('the balance guard itself is not decorative', () => {
  it('refuses a line carrying both sides', () => {
    expect(() =>
      assertBalances('x', [
        { role: 'TILL_CASH', locationId: LOC_A, debitMinor: 5n, creditMinor: 5n },
        { role: 'SALES_REVENUE', locationId: LOC_A, debitMinor: 0n, creditMinor: 5n },
      ]),
    ).toThrow(/both sides/);
  });

  it('refuses a set that balances in TOTAL but not per location', () => {
    expect(() =>
      assertBalances('x', [
        { role: 'TILL_CASH', locationId: LOC_A, debitMinor: 100n, creditMinor: 0n },
        { role: 'SALES_REVENUE', locationId: LOC_B, debitMinor: 0n, creditMinor: 100n },
      ]),
    ).toThrow(/location .* Dr 100 \/ Cr 0/);
  });

  it('refuses a single-line entry', () => {
    expect(() =>
      assertBalances('x', [{ role: 'TILL_CASH', locationId: LOC_A, debitMinor: 1n, creditMinor: 0n }]),
    ).toThrow(/double entry needs at least two/);
  });
});
