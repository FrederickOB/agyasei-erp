// @vitest-environment jsdom
/**
 * The supplier screen, tested for the mistake it exists to prevent.
 *
 * Three quotes for the same material in three different units are not
 * comparable numbers, and the smallest figure on the page is routinely not the
 * cheapest source. Buying from the wrong supplier because the number LOOKED
 * smaller is a margin decision made by a formatting accident — so the tests
 * below are about the SECOND figure on every row: the same money expressed per
 * one stocking unit, which is the only denominator all three share.
 *
 * The other half is offline honesty. Suppliers and their prices are in no sync
 * bucket, so a partitioned device cannot answer — and an empty supplier list
 * reads as "we have no suppliers", which is a different and false statement.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { upsertSupplierInput, upsertSupplierProductInput } from '@erp/contracts';
import type { ApiCallOptions, ApiEndpoint, ApiFetch } from '../src/data/api/client';
import { CAPABILITY, type PermissionsState } from '../src/data/api/session';
import type { LocalDb } from '../src/data/db';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { Suppliers } from '../src/features/suppliers/Suppliers';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { provisionDevice, seedProduct, seedPurchaseUnit } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const ENDPOINT: ApiEndpoint = { url: 'http://api.test', bearer: 'dev' };
const LOC = '018f3a1e-0000-7000-8000-00000000aaaa';
const PRODUCT = '018f3a1e-0000-7000-8000-0000000000c1';

type Answer = { ok: true; json: unknown } | 'reject';

function router(answers: Readonly<Record<string, Answer>>): ApiFetch {
  return (url) => {
    const path = new URL(url).pathname.replace('/trpc/', '');
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

const SUPPLIERS = {
  supplierCount: 2,
  suppliers: [
    {
      supplierId: '018f3a1e-0000-7000-8000-00000000f001',
      code: 'SUP-1',
      name: 'Northern Supply',
      paymentTermsDays: 30,
      currencyCode: 'XTS',
      contactName: 'Ama',
      contactPhone: '024 000 0000',
      contactEmail: null,
      addressText: null,
      notes: null,
      isActive: true,
      capabilities: [{ capabilityTypeId: '018f3a1e-0000-7000-8000-00000000c001', code: 'SELLS', name: 'Sells goods', kind: 'GOODS' }],
    },
    {
      supplierId: '018f3a1e-0000-7000-8000-00000000f002',
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
      capabilities: [{ capabilityTypeId: '018f3a1e-0000-7000-8000-00000000c002', code: 'HAULS', name: 'Moves goods', kind: 'HAULAGE' }],
    },
  ],
  capabilityTypes: [
    { capabilityTypeId: '018f3a1e-0000-7000-8000-00000000c001', code: 'SELLS', name: 'Sells goods', kind: 'GOODS' },
    { capabilityTypeId: '018f3a1e-0000-7000-8000-00000000c002', code: 'HAULS', name: 'Moves goods', kind: 'HAULAGE' },
  ],
};

/**
 * Two sources for one product, quoted in two DIFFERENT units.
 *
 *   Northern:  1,000.00 per TONNE     → 20 sacks to the tonne →  50.00 a sack
 *   Coast:        55.00 per SACK      → one to one            →  55.00 a sack
 *
 * The larger headline figure is the cheaper source. The server ranks them on
 * the exact rationals and puts Northern first; the screen shows both figures
 * and marks the one the server called cheapest.
 */
