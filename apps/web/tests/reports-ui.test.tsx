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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
        tenders: [
          { methodId: 'm1', name: 'Notes and coins', postingRole: 'TILL_CASH', isCash: true, isOnAccount: false, amountMinor: '60000', saleCount: '2' },
          { methodId: 'm2', name: 'Phone wallet', postingRole: 'MOMO_WALLET', isCash: false, isOnAccount: false, amountMinor: '30000', saleCount: '1' },
          { methodId: 'm3', name: 'Tab', postingRole: 'AR_TRADE', isCash: false, isOnAccount: true, amountMinor: '25000', saleCount: '1' },
        ],
        tills: { opened: '1', closed: '1', counted: '1', autoClosed: '0', openedOffline: '0', varianceMinor: '-150', offCount: '1', bankedMinor: '50000' },
      },
    ],
    total: {
      immediateTenderMinor: '90000', creditTenderMinor: '25000', billedTotalMinor: '115000',
      tenders: [
        { methodId: 'm1', name: 'Notes and coins', postingRole: 'TILL_CASH', isCash: true, isOnAccount: false, amountMinor: '60000', saleCount: '2' },
        { methodId: 'm2', name: 'Phone wallet', postingRole: 'MOMO_WALLET', isCash: false, isOnAccount: false, amountMinor: '30000', saleCount: '1' },
        { methodId: 'm3', name: 'Tab', postingRole: 'AR_TRADE', isCash: false, isOnAccount: true, amountMinor: '25000', saleCount: '1' },
      ],
    },
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

/**
 * The ADR-0001 ratio, as the server actually answers it now.
 *
 * `line()` builds one row and takes the three cases apart deliberately:
 *   · a real figure,
 *   · a figure that is a FLOOR because some freight was never agreed,
 *   · a location that took nothing, where a percentage is undefined and the
 *     COST still has to be reported.
 */
function line(over: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    netRevenueMinor: '100000',
    // 4500 minor over 100000 minor is 4.5% -> 45000 at ×10⁴.
    distributionCostMinor: '4500',
    distributionCostPctE4: '45000',
    deliveryCount: 3,
    deliveriesWithNoAgreedFreight: 0,
    unavailable: null,
    ...over,
  };
}

function distributionPayload(over: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    from: '2026-08-01',
    to: '2026-08-07',
    scope: { network: false, locationCount: 1 },
    currencyCode: 'XTS',
    moneyScale: '2',
    locations: [
      { locationId: LOC, locationCode: 'OUT-01', locationName: 'Main counter', ...line() },
    ],
    groups: [
      {
        groupId: 'g-1',
        groupCode: 'GRP-N',
        groupName: 'Northern grouping',
        locationCount: 2,
        ...line({ netRevenueMinor: '200000', distributionCostMinor: '5000', distributionCostPctE4: '25000' }),
      },
    ],
    groupsNest: true,
    total: line(),
    costBasis: 'AGREED_NOT_INVOICED',
    periodBasis: {
      datedByAssertion: 3,
      datedByPlannedFor: 0,
      datedByDispatchClock: 0,
      datedByRowCreated: 0,
      note: 'Every delivery in this period carries an asserted business date.',
    },
    unavailableReason:
      'Distribution cost is the AGREED freight on third-party deliveries, not the haulier\u2019s AP invoice.',
    method: 'Agreed freight over net revenue, both dated by business date.',
    ...over,
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

function mountReports(db: LocalDb, permissions: PermissionsState, apiOptions: ApiCallOptions) {
  return render(
    <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
      <Reports db={db} permissions={permissions} apiOptions={apiOptions} />
    </CurrencyProvider>,
  );
}

/**
 * The whole page, every panel at once — the "Everything" section. Most claims
 * below are about how each panel behaves BESIDE the others (a refusal takes
 * no other panel down; offline, every panel says so), so they are made there.
 * The sections themselves are tested in their own block at the end.
 */
async function renderReports(db: LocalDb, permissions: PermissionsState, apiOptions: ApiCallOptions) {
  const view = mountReports(db, permissions, apiOptions);
  fireEvent.click(await screen.findByRole('button', { name: 'Everything' }));
  return view;
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
    await renderReports(db, holding([CAPABILITY.reportLocation]), opts);

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
    await renderReports(db, holding([CAPABILITY.reportLocation]), opts);

    expect(await screen.findAllByText(/Whole organisation · 4 locations/)).not.toHaveLength(0);
    expect(screen.getAllByText(/Total, whole organisation/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/not the whole organisation/i)).toBeNull();
  });
});

