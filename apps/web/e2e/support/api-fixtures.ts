/**
 * Server answers for the screens the browser tests open, shaped to the
 * mappers that read them (src/data/api/*.ts) — which reject anything they
 * cannot read as `malformed`, so a fixture that drifts from the client fails
 * loudly on screen rather than rendering a blank.
 *
 * Money and quantities cross as decimal strings of minor units / scaled
 * integers (ADR-0004); nothing here is a float.
 */
import identity from './identity.json' with { type: 'json' };
import type { ProcedureHandler } from './api-mock';
import { PRODUCTS, productIdOf } from './download';

const LOC = identity.locationId;
const LOC2 = identity.otherLocationId;

/**
 * What the fixture session holds — a manager who sells, cashes up, reads
 * reporting and stock for the network, and administers people, devices and
 * roles. Platform capability codes (data/api/session.ts CAPABILITY), never a
 * role name. Deliberately NOT margin, credit, buying, decisions or books: the
 * dashboard then offers exactly the tiles these fixtures answer.
 */
export const FIXTURE_CAPABILITIES: readonly string[] = [
  'sale.record',
  'cash.session.open',
  'cash.session.close',
  'report.view.location',
  'report.view.tenant',
  'stock.view',
  'admin.user.manage',
  'admin.device.enrol',
  'admin.role.manage',
];

