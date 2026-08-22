// @vitest-environment jsdom
/**
 * The low-stock screen, tested for the confusion it exists to prevent.
 *
 * An empty list means "stock is healthy" in one world and "nobody has said
 * what low means here" in another. They are different facts, and the second
 * one dressed as the first is how a stock-out is missed — the screen
 * reassures somebody about a question nobody asked. There is a third case
 * too: the device could not find out, which is not a tie-breaker between the
 * other two.
 *
 * The other half of this file is the courtesy boundary: counter staff read
 * the list and are not offered the control that changes a threshold. That is
 * a courtesy — the server refuses the write regardless — and it is tested as
 * one, never as a security property.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiCallOptions, ApiEndpoint, ApiFetch } from '../src/data/api/client';
import { CAPABILITY, type PermissionsState } from '../src/data/api/session';
import type { LocalDb } from '../src/data/db';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { LowStock } from '../src/features/stock/LowStock';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { provisionDevice, seedProduct } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const ENDPOINT: ApiEndpoint = { url: 'http://api.test', bearer: 'dev' };
const LOC = '018f3a1e-0000-7000-8000-00000000aaaa';
/** Real UUIDs: the shared contract requires them, so a fixture that used
 *  'p-1' would be a fixture the API could never have accepted. */
const PRODUCT = '018f3a1e-0000-7000-8000-0000000000c1';

const LOCATION_ROW = {
  locationId: LOC,
  locationCode: 'OUT-01',
  locationName: 'Main counter',
};

function alert(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    locationId: LOC,
    reorderPointId: 'rp-1',
    productId: PRODUCT,
    skuCode: 'SKU-1',
    productName: 'Cement 50kg',
    qtyOnHand: '4',
    reorderPointQty: '20',
    reorderUpToQty: '80',
    shortfallQty: '16',
    leadTimeDays: 3,
    qtyScale: 0,
    uomCode: 'BAG',
    coverageBp: '2000',
    ...over,
  };
}

function lowStockPayload(alerts: readonly unknown[]): unknown {
  return {
    scope: { locationCount: 1 },
    alertCount: alerts.length,
    alerts,
    locations: [{ ...LOCATION_ROW, alertCount: alerts.length }],
  };
}

function reorderPointsPayload(count: number): unknown {
  return {
    locationId: LOC,
    points: Array.from({ length: count }, (_, i) => ({
      reorderPointId: `rp-${String(i)}`,
      productId: `018f3a1e-0000-7000-8000-00000000000${String(i)}`,
      skuCode: `SKU-${String(i)}`,
      productName: `Product ${String(i)}`,
      reorderPointQty: '20',
      reorderUpToQty: null,
      leadTimeDays: null,
      qtyOnHand: '30',
      isLow: false,
      isActive: true,
      qtyScale: 0,
      uomCode: 'BAG',
    })),
  };
}

type Answer = { ok: true; json: unknown } | { ok: false; status: number; message: string } | 'reject';

