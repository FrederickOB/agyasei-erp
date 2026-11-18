// @vitest-environment jsdom
/**
 * Navigation, tested for the two things it can break.
 *
 * 1. **A cart lost to a mis-tap.** The lines survive anything, because they
 *    are rows in local-only SQLite. What does NOT survive an unmount is
 *    everything around them — which step of the sale is showing, a tender
 *    panel half filled in, the five-second undo of a removed line — and a
 *    counter that has silently reset to step one is a counter that re-rings a
 *    sale. So the counter is kept mounted and hidden, and that is asserted
 *    here rather than left as an implementation detail somebody tidies away.
 *
 * 2. **Offering a destination that leads nowhere, or hiding one that does
 *    not.** Hiding is a courtesy: the server re-authorises every read behind
 *    every tab. The test that matters most in this file is the last one — a
 *    device that could not fetch its capability list offers everything, and
 *    the screens behind the tabs say what they cannot answer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ApiCallOptions } from '../src/data/api/client';
import { CAPABILITY, type PermissionsState } from '../src/data/api/session';
import type { LocalDb } from '../src/data/db';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { createCart } from '../src/data/mutations/cart';
import { getCartLines, getOpenCart } from '../src/data/queries/cart';
import { Shell } from '../src/features/shell/Shell';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { provisionDevice, seedProduct } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

/** jsdom has no matchMedia; the counter's layout is whichever we say it is. */
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
/** No server at all: Reports and Stock render their own honest state, and
 *  nothing in this file goes near a socket. */
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
  const device = await provisionDevice(db, { locationId: LOC, locationCode: 'OUT-01' });
  await seedProduct(db, {
    code: 'P-1',
    name: 'Cement 50kg',
    category: 'Cement',
    uomLabel: 'bag',
    unitPriceE4: 620_000_000n,
    priceListId: device.priceListId,
  });
  // The cart — and with it the sale's idempotency key — exists BEFORE the
  // first line is added (§8.2). Opening it here rather than leaving it to the
  // counter's own effect makes the first tap deterministic: a tap that lands
  // before the cart exists is silently a no-op, which is a real race at a
  // counter and a flaky test here.
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

beforeEach(() => setLayout(false));
afterEach(cleanup);

/**
 * The destinations a capability list decides. The printer settings destination
 * is offered to every session (it is this device's own, local, and needed to set
 * up a counter), so it is asserted once on its own below and left out of the
 * capability-by-capability lists, which are about what a capability ADDS.
 */
function offered(nav: HTMLElement): (string | null)[] {
  return [...nav.querySelectorAll('button')].map((b) => b.textContent).filter((t) => t !== 'Printer');
}

