// @vitest-environment jsdom
/**
 * The back office, tested for the three things it can break.
 *
 * 1. **Losing the cart on the way to the dashboard.** The office is a second
 *    room, not a second app; the counter stays mounted and hidden behind it.
 * 2. **Offering a room or a tile to a session that holds nothing it shows.**
 *    Hiding is a courtesy, and the courtesy has to be right in both
 *    directions: a counter-only session is never shown a door to the office,
 *    and an office session sees exactly the tiles its capabilities cover.
 * 3. **A tile that cannot answer taking the grid down with it.** With no
 *    server at all, every tile says so in its own frame and the rest of the
 *    page stands.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ApiCallOptions } from '../src/data/api/client';
import { CAPABILITY, type PermissionsState } from '../src/data/api/session';
import type { LocalDb } from '../src/data/db';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { createCart } from '../src/data/mutations/cart';
import { OFFICE_CAPABILITIES, officeOffered, rememberRoom, rememberedRoom } from '../src/features/office/room';
import { Shell } from '../src/features/shell/Shell';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { provisionDevice } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

function setLayout(wide: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: wide,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

const LOC = '018f3a1e-0000-7000-8000-00000000aaaa';
const NO_SERVER: ApiCallOptions = { endpoint: null };

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
  await createCart(db);
  return db;
}

function renderShell(db: LocalDb, permissions: PermissionsState) {
  return render(
    <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
      <Shell db={db} permissions={permissions} status={<div>status</div>} apiOptions={NO_SERVER} />
    </CurrencyProvider>,
  );
}

/** An in-memory store: this jsdom's own `localStorage` is only partly there. */
function freshStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
}

beforeEach(() => {
  setLayout(false);
  freshStorage();
});
afterEach(cleanup);

describe('the room a session lands in', () => {
  it('defaults to the counter and remembers a choice, best-effort', () => {
    expect(rememberedRoom()).toBe('counter');
    rememberRoom('office');
    expect(rememberedRoom()).toBe('office');
    rememberRoom('counter');
    expect(rememberedRoom()).toBe('counter');
  });

  it('offers the office only to a session holding something the office shows', () => {
    expect(officeOffered(holding([]))).toBe(false);
    expect(officeOffered(holding([CAPABILITY.stockAdjust]))).toBe(false);
    for (const code of OFFICE_CAPABILITIES) expect(officeOffered(holding([code]))).toBe(true);
    // No server: nothing behind the door to reach.
    expect(officeOffered({ status: 'no-session' })).toBe(false);
    // Could not ask: an unanswerable question is not a refusal.
    expect(
      officeOffered({
        status: 'unknown',
        failure: { kind: 'offline', message: '', detail: null, status: null },
      }),
    ).toBe(true);
  });

  it('shows no door to the office on a counter-only device', async () => {
    const db = await till();
    renderShell(db, holding([]));
    await screen.findByRole('navigation', { name: 'Main' });
    expect(screen.queryByRole('button', { name: 'Open the office' })).toBeNull();
  });
});

describe('inside the office', () => {
  it('keeps the counter mounted and hidden, and comes back to it with the cart intact', async () => {
    const db = await till();
    const { container } = renderShell(db, holding([CAPABILITY.reportLocation, CAPABILITY.stockView]));
    fireEvent.click(await screen.findByRole('button', { name: 'Open the office' }));

    const rail = await screen.findByRole('navigation', { name: 'Office' });
    expect(within(rail).getByRole('button', { name: 'Dashboard' })).toBeTruthy();
    // The counter room is hidden, not gone: the attribute, not an unmount.
    const counterRoom = container.querySelector('.app-shell');
    expect(counterRoom).not.toBeNull();
    expect((counterRoom as HTMLElement).hidden).toBe(true);
    expect(container.querySelector('.view-pane')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open counter' }));
    await waitFor(() => expect((counterRoom as HTMLElement).hidden).toBe(false));
    expect(screen.queryByRole('navigation', { name: 'Office' })).toBeNull();
  });

  it('offers tabs by capability, in rail order, and never the two counter writers', async () => {
    const db = await till();
    renderShell(
      db,
      holding([
        CAPABILITY.reportLocation,
        CAPABILITY.stockView,
        CAPABILITY.stockAdjust,
        CAPABILITY.goodsReceive,
        CAPABILITY.glView,
      ]),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open the office' }));
    const rail = await screen.findByRole('navigation', { name: 'Office' });
    const labels = [...rail.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['Dashboard', 'Reports', 'Stock', 'Books', 'Printer']);
  });

  it('composes the dashboard from capabilities, and every tile refuses on its own', async () => {
    const db = await till();
    renderShell(db, holding([CAPABILITY.reportLocation, CAPABILITY.conflictReview]));
    fireEvent.click(await screen.findByRole('button', { name: 'Open the office' }));
    // The office is a LAZY chunk (Shell.tsx): under a loaded parallel test run
    // its first import can take longer than the default second.
    const sales = await screen.findByRole('region', { name: 'Sales' }, { timeout: 8000 });
    const taken = screen.getByRole('region', { name: 'Taken' });
    const decisions = screen.getByRole('region', { name: 'Decisions' });
    // Not held: no tile, rather than a tile of zeroes.
    expect(screen.queryByRole('region', { name: 'Low stock' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Margin and cover' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Posting' })).toBeNull();
    // No server: each tile says so inside its own frame; the grid stands.
    for (const tile of [sales, taken, decisions]) {
      await waitFor(() => expect(within(tile).getByRole('status')).toBeTruthy());
    }
  });

  it('opens a destination from the tabs and returns to the dashboard', async () => {
    const db = await till();
    renderShell(db, holding([CAPABILITY.reportLocation]));
    fireEvent.click(await screen.findByRole('button', { name: 'Open the office' }));
    const rail = await screen.findByRole('navigation', { name: 'Office' }, { timeout: 8000 });
    fireEvent.click(within(rail).getByRole('button', { name: 'Reports' }));
    expect(within(rail).getByRole('button', { name: 'Reports' }).getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Sales' })).toBeNull());
    // The office's own reporting page, with its period control.
    await screen.findByRole('heading', { name: 'Reports' }, { timeout: 8000 });
    expect(screen.getByRole('group', { name: 'Period' })).toBeTruthy();
    fireEvent.click(within(rail).getByRole('button', { name: 'Dashboard' }));
    await screen.findByRole('region', { name: 'Sales' }, { timeout: 8000 });
  });
});
