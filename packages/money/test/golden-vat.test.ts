/**
 * Golden worked examples from the architecture document:
 * §4.6 / §7.2.4 tax computation (base_kind 'net' and the 'net_plus' cascade),
 * and §4.13 row 3 (extended line amount) / row 5 (per-line, per-component
 * rounding — the document total is the SUM of rounded line amounts, never a
 * recomputation from the document net).
 *
 * The component orchestration lives in the TEST, driven by rows shaped like
 * `tax_rate` — the module supplies only the arithmetic (mulBps). That is the
 * ADR-0002/ADR-0007 boundary: rates and base composition are pack DATA.
 *
 * Q8 note: these tests stop at tax AMOUNTS. Invoice issuance / e-VAT clearance
 * is deliberately absent pending Q8 — see the seam comment in src/index.ts.
 */
import { describe, expect, it } from 'vitest';
import { lineNetMinor, mulBps, type RoundingMode } from '../src/index.js';

/** Mirrors §7.2.4 pack_tax_rate: code, rate_bp, base_kind, base_includes, rounding_mode. */
interface TaxComponentRow {
  readonly code: string;
  readonly rateBp: bigint;
  readonly baseKind: 'net' | 'net_plus';
  readonly baseIncludes: readonly string[];
  readonly roundingMode: RoundingMode;
}

/** §4.13 row 5, verbatim: for each component c in the pack's declared order,
 * base_c = net + sum(tax_j for j in base_includes_c); tax_c = ROUND(base_c * rate_bp / 10000)
 * at the component's mode, rounded once per (line, component). */
function computeLineTaxes(netMinor: bigint, rows: readonly TaxComponentRow[]): Map<string, bigint> {
  const amounts = new Map<string, bigint>();
  for (const row of rows) {
    let base = netMinor;
    if (row.baseKind === 'net_plus') {
      for (const included of row.baseIncludes) {
        const prior = amounts.get(included);
        if (prior === undefined) {
          throw new Error(`pack order error: ${row.code} includes ${included} before it is computed`);
        }
        base += prior;
      }
    }
    amounts.set(row.code, mulBps(base, row.rateBp, row.roundingMode));
  }
  return amounts;
}

const sumOf = (m: Map<string, bigint>): bigint => [...m.values()].reduce((a, b) => a + b, 0n);

// ── §7.2.6: the Ghana pack from 1 Jan 2026 — all three on the SAME net base ──
const GHANA_2026: readonly TaxComponentRow[] = [
  { code: 'GH.NHIL', rateBp: 250n, baseKind: 'net', baseIncludes: [], roundingMode: 'half-up' },
  { code: 'GH.GETFUND', rateBp: 250n, baseKind: 'net', baseIncludes: [], roundingMode: 'half-up' },
  { code: 'GH.VAT.STD', rateBp: 1500n, baseKind: 'net', baseIncludes: [], roundingMode: 'half-up' },
];

// ── §7.2.4/§7.2.6: until 31 Dec 2025 — VAT on a base that already includes the levies ──
const GHANA_PRE_2026: readonly TaxComponentRow[] = [
  { code: 'GH.NHIL', rateBp: 250n, baseKind: 'net', baseIncludes: [], roundingMode: 'half-up' },
  { code: 'GH.GETFUND', rateBp: 250n, baseKind: 'net', baseIncludes: [], roundingMode: 'half-up' },
  { code: 'GH.COVID', rateBp: 100n, baseKind: 'net', baseIncludes: [], roundingMode: 'half-up' },
  {
    code: 'GH.VAT.STD',
    rateBp: 1500n,
    baseKind: 'net_plus',
    baseIncludes: ['GH.NHIL', 'GH.GETFUND', 'GH.COVID'],
    roundingMode: 'half-up',
  },
];

describe('golden: Ghana VAT, net base (2026 regime — 15 + 2.5 + 2.5 = 20%)', () => {
  it('GH₵100.00 net: NHIL 2.50, GETFund 2.50, VAT 15.00 — total tax GH₵20.00', () => {
    const taxes = computeLineTaxes(10_000n, GHANA_2026);
    expect(taxes.get('GH.NHIL')).toBe(250n);
    expect(taxes.get('GH.GETFUND')).toBe(250n);
    expect(taxes.get('GH.VAT.STD')).toBe(1_500n);
    expect(sumOf(taxes)).toBe(2_000n); // exactly 20% on this even base
  });
});

