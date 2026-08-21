/**
 * The contract's own tests. These are the tests that would have caught the
 * bug: the API's schema and the PWA's payload builder were never once checked
 * against each other, so `packages/sync-drills` passed 5/5 while every real
 * sale was rejected BAD_REQUEST.
 *
 * The malformed variants below are the ACTUAL shape `apps/web`'s
 * `buildSalePayload` emitted, kept verbatim so a regression to it fails here
 * rather than in Techiman.
 */
import { describe, expect, it } from 'vitest';
import { comparePriceCheck, createSaleInput, saleLineInput } from '../src/index.js';

const LOCATION = '018f3a1e-0000-7000-8000-000000000001';
const PRODUCT = '018f3a1e-0000-7000-8000-000000000002';
const CUSTOMER = '018f3a1e-0000-7000-8000-000000000003';
const KEY = '018f3a1e-0000-7000-8000-0000000000ff';
const HLC = '1755600000000-00001-0123456789abcdef0123456789abcdef';

/** A known-good cash sale: two lines, money and quantity as decimal strings. */
function goodPayload(): Record<string, unknown> {
  return {
    idempotencyKey: KEY,
    claimedHlc: HLC,
    clientWallAt: '2026-08-20T09:14:03.000Z',
    locationId: LOCATION,
    priceListCode: 'RETAIL',
    receiptNo: 'SUN-RCT-004312',
    businessDate: '2026-08-20',
    occurredAt: '2026-08-20T09:14:03.000Z',
    tender: 'CASH',
    lines: [
      { productId: PRODUCT, qty: '3000', uomCode: 'BAG' },
      { productId: PRODUCT, qty: '1', lineDiscountMinor: '250' },
    ],
  };
}

/** Fail with the paths that failed, so an assertion says WHICH key was wrong. */
function failurePaths(payload: unknown): string[] {
  const parsed = createSaleInput.safeParse(payload);
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => i.path.join('.')).sort();
}

describe('createSaleInput — the known-good payload', () => {
  it('accepts a well-formed cash sale', () => {
    const parsed = createSaleInput.safeParse(goodPayload());
    expect(parsed.success).toBe(true);
  });

  it('transforms every magnitude to bigint — never a JS number', () => {
    const parsed = createSaleInput.parse(goodPayload());
    expect(parsed.lines[0]!.qty).toBe(3000n);
    expect(parsed.lines[1]!.qty).toBe(1n);
    expect(parsed.lines[1]!.lineDiscountMinor).toBe(250n);
    for (const line of parsed.lines) {
      expect(typeof line.qty).toBe('bigint');
      expect(typeof line.lineDiscountMinor).toBe('bigint');
    }
  });

  it('defaults an omitted line discount to zero, as a bigint', () => {
    const parsed = createSaleInput.parse(goodPayload());
    expect(parsed.lines[0]!.lineDiscountMinor).toBe(0n);
  });

  it('accepts a credit sale carrying a customerId', () => {
    const parsed = createSaleInput.safeParse({
      ...goodPayload(),
      tender: 'CREDIT',
      customerId: CUSTOMER,
    });
    expect(parsed.success).toBe(true);
  });

  it('survives a JSON round trip — the payload is what actually crosses the wire', () => {
    const parsed = createSaleInput.safeParse(JSON.parse(JSON.stringify(goodPayload())));
    expect(parsed.success).toBe(true);
  });

  it('carries no HTTP-envelope requirement beyond the mutation envelope', () => {
    const { claimedHlc, clientWallAt, occurredAt, ...minimal } = goodPayload();
    expect(claimedHlc).toBeDefined();
    expect(clientWallAt).toBeDefined();
    expect(occurredAt).toBeDefined();
    expect(createSaleInput.safeParse(minimal).success).toBe(true);
  });
});

