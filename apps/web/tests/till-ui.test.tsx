// @vitest-environment jsdom
/**
 * THE TILL AND THE TENDER, AT THE COUNTER — the screens a cashier touches.
 *
 * Behaviour, not markup: no till means the counter IS the open-till screen;
 * the date is shown large before anyone confirms it; the server's refusal is
 * shown with the server's date; an offline open is marked; cash-up shows
 * expected, counted and variance BEFORE the close is confirmed; a split
 * tender asks for the reference a method needs and records each part; and
 * after a midnight close the drawer is offered as the new day's float.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createSaleInput } from '@erp/contracts';
import type { ApiCallOptions, ApiFetch } from '../src/data/api/client';
import type { LocalDb } from '../src/data/db';
import { closeTill, openTill } from '../src/data/mutations/till';
import { readPendingOps } from '../src/data/sync/upload';
import { Counter } from '../src/features/counter/Counter';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { fixedHlc, provisionDevice, seedProduct } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const DAY = '2026-08-21';
const NOW = `${DAY}T09:00:00.000Z`;
const ENDPOINT = { url: 'http://api.test', bearer: 'test-bearer' };

function setLayout(wide: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: wide, media: query, onchange: null,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
    }),
  });
}

/** The pre-open check answering with whatever the test says the server says. */
function serverSays(json: unknown): ApiFetch {
  return () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ result: { data: { json } } }) });
}

function counter(db: LocalDb, apiOptions: ApiCallOptions = { endpoint: null }, now = NOW): ReactElement {
  return (
    <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
      <Counter db={db} apiOptions={apiOptions} nowIso={() => now} />
    </CurrencyProvider>
  );
}

async function device(opts: { till: string | false; timeZone?: string } = { till: false }) {
  const db = openTestDb();
  const d = await provisionDevice(db, { till: opts.till, timeZone: opts.timeZone ?? 'UTC' });
  await seedProduct(db, {
    code: 'P-1', name: 'Cement 50kg', uomLabel: 'bag', unitPriceE4: 620_000_000n, priceListId: d.priceListId,
  });
  return { db, device: d };
}

beforeEach(() => setLayout(true));
afterEach(cleanup);

