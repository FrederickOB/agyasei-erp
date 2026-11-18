/** Receipt documents for the printing tests. Currency is the test pack's, not a real one. */
import { buildReceiptDocument, type ReceiptDocument, type ReceiptDocumentInput } from '../../src/printing/document';

/** A currency with a non-ASCII sign and scale 2, as a jurisdiction pack would supply it. */
export const TEST_CURRENCY = { code: 'TST', symbol: '₵', scale: 2 } as const;

export function sampleInput(overrides: Partial<ReceiptDocumentInput> = {}): ReceiptDocumentInput {
  return {
    saleId: 'sale-1',
    receiptNo: 'R-0042',
    issuedAtIso: '2026-12-01T09:30:00.000Z',
    timeZone: 'UTC',
    businessDate: '2026-12-01',
    currency: TEST_CURRENCY,
    businessName: 'Test Traders',
    headerLines: ['Main Road'],
    locationName: 'Counter One',
    customerName: null,
    pricesIncludeTax: false,
    lines: [
      {
        name: 'Cement 50kg',
        qtyScaled: 20n,
        qtyScale: 0,
        uomLabel: 'bag',
        unitPriceE4: 620_000_000n, // 62000 minor => 620.00
        amountMinor: 1_240_000n,
      },
    ],
    netMinor: 1_240_000n,
    taxLines: [{ code: 'T1', name: 'Tax one', rateBp: 1500n, baseMinor: 1_240_000n, taxMinor: 186_000n }],
    totalMinor: 1_426_000n,
    tenders: [{ method: 'Cash', amountMinor: 1_500_000n, reference: null }],
    changeMinor: 74_000n,
    ...overrides,
  };
}

export function sampleDoc(overrides: Partial<ReceiptDocumentInput> = {}): ReceiptDocument {
  return buildReceiptDocument(sampleInput(overrides));
}