const SOURCES = {
  productId: PRODUCT,
  skuCode: 'SKU-1',
  productName: 'Binder 50kg',
  stockingUomId: 'u-sack',
  stockingUomCode: 'SACK',
  qtyScale: 0,
  sourceCount: 3,
  pricedSourceCount: 2,
  preferredSupplierId: null,
  cheapestSupplierId: '018f3a1e-0000-7000-8000-00000000f001',
  sources: [
    {
      supplierProductId: 'sp-1',
      supplierId: '018f3a1e-0000-7000-8000-00000000f001',
      supplierCode: 'SUP-1',
      supplierName: 'Northern Supply',
      paymentTermsDays: 30,
      supplierSku: 'NS-77',
      leadTimeDays: 4,
      isPreferred: false,
      isActive: true,
      supplierIsActive: true,
      purchaseUomId: 'u-tonne',
      purchaseUomCode: 'TONNE',
      buyScale: 3,
      stockUnitsPerPurchaseUnitNum: '20',
      stockUnitsPerPurchaseUnitDen: '1',
      // 1000.00 per tonne, as a rate ×10⁴ of minor units.
      lastPriceE4: '1000000000',
      lastPriceOn: '2026-08-01',
      // 50.00 per sack.
      pricePerStockUnitE4: '50000000',
      priceComparable: true,
      priceUnavailableReason: null,
    },
    {
      supplierProductId: 'sp-2',
      supplierId: 's-coast',
      supplierCode: 'SUP-2',
      supplierName: 'Coast Traders',
      paymentTermsDays: 14,
      supplierSku: null,
      leadTimeDays: null,
      isPreferred: false,
      isActive: true,
      supplierIsActive: true,
      purchaseUomId: 'u-sack',
      purchaseUomCode: 'SACK',
      buyScale: 0,
      stockUnitsPerPurchaseUnitNum: '1',
      stockUnitsPerPurchaseUnitDen: '1',
      lastPriceE4: '55000000',
      lastPriceOn: '2026-07-14',
      pricePerStockUnitE4: '55000000',
      priceComparable: true,
      priceUnavailableReason: null,
    },
    {
      supplierProductId: 'sp-3',
      supplierId: '018f3a1e-0000-7000-8000-00000000f003',
      supplierCode: 'SUP-3',
      supplierName: 'Inland Depot',
      paymentTermsDays: 7,
      supplierSku: null,
      leadTimeDays: null,
      isPreferred: false,
      isActive: true,
      supplierIsActive: true,
      purchaseUomId: 'u-sack',
      purchaseUomCode: 'SACK',
      buyScale: 0,
      stockUnitsPerPurchaseUnitNum: '1',
      stockUnitsPerPurchaseUnitDen: '1',
      lastPriceE4: null,
      lastPriceOn: null,
      pricePerStockUnitE4: null,
      priceComparable: false,
      priceUnavailableReason: 'NO_RECORDED_PRICE',
    },
  ],
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
      <Suppliers db={db} permissions={permissions} apiOptions={apiOptions} />
    </CurrencyProvider>,
  );
}

afterEach(cleanup);

describe('the cheapest source is the cheapest in a COMMON unit', () => {
  it('shows both the quote and the same money per stocking unit', async () => {
    const db = await device();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'procurement.listSuppliers': { ok: true, json: SUPPLIERS },
        'procurement.suppliersForProduct': { ok: true, json: SOURCES },
      }),
    };
    renderScreen(db, holding([CAPABILITY.supplierView]), opts);

    fireEvent.change(await screen.findByLabelText('Product to compare sources for'), {
      target: { value: PRODUCT },
    });

    const list = await screen.findByRole('list', { name: 'Sources' });
    // The headline quote, in the supplier's own unit…
    // `@erp/money` formats without grouping separators — a grouped figure is
    // a locale decision, and the counter never makes one.
    expect(list.textContent).toContain('1,000.00');
    expect(list.textContent).toContain('per TONNE');
    // …and the figure that makes it comparable, which is the smaller one even
    // though the quote is the larger.
    expect(list.textContent).toContain('50.00');
    expect(list.textContent).toContain('55.00');
    expect(screen.getAllByText(/Same money per SACK/).length).toBe(3);
  });

  it('marks the source the SERVER ranked cheapest, and keeps the server’s order', async () => {
    const db = await device();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'procurement.listSuppliers': { ok: true, json: SUPPLIERS },
        'procurement.suppliersForProduct': { ok: true, json: SOURCES },
      }),
    };
    renderScreen(db, holding([CAPABILITY.supplierView]), opts);
    fireEvent.change(await screen.findByLabelText('Product to compare sources for'), {
      target: { value: PRODUCT },
    });

    const list = await screen.findByRole('list', { name: 'Sources' });
    const names = [...list.querySelectorAll('.report-loc-name')].map((n) => n.textContent);
    // Exactly the order the server sent. The screen never re-sorts on the
    // rounded per-stocking-unit figure, which could transpose two sources that
    // differ by less than one rounding step.
    expect(names).toEqual(['Northern Supply', 'Coast Traders', 'Inland Depot']);
    expect(screen.getByText(/Cheapest per SACK/)).toBeDefined();
    // The badge is on the row the server named, not on the smallest headline.
    const best = list.querySelector('.source-row-best');
    expect(best?.textContent).toContain('Northern Supply');
  });

  it('renders the conversion as the exact pair it is', async () => {
    const db = await device();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'procurement.listSuppliers': { ok: true, json: SUPPLIERS },
        'procurement.suppliersForProduct': { ok: true, json: SOURCES },
      }),
    };
    renderScreen(db, holding([CAPABILITY.supplierView]), opts);
    fireEvent.change(await screen.findByLabelText('Product to compare sources for'), {
      target: { value: PRODUCT },
    });
    const list = await screen.findByRole('list', { name: 'Sources' });
    expect(list.textContent).toContain('One TONNE is');
    expect(list.textContent).toContain('20 SACK');
  });
});