describe('cash position by the tenant’s own payment methods, and the tills behind it', () => {
  it('lists each method under ITS name, and says how the counts reconciled', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'reports.salesByLocation': salesPayload(false),
        'reports.cashPosition': cashPayload(false),
        'reports.stockOnHand': stockPayload(false),
      }),
    };
    await renderReports(db, holding([CAPABILITY.reportLocation]), opts);
    const table = await screen.findByRole('table', { name: 'By payment method' });
    // The names are the tenant's rows, rendered — "Phone wallet" is visible
    // as itself, not folded into "settled at the counter".
    expect(within(table).getByText('Phone wallet')).toBeTruthy();
    expect(within(table).getByText((t) => t.includes('300.00'))).toBeTruthy();
    expect(within(table).getByText(/on account/)).toBeTruthy();
    const tills = screen.getByRole('list', { name: 'Tills' });
    expect(tills.textContent).toMatch(/1 of 1 tills closed, 1 counted, 1 off by a net/);
    expect(tills.textContent).toMatch(/1\.50/);
    expect(tills.textContent).toMatch(/short/);
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
    await renderReports(db, holding([CAPABILITY.reportLocation]), opts);

    // 115000 minor units at the configured scale of 2 — formatted by
    // @erp/money, with the configured symbol, not by this screen.
    const cells = await screen.findAllByText((t) => t.includes('1,150.00'));
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
    await renderReports(db, holding([CAPABILITY.reportLocation]), opts);
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
    await renderReports(db, holding([CAPABILITY.reportLocation]), opts);

    await screen.findAllByText(/Total of your locations only/);
    // Three margin-gated panels now: stock cover, the distribution ratio, and
    // the per-carrier split the ratio is negotiated down through.
    expect(await screen.findAllByText(/Not part of what you can see/)).toHaveLength(3);
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(asked).not.toContain('reports.inventoryDays');
    expect(asked).not.toContain('reports.distributionCostRatio');
    expect(asked).not.toContain('logistics.haulageSpend');
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
    await renderReports(db, holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]), opts);

    // 350000 e4 days -> 35; 200000 e4 percent -> 20%.
    expect(await screen.findAllByText('35')).not.toHaveLength(0);
    expect(screen.getAllByText('20%').length).toBeGreaterThan(0);
  });

  it('renders a cost the server has no basis for as an absence, never as zero', async () => {
    const db = await till();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'reports.salesByLocation': salesPayload(false),
        'reports.cashPosition': cashPayload(false),
        'reports.stockOnHand': stockPayload(false),
        'reports.inventoryDays': inventoryDaysPayload(),
        'reports.distributionCostRatio': distributionPayload({
          locations: [
            {
              locationId: LOC,
              locationCode: 'OUT-01',
              locationName: 'Main counter',
              ...line({
                distributionCostMinor: null,
                distributionCostPctE4: null,
                unavailable: 'NO_DISTRIBUTION_COST_SOURCE',
              }),
            },
          ],
        }),
      }),
    };
    await renderReports(db, holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]), opts);

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
    await renderReports(db, holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]), opts);

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
    await renderReports(db, holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]), opts);

    // Every panel answers on its own; wait for all six, not the first.
    await waitFor(() => expect(screen.getAllByText(/Not available offline\./).length).toBe(6));
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
    const { container } = await renderReports(db, holding([CAPABILITY.reportLocation]), opts);
    await screen.findAllByText(/Total of your locations only/);

    const inputs = container.querySelectorAll('input[type="date"]');
    const from = inputs[0] as HTMLInputElement;
    // Typing a start date after the end date.
    fireEvent.change(from, { target: { value: '2030-01-01' } });

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByRole('alert').textContent).toContain('no period to report on');
  });
});

// ---------------------------------------------------------------------------
// The ADR-0001 ratio — the number the founder was promised for the fleet
// ---------------------------------------------------------------------------

/** Every distribution case needs the other three panels answered too. */
function withDistribution(payload: unknown): ApiCallOptions {
  return {
    endpoint: ENDPOINT,
    fetchFn: router({
      'reports.salesByLocation': salesPayload(false),
      'reports.cashPosition': cashPayload(false),
      'reports.stockOnHand': stockPayload(false),
      'reports.inventoryDays': inventoryDaysPayload(),
      'reports.distributionCostRatio': payload,
    }),
  };
}

