/**
 * The Ghana jurisdiction pack seed (platform-level reference data;
 * ADR-0007, 07-jurisdiction §7.4).
 *
 * EVERY RATE HERE IS [UNCONFIRMED]: confirmed_by is NULL on every row, and
 * CLAUDE.md §2.8 blocks go-live until a qualified local professional
 * confirms each row a tenant will actually use (that confirmation writes
 * confirmed_by/confirmed_at — it is the gate, in the schema).
 *
 * Both regimes are seeded because a historical transaction reprices against
 * the row in force on its business date (ADR-0002):
 *   - pre-2026: VAT 15% computed on net PLUS NHIL + GETFund + COVID
 *     (base_kind 'net_plus'), levies at 2.5/2.5/1% on net;
 *   - from 2026-01-01 (VAT Act 2025, Act 1151): VAT 15%, NHIL 2.5%,
 *     GETFund 2.5%, all on the same net base; COVID levy repealed — its
 *     rate row CLOSES, it is never deleted (pre-2026 documents must stay
 *     auditable).
 */
import type { Queryable } from '../testing/harness.js';

export const GHANA = {
  jurisdictionCode: 'GH',
  name: 'Ghana',
  currencyCode: 'GHS',
  currencySymbol: 'GH₵',
  /** The divisor itself — pesewas to the cedi. A pack value, never assumed. */
  minorUnitsPerMajor: 100n,
} as const;

interface RateRow {
  taxCode: string;
  rateBp: number;
  baseKind: 'net' | 'net_plus';
  baseIncludes: string[];
  effectiveFrom: string;
  effectiveTo: string | null; // null = open-ended
  legalReference: string;
}

const TAX_CODES: { code: string; name: string; inputDeductible: boolean }[] = [
  { code: 'GH.VAT.STD', name: 'VAT — standard rate', inputDeductible: true },
  { code: 'GH.NHIL', name: 'National Health Insurance Levy', inputDeductible: true },
  { code: 'GH.GETFUND', name: 'GETFund Levy', inputDeductible: true },
  { code: 'GH.COVID', name: 'COVID-19 Health Recovery Levy', inputDeductible: false },
];

const RATES: RateRow[] = [
  // ---- prior regime (to 2025-12-31) — [UNCONFIRMED] -----------------------
  {
    taxCode: 'GH.VAT.STD',
    rateBp: 1500,
    baseKind: 'net_plus',
    baseIncludes: ['GH.NHIL', 'GH.GETFUND', 'GH.COVID'],
    effectiveFrom: '2019-01-01',
    effectiveTo: '2026-01-01',
    legalReference: 'Value Added Tax Act, 2013 (Act 870), as amended [UNCONFIRMED]',
  },
  {
    taxCode: 'GH.NHIL',
    rateBp: 250,
    baseKind: 'net',
    baseIncludes: [],
    effectiveFrom: '2019-01-01',
    effectiveTo: '2026-01-01',
    legalReference: 'National Health Insurance Act, 2012 (Act 852) [UNCONFIRMED]',
  },
  {
    taxCode: 'GH.GETFUND',
    rateBp: 250,
    baseKind: 'net',
    baseIncludes: [],
    effectiveFrom: '2019-01-01',
    effectiveTo: '2026-01-01',
    legalReference: 'Ghana Education Trust Fund Act, 2000 (Act 581), as amended [UNCONFIRMED]',
  },
  {
    taxCode: 'GH.COVID',
    rateBp: 100,
    baseKind: 'net',
    baseIncludes: [],
    effectiveFrom: '2021-05-01',
    effectiveTo: '2026-01-01', // reported repealed; range CLOSES, row survives
    legalReference: 'COVID-19 Health Recovery Levy Act, 2021 (Act 1068) [UNCONFIRMED]',
  },
  // ---- current regime (from 2026-01-01) — [UNCONFIRMED] -------------------
  {
    taxCode: 'GH.VAT.STD',
    rateBp: 1500,
    baseKind: 'net',
    baseIncludes: [],
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    legalReference: 'Value Added Tax Act, 2025 (Act 1151) [UNCONFIRMED]',
  },
  {
    taxCode: 'GH.NHIL',
    rateBp: 250,
    baseKind: 'net',
    baseIncludes: [],
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    legalReference: 'Value Added Tax Act, 2025 (Act 1151) [UNCONFIRMED]',
  },
  {
    taxCode: 'GH.GETFUND',
    rateBp: 250,
    baseKind: 'net',
    baseIncludes: [],
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    legalReference: 'Value Added Tax Act, 2025 (Act 1151) [UNCONFIRMED]',
  },
];

/**
 * Seed the Ghana jurisdiction, its tax codes and both rate regimes.
 * Platform-level (admin path); idempotent via ON CONFLICT DO NOTHING /
 * a natural-key guard on tax_rate.
 */
export async function seedGhanaJurisdiction(tx: Queryable): Promise<void> {
  await tx.query(
    `insert into platform.jurisdiction
       (code, name, currency_code, currency_symbol, minor_units_per_major)
     values ($1, $2, $3, $4, $5)
     on conflict (code) do nothing`,
    [GHANA.jurisdictionCode, GHANA.name, GHANA.currencyCode, GHANA.currencySymbol, String(GHANA.minorUnitsPerMajor)],
  );

  for (const c of TAX_CODES) {
    await tx.query(
      `insert into platform.tax_code (jurisdiction_code, code, name, input_deductible)
       values ($1, $2, $3, $4)
       on conflict (jurisdiction_code, code) do nothing`,
      [GHANA.jurisdictionCode, c.code, c.name, c.inputDeductible],
    );
  }

  for (const r of RATES) {
    const effective =
      r.effectiveTo === null ? `[${r.effectiveFrom},)` : `[${r.effectiveFrom},${r.effectiveTo})`;
    // Natural-key guard rather than ON CONFLICT: the no-overlap invariant is
    // held by the constraint trigger, which is not a conflict target.
    await tx.query(
      `insert into platform.tax_rate
         (jurisdiction_code, tax_code, rate_bp, base_kind, base_includes,
          rounding_level, rounding_mode, effective, legal_reference, confirmed_by, confirmed_at)
       select $1, $2, $3, $4,
              case when $5 = '' then '{}'::text[] else string_to_array($5, ',') end,
              'line', 'half_up', $6::daterange, $7, null, null
       where not exists (
         select 1 from platform.tax_rate t
         where t.jurisdiction_code = $1 and t.tax_code = $2 and t.effective = $6::daterange
       )`,
      [
        GHANA.jurisdictionCode,
        r.taxCode,
        r.rateBp,
        r.baseKind,
        r.baseIncludes.join(','),
        effective,
        r.legalReference,
      ],
    );
  }
}
