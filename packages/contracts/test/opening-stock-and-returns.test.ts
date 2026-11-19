/**
 * The two new wire contracts, pure: the opening-stock CSV parser (exact
 * scaled quantities, never a float) and the void/return payload rules.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalOpeningRows,
  createSaleReturnInput,
  parseOpeningStockCsv,
  parseScaledDecimal,
} from '../src/index.js';

describe('parseScaledDecimal — exact, never via a float', () => {
  it('parses at the unit’s scale, trailing zeros beyond it are exact', () => {
    expect(parseScaledDecimal('2.5', 3)).toBe(2500n);
    expect(parseScaledDecimal('2.500', 3)).toBe(2500n);
    expect(parseScaledDecimal('2.50000', 3)).toBe(2500n);
    expect(parseScaledDecimal('40', 0)).toBe(40n);
    // a float would lose this; the parser does not
    expect(parseScaledDecimal('9007199254740993', 0)).toBe(9007199254740993n);
    expect(parseScaledDecimal('0.1', 1)! + parseScaledDecimal('0.2', 1)!).toBe(3n);
  });

  it('refuses a significant digit beyond the scale — never rounds an opening balance', () => {
    expect(parseScaledDecimal('2.5005', 3)).toBeNull();
    expect(parseScaledDecimal('1.5', 0)).toBeNull();
    expect(parseScaledDecimal('-1', 0)).toBeNull();
    expect(parseScaledDecimal('1e3', 0)).toBeNull();
    expect(parseScaledDecimal(' 1', 0)).toBeNull();
  });
});

describe('parseOpeningStockCsv', () => {
  it('reads the header by name, any order, and flags shape problems without a lookup', () => {
    const f = parseOpeningStockCsv(
      [
        'quantity,location_code,sku_code,unit_cost_minor',
        '40,OUT1,CEM-1,5500',
        '"2.5",OUT1,"REB,12",',
        'abc,OUT1,X-1,',
        '40,OUT1,CEM-1,',
        ',OUT1,Y-1,',
        '3,OUT1,Z-1,12.5',
        '',
      ].join('\r\n'),
    );
    expect(f.fileError).toBeNull();
    expect(f.rows.map((r) => [r.lineNo, r.skuCode, r.issues])).toEqual([
      [2, 'CEM-1', []],
      [3, 'REB,12', []],
      [4, 'X-1', ['BAD_QUANTITY']],
      [5, 'CEM-1', ['DUPLICATE_ROW']],
      [6, 'Y-1', ['MISSING_FIELD']],
      [7, 'Z-1', ['BAD_UNIT_COST']],
    ]);
    expect(f.rows[0]!.unitCostText).toBe('5500');
    expect(f.rows[1]!.unitCostText).toBeNull();
  });

  it('refuses a file that is not this format', () => {
    expect(parseOpeningStockCsv('').fileError).toMatch(/empty/);
    expect(parseOpeningStockCsv('sku,qty\nA,1').fileError).toMatch(/Missing: sku_code, location_code, quantity/);
    expect(parseOpeningStockCsv('sku_code,location_code,quantity\n').fileError).toMatch(/no rows/);
  });

  it('the content key ignores row order and blank lines, and sees a changed quantity', () => {
    const a = parseOpeningStockCsv('sku_code,location_code,quantity\nA,L,1\nB,L,2\n');
    const b = parseOpeningStockCsv('sku_code,location_code,quantity\n\nB,L,2\nA,L,1');
    const c = parseOpeningStockCsv('sku_code,location_code,quantity\nA,L,1\nB,L,3');
    expect(canonicalOpeningRows(a.rows)).toBe(canonicalOpeningRows(b.rows));
    expect(canonicalOpeningRows(a.rows)).not.toBe(canonicalOpeningRows(c.rows));
  });
});

describe('createSaleReturnInput', () => {
  const base = {
    idempotencyKey: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    originalSaleId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c',
    locationId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d',
    cashSessionId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5e',
    returnNo: 'R-1',
    reason: 'wrong item',
  };
  const refund = {
    methodId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5f', onAccountClaimMinor: '0', immediateClaimMinor: '5500',
  };

  it('a VOID states no lines and no refund; a RETURN states both', () => {
    expect(createSaleReturnInput.safeParse({ ...base, kind: 'VOID' }).success).toBe(true);
    expect(createSaleReturnInput.safeParse({ ...base, kind: 'VOID', refund }).success).toBe(false);
    expect(
      createSaleReturnInput.safeParse({
        ...base, kind: 'RETURN', refund, lines: [{ originalLineNo: 1, qty: '1', disposition: 'RESTOCK' }],
      }).success,
    ).toBe(true);
    expect(createSaleReturnInput.safeParse({ ...base, kind: 'RETURN', refund, lines: [] }).success).toBe(false);
    expect(
      createSaleReturnInput.safeParse({ ...base, kind: 'RETURN', lines: [{ originalLineNo: 1, qty: '1', disposition: 'RESTOCK' }] })
        .success,
    ).toBe(false);
  });

  it('quantities and money are decimal strings — a JSON number is refused; a forged tenant is refused', () => {
    const lines = [{ originalLineNo: 1, qty: 1, disposition: 'RESTOCK' }];
    expect(createSaleReturnInput.safeParse({ ...base, kind: 'RETURN', refund, lines }).success).toBe(false);
    expect(createSaleReturnInput.safeParse({ ...base, kind: 'VOID', tenantId: base.locationId }).success).toBe(false);
    expect(
      createSaleReturnInput.safeParse({
        ...base, kind: 'RETURN', refund,
        lines: [
          { originalLineNo: 1, qty: '1', disposition: 'RESTOCK' },
          { originalLineNo: 1, qty: '1', disposition: 'DAMAGED' },
        ],
      }).success,
    ).toBe(false);
  });
});