describe('distribution cost as a percentage of revenue', () => {
  it('shows the ratio per location and a headline for whatever the scope is', async () => {
    const db = await till();
    await renderReports(
      db,
      holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]),
      withDistribution(distributionPayload()),
    );

    // 4500 minor over 100000 minor: 45000 at ×10⁴ is 4.5%. Rounded once, in
    // integer arithmetic, at the presentation boundary and nowhere else, and
    // rendered by the one exact decimal renderer, which trims trailing zeros.
    expect(await screen.findAllByText('4.5%')).not.toHaveLength(0);
    expect(screen.getByText(/went on moving goods between/)).toBeDefined();
    // The money is formatted by @erp/money at the tenant's own scale.
    expect(screen.getAllByText((t) => t.includes('45.00')).length).toBeGreaterThan(0);
  });

  it('rolls the same ratio up to the tenant’s own grouping nodes', async () => {
    const db = await till();
    await renderReports(
      db,
      holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]),
      withDistribution(distributionPayload()),
    );

    // The GROUP's own ratio, computed by the server over its members — not
    // summed on the client, which would be a second implementation of the
    // rollup. The tenant's own name for the node is what is rendered.
    expect(await screen.findByText('Northern grouping')).toBeDefined();
    expect(screen.getAllByText('2.5%').length).toBeGreaterThan(0);
    expect(screen.getByText(/these nest, so they do not add up/)).toBeDefined();
  });

  it('prints a real zero when nothing moved, and says so beside it', async () => {
    const db = await till();
    await renderReports(
      db,
      holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]),
      withDistribution(
        distributionPayload({
          locations: [
            {
              locationId: LOC,
              locationCode: 'OUT-01',
              locationName: 'Main counter',
              ...line({
                distributionCostMinor: '0',
                distributionCostPctE4: '0',
                deliveryCount: 0,
              }),
            },
          ],
          groups: [],
        }),
      ),
    );

    // A location nothing was delivered to really did cost nothing to serve.
    // That is a FACT, and printing it as an absence would hide a real zero —
    // but a bare 0.00% with no context is how a gap gets read as an
    // achievement, so the count says which of the two it is.
    expect(await screen.findAllByText('0%')).not.toHaveLength(0);
    expect(screen.getAllByText('nothing moved').length).toBeGreaterThan(0);
  });

  it('says the figure is a floor when freight was never agreed', async () => {
    const db = await till();
    await renderReports(
      db,
      holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]),
      withDistribution(
        distributionPayload({
          locations: [
            {
              locationId: LOC,
              locationCode: 'OUT-01',
              locationName: 'Main counter',
              ...line({
                deliveriesWithNoAgreedFreight: 2,
                unavailable: 'INCOMPLETE_FREIGHT_BASIS',
              }),
            },
          ],
          groups: [],
        }),
      ),
    );

    // The ratio is still shown — it is the best figure there is — but it is
    // marked as a lower bound, because a partial basis read as a complete one
    // understates exactly the trajectory this panel exists to expose.
    expect(await screen.findAllByText('4.5%')).not.toHaveLength(0);
    expect(screen.getAllByText(/at least/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/with no agreed freight/).length).toBeGreaterThan(0);
  });

  it('reports the cost of a location that took nothing, and refuses to call it a percentage', async () => {
    const db = await till();
    await renderReports(
      db,
      holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]),
      withDistribution(
        distributionPayload({
          locations: [
            {
              locationId: LOC,
              locationCode: 'OUT-01',
              locationName: 'Store yard',
              ...line({
                netRevenueMinor: '0',
                distributionCostPctE4: null,
                unavailable: 'NO_REVENUE_IN_PERIOD',
              }),
            },
          ],
          groups: [],
        }),
      ),
    );

    // A warehouse has no till and still pays hauliers. The SPEND is reported —
    // dropping it is how a network ratio ends up flattering itself — and the
    // percentage is an absence with the server's reason, never a zero.
    expect(await screen.findAllByText(/nothing was sold here in this period/)).not.toHaveLength(0);
    expect(screen.getAllByText((t) => t.includes('45.00')).length).toBeGreaterThan(0);
  });

  it('warns when a delivery was dated by a clock rather than by a person', async () => {
    const db = await till();
    await renderReports(
      db,
      holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]),
      withDistribution(
        distributionPayload({
          periodBasis: {
            datedByAssertion: 1,
            datedByPlannedFor: 0,
            datedByDispatchClock: 2,
            datedByRowCreated: 0,
            note: 'Some deliveries fell back to a device clock.',
          },
        }),
      ),
    );

    expect(
      await screen.findByText(/placed in this period by a clock rather than by a person/),
    ).toBeDefined();
  });

  it('stays quiet about the dating when every delivery carries an asserted date', async () => {
    const db = await till();
    await renderReports(
      db,
      holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]),
      withDistribution(distributionPayload()),
    );

    await screen.findAllByText('4.5%');
    expect(screen.queryByText(/by a clock rather than by a person/)).toBeNull();
  });

  it('invents no target curve, because a target belongs to a tenant and not to this code', async () => {
    const db = await till();
    await renderReports(
      db,
      holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]),
      withDistribution(distributionPayload()),
    );

    await screen.findAllByText('4.5%');
    // The 5.0% -> 2.5% curve is a figure in ONE tenant's financial model. It is
    // not on the wire and no tenant configuration carries it, so the screen
    // must not draw it: that would be tenant #1's numbers in platform code
    // (CLAUDE.md 2.9, ADR-0006). This assertion is what keeps somebody from
    // "just adding the target line".
    expect(screen.queryByText(/target/i)).toBeNull();
    expect(screen.queryByText('5%')).toBeNull();
    // What IS shown about the limits of the figure is the SERVER's own words.
    expect(screen.getByText(/AGREED freight on third-party deliveries/)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Haulage per carrier — logistics.haulageSpend's `carriers`
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RATIO IS THE OUTCOME. THE PER-CARRIER SPLIT IS THE LEVER.
 * ═══════════════════════════════════════════════════════════════════════════
 * ADR-0001 gave up the owned fleet on the argument that third-party rates
 * could be driven DOWN. A rate is driven down in one conversation with one
 * haulier, holding what that haulier has actually been agreed and over how
 * many loads. Nobody can pull a lever they cannot see, so the split has to be
 * on a screen — and it has to say when a carrier's figure is a FLOOR, because
 * walking into a rate negotiation with a total that is quietly missing four
 * loads is worse than walking in with no figure at all.
 */
function bucket(over: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    haulageSpendMinor: '4500',
    deliveryCount: 3,
    deliveriesWithNoAgreedFreight: 0,
    unavailable: null,
    ...over,
  };
}

