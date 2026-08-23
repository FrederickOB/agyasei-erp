// @vitest-environment jsdom
/**
 * The buying screen, tested for the control it exists to hold.
 *
 * **RAISING AN ORDER AND APPROVING ONE ARE TWO CAPABILITIES.** One person who
 * can do both can commit the business to a spend nobody else saw. The UI must
 * not imply otherwise: somebody who may raise an order sees *Submit for
 * approval* and a sentence saying who has to sign it off — never one button
 * that quietly does both, and never a blank space that reads as "there is
 * nothing left to do" while an order sits unsigned.
 *
 * Hiding *Approve* is a COURTESY, not the boundary: the server derives the
 * required capability from the target status and refuses the transition
 * regardless of what this screen offered. It is tested as a courtesy.
 *
 * The rest is the same offline honesty every server-backed screen owes: orders
 * are in no sync bucket, so a partitioned device says so rather than showing an
 * empty list, and a suggestion list that is empty says WHICH kind of empty.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiCallOptions, ApiEndpoint, ApiFetch } from '../src/data/api/client';
import { CAPABILITY, type PermissionsState } from '../src/data/api/session';
import type { LocalDb } from '../src/data/db';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { Purchasing } from '../src/features/purchasing/Purchasing';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { provisionDevice, seedProduct, seedPurchaseUnit } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const ENDPOINT: ApiEndpoint = { url: 'http://api.test', bearer: 'dev' };
const LOC = '018f3a1e-0000-7000-8000-00000000aaaa';
const PRODUCT = '018f3a1e-0000-7000-8000-0000000000c1';
const SUPPLIER = '018f3a1e-0000-7000-8000-0000000000d1';
const ORDER = '018f3a1e-0000-7000-8000-0000000000e1';
const UOM_TONNE = '018f3a1e-0000-7000-8000-0000000000b2';

interface Sent {
  readonly path: string;
  readonly input: string;
}

type Answer = { ok: true; json: unknown } | 'reject';

function router(answers: Readonly<Record<string, Answer>>, sent: Sent[] = []): ApiFetch {
  return (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/trpc/', '');
    sent.push({ path, input: init.body ?? parsed.searchParams.get('input') ?? '' });
    const answer = answers[path];
    if (answer === undefined || answer === 'reject') return Promise.reject(new Error('no radio'));
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: { data: { json: answer.json } } }),
    });
  };
}

function holding(codes: readonly string[]): PermissionsState {
  return {
    status: 'live',
    asOfMs: 0,
    snapshot: {
      userId: 'u1',
      grants: codes.map((code) => ({ code, locationId: LOC })),
      codes: [...codes],
      locationIds: [LOC],
    },
  };
}

const HEADER = {
  purchaseOrderId: ORDER,
  supplierId: SUPPLIER,
  supplierCode: 'SUP-1',
  supplierName: 'Northern Supply',
  deliverToLocationId: LOC,
  locationCode: 'OUT-01',
  locationName: 'Main yard',
  orderNo: null,
  status: 'SUBMITTED',
  orderDate: '2026-08-20',
  expectedAt: null,
  currencyCode: 'XTS',
  moneyScale: '100',
  submittedAt: '2026-08-20T10:00:00.000Z',
  approvedAt: null,
  closedAt: null,
  cancelledAt: null,
  cancelReason: null,
  notes: null,
  lineCount: 1,
  totalMinor: '450000',
};

const LIST = {
  scope: { locationCount: 1, network: false },
  orderCount: 1,
  totalMinor: '450000',
  orders: [HEADER],
  locations: [{ locationId: LOC, locationCode: 'OUT-01', locationName: 'Main yard' }],
};

const DETAIL = {
  ...HEADER,
  // Read from `app.purchase_order_legal_transitions()` by the router. The
  // screen greys nothing in from a second copy of that table.
  legalNextStatuses: ['APPROVED', 'CANCELLED'],
  lines: [
    {
      purchaseOrderLineId: 'pol-1',
      lineNo: 1,
      productId: PRODUCT,
      skuCode: 'SKU-1',
      productName: 'Binder 50kg',
      uomId: 'u-tonne',
      uomCode: 'TONNE',
      qtyScale: 3,
      qtyOrdered: '5000',
      qtyReceived: '2000',
      qtyOutstanding: '3000',
      isFullyReceived: false,
      receiptLineCount: 1,
      stockingUomId: 'u-sack',
      stockingUomCode: 'SACK',
      qtyStockScale: 0,
      qtyOrderedStock: '100',
      qtyStockReceived: '40',
      factorNum: '20',
      factorDen: '1',
      unitPriceE4: '900000000',
      lineNetMinor: '450000',
    },
  ],
};

const SUGGESTIONS_EMPTY = {
  scope: { locationCount: 1, network: false },
  state: 'NO_THRESHOLDS_CONFIGURED',
  activeThresholdCount: 0,
  lowStockCount: 0,
  suggestionCount: 0,
  unsourcedCount: 0,
  suggestions: [],
  unsourced: [],
};

const SUGGESTIONS = {
  scope: { locationCount: 1, network: false },
  state: 'SUGGESTIONS',
  activeThresholdCount: 3,
  lowStockCount: 2,
  suggestionCount: 1,
  unsourcedCount: 1,
  suggestions: [
    {
      locationId: LOC,
      reorderPointId: 'rp-1',
      productId: PRODUCT,
      skuCode: 'SKU-1',
      productName: 'Binder 50kg',
      qtyOnHand: '10',
      reorderPointQty: '40',
      reorderUpToQty: '120',
      shortfallQty: '110',
      qtyScale: 0,
      uomCode: 'SACK',
      reorderLeadTimeDays: 4,
      recommendation: {
        basis: 'PREFERRED',
        supplierId: SUPPLIER,
        supplierCode: 'SUP-1',
        supplierName: 'Northern Supply',
        supplierSku: 'NS-77',
        leadTimeDays: 4,
        paymentTermsDays: 30,
        purchaseUomId: 'u-tonne',
        purchaseUomCode: 'TONNE',
        buyScale: 3,
        qtyBasis: 'ORDER_UP_TO',
        qtyToOrderStock: '110',
        qtyToOrder: '5500',
        qtyUnavailableReason: null,
        estimatedCostMinor: '495000',
        estimateUnavailableReason: null,
      },
      alternativeCount: 1,
      alternatives: [],
    },
  ],
  unsourced: [
    {
      locationId: LOC,
      reorderPointId: 'rp-2',
      productId: 'p-other',
      skuCode: 'SKU-2',
      productName: 'Roofing sheet',
      qtyOnHand: '0',
      reorderPointQty: '10',
      reorderUpToQty: null,
      shortfallQty: '10',
      qtyScale: 0,
      uomCode: 'SHEET',
      reorderLeadTimeDays: null,
      reason: 'NO_ACTIVE_SUPPLIER',
    },
  ],
};

const SUPPLIERS = {
  supplierCount: 1,
  suppliers: [
    {
      supplierId: SUPPLIER,
      code: 'SUP-1',
      name: 'Northern Supply',
      paymentTermsDays: 30,
      currencyCode: 'XTS',
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      addressText: null,
      notes: null,
      isActive: true,
      capabilities: [],
    },
  ],
  capabilityTypes: [],
};

async function device(): Promise<LocalDb> {
  const db = openTestDb();
  const provisioned = await provisionDevice(db, { locationId: LOC, locationCode: 'OUT-01' });
  await seedProduct(db, {
    id: PRODUCT,
    code: 'SKU-1',
    name: 'Binder 50kg',
    uomLabel: 'SACK',
    unitPriceE4: 620_000_000n,
    priceListId: provisioned.priceListId,
  });
  await seedPurchaseUnit(db, {
    productId: PRODUCT,
    uomId: UOM_TONNE,
    code: 'TONNE',
    qtyScale: 3,
    factorNum: 20n,
    factorDen: 1n,
  });
  return db;
}

function renderScreen(db: LocalDb, permissions: PermissionsState, apiOptions: ApiCallOptions) {
  return render(
    <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
      <Purchasing db={db} permissions={permissions} apiOptions={apiOptions} />
    </CurrencyProvider>,
  );
}

const READY: Readonly<Record<string, Answer>> = {
  'procurement.listPurchaseOrders': { ok: true, json: LIST },
  'procurement.purchaseOrder': { ok: true, json: DETAIL },
  'procurement.reorderSuggestions': { ok: true, json: SUGGESTIONS_EMPTY },
  'procurement.listSuppliers': { ok: true, json: SUPPLIERS },
};

afterEach(cleanup);

describe('raising an order and approving one are not the same control', () => {
  it('offers Approve only to somebody who holds the approval capability', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.purchaseOrderView, CAPABILITY.purchaseOrderApprove]), {
      endpoint: ENDPOINT,
      fetchFn: router(READY),
    });

    fireEvent.click(await screen.findByRole('button', { name: /Northern Supply/ }));
    expect(await screen.findByRole('button', { name: 'Approve this order' })).toBeDefined();
  });

  it('does NOT offer it to somebody who may only raise one — and says who must', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.purchaseOrderView, CAPABILITY.purchaseOrderCreate]), {
      endpoint: ENDPOINT,
      fetchFn: router(READY),
    });

    fireEvent.click(await screen.findByRole('button', { name: /Northern Supply/ }));
    // The move it CAN make is offered…
    expect(await screen.findByRole('button', { name: 'Cancel this order' })).toBeDefined();
    // …the one it cannot is absent…
    expect(screen.queryByRole('button', { name: 'Approve this order' })).toBeNull();
    // …and the screen says so, rather than leaving a silence that reads as
    // "nothing left to do" while the order sits unsigned.
    expect(
      screen.getByText(/still needs approving, and approving is not part of what you do/),
    ).toBeDefined();
  });

  it('offers only the moves the SERVER said are legal from here', async () => {
    const db = await device();
    renderScreen(
      db,
      holding([
        CAPABILITY.purchaseOrderView,
        CAPABILITY.purchaseOrderCreate,
        CAPABILITY.purchaseOrderApprove,
      ]),
      { endpoint: ENDPOINT, fetchFn: router(READY) },
    );

    fireEvent.click(await screen.findByRole('button', { name: /Northern Supply/ }));
    await screen.findByRole('button', { name: 'Approve this order' });
    // `legalNextStatuses` is APPROVED and CANCELLED. Nothing else is offered,
    // because the transition table lives in the database and this screen asks
    // rather than keeping a copy.
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark delivered' })).toBeNull();
  });

  it('refuses to send a cancellation with no reason, before a round trip', async () => {
    const db = await device();
    const sent: Sent[] = [];
    renderScreen(db, holding([CAPABILITY.purchaseOrderView, CAPABILITY.purchaseOrderCreate]), {
      endpoint: ENDPOINT,
      fetchFn: router(READY, sent),
    });

    fireEvent.click(await screen.findByRole('button', { name: /Northern Supply/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel this order' }));

    expect(await screen.findByText(/cancelled with no explanation cannot be accounted for/)).toBeDefined();
    expect(sent.some((s) => s.path === 'procurement.changePurchaseOrderStatus')).toBe(false);
  });

  it('hides the raise control from somebody who may only read orders', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.purchaseOrderView]), {
      endpoint: ENDPOINT,
      fetchFn: router(READY),
    });
    await screen.findByRole('list', { name: 'Purchase orders' });
    expect(screen.queryByRole('button', { name: /Raise an order/ })).toBeNull();
  });
});

describe('the order itself', () => {
  it('shows an over-delivery as an over-delivery rather than clamping it to zero', async () => {
    const db = await device();
    const over = {
      ...DETAIL,
      lines: [{ ...DETAIL.lines[0], qtyOutstanding: '-500' }],
    };
    renderScreen(db, holding([CAPABILITY.purchaseOrderView]), {
      endpoint: ENDPOINT,
      fetchFn: router({ ...READY, 'procurement.purchaseOrder': { ok: true as const, json: over } }),
    });

    fireEvent.click(await screen.findByRole('button', { name: /Northern Supply/ }));
    expect(await screen.findByText(/0\.5 TONNE over/)).toBeDefined();
  });

  it('renders the total through the tenant’s own currency configuration', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.purchaseOrderView]), {
      endpoint: ENDPOINT,
      fetchFn: router(READY),
    });
    fireEvent.click(await screen.findByRole('button', { name: /Northern Supply/ }));
    // 450000 minor units at the configured scale of 2.
    expect((await screen.findAllByText(/4500\.00/)).length).toBeGreaterThan(0);
  });
});

describe('what needs ordering', () => {
  it('says NO THRESHOLDS have been set, and does not say stock is healthy', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.purchaseOrderView]), {
      endpoint: ENDPOINT,
      fetchFn: router(READY),
    });
    expect(await screen.findByText(/No thresholds have been set here yet/)).toBeDefined();
    expect(screen.queryByText(/Nothing is below its threshold/)).toBeNull();
  });

  it('says stock IS healthy only when thresholds actually exist', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.purchaseOrderView]), {
      endpoint: ENDPOINT,
      fetchFn: router({
        ...READY,
        'procurement.reorderSuggestions': {
          ok: true as const,
          json: { ...SUGGESTIONS_EMPTY, state: 'NOTHING_BELOW_REORDER_POINT', activeThresholdCount: 7 },
        },
      }),
    });
    expect(await screen.findByText(/Nothing is below its threshold/)).toBeDefined();
    expect(screen.getByText(/All 7 products with a threshold/)).toBeDefined();
    expect(screen.queryByText(/No thresholds have been set here yet/)).toBeNull();
  });

  it('lists what has NOBODY to buy it from rather than quietly dropping it', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.purchaseOrderView]), {
      endpoint: ENDPOINT,
      fetchFn: router({
        ...READY,
        'procurement.reorderSuggestions': { ok: true as const, json: SUGGESTIONS },
      }),
    });
    expect(await screen.findByText(/has nobody to buy it from/)).toBeDefined();
    expect(screen.getByText(/Roofing sheet/)).toBeDefined();
  });

  it('offers to start an order only to somebody who may raise one', async () => {
    const db = await device();
    const withSuggestions = {
      ...READY,
      'procurement.reorderSuggestions': { ok: true as const, json: SUGGESTIONS },
    };
    renderScreen(db, holding([CAPABILITY.purchaseOrderView]), {
      endpoint: ENDPOINT,
      fetchFn: router(withSuggestions),
    });
    await screen.findByRole('list', { name: 'Reorder suggestions' });
    expect(screen.queryByRole('button', { name: /Start an order for this/ })).toBeNull();

    cleanup();
    const db2 = await device();
    renderScreen(db2, holding([CAPABILITY.purchaseOrderView, CAPABILITY.purchaseOrderCreate]), {
      endpoint: ENDPOINT,
      fetchFn: router(withSuggestions),
    });
    expect(await screen.findByRole('button', { name: /Start an order for this/ })).toBeDefined();
  });

  it('shows an estimate as an estimate, and never a zero when there is none', async () => {
    const db = await device();
    const unpriced = {
      ...SUGGESTIONS,
      suggestions: [
        {
          ...SUGGESTIONS.suggestions[0],
          recommendation: {
            ...SUGGESTIONS.suggestions[0]!.recommendation,
            estimatedCostMinor: null,
            estimateUnavailableReason: 'NO_RECORDED_PRICE',
          },
        },
      ],
    };
    renderScreen(db, holding([CAPABILITY.purchaseOrderView]), {
      endpoint: ENDPOINT,
      fetchFn: router({
        ...READY,
        'procurement.reorderSuggestions': { ok: true as const, json: unpriced },
      }),
    });
    const list = await screen.findByRole('list', { name: 'Reorder suggestions' });
    expect(list.textContent).toContain('Nothing bought from them yet');
    expect(list.textContent).not.toContain('0.00');
  });
});

describe('offline', () => {
  it('says unavailable on every panel and renders no list at all', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.purchaseOrderView, CAPABILITY.purchaseOrderCreate]), {
      endpoint: ENDPOINT,
      fetchFn: () => Promise.reject(new Error('down')),
    });

    expect((await screen.findAllByText(/Not available offline\./)).length).toBeGreaterThan(1);
    expect(screen.queryByRole('list', { name: 'Purchase orders' })).toBeNull();
    expect(screen.queryByText('No orders here yet')).toBeNull();
    expect(screen.queryByText(/Nothing is below its threshold/)).toBeNull();
  });

  it('refuses to raise an order offline and says nothing was queued', async () => {
    const db = await device();
    let allowSuppliers = true;
    const fetchFn: ApiFetch = (url, init) => {
      const parsed = new URL(url);
      const path = parsed.pathname.replace('/trpc/', '');
      if (path === 'procurement.listSuppliers' && allowSuppliers) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ result: { data: { json: SUPPLIERS } } }),
        });
      }
      if (path === 'procurement.listPurchaseOrders') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ result: { data: { json: LIST } } }),
        });
      }
      if (path === 'procurement.reorderSuggestions') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ result: { data: { json: SUGGESTIONS_EMPTY } } }),
        });
      }
      void init;
      return Promise.reject(new Error('no radio'));
    };
    renderScreen(db, holding([CAPABILITY.purchaseOrderView, CAPABILITY.purchaseOrderCreate]), {
      endpoint: ENDPOINT,
      fetchFn,
    });

    fireEvent.click(await screen.findByRole('button', { name: /Raise an order/ }));
    const form = await screen.findByRole('form', { name: 'New order' });
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: SUPPLIER } });
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: PRODUCT } });
    await waitFor(() => expect(screen.getByLabelText('Purchase unit')).toBeDefined());
    // Bought by the tonne, stocked in sacks — the conversion 04 §4.10 names,
    // and the reason a quantity here carries three decimals while the shelf
    // counts whole sacks.
    await waitFor(() =>
      expect(
        [...screen.getByLabelText('Purchase unit').querySelectorAll('option')].map(
          (o) => (o as HTMLOptionElement).value,
        ),
      ).toContain(UOM_TONNE),
    );
    fireEvent.change(screen.getByLabelText('Purchase unit'), { target: { value: UOM_TONNE } });
    fireEvent.change(screen.getByLabelText('Quantity ordered'), { target: { value: '2.5' } });
    fireEvent.change(screen.getByLabelText('Agreed unit price'), { target: { value: '1000.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to the order' }));
    // The line is priced by the extended amount, rounded once: 2.5 × 1000.00.
    await waitFor(() => expect(form.textContent).toContain('2500.00'));

    allowSuppliers = false;
    fireEvent.click(screen.getByRole('button', { name: 'Raise as a draft' }));
    expect(
      await screen.findByText(/Nothing was queued and nothing was ordered/),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Correcting a draft — procurement.updatePurchaseOrder
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A MISTYPED QUANTITY MUST NOT COST AN ABANDONED DOCUMENT
 * ═══════════════════════════════════════════════════════════════════════════
 * Until the amendment route had a caller, correcting a draft meant cancelling
 * it and raising another — an abandoned order in the audit trail for a typing
 * slip.
 *
 * The window is DRAFT and ONLY DRAFT, and that is the SERVER's rule: the API
 * refuses an amendment on SUBMITTED, APPROVED and CANCELLED with
 * PRECONDITION_FAILED, and 0008's trigger refuses a line edit that never
 * reaches the router at all (`apps/api/test/procurement.test.ts`). If an
 * approved order could take a silent line change, an approval would certify
 * nothing. So this screen offers the control on a draft and nowhere else,
 * rather than offering it everywhere and letting somebody discover the refusal
 * after typing.
 *
 * Every test below fails if the wiring is removed: each asserts the request
 * reached the wire, or that the control is honestly absent.
 */
