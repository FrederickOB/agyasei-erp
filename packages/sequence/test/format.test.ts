/**
 * Number rendering and block arithmetic (03 §3.7.5). This module is shared by
 * the server, the device and the drills precisely so all three agree; these
 * tests pin the agreement.
 */
import { describe, expect, it } from 'vitest';
import {
  SequenceFormatError,
  SequenceOverflowError,
  blockEnd,
  declaredWidth,
  deviceSuffix,
  emergencyNumber,
  needsReplacement,
  nextNumber,
  remaining,
  renderNumber,
} from '../src/index.js';

/** Tenant #1's template format (§3.7.5). Data, never a constant in code. */
const TENANT1 = {
  format: '{location_code}-{prefix}-{n:06d}',
  locationCode: 'SUN',
  prefix: 'RCT',
} as const;

describe('renderNumber', () => {
  it('renders the template format from §3.7.5', () => {
    expect(renderNumber(TENANT1, 4312n)).toBe('SUN-RCT-004312');
  });

  it('another tenant\'s format is another value, not another code path', () => {
    expect(
      renderNumber({ format: 'INV/{prefix}/{n:04d}', locationCode: 'X', prefix: 'KB' }, 7n),
    ).toBe('INV/KB/0007');
    expect(renderNumber({ format: '{n}', locationCode: 'X', prefix: 'Y' }, 123456789n)).toBe(
      '123456789',
    );
  });

  it('raises rather than wrapping when n exceeds the declared width', () => {
    expect(renderNumber(TENANT1, 999_999n)).toBe('SUN-RCT-999999');
    expect(() => renderNumber(TENANT1, 1_000_000n)).toThrow(SequenceOverflowError);
  });

  it('carries exactly past 2^53 — a receipt number is never a float64', () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    expect(renderNumber({ format: '{n}', locationCode: 'X', prefix: 'Y' }, big)).toBe(
      '9007199254740993',
    );
  });

  it('refuses an unknown placeholder at the counter, not on a printed receipt', () => {
    expect(() =>
      renderNumber({ format: '{branch}-{n:04d}', locationCode: 'A', prefix: 'B' }, 1n),
    ).toThrow(SequenceFormatError);
  });

  it('refuses a format with no {n} slot, and a number below 1', () => {
    expect(() => declaredWidth('{prefix}-only')).toThrow(SequenceFormatError);
    expect(() => renderNumber(TENANT1, 0n)).toThrow(SequenceFormatError);
  });

  it('reads the declared width (0 = unpadded, no ceiling)', () => {
    expect(declaredWidth(TENANT1.format)).toBe(6);
    expect(declaredWidth('{n}')).toBe(0);
  });
});

describe('emergency form', () => {
  const device = '01a02430-5627-780b-b10a-f9bec1050341';

  it('appends the device-derived suffix §3.7.5 specifies', () => {
    expect(deviceSuffix(device)).toBe('01A');
    expect(emergencyNumber('SUN-RCT-004999', device)).toBe('SUN-RCT-004999-01A');
  });

  it('a discriminator separates two emergency numbers from ONE device', () => {
    const a = emergencyNumber('SUN-RCT-004999', device, 'aaaa-1111');
    const b = emergencyNumber('SUN-RCT-004999', device, 'bbbb-2222');
    expect(a).not.toBe(b);
    expect(a.startsWith('SUN-RCT-004999-01A')).toBe(true);
  });
});

describe('block arithmetic', () => {
  const block = { blockStart: 1000n, blockSize: 500 };

  it('spans [start, start + size - 1]', () => {
    expect(blockEnd(block)).toBe(1499n);
  });

  it('issues from the start, then one past the last issued', () => {
    expect(nextNumber(block, null)).toBe(1000n);
    expect(nextNumber(block, 1000n)).toBe(1001n);
    expect(nextNumber(block, 1498n)).toBe(1499n);
  });

  it('is spent — not wrapped — at the end of the range', () => {
    expect(nextNumber(block, 1499n)).toBeNull();
    expect(remaining(block, 1499n)).toBe(0n);
    expect(remaining(block, null)).toBe(500n);
  });

  it('asks for a replacement by DAYS of observed throughput, not a flat percentage', () => {
    // 150/day at a flagship till: 500 numbers is 3–4 days, so a block that
    // looks "80% fine" is already inside the reorder window (§3.7.5).
    expect(needsReplacement(block, 1100n, { observedPerDay: 150 })).toBe(true); // 399 left
    expect(needsReplacement(block, 1000n, { observedPerDay: 20 })).toBe(false); // 499 left
  });

  it('falls back to 20% only when the till has no observed history', () => {
    expect(needsReplacement(block, 1399n)).toBe(true); // 100 left of 500
    expect(needsReplacement(block, 1000n)).toBe(false);
  });
});
