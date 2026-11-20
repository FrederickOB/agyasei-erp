// @vitest-environment jsdom
/**
 * The void/return flow and the thresholds button, as a person meets them.
 *
 *  · From the Sales list, a sale rung minutes ago (still queued, radio off) is
 *    voided in two deliberate steps with a reason, and the drawer's expected
 *    cash falls by what went back.
 *  · The control is offered only to a session that holds `sale.void` or
 *    `sale.return` HERE — counter staff see the list and no button.
 *  · The low-stock screen's new button calls `inventory.ensureReorderPoints`
 *    for THIS location and says what it did.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ApiCallOptions } from '../src/data/api/client';
import { CAPABILITY, type PermissionsState } from '../src/data/api/session';
import type { LocalDb } from '../src/data/db';
import { addProductToCart, createCart } from '../src/data/mutations/cart';
import { checkout } from '../src/data/mutations/checkout';
import { readOpenTill, tillExpectedCash } from '../src/data/mutations/till';
import { loadActiveProducts } from '../src/data/queries/products';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { SalesList } from '../src/features/sales/SalesList';
import { LowStock } from '../src/features/stock/LowStock';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { fixedHlc, provisionDevice, seedProduct } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const LOC = '018f3a1e-0000-7000-8000-00000000a001';

function holding(codes: readonly string[]): PermissionsState {
  return {
    status: 'live',
    asOfMs: 0,
    snapshot: { userId: 'u1', grants: codes.map((code) => ({ code, locationId: LOC })), codes: [...codes], locationIds: [LOC] },
  };
}

async function counterWithASale(): Promise<{ db: LocalDb; total: bigint }> {
  const db = openTestDb();
  const device = await provisionDevice(db, { locationId: LOC, locationCode: 'OUT-01' });
  const p = await seedProduct(db, { code: 'SKU-1', name: 'Bag', unitPriceE4: 55_000_000n, priceListId: device.priceListId });
  const cartId = await createCart(db);
  const row = (await loadActiveProducts(db)).find((x) => x.id === p.id)!;
  await addProductToCart(db, cartId, row);
  const sale = await checkout(db, { cartId, hlc: fixedHlc(Date.now()) });
  return { db, total: sale.totalMinor };
}

afterEach(cleanup);

describe('void from the Sales list', () => {
  it('two deliberate steps and a reason; the drawer’s expected cash falls by what went back', async () => {
    const { db, total } = await counterWithASale();
    const till = (await readOpenTill(db))!;
    expect(await tillExpectedCash(db, till)).toBe(total);
    render(
      <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
        <SalesList db={db} permissions={holding([CAPABILITY.saleVoid, CAPABILITY.saleReturn])} />
      </CurrencyProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Void or return/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Void the whole sale/ }));
    // A partial return is not offered for a sale the office has not seen yet.
    const firstStep = await screen.findByRole('button', { name: 'Void this sale' });
    expect((firstStep as HTMLButtonElement).disabled).toBe(true); // no reason yet
    fireEvent.click(screen.getByRole('button', { name: 'Rung in error' }));
    fireEvent.click(screen.getByRole('button', { name: 'Void this sale' }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm: refund/ }));
    expect(await screen.findByText('Sale voided')).toBeTruthy();
    expect(await tillExpectedCash(db, till)).toBe(0n);
  });

  it('is not offered to a session that holds neither capability here', async () => {
    const { db } = await counterWithASale();
    render(
      <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
        <SalesList db={db} permissions={holding(['sale.record', 'sale.view'])} />
      </CurrencyProvider>,
    );
    expect(await screen.findByText(/Sale /)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Void or return/ })).toBeNull();
    expect(screen.queryByLabelText('Receipt number')).toBeNull();
  });
});

describe('the reorder-thresholds button (phase2-gate D1)', () => {
  it('calls inventory.ensureReorderPoints for this location and says what it did', async () => {
    const db = openTestDb();
    await provisionDevice(db, { locationId: LOC, locationCode: 'OUT-01' });
    const asked: { path: string; body: string | undefined }[] = [];
    const ok = (json: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ result: { data: { json } } }) });
    const apiOptions: ApiCallOptions = {
      endpoint: { url: 'http://api.test', bearer: 'dev' },
      fetchFn: (url: string, init?: { body?: unknown }) => {
        const path = new URL(url).pathname.replace('/trpc/', '');
        asked.push({ path, body: typeof init?.body === 'string' ? init.body : undefined });
        if (path === 'inventory.lowStock') {
          return ok({ scope: { locationCount: 1 }, alertCount: 0, alerts: [],
            locations: [{ locationId: LOC, locationCode: 'OUT-01', locationName: 'Out', alertCount: 0 }] });
        }
        if (path === 'inventory.reorderPoints') return ok({ locationId: LOC, points: [] });
        if (path === 'inventory.ensureReorderPoints') return ok({ seeded: 12, needsFounderReview: true });
        return Promise.reject(new Error('unexpected'));
      },
    } as unknown as ApiCallOptions;
    render(<LowStock db={db} permissions={holding([CAPABILITY.stockView, CAPABILITY.reorderManage])} apiOptions={apiOptions} />);
    fireEvent.click(await screen.findByRole('button', { name: /Set thresholds for everything held here/ }));
    expect(await screen.findByText(/12 thresholds set from the stock held here/)).toBeTruthy();
    const call = asked.find((a) => a.path === 'inventory.ensureReorderPoints');
    expect(call?.body).toContain(LOC);
  });
});