const PRODUCT_2 = '018f3a1e-0000-7000-8000-0000000000c2';
const UOM_SHEET = '018f3a1e-0000-7000-8000-0000000000b3';

/**
 * The shared DETAIL fixture carries placeholder ids for its units. These do
 * not, and that is load-bearing: the amendment is proved against the SHARED
 * contract before it leaves the device, so a line whose `uomId` is not a uuid
 * never reaches the wire at all — as this file discovered by writing one.
 */
const DRAFT_DETAIL = {
  ...DETAIL,
  status: 'DRAFT',
  legalNextStatuses: ['SUBMITTED', 'CANCELLED'],
  lines: [{ ...DETAIL.lines[0], uomId: UOM_TONNE }],
};

const DRAFT_TWO_LINES = {
  ...DRAFT_DETAIL,
  lineCount: 2,
  totalMinor: '580000',
  lines: [
    { ...DETAIL.lines[0], uomId: UOM_TONNE },
    {
      ...DETAIL.lines[0],
      purchaseOrderLineId: 'pol-2',
      lineNo: 2,
      productId: PRODUCT_2,
      skuCode: 'SKU-2',
      productName: 'Roofing sheet',
      uomId: UOM_SHEET,
      uomCode: 'SHEET',
      qtyScale: 0,
      qtyOrdered: '10',
      qtyReceived: '0',
      qtyOutstanding: '10',
      unitPriceE4: '130000000',
      lineNetMinor: '130000',
    },
  ],
};