describe('createSaleInput — the payload from the bug report', () => {
  /**
   * Verbatim output of the old apps/web buildSalePayload. Every sale uploaded
   * from the PWA looked exactly like this, and every one was rejected.
   */
  const webPayload = {
    kind: 'sale',
    sale_id: KEY,
    price_list_id: '018f3a1e-0000-7000-8000-00000000000a',
    created_at: '2026-08-20T09:14:03.000Z',
    lines: [
      {
        seq: 1,
        product_id: PRODUCT,
        name: 'Cement 50kg',
        uom_label: 'bag',
        qty_scale: 3,
        qty_scaled: '3000',
        unit_price_e4: '850000',
        line_total_minor: '2550',
      },
    ],
    tax_lines: [],
    total_minor: '2550',
    tender: { kind: 'cash', tendered_minor: '5000', change_minor: '2450' },
  };

  it('rejects the whole snake_case payload', () => {
    expect(createSaleInput.safeParse(webPayload).success).toBe(false);
  });

  it('names every unrecognised snake_case key rather than stripping it', () => {
    const message = JSON.stringify(createSaleInput.safeParse(webPayload));
    for (const key of ['kind', 'sale_id', 'price_list_id', 'created_at', 'total_minor', 'tax_lines']) {
      expect(message).toContain(key);
    }
  });

  it('rejects tender as an object — it is an enum of CASH | CREDIT', () => {
    const paths = failurePaths({
      ...goodPayload(),
      tender: { kind: 'cash', tendered_minor: '5000', change_minor: '2450' },
    });
    expect(paths).toContain('tender');
  });

  it('rejects a lowercase tender — the vocabulary is not case-insensitive', () => {
    expect(failurePaths({ ...goodPayload(), tender: 'cash' })).toContain('tender');
  });

  it('rejects a payload missing locationId', () => {
    const { locationId, ...withoutLocation } = goodPayload();
    expect(locationId).toBeDefined();
    expect(failurePaths(withoutLocation)).toContain('locationId');
  });

  it('rejects a payload missing receiptNo — the device allocates it (03 §3.7.5)', () => {
    const { receiptNo, ...without } = goodPayload();
    expect(receiptNo).toBeDefined();
    expect(failurePaths(without)).toContain('receiptNo');
  });

  it('rejects a payload missing businessDate — pricing and tax are dated by it', () => {
    const { businessDate, ...without } = goodPayload();
    expect(businessDate).toBeDefined();
    expect(failurePaths(without)).toContain('businessDate');
  });

  it('rejects a payload missing the idempotency key (CLAUDE.md §2.2)', () => {
    const { idempotencyKey, ...without } = goodPayload();
    expect(idempotencyKey).toBeDefined();
    expect(failurePaths(without)).toContain('idempotencyKey');
  });

  it('rejects snake_case line keys', () => {
    const paths = failurePaths({
      ...goodPayload(),
      lines: [{ product_id: PRODUCT, qty_scaled: '3000' }],
    });
    expect(paths.some((p) => p.startsWith('lines.0'))).toBe(true);
  });
});

describe('createSaleInput — the server is the pricing authority', () => {
  it('rejects a client-asserted unit price', () => {
    const bad = goodPayload();
    (bad['lines'] as Record<string, unknown>[])[0]!['unitPriceE4'] = '850000';
    expect(createSaleInput.safeParse(bad).success).toBe(false);
  });

  it('rejects a client-asserted line total', () => {
    const bad = goodPayload();
    (bad['lines'] as Record<string, unknown>[])[0]!['lineTotalMinor'] = '2550';
    expect(createSaleInput.safeParse(bad).success).toBe(false);
  });

  it('rejects a client-asserted authoritative total', () => {
    expect(createSaleInput.safeParse({ ...goodPayload(), totalMinor: '2550' }).success).toBe(false);
  });

  it('rejects client-supplied tax lines', () => {
    expect(createSaleInput.safeParse({ ...goodPayload(), taxLines: [] }).success).toBe(false);
  });

  it('rejects cash tender detail — decision (a): the server has nowhere to record it', () => {
    expect(
      createSaleInput.safeParse({ ...goodPayload(), cashTenderedMinor: '5000' }).success,
    ).toBe(false);
    expect(createSaleInput.safeParse({ ...goodPayload(), changeMinor: '2450' }).success).toBe(false);
  });
});

describe('createSaleInput — tenant identity is never an input (CLAUDE.md §2.1)', () => {
  for (const spelling of ['tenant_id', 'tenantId', 'tid']) {
    it(`rejects a forged ${spelling}`, () => {
      expect(
        createSaleInput.safeParse({ ...goodPayload(), [spelling]: LOCATION }).success,
      ).toBe(false);
    });
  }
});