describe('a price nobody has paid is an absence, never a zero', () => {
  it('says nothing has been bought from them rather than printing a zero', async () => {
    const db = await device();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'procurement.listSuppliers': { ok: true, json: SUPPLIERS },
        'procurement.suppliersForProduct': { ok: true, json: SOURCES },
      }),
    };
    renderScreen(db, holding([CAPABILITY.supplierView]), opts);
    fireEvent.change(await screen.findByLabelText('Product to compare sources for'), {
      target: { value: PRODUCT },
    });

    await screen.findByRole('list', { name: 'Sources' });
    expect(screen.getByText('No price recorded')).toBeDefined();
    expect(screen.getByText(/Nothing bought from them yet/)).toBeDefined();
    // A zero here would put the cheapest-looking source in the business next
    // to a supplier nobody has a quote from.
    const list = screen.getByRole('list', { name: 'Sources' });
    expect(list.textContent).not.toContain('0.00 per SACK');
  });
});

describe('offline', () => {
  it('says unavailable, and shows neither an empty list nor a stale one', async () => {
    const db = await device();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: () => Promise.reject(new Error('down')),
    };
    renderScreen(db, holding([CAPABILITY.supplierView]), opts);

    expect(await screen.findByText(/Not available offline\./)).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Suppliers' })).toBeNull();
    expect(screen.queryByText('No suppliers yet')).toBeNull();
  });

  it('says unavailable for the comparison too, with no partial table', async () => {
    const db = await device();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({
        'procurement.listSuppliers': { ok: true, json: SUPPLIERS },
        'procurement.suppliersForProduct': 'reject',
      }),
    };
    renderScreen(db, holding([CAPABILITY.supplierView]), opts);
    fireEvent.change(await screen.findByLabelText('Product to compare sources for'), {
      target: { value: PRODUCT },
    });

    expect(await screen.findByText(/Who supplies this product is held on the server/)).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Sources' })).toBeNull();
    expect(screen.queryByText(/Nobody is recorded as supplying this/)).toBeNull();
  });
});

describe('who is offered this at all', () => {
  it('shows nothing rather than an empty list to somebody without the capability', async () => {
    const db = await device();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({ 'procurement.listSuppliers': { ok: true, json: SUPPLIERS } }),
    };
    renderScreen(db, holding([CAPABILITY.stockView]), opts);

    expect(
      await screen.findByText(/Who supplies what is not part of what you see/),
    ).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Suppliers' })).toBeNull();
  });

  it('narrows to the carriers by the PLATFORM capability kind, not a tenant code', async () => {
    const db = await device();
    const asked: string[] = [];
    const fetchFn: ApiFetch = (url) => {
      const parsed = new URL(url);
      asked.push(parsed.searchParams.get('input') ?? '');
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            result: {
              data: {
                json: { ...SUPPLIERS, suppliers: [SUPPLIERS.suppliers[1]], supplierCount: 1 },
              },
            },
          }),
      });
    };
    renderScreen(db, holding([CAPABILITY.supplierView]), { endpoint: ENDPOINT, fetchFn });

    fireEvent.click(await screen.findByRole('button', { name: /Only the ones that carry loads/ }));
    await screen.findByText('Road Partners');
    // HAULAGE is the platform's own word (ADR-0006). The tenant's code for it
    // — "HAULS" here — is rendered and never sent.
    expect(asked.some((i) => i.includes('HAULAGE'))).toBe(true);
    expect(asked.some((i) => i.includes('HAULS'))).toBe(false);
  });
});