function haulagePayload(over: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    from: '2026-08-01',
    to: '2026-08-07',
    scope: { network: false, locationCount: 1 },
    currencyCode: 'XTS',
    moneyScale: '2',
    locations: [
      { locationId: LOC, locationCode: 'OUT-01', locationName: 'Main counter', ...bucket() },
    ],
    groups: [],
    groupsNest: true,
    carriers: [
      {
        carrierSupplierId: 's-1',
        carrierName: 'Northern Haulage',
        haulageSpendMinor: '3000',
        deliveryCount: 2,
        deliveriesWithNoAgreedFreight: 0,
      },
      {
        carrierSupplierId: 's-2',
        carrierName: 'Riverside Transport',
        haulageSpendMinor: '1500',
        deliveryCount: 1,
        deliveriesWithNoAgreedFreight: 0,
      },
    ],
    total: bucket(),
    basis: 'AGREED_NOT_INVOICED',
    excludedStatus: 'CANCELLED',
    limitApplies: false,
    periodBasis: {
      datedByAssertion: 3,
      datedByPlannedFor: 0,
      datedByDispatchClock: 0,
      datedByRowCreated: 0,
      note: 'Every delivery in this period carries an asserted business date.',
    },
    method: 'Agreed freight per carrier, dated by business date.',
    ...over,
  };
}

const MARGIN_READY: Readonly<Record<string, unknown>> = {
  'reports.salesByLocation': salesPayload(false),
  'reports.cashPosition': cashPayload(false),
  'reports.stockOnHand': stockPayload(false),
  'reports.inventoryDays': inventoryDaysPayload(),
  'reports.distributionCostRatio': distributionPayload(),
  'logistics.haulageSpend': haulagePayload(),
};

