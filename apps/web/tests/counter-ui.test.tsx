// @vitest-environment jsdom
/**
 * The counter, exercised the way a counter is used: tap a product, watch the
 * cart, open it, close it. These are UI tests for behaviour the redesign
 * introduced, and they exist because that behaviour is not decoration —
 * a cart a phone cannot reach is a till that mis-rings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { LocalDb } from '../src/data/db';
import { addProductToCart, createCart } from '../src/data/mutations/cart';
import { getCartLines, getOpenCart } from '../src/data/queries/cart';
import { CONFIG_KEY_PRICE_LIST_ID, readActivePriceListId } from '../src/data/queries/session';
import { uuidv7 } from '../src/lib/uuidv7';
import { Counter } from '../src/features/counter/Counter';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { provisionDevice, seedProduct } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

/** jsdom has no matchMedia; the layout under test is whichever we say it is. */
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

function renderCounter(db: LocalDb): ReactElement {
  return (
    <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
      <Counter db={db} />
    </CurrencyProvider>
  );
}

async function tillWithOneProduct(): Promise<{ db: LocalDb; priceListId: string }> {
  const db = openTestDb();
  const device = await provisionDevice(db);
  await seedProduct(db, {
    code: 'P-1',
    name: 'Cement 50kg',
    category: 'Cement',
    uomLabel: 'bag',
    unitPriceE4: 620_000_000n, // 62 000 minor units — 620.00 at scale 2
    priceListId: device.priceListId,
  });
  return { db, priceListId: device.priceListId };
}

beforeEach(() => setLayout(false));
afterEach(cleanup);

describe('the counter on a phone', () => {
  it('shows the catalogue, and adding to it moves the total in the cart bar', async () => {
    const { db } = await tillWithOneProduct();
    render(renderCounter(db));

    const card = await screen.findByRole('button', { name: /Cement 50kg/ });
    // The running total lives in the bar at the thumb, not below the catalogue.
    const bar = await screen.findByRole('button', { name: /0 lines/ });
    expect(bar.textContent).toContain('0.00');

    fireEvent.click(card);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /1 line/ }).textContent).toContain('620.00'),
    );
  });

  it('confirms the tap on the card the finger is already on', async () => {
    const { db } = await tillWithOneProduct();
    render(renderCounter(db));
    const card = await screen.findByRole('button', { name: /Cement 50kg/ });

    fireEvent.click(card);

    // Cause and effect, where the eye already is — not only at the far end of
    // the screen where the total sits.
    await waitFor(() => expect(card.textContent).toContain('Added'));
  });

  it('opens the cart as a real modal, and offers three ways out of it', async () => {
    const { db } = await tillWithOneProduct();
    render(renderCounter(db));
    fireEvent.click(await screen.findByRole('button', { name: /Cement 50kg/ }));
    const trigger = await screen.findByRole('button', { name: /1 line/ });

    fireEvent.click(trigger);

    const sheet = await screen.findByRole('dialog', { name: 'Cart' });
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(within(sheet).getByText('Cement 50kg')).toBeTruthy();
    // Three ways out: the close button, the scrim, and Escape — but only ONE
    // of them is a focus stop, and only one announces itself. Two focusable
    // controls both called "Close cart" is one thing too many to tab through.
    expect(within(sheet).getByRole('button', { name: 'Close cart' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Close cart' })).toHaveLength(1);
    expect(document.querySelector('.sheet-scrim')?.getAttribute('aria-hidden')).toBe('true');

    fireEvent.keyDown(sheet, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Focus goes back to the control that opened it, not to the top of a
    // catalogue the person had already scrolled past.
    expect(document.activeElement).toBe(trigger);
  });

  it('refuses to take payment on an empty cart', async () => {
    const { db } = await tillWithOneProduct();
    render(renderCounter(db));

    const pay = await screen.findByRole('button', { name: 'Take payment' });
    expect(pay.hasAttribute('disabled')).toBe(true);
  });
});

describe('the counter on a tablet', () => {
  beforeEach(() => setLayout(true));

  it('docks the cart beside the catalogue, with no modal and no bar', async () => {
    const { db } = await tillWithOneProduct();
    render(renderCounter(db));

    // The cart is simply THERE — claiming a modal here would trap a keyboard
    // user inside a panel they could have walked out of.
    const cart = await screen.findByRole('region', { name: 'Cart' });
    expect(cart.getAttribute('aria-modal')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: /0 lines/ })).toBeNull();
  });
});