describe('a haulier is a supplier, and nothing on this screen is a truck', () => {
  it('renders the carrier as a party with terms', async () => {
    const db = await device();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({ 'procurement.listSuppliers': { ok: true, json: SUPPLIERS } }),
    };
    const { container } = renderScreen(db, holding([CAPABILITY.supplierView]), opts);

    const list = await screen.findByRole('list', { name: 'Suppliers' });
    expect(list.textContent).toContain('Road Partners');
    expect(list.textContent).toContain('Carries loads');
    expect(list.textContent).toContain('On delivery');
    // ADR-0001, checked rather than asserted: no fleet vocabulary anywhere in
    // the rendered tree.
    const text = container.textContent ?? '';
    for (const word of ['vehicle', 'truck', 'driver', 'registration', 'fuel', 'odometer']) {
      expect(text.toLowerCase()).not.toContain(word);
    }
  });
});

// ---------------------------------------------------------------------------
// Writing: a supplier, and a source for a product
// ---------------------------------------------------------------------------

/**
 * The same router, but it RECORDS what was sent — the point of these tests is
 * the request body. Every one is checked against the SHARED contract
 * (`@erp/contracts`), not against a shape written here: the client already
 * validates the payload before it leaves the device, and parsing the captured
 * body with the same schema proves what the server would have parsed.
 */
interface Sent {
  readonly path: string;
  readonly body: unknown;
}

function recordingRouter(
  answers: Readonly<Record<string, Answer>>,
  sent: Sent[],
): ApiFetch {
  return (url, init) => {
    const path = new URL(url).pathname.replace('/trpc/', '');
    if (init.body !== undefined) {
      sent.push({ path, body: (JSON.parse(init.body) as { json: unknown }).json });
    }
    const answer = answers[path];
    if (answer === undefined || answer === 'reject') return Promise.reject(new Error('no radio'));
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: { data: { json: answer.json } } }),
    });
  };
}

const SAVED_SUPPLIER = {
  supplierId: '018f3a1e-0000-7000-8000-00000000f003',
  created: true,
  code: 'SUP-9',
  name: 'Volta Cement',
  paymentTermsDays: 14,
  currencyCode: 'XTS',
  isActive: true,
  capabilityTypeIds: ['018f3a1e-0000-7000-8000-00000000c001', '018f3a1e-0000-7000-8000-00000000c002'],
  capabilitiesReplaced: true,
};

const SAVED_SOURCE = {
  supplierProductId: 'sp-9',
  created: true,
  supplierId: '018f3a1e-0000-7000-8000-00000000f001',
  productId: PRODUCT,
  skuCode: 'SKU-1',
  purchaseUomId: 'u-tonne',
  purchaseUomCode: 'TONNE',
  buyScale: 3,
  stockingUomId: 'u-sack',
  stockingUomCode: 'SACK',
  stockUnitsPerPurchaseUnitNum: '20',
  stockUnitsPerPurchaseUnitDen: '1',
  supplierSku: 'VC-42',
  leadTimeDays: 4,
  lastPriceE4: '10000000',
  lastPriceOn: null,
  pricePerStockUnitE4: '500000',
  isPreferred: true,
  isActive: true,
};

