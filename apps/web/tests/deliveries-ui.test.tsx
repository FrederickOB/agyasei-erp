// @vitest-environment jsdom
/**
 * The delivery screen, tested for what ADR-0001 forbids and what it promised.
 *
 * **FORBIDS:** a fleet. There is no vehicle, driver, registration, fuel or
 * servicing anywhere in this feature. A carrier is a SUPPLIER holding a
 * capability whose platform kind is HAULAGE, and the tests below check the
 * rendered tree for fleet vocabulary rather than trusting a code review.
 *
 * **PROMISED:** that distribution cost as a percentage of revenue would be
 * measurable. That rests on the freight figure being honest, so a delivery
 * with nothing agreed renders an ABSENCE — a zero would read as a free
 * delivery and would flatter exactly the number open-questions Q1 depends on.
 *
 * The rest is the split between the two writes. Booking a load commits the
 * business to a carrier the server has to check, so it is online-only and says
 * so. A status move is recorded by whoever hears from the driver, so it rides
 * the outbox — and while one is queued the row shows the status it WILL have,
 * because rendering the server's older status beside a queued move is how the
 * same move gets recorded twice.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DELIVERY_TRANSITIONS, legalDeliveryNextStatuses } from '@erp/contracts';
import type { ApiCallOptions, ApiEndpoint, ApiFetch } from '../src/data/api/client';
import { CAPABILITY, type PermissionsState } from '../src/data/api/session';
import type { LocalDb } from '../src/data/db';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { Deliveries } from '../src/features/deliveries/Deliveries';
import {
  DeliveryReasonRequiredError,
  DeliveryStatusUnchangedError,
  buildDeliveryStatusPayload,
} from '../src/data/mutations/updateDeliveryStatus';
import { recentDeliveryUpdates } from '../src/data/queries/procurement-outbox';
import { drainOutbox, readPendingOps, type UploadTransport } from '../src/data/sync/upload';
import { WIRE_KINDS } from '../src/data/sync/transport';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { fixedHlc, provisionDevice, seedProduct } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const ENDPOINT: ApiEndpoint = { url: 'http://api.test', bearer: 'dev' };
const LOC = '018f3a1e-0000-7000-8000-00000000aaaa';
const PRODUCT = '018f3a1e-0000-7000-8000-0000000000c1';
const CARRIER = '018f3a1e-0000-7000-8000-0000000000d2';
const ORDER = '018f3a1e-0000-7000-8000-0000000000e1';
const DELIVERY = '018f3a1e-0000-7000-8000-0000000000a1';
const UPDATE = '018f3a1e-0000-7000-8000-0000000000a2';

type Answer = { ok: true; json: unknown } | 'reject';

function router(answers: Readonly<Record<string, Answer>>, sent: string[] = []): ApiFetch {
  return (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/trpc/', '');
    sent.push(`${path}:${init.body ?? parsed.searchParams.get('input') ?? ''}`);
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

function delivery(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deliveryId: DELIVERY,
    sourceKind: 'PURCHASE_ORDER',
    sourceId: ORDER,
    carrierSupplierId: CARRIER,
    carrierName: 'Road Partners',
    carrierReference: 'RP-4471',
    fromLocationId: null,
    toLocationId: LOC,
    toAddressText: null,
    costLocationId: LOC,
    status: 'PLANNED',
    plannedFor: '2026-08-24',
    dispatchedAt: null,
    deliveredAt: null,
    failedReason: null,
    freightCostMinor: '120000',
    currencyCode: 'XTS',
    moneyScale: '100',
    notes: null,
    ...over,
  };
}

function listOf(rows: readonly unknown[]): unknown {
  return {
    scope: { locationCount: 1 },
    deliveryCount: rows.length,
    deliveries: rows,
  };
}

const CARRIERS = {
  supplierCount: 1,
  suppliers: [
    {
      supplierId: CARRIER,
      code: 'HAU-1',
      name: 'Road Partners',
      paymentTermsDays: 0,
      currencyCode: 'XTS',
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      addressText: null,
      notes: null,
      isActive: true,
      capabilities: [{ capabilityTypeId: 'ct-2', code: 'HAULS', name: 'Moves goods', kind: 'HAULAGE' }],
    },
  ],
  capabilityTypes: [],
};

const ORDERS = {
  scope: { locationCount: 1, network: false },
  orderCount: 1,
  totalMinor: '450000',
  orders: [
    {
      purchaseOrderId: ORDER,
      supplierId: '018f3a1e-0000-7000-8000-0000000000d1',
      supplierCode: 'SUP-1',
      supplierName: 'Northern Supply',
      deliverToLocationId: LOC,
      locationCode: 'OUT-01',
      locationName: 'Main yard',
      orderNo: null,
      status: 'APPROVED',
      orderDate: '2026-08-20',
      expectedAt: null,
      currencyCode: 'XTS',
      moneyScale: '100',
      submittedAt: null,
      approvedAt: '2026-08-21T09:00:00.000Z',
      closedAt: null,
      cancelledAt: null,
      cancelReason: null,
      notes: null,
      lineCount: 1,
      totalMinor: '450000',
    },
  ],
  locations: [{ locationId: LOC, locationCode: 'OUT-01', locationName: 'Main yard' }],
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
  return db;
}

function renderScreen(db: LocalDb, permissions: PermissionsState, apiOptions: ApiCallOptions) {
  return render(
    <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
      <Deliveries db={db} permissions={permissions} apiOptions={apiOptions} />
    </CurrencyProvider>,
  );
}

function ready(rows: readonly unknown[]): Readonly<Record<string, Answer>> {
  return {
    'logistics.list': { ok: true, json: listOf(rows) },
    'procurement.listSuppliers': { ok: true, json: CARRIERS },
    'procurement.listPurchaseOrders': { ok: true, json: ORDERS },
  };
}

const acking = (status: 'applied' | 'rejected', reason?: string): UploadTransport => ({
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
});

afterEach(cleanup);

describe('ADR-0001: a carrier is a supplier, and there is no fleet here', () => {
  it('renders the counterparty and no vehicle vocabulary at all', async () => {
    const db = await device();
    const { container } = renderScreen(
      db,
      holding([CAPABILITY.deliveryView, CAPABILITY.dispatchManage]),
      { endpoint: ENDPOINT, fetchFn: router(ready([delivery()])) },
    );

    const list = await screen.findByRole('list', { name: 'Deliveries' });
    expect(list.textContent).toContain('Road Partners');
    expect(list.textContent).toContain('RP-4471');

    const text = (container.textContent ?? '').toLowerCase();
    for (const word of ['vehicle', 'truck', 'driver', 'registration', 'odometer', 'fuel', 'mileage']) {
      expect(text).not.toContain(word);
    }
  });

  it('picks the haulier by the PLATFORM capability kind, never by a tenant code', async () => {
    const db = await device();
    const sent: string[] = [];
    renderScreen(db, holding([CAPABILITY.deliveryView, CAPABILITY.dispatchManage]), {
      endpoint: ENDPOINT,
      fetchFn: router(ready([]), sent),
    });
    await screen.findByRole('button', { name: /Hand a load to a haulier/ });
    await waitFor(() => expect(sent.some((s) => s.includes('HAULAGE'))).toBe(true));
    expect(sent.some((s) => s.includes('HAULS'))).toBe(false);
  });
});

describe('freight that nobody agreed is an absence, never a zero', () => {
  it('says Not agreed rather than printing nothing-as-a-figure', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.deliveryView]), {
      endpoint: ENDPOINT,
      fetchFn: router(ready([delivery({ freightCostMinor: null })])),
    });

    const list = await screen.findByRole('list', { name: 'Deliveries' });
    expect(list.textContent).toContain('Not agreed');
    expect(list.textContent).not.toContain('0.00');
  });

  it('renders an agreed figure through the tenant’s own currency configuration', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.deliveryView]), {
      endpoint: ENDPOINT,
      fetchFn: router(ready([delivery()])),
    });
    const list = await screen.findByRole('list', { name: 'Deliveries' });
    expect(list.textContent).toContain('1200.00');
  });
});

describe('the moves offered are the ones the machine allows', () => {
  it('offers exactly the contract’s legal next steps from PLANNED', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.deliveryView, CAPABILITY.dispatchManage]), {
      endpoint: ENDPOINT,
      fetchFn: router(ready([delivery()])),
    });
    await screen.findByRole('list', { name: 'Deliveries' });
    expect(legalDeliveryNextStatuses('PLANNED')).toEqual(['DISPATCHED', 'CANCELLED']);
    expect(screen.getByRole('button', { name: 'It has left' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Cancel it' })).toBeDefined();
    // DELIVERED is not reachable from PLANNED, so it is not offered — a move
    // the database refuses would be queued and retried for ever.
    expect(screen.queryByRole('button', { name: 'It arrived' })).toBeNull();
  });

  it('offers nothing at all on a terminal delivery', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.deliveryView, CAPABILITY.dispatchManage]), {
      endpoint: ENDPOINT,
      fetchFn: router(ready([delivery({ status: 'DELIVERED', deliveredAt: '2026-08-24T11:00:00.000Z' })])),
    });
    await screen.findByRole('list', { name: 'Deliveries' });
    expect(DELIVERY_TRANSITIONS.DELIVERED).toEqual([]);
    expect(screen.queryByRole('button', { name: /It arrived|It has left|Cancel it/ })).toBeNull();
  });

  it('offers no move at all to somebody who may only watch', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.deliveryView]), {
      endpoint: ENDPOINT,
      fetchFn: router(ready([delivery()])),
    });
    await screen.findByRole('list', { name: 'Deliveries' });
    expect(screen.queryByRole('button', { name: 'It has left' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Hand a load to a haulier/ })).toBeNull();
  });
});

describe('a status move rides the outbox', () => {
  it('queues locally, shows the status it WILL have, and drains on reconnect', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.deliveryView, CAPABILITY.dispatchManage]), {
      endpoint: ENDPOINT,
      fetchFn: router(ready([delivery()])),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'It has left' }));

    await waitFor(async () => {
      expect(await readPendingOps(db)).toHaveLength(1);
    });
    const pending = await readPendingOps(db);
    expect(pending[0]!.kind).toBe('delivery_status');
    expect(WIRE_KINDS['delivery_status']).toBe('logistics.update_delivery_status');

    // The row shows the queued status, not the server's older one — otherwise
    // the person who just recorded it records it again. Scoped to the list,
    // because this device's own record of the move is shown separately below.
    const list = await screen.findByRole('list', { name: 'Deliveries' });
    expect(await within(list).findByText('Left with the haulier')).toBeDefined();
    expect(await within(list).findByText('Waiting to send')).toBeDefined();

    // And it is on the device's own sent list too, which is a LOCAL read and
    // is the thing that still answers when the server's list does not.
    const own = await screen.findByRole('list', { name: 'Updates recorded on this device' });
    expect(within(own).getByText('Left with the haulier')).toBeDefined();

    const report = await drainOutbox(db, acking('applied'));
    expect(report.completed).toBe(1);
    expect((await recentDeliveryUpdates(db))[0]!.syncState).toBe('synced');
  });

  it('surfaces a refusal as work rather than as silence', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.deliveryView, CAPABILITY.dispatchManage]), {
      endpoint: ENDPOINT,
      fetchFn: router(ready([delivery()])),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'It has left' }));
    await waitFor(async () => {
      expect(await readPendingOps(db)).toHaveLength(1);
    });

    await drainOutbox(db, acking('rejected', 'BAD_REQUEST: a failed delivery requires a reason'));
    db.changes.notify();

    expect(await screen.findByText(/The office refused this update/)).toBeDefined();
    expect(
      screen.getAllByText(/BAD_REQUEST: a failed delivery requires a reason/).length,
    ).toBeGreaterThan(0);

    // AND it is still visible on the device's own sent list, which is the
    // point: the server's list shows the OLD status with nothing to suggest
    // anybody tried to change it, so a refusal that lived only on the row
    // would vanish the moment the row scrolled or the list refreshed.
    const own = await screen.findByRole('list', { name: 'Updates recorded on this device' });
    expect(within(own).getByText(/The office refused this one/)).toBeDefined();
  });
});

describe('booking a load is online only, and says so', () => {
  it('refuses when the radio is dead and promises the haulier nothing', async () => {
    const db = await device();
    let live = true;
    const fetchFn: ApiFetch = (url, init) => {
      const parsed = new URL(url);
      const path = parsed.pathname.replace('/trpc/', '');
      const answers = ready([delivery()]);
      const answer = answers[path];
      if (!live || answer === undefined || answer === 'reject') {
        return Promise.reject(new Error('no radio'));
      }
      void init;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: { data: { json: answer.json } } }),
      });
    };
    renderScreen(db, holding([CAPABILITY.deliveryView, CAPABILITY.dispatchManage]), {
      endpoint: ENDPOINT,
      fetchFn,
    });

    fireEvent.click(await screen.findByRole('button', { name: /Hand a load to a haulier/ }));
    await screen.findByRole('form', { name: 'Hand a load to a haulier' });
    fireEvent.change(screen.getByLabelText('Order to move'), { target: { value: ORDER } });
    fireEvent.change(screen.getByLabelText('Haulier'), { target: { value: CARRIER } });

    live = false;
    fireEvent.click(screen.getByRole('button', { name: 'Book it with them' }));

    expect(
      await screen.findByText(/Nothing was queued, so nothing has been promised to a haulier/),
    ).toBeDefined();
    // And nothing was written locally either.
    expect(await readPendingOps(db)).toHaveLength(0);
  });
});

describe('offline', () => {
  it('says unavailable rather than showing an empty road', async () => {
    const db = await device();
    renderScreen(db, holding([CAPABILITY.deliveryView]), {
      endpoint: ENDPOINT,
      fetchFn: () => Promise.reject(new Error('down')),
    });
    expect(await screen.findByText(/Not available offline\./)).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Deliveries' })).toBeNull();
    expect(screen.queryByText(/Nothing is on the road for this place/)).toBeNull();
  });
});

describe('the queued write refuses what the server would only answer CONFLICT to', () => {
  it('refuses a move to the status it is already in', () => {
    expect(() =>
      buildDeliveryStatusPayload({
        updateId: UPDATE,
        deliveryId: DELIVERY,
        fromStatus: 'DISPATCHED',
        toStatus: 'DISPATCHED',
        createdAt: '2026-08-22T09:00:00.000Z',
      }),
    ).toThrow(DeliveryStatusUnchangedError);
  });

  it('refuses a failure with no explanation, as the shared contract does', () => {
    expect(() =>
      buildDeliveryStatusPayload({
        updateId: UPDATE,
        deliveryId: DELIVERY,
        fromStatus: 'DISPATCHED',
        toStatus: 'FAILED',
        createdAt: '2026-08-22T09:00:00.000Z',
      }),
    ).toThrow(DeliveryReasonRequiredError);
  });

  it('builds bytes the shared contract accepts when the reason is there', () => {
    const built = buildDeliveryStatusPayload({
      updateId: UPDATE,
      deliveryId: DELIVERY,
      fromStatus: 'DISPATCHED',
      toStatus: 'FAILED',
      reason: 'The bridge at the junction was closed.',
      createdAt: '2026-08-22T09:00:00.000Z',
    });
    expect(built.payload.toStatus).toBe('FAILED');
    expect(built.payload.reason).toMatch(/bridge/);
    expect(JSON.parse(built.payloadJson)).toMatchObject({ deliveryId: DELIVERY });
  });

  it('is one write per move — a fresh key, never a replayed one', async () => {
    const db = await device();
    const { recordDeliveryStatus } = await import('../src/data/mutations/updateDeliveryStatus');
    await recordDeliveryStatus(db, {
      updateId: UPDATE,
      deliveryId: DELIVERY,
      fromStatus: 'PLANNED',
      toStatus: 'DISPATCHED',
      hlc: fixedHlc(),
      nowIso: '2026-08-22T09:00:00.000Z',
    });
    await recordDeliveryStatus(db, {
      updateId: '018f3a1e-0000-7000-8000-0000000000a3',
      deliveryId: DELIVERY,
      fromStatus: 'DISPATCHED',
      toStatus: 'DELIVERED',
      hlc: fixedHlc(),
      nowIso: '2026-08-22T10:00:00.000Z',
    });
    const queued = await recentDeliveryUpdates(db);
    expect(queued.map((q) => q.toStatus)).toEqual(['DELIVERED', 'DISPATCHED']);
  });
});

// ---------------------------------------------------------------------------
// Asking the office about ONE load
// ---------------------------------------------------------------------------

describe('checking one load with the office', () => {
  it('re-reads that delivery by id and shows what the office actually holds', async () => {
    const db = await device();
    const asked: string[] = [];
    const fetchFn: ApiFetch = (url) => {
      const path = new URL(url).pathname.replace('/trpc/', '');
      asked.push(path);
      const answers: Readonly<Record<string, Answer>> = {
        ...ready([delivery()]),
        // The office moved on since the list was taken: another device
        // recorded the dispatch, and this one has no idea.
        'logistics.get': {
          ok: true,
          json: delivery({
            status: 'DISPATCHED',
            dispatchedAt: '2026-08-23T07:40:00.000Z',
            notes: 'Loaded at the depot gate.',
          }),
        },
      };
      const answer = answers[path];
      if (answer === undefined || answer === 'reject') return Promise.reject(new Error('no radio'));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: { data: { json: answer.json } } }),
      });
    };
    renderScreen(db, holding([CAPABILITY.deliveryView, CAPABILITY.dispatchManage]), {
      endpoint: ENDPOINT,
      fetchFn,
    });

    await screen.findByRole('list', { name: 'Deliveries' });
    // NOTHING is asked per row on render: this is a load somebody is standing
    // in front of, and a screen that quietly re-asked for every row would be
    // unusable on the link these outlets actually have.
    expect(asked).not.toContain('logistics.get');

    fireEvent.click(screen.getByRole('button', { name: /Check with the office/ }));

    const record = await screen.findByRole('group', {
      name: 'What the office holds for Road Partners',
    });
    expect(within(record).getByText('Left with the haulier')).toBeDefined();
    expect(within(record).getByText('2026-08-23T07:40:00.000Z')).toBeDefined();
    expect(within(record).getByText('Loaded at the depot gate.')).toBeDefined();
    expect(asked).toContain('logistics.get');
  });

  it('says it could not ask rather than passing off the list’s older copy as current', async () => {
    const db = await device();
    const fetchFn: ApiFetch = (url) => {
      const path = new URL(url).pathname.replace('/trpc/', '');
      // Everything answers except the by-id read: the list is on the screen
      // and looks fine, which is exactly when a stale figure is dangerous.
      const answers = ready([delivery()]);
      const answer = answers[path];
      if (answer === undefined || answer === 'reject') return Promise.reject(new Error('no radio'));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: { data: { json: answer.json } } }),
      });
    };
    renderScreen(db, holding([CAPABILITY.deliveryView, CAPABILITY.dispatchManage]), {
      endpoint: ENDPOINT,
      fetchFn,
    });

    await screen.findByRole('list', { name: 'Deliveries' });
    fireEvent.click(screen.getByRole('button', { name: /Check with the office/ }));

    expect(
      await screen.findByText(/What the office holds for this load/),
    ).toBeDefined();
    expect(
      screen.queryByRole('group', { name: 'What the office holds for Road Partners' }),
    ).toBeNull();
  });
});