describe('while the catalogue is still being read', () => {
  it('shows the shape of what is coming, never a blank counter', async () => {
    const db = openTestDb();
    await provisionDevice(db);
    const { container } = render(renderCounter(db));

    // First frame, before the local read resolves.
    expect(container.querySelectorAll('.skeleton-card').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText('No products priced yet')).toBeTruthy());
  });
});

describe('a cart the counter can no longer sell', () => {
  /**
   * A till in the state that wedged a real device: an open cart pinned to a
   * price list that is no longer on the device, while the device itself has
   * been re-provisioned onto the tenant's current list.
   */
  async function stuckTill(withLines: boolean): Promise<LocalDb> {
    const db = openTestDb();
    const device = await provisionDevice(db);
    const product = await seedProduct(db, {
      code: 'P-1',
      name: 'Cement 50kg',
      unitPriceE4: 620_000_000n,
      priceListId: device.priceListId,
    });
    const cartId = await createCart(db);
    if (withLines) await addProductToCart(db, cartId, product);
    await db.execute('DELETE FROM price_list WHERE id = ?', [device.priceListId]);
    // The list the counter sells from now.
    const currentId = uuidv7();
    await db.execute(
      `INSERT INTO price_list (id, tenant_id, code, name, is_tax_inclusive, currency_code,
                               priority, location_id, effective_from, effective_to, hlc, updated_at)
       VALUES (?, ?, 'CURRENT', 'Current list', 0, 'XTS', 10, NULL, '2000-01-01', NULL, NULL, NULL)`,
      [currentId, uuidv7()],
    );
    await db.execute('DELETE FROM local_config WHERE key = ?', [CONFIG_KEY_PRICE_LIST_ID]);
    await db.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
      uuidv7(),
      CONFIG_KEY_PRICE_LIST_ID,
      currentId,
    ]);
    return db;
  }

  it('says so plainly, and will not take payment', async () => {
    const db = await stuckTill(true);
    render(renderCounter(db));

    // The sentence names the fix, not just the fault.
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain('Start a fresh cart');
    // And the reason is pinned where the dead button is — the banner at the
    // top of the page scrolls away, the cart bar does not.
    expect(screen.getByText('These prices are out of date')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Take payment' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('recovers in one tap, and the recovery is not where the pay button is', async () => {
    const db = await stuckTill(true);
    render(renderCounter(db));
    const recover = await screen.findByRole('button', { name: /Start a fresh cart/ });

    // Deliberately a different control from the primary action: that pixel has
    // "charge the customer" attached to it, and a habitual tap must not
    // discard a cart.
    expect(recover).not.toBe(screen.getByRole('button', { name: 'Take payment' }));

    fireEvent.click(recover);

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(await getCartLines(db, String((await getOpenCart(db))?.id))).toHaveLength(0);
    expect((await getOpenCart(db))?.priceListId).toBe(await readActivePriceListId(db));
  });

  it('repairs an EMPTY unusable cart without saying anything at all', async () => {
    // Nothing was quoted, nothing to re-ring, nothing to decide — so the till
    // fixes itself and stays quiet. This is what heals a wedged device.
    const db = await stuckTill(false);
    const before = await getOpenCart(db);
    render(renderCounter(db));

    await waitFor(async () => {
      const open = await getOpenCart(db);
      expect(open?.id).not.toBe(before?.id);
      expect(open?.priceListId).toBe(await readActivePriceListId(db));
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('These prices are out of date')).toBeNull();
  });
});

describe('search and browse', () => {
  it('filters by the tenant’s own categories, and offers a way back', async () => {
    const { db, priceListId } = await tillWithOneProduct();
    await seedProduct(db, {
      code: 'P-2',
      name: 'Roofing sheet',
      category: 'Roofing',
      unitPriceE4: 480_000_000n,
      priceListId, // the SAME list this till sells from, or it is not on sale
    });
    render(renderCounter(db));

    const chip = await screen.findByRole('button', { name: 'Cement' });
    fireEvent.click(chip);

    await waitFor(() => expect(screen.queryByRole('button', { name: /Roofing sheet/ })).toBeNull());
    expect(chip.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByRole('button', { name: /Roofing sheet/ })).toBeTruthy());
  });
});