const AMENDED = {
  purchaseOrderId: ORDER,
  status: 'DRAFT',
  expectedAt: null,
  notes: null,
  linesReplaced: true,
  lineCount: 1,
  totalMinor: '360000',
  lines: [
    {
      lineNo: 1,
      productId: PRODUCT,
      skuCode: 'SKU-1',
      uomId: 'u-tonne',
      uomCode: 'TONNE',
      qtyScale: 3,
      qtyOrdered: '4000',
      unitPriceE4: '900000000',
      stockingUomId: 'u-sack',
      stockingUomCode: 'SACK',
      qtyStockScale: 0,
      qtyOrderedStock: '80',
      factorNum: '20',
      factorDen: '1',
      lineNetMinor: '360000',
      notes: null,
    },
  ],
};

function draftRouter(
  detail: unknown,
  sent: Sent[] = [],
  amend: Answer = { ok: true, json: AMENDED },
): ApiFetch {
  return router(
    {
      'procurement.listPurchaseOrders': { ok: true, json: LIST },
      'procurement.purchaseOrder': { ok: true, json: detail },
      'procurement.reorderSuggestions': { ok: true, json: SUGGESTIONS_EMPTY },
      'procurement.listSuppliers': { ok: true, json: SUPPLIERS },
      'procurement.updatePurchaseOrder': amend,
    },
    sent,
  );
}

