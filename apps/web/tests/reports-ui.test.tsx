// @vitest-environment jsdom
/**
 * The reporting screen, tested for the three ways it can mislead somebody.
 *
 * 1. A total of one manager's outlets rendered like the organisation's total.
 *    They are the same digits and different facts, and a decision made on the
 *    second when it was the first is a decision made on a number missing most
 *    of the company.
 * 2. A cost or margin figure shown as zero to somebody who is not allowed to
 *    see it. A zero is a number; it gets compared to a target and acted on.
 * 3. An empty table where the answer is "this device cannot reach the server".
 *
 * Every assertion below is about words on a screen rather than about state,
 * because the words are the product here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiCallOptions, ApiEndpoint, ApiFetch } from '../src/data/api/client';
import { CAPABILITY, type PermissionsState } from '../src/data/api/session';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import type { LocalDb } from '../src/data/db';
import { Reports } from '../src/features/reports/Reports';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { provisionDevice } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const ENDPOINT: ApiEndpoint = { url: 'http://api.test', bearer: 'dev' };
const LOC = '018f3a1e-0000-7000-8000-00000000aaaa';

function salesPayload(network: boolean): unknown {
  const figures = {
    saleCount: '3',
    subtotalNetMinor: '100000',
    discountMinor: '0',
    netRevenueMinor: '100000',
    taxTotalMinor: '15000',
    totalMinor: '115000',
  };
  return {
    from: '2026-08-01',
    to: '2026-08-07',
    days: 7,
    scope: { network, locationCount: network ? 4 : 1 },
    locations: [
      { locationId: LOC, locationCode: 'OUT-01', locationName: 'Main counter', ...figures },
    ],
    total: figures,
  };
}

function cashPayload(network: boolean): unknown {
  return {
    from: '2026-08-01',
    to: '2026-08-07',
    scope: { network, locationCount: 1 },
    locations: [
      {
        locationId: LOC,
        locationCode: 'OUT-01',
        locationName: 'Main counter',
        immediateTenderMinor: '90000',
        immediateSaleCount: '2',
        creditTenderMinor: '25000',
        creditSaleCount: '1',
        billedTotalMinor: '115000',
      },
    ],
    total: { immediateTenderMinor: '90000', creditTenderMinor: '25000', billedTotalMinor: '115000' },
    unattributed: { creditReceiptsMinor: '5000', reason: 'no location on a payment' },
    caveats: ['This is what the till billed, not what is in the drawer.'],
  };
}

function stockPayload(network: boolean): unknown {
  return {
    scope: { network, locationCount: 1 },
    locations: [
      { locationId: LOC, locationCode: 'OUT-01', locationName: 'Main counter', lines: [] },
    ],
    networkByProduct: [
      {
        productId: 'p1',
        skuCode: 'SKU-1',
        productName: 'Binding wire',
        qtyOnHand: '2500',
        qtyScale: 3,
        uomCode: 'KG',
      },
    ],
  };
}

function inventoryDaysPayload(): unknown {
  const line = {
    netRevenueMinor: '100000',
    stockAtCostMinor: '400000',
    cogsMinor: '80000',
    inventoryDaysE4: '350000',
    grossMarginPctE4: '200000',
    unavailable: null,
    productsMissingCostBasis: 0,
    productsWithCostBasis: 4,
  };
  return {
    from: '2026-08-01',
    to: '2026-08-07',
    days: 7,
    scope: { network: false, locationCount: 1 },
    locations: [
      { locationId: LOC, locationCode: 'OUT-01', locationName: 'Main counter', ...line },
    ],
    total: {
      netRevenueMinor: '100000',
      stockAtCostMinor: '400000',
      cogsMinor: '80000',
      inventoryDaysE4: '350000',
      grossMarginPctE4: '200000',
      unavailable: null,
    },
    method: 'Weighted-average cost from each location’s own costed inbound movements.',
  };
}

function distributionPayload(): unknown {
  return {
    from: '2026-08-01',
    to: '2026-08-07',
    scope: { network: false, locationCount: 1 },
    locations: [
      {
        locationId: LOC,
        locationCode: 'OUT-01',
        locationName: 'Main counter',
        netRevenueMinor: '100000',
        distributionCostMinor: null,
        distributionCostPctE4: null,
        unavailable: 'NO_DISTRIBUTION_COST_SOURCE',
      },
    ],
    groups: [],
    groupsNest: true,
    total: {
      netRevenueMinor: '100000',
      distributionCostMinor: null,
      distributionCostPctE4: null,
      unavailable: 'NO_DISTRIBUTION_COST_SOURCE',
    },
    unavailableReason: 'No table records money spent moving goods.',
  };
}

/** Routes on the tRPC path, so each panel gets its own answer — or its own no. */
function router(
  answers: Readonly<Record<string, unknown>>,
  asked: string[] = [],
): ApiFetch {
  return (url) => {
    const path = new URL(url).pathname.replace('/trpc/', '');
    asked.push(path);
    if (!(path in answers)) {
      return Promise.resolve({
        ok: false,
        status: 403,
        json: () =>
          Promise.resolve({
            error: {
              json: { message: `PERMISSION_DENIED: ${path} is not held by this user`, data: { code: 'FORBIDDEN' } },
            },
          }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: { data: { json: answers[path] } } }),
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
  await provisionDevice(db, { locationId: LOC, locationCode: 'OUT-01' });
  return db;
}

function renderReports(db: LocalDb, permissions: PermissionsState, apiOptions: ApiCallOptions) {
  return render(
    <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
      <Reports db={db} permissions={permissions} apiOptions={apiOptions} />
    </CurrencyProvider>,
  );
}

afterEach(cleanup);

describe('whose total is it', () => {
  it('says a location-scoped total is NOT the organisation’s', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'reports.salesByLocation': salesPayload(false),
        'reports.cashPosition': cashPayload(false),
        'reports.stockOnHand': stockPayload(false),
      }),
    };
    renderReports(db, holding([CAPABILITY.reportLocation]), opts);

    expect(await screen.findAllByText(/not the whole organisation/i)).not.toHaveLength(0);
    expect(screen.getAllByText(/Total of your locations only/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Total, whole organisation/)).toBeNull();
  });

  it('says a tenant-wide total IS the organisation’s, in different words', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'reports.salesByLocation': salesPayload(true),
        'reports.cashPosition': cashPayload(true),
        'reports.stockOnHand': stockPayload(true),
      }),
    };
    renderReports(db, holding([CAPABILITY.reportLocation]), opts);

    expect(await screen.findAllByText(/Whole organisation · 4 locations/)).not.toHaveLength(0);
    expect(screen.getAllByText(/Total, whole organisation/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/not the whole organisation/i)).toBeNull();
  });
});

