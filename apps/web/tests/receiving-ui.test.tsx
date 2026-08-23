// @vitest-environment jsdom
/**
 * The yard screen, tested for the four things it exists to get right.
 *
 * 1. **It works with the radio off.** The truck is at the gate and the bags
 *    are on the ground whether or not the tower is up. The receipt is written
 *    locally, nothing awaits a socket, and it drains on reconnect.
 * 2. **A variance is the ORDINARY path, not an error path.** The quantity
 *    field opens on what is outstanding, a short delivery is described in
 *    words as it is typed, and nothing has to be dismissed. A screen that
 *    treats a short delivery as a mistake is a screen a yard hand routes
 *    around — and a routed-around screen is a wrong ledger.
 * 3. **A copy is labelled as a copy.** The order list lives on the server;
 *    what the yard carries to the gate is a take-down stamped with the minute
 *    it was taken, and it is never rendered as a current figure.
 * 4. **A refused receipt is visible work.** The office refusing it means the
 *    goods are in the yard and the ledger does not know.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiCallOptions, ApiEndpoint, ApiFetch } from '../src/data/api/client';
import { CAPABILITY, type PermissionsState } from '../src/data/api/session';
import type { LocalDb } from '../src/data/db';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { Receiving } from '../src/features/receiving/Receiving';
import { recentReceipts } from '../src/data/queries/procurement-outbox';
import { readTakeDown, writeTakeDown, type TakeDown } from '../src/data/queries/takedown';
import { drainOutbox, readPendingOps, type UploadTransport } from '../src/data/sync/upload';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { provisionDevice, seedProduct, seedPurchaseUnit } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const ENDPOINT: ApiEndpoint = { url: 'http://api.test', bearer: 'dev' };
const LOC = '018f3a1e-0000-7000-8000-00000000aaaa';
const PRODUCT = '018f3a1e-0000-7000-8000-0000000000c1';
const SUPPLIER = '018f3a1e-0000-7000-8000-0000000000d1';
const ORDER = '018f3a1e-0000-7000-8000-0000000000e1';
const ORDER_LINE = '018f3a1e-0000-7000-8000-0000000000e2';
const UOM_TONNE = '018f3a1e-0000-7000-8000-0000000000b2';
const TAKEN_AT = Date.parse('2026-08-22T07:30:00.000Z');

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

/**
 * A yard that stocks in sacks and buys by the tonne, with three tonnes of one
 * order still outstanding when the copy was taken. Twenty sacks to the tonne.
 */
async function yard(): Promise<LocalDb> {
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
    toleranceBp: 500n,
  });
  return db;
}

const COPY: TakeDown = {
  takenDownAtMs: TAKEN_AT,
  locationId: LOC,
  suppliers: [{ supplierId: SUPPLIER, code: 'SUP-1', name: 'Northern Supply' }],
  orders: [
    {
      purchaseOrderId: ORDER,
      supplierId: SUPPLIER,
      supplierCode: 'SUP-1',
      supplierName: 'Northern Supply',
      deliverToLocationId: LOC,
      locationCode: 'OUT-01',
      statusAtTakeDown: 'APPROVED',
      orderDate: '2026-08-20',
      expectedAt: '2026-08-22',
      lines: [
        {
          purchaseOrderLineId: ORDER_LINE,
          lineNo: 1,
          productId: PRODUCT,
          skuCode: 'SKU-1',
          productName: 'Binder 50kg',
          uomId: UOM_TONNE,
          uomCode: 'TONNE',
          qtyScale: 3,
          qtyOrdered: 5000n,
          qtyOutstandingAtTakeDown: 3000n,
          stockingUomCode: 'SACK',
          qtyStockScale: 0,
          unitPriceE4: 9_000_000_000n,
        },
      ],
    },
  ],
};

const DEAD_FETCH: ApiFetch = () => Promise.reject(new Error('no radio'));

function acking(status: 'applied' | 'rejected', reason?: string): UploadTransport {
  return {
    send: (ops) =>
      Promise.resolve({
        ok: true,
        status: 200,
        acks: ops.map((op) => ({
          key: op.idempotencyKey,
          status,
          ...(reason === undefined ? {} : { reason }),
        })),
      }),
  };
}