function router(answers: Readonly<Record<string, Answer>>, asked: string[] = []): ApiFetch {
  return (url) => {
    const path = new URL(url).pathname.replace('/trpc/', '');
    asked.push(path);
    const answer = answers[path];
    if (answer === undefined || answer === 'reject') {
      return Promise.reject(new Error('no radio'));
    }
    if (!answer.ok) {
      return Promise.resolve({
        ok: false,
        status: answer.status,
        json: () =>
          Promise.resolve({ error: { json: { message: answer.message, data: { code: 'FORBIDDEN' } } } }),
      });
    }
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

async function till(): Promise<LocalDb> {
  const db = openTestDb();
  const device = await provisionDevice(db, { locationId: LOC, locationCode: 'OUT-01' });
  await seedProduct(db, {
    code: 'SKU-9',
    name: 'Roofing sheet',
    uomLabel: 'sheet',
    unitPriceE4: 100_0000n,
    priceListId: device.priceListId,
  });
  return db;
}

function renderScreen(db: LocalDb, permissions: PermissionsState, apiOptions: ApiCallOptions) {
  return render(
    <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
      <LowStock db={db} permissions={permissions} apiOptions={apiOptions} />
    </CurrencyProvider>,
  );
}

afterEach(cleanup);

describe('an empty list is not one fact', () => {
  it('says NO THRESHOLDS have been set, and does not say stock is healthy', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'inventory.lowStock': { ok: true, json: lowStockPayload([]) },
        'inventory.reorderPoints': { ok: true, json: reorderPointsPayload(0) },
      }),
    };
    renderScreen(db, holding([CAPABILITY.stockView, CAPABILITY.reorderManage]), opts);

    expect(await screen.findByText(/No thresholds have been set here yet/)).toBeDefined();
    expect(screen.getByText(/it is a report that nobody has asked the question/)).toBeDefined();
    expect(screen.queryByText(/Nothing is below its threshold/)).toBeNull();
  });

  it('says stock IS healthy only when thresholds actually exist', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'inventory.lowStock': { ok: true, json: lowStockPayload([]) },
        'inventory.reorderPoints': { ok: true, json: reorderPointsPayload(7) },
      }),
    };
    renderScreen(db, holding([CAPABILITY.stockView]), opts);

    expect(await screen.findByText(/Nothing is below its threshold/)).toBeDefined();
    expect(screen.getByText(/All 7 products with a threshold/)).toBeDefined();
    expect(screen.queryByText(/No thresholds have been set here yet/)).toBeNull();
  });

  it('says it could not check when the threshold list could not be fetched', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'inventory.lowStock': { ok: true, json: lowStockPayload([]) },
        'inventory.reorderPoints': 'reject',
      }),
    };
    renderScreen(db, holding([CAPABILITY.stockView]), opts);

    expect(await screen.findByText(/This device could not check/)).toBeDefined();
    expect(screen.getByText(/This is not a report that nothing is low/)).toBeDefined();
    expect(screen.queryByText(/Nothing is below its threshold/)).toBeNull();
  });
});

describe('offline', () => {
  it('says unavailable offline, and shows neither an empty list nor a stale one', async () => {
    const db = await till();
    const opts: ApiCallOptions = { endpoint: ENDPOINT, fetchFn: () => Promise.reject(new Error('down')) };
    renderScreen(db, holding([CAPABILITY.stockView]), opts);

    expect(await screen.findByText(/Not available offline\./)).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Low stock' })).toBeNull();
    expect(screen.queryByText(/Nothing is below its threshold/)).toBeNull();
    expect(screen.queryByText(/No thresholds have been set here yet/)).toBeNull();
  });
});

describe('the list itself', () => {
  it('keeps the server’s urgency order and shows each quantity in its stocking unit', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'inventory.lowStock': {
          ok: true,
          json: lowStockPayload([
            alert({ reorderPointId: 'rp-gone', productName: 'Sand', qtyOnHand: '0', shortfallQty: '20', coverageBp: '0' }),
            alert({ reorderPointId: 'rp-low', productName: 'Cement 50kg' }),
          ]),
        },
        'inventory.reorderPoints': { ok: true, json: reorderPointsPayload(2) },
      }),
    };
    renderScreen(db, holding([CAPABILITY.stockView]), opts);

    const list = await screen.findByRole('list', { name: 'Low stock' });
    const names = [...list.querySelectorAll('.report-loc-name')].map((n) => n.textContent);
    expect(names).toEqual(['Sand', 'Cement 50kg']);
    // Nothing left is a different badge from merely below the line.
    expect(screen.getByText('None left')).toBeDefined();
    expect(screen.getByText('Below threshold')).toBeDefined();
    expect(screen.getAllByText(/20 BAG/).length).toBeGreaterThan(0);
  });
});