describe('a tenant can create and amend a supplier from the product', () => {
  it('sends a payload the shared contract accepts, with the capability set it ticked', async () => {
    const db = await device();
    const sent: Sent[] = [];
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: recordingRouter(
        {
          'procurement.listSuppliers': { ok: true, json: SUPPLIERS },
          'procurement.upsertSupplier': { ok: true, json: SAVED_SUPPLIER },
        },
        sent,
      ),
    };
    renderScreen(db, holding([CAPABILITY.supplierView, CAPABILITY.supplierManage]), opts);

    fireEvent.click(await screen.findByRole('button', { name: 'Add a supplier' }));
    const form = await screen.findByRole('form', { name: 'New supplier' });
    fireEvent.change(screen.getByLabelText('Supplier code'), { target: { value: 'SUP-9' } });
    fireEvent.change(screen.getByLabelText('Supplier name'), { target: { value: 'Volta Cement' } });
    fireEvent.change(screen.getByLabelText('Payment terms in days'), { target: { value: '14' } });
    // The TENANT's own words label the box. Nothing here types a code.
    fireEvent.click(screen.getByLabelText('Sells goods'));
    fireEvent.click(screen.getByLabelText('Moves goods'));
    fireEvent.submit(form);

    await waitFor(() => expect(sent.some((s) => s.path === 'procurement.upsertSupplier')).toBe(true));
    const body = sent.find((s) => s.path === 'procurement.upsertSupplier')!.body;
    const parsed = upsertSupplierInput.safeParse(body);
    expect(parsed.success).toBe(true);

    const payload = body as Record<string, unknown>;
    expect(payload['code']).toBe('SUP-9');
    expect(payload['paymentTermsDays']).toBe(14);
    // Sent ALWAYS, because sending it replaces the set.
    expect(payload['capabilityTypeIds']).toEqual(['018f3a1e-0000-7000-8000-00000000c001', '018f3a1e-0000-7000-8000-00000000c002']);
    // The currency is the jurisdiction pack's; a client may not state one.
    expect(payload).not.toHaveProperty('currencyCode');
    expect(payload).not.toHaveProperty('tenantId');
  });

  it('re-sends a BYTE-IDENTICAL payload on retry, not just the same key', async () => {
    const db = await device();
    const sent: Sent[] = [];
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      // The write is not answered, so every attempt fails and the key must not
      // move — a double-tap on a bad link is one supplier, not three.
      fetchFn: recordingRouter({ 'procurement.listSuppliers': { ok: true, json: SUPPLIERS } }, sent),
    };
    renderScreen(db, holding([CAPABILITY.supplierView, CAPABILITY.supplierManage]), opts);

    fireEvent.click(await screen.findByRole('button', { name: 'Add a supplier' }));
    const form = await screen.findByRole('form', { name: 'New supplier' });
    fireEvent.change(screen.getByLabelText('Supplier code'), { target: { value: 'SUP-9' } });
    fireEvent.change(screen.getByLabelText('Supplier name'), { target: { value: 'Volta Cement' } });
    fireEvent.submit(form);
    await screen.findByText(/Nothing was queued and nothing was changed/);
    fireEvent.submit(form);
    await waitFor(() =>
      expect(sent.filter((s) => s.path === 'procurement.upsertSupplier')).toHaveLength(2),
    );

    // THE WHOLE INPUT, not just the key. The server hashes the canonical form
    // of the payload ALONGSIDE the key (apps/api/src/canonical.ts), so a retry
    // that keeps the key and stamps a fresh `clientWallAt` is "same key,
    // different payload" and is refused 409 IDEMPOTENCY_KEY_REUSE — the retry
    // that was supposed to be safe becomes the one that fails. A mocked
    // transport does not compute that hash, so this assertion is on the bytes.
    const bodies = sent
      .filter((s) => s.path === 'procurement.upsertSupplier')
      .map((s) => JSON.stringify(s.body));
    expect(bodies[0]).toBe(bodies[1]);
    const first = JSON.parse(bodies[0]!) as Record<string, unknown>;
    expect(typeof first['idempotencyKey']).toBe('string');
    expect(typeof first['clientWallAt']).toBe('string');
  });

  it('amends the supplier it was opened on, and says so rather than creating a second', async () => {
    const db = await device();
    const sent: Sent[] = [];
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: recordingRouter(
        {
          'procurement.listSuppliers': { ok: true, json: SUPPLIERS },
          'procurement.upsertSupplier': {
            ok: true,
            json: { ...SAVED_SUPPLIER, supplierId: '018f3a1e-0000-7000-8000-00000000f001', created: false },
          },
        },
        sent,
      ),
    };
    renderScreen(db, holding([CAPABILITY.supplierView, CAPABILITY.supplierManage]), opts);

    fireEvent.click(await screen.findByRole('button', { name: 'Amend SUP-1' }));
    const form = await screen.findByRole('form', { name: 'Amend supplier' });
    // The form opened on the row's own values, not on an empty form.
    expect((screen.getByLabelText('Supplier name') as HTMLInputElement).value).toBe(
      'Northern Supply',
    );
    // Retiring a supplier is an amend, never a delete: the orders against them
    // keep their name.
    fireEvent.click(screen.getByLabelText('Still in use'));
    fireEvent.submit(form);

    await waitFor(() => expect(sent.some((s) => s.path === 'procurement.upsertSupplier')).toBe(true));
    const payload = sent.find((s) => s.path === 'procurement.upsertSupplier')!.body as Record<
      string,
      unknown
    >;
    expect(payload['supplierId']).toBe('018f3a1e-0000-7000-8000-00000000f001');
    expect(payload['isActive']).toBe(false);
    expect(upsertSupplierInput.safeParse(payload).success).toBe(true);
  });

  it('refuses out loud when the device is partitioned, and queues nothing', async () => {
    const db = await device();
    const sent: Sent[] = [];
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: recordingRouter({ 'procurement.listSuppliers': { ok: true, json: SUPPLIERS } }, sent),
    };
    renderScreen(db, holding([CAPABILITY.supplierView, CAPABILITY.supplierManage]), opts);

    fireEvent.click(await screen.findByRole('button', { name: 'Add a supplier' }));
    const form = await screen.findByRole('form', { name: 'New supplier' });
    fireEvent.change(screen.getByLabelText('Supplier code'), { target: { value: 'SUP-9' } });
    fireEvent.change(screen.getByLabelText('Supplier name'), { target: { value: 'Volta Cement' } });
    fireEvent.submit(form);

    // Not "saved", not a spinner that never ends: the whole truth.
    expect(await screen.findByText(/Nothing was queued and nothing was changed/)).toBeDefined();
  });

  it('offers no control at all to a holder of supplier.view', async () => {
    const db = await device();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({ 'procurement.listSuppliers': { ok: true, json: SUPPLIERS } }),
    };
    renderScreen(db, holding([CAPABILITY.supplierView]), opts);

    await screen.findByRole('list', { name: 'Suppliers' });
    expect(screen.queryByRole('button', { name: 'Add a supplier' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Amend SUP-1' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record a source' })).toBeNull();
  });
});

