/**
 * Effective-dated tax rates (ADR-0002 / ADR-0007; 07-jurisdiction §7.2):
 * a historical transaction ALWAYS reprices against the rate row in force on
 * its business date, resolved with `effective @> date`.
 *
 * The Ghana seed carries BOTH regimes precisely so this is testable:
 * pre-2026 VAT is 15% on net PLUS the levies (base_kind 'net_plus');
 * from 2026-01-01 all components apply to the same net base.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from '../src/testing/harness.js';
import { setupDb } from './util.js';

let db: TestDb;

beforeAll(async () => {
  db = await setupDb(); // seeds the Ghana jurisdiction pack
});
afterAll(async () => {
  await db.close();
});

interface RateRow {
  rate_bp: number;
  base_kind: string;
  base_includes: string[];
  confirmed_by: string | null;
}

function rateOn(taxCode: string, businessDate: string) {
  return db.query<RateRow>(
    `select rate_bp, base_kind, base_includes, confirmed_by
     from platform.tax_rate
     where jurisdiction_code = 'GH' and tax_code = $1 and effective @> $2::date`,
    [taxCode, businessDate],
  );
}

describe('effective-dated tax rates reprice by business date', () => {
  it('a 2025 business date resolves the PRIOR regime: VAT 15% on net_plus {NHIL, GETFund, COVID}', async () => {
    const res = await rateOn('GH.VAT.STD', '2025-06-15');
    expect(res.rows).toHaveLength(1); // exactly one row in force — never ambiguous
    const row = res.rows[0]!;
    expect(row.rate_bp).toBe(1500);
    expect(row.base_kind).toBe('net_plus');
    expect([...row.base_includes].sort()).toEqual(['GH.COVID', 'GH.GETFUND', 'GH.NHIL']);
  });

  it('a 2026 business date resolves the CURRENT regime: VAT 15% on net', async () => {
    const res = await rateOn('GH.VAT.STD', '2026-03-01');
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0]!;
    expect(row.rate_bp).toBe(1500);
    expect(row.base_kind).toBe('net');
    expect(row.base_includes).toEqual([]);
  });

  it('the repealed COVID levy applies to 2025 dates and NOT to 2026 dates — closed, never deleted', async () => {
    expect((await rateOn('GH.COVID', '2025-06-15')).rows).toHaveLength(1);
    expect((await rateOn('GH.COVID', '2026-03-01')).rows).toHaveLength(0);
    // The row survives so pre-2026 documents stay auditable:
    const all = await db.query<{ n: string }>(
      `select count(*)::text as n from platform.tax_rate where tax_code = 'GH.COVID'`,
    );
    expect(all.rows[0]!.n).toBe('1');
  });

  it('boundary day: 2026-01-01 belongs to the NEW regime (ranges are [from, to))', async () => {
    const res = await rateOn('GH.VAT.STD', '2026-01-01');
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.base_kind).toBe('net');
  });

  it('every seeded rate is UNCONFIRMED — the §2.8 go-live gate is visibly open', async () => {
    const res = await db.query<{ n: string }>(
      `select count(*)::text as n from platform.tax_rate where confirmed_by is not null`,
    );
    expect(res.rows[0]!.n).toBe('0');
  });

  it('overlapping effective ranges for one (jurisdiction, tax_code) are refused', async () => {
    await expect(
      db.asAdmin((tx) =>
        tx.query(
          `insert into platform.tax_rate
             (jurisdiction_code, tax_code, rate_bp, base_kind, base_includes,
              rounding_level, rounding_mode, effective, legal_reference)
           values ('GH', 'GH.VAT.STD', 1250, 'net', '{}', 'line', 'half_up',
                   daterange('2025-06-01', '2026-06-01'), 'overlap probe')`,
        ),
      ),
    ).rejects.toThrow(/overlaps/i);
  });

  it('confirmation must be a pair: confirmed_by without confirmed_at is refused', async () => {
    await expect(
      db.asAdmin((tx) =>
        tx.query(
          `insert into platform.tax_rate
             (jurisdiction_code, tax_code, rate_bp, base_kind, base_includes,
              rounding_level, rounding_mode, effective, legal_reference, confirmed_by)
           values ('GH', 'GH.COVID', 100, 'net', '{}', 'line', 'half_up',
                   daterange('2030-01-01', '2031-01-01'), 'probe', 'A. Accountant')`,
        ),
      ),
    ).rejects.toThrow(/tax_rate_confirmation_pairs|check/i);
  });

  it('re-seeding is idempotent: the rate table does not grow', async () => {
    const before = await db.query<{ n: string }>('select count(*)::text as n from platform.tax_rate');
    const { seedGhanaJurisdiction } = await import('../src/seed/ghana.js');
    await db.asAdmin((tx) => seedGhanaJurisdiction(tx));
    const after = await db.query<{ n: string }>('select count(*)::text as n from platform.tax_rate');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});
