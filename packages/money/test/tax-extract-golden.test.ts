/**
 * Golden worked examples for de-grossing a tax-INCLUSIVE price (§4.13 row 6),
 * against BOTH Ghana compositions — the 2026 flat regime and the prior cascade.
 * Every figure below was computed by hand and is written out in the test so a
 * reviewing accountant can follow it without running anything.
 *
 * ── STATUS OF THE GHANA FIGURES ─────────────────────────────────────────────
 * Every rate, base composition and commencement date used here is `[UNCONFIRMED]`
 * exactly as §7.4.1/§7.4.2 mark them, and is carried in `fixtures/tax-packs.ts`
 * with that marker. These tests pin the ARITHMETIC over a declared composition,
 * not the law. If the reviewing professional (CLAUDE.md §2.8) corrects a rate,
 * the fixture changes and every assertion here still has to hold.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from 'vitest';
import { composeTaxFromNet, effectiveTaxFraction, extractTaxFromGross } from '../src/index.js';
import { GH_2026, GH_PRE_2026, byCode, sumTax } from './fixtures/tax-packs.js';

describe('golden: the effective gross-up is DERIVED from the set, never a constant', () => {
  it('2026 flat composition ⇒ 2000 bp of net [UNCONFIRMED]', () => {
    const f = effectiveTaxFraction(GH_2026);
    expect((f.numerator * 10_000n) / f.denominator).toBe(2_000n); // 20.00%
  });

  it('prior cascade ⇒ 2190 bp of net [UNCONFIRMED] — with no rate differing', () => {
    const f = effectiveTaxFraction(GH_PRE_2026);
    expect((f.numerator * 10_000n) / f.denominator).toBe(2_190n); // 21.90%
    // The §7.2.4 proof, restated from the extraction side: the two sets share
    // every rate they have in common; only base composition differs.
    for (const code of ['GH.NHIL', 'GH.GETFUND', 'GH.VAT.STD']) {
      expect(GH_2026.find((c) => c.code === code)?.rateBp).toBe(
        GH_PRE_2026.find((c) => c.code === code)?.rateBp,
      );
    }
  });
});

describe('golden: Ghana 2026 flat regime, de-grossed', () => {
  it('a GH₵120.00 inclusive price is exactly the GH₵100.00 net receipt, inverted', () => {
    const r = extractTaxFromGross(12_000n, GH_2026, 'half-even');
    expect(r.netMinor).toBe(10_000n);
    expect(byCode(r.taxes, 'GH.NHIL')).toBe(250n);
    expect(byCode(r.taxes, 'GH.GETFUND')).toBe(250n);
    expect(byCode(r.taxes, 'GH.VAT.STD')).toBe(1_500n);
    expect(r.taxTotalMinor).toBe(2_000n);
    expect(r.netMinor + sumTax(r.taxes)).toBe(12_000n);
    expect(r.roundTrips).toBe(true);
  });

  it('a GH₵100.00 SHELF price: net 83.34, NHIL 2.08, GETFund 2.08, VAT 12.50', () => {
    // By hand: 8334 x 250bp = 208.35 -> half-up 208 (twice).
    //          8334 x 1500bp = 1250.10 -> 1250.  208+208+1250 = 1666.
    //          8334 + 1666 = 10000, exactly the shelf price.
    const r = extractTaxFromGross(10_000n, GH_2026, 'half-even');
    expect(r.netMinor).toBe(8_334n);
    expect(byCode(r.taxes, 'GH.NHIL')).toBe(208n);
    expect(byCode(r.taxes, 'GH.GETFUND')).toBe(208n);
    expect(byCode(r.taxes, 'GH.VAT.STD')).toBe(1_250n);
    expect(r.taxTotalMinor).toBe(1_666n);
    expect(r.netMinor + sumTax(r.taxes)).toBe(10_000n);
  });

  it('§4.13 row 6 ALONE would have answered 83.33 — one pesewa of tax out of place', () => {
    // The row-6 candidate is ROUND(10000 x 1/1.2) = ROUND(8333.33) = 8333, and
    // 8333 does NOT reproduce the shelf price forward: it grosses to 9999. The
    // residual rule would then have shifted a pesewa onto VAT and produced a
    // receipt that priced differently from the same sale rung tax-exclusive.
    const wrong = composeTaxFromNet(8_333n, GH_2026);
    expect(wrong.grossMinor).toBe(9_999n);
    // The exact inverse exists one pesewa up, and that is what is returned.
    expect(composeTaxFromNet(8_334n, GH_2026).grossMinor).toBe(10_000n);
  });

  it('a three-item inclusive basket foots to the printed shelf prices, per line', () => {
    // §4.13 row 5: each line rounds once; the document total is the SUM of the
    // rounded line amounts, never a recompute against the document gross.
    const shelf = [10_000n, 4_550n, 999n]; // GH₵100.00, GH₵45.50, GH₵9.99
    const lines = shelf.map((g) => extractTaxFromGross(g, GH_2026, 'half-even'));
    expect(lines.map((l) => l.netMinor)).toEqual([8_334n, 3_791n, 832n]);
    expect(lines.map((l) => l.taxTotalMinor)).toEqual([1_666n, 759n, 167n]);
    expect(lines.every((l) => l.roundTrips)).toBe(true);

    const netTotal = lines.reduce((a, l) => a + l.netMinor, 0n);
    const taxTotal = lines.reduce((a, l) => a + l.taxTotalMinor, 0n);
    expect(netTotal).toBe(12_957n);
    expect(taxTotal).toBe(2_592n);
    expect(netTotal + taxTotal).toBe(shelf.reduce((a, b) => a + b, 0n)); // 15,549
  });
});

describe('golden: Ghana prior cascade, de-grossed', () => {
  it('a GH₵121.90 inclusive price inverts to the GH₵100.00 cascade receipt', () => {
    const r = extractTaxFromGross(12_190n, GH_PRE_2026, 'half-even');
    expect(r.netMinor).toBe(10_000n);
    expect(byCode(r.taxes, 'GH.NHIL')).toBe(250n);
    expect(byCode(r.taxes, 'GH.GETFUND')).toBe(250n);
    expect(byCode(r.taxes, 'GH.COVID')).toBe(100n);
    expect(byCode(r.taxes, 'GH.VAT.STD')).toBe(1_590n); // base 10600 x 1500bp
    expect(r.taxTotalMinor).toBe(2_190n);
    expect(r.roundTrips).toBe(true);
  });

  it('a GH₵100.00 SHELF price: net 82.04, levies 2.05/2.05/0.82, VAT 13.04', () => {
    // By hand: 8204 x 250bp = 205.10 -> 205 (twice); x 100bp = 82.04 -> 82.
    //          VAT base = 8204 + 205 + 205 + 82 = 8696; x 1500bp = 1304.40 -> 1304.
    //          205 + 205 + 82 + 1304 = 1796;  8204 + 1796 = 10000.
    const r = extractTaxFromGross(10_000n, GH_PRE_2026, 'half-even');
    expect(r.netMinor).toBe(8_204n);
    expect(byCode(r.taxes, 'GH.NHIL')).toBe(205n);
    expect(byCode(r.taxes, 'GH.GETFUND')).toBe(205n);
    expect(byCode(r.taxes, 'GH.COVID')).toBe(82n);
    const vat = r.taxes.find((t) => t.code === 'GH.VAT.STD');
    expect(vat?.baseMinor).toBe(8_696n);
    expect(vat?.taxMinor).toBe(1_304n);
    expect(r.netMinor + sumTax(r.taxes)).toBe(10_000n);
  });

  it('THE DATED TEST: one shelf price, two regimes, GH₵1.30 of net between them', () => {
    // The §7.8 dated golden, inverted. A pack that flattened the cascade — or a
    // de-grossing that divided by one rate — would return the same net twice.
    const cascade = extractTaxFromGross(10_000n, GH_PRE_2026, 'half-even');
    const flat = extractTaxFromGross(10_000n, GH_2026, 'half-even');
    expect(cascade.netMinor).toBe(8_204n);
    expect(flat.netMinor).toBe(8_334n);
    expect(flat.netMinor - cascade.netMinor).toBe(130n);
    expect(cascade.netMinor + cascade.taxTotalMinor).toBe(10_000n);
    expect(flat.netMinor + flat.taxTotalMinor).toBe(10_000n);
  });
});

describe('golden: a shelf price the forward path can never produce', () => {
  it('4 pesewas at 20%: no net grosses to 4, so the residual lands on VAT', () => {
    // f(3) = 3 (every component rounds to zero); f(4) = 5 (VAT 0.60 -> 1).
    // 4 is skipped. Candidate net = ROUND(4 / 1.2) = ROUND(3.33) = 3, residual 1.
    // Claim weights are base x rate: 750, 750, 4500 — VAT's is largest.
    expect(composeTaxFromNet(3n, GH_2026).grossMinor).toBe(3n);
    expect(composeTaxFromNet(4n, GH_2026).grossMinor).toBe(5n);

    const r = extractTaxFromGross(4n, GH_2026, 'half-even');
    expect(r.roundTrips).toBe(false);
    expect(r.residualMinor).toBe(1n);
    expect(r.netMinor).toBe(3n);
    const vat = r.taxes.find((t) => t.code === 'GH.VAT.STD');
    expect(vat?.computedMinor).toBe(0n); // ROUND(3 x 1500bp) = ROUND(0.45) = 0
    expect(vat?.residualMinor).toBe(1n); // the placed pesewa, reported separately
    expect(vat?.taxMinor).toBe(1n);
    expect(byCode(r.taxes, 'GH.NHIL')).toBe(0n);
    expect(byCode(r.taxes, 'GH.GETFUND')).toBe(0n);
    expect(r.netMinor + sumTax(r.taxes)).toBe(4n);
  });
});
