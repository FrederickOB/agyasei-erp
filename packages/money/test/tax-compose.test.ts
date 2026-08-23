/**
 * The forward (tax-EXCLUSIVE) path, §4.13 row 5, and the component-set
 * validation both directions share. The composition rules were previously
 * re-implemented in a test helper and again in the API server; they live in
 * `@erp/money` now so the two directions cannot drift apart.
 */
import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  assertTaxComponents,
  composeTaxFromNet,
  extractTaxFromGross,
  taxRoundingLevel,
  type TaxComponent,
} from '../src/index.js';
import { DEEP_CASCADE, GH_2026, GH_PRE_2026, byCode } from './fixtures/tax-packs.js';

const one = (over: Partial<TaxComponent> = {}): TaxComponent[] => [
  { code: 'A', rateBp: 1500n, baseKind: 'net', baseIncludes: [], roundingLevel: 'line', roundingMode: 'half-up', ...over },
];

describe('composeTaxFromNet — §4.13 row 5', () => {
  it('flat composition: each component on the bare net', () => {
    const r = composeTaxFromNet(10_000n, GH_2026);
    expect(r.taxes.map((t) => t.taxMinor)).toEqual([250n, 250n, 1_500n]);
    expect(r.taxes.every((t) => t.baseMinor === 10_000n)).toBe(true);
    expect(r.grossMinor).toBe(12_000n);
  });

  it('cascade: the later component sees a base that already includes the earlier ones', () => {
    const r = composeTaxFromNet(10_000n, GH_PRE_2026);
    expect(byCode(r.taxes, 'GH.VAT.STD')).toBe(1_590n);
    expect(r.taxes.find((t) => t.code === 'GH.VAT.STD')?.baseMinor).toBe(10_600n);
    expect(r.grossMinor).toBe(12_190n);
  });

  it('every component rounds ONCE, at its own declared mode', () => {
    // 999 x 250bp = 24.975 -> half-up 25; x 100bp = 9.99 -> 10.
    // VAT base 999 + 25 + 25 + 10 = 1059; x 1500bp = 158.85 -> 159.
    const r = composeTaxFromNet(999n, GH_PRE_2026);
    expect(r.taxes.map((t) => t.taxMinor)).toEqual([25n, 25n, 10n, 159n]);
    expect(r.taxTotalMinor).toBe(219n);
  });

  it('a base_includes member absent from the set contributes nothing — the pack governs', () => {
    // The dated case: GH.COVID sits in VAT's base_includes and has no rate row
    // in force after repeal. The lookup returns three rows; VAT must compute on
    // net + NHIL + GETFund, not fail and not invent a COVID amount.
    const repealed: TaxComponent[] = GH_PRE_2026.filter((c) => c.code !== 'GH.COVID');
    const r = composeTaxFromNet(10_000n, repealed);
    expect(r.taxes.find((t) => t.code === 'GH.VAT.STD')?.baseMinor).toBe(10_500n);
    expect(byCode(r.taxes, 'GH.VAT.STD')).toBe(1_575n);
    expect(r.grossMinor).toBe(12_075n);
  });

  it('forward lines never carry a residual — only de-grossing can place one', () => {
    const r = composeTaxFromNet(7n, DEEP_CASCADE);
    expect(r.taxes.every((t) => t.residualMinor === 0n)).toBe(true);
    expect(r.taxes.every((t) => t.taxMinor === t.computedMinor)).toBe(true);
  });

  it('is sign-symmetric: a full credit note nets to zero per component', () => {
    const sale = composeTaxFromNet(4_567n, GH_PRE_2026);
    const credit = composeTaxFromNet(-4_567n, GH_PRE_2026);
    sale.taxes.forEach((t, i) => expect(t.taxMinor + credit.taxes[i]!.taxMinor).toBe(0n));
    expect(sale.grossMinor + credit.grossMinor).toBe(0n);
  });

  it('rejects a number for the net — money never passes through float64', () => {
    expect(() => composeTaxFromNet(100 as unknown as bigint, GH_2026)).toThrow(MoneyError);
  });
});