/** Open the order, then the correction form. */
async function openAmendForm(fetchFn: ApiFetch, db: LocalDb): Promise<void> {
  renderScreen(db, holding([CAPABILITY.purchaseOrderView, CAPABILITY.purchaseOrderCreate]), {
    endpoint: ENDPOINT,
    fetchFn,
  });
  fireEvent.click(await screen.findByRole('button', { name: /Northern Supply/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Correct this order' }));
  await screen.findByRole('form', { name: 'Correct this order' });
}

describe('a draft can be corrected; anything further along cannot', () => {
  it('offers the correction on a DRAFT to somebody who may raise orders', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.purchaseOrderView, CAPABILITY.purchaseOrderCreate]), {
      endpoint: ENDPOINT,
      fetchFn: draftRouter(DRAFT_DETAIL),
    });
    fireEvent.click(await screen.findByRole('button', { name: /Northern Supply/ }));
    expect(await screen.findByRole('button', { name: 'Correct this order' })).toBeDefined();
  });

  it('does NOT offer it once the order has been submitted, and says why', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.purchaseOrderView, CAPABILITY.purchaseOrderCreate]), {
      endpoint: ENDPOINT,
      // The shared DETAIL fixture is SUBMITTED.
      fetchFn: draftRouter(DETAIL),
    });
    fireEvent.click(await screen.findByRole('button', { name: /Northern Supply/ }));
    await screen.findByRole('button', { name: 'Cancel this order' });

    expect(screen.queryByRole('button', { name: 'Correct this order' })).toBeNull();
    // A missing button and "this can no longer be changed" are different
    // messages, and only the second stops somebody hunting for it.
    expect(
      screen.getByText(/has left draft, so its lines are frozen and cannot be corrected/),
    ).toBeDefined();
  });

  it('does NOT offer it to somebody who may only approve, even on a draft', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.purchaseOrderView, CAPABILITY.purchaseOrderApprove]), {
      endpoint: ENDPOINT,
      fetchFn: draftRouter(DRAFT_DETAIL),
    });
    fireEvent.click(await screen.findByRole('button', { name: /Northern Supply/ }));
    await screen.findByText(/Being written/);
    expect(screen.queryByRole('button', { name: 'Correct this order' })).toBeNull();
  });
});