describe('createSaleInput — money and quantity discipline (ADR-0004)', () => {
  it('rejects a quantity sent as a JSON number', () => {
    const bad = goodPayload();
    (bad['lines'] as Record<string, unknown>[])[0]!['qty'] = 3000;
    expect(failurePaths(bad).some((p) => p.startsWith('lines.0.qty'))).toBe(true);
  });

  it('rejects a discount sent as a JSON number', () => {
    const bad = goodPayload();
    (bad['lines'] as Record<string, unknown>[])[0]!['lineDiscountMinor'] = 250;
    expect(failurePaths(bad).some((p) => p.startsWith('lines.0'))).toBe(true);
  });

  it('rejects a fractional quantity string — quantities are scaled integers', () => {
    const bad = goodPayload();
    (bad['lines'] as Record<string, unknown>[])[0]!['qty'] = '3.5';
    expect(failurePaths(bad).some((p) => p.startsWith('lines.0.qty'))).toBe(true);
  });

  it('rejects a zero or negative quantity', () => {
    for (const qty of ['0', '-1']) {
      const bad = goodPayload();
      (bad['lines'] as Record<string, unknown>[])[0]!['qty'] = qty;
      expect(createSaleInput.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects a negative line discount', () => {
    const bad = goodPayload();
    (bad['lines'] as Record<string, unknown>[])[0]!['lineDiscountMinor'] = '-1';
    expect(createSaleInput.safeParse(bad).success).toBe(false);
  });

  it('carries a magnitude beyond Number.MAX_SAFE_INTEGER without loss', () => {
    const huge = '9007199254740993'; // 2^53 + 1 — unrepresentable as a float64
    const bad = goodPayload();
    (bad['lines'] as Record<string, unknown>[])[0]!['qty'] = huge;
    const parsed = createSaleInput.parse(bad);
    expect(parsed.lines[0]!.qty).toBe(BigInt(huge));
    expect(parsed.lines[0]!.qty.toString(10)).toBe(huge);
  });

  it('rejects a malformed business date and a non-calendar one', () => {
    expect(failurePaths({ ...goodPayload(), businessDate: '20-08-2026' })).toContain('businessDate');
    expect(failurePaths({ ...goodPayload(), businessDate: '2026-13-40' })).toContain('businessDate');
  });

  it('rejects a malformed claimed HLC', () => {
    expect(failurePaths({ ...goodPayload(), claimedHlc: 'not-an-hlc' })).toContain('claimedHlc');
  });

  it('rejects an empty and an oversized line list', () => {
    expect(failurePaths({ ...goodPayload(), lines: [] })).toContain('lines');
    const many = Array.from({ length: 201 }, () => ({ productId: PRODUCT, qty: '1' }));
    expect(failurePaths({ ...goodPayload(), lines: many })).toContain('lines');
  });
});

describe('clientTotalMinor — decision (b), the stale-price-list detector', () => {
  it('is optional: a payload without it parses', () => {
    expect(createSaleInput.safeParse(goodPayload()).success).toBe(true);
  });

  it('is accepted as a decimal string and lands as a bigint', () => {
    const parsed = createSaleInput.parse({ ...goodPayload(), clientTotalMinor: '2550' });
    expect(parsed.clientTotalMinor).toBe(2550n);
  });

  it('rejects a JS number and a negative total', () => {
    expect(createSaleInput.safeParse({ ...goodPayload(), clientTotalMinor: 2550 }).success).toBe(
      false,
    );
    expect(createSaleInput.safeParse({ ...goodPayload(), clientTotalMinor: '-1' }).success).toBe(
      false,
    );
  });

  it('reports agreement exactly, with money as strings', () => {
    expect(comparePriceCheck(2550n, 2550n)).toEqual({
      clientTotalMinor: '2550',
      serverTotalMinor: '2550',
      deltaMinor: '0',
      matches: true,
    });
  });

  it('reports a stale-price-list divergence signed server − client', () => {
    // Device priced on last week's list: server reprices HIGHER.
    expect(comparePriceCheck(2550n, 2600n)).toEqual({
      clientTotalMinor: '2550',
      serverTotalMinor: '2600',
      deltaMinor: '50',
      matches: false,
    });
    // …and LOWER.
    expect(comparePriceCheck(2600n, 2550n)).toEqual({
      clientTotalMinor: '2600',
      serverTotalMinor: '2550',
      deltaMinor: '-50',
      matches: false,
    });
  });

  it('has no tolerance band — one pesewa of divergence is a divergence', () => {
    expect(comparePriceCheck(2550n, 2551n).matches).toBe(false);
  });

  it('stays exact past float64 range', () => {
    const client = 9007199254740993n;
    const server = 9007199254740994n;
    const check = comparePriceCheck(client, server);
    expect(check.deltaMinor).toBe('1');
    expect(check.matches).toBe(false);
  });
});

describe('saleLineInput is exported on its own, and is strict', () => {
  it('accepts a bare line', () => {
    expect(saleLineInput.safeParse({ productId: PRODUCT, qty: '1' }).success).toBe(true);
  });

  it('rejects an unknown key on a line', () => {
    expect(saleLineInput.safeParse({ productId: PRODUCT, qty: '1', name: 'Cement' }).success).toBe(
      false,
    );
  });
});