describe('which destinations are offered', () => {
  it('always offers the printer settings, whatever the capabilities', async () => {
    const db = await till();
    renderShell(db, holding([]));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect([...nav.querySelectorAll('button')].map((b) => b.textContent)).toContain('Printer');
  });

  it('always offers the counter and this device’s own sales', async () => {
    const db = await till();
    renderShell(db, holding([]));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const labels = offered(nav);
    expect(labels).toEqual(['Counter', 'Sales']);
  });

  it('offers reporting only where the reporting capability is held', async () => {
    const db = await till();
    renderShell(db, holding([CAPABILITY.reportLocation]));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(offered(nav)).toEqual([
      'Counter',
      'Sales',
      'Reports',
    ]);
  });

  it('offers the stock alert only where the stock capability is held', async () => {
    const db = await till();
    renderShell(db, holding([CAPABILITY.stockView]));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    // `stock.view` is READING what is low. It is deliberately NOT the same
    // capability as changing a count, so the Adjust destination is absent —
    // which is exactly the template's counter-staff shape.
    expect(offered(nav)).toEqual([
      'Counter',
      'Sales',
      'Stock',
    ]);
  });

  it('offers adjusting a count only where stock.adjust is held', async () => {
    const db = await till();
    renderShell(db, holding([CAPABILITY.stockAdjust]));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(offered(nav)).toEqual([
      'Counter',
      'Sales',
      'Adjust',
    ]);
  });

  it('offers the credit position only where credit.view is held', async () => {
    const db = await till();
    renderShell(db, holding([CAPABILITY.creditView]));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(offered(nav)).toEqual([
      'Counter',
      'Sales',
      'Credit',
    ]);
  });

  it('offers nothing server-backed on a device that has no server', async () => {
    const db = await till();
    renderShell(db, { status: 'no-session' });
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(offered(nav)).toEqual([
      'Counter',
      'Sales',
    ]);
  });

  it('offers signing for goods only where goods.receive is held', async () => {
    const db = await till();
    renderShell(db, holding([CAPABILITY.goodsReceive]));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    // `goods.receive` is signing for a delivery. It is deliberately NOT
    // `purchase.order.approve` and not `stock.adjust`: one person who can
    // authorise an order and also sign for its goods can fabricate a receipt
    // against an order they invented. So the yard sees Receive and nothing
    // else that buying opens.
    expect(offered(nav)).toEqual([
      'Counter',
      'Sales',
      'Receive',
    ]);
  });

  it('offers buying and supply under their own separate capabilities', async () => {
    const db = await till();
    renderShell(db, holding([CAPABILITY.purchaseOrderView]));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(offered(nav)).toEqual([
      'Counter',
      'Sales',
      'Buying',
    ]);

    cleanup();
    const db2 = await till();
    renderShell(db2, holding([CAPABILITY.supplierView]));
    const nav2 = await screen.findByRole('navigation', { name: 'Main' });
    expect(offered(nav2)).toEqual([
      'Counter',
      'Sales',
      'Supply',
    ]);
  });

  it('offers tracking a load only where the delivery capability is held', async () => {
    const db = await till();
    renderShell(db, holding([CAPABILITY.deliveryView]));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(offered(nav)).toEqual([
      'Counter',
      'Sales',
      'On the road',
    ]);
  });

  it('offers the review queue only where sync.conflict.review is held', async () => {
    // The template gives this to a regional manager and to Accounts, and
    // withholds it from the counter and from an outlet manager. A queue on a
    // cashier's nav is a queue that gets dismissed rather than worked.
    const db = await till();
    renderShell(db, holding([CAPABILITY.conflictReview]));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(offered(nav)).toEqual([
      'Counter',
      'Sales',
      'Decisions',
    ]);

    // The negative, with a capability that is real but different — a nav that
    // showed everything would pass the assertion above on its own.
    cleanup();
    const db2 = await till();
    renderShell(db2, holding([CAPABILITY.stockView]));
    const nav2 = await screen.findByRole('navigation', { name: 'Main' });
    expect(offered(nav2)).not.toContain(
      'Decisions',
    );
  });

  it('offers the books only where gl.view is held — Accounts, and nobody else', async () => {
    const db = await till();
    renderShell(db, holding([CAPABILITY.glView]));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(offered(nav)).toEqual([
      'Counter',
      'Sales',
      'Books',
    ]);

    cleanup();
    const db2 = await till();
    // The margin capability is the strongest REPORTING grant; it must not
    // open the books, or the gl.view split means nothing on the client.
    renderShell(db2, holding([CAPABILITY.reportMargin, CAPABILITY.reportLocation]));
    const nav2 = await screen.findByRole('navigation', { name: 'Main' });
    expect(offered(nav2)).not.toContain('Books');
  });

  it('offers everything when the capability list could not be fetched', async () => {
    const db = await till();
    renderShell(db, {
      status: 'unknown',
      failure: { kind: 'offline', message: 'Not available offline.', detail: null, status: null },
    });
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(offered(nav)).toEqual([
      'Counter',
      'Sales',
      'Reports',
      'Stock',
      'Adjust',
      'Credit',
      'Receive',
      'Buying',
      'Supply',
      'On the road',
      // The review queue. Present here because this case is "capabilities
      // could not be fetched, so offer everything and let the server refuse"
      // — and absent from every case above, because the template withholds
      // `sync.conflict.review` from the counter and from an outlet manager.
      'Decisions',
      'Books',
    ]);
  });
});