describe('assertTaxComponents — a pack that cannot price fails closed', () => {
  it('refuses an EMPTY component set: an untaxed supply is a zero-RATE component', () => {
    expect(() => assertTaxComponents([])).toThrow(/at least one component/);
  });

  it('refuses a duplicate component code', () => {
    expect(() => assertTaxComponents([...one(), ...one()])).toThrow(/duplicate component code/);
  });

  it('refuses a negative rate — the gross-up would have no unique inverse', () => {
    expect(() => assertTaxComponents(one({ rateBp: -1n }))).toThrow(/must be ≥ 0/);
  });

  it('refuses a number rate — rate_bp is a bigint like every other magnitude', () => {
    expect(() => assertTaxComponents(one({ rateBp: 1500 as unknown as bigint }))).toThrow(MoneyError);
  });

  it("refuses base_includes on a 'net' component instead of silently discarding it", () => {
    expect(() => assertTaxComponents(one({ baseIncludes: ['B'] }))).toThrow(/cannot declare base_includes/);
  });

  it('refuses a component that includes ITSELF (a cycle)', () => {
    expect(() => assertTaxComponents(one({ baseKind: 'net_plus', baseIncludes: ['A'] }))).toThrow(/a cycle/);
  });

  it('refuses a forward reference — evaluation order would be undefined', () => {
    const misordered: TaxComponent[] = [
      { code: 'A', rateBp: 1500n, baseKind: 'net_plus', baseIncludes: ['B'], roundingLevel: 'line', roundingMode: 'half-up' },
      { code: 'B', rateBp: 250n, baseKind: 'net', baseIncludes: [], roundingLevel: 'line', roundingMode: 'half-up' },
    ];
    expect(() => assertTaxComponents(misordered)).toThrow(/orders AFTER it/);
  });

  it('refuses an unknown rounding mode and an unknown base_kind and rounding_level', () => {
    expect(() => assertTaxComponents(one({ roundingMode: 'nearest' as never }))).toThrow(/rounding_mode/);
    expect(() => assertTaxComponents(one({ baseKind: 'gross' as never }))).toThrow(/base_kind/);
    expect(() => assertTaxComponents(one({ roundingLevel: 'sale' as never }))).toThrow(/rounding_level/);
  });

  it('refuses an empty or non-string code', () => {
    expect(() => assertTaxComponents(one({ code: '' }))).toThrow(/non-empty string/);
  });
});

describe('taxRoundingLevel — the pack chooses the CALL SITE, not the arithmetic', () => {
  it("reports the set's uniform level", () => {
    expect(taxRoundingLevel(GH_2026)).toBe('line');
    expect(taxRoundingLevel(one({ roundingLevel: 'document' }))).toBe('document');
  });

  it('refuses a mixed set at EVERY entry point — there is no single call site for it', () => {
    const mixed: TaxComponent[] = [
      ...one(),
      { code: 'B', rateBp: 250n, baseKind: 'net', baseIncludes: [], roundingLevel: 'document', roundingMode: 'half-up' },
    ];
    expect(() => taxRoundingLevel(mixed)).toThrow(/not uniform/);
    expect(() => assertTaxComponents(mixed)).toThrow(/not uniform/);
    expect(() => composeTaxFromNet(1_000n, mixed)).toThrow(/not uniform/);
    expect(() => extractTaxFromGross(1_000n, mixed, 'half-even')).toThrow(/not uniform/);
  });

  it("computes identically at either level — 'document' is where you call it from", () => {
    const asDocument = GH_2026.map((c) => ({ ...c, roundingLevel: 'document' as const }));
    expect(composeTaxFromNet(999n, asDocument).taxes.map((t) => t.taxMinor)).toEqual(
      composeTaxFromNet(999n, GH_2026).taxes.map((t) => t.taxMinor),
    );
  });
});