function renderScreen(db: LocalDb, permissions: PermissionsState, apiOptions: ApiCallOptions) {
  return render(
    <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
      <Receiving db={db} permissions={permissions} apiOptions={apiOptions} />
    </CurrencyProvider>,
  );
}

/** Open the delivery form against the taken-down order, offline. */
async function openForm(db: LocalDb): Promise<void> {
  renderScreen(db, holding([CAPABILITY.goodsReceive]), {
    endpoint: ENDPOINT,
    fetchFn: DEAD_FETCH,
  });
  const row = await screen.findByRole('button', { name: /Northern Supply/ });
  fireEvent.click(row);
  await screen.findByRole('form', { name: 'Sign for a delivery' });
}

afterEach(cleanup);

describe('offline, the copy taken at the gate is offered AS A COPY', () => {
  it('says the server list is unavailable and stamps the copy with its time', async () => {
    const db = await yard();
    await writeTakeDown(db, COPY);
    renderScreen(db, holding([CAPABILITY.goodsReceive]), {
      endpoint: ENDPOINT,
      fetchFn: DEAD_FETCH,
    });

    expect(await screen.findByText(/Not available offline\./)).toBeDefined();
    // Never presented as current. The minute it was taken is on the page, and
    // so is the sentence saying what that means.
    expect(await screen.findByText(/Showing the copy taken at/)).toBeDefined();
    expect(
      screen.getByText(/what the orders said then, not what the office knows now/),
    ).toBeDefined();
    expect(screen.getByText(/From the copy taken at the gate/)).toBeDefined();
  });

  it('with no copy, says so plainly instead of showing an empty list', async () => {
    const db = await yard();
    renderScreen(db, holding([CAPABILITY.goodsReceive]), {
      endpoint: ENDPOINT,
      fetchFn: DEAD_FETCH,
    });

    expect(await screen.findByText(/No copy was taken for this yard/)).toBeDefined();
    // And it offers the honest way out rather than a dead end.
    expect(screen.getByText(/record it below as a delivery with no order/)).toBeDefined();
    expect(screen.queryByText(/Nothing is expected here/)).toBeNull();
  });

  it('lets a yard throw a copy it knows is wrong away, with no connection at all', async () => {
    // The one thing "take a fresh copy" cannot do offline. A partitioned yard
    // that learns its copy is false — the order was cancelled, the load was
    // diverted — must be able to stop showing it, and taking a new one needs
    // the server it cannot reach.
    const db = await yard();
    await writeTakeDown(db, COPY);
    renderScreen(db, holding([CAPABILITY.goodsReceive]), {
      endpoint: ENDPOINT,
      fetchFn: DEAD_FETCH,
    });

    expect(await screen.findByText(/Showing the copy taken at/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Throw this copy away/ }));

    // The copy is gone from the device, and the screen says what it says with
    // no copy — never an empty list that reads as "nothing is coming".
    expect(await screen.findByText(/No copy was taken for this yard/)).toBeDefined();
    expect(await readTakeDown(db, LOC)).toBeNull();
    // And the honest way out is still offered.
    expect(screen.getByText(/record it below as a delivery with no order/)).toBeDefined();
  });

  it('discards a copy taken for a different yard rather than using it', async () => {
    const db = await yard();
    await writeTakeDown(db, { ...COPY, locationId: '018f3a1e-0000-7000-8000-00000000bbbb' });
    renderScreen(db, holding([CAPABILITY.goodsReceive]), {
      endpoint: ENDPOINT,
      fetchFn: DEAD_FETCH,
    });
    // A receipt signed at the wrong yard moves stock at a counter that never
    // saw it — the same class of error as a sale filed against the wrong outlet.
    expect(await screen.findByText(/No copy was taken for this yard/)).toBeDefined();
    expect(screen.queryByText('Northern Supply')).toBeNull();
  });
});