export function permissionsFor(codes: readonly string[]): ProcedureHandler {
  return () => ({
    userId: identity.userId,
    grants: codes.flatMap((code) => [LOC, LOC2].map((locationId) => ({ code, locationId, bound: null }))),
  });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function inputDates(input: unknown): { from: string; to: string } {
  const r = (input ?? {}) as Record<string, unknown>;
  const to = typeof r['to'] === 'string' ? r['to'] : today();
  const from = typeof r['from'] === 'string' ? r['from'] : to;
  return { from, to };
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end && out.length < 400; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** A deterministic, plausible day of trade in minor units — integers only. */
function dayFigures(date: string, salt: number): Record<string, string> {
  const d = Number(date.slice(8, 10)) + salt;
  const saleCount = 20n + BigInt((d * 7) % 23);
  const net = 1_200_000n + BigInt(((d * 7919) % 97) * 15_000);
  const tax = (net * 15n) / 100n;
  return {
    saleCount: String(saleCount),
    subtotalNetMinor: String(net),
    discountMinor: '0',
    netRevenueMinor: String(net),
    taxTotalMinor: String(tax),
    totalMinor: String(net + tax),
  };
}

function sum(rows: readonly Record<string, string>[]): Record<string, string> {
  const keys = ['saleCount', 'subtotalNetMinor', 'discountMinor', 'netRevenueMinor', 'taxTotalMinor', 'totalMinor'];
  return Object.fromEntries(keys.map((k) => [k, String(rows.reduce((a, r) => a + BigInt(r[k] ?? '0'), 0n))]));
}

const LOCATIONS = [
  { locationId: LOC, locationCode: 'OUT-01', locationName: 'Test outlet one' },
  { locationId: LOC2, locationCode: 'OUT-02', locationName: 'Test outlet two' },
];
const SCOPE = { network: true, locationCount: 2 };

const salesByDay: ProcedureHandler = (input) => {
  const { from, to } = inputDates(input);
  const series = daysBetween(from, to).map((date) => ({ date, ...dayFigures(date, 0) }));
  return { from, to, days: series.length, scope: SCOPE, series, total: sum(series) };
};

const salesByLocation: ProcedureHandler = (input) => {
  const { from, to } = inputDates(input);
  const dates = daysBetween(from, to);
  const locations = LOCATIONS.map((l, i) => ({ ...l, ...sum(dates.map((d) => dayFigures(d, i * 5))) }));
  return { from, to, days: dates.length, scope: SCOPE, locations, total: sum(locations) };
};

const tender = (name: string, isCash: boolean, amount: bigint, count: bigint, n: number) => ({
  methodId: `01930000-0000-7000-8014-${String(n).padStart(12, '0')}`,
  name,
  isCash,
  isOnAccount: false,
  amountMinor: String(amount),
  saleCount: String(count),
});

const cashPosition: ProcedureHandler = (input) => {
  const { from, to } = inputDates(input);
  const locations = LOCATIONS.map((l, i) => {
    const cash = 4_200_000n + BigInt(i) * 900_000n;
    const momo = 1_800_000n + BigInt(i) * 250_000n;
    return {
      ...l,
      immediateTenderMinor: String(cash + momo),
      immediateSaleCount: String(140 + i * 30),
      creditTenderMinor: '0',
      creditSaleCount: '0',
      billedTotalMinor: String(cash + momo),
      tenders: [tender('Cash', true, cash, 110n, 1), tender('Mobile money', false, momo, 30n, 2)],
      tills: {
        opened: '7',
        closed: '6',
        counted: '6',
        autoClosed: '1',
        openedOffline: '2',
        varianceMinor: String(-1500 * (i + 1)),
        offCount: '1',
        bankedMinor: String(cash - 500_000n),
      },
    };
  });
  const total = (k: 'immediateTenderMinor' | 'creditTenderMinor' | 'billedTotalMinor') =>
    String(locations.reduce((a, l) => a + BigInt(l[k]), 0n));
  return {
    from,
    to,
    scope: SCOPE,
    locations,
    total: {
      immediateTenderMinor: total('immediateTenderMinor'),
      creditTenderMinor: total('creditTenderMinor'),
      billedTotalMinor: total('billedTotalMinor'),
      tenders: [
        tender('Cash', true, 9_300_000n, 220n, 1),
        tender('Mobile money', false, 3_850_000n, 60n, 2),
      ],
    },
    unattributed: { creditReceiptsMinor: '0', reason: 'Repayments are not attributed to a till.' },
    caveats: [],
  };
};

function stockLine(p: (typeof PRODUCTS)[number], i: number) {
  const scale = p.uom === 'KG' ? 3 : p.uom === 'M' ? 2 : 0;
  return {
    productId: productIdOf(p.sku),
    skuCode: p.sku,
    productName: p.name,
    qtyOnHand: String((40 + ((i * 13) % 70)) * 10 ** scale),
    qtyScale: scale,
    uomCode: p.uom,
  };
}

const stockOnHand: ProcedureHandler = () => {
  const lines = PRODUCTS.map(stockLine);
  return {
    scope: SCOPE,
    locations: LOCATIONS.map((l) => ({ ...l, lines })),
    networkByProduct: lines.map((line) => ({ ...line, qtyOnHand: String(BigInt(line.qtyOnHand) * 2n) })),
  };
};

const lowStock: ProcedureHandler = () => {
  const alerts = PRODUCTS.slice(0, 4).map((p, i) => ({
    locationId: LOC,
    reorderPointId: `01930000-0000-7000-8020-${String(i + 1).padStart(12, '0')}`,
    productId: productIdOf(p.sku),
    skuCode: p.sku,
    productName: p.name,
    qtyOnHand: String(3 + i),
    reorderPointQty: '20',
    reorderUpToQty: '60',
    shortfallQty: String(17 - i),
    leadTimeDays: 3,
    qtyScale: 0,
    uomCode: p.uom,
    coverageBp: String(Math.round(((3 + i) / 20) * 10_000)),
  }));
  return {
    scope: { locationCount: 2 },
    alertCount: alerts.length,
    alerts,
    locations: LOCATIONS.map((l, i) => ({ ...l, alertCount: i === 0 ? alerts.length : 0 })),
  };
};

const ROLE_ID = '01930000-0000-7000-8030-000000000001';

const adminLocations: ProcedureHandler = () =>
  LOCATIONS.map((l) => ({ id: l.locationId, code: l.locationCode, name: l.locationName, kind: 'OUTLET', parentId: null }));

const adminUsers: ProcedureHandler = () => [
  {
    id: identity.userId,
    username: 'e2e.manager',
    displayName: 'Fixture Manager With A Rather Long Display Name',
    status: 'active',
    linkedToIdentityProvider: true,
    subjectRef: 'idp|e2e-0001',
    openSessions: 1,
    assignments: [
      {
        id: '01930000-0000-7000-8031-000000000001',
        roleId: ROLE_ID,
        roleName: 'Counter manager',
        isOwnerRole: false,
        scopeLocationId: LOC,
        scopeName: 'Test outlet one',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        live: true,
      },
    ],
  },
  {
    id: '01930000-0000-7000-8032-000000000002',
    username: 'e2e.cashier',
    displayName: 'Fixture Cashier',
    status: 'active',
    linkedToIdentityProvider: false,
    subjectRef: null,
    openSessions: 0,
    assignments: [],
  },
];

const adminRoles: ProcedureHandler = () => [
  {
    id: ROLE_ID,
    name: 'Counter manager',
    description: 'Sells, cashes up and reads the outlet’s reporting.',
    isOwner: false,
    liveAssignments: 1,
    permissions: FIXTURE_CAPABILITIES.map((code) => ({ code, bound: null })),
  },
  {
    id: '01930000-0000-7000-8030-000000000002',
    name: 'Counter',
    description: 'Sells and looks stock up.',
    isOwner: false,
    liveAssignments: 0,
    permissions: [{ code: 'sale.record', bound: null }],
  },
];

const adminCatalogue: ProcedureHandler = () =>
  [...FIXTURE_CAPABILITIES, 'sale.record.credit', 'stock.adjust', 'gl.view'].map((code) => ({
    code,
    domain: code.split('.')[0]!,
    description: `Fixture description of ${code}`,
    isSensitive: code.startsWith('admin') || code === 'gl.view',
    offlineMode: code.startsWith('sale') || code.startsWith('cash') ? 'queued' : 'online',
  }));

const adminDevices: ProcedureHandler = () => [
  {
    id: '01930000-0000-7000-8040-000000000001',
    label: 'Counter tablet 1',
    formFactor: 'tablet',
    status: 'active',
    retiredReason: null,
    lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    openSessions: 1,
    locations: [{ id: LOC, name: 'Test outlet one' }],
  },
  {
    id: '01930000-0000-7000-8040-000000000002',
    label: 'Back-office laptop',
    formFactor: 'laptop',
    status: 'suspended',
    retiredReason: null,
    lastSeenAt: null,
    openSessions: 0,
    locations: [],
  },
];

/** Every procedure the fixture session's screens call, answered. */
export function defaultProcedures(codes: readonly string[] = FIXTURE_CAPABILITIES): Record<string, ProcedureHandler> {
  return {
    'session.permissions': permissionsFor(codes),
    // The office masthead names the business the session belongs to.
    'session.tenant': () => ({ name: 'Fixture Trading Ltd' }),
    // Online, the till asks before it opens (OpenTill.tsx): the server's date
    // at this location, the period open, no refusal.
    'cashSession.openCheck': (input) => ({
      serverDate: ((input ?? {}) as { businessDate?: string }).businessDate ?? today(),
      toleranceDays: 1,
      periodStatus: 'open',
      refusal: null,
    }),
    'reports.salesByDay': salesByDay,
    'reports.salesByLocation': salesByLocation,
    'reports.cashPosition': cashPosition,
    'reports.stockOnHand': stockOnHand,
    'inventory.lowStock': lowStock,
    'admin.locations': adminLocations,
    'admin.users.list': adminUsers,
    'admin.roles.list': adminRoles,
    'admin.catalogue': adminCatalogue,
    'admin.devices.list': adminDevices,
  };
}
