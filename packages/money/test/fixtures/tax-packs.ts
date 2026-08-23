/**
 * Component sets shaped exactly like §7.2.4 `pack_tax_rate` rows, used by the
 * tax composition and extraction tests.
 *
 * ── EVERY GHANA FIGURE BELOW IS `[UNCONFIRMED]` ──────────────────────────────
 * §7.4.1 and §7.4.2 mark every rate, base composition and commencement date in
 * the Ghana pack `[UNCONFIRMED]` — the architecture author's reading of public
 * sources on 20 August 2026, pending a qualified local professional's review
 * (CLAUDE.md §2.8). These fixtures carry the marker forward verbatim. What the
 * tests actually pin is the ARITHMETIC over a declared composition; if the
 * reviewing accountant changes a rate or a base, the fixture changes and the
 * arithmetic assertions still hold. Nothing here is a claim about Ghanaian law.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { TaxComponent } from '../../src/index.js';

/**
 * §7.4.1 — the regime effective 1 January 2026 `[UNCONFIRMED]`: NHIL 2.5%,
 * GETFund 2.5% and VAT 15% ALL on the same net base ⇒ effective 20% `[UNCONFIRMED]`.
 */
export const GH_2026: readonly TaxComponent[] = [
  { code: 'GH.NHIL', rateBp: 250n, baseKind: 'net', baseIncludes: [], roundingLevel: 'line', roundingMode: 'half-up' },
  { code: 'GH.GETFUND', rateBp: 250n, baseKind: 'net', baseIncludes: [], roundingLevel: 'line', roundingMode: 'half-up' },
  { code: 'GH.VAT.STD', rateBp: 1500n, baseKind: 'net', baseIncludes: [], roundingLevel: 'line', roundingMode: 'half-up' },
];

/**
 * §7.4.2 — the prior regime, to 31 December 2025 `[UNCONFIRMED]`: the same three
 * rates plus COVID 1%, with VAT on a base that ALREADY INCLUDES the levies ⇒
 * effective 21.9% `[UNCONFIRMED]`. No rate differs from {@link GH_2026}; only
 * the base composition does. That is the dated proof that composition is pack
 * data (§7.2.4), and the reason extraction must invert a declaration rather
 * than divide by a constant.
 */
export const GH_PRE_2026: readonly TaxComponent[] = [
  { code: 'GH.NHIL', rateBp: 250n, baseKind: 'net', baseIncludes: [], roundingLevel: 'line', roundingMode: 'half-up' },
  { code: 'GH.GETFUND', rateBp: 250n, baseKind: 'net', baseIncludes: [], roundingLevel: 'line', roundingMode: 'half-up' },
  { code: 'GH.COVID', rateBp: 100n, baseKind: 'net', baseIncludes: [], roundingLevel: 'line', roundingMode: 'half-up' },
  {
    code: 'GH.VAT.STD',
    rateBp: 1500n,
    baseKind: 'net_plus',
    baseIncludes: ['GH.NHIL', 'GH.GETFUND', 'GH.COVID'],
    roundingLevel: 'line',
    roundingMode: 'half-up',
  },
];

/** A single-component set — the §7.6 "second pack" shape (one component,
 * `base_kind = 'net'`, `rounding_mode = 'half_even'`). Not Ghana, no glyph. */
export const SINGLE_HALF_EVEN: readonly TaxComponent[] = [
  { code: 'STD', rateBp: 1750n, baseKind: 'net', baseIncludes: [], roundingLevel: 'line', roundingMode: 'half-even' },
];

/** A zero-rate component alongside a standard one: proves a zero-rated line
 * prints exactly 0 even when a residual has to land somewhere. */
export const WITH_ZERO_RATE: readonly TaxComponent[] = [
  { code: 'ZERO', rateBp: 0n, baseKind: 'net', baseIncludes: [], roundingLevel: 'line', roundingMode: 'half-up' },
  { code: 'STD', rateBp: 1500n, baseKind: 'net', baseIncludes: [], roundingLevel: 'line', roundingMode: 'half-up' },
];

/** Two-deep cascade: C on net+A, D on net+C — exercises a multiplier that is
 * not a whole basis point (3.33% on a base including 3.33% is 3.440889%). */
export const DEEP_CASCADE: readonly TaxComponent[] = [
  { code: 'A', rateBp: 333n, baseKind: 'net', baseIncludes: [], roundingLevel: 'line', roundingMode: 'half-even' },
  { code: 'C', rateBp: 333n, baseKind: 'net_plus', baseIncludes: ['A'], roundingLevel: 'line', roundingMode: 'half-up' },
  { code: 'D', rateBp: 900n, baseKind: 'net_plus', baseIncludes: ['C'], roundingLevel: 'line', roundingMode: 'down' },
];

export const sumTax = (taxes: readonly { readonly taxMinor: bigint }[]): bigint =>
  taxes.reduce((a, t) => a + t.taxMinor, 0n);

export const byCode = (
  taxes: readonly { readonly code: string; readonly taxMinor: bigint }[],
  code: string,
): bigint => {
  const line = taxes.find((t) => t.code === code);
  if (!line) throw new Error(`no tax line ${code}`);
  return line.taxMinor;
};