describe('no till open: the counter IS the open-till screen', () => {
  it('shows the trading day large, and nothing to sell from until a float is entered and confirmed', async () => {
    const { db } = await device();
    render(counter(db));
    const open = await screen.findByRole('region', { name: 'Open the till' });
    expect(await within(open).findByText(/Friday,? 21 August 2026/)).toBeTruthy();
    // There is no catalogue behind it — no path to a sale without a till.
    expect(screen.queryByRole('button', { name: /Cement 50kg/ })).toBeNull();
    const button = within(open).getByRole('button', { name: 'Open the till' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(within(open).getByLabelText(/Opening float/), { target: { value: '200.00' } });
    expect(button.disabled).toBe(false);
  });

  it('with no server to ask, opens OFFLINE, says so in the chrome, and queues the open', async () => {
    const { db } = await device();
    render(counter(db));
    const open = await screen.findByRole('region', { name: 'Open the till' });
    fireEvent.change(within(open).getByLabelText(/Opening float/), { target: { value: '200.00' } });
    fireEvent.click(within(open).getByRole('button', { name: 'Open the till' }));

    const bar = await screen.findByText(/Till open/);
    expect(bar.closest('.till-bar')?.textContent).toMatch(/opened offline/);
    expect(await screen.findByRole('button', { name: /Cement 50kg/ })).toBeTruthy();
    const ops = await readPendingOps(db);
    expect(ops.map((o) => o.kind)).toEqual(['cash_session_open']);
    expect(JSON.parse(ops[0]!.payloadJson)).toMatchObject({ openingFloatMinor: '20000', openedOffline: true, businessDate: DAY });
  });

  it('when the SERVER refuses the date, shows its sentence and its date — and opens nothing', async () => {
    const { db } = await device();
    const refusal = "The server's date here is 2026-08-25; this tablet proposed 2026-08-21.";
    render(counter(db, { endpoint: ENDPOINT, fetchFn: serverSays({
      serverDate: '2026-08-25', toleranceDays: 1, periodStatus: 'open', refusal,
    }) }));
    const open = await screen.findByRole('region', { name: 'Open the till' });
    fireEvent.change(within(open).getByLabelText(/Opening float/), { target: { value: '0.00' } });
    fireEvent.click(within(open).getByRole('button', { name: 'Open the till' }));
    expect(await within(open).findByText(refusal)).toBeTruthy();
    expect(await readPendingOps(db)).toHaveLength(0);
  });

  it('when the server agrees, the till opens ONLINE — not flagged', async () => {
    const { db } = await device();
    render(counter(db, { endpoint: ENDPOINT, fetchFn: serverSays({
      serverDate: DAY, toleranceDays: 1, periodStatus: 'open', refusal: null,
    }) }));
    const open = await screen.findByRole('region', { name: 'Open the till' });
    fireEvent.change(within(open).getByLabelText(/Opening float/), { target: { value: '50.00' } });
    fireEvent.click(within(open).getByRole('button', { name: 'Open the till' }));
    const bar = await screen.findByText(/Till open/);
    expect(bar.closest('.till-bar')?.textContent).not.toMatch(/opened offline/);
    expect(JSON.parse((await readPendingOps(db))[0]!.payloadJson)).toMatchObject({ openedOffline: false });
  });

  it('after the MIDNIGHT close, offers the old drawer as the new day’s float, as a NEW till', async () => {
    const { db } = await device();
    await openTill(db, { openingFloatMinor: 12_345n, businessDate: DAY, openedOffline: false, hlc: fixedHlc(), nowIso: NOW });
    render(counter(db, { endpoint: null }, '2026-08-22T00:00:30.000Z'));
    const open = await screen.findByRole('region', { name: 'Open the till' });
    expect(within(open).getByRole('status').textContent).toMatch(/closed itself at midnight/);
    expect(await within(open).findByText(/Saturday,? 22 August 2026/)).toBeTruthy();
    expect((within(open).getByLabelText(/Opening float/) as HTMLInputElement).value).toBe('123.45');
    const ops = await readPendingOps(db);
    expect(ops.map((o) => o.kind)).toEqual(['cash_session_open', 'cash_session_close']);
    expect(JSON.parse(ops[1]!.payloadJson)).toMatchObject({ autoClosed: true });
  });
});

describe('cash-up shows expected, counted and variance BEFORE it is confirmed', () => {
  it('counts short, shows by how much, and only then closes', async () => {
    const { db } = await device({ till: DAY });
    render(counter(db));
    fireEvent.click(await screen.findByRole('button', { name: 'Cash up' }));
    const panel = await screen.findByRole('region', { name: 'Cash up the till' });
    // The fixture's till has a zero float and no sales yet: expected is 0.00.
    await within(panel).findByText('Expected in the drawer');
    fireEvent.change(within(panel).getByLabelText(/Counted cash/), { target: { value: '0.50' } });
    const variance = within(panel).getAllByRole('status').find((n) => n.className.includes('till-variance'))!;
    expect(variance.textContent).toMatch(/Over/);
    expect(variance.textContent).toMatch(/0\.50/);
    // Nothing has been queued yet: the preview is not the close.
    expect(await readPendingOps(db)).toHaveLength(0);

    fireEvent.click(within(panel).getByRole('button', { name: 'Close the till' }));
    expect(await screen.findByRole('region', { name: 'Till closed' })).toBeTruthy();
    const ops = await readPendingOps(db);
    expect(ops.map((o) => o.kind)).toEqual(['cash_session_close']);
    expect(JSON.parse(ops[0]!.payloadJson)).toMatchObject({ countedMinor: '50', clientExpectedMinor: '0' });
  });

  it('refuses to bank more than was counted — the button stays dead', async () => {
    const { db } = await device({ till: DAY });
    render(counter(db));
    fireEvent.click(await screen.findByRole('button', { name: 'Cash up' }));
    const panel = await screen.findByRole('region', { name: 'Cash up the till' });
    fireEvent.change(within(panel).getByLabelText(/Counted cash/), { target: { value: '10.00' } });
    fireEvent.change(within(panel).getByLabelText(/Taken out for the bank/), { target: { value: '10.01' } });
    expect((within(panel).getByRole('button', { name: 'Close the till' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(panel).getByText(/cannot bank more/)).toBeTruthy();
  });
});

describe('tender lines at the counter', () => {
  async function toTender(db: LocalDb) {
    render(counter(db));
    fireEvent.click(await screen.findByRole('button', { name: /Cement 50kg/ }));
    const take = await screen.findByRole('button', { name: 'Take payment' });
    await waitFor(() => expect((take as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(take);
    return screen.findByRole('region', { name: 'Payment' });
  }

  it('a method that needs a reference keeps Complete dead until it has one', async () => {
    const { db } = await device({ till: DAY });
    const panel = await toTender(db);
    fireEvent.click(within(panel).getByRole('button', { name: 'Phone wallet' }));
    const complete = within(panel).getByRole('button', { name: 'Complete sale' }) as HTMLButtonElement;
    expect(complete.disabled).toBe(true);
    expect(within(panel).getByText(/needs a reference/)).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText(/Reference/), { target: { value: 'W-778' } });
    expect(complete.disabled).toBe(false);
  });

  it('SPLIT: 100.00 on the phone wallet with its reference, the rest in cash — one sale, two lines, on the wire', async () => {
    const { db, device: d } = await device({ till: DAY });
    const panel = await toTender(db);
    // Line 1 becomes the wallet part; "Split" adds line 2, which takes the rest.
    fireEvent.click(within(panel).getByRole('button', { name: 'Split the payment' }));
    const lines = within(panel).getAllByRole('group', { name: /Payment \d/ });
    expect(lines).toHaveLength(2);
    fireEvent.click(within(lines[0]!).getByRole('button', { name: 'Phone wallet' }));
    fireEvent.change(within(lines[0]!).getByLabelText('Amount'), { target: { value: '100.00' } });
    fireEvent.change(within(lines[0]!).getByLabelText(/Reference/), { target: { value: 'W-1' } });
    expect(within(lines[1]!).getByText('Takes the rest').parentElement?.textContent).toMatch(/520\.00/);
    fireEvent.click(within(lines[1]!).getByRole('button', { name: 'Exact' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Complete sale' }));

    expect(await screen.findByRole('region', { name: 'Sale recorded' })).toBeTruthy();
    const sale = (await readPendingOps(db)).find((o) => o.kind === 'sale')!;
    const payload = createSaleInput.parse(JSON.parse(sale.payloadJson));
    expect(payload.cashSessionId).toBe(d.tillId);
    expect(payload.tenders.map((t) => [t.settlement, t.amountMinor ?? null, t.reference ?? null])).toEqual([
      ['IMMEDIATE', 10_000n, 'W-1'],
      ['IMMEDIATE', null, null], // the balance line: no claim on the wire
    ]);
    // The receipt says how it was paid, reference included.
    expect(await screen.findByText(/W-1/)).toBeTruthy();
  });

  // The completion screen states what was HANDED OVER and what goes back —
  // the device's own record of the moment, not a recomputation. (It showed
  // only the amount each method settled, so "1,000 handed over" vanished.)
  it('after a cash sale the completion screen leads with the change, out of the cash received', async () => {
    const { db } = await device({ till: DAY });
    const panel = await toTender(db);
    fireEvent.change(within(panel).getByLabelText('Cash received'), { target: { value: '1000.00' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Complete sale' }));

    const done = await screen.findByRole('region', { name: 'Sale recorded' });
    const change = await waitFor(() => {
      const el = done.querySelector('.receipt-change');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(change.textContent).toMatch(/Change to give/);
    expect(done.querySelector('.receipt-change-value')?.textContent).toMatch(/380\.00/);
    expect(done.querySelector('.receipt-received-value')?.textContent).toMatch(/1,?000\.00/);
    expect(change.textContent).toMatch(/cash received/);
    // What the cash SETTLED is still its own row, and it is the total, not the notes.
    const cashRow = within(done).getByText('Notes and coins').closest('.receipt-tender');
    expect(cashRow?.textContent).toMatch(/620\.00/);
  });

  it('exact cash says no change is due, and still states the cash received', async () => {
    const { db } = await device({ till: DAY });
    const panel = await toTender(db);
    fireEvent.click(within(panel).getByRole('button', { name: 'Exact' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Complete sale' }));

    const done = await screen.findByRole('region', { name: 'Sale recorded' });
    await waitFor(() => expect(done.querySelector('.receipt-change')?.textContent).toMatch(/No change due/));
    expect(done.querySelector('.receipt-change-value')).toBeNull();
    expect(done.querySelector('.receipt-received-value')?.textContent).toMatch(/620\.00/);
  });

  it('a sale with no cash in it shows no cash-received or change block', async () => {
    const { db } = await device({ till: DAY });
    const panel = await toTender(db);
    fireEvent.click(within(panel).getByRole('button', { name: 'Phone wallet' }));
    fireEvent.change(within(panel).getByLabelText(/Reference/), { target: { value: 'W-9' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Complete sale' }));

    const done = await screen.findByRole('region', { name: 'Sale recorded' });
    await within(done).findByText(/W-9/);
    expect(done.querySelector('.receipt-change')).toBeNull();
    expect(done.textContent).not.toMatch(/cash received/i);
  });

  it('a tap still going in when payment is taken is refused, not charged — then the screen catches up', async () => {
    const { db } = await device({ till: DAY });
    const panel = await toTender(db);
    expect(panel.querySelector('.tender-total')?.textContent).toMatch(/620\.00/);
    // A second bag lands in the cart without the screen having caught up yet
    // (written, but not yet re-read) — the race, held still.
    await db.execute('UPDATE cart_line SET qty_scaled = qty_scaled + 1');
    fireEvent.change(within(panel).getByLabelText('Cash received'), { target: { value: '1000.00' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Complete sale' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Nothing was recorded/);
    expect(alert.textContent).toMatch(/cart changed/);
    expect(screen.queryByRole('region', { name: 'Sale recorded' })).toBeNull();
    expect((await readPendingOps(db)).filter((o) => o.kind === 'sale')).toHaveLength(0);

    // The screen catches up to the real cart, and the sale goes through at it.
    db.changes.notify();
    await waitFor(() => expect(panel.querySelector('.tender-total')?.textContent).toMatch(/1,?240\.00/));
    // 1,000 no longer covers it, and the screen now says so — Complete is dead.
    const complete = within(panel).getByRole('button', { name: 'Complete sale' }) as HTMLButtonElement;
    expect(complete.disabled).toBe(true);
    fireEvent.change(within(panel).getByLabelText('Cash received'), { target: { value: '2000.00' } });
    expect(complete.disabled).toBe(false);
    fireEvent.click(complete);
    const done = await screen.findByRole('region', { name: 'Sale recorded' });
    await waitFor(() => expect(done.querySelector('.receipt-total')?.textContent).toMatch(/1,?240\.00/));
  });

  it('does NOT offer an on-account method to a session not known to hold the credit capability', async () => {
    const { db } = await device({ till: DAY });
    const panel = await toTender(db);
    expect(within(panel).queryByRole('button', { name: 'Tab' })).toBeNull();
    expect(within(panel).getAllByRole('button', { name: 'Notes and coins' }).length).toBeGreaterThan(0);
  });
});

describe('the till closes itself at local midnight, even with the counter left open', () => {
  it('a till from yesterday is closed on arrival and the open-till screen appears', async () => {
    const { db } = await device();
    const till = await openTill(db, { openingFloatMinor: 0n, businessDate: '2026-08-20', openedOffline: false, hlc: fixedHlc(), nowIso: NOW });
    render(counter(db));
    await screen.findByRole('region', { name: 'Open the till' });
    // The old one really is closed — uncounted — not extended.
    await expect(closeTill(db, { tillId: till.id, countedMinor: 0n, hlc: fixedHlc(), nowIso: NOW })).rejects.toThrow(/already closed/);
  });
});