describe('golden: Ghana VAT, cascade base (pre-2026 — the effective 21.9% of §7.2.4)', () => {
  it('GH₵100.00 net: VAT base is 100 + 2.50 + 2.50 + 1.00 = 106.00, so VAT is 15.90', () => {
    const taxes = computeLineTaxes(10_000n, GHANA_PRE_2026);
    expect(taxes.get('GH.NHIL')).toBe(250n);
    expect(taxes.get('GH.GETFUND')).toBe(250n);
    expect(taxes.get('GH.COVID')).toBe(100n);
    expect(taxes.get('GH.VAT.STD')).toBe(1_590n); // 10600 x 1500bp
    expect(sumOf(taxes)).toBe(2_190n); // the documented effective 21.9%
  });

  it('no rate differs between the two regimes — only base composition (the §7.2.4 proof)', () => {
    const rate = (rows: readonly TaxComponentRow[], code: string): bigint | undefined =>
      rows.find((r) => r.code === code)?.rateBp;
    for (const code of ['GH.NHIL', 'GH.GETFUND', 'GH.VAT.STD']) {
      expect(rate(GHANA_2026, code)).toBe(rate(GHANA_PRE_2026, code));
    }
  });

  it('GH₵9.99 net exercises every component rounding: 25, 25, 10, then VAT 159', () => {
    // NHIL/GETFund: 999 x 250bp = 24.975 -> 25. COVID: 9.99 -> 10.
    // VAT base: 999 + 25 + 25 + 10 = 1059; 1059 x 1500bp = 158.85 -> 159.
    const taxes = computeLineTaxes(999n, GHANA_PRE_2026);
    expect(taxes.get('GH.NHIL')).toBe(25n);
    expect(taxes.get('GH.GETFUND')).toBe(25n);
    expect(taxes.get('GH.COVID')).toBe(10n);
    expect(taxes.get('GH.VAT.STD')).toBe(159n);
    expect(sumOf(taxes)).toBe(219n);
  });

  it('declaring an include the pack has not yet computed is an error, never a silent zero', () => {
    const misordered: readonly TaxComponentRow[] = [
      {
        code: 'GH.VAT.STD',
        rateBp: 1500n,
        baseKind: 'net_plus',
        baseIncludes: ['GH.NHIL'],
        roundingMode: 'half-up',
      },
    ];
    expect(() => computeLineTaxes(10_000n, misordered)).toThrow(/pack order/);
  });
});

describe('golden: §4.13 row 5 — document tax is the sum of rounded line amounts', () => {
  it('three lines at 2026 rates: per-line rounding makes 901, not the 900 a document-net recomputation would give', () => {
    const nets = [999n, 1001n, 2500n]; // doc net 4500
    const perLine = nets.map((net) => sumOf(computeLineTaxes(net, GHANA_2026)));
    expect(perLine).toEqual([200n, 200n, 501n]); // 2500: NHIL 62.5->63, GETFund 63, VAT 375
    const documentTax = perLine.reduce((a, b) => a + b, 0n);
    expect(documentTax).toBe(901n);
    // The forbidden shortcut — 20% straight off the document net — loses a pesewa:
    expect(mulBps(4_500n, 2_000n, 'half-up')).toBe(900n);
  });
});

describe('golden: §4.13 row 3 — extended line amounts, rounded once on the extension', () => {
  it('binding wire: 2.500 kg (scale 3) x GH₵25.00/kg -> GH₵62.50', () => {
    // unit_price_e4 = 2500 pesewas x 10^4 = 25,000,000
    expect(lineNetMinor(2_500n, 3, 25_000_000n, 'half-up')).toBe(6_250n);
  });

  it('0.333 kg x GH₵25.00/kg = 832.5 pesewas -> half-up 833', () => {
    expect(lineNetMinor(333n, 3, 25_000_000n, 'half-up')).toBe(833n);
    expect(lineNetMinor(333n, 3, 25_000_000n, 'half-even')).toBe(832n); // tie: even side
  });

  it('400-tonne cement order: the 10^14 intermediate §4.13 warns about stays exact', () => {
    // 400.000 t (scale 3) x GH₵2,000.00/t (unit_price_e4 = 2,000,000,000)
    // intermediate 400000 x 2e9 = 8e14; line net = GH₵800,000.00 exactly.
    expect(lineNetMinor(400_000n, 3, 2_000_000_000n, 'half-up')).toBe(80_000_000n);
  });

  it('adversarial magnitudes beyond float64 precision remain exact', () => {
    const qty = 999_999_999n; // 999,999.999 at scale 3
    const priceE4 = 999_999_999_999n; // ~GH₵100k per unit, e4
    const expected = (qty * priceE4 + 5_000_000n) / 10_000_000n; // half-up by hand, positive operands
    expect(lineNetMinor(qty, 3, priceE4, 'half-up')).toBe(expected);
    // float64 cannot even represent the 10^21 intermediate, let alone round it correctly:
    expect(BigInt(Number(qty * priceE4))).not.toBe(qty * priceE4);
  });
});
