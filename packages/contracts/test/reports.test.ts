/**
 * The reporting and reorder-point declarations.
 *
 * Two things are being pinned here, and they are different in kind.
 *
 * 1. `reports.ts` holds QUERY inputs. They are deliberately NOT in the
 *    `device-ops` registry — a device never uploads a report — so
 *    `device-ops.test.ts`'s sweeps (which iterate `DEVICE_OP_KINDS`) do not
 *    cover them and cannot be made to. Without this file the tenant-identity
 *    rule, the strictness rule and the date-range rule would hold on the
 *    uploadable surface and be unasserted on the readable one. A report that
 *    accepted a `tenant_id` would be the §2.1 violation with the widest blast
 *    radius in the codebase: it returns other people's totals.
 *
 * 2. `setReorderPointInput` is a MUTATION that is deliberately absent from the
 *    registry too, because no PWA builder exists for it yet. The registry's
 *    `satisfies` clause therefore cannot police it, so its envelope and its
 *    money/quantity discipline are asserted here instead — and the thing that
 *    matters most about it is an ABSENCE: there is no `uomCode` field, and a
 *    caller that tries to name a unit is refused. That absence is what keeps
 *    "on hand <= reorder point" an integer comparison for a SKU stocked in
 *    bars and sold by the tonne.
 *
 * Everything here is shape-level. That the ROUTERS parse with these exact
 * objects is a different claim, asserted against the live routes in
 * `apps/api/test/reports.test.ts` and `apps/api/test/reorder-points.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  cashPositionReportInput,
  distributionCostReportInput,
  inventoryDaysReportInput,
  lowStockInput,
  salesReportInput,
  setReorderPointInput,
  stockReportInput,
} from '../src/index.js';

const LOCATION = '018f3a1e-0000-7000-8000-000000000001';
const PRODUCT = '018f3a1e-0000-7000-8000-000000000002';
const KEY = '018f3a1e-0000-7000-8000-0000000000ff';

/** Every date-ranged report input, so a rule is asserted on all of them. */
const RANGED = [
  ['salesReportInput', salesReportInput],
  ['cashPositionReportInput', cashPositionReportInput],
  ['inventoryDaysReportInput', inventoryDaysReportInput],
  ['distributionCostReportInput', distributionCostReportInput],
] as const;

/** Every report input, ranged or not. */
const ALL_REPORTS = [...RANGED, ['stockReportInput', stockReportInput] as const] as const;

const range = { from: '2026-08-01', to: '2026-08-31' };

function paths(schema: { safeParse: (v: unknown) => unknown }, value: unknown): string[] {
  const parsed = schema.safeParse(value) as
    | { success: true }
    | { success: false; error: { issues: { path: (string | number)[] }[] } };
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => i.path.join('.'));
}

describe('report inputs — tenant identity is never an input (CLAUDE.md §2.1)', () => {
  it('every report input refuses all three spellings of a tenant identity', () => {
    for (const [name, schema] of ALL_REPORTS) {
      for (const spelling of ['tenant_id', 'tenantId', 'tid']) {
        const base = name === 'stockReportInput' ? {} : range;
        const parsed = schema.safeParse({ ...base, [spelling]: LOCATION });
        expect(parsed.success, `${name} accepted ${spelling}`).toBe(false);
      }
    }
  });

  it('every report input is strict — an unknown key is refused, never ignored', () => {
    for (const [name, schema] of ALL_REPORTS) {
      const base = name === 'stockReportInput' ? {} : range;
      expect(
        schema.safeParse({ ...base, groupByRegion: true }).success,
        `${name} silently accepted an unknown key`,
      ).toBe(false);
    }
  });

  it('lowStockInput is strict and refuses a tenant identity too', () => {
    expect(lowStockInput.safeParse({}).success).toBe(true);
    for (const spelling of ['tenant_id', 'tenantId', 'tid']) {
      expect(lowStockInput.safeParse({ [spelling]: LOCATION }).success).toBe(false);
    }
    expect(lowStockInput.safeParse({ includeInactive: true }).success).toBe(false);
  });
});

