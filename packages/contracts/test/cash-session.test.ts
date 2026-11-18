/**
 * The till's two outbox ops, as declarations: what they accept, what they
 * refuse, and that both are registered uploadable kinds. That the API parses
 * with these exact objects is asserted in `@erp/wire-conformance`.
 */
import { describe, expect, it } from 'vitest';
import {
  closeCashSessionInput,
  contractFor,
  DEVICE_OP_KINDS,
  openCashSessionInput,
} from '../src/index.js';

const KEY = '018f3a1e-0000-7000-8000-0000000000ff';
const LOCATION = '018f3a1e-0000-7000-8000-000000000001';
const SESSION = '018f3a1e-0000-7000-8000-0000000000aa';

function open(): Record<string, unknown> {
  return {
    idempotencyKey: KEY,
    locationId: LOCATION,
    businessDate: '2027-01-04',
    openingFloatMinor: '20000',
    openedAt: '2027-01-04T07:02:11.000Z',
    openedOffline: false,
  };
}

function close(): Record<string, unknown> {
  return {
    idempotencyKey: KEY,
    locationId: LOCATION,
    cashSessionId: SESSION,
    closedAt: '2027-01-04T18:40:00.000Z',
    autoClosed: false,
    countedMinor: '1234500',
    bankedMinor: '1200000',
    clientExpectedMinor: '1234500',
  };
}

describe('cash_session.open', () => {
  it('is an uploadable kind, registered against this exact schema', () => {
    expect(DEVICE_OP_KINDS).toContain('cash_session.open');
    expect(contractFor('cash_session.open')).toBe(openCashSessionInput);
  });

  it('accepts an open, defaults the drawer to the device’s own, and lands the float as bigint', () => {
    const parsed = openCashSessionInput.parse(open());
    expect(parsed.drawer).toBe('DEVICE');
    expect(parsed.openingFloatMinor).toBe(20_000n);
  });

  it('refuses a float as a JSON number, a negative float, and a non-calendar date', () => {
    expect(openCashSessionInput.safeParse({ ...open(), openingFloatMinor: 20000 }).success).toBe(false);
    expect(openCashSessionInput.safeParse({ ...open(), openingFloatMinor: '-1' }).success).toBe(false);
    expect(openCashSessionInput.safeParse({ ...open(), businessDate: '2027-02-30' }).success).toBe(false);
  });

  it('refuses a device or a user asserted in the payload — both come from the token', () => {
    for (const forged of ['deviceId', 'device_id', 'openedBy', 'userId']) {
      expect(openCashSessionInput.safeParse({ ...open(), [forged]: SESSION }).success, forged).toBe(false);
    }
  });

  it('accepts the SHARED drawer and nothing else outside the enum', () => {
    expect(openCashSessionInput.safeParse({ ...open(), drawer: 'SHARED' }).success).toBe(true);
    expect(openCashSessionInput.safeParse({ ...open(), drawer: 'shared' }).success).toBe(false);
  });
});

describe('cash_session.close', () => {
  it('is an uploadable kind, registered against this exact schema', () => {
    expect(DEVICE_OP_KINDS).toContain('cash_session.close');
    expect(contractFor('cash_session.close')).toBe(closeCashSessionInput);
  });

  it('accepts a counted close, with every figure as bigint', () => {
    const parsed = closeCashSessionInput.parse(close());
    expect(parsed.countedMinor).toBe(1_234_500n);
    expect(parsed.bankedMinor).toBe(1_200_000n);
  });

  it('a person’s close needs a count', () => {
    const { countedMinor, bankedMinor, ...uncounted } = close();
    expect(countedMinor).toBeDefined();
    expect(bankedMinor).toBeDefined();
    expect(closeCashSessionInput.safeParse(uncounted).success).toBe(false);
  });

  it('the midnight auto-close counts nothing and banks nothing', () => {
    const { countedMinor, bankedMinor, ...rest } = close();
    expect(countedMinor).toBeDefined();
    expect(bankedMinor).toBeDefined();
    expect(closeCashSessionInput.safeParse({ ...rest, autoClosed: true }).success).toBe(true);
    expect(closeCashSessionInput.safeParse({ ...close(), autoClosed: true }).success).toBe(false);
  });

  it('cannot bank more than was counted', () => {
    expect(closeCashSessionInput.safeParse({ ...close(), bankedMinor: '1234501' }).success).toBe(false);
    expect(closeCashSessionInput.safeParse({ ...close(), bankedMinor: '1234500' }).success).toBe(true);
  });

  it('refuses an expected figure asserted as the authority — only clientExpectedMinor, a claim', () => {
    expect(closeCashSessionInput.safeParse({ ...close(), expectedCashMinor: '1' }).success).toBe(false);
    expect(closeCashSessionInput.safeParse({ ...close(), varianceMinor: '0' }).success).toBe(false);
  });
});