describe('what a correction actually sends', () => {
  it('sends the amended quantity, and the UNTOUCHED rate exactly as it was agreed', async () => {
    const db = await device();
    const sent: Sent[] = [];
    await openAmendForm(draftRouter(DRAFT_DETAIL, sent), db);

    // Five tonnes was a typing slip; it should be four.
    fireEvent.change(screen.getByLabelText('Quantity ordered for Binder 50kg'), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save the correction' }));

    await waitFor(() =>
      expect(sent.some((s) => s.path === 'procurement.updatePurchaseOrder')).toBe(true),
    );
    const body = JSON.parse(
      sent.find((s) => s.path === 'procurement.updatePurchaseOrder')?.input ?? '{}',
    ) as { json: { purchaseOrderId: string; lines: { qtyOrdered: string; unitPriceE4: string }[] } };

    expect(body.json.purchaseOrderId).toBe(ORDER);
    expect(body.json.lines).toHaveLength(1);
    // Four tonnes at the unit's own scale — a scaled integer, not a float.
    expect(body.json.lines[0]?.qtyOrdered).toBe('4000');
    // THE POINT OF THE WHOLE ROW: the rate nobody touched goes back at its
    // own ×10⁴ precision, not re-parsed out of a box that shows it at the
    // currency's two decimals. Rounding for display and storing the rounded
    // figure is the one thing ADR-0004 forbids outright.
    expect(body.json.lines[0]?.unitPriceE4).toBe('900000000');
  });

  it('renumbers the lines that survive when one is taken off', async () => {
    const db = await device();
    const sent: Sent[] = [];
    await openAmendForm(draftRouter(DRAFT_TWO_LINES, sent), db);

    fireEvent.click(screen.getByRole('button', { name: 'Take Binder 50kg off this order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save the correction' }));

    await waitFor(() =>
      expect(sent.some((s) => s.path === 'procurement.updatePurchaseOrder')).toBe(true),
    );
    const body = JSON.parse(
      sent.find((s) => s.path === 'procurement.updatePurchaseOrder')?.input ?? '{}',
    ) as { json: { lines: { lineNo: number; productId: string }[] } };

    // Supplying the array REPLACES every line, so the survivor has to be
    // restated — and renumbered from one, because the contract will not take
    // a gap.
    expect(body.json.lines).toHaveLength(1);
    expect(body.json.lines[0]?.lineNo).toBe(1);
    expect(body.json.lines[0]?.productId).toBe(PRODUCT_2);
  });

  it('refuses to empty an order rather than sending nothing to buy', async () => {
    const db = await device();
    const sent: Sent[] = [];
    await openAmendForm(draftRouter(DRAFT_DETAIL, sent), db);

    fireEvent.click(screen.getByRole('button', { name: 'Take Binder 50kg off this order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save the correction' }));

    expect(await screen.findByText(/An order for nothing is not an order/)).toBeDefined();
    expect(sent.some((s) => s.path === 'procurement.updatePurchaseOrder')).toBe(false);
  });

  it('says nothing has changed rather than sending an empty amendment', async () => {
    const db = await device();
    const sent: Sent[] = [];
    await openAmendForm(draftRouter(DRAFT_DETAIL, sent), db);

    fireEvent.click(screen.getByRole('button', { name: 'Save the correction' }));
    expect(await screen.findByText(/Nothing has been changed/)).toBeDefined();
    expect(sent.some((s) => s.path === 'procurement.updatePurchaseOrder')).toBe(false);
  });

  it('OFFLINE, says the order still says what it said and that nothing was queued', async () => {
    // Amending is a change to a document that lives on the server. A queued
    // correction would be one nobody could see, beside an order still showing
    // the old figures — the worst of the three outcomes.
    const db = await device();
    const sent: Sent[] = [];
    await openAmendForm(draftRouter(DRAFT_DETAIL, sent, 'reject'), db);

    fireEvent.change(screen.getByLabelText('Quantity ordered for Binder 50kg'), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save the correction' }));

    expect(
      await screen.findByText(/Nothing was queued and the order still says what it said/),
    ).toBeDefined();
  });
});