describe('report inputs — locationIds narrows, and is optional', () => {
  it('omitting locationIds is valid: it means "everything in my scope"', () => {
    for (const [, schema] of RANGED) expect(schema.safeParse(range).success).toBe(true);
    expect(stockReportInput.safeParse({}).success).toBe(true);
  });

  it('refuses an EMPTY location list rather than reading it as "everything"', () => {
    // The dangerous reading. `[]` most plausibly means "the caller computed a
    // set and it came out empty"; answering it with the whole network would
    // be the widest possible answer to the narrowest possible request.
    for (const [name, schema] of RANGED) {
      expect(
        schema.safeParse({ ...range, locationIds: [] }).success,
        `${name} accepted an empty location list`,
      ).toBe(false);
    }
    expect(stockReportInput.safeParse({ locationIds: [] }).success).toBe(false);
    expect(lowStockInput.safeParse({ locationIds: [] }).success).toBe(false);
  });

  it('refuses a non-uuid location id', () => {
    expect(paths(salesReportInput, { ...range, locationIds: ['OUT-01'] })).toContain(
      'locationIds.0',
    );
  });

  it('caps the list so one request cannot ask for an unbounded scan', () => {
    const many = Array.from({ length: 501 }, () => LOCATION);
    expect(salesReportInput.safeParse({ ...range, locationIds: many }).success).toBe(false);
  });
});

describe('report inputs — the business-date range', () => {
  it('accepts an inclusive range and a single day', () => {
    for (const [, schema] of RANGED) {
      expect(schema.safeParse(range).success).toBe(true);
      expect(schema.safeParse({ from: '2026-08-01', to: '2026-08-01' }).success).toBe(true);
    }
  });

  it('REFUSES a reversed range instead of silently swapping the ends', () => {
    // Normalising would turn an operator's typo into a confidently wrong
    // report — the same figure, a different period, and nothing on the page
    // to say so.
    for (const [name, schema] of RANGED) {
      expect(
        schema.safeParse({ from: '2026-08-31', to: '2026-08-01' }).success,
        `${name} normalised a reversed range`,
      ).toBe(false);
    }
  });

  it('requires both ends — a half-open range is not a period', () => {
    for (const [, schema] of RANGED) {
      expect(schema.safeParse({ from: '2026-08-01' }).success).toBe(false);
      expect(schema.safeParse({ to: '2026-08-31' }).success).toBe(false);
    }
  });

  it('refuses a timestamp where a business date belongs', () => {
    // A business date is the human-asserted trading day (03 §3.4.2). A sale
    // rung at 23:55 on a till whose clock is two hours fast still belongs to
    // the day the operator said it did, so an instant is the wrong type here.
    expect(paths(salesReportInput, { ...range, from: '2026-08-01T00:00:00Z' })).toContain('from');
  });

  it('refuses a non-calendar date that Date.parse would happily roll over', () => {
    // Date.parse('2026-02-30T00:00:00Z') succeeds in V8 and becomes 2 March.
    expect(paths(salesReportInput, { from: '2026-02-30', to: '2026-03-01' })).toContain('from');
    expect(paths(salesReportInput, { from: '2026-01-01', to: '2026-13-01' })).toContain('to');
  });

  it('stockReportInput carries NO date range — on-hand is a position, not a flow', () => {
    expect(stockReportInput.safeParse({ from: '2026-08-01', to: '2026-08-31' }).success).toBe(
      false,
    );
    // and no asOf either: offering one before the ledger can be replayed to a
    // date would label a "today" figure as a historic one.
    expect(stockReportInput.safeParse({ asOf: '2026-08-01' }).success).toBe(false);
  });
});

describe('setReorderPointInput — the unit is the server’s answer, not the caller’s', () => {
  const good = {
    idempotencyKey: KEY,
    locationId: LOCATION,
    productId: PRODUCT,
    reorderPointQty: '400',
  };

  it('accepts the minimal payload', () => {
    const parsed = setReorderPointInput.parse(good);
    expect(parsed.reorderPointQty).toBe(400n);
  });

  it('HAS NO UNIT FIELD — a caller cannot name the unit its threshold is in', () => {
    // The absence is the design. 12 m rebar is stocked as countable bars and
    // sold by the bar OR by the tonne at ~93 bars per tonne (04 §4.4.1); a
    // caller that could name a unit could name the one the last customer
    // bought in, and the alert would compare tonnes against bars thereafter.
    for (const spelling of ['uomCode', 'uomId', 'unit', 'qtyScale']) {
      expect(
        setReorderPointInput.safeParse({ ...good, [spelling]: 'TON' }).success,
        `accepted ${spelling} — the threshold's unit must come from the product`,
      ).toBe(false);
    }
  });

  it('refuses a tenant identity and any unknown key', () => {
    for (const spelling of ['tenant_id', 'tenantId', 'tid']) {
      expect(setReorderPointInput.safeParse({ ...good, [spelling]: KEY }).success).toBe(false);
    }
  });

  it('requires the idempotency key (CLAUDE.md §2.2)', () => {
    const { idempotencyKey: _omitted, ...withoutKey } = good;
    expect(paths(setReorderPointInput, withoutKey)).toContain('idempotencyKey');
  });

  it('accepts the envelope’s optional clock claims and refuses a malformed HLC', () => {
    expect(
      setReorderPointInput.safeParse({
        ...good,
        claimedHlc: '1787345012641-00001-0123456789abcdef0123456789abcdef',
        clientWallAt: '2026-08-21T20:39:51.000Z',
      }).success,
    ).toBe(true);
    expect(paths(setReorderPointInput, { ...good, claimedHlc: 'not-an-hlc' })).toContain(
      'claimedHlc',
    );
  });
});