describe('money on a report', () => {
  it('renders through the tenant’s CurrencySpec, never a hard-coded scale', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'reports.salesByLocation': salesPayload(false),
        'reports.cashPosition': cashPayload(false),
        'reports.stockOnHand': stockPayload(false),
      }),
    };
    renderReports(db, holding([CAPABILITY.reportLocation]), opts);

    // 115000 minor units at the configured scale of 2 — formatted by
    // @erp/money, with the configured symbol, not by this screen.
    const cells = await screen.findAllByText((t) => t.includes('1150.00'));
    expect(cells.length).toBeGreaterThan(0);
    expect(cells[0]?.textContent).toContain(DEV_PLACEHOLDER_CURRENCY.symbol);
  });

  it('shows a scaled quantity in its own stocking unit', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'reports.salesByLocation': salesPayload(false),
        'reports.cashPosition': cashPayload(false),
        'reports.stockOnHand': stockPayload(false),
      }),
    };
    renderReports(db, holding([CAPABILITY.reportLocation]), opts);
    // 2500 at scale 3 is 2.5, trailing zeros trimmed, in the server's unit.
    expect(await screen.findByText(/2\.5 KG/)).toBeDefined();
  });
});

describe('cost and margin are a narrower audience', () => {
  it('does not even ask for them when the capability is absent, and shows no zeroes', async () => {
    const db = await till();
    const asked: string[] = [];
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router(
        {
          'reports.salesByLocation': salesPayload(false),
          'reports.cashPosition': cashPayload(false),
          'reports.stockOnHand': stockPayload(false),
        },
        asked,
      ),
    };
    renderReports(db, holding([CAPABILITY.reportLocation]), opts);

    await screen.findAllByText(/Total of your locations only/);
    expect(await screen.findAllByText(/Not part of what you can see/)).toHaveLength(2);
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(asked).not.toContain('reports.inventoryDays');
    expect(asked).not.toContain('reports.distributionCostRatio');
    // The absence is words, never a figure somebody could act on.
    expect(screen.queryByText('0.00')).toBeNull();
  });

  it('shows the figures when the capability is held', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'reports.salesByLocation': salesPayload(false),
        'reports.cashPosition': cashPayload(false),
        'reports.stockOnHand': stockPayload(false),
        'reports.inventoryDays': inventoryDaysPayload(),
        'reports.distributionCostRatio': distributionPayload(),
      }),
    };
    renderReports(db, holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]), opts);

    // 350000 e4 days -> 35; 200000 e4 percent -> 20%.
    expect(await screen.findAllByText('35')).not.toHaveLength(0);
    expect(screen.getAllByText('20%').length).toBeGreaterThan(0);
  });

  it('renders a cost the server has no source for as an absence, never as zero', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'reports.salesByLocation': salesPayload(false),
        'reports.cashPosition': cashPayload(false),
        'reports.stockOnHand': stockPayload(false),
        'reports.inventoryDays': inventoryDaysPayload(),
        'reports.distributionCostRatio': distributionPayload(),
      }),
    };
    renderReports(db, holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]), opts);

    expect(await screen.findAllByText(/not recorded anywhere yet/)).not.toHaveLength(0);
  });

  it('explains a refusal from the server in the server’s own words', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      // inventoryDays / distributionCostRatio are absent from the answer map,
      // so the router refuses them with a real FORBIDDEN.
      fetchFn: router({
        'reports.salesByLocation': salesPayload(false),
        'reports.cashPosition': cashPayload(false),
        'reports.stockOnHand': stockPayload(false),
      }),
    };
    renderReports(db, holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]), opts);

    expect(await screen.findAllByText(/This is not part of what you are allowed to see/)).not.toHaveLength(0);
    expect(screen.getAllByText(/PERMISSION_DENIED: reports.inventoryDays/).length).toBeGreaterThan(0);
  });
});

describe('offline', () => {
  it('says unavailable offline on every panel, and renders no table at all', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: () => Promise.reject(new Error('no radio')),
    };
    renderReports(db, holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]), opts);

    const notices = await screen.findAllByText(/Not available offline\./);
    expect(notices.length).toBe(5);
    expect(screen.queryByRole('table')).toBeNull();
    // The words that matter: not an old figure, not an empty list.
    expect(
      screen.getAllByText(/an old figure or an empty list would both read/).length,
    ).toBeGreaterThan(0);
  });
});

describe('the date range', () => {
  it('refuses a reversed range on the device instead of reporting on nothing', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'reports.salesByLocation': salesPayload(false),
        'reports.cashPosition': cashPayload(false),
        'reports.stockOnHand': stockPayload(false),
      }),
    };
    const { container } = renderReports(db, holding([CAPABILITY.reportLocation]), opts);
    await screen.findAllByText(/Total of your locations only/);

    const inputs = container.querySelectorAll('input[type="date"]');
    const from = inputs[0] as HTMLInputElement;
    // Typing a start date after the end date.
    fireEvent.change(from, { target: { value: '2030-01-01' } });

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByRole('alert').textContent).toContain('no period to report on');
  });
});
