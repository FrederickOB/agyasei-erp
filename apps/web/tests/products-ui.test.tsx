// @vitest-environment jsdom
/**
 * THE PRODUCTS SCREEN — the spreadsheet import a person actually walks:
 *
 *  1. The template is built from the tenant's OWN price lists, units and
 *     categories, as a real workbook (read back here with the same reader).
 *  2. A chosen file is checked by the server; every row's verdict and reason
 *     is shown; importing sends the file once, under the key minted when the
 *     file was chosen, and only the ready rows are reported added.
 *  3. Removing every product needs the confirmation word, and sends the
 *     count the person was shown — so a catalogue that changed meanwhile is
 *     refused by the server rather than archived blind.
 *  4. One product is switched off (and on) from its row: one call per press,
 *     under its own key; the list shows the server's answer, and a press the
 *     server did not take leaves the switch where it was and says so.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiCallOptions, ApiEndpoint, ApiFetch } from '../src/data/api/client';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { Products } from '../src/features/products/Products';
import { conflictSummary, conflictTitle } from '../src/features/review/labels';
import { readXlsxRows } from '../src/lib/xlsx';
import { CurrencyProvider } from '../src/money/CurrencyContext';

const ENDPOINT: ApiEndpoint = { url: 'http://api.test', bearer: 'dev' };

const SETUP = {
  currencyCode: 'XTS',
  minorUnitsPerMajor: '100',
  units: [
    { code: 'BAG', name: 'Bag', qtyScale: 0 },
    { code: 'KG', name: 'Kilogram', qtyScale: 3 },
  ],
  categories: ['Cement', 'Paint'],
  priceLists: [
    { id: 'pl-1', code: 'RTL', name: 'Shop price', isTaxInclusive: true },
    { id: 'pl-2', code: 'TRD', name: 'Trade price', isTaxInclusive: false },
  ],
  taxCodes: [{ code: 'T.STD', name: 'Standard' }],
  defaultTaxCode: 'T.STD',
  suppliers: ['Acme Ltd'],
  productCount: 3,
};

const P1 = '0190a0b0-0000-7000-8000-0000000000a1';
const P2 = '0190a0b0-0000-7000-8000-0000000000a2';

const LIST = {
  products: [
    {
      productId: P1, code: 'P-00001', name: 'Cement 50kg', category: 'Cement', unit: 'Bag',
      costE4: '9800000', supplier: 'Acme Ltd', createdAt: '2026-11-24T10:00:00.000Z', sellable: true,
      prices: [{ priceListId: 'pl-1', priceE4: '12500000' }],
    },
    {
      productId: P2, code: 'P-00002', name: 'Old gloss paint', category: 'Paint', unit: 'Bag',
      costE4: null, supplier: null, createdAt: '2026-11-24T10:00:00.000Z', sellable: false,
      prices: [{ priceListId: 'pl-1', priceE4: '5000000' }],
    },
  ],
};

const PREVIEW = {
  fileError: null,
  ignoredColumns: ['Colour'],
  priceColumns: [{ priceListId: 'pl-1', name: 'Shop price' }],
  summary: { rowCount: 3, readyCount: 1, duplicateCount: 1, problemCount: 1, newCategories: ['Tiles'], newSuppliers: [] },
  rows: [
    {
      lineNo: 2, name: 'Floor tile', code: '', category: 'Tiles', categoryIsNew: true, unit: 'Bag', supplier: null,
      supplierIsNew: false, taxCode: 'T.STD', costE4: null,
      prices: [{ priceListId: 'pl-1', priceListName: 'Shop price', priceE4: '1500000' }], status: 'ready', issues: [],
    },
    {
      lineNo: 3, name: 'Cement 50kg', code: '', category: 'Cement', categoryIsNew: false, unit: 'Bag', supplier: null,
      supplierIsNew: false, taxCode: 'T.STD', costE4: null,
      prices: [{ priceListId: 'pl-1', priceListName: 'Shop price', priceE4: '12500000' }], status: 'duplicate', issues: ['DUPLICATE_NAME'],
    },
    {
      lineNo: 4, name: 'Mystery', code: '', category: 'Cement', categoryIsNew: false, unit: 'furlong', supplier: null,
      supplierIsNew: false, taxCode: 'T.STD', costE4: null, prices: [], status: 'problem', issues: ['UNKNOWN_UNIT'],
    },
  ],
};

interface Sent {
  readonly path: string;
  readonly body: Record<string, unknown> | null;
}

function server(answers: Readonly<Record<string, unknown>>, sent: Sent[]): ApiCallOptions {
  const fetchFn: ApiFetch = (url, init) => {
    const path = new URL(url).pathname.replace('/trpc/', '');
    const raw = typeof init.body === 'string' ? (JSON.parse(init.body) as { json?: Record<string, unknown> }) : null;
    sent.push({ path, body: raw?.json ?? (raw as Record<string, unknown> | null) });
    const answer = answers[path];
    if (answer === undefined) return Promise.reject(new Error('no radio'));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ result: { data: { json: answer } } }) });
  };
  return { endpoint: ENDPOINT, fetchFn };
}

function renderProducts(options: ApiCallOptions) {
  return render(
    <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
      <Products apiOptions={options} />
    </CurrencyProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the template is this tenant’s own', () => {
  it('downloads a workbook whose header names the tenant’s price lists, with its units on the Lists sheet', async () => {
    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:test';
    });
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    renderProducts(server({ 'products.importSetup': SETUP, 'products.list': LIST }, []));
    fireEvent.click(await screen.findByRole('button', { name: /Excel template/ }));
    expect(blobs).toHaveLength(1);
    const bytes = await new Promise<Uint8Array>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(blobs[0]!);
    });
    const [header] = await readXlsxRows(bytes);
    expect(header).toEqual([
      'Product name *', 'Category *', 'Unit *', 'Price: Shop price *', 'Price: Trade price',
      'Cost price', 'Supplier', 'Product code', 'Tax', 'On sale', 'Notes',
    ]);
    const lists = await readXlsxRows(bytes, 'Lists');
    expect(lists.map((r) => r[0])).toEqual(['Units', 'Bag', 'Kilogram']);
    expect(lists[1]?.[1]).toBe('Cement');
  });
});

describe('checking and importing a file', () => {
  it('shows every row’s verdict, then imports once under the key minted with the file', async () => {
    const sent: Sent[] = [];
    renderProducts(
      server(
        {
          'products.importSetup': SETUP,
          'products.list': LIST,
          'products.previewImport': PREVIEW,
          'products.commitImport': {
            importId: 'k', rowCount: 3, importedCount: 1, rejectedCount: 2, createdCategoryCount: 1, createdSupplierCount: 0,
            rejected: [{ lineNo: 3, issues: ['DUPLICATE_NAME'] }, { lineNo: 4, issues: ['UNKNOWN_UNIT'] }],
            created: [{ lineNo: 2, code: 'P-00002' }],
          },
        },
        sent,
      ),
    );
    expect(await screen.findByText(/3 products in your catalogue/)).toBeTruthy();
    // The catalogue itself, with the stated cost beside the price.
    expect(await screen.findByText('Cement 50kg')).toBeTruthy();

    const csv = 'Product name,Category,Unit,Price,Colour\nFloor tile,Tiles,Bag,15,red\nCement 50kg,Cement,Bag,125,\nMystery,Cement,furlong,1,\n';
    const input = screen.getByLabelText('Product file');
    fireEvent.change(input, { target: { files: [new File([csv], 'list.csv', { type: 'text/csv' })] } });
    expect(await screen.findByText(/3 rows found/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Check file/ }));
    expect(await screen.findByText('A product with this name already exists')).toBeTruthy();
    expect(screen.getByText(/Unit not recognised/)).toBeTruthy();
    expect(screen.getByText(/New categories to create: Tiles/)).toBeTruthy();
    expect(screen.getByText(/Columns not used: Colour/)).toBeTruthy();
    expect(screen.getByText(/2 rows will be skipped/)).toBeTruthy();

    // Filter to the problems only.
    fireEvent.click(screen.getByRole('button', { name: 'Problem' }));
    expect(screen.queryByText('Floor tile')).toBeNull();
    expect(screen.getByText('Mystery')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Import 1 product$/ }));
    expect(await screen.findByText(/1 product added, 2 skipped/)).toBeTruthy();

    const preview = sent.find((s) => s.path === 'products.previewImport')!;
    const commit = sent.filter((s) => s.path === 'products.commitImport');
    expect(commit).toHaveLength(1);
    expect(preview.body).toMatchObject({ csv, fileName: 'list.csv' });
    expect(commit[0]!.body).toMatchObject({ csv, fileName: 'list.csv' });
    expect(commit[0]!.body!['idempotencyKey']).toMatch(/^[0-9a-f-]{36}$/);
    // The catalogue is re-read so the new product shows.
    await waitFor(() => expect(sent.filter((s) => s.path === 'products.list').length).toBeGreaterThan(1));
  });

  it('says so when a file is not one it can read, instead of sending it', async () => {
    const sent: Sent[] = [];
    renderProducts(server({ 'products.importSetup': SETUP, 'products.list': LIST }, sent));
    const input = await screen.findByLabelText('Product file');
    fireEvent.change(input, { target: { files: [new File(['x'], 'old.xls')] } });
    expect(await screen.findByText(/reads Excel .xlsx and CSV files/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Check file/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(sent.some((s) => s.path === 'products.previewImport')).toBe(false);
  });
});

describe('removing every product', () => {
  it('needs the confirmation word, and sends the count that was shown', async () => {
    const sent: Sent[] = [];
    renderProducts(
      server({ 'products.importSetup': SETUP, 'products.list': LIST, 'products.removeAll': { archivedCount: 3 } }, sent),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Remove all products/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove all products' });
    expect(dialog.textContent).toMatch(/Past sales, receipts and stock history stay/);
    const confirm = screen.getByRole('button', { name: /Remove 3 products/ }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type REMOVE to confirm/), { target: { value: 'remove' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(await screen.findByText(/3 products removed/)).toBeTruthy();
    const call = sent.find((s) => s.path === 'products.removeAll')!;
    expect(call.body).toMatchObject({ expectedCount: 3 });
  });
});

describe('switching one product off, and on', () => {
  it('one call per press, under its own key; the row shows the server’s answer and the filter counts follow', async () => {
    const sent: Sent[] = [];
    renderProducts(
      server(
        {
          'products.importSetup': SETUP,
          'products.list': LIST,
          'products.setSellable': { productId: P1, sellable: false, changed: true },
        },
        sent,
      ),
    );
    const cement = (await screen.findByRole('switch', { name: 'On sale: Cement 50kg' })) as HTMLButtonElement;
    const paint = screen.getByRole('switch', { name: 'On sale: Old gloss paint' });
    expect(cement.getAttribute('aria-checked')).toBe('true');
    expect(paint.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('button', { name: 'Switched off (1)' })).toBeTruthy();

    fireEvent.click(cement);
    await waitFor(() => expect(cement.getAttribute('aria-checked')).toBe('false'));
    const calls = sent.filter((s) => s.path === 'products.setSellable');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ productId: P1, sellable: false });
    expect(calls[0]!.body!['idempotencyKey']).toMatch(/^[0-9a-f-]{36}$/);
    expect(cement.textContent).toMatch(/Off/);

    // The filter reads the new state: both are off now, none on sale.
    fireEvent.click(screen.getByRole('button', { name: 'Switched off (2)' }));
    expect(screen.getByText('Cement 50kg')).toBeTruthy();
    expect(screen.getByText('Old gloss paint')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'On sale (0)' }));
    expect(screen.queryByText('Cement 50kg')).toBeNull();
    expect(screen.getByText('No products here.')).toBeTruthy();
  });

  it('a press the server did not take leaves the switch as it was, and names the product', async () => {
    const sent: Sent[] = [];
    // No answer for setSellable: the call fails as an unreachable server would.
    renderProducts(server({ 'products.importSetup': SETUP, 'products.list': LIST }, sent));
    const paint = await screen.findByRole('switch', { name: 'On sale: Old gloss paint' });
    fireEvent.click(paint);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Old gloss paint was not switched on/);
    expect(paint.getAttribute('aria-checked')).toBe('false');
    // It was really sent — the refusal is the server's silence, not a malformed request.
    expect(sent.filter((x) => x.path === 'products.setSellable').map((x) => x.body)).toEqual([
      expect.objectContaining({ productId: P2, sellable: true }),
    ]);
  });
});

describe('Decisions names the review a taken-off product raises', () => {
  it('has a sentence, not a code', () => {
    expect(conflictTitle('PRODUCT_RETIRED_BEFORE_SYNC')).toBe('Recorded for a product that had been taken off');
    expect(conflictSummary('PRODUCT_RETIRED_BEFORE_SYNC')).toMatch(/kept exactly as recorded/);
  });
});