describe('a variance is the ordinary path, typed and described', () => {
  it('opens on what was outstanding and shows the shelf figure the server will compute', async () => {
    const db = await yard();
    await writeTakeDown(db, COPY);
    await openForm(db);

    const qty = screen.getByLabelText('Quantity invoiced for Binder 50kg') as HTMLInputElement;
    // Three tonnes outstanding at the take-down, so the field opens there and
    // the common case is one tap.
    expect(qty.value).toBe('3');
    // …and 3 tonnes is 60 sacks, computed with the SAME expression the server
    // runs, so the yard sees the figure the ledger will get.
    expect(await screen.findByText(/60 SACK/)).toBeDefined();
    expect(screen.getByText(/Exactly what was outstanding/)).toBeDefined();
  });

  it('describes a SHORT delivery in words, with nothing to dismiss', async () => {
    const db = await yard();
    await writeTakeDown(db, COPY);
    await openForm(db);

    fireEvent.change(screen.getByLabelText('Quantity invoiced for Binder 50kg'), {
      target: { value: '2.5' },
    });

    expect(await screen.findByText(/Short of what was outstanding/)).toBeDefined();
    expect(screen.getByText(/0\.5 TONNE/)).toBeDefined();
    expect(screen.getByText(/nothing here has to balance/)).toBeDefined();
    // A short delivery is a fact, not a failure: no alert, no blocked submit.
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: /Sign for this delivery/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('describes an OVER delivery the same calm way', async () => {
    const db = await yard();
    await writeTakeDown(db, COPY);
    await openForm(db);

    fireEvent.change(screen.getByLabelText('Quantity invoiced for Binder 50kg'), {
      target: { value: '3.5' },
    });
    expect(await screen.findByText(/More than was outstanding/)).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('asks for a signature only when the count OVERRIDES the conversion', async () => {
    const db = await yard();
    await writeTakeDown(db, COPY);
    await openForm(db);

    // Accepting the conversion asks for nothing.
    expect(screen.queryByText(/You are signing for a count that differs/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Counted something else\?/ }));
    fireEvent.change(screen.getByLabelText('Counted quantity for Binder 50kg'), {
      target: { value: '56' },
    });

    expect(await screen.findByText(/You are signing for a count that differs/)).toBeDefined();
    // 56 against a computed 60 is four sacks out of sixty. The unit allows
    // 500bp — three sacks — so this one is past it, and the screen says the
    // office will be asked to look. That bound is measured by
    // cross-multiplication, never by dividing first.
    expect(screen.getByText(/the office will be asked to look at it/)).toBeDefined();
  });

  it('does not warn about a review when the override is inside the unit’s slack', async () => {
    const db = await yard();
    await writeTakeDown(db, COPY);
    await openForm(db);

    fireEvent.click(screen.getByRole('button', { name: /Counted something else\?/ }));
    fireEvent.change(screen.getByLabelText('Counted quantity for Binder 50kg'), {
      target: { value: '59' },
    });

    expect(await screen.findByText(/You are signing for a count that differs/)).toBeDefined();
    expect(screen.queryByText(/the office will be asked to look at it/)).toBeNull();
  });
});

describe('the receipt queues locally and drains on reconnect', () => {
  it('records with nothing awaiting a socket, then completes on the server’s ack', async () => {
    const db = await yard();
    await writeTakeDown(db, COPY);
    await openForm(db);

    fireEvent.change(screen.getByLabelText('Quantity invoiced for Binder 50kg'), {
      target: { value: '2.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Sign for this delivery/ }));

    // The confirmation says what actually happened — recorded HERE, not saved
    // at the office. That distinction is the whole of §8.5.
    expect(await screen.findByText(/Recorded on this device/)).toBeDefined();
    expect(screen.getByText(/waiting to send — it has not reached the office yet/)).toBeDefined();

    const pending = await readPendingOps(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe('goods_receipt');
    const queued = await recentReceipts(db);
    expect(queued[0]!.purchaseOrderId).toBe(ORDER);
    expect(queued[0]!.lines[0]!.purchaseOrderLineId).toBe(ORDER_LINE);
    // 2.5 tonnes invoiced, 50 sacks onto the shelf — both facts on the wire.
    expect(queued[0]!.lines[0]!.qtyReceived).toBe(2500n);
    expect(queued[0]!.lines[0]!.qtyStock).toBe(50n);
    expect(queued[0]!.lines[0]!.conversionConfirmed).toBe(false);
    expect(queued[0]!.syncState).toBe('pending');

    const report = await drainOutbox(db, acking('applied'));
    expect(report.completed).toBe(1);
    await waitFor(async () => {
      expect((await recentReceipts(db))[0]!.syncState).toBe('synced');
    });
  });

  it('carries the signature when the yard counted something else', async () => {
    const db = await yard();
    await writeTakeDown(db, COPY);
    await openForm(db);

    fireEvent.click(screen.getByRole('button', { name: /Counted something else\?/ }));
    fireEvent.change(screen.getByLabelText('Counted quantity for Binder 50kg'), {
      target: { value: '58' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Sign for this delivery/ }));

    await screen.findByText(/Recorded on this device/);
    const queued = await recentReceipts(db);
    expect(queued[0]!.lines[0]!.qtyReceived).toBe(3000n);
    expect(queued[0]!.lines[0]!.qtyStock).toBe(58n);
    // Without this the server refuses the line; with it always set, every line
    // would look signed for.
    expect(queued[0]!.lines[0]!.conversionConfirmed).toBe(true);
  });
});

describe('a refused receipt is visible work', () => {
  it('keeps the row and says the goods are still in the yard', async () => {
    const db = await yard();
    await writeTakeDown(db, COPY);
    await openForm(db);
    fireEvent.click(screen.getByRole('button', { name: /Sign for this delivery/ }));
    await screen.findByText(/Recorded on this device/);

    await drainOutbox(db, acking('rejected', 'BAD_REQUEST: receipt line numbers must be distinct'));
    db.changes.notify();

    expect(await screen.findByText(/The office refused this delivery/)).toBeDefined();
    expect(screen.getByText(/The goods are still in the yard/)).toBeDefined();
    expect(screen.getByText(/BAD_REQUEST: receipt line numbers must be distinct/)).toBeDefined();
  });
});

describe('who is offered the form', () => {
  it('is not offered to somebody who cannot sign for goods', async () => {
    const db = await yard();
    await writeTakeDown(db, COPY);
    renderScreen(db, holding([CAPABILITY.purchaseOrderApprove]), {
      endpoint: ENDPOINT,
      fetchFn: DEAD_FETCH,
    });
    // Approving an order and signing for its goods are deliberately held by
    // different people; holding the first offers nothing here.
    expect(await screen.findByText(/Signing for goods is not part of what you do/)).toBeDefined();
    expect(screen.queryByRole('form', { name: 'Sign for a delivery' })).toBeNull();
  });
});

describe('a delivery with no order', () => {
  it('is offered from the copy’s supplier list, and says so when there is none', async () => {
    const db = await yard();
    renderScreen(db, holding([CAPABILITY.goodsReceive]), {
      endpoint: ENDPOINT,
      fetchFn: DEAD_FETCH,
    });
    expect(
      await screen.findByText(/This device has no copy of the supplier list/),
    ).toBeDefined();

    cleanup();
    const db2 = await yard();
    await writeTakeDown(db2, COPY);
    renderScreen(db2, holding([CAPABILITY.goodsReceive]), {
      endpoint: ENDPOINT,
      fetchFn: DEAD_FETCH,
    });
    fireEvent.change(await screen.findByLabelText('Supplier who delivered'), {
      target: { value: SUPPLIER },
    });
    fireEvent.click(screen.getByRole('button', { name: /Record what turned up/ }));
    const form = await screen.findByRole('form', { name: 'Sign for a delivery' });
    expect(form.textContent).toContain('No order — recorded as it stands');
  });
});

// ---------------------------------------------------------------------------
// "Has this already been booked in?" — receiving.get and the receipt status
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DOUBLE-RECEIVE RISK IS A HUMAN ONE, AND THE SERVER CANNOT CLOSE IT
 * ═══════════════════════════════════════════════════════════════════════════
 * A replayed receipt carrying the same key is one receipt. Two people signing
 * for the same load with two different keys is TWO receipts, both of them
 * legitimate as far as the server can tell, and the only thing that stops it
 * is a screen that answers "has this already gone in?" before anybody signs.
 *
 * These tests would all fail if the wiring were removed: each one asserts a
 * real request went out on the wire and that the figures on the screen came
 * back from it.
 */
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

const RECEIPT = '018f3a1e-0000-7000-8000-0000000000f1';

const ORDER_HEADER = {
  purchaseOrderId: ORDER,
  supplierId: SUPPLIER,
  supplierCode: 'SUP-1',
  supplierName: 'Northern Supply',
  deliverToLocationId: LOC,
  locationCode: 'OUT-01',
  locationName: 'Main yard',
  orderNo: null,
  status: 'PARTIALLY_RECEIVED',
  orderDate: '2026-08-20',
  expectedAt: '2026-08-22',
  currencyCode: 'XTS',
  moneyScale: '100',
  submittedAt: null,
  approvedAt: '2026-08-20T12:00:00.000Z',
  closedAt: null,
  cancelledAt: null,
  cancelReason: null,
  notes: null,
  lineCount: 1,
  totalMinor: '450000',
};

const EXPECTED_LIST = {
  scope: { locationCount: 1, network: false },
  orderCount: 1,
  totalMinor: '450000',
  orders: [ORDER_HEADER],
  locations: [{ locationId: LOC, locationCode: 'OUT-01', locationName: 'Main yard' }],
};

/** Five tonnes ordered, two already in, three still to come. */
const RECEIPT_STATUS = {
  purchaseOrderId: ORDER,
  status: 'PARTIALLY_RECEIVED',
  supplierId: SUPPLIER,
  deliverToLocationId: LOC,
  isFullyReceived: false,
  lines: [
    {
      purchaseOrderLineId: ORDER_LINE,
      lineNo: 1,
      productId: PRODUCT,
      skuCode: 'SKU-1',
      productName: 'Binder 50kg',
      uomCode: 'TONNE',
      qtyScale: 3,
      qtyOrdered: '5000',
      qtyReceived: '2000',
      qtyOutstanding: '3000',
      stockingUomCode: 'SACK',
      qtyStockScale: 0,
      qtyOrderedStock: '100',
      qtyStockReceived: '40',
      isFullyReceived: false,
      receiptLineCount: '1',
    },
  ],
  receipts: [{ goodsReceiptId: RECEIPT, businessDate: '2026-08-21' }],
};

const ONE_RECEIPT = {
  goodsReceiptId: RECEIPT,
  purchaseOrderId: ORDER,
  supplierId: SUPPLIER,
  supplierName: 'Northern Supply',
  locationId: LOC,
  businessDate: '2026-08-21',
  receivedAt: '2026-08-21T09:15:00.000Z',
  supplierDeliveryNoteRef: 'DN-4471',
  supplierInvoiceRef: null,
  receivedByUserId: 'u1',
  notes: null,
  lines: [
    {
      goodsReceiptLineId: 'grl-1',
      lineNo: 1,
      purchaseOrderLineId: ORDER_LINE,
      productId: PRODUCT,
      skuCode: 'SKU-1',
      productName: 'Binder 50kg',
      uomCode: 'TONNE',
      qtyReceived: '2000',
      qtyReceivedScale: 3,
      stockingUomCode: 'SACK',
      qtyStock: '38',
      qtyStockComputed: '40',
      qtyStockScale: 0,
      factorNum: '20',
      factorDen: '1',
      conversionConfirmedBy: 'u1',
      deviationBp: '500',
      unitCostE4: '900000000',
      stockUnitCostE4: '45000000',
      lineNetMinor: '180000',
    },
  ],
};

const YARD_ONLINE: Readonly<Record<string, Answer>> = {
  'procurement.listPurchaseOrders': { ok: true, json: EXPECTED_LIST },
  'receiving.purchaseOrderReceiptStatus': { ok: true, json: RECEIPT_STATUS },
  'receiving.get': { ok: true, json: ONE_RECEIPT },
};

describe('has this already been booked in?', () => {
  it('asks the server for what is outstanding against THIS order and shows it', async () => {
    const db = await yard();
    const sent: Sent[] = [];
    renderScreen(db, holding([CAPABILITY.goodsReceive, CAPABILITY.purchaseOrderView]), {
      endpoint: ENDPOINT,
      fetchFn: router(YARD_ONLINE, sent),
    });

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'What has already come in against the order of 2026-08-20',
      }),
    );

    // The request actually went out, carrying THIS order's id. Remove the
    // wiring and there is nothing on the wire to find.
    await waitFor(() =>
      expect(sent.some((s) => s.path === 'receiving.purchaseOrderReceiptStatus')).toBe(true),
    );
    const asked = sent.find((s) => s.path === 'receiving.purchaseOrderReceiptStatus');
    expect(asked?.input).toContain(ORDER);

    // Ordered, already in, and what remains — in the unit it was ordered in,
    // which is the unit on the delivery note in the yard hand's hand.
    expect(await screen.findByText(/3 TONNE short/)).toBeDefined();
    expect(screen.getByText(/Some of this order is still outstanding/)).toBeDefined();
    expect(screen.getByText(/Signed for on 2026-08-21/)).toBeDefined();
  });

  it('opens a posted receipt and shows invoiced against counted, with the difference', async () => {
    const db = await yard();
    const sent: Sent[] = [];
    renderScreen(db, holding([CAPABILITY.goodsReceive, CAPABILITY.purchaseOrderView]), {
      endpoint: ENDPOINT,
      fetchFn: router(YARD_ONLINE, sent),
    });

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'What has already come in against the order of 2026-08-20',
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Signed for on 2026-08-21/ }));

    await waitFor(() => expect(sent.some((s) => s.path === 'receiving.get')).toBe(true));
    expect(sent.find((s) => s.path === 'receiving.get')?.input).toContain(RECEIPT);

    // 2 tonnes invoiced, 38 sacks counted where the conversion said 40 — the
    // deviation is shown as a fact, not as an error.
    expect(await screen.findByText(/DN-4471/)).toBeDefined();
    expect(screen.getByText(/38 SACK/)).toBeDefined();
    expect(screen.getByText(/5% from 40 SACK, signed for/)).toBeDefined();
  });

  it('OFFLINE, says it cannot answer — and never falls back to the copy taken at the gate', async () => {
    // The one figure that must never be stale. Somebody is about to decide
    // "it has not gone in yet" from it, and the take-down is a document from
    // earlier in the day that another yard's receipt would not be in.
    const db = await yard();
    await writeTakeDown(db, COPY);
    renderScreen(db, holding([CAPABILITY.goodsReceive, CAPABILITY.purchaseOrderView]), {
      endpoint: ENDPOINT,
      fetchFn: DEAD_FETCH,
    });

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'What has already come in against the order of 2026-08-20',
      }),
    );

    expect(
      await screen.findByText(/What has already been booked in against this order/),
    ).toBeDefined();
    expect(screen.getByText(/The copy taken at the gate cannot answer this/)).toBeDefined();
    // No table of figures at all, and specifically not the copy's own
    // outstanding quantity dressed up as the current one.
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(/3 TONNE short/)).toBeNull();
  });

  it('says plainly when NOTHING has been signed for against the order yet', async () => {
    const db = await yard();
    renderScreen(db, holding([CAPABILITY.goodsReceive, CAPABILITY.purchaseOrderView]), {
      endpoint: ENDPOINT,
      fetchFn: router({
        ...YARD_ONLINE,
        'receiving.purchaseOrderReceiptStatus': {
          ok: true,
          json: { ...RECEIPT_STATUS, receipts: [] },
        },
      }),
    });

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'What has already come in against the order of 2026-08-20',
      }),
    );
    // An empty list would read as "I could not tell". This says which.
    expect(
      await screen.findByText(/Nothing has been signed for against this order yet/),
    ).toBeDefined();
  });

  it('an OVER-delivery is said to be one, never clamped to nothing outstanding', async () => {
    const db = await yard();
    renderScreen(db, holding([CAPABILITY.goodsReceive, CAPABILITY.purchaseOrderView]), {
      endpoint: ENDPOINT,
      fetchFn: router({
        ...YARD_ONLINE,
        'receiving.purchaseOrderReceiptStatus': {
          ok: true,
          json: {
            ...RECEIPT_STATUS,
            isFullyReceived: true,
            lines: [
              {
                ...RECEIPT_STATUS.lines[0],
                qtyReceived: '6000',
                qtyOutstanding: '-1000',
                isFullyReceived: true,
              },
            ],
          },
        },
      }),
    });

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'What has already come in against the order of 2026-08-20',
      }),
    );
    // A supplier will invoice for the extra tonne. Hiding it hides the bill.
    expect(await screen.findByText(/1 TONNE over/)).toBeDefined();
    expect(screen.getByText(/Anything more against it is an over-delivery/)).toBeDefined();
  });
});