describe('setReorderPointInput — quantity discipline (ADR-0004)', () => {
  const good = {
    idempotencyKey: KEY,
    locationId: LOCATION,
    productId: PRODUCT,
    reorderPointQty: '400',
  };

  it('rejects a quantity sent as a JSON number — a float64 in every consumer', () => {
    expect(paths(setReorderPointInput, { ...good, reorderPointQty: 400 })).toContain(
      'reorderPointQty',
    );
    expect(paths(setReorderPointInput, { ...good, reorderUpToQty: 900 })).toContain(
      'reorderUpToQty',
    );
  });

  it('rejects a fractional string — quantities are scaled integers, not decimals', () => {
    // "2.5 tonnes" is expressed as 2500 at scale 3, never as "2.5".
    expect(paths(setReorderPointInput, { ...good, reorderPointQty: '2.5' })).toContain(
      'reorderPointQty',
    );
  });

  it('rejects a negative threshold but ALLOWS zero', () => {
    expect(setReorderPointInput.safeParse({ ...good, reorderPointQty: '-1' }).success).toBe(false);
    // Zero is meaningful: "tell me only when it is actually gone".
    const atZero = setReorderPointInput.parse({ ...good, reorderPointQty: '0' });
    expect(atZero.reorderPointQty).toBe(0n);
  });

  it('carries a magnitude beyond Number.MAX_SAFE_INTEGER without loss', () => {
    const huge = '9007199254740993'; // 2^53 + 1 — unrepresentable as a float64
    const parsed = setReorderPointInput.parse({ ...good, reorderPointQty: huge });
    expect(parsed.reorderPointQty).toBe(BigInt(huge));
    expect(parsed.reorderPointQty.toString(10)).toBe(huge);
  });

  it('carries the Phase 2 fields, and bounds the lead time', () => {
    // Declared now so a tenant types its numbers once; unread until Phase 2's
    // reorder management reads them off the same rows.
    const parsed = setReorderPointInput.parse({
      ...good,
      reorderUpToQty: '1200',
      leadTimeDays: 14,
      isActive: false,
      notes: 'ships from Tema, two lorries a week',
    });
    expect(parsed.reorderUpToQty).toBe(1200n);
    expect(parsed.leadTimeDays).toBe(14);
    expect(parsed.isActive).toBe(false);
    expect(setReorderPointInput.safeParse({ ...good, leadTimeDays: -1 }).success).toBe(false);
    expect(setReorderPointInput.safeParse({ ...good, leadTimeDays: 1.5 }).success).toBe(false);
  });
});

describe('lowStockInput', () => {
  it('bounds the page size, and the ordering is not the caller’s to choose', () => {
    expect(lowStockInput.safeParse({ limit: 50 }).success).toBe(true);
    expect(lowStockInput.safeParse({ limit: 0 }).success).toBe(false);
    expect(lowStockInput.safeParse({ limit: 1001 }).success).toBe(false);
    expect(lowStockInput.safeParse({ limit: 10.5 }).success).toBe(false);
    // Urgency ordering is the router's: there is no orderBy on the wire, so a
    // caller cannot ask for the alert list sorted by anything else.
    expect(lowStockInput.safeParse({ orderBy: 'skuCode' }).success).toBe(false);
  });

  it('narrows by product as well as by location', () => {
    const parsed = lowStockInput.parse({ locationIds: [LOCATION], productIds: [PRODUCT] });
    expect(parsed.locationIds).toEqual([LOCATION]);
    expect(parsed.productIds).toEqual([PRODUCT]);
  });
});