describe('an in-progress cart survives navigation', () => {
  /**
   * `waitFor` defaults to one second, and this is the only test in the web
   * suite that has ever exceeded it — never when the file or the package runs
   * alone (verified over five consecutive runs), only under `turbo run test`
   * with nineteen tasks competing for the CPU, where it took 3.2s and was
   * still progressing rather than stuck.
   *
   * The timeout is raised rather than the assertions relaxed. What is under
   * test is that the cart SURVIVES navigation, which is a behaviour; how many
   * milliseconds a contended machine takes to render it is not. Raised here
   * and not globally, so a genuine slowdown anywhere else in the suite still
   * fails loudly.
   */
  const SLOW = { timeout: 10_000 };

  it('keeps the lines, and keeps the counter mounted rather than rebuilding it', async () => {
    const db = await till();
    const { container } = renderShell(db, holding([CAPABILITY.stockView]));
    // Scoped to the counter's own pane: the nav carries the same line count,
    // and asserting on the wrong one would prove nothing about the cart.
    const pane = container.querySelector('.view-pane') as HTMLElement;

    // Ring one line at the counter.
    fireEvent.click(await screen.findByRole('button', { name: /Cement 50kg/ }, SLOW));
    await waitFor(
      () => expect(within(pane).getByRole('button', { name: /1 line/ }).textContent).toContain('620.00'),
      SLOW,
    );

    // Walk away to another destination.
    fireEvent.click(screen.getByRole('button', { name: /^Stock/ }));
    await screen.findByRole('heading', { name: /Low stock/ }, SLOW);

    // The counter is HIDDEN, not unmounted: its markup is still in the
    // document, and it is out of the accessibility tree while it is away.
    expect(pane.hasAttribute('hidden')).toBe(true);
    expect(pane.textContent).toContain('Cement 50kg');
    expect(screen.queryByRole('button', { name: /Cement 50kg/ })).toBeNull();

    // And the cart is still the same cart when we come back.
    fireEvent.click(screen.getByRole('button', { name: /^Counter/ }));
    await waitFor(
      () => expect(within(pane).getByRole('button', { name: /1 line/ }).textContent).toContain('620.00'),
      SLOW,
    );

    const cart = await getOpenCart(db);
    expect(cart).not.toBeNull();
    expect((await getCartLines(db, cart?.id ?? '')).length).toBe(1);
  });

  it('shows the cart’s size on the counter tab from anywhere else', async () => {
    const db = await till();
    renderShell(db, holding([CAPABILITY.stockView]));

    fireEvent.click(await screen.findByRole('button', { name: /Cement 50kg/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /1 line in the cart/ })).toBeDefined(),
    );

    fireEvent.click(screen.getByRole('button', { name: /^Stock/ }));
    await screen.findByRole('heading', { name: /Low stock/ });
    // Two screens away, the badge still says the cart is waiting.
    expect(screen.getByRole('button', { name: /1 line in the cart/ })).toBeDefined();
  });
});

describe('a destination that stops being offered', () => {
  it('falls back to the counter rather than stranding somebody on a dead screen', async () => {
    const db = await till();
    const { rerender } = render(
      <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
        <Shell
          db={db}
          permissions={holding([CAPABILITY.stockView])}
          status={<div>status</div>}
          apiOptions={NO_SERVER}
        />
      </CurrencyProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Stock/ }));
    await screen.findByRole('heading', { name: /Low stock/ });

    // The capability list arrives and is narrower than this device assumed.
    rerender(
      <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
        <Shell db={db} permissions={holding([])} status={<div>status</div>} apiOptions={NO_SERVER} />
      </CurrencyProvider>,
    );

    await waitFor(() => expect(screen.queryByRole('heading', { name: /Low stock/ })).toBeNull());
    expect(screen.getByRole('button', { name: /Cement 50kg/ })).toBeDefined();
  });
});