describe('a tenant can record a source for a product', () => {
  it('offers only units the DEVICE says the product can be bought in', async () => {
    const db = await device();
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: router({ 'procurement.listSuppliers': { ok: true, json: SUPPLIERS } }),
    };
    renderScreen(db, holding([CAPABILITY.supplierView, CAPABILITY.supplierManage]), opts);

    fireEvent.click(await screen.findByRole('button', { name: 'Record a source' }));
    await screen.findByRole('form', { name: 'New source' });
    fireEvent.change(screen.getByLabelText('Product for this source'), {
      target: { value: PRODUCT },
    });

    // TONNE is the seeded buyable unit; the conversion is stated so nobody has
    // to guess what the comparison will be made in.
    // Exactly the two units the DEVICE holds as buyable for it, and nothing
    // else — no unit is offered that the server would refuse.
    const unit = (await screen.findByLabelText('Purchase unit')) as HTMLSelectElement;
    await waitFor(() => expect(unit.options.length).toBe(2));
    expect([...unit.options].map((o) => o.textContent).sort()).toEqual(['SACK', 'TONNE']);
    expect(await screen.findByText(/which is the unit every quote is compared in/)).toBeDefined();
  });

  it('sends a contract-valid source, with the price as an exact rate and never a float', async () => {
    const db = await device();
    const sent: Sent[] = [];
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: recordingRouter(
        {
          'procurement.listSuppliers': { ok: true, json: SUPPLIERS },
          'procurement.upsertSupplierProduct': { ok: true, json: SAVED_SOURCE },
        },
        sent,
      ),
    };
    renderScreen(db, holding([CAPABILITY.supplierView, CAPABILITY.supplierManage]), opts);

    fireEvent.click(await screen.findByRole('button', { name: 'Record a source' }));
    const form = await screen.findByRole('form', { name: 'New source' });
    fireEvent.change(screen.getByLabelText('Supplier for this source'), {
      target: { value: '018f3a1e-0000-7000-8000-00000000f001' },
    });
    fireEvent.change(screen.getByLabelText('Product for this source'), {
      target: { value: PRODUCT },
    });
    // Choose the unit that is NOT one-to-one, so the source being recorded is a
    // real conversion rather than a relabelling.
    const unitSelect = screen.getByLabelText('Purchase unit') as HTMLSelectElement;
    await waitFor(() => expect(unitSelect.options.length).toBe(2));
    const tonne = [...unitSelect.options].find((o) => o.textContent === 'TONNE')!;
    fireEvent.change(unitSelect, { target: { value: tonne.value } });
    expect(await screen.findByText(/is the unit every quote is compared in/)).toBeDefined();
    fireEvent.change(screen.getByLabelText("Supplier's own code for this product"), {
      target: { value: 'VC-42' },
    });
    fireEvent.change(screen.getByLabelText('Lead time in days'), { target: { value: '4' } });
    // 1000.00 at the tenant's scale of 2 is 100000 minor units; the rate is
    // ×10⁴ of that, exactly, with nothing rounded on the way in.
    fireEvent.change(screen.getByLabelText('Quoted price per purchase unit'), {
      target: { value: '1000.00' },
    });
    fireEvent.click(screen.getByLabelText('Buy from them by default'));
    fireEvent.submit(form);

    await waitFor(() =>
      expect(sent.some((s) => s.path === 'procurement.upsertSupplierProduct')).toBe(true),
    );
    const payload = sent.find((s) => s.path === 'procurement.upsertSupplierProduct')!.body as Record<
      string,
      unknown
    >;
    expect(upsertSupplierProductInput.safeParse(payload).success).toBe(true);
    expect(payload['lastPriceE4']).toBe('1000000000');
    expect(typeof payload['lastPriceE4']).toBe('string');
    expect(payload['supplierSku']).toBe('VC-42');
    expect(payload['leadTimeDays']).toBe(4);
    expect(payload['isPreferred']).toBe(true);
  });

  it('omits an unknown price rather than sending a zero', async () => {
    const db = await device();
    const sent: Sent[] = [];
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: recordingRouter(
        {
          'procurement.listSuppliers': { ok: true, json: SUPPLIERS },
          'procurement.upsertSupplierProduct': {
            ok: true,
            json: { ...SAVED_SOURCE, lastPriceE4: null, pricePerStockUnitE4: null },
          },
        },
        sent,
      ),
    };
    renderScreen(db, holding([CAPABILITY.supplierView, CAPABILITY.supplierManage]), opts);

    fireEvent.click(await screen.findByRole('button', { name: 'Record a source' }));
    const form = await screen.findByRole('form', { name: 'New source' });
    fireEvent.change(screen.getByLabelText('Supplier for this source'), {
      target: { value: '018f3a1e-0000-7000-8000-00000000f001' },
    });
    fireEvent.change(screen.getByLabelText('Product for this source'), {
      target: { value: PRODUCT },
    });
    await waitFor(() =>
      expect((screen.getByLabelText('Purchase unit') as HTMLSelectElement).value.length).toBeGreaterThan(0),
    );
    fireEvent.submit(form);

    await waitFor(() =>
      expect(sent.some((s) => s.path === 'procurement.upsertSupplierProduct')).toBe(true),
    );
    const payload = sent.find((s) => s.path === 'procurement.upsertSupplierProduct')!.body as Record<
      string,
      unknown
    >;
    // A source with no quote is UNKNOWN, never free.
    expect(payload).not.toHaveProperty('lastPriceE4');
    expect(upsertSupplierProductInput.safeParse(payload).success).toBe(true);
  });

  it('refuses a price the tenant’s currency cannot hold, before anything is sent', async () => {
    const db = await device();
    const sent: Sent[] = [];
    const opts: ApiCallOptions = {
      endpoint: ENDPOINT,
      fetchFn: recordingRouter(
        {
          'procurement.listSuppliers': { ok: true, json: SUPPLIERS },
          'procurement.upsertSupplierProduct': { ok: true, json: SAVED_SOURCE },
        },
        sent,
      ),
    };
    renderScreen(db, holding([CAPABILITY.supplierView, CAPABILITY.supplierManage]), opts);

    fireEvent.click(await screen.findByRole('button', { name: 'Record a source' }));
    const form = await screen.findByRole('form', { name: 'New source' });
    fireEvent.change(screen.getByLabelText('Supplier for this source'), {
      target: { value: '018f3a1e-0000-7000-8000-00000000f001' },
    });
    fireEvent.change(screen.getByLabelText('Product for this source'), {
      target: { value: PRODUCT },
    });
    await waitFor(() =>
      expect((screen.getByLabelText('Purchase unit') as HTMLSelectElement).value.length).toBeGreaterThan(0),
    );
    // Three decimals in a two-decimal currency. `@erp/money` refuses it; a
    // float would silently have accepted and rounded it.
    fireEvent.change(screen.getByLabelText('Quoted price per purchase unit'), {
      target: { value: '10.005' },
    });
    fireEvent.submit(form);

    expect(await screen.findByText(/Enter the quoted price using digits/)).toBeDefined();
    expect(sent.filter((s) => s.path === 'procurement.upsertSupplierProduct')).toHaveLength(0);
  });
});