describe('who is offered the control', () => {
  it('offers a manager the threshold control', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'inventory.lowStock': { ok: true, json: lowStockPayload([alert()]) },
        'inventory.reorderPoints': { ok: true, json: reorderPointsPayload(1) },
      }),
    };
    renderScreen(db, holding([CAPABILITY.stockView, CAPABILITY.reorderManage]), opts);
    expect(await screen.findByRole('button', { name: 'Change threshold' })).toBeDefined();
  });

  it('does not offer it to counter staff — a courtesy, not the boundary', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'inventory.lowStock': { ok: true, json: lowStockPayload([alert()]) },
        'inventory.reorderPoints': { ok: true, json: reorderPointsPayload(1) },
      }),
    };
    renderScreen(db, holding([CAPABILITY.stockView]), opts);

    await screen.findByRole('list', { name: 'Low stock' });
    expect(screen.queryByRole('button', { name: 'Change threshold' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Set a threshold/ })).toBeNull();
  });

  it('tells counter staff who can set one, rather than nothing at all', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'inventory.lowStock': { ok: true, json: lowStockPayload([]) },
        'inventory.reorderPoints': { ok: true, json: reorderPointsPayload(0) },
      }),
    };
    renderScreen(db, holding([CAPABILITY.stockView]), opts);

    expect(await screen.findByText(/Your manager can set thresholds/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Set the first threshold' })).toBeNull();
  });
});

describe('setting a threshold', () => {
  it('refuses a quantity the unit cannot hold, before anything is sent', async () => {
    const db = await till();
    const asked: string[] = [];
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router(
        {
          'inventory.lowStock': { ok: true, json: lowStockPayload([alert()]) },
          'inventory.reorderPoints': { ok: true, json: reorderPointsPayload(1) },
        },
        asked,
      ),
    };
    renderScreen(db, holding([CAPABILITY.stockView, CAPABILITY.reorderManage]), opts);

    fireEvent.click(await screen.findByRole('button', { name: 'Change threshold' }));
    const field = await screen.findByLabelText(/Reorder threshold in BAG/);
    fireEvent.change(field, { target: { value: '20.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save threshold' }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByRole('alert').textContent).toContain('whole numbers');
    expect(asked).not.toContain('inventory.setReorderPoint');
  });

  it('says a threshold was NOT saved and NOT queued when the server cannot be reached', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'inventory.lowStock': { ok: true, json: lowStockPayload([alert()]) },
        'inventory.reorderPoints': { ok: true, json: reorderPointsPayload(1) },
        'inventory.setReorderPoint': 'reject',
      }),
    };
    renderScreen(db, holding([CAPABILITY.stockView, CAPABILITY.reorderManage]), opts);

    fireEvent.click(await screen.findByRole('button', { name: 'Change threshold' }));
    fireEvent.change(await screen.findByLabelText(/Reorder threshold in BAG/), {
      target: { value: '25' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save threshold' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Nothing was queued.'),
    );
  });

  it('sends the threshold once, under one idempotency key, and against the shared contract', async () => {
    const db = await till();
    const bodies: string[] = [];
    const fetchFn: ApiFetch = (url, init) => {
      const path = new URL(url).pathname.replace('/trpc/', '');
      if (path === 'inventory.setReorderPoint') {
        bodies.push(init.body ?? '');
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              result: {
                data: {
                  json: {
                    reorderPointId: 'rp-1',
                    created: false,
                    locationId: LOC,
                    productId: PRODUCT,
                    reorderPointQty: '25',
                    reorderUpToQty: null,
                    leadTimeDays: null,
                    isActive: true,
                    qtyScale: 0,
                    uomCode: 'BAG',
                  },
                },
              },
            }),
        });
      }
      const json =
        path === 'inventory.lowStock' ? lowStockPayload([alert()]) : reorderPointsPayload(1);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: { data: { json } } }),
      });
    };
    renderScreen(db, holding([CAPABILITY.stockView, CAPABILITY.reorderManage]), { endpoint: ENDPOINT, fetchFn });

    fireEvent.click(await screen.findByRole('button', { name: 'Change threshold' }));
    fireEvent.change(await screen.findByLabelText(/Reorder threshold in BAG/), {
      target: { value: '25' },
    });
    const save = screen.getByRole('button', { name: 'Save threshold' });
    fireEvent.click(save);

    await waitFor(() => expect(bodies.length).toBe(1));
    const sent = JSON.parse(bodies[0] ?? '{}') as { json: Record<string, unknown> };
    // The quantity is a decimal STRING of scaled integer units, never a number.
    expect(sent.json['reorderPointQty']).toBe('25');
    expect(typeof sent.json['idempotencyKey']).toBe('string');
    expect(sent.json['locationId']).toBe(LOC);
    expect(sent.json).not.toHaveProperty('tenantId');
  });
});
