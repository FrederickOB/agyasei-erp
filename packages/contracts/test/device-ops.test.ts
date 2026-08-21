/**
 * The registry and the two payloads that moved into it, plus the `/sync/token`
 * response shape.
 *
 * These schemas were private to `apps/api/src/routers/` until the second
 * contract-drift bug. Nothing on the client had ever seen them; the sync
 * drills' hand-written JSON was the only thing that had. The tests here are
 * about the DECLARATION — that it exists, that it is exhaustive, that it
 * enforces the money and tenant rules. That the API's routers actually parse
 * with these exact objects is asserted in `@erp/wire-conformance`, which is
 * the only package that can import both sides.
 */
import { describe, expect, it } from 'vitest';
import {
  CREDIT_ENTRY_KINDS,
  DEVICE_OP_KINDS,
  DIRECT_MOVEMENT_KINDS,
  contractFor,
  deviceOpContracts,
  openAccountInput,
  recordEntryInput,
  recordMovementInput,
  syncTokenResponse,
} from '../src/index.js';

const LOCATION = '018f3a1e-0000-7000-8000-000000000001';
const PRODUCT = '018f3a1e-0000-7000-8000-000000000002';
const ACCOUNT = '018f3a1e-0000-7000-8000-000000000003';
const KEY = '018f3a1e-0000-7000-8000-0000000000ff';

describe('the device-op registry', () => {
  it('covers every uploadable kind, and only those', () => {
    expect(Object.keys(deviceOpContracts).sort()).toEqual([...DEVICE_OP_KINDS].sort());
  });

  it('hands back a parser for each kind', () => {
    for (const kind of DEVICE_OP_KINDS) {
      expect(typeof contractFor(kind).safeParse).toBe('function');
    }
  });

  it('every registered schema requires the idempotency key (CLAUDE.md §2.2)', () => {
    for (const kind of DEVICE_OP_KINDS) {
      const parsed = contractFor(kind).safeParse({});
      expect(parsed.success).toBe(false);
      if (parsed.success) continue;
      expect(parsed.error.issues.some((i) => i.path[0] === 'idempotencyKey')).toBe(true);
    }
  });

  it('every registered schema refuses a tenant identity in the payload (CLAUDE.md §2.1)', () => {
    for (const kind of DEVICE_OP_KINDS) {
      for (const spelling of ['tenant_id', 'tenantId', 'tid']) {
        const parsed = contractFor(kind).safeParse({ idempotencyKey: KEY, [spelling]: KEY });
        expect(parsed.success, `${kind} accepted ${spelling}`).toBe(false);
        if (parsed.success) continue;
        expect(
          parsed.error.issues.some((i) => i.message.toLowerCase().includes('unrecognized')),
          `${kind} did not reject ${spelling} as an unknown key`,
        ).toBe(true);
      }
    }
  });
});

describe('stock.record_movement', () => {
  function good(): Record<string, unknown> {
    return {
      idempotencyKey: KEY,
      locationId: LOCATION,
      productId: PRODUCT,
      qtyDelta: '-250',
      sourceKind: 'WRITE_OFF',
      reasonCode: 'DAMAGE',
      businessDate: '2026-08-21',
    };
  }

  it('accepts a signed scaled-integer delta as a decimal string and yields bigint', () => {
    const parsed = recordMovementInput.parse(good());
    expect(parsed.qtyDelta).toBe(-250n);
    expect(typeof parsed.qtyDelta).toBe('bigint');
  });

  it('refuses a quantity sent as a JSON number (ADR-0004)', () => {
    expect(recordMovementInput.safeParse({ ...good(), qtyDelta: -250 }).success).toBe(false);
  });

  it('refuses a zero delta — a movement that moves nothing is a bug, not a row', () => {
    expect(recordMovementInput.safeParse({ ...good(), qtyDelta: '0' }).success).toBe(false);
  });

  it('refuses SALE — sale movements are written by the sales document, never directly', () => {
    expect(DIRECT_MOVEMENT_KINDS).not.toContain('SALE');
    expect(recordMovementInput.safeParse({ ...good(), sourceKind: 'SALE' }).success).toBe(false);
  });

  it('takes the reason as free tenant vocabulary, not an enum (CLAUDE.md §2.9)', () => {
    // A reason code is a row in the tenant's own `movement_reason` table. The
    // contract must not encode tenant #1's list.
    for (const code of ['DAMAGE', 'anything-the-tenant-defined', 'ZZZ']) {
      expect(recordMovementInput.safeParse({ ...good(), reasonCode: code }).success).toBe(true);
    }
    expect(recordMovementInput.safeParse({ ...good(), reasonCode: '' }).success).toBe(false);
  });

  it('refuses a unit cost sent as a number, and accepts one as a decimal string', () => {
    expect(recordMovementInput.safeParse({ ...good(), unitCostE4: 12_000 }).success).toBe(false);
    expect(recordMovementInput.parse({ ...good(), unitCostE4: '12000' }).unitCostE4).toBe(12_000n);
  });
});