describe('what each haulier has been agreed', () => {
  it('asks the server for it and names every carrier, with its share of the spend', async () => {
    const db = await till();
    const asked: string[] = [];
    await renderReports(db, holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]), {
      endpoint: ENDPOINT,
      fetchFn: router(MARGIN_READY, asked),
    });

    // The request goes out. Remove the wiring and this line fails first.
    expect(await screen.findByText('Northern Haulage')).toBeDefined();
    expect(asked).toContain('logistics.haulageSpend');
    expect(screen.getByText('Riverside Transport')).toBeDefined();
    // 3000 of 4500 is 66.67%, rounded once in integer arithmetic and never
    // recomputed from anything already on the screen.
    expect(screen.getByText('66.67%')).toBeDefined();
    expect(screen.getByText('33.33%')).toBeDefined();
    // In the server's own words, so a paraphrase cannot drift from it.
    expect(screen.getByText(/Agreed freight per carrier/)).toBeDefined();
  });

  it('says a carrier’s figure is a FLOOR when some of its loads had nothing agreed', async () => {
    const db = await till();
    await renderReports(db, holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]), {
      endpoint: ENDPOINT,
      fetchFn: router({
        ...MARGIN_READY,
        'logistics.haulageSpend': haulagePayload({
          carriers: [
            {
              carrierSupplierId: 's-1',
              carrierName: 'Northern Haulage',
              haulageSpendMinor: '3000',
              deliveryCount: 5,
              deliveriesWithNoAgreedFreight: 2,
            },
          ],
          total: bucket({ deliveryCount: 5, deliveriesWithNoAgreedFreight: 2 }),
        }),
      }),
    });

    await screen.findByText('Northern Haulage');
    // Never a bare total. "At least" is the difference between a figure to
    // negotiate from and one to be embarrassed by.
    expect(screen.getAllByText(/at least/).length).toBeGreaterThan(0);
    expect(screen.getByText(/\(2 with no agreed freight\)/)).toBeDefined();
  });

  it('says nothing moved rather than showing an empty table', async () => {
    const db = await till();
    await renderReports(db, holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]), {
      endpoint: ENDPOINT,
      fetchFn: router({
        ...MARGIN_READY,
        'logistics.haulageSpend': haulagePayload({
          carriers: [],
          total: bucket({ haulageSpendMinor: '0', deliveryCount: 0 }),
        }),
      }),
    });

    expect(
      await screen.findByText(/No load was handed to anybody in this period/),
    ).toBeDefined();
  });

  it('is refused honestly when the server refuses it, and takes no other panel down', async () => {
    const db = await till();
    const answers = { ...MARGIN_READY };
    delete (answers as Record<string, unknown>)['logistics.haulageSpend'];
    await renderReports(db, holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]), {
      endpoint: ENDPOINT,
      fetchFn: router(answers),
    });

    // The refusal is shown in the server's words…
    expect(
      await screen.findByText(/PERMISSION_DENIED: logistics.haulageSpend/),
    ).toBeDefined();
    // …and the takings panel beside it still answered.
    expect(screen.getAllByText(/Total of your locations only/).length).toBeGreaterThan(0);
  });
});

describe('one section at a time', () => {
  const answers = {
    'reports.salesByLocation': salesPayload(false),
    'reports.cashPosition': cashPayload(false),
    'reports.stockOnHand': stockPayload(false),
  };

  it('opens on Sales and asks the server for sales only', async () => {
    const db = await till();
    const asked: string[] = [];
    mountReports(db, holding([CAPABILITY.reportLocation, CAPABILITY.reportMargin]), {
      endpoint: ENDPOINT,
      fetchFn: router(answers, asked),
    });
    expect(await screen.findByRole('button', { name: 'Sales', pressed: true })).toBeTruthy();
    await screen.findAllByText(/Total of your locations only/);
    expect(asked).toEqual(['reports.salesByLocation']);
    expect(screen.queryByRole('table', { name: 'By payment method' })).toBeNull();
  });

  it('asks for a section only when it is opened', async () => {
    const db = await till();
    const asked: string[] = [];
    mountReports(db, holding([CAPABILITY.reportLocation]), {
      endpoint: ENDPOINT,
      fetchFn: router(answers, asked),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Cash' }));
    expect(await screen.findByRole('table', { name: 'By payment method' })).toBeTruthy();
    expect(asked).toContain('reports.cashPosition');
    expect(asked).not.toContain('reports.stockOnHand');
  });

  it('drops the date range for stock, which is "now" rather than a period', async () => {
    const db = await till();
    mountReports(db, holding([CAPABILITY.reportLocation]), {
      endpoint: ENDPOINT,
      fetchFn: router(answers),
    });
    expect(await screen.findByLabelText('From')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stock' }));
    expect(await screen.findByText(/2\.5 KG/)).toBeDefined();
    expect(screen.queryByLabelText('From')).toBeNull();
  });

  it('still says what is not yours inside a gated section, and asks nothing for it', async () => {
    const db = await till();
    const asked: string[] = [];
    mountReports(db, holding([CAPABILITY.reportLocation]), {
      endpoint: ENDPOINT,
      fetchFn: router(answers, asked),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Moving goods' }));
    expect(await screen.findAllByText(/Not part of what you can see/)).toHaveLength(2);
    expect(asked).not.toContain('reports.distributionCostRatio');
    expect(asked).not.toContain('logistics.haulageSpend');
  });
});