describe('credit.open_account', () => {
  function good(): Record<string, unknown> {
    return {
      idempotencyKey: KEY,
      newCustomer: { code: 'CUST-1', name: 'A contractor' },
      termsDays: 30,
      feeRateBpPerMonth: 200,
      creditLimitMinor: '1000000',
    };
  }

  it('carries the credit limit as a decimal string and yields bigint', () => {
    const parsed = openAccountInput.parse(good());
    expect(parsed.creditLimitMinor).toBe(1_000_000n);
  });

  it('refuses a credit limit sent as a JSON number (ADR-0004)', () => {
    expect(openAccountInput.safeParse({ ...good(), creditLimitMinor: 1_000_000 }).success).toBe(
      false,
    );
  });

  it('requires exactly one of customerId or newCustomer', () => {
    const { newCustomer: _drop, ...withoutCustomer } = good();
    expect(openAccountInput.safeParse(withoutCustomer).success).toBe(false);
    expect(openAccountInput.safeParse({ ...good(), customerId: ACCOUNT }).success).toBe(false);
    expect(openAccountInput.safeParse({ ...withoutCustomer, customerId: ACCOUNT }).success).toBe(
      true,
    );
  });

  it('refuses a negative credit limit and an out-of-range fee rate', () => {
    expect(openAccountInput.safeParse({ ...good(), creditLimitMinor: '-1' }).success).toBe(false);
    expect(openAccountInput.safeParse({ ...good(), feeRateBpPerMonth: -1 }).success).toBe(false);
    expect(openAccountInput.safeParse({ ...good(), feeRateBpPerMonth: 10_001 }).success).toBe(false);
  });
});

describe('credit.record_entry', () => {
  function good(): Record<string, unknown> {
    return {
      idempotencyKey: KEY,
      accountId: ACCOUNT,
      kind: 'PAYMENT',
      amountMinor: '-25000',
      businessDate: '2026-08-21',
    };
  }

  it('carries a signed amount as a decimal string and yields bigint', () => {
    expect(recordEntryInput.parse(good()).amountMinor).toBe(-25_000n);
  });

  it('refuses an amount sent as a JSON number, and a zero amount', () => {
    expect(recordEntryInput.safeParse({ ...good(), amountMinor: -25_000 }).success).toBe(false);
    expect(recordEntryInput.safeParse({ ...good(), amountMinor: '0' }).success).toBe(false);
  });

  it('offers no FEE kind — fee entries are server-side accrual behind the Q4 gate', () => {
    expect(CREDIT_ENTRY_KINDS).not.toContain('FEE');
    expect(recordEntryInput.safeParse({ ...good(), kind: 'FEE' }).success).toBe(false);
  });

  it('refuses a non-calendar business date rather than rolling it over', () => {
    expect(recordEntryInput.safeParse({ ...good(), businessDate: '2026-02-30' }).success).toBe(
      false,
    );
  });
});

describe('the GET /sync/token response contract', () => {
  const good = {
    token: 'header.payload.signature',
    expires_at: '2026-08-21T09:05:00.000Z',
    endpoint: 'http://localhost:8080',
  };

  it('accepts what the API sends', () => {
    expect(syncTokenResponse.safeParse(good).success).toBe(true);
  });

  it('is not strict — a server that adds a field must not break older devices', () => {
    expect(syncTokenResponse.safeParse({ ...good, some_future_field: 1 }).success).toBe(true);
  });

  it('treats endpoint as optional, because the client ignores it', () => {
    const { endpoint: _drop, ...withoutEndpoint } = good;
    expect(syncTokenResponse.safeParse(withoutEndpoint).success).toBe(true);
  });

  it('refuses a renamed or missing expiry — the failure this shape exists to catch', () => {
    const { expires_at: _drop, ...renamed } = good;
    expect(syncTokenResponse.safeParse({ ...renamed, expiresAt: good.expires_at }).success).toBe(
      false,
    );
    expect(syncTokenResponse.safeParse({ ...good, expires_at: 'soon' }).success).toBe(false);
    expect(syncTokenResponse.safeParse({ ...good, token: '' }).success).toBe(false);
  });
});
