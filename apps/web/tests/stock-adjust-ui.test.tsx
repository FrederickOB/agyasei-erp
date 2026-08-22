// @vitest-environment jsdom
/**
 * The adjustment screen, tested for the four things it can get wrong.
 *
 * 1. **Claiming more than happened.** The confirmation after a save says
 *    "Recorded on this device" and the row says "Waiting to send", because at
 *    that moment nothing has reached the server. A screen that said "Saved"
 *    would be making the §8.5 mistake in one word.
 * 2. **Losing a refusal.** A definitively rejected adjustment stays on the
 *    screen, named, with the server's own sentence and the plain fact that the
 *    office's count has not changed.
 * 3. **Recording an adjustment nobody can explain later.** A reason is
 *    required, it is picked from the tenant's own rows, and nothing is queued
 *    without one.
 * 4. **Offering the form to somebody who cannot use it.** Counter staff hold
 *    `stock.view`, not `stock.adjust`. Hiding the form is a COURTESY — the
 *    server re-derives the same capability from the movement's `sourceKind`
 *    and refuses the write regardless — and it is tested as one.
 *
 * Nothing in this file goes near a socket, and neither does the screen.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CAPABILITY, type PermissionsState } from '../src/data/api/session';
import type { LocalDb } from '../src/data/db';
import { recordAdjustment } from '../src/data/mutations/adjustStock';
import { readOutboxQueue } from '../src/data/queries/sales';
import { drainOutbox, type PendingOp, type UploadResult, type UploadTransport } from '../src/data/sync/upload';
import { StockAdjust } from '../src/features/inventory/StockAdjust';
import { fixedHlc, provisionDevice, seedMovementReason, seedProduct } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';
import { uuidv7 } from '../src/lib/uuidv7';

const LOC = '018f3a1e-0000-7000-8000-00000000aaaa';
const hlc = fixedHlc();

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

async function yard(): Promise<{ db: LocalDb; productId: string }> {
  const db = openTestDb();
  const device = await provisionDevice(db, { locationId: LOC, locationCode: 'OUT-01' });
  const product = await seedProduct(db, {
    code: 'SKU-1',
    name: 'Cement 50kg',
    uomLabel: 'bag',
    unitPriceE4: 620_000_000n,
    priceListId: device.priceListId,
  });
  await seedMovementReason(db, { code: 'DAMAGE', name: 'Damaged goods' });
  return { db, productId: product.id };
}

function renderScreen(db: LocalDb, permissions: PermissionsState) {
  return render(<StockAdjust db={db} permissions={permissions} />);
}

class Answering implements UploadTransport {
  constructor(private readonly reason: string | undefined) {}
  send(ops: readonly PendingOp[]): Promise<UploadResult> {
    return Promise.resolve({
      ok: true,
      status: 200,
      acks: ops.map((op) => ({
        key: op.idempotencyKey,
        status: this.reason === undefined ? ('applied' as const) : ('rejected' as const),
        ...(this.reason === undefined ? {} : { reason: this.reason }),
      })),
    });
  }
}

afterEach(cleanup);

describe('who is offered the form', () => {
  it('offers it to somebody holding stock.adjust at this counter', async () => {
    const { db } = await yard();
    renderScreen(db, holding([CAPABILITY.stockAdjust]));
    expect(await screen.findByRole('button', { name: 'Record adjustment' })).toBeDefined();
  });

  it('does not offer it to counter staff — a courtesy, not the boundary', async () => {
    const { db } = await yard();
    renderScreen(db, holding([CAPABILITY.stockView]));
    expect(await screen.findByText(/Changing a count is not part of what you do/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Record adjustment' })).toBeNull();
    // They can still see whether what this device already recorded went through.
    expect(screen.getByText('Recorded on this device')).toBeDefined();
  });

  it('offers it when the capability list could not be fetched, rather than hiding on a guess', async () => {
    const { db } = await yard();
    renderScreen(db, {
      status: 'unknown',
      failure: { kind: 'offline', message: 'Not available offline.', detail: null, status: null },
    });
    expect(await screen.findByRole('button', { name: 'Record adjustment' })).toBeDefined();
  });
});

describe('a reason is required', () => {
  it('refuses to save without one, and queues nothing', async () => {
    const { db } = await yard();
    renderScreen(db, holding([CAPABILITY.stockAdjust]));

    fireEvent.change(await screen.findByLabelText('Which product'), {
      target: { value: (await screen.findByRole('option', { name: /Cement 50kg/ })).getAttribute('value') },
    });
    fireEvent.change(screen.getByLabelText(/Quantity in bag/), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByRole('alert').textContent).toContain('Pick a reason');
    expect((await readOutboxQueue(db)).pendingCount).toBe(0);
  });

  it('offers the tenant’s own words for its own reasons', async () => {
    const { db } = await yard();
    await seedMovementReason(db, { code: 'THEFT', name: 'Theft / shrinkage' });
    renderScreen(db, holding([CAPABILITY.stockAdjust]));
    await screen.findByLabelText('Reason');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Damaged goods' })).toBeDefined());
    expect(screen.getByRole('option', { name: 'Theft / shrinkage' })).toBeDefined();
  });
});

describe('recording one with no network at all', () => {
  it('records it locally and says exactly that — never that it was saved', async () => {
    const { db } = await yard();
    renderScreen(db, holding([CAPABILITY.stockAdjust]));

    const productOption = await screen.findByRole('option', { name: /Cement 50kg/ });
    fireEvent.change(screen.getByLabelText('Which product'), {
      target: { value: productOption.getAttribute('value') },
    });
    fireEvent.change(screen.getByLabelText(/Quantity in bag/), { target: { value: '20' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Damaged goods' })).toBeDefined());
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'DAMAGE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));

    expect(await screen.findByText(/Recorded on this device: −20 bag of Cement 50kg/)).toBeDefined();
    expect(screen.getByText(/has not reached the office yet/)).toBeDefined();

    const list = await screen.findByRole('list', { name: 'Recorded adjustments' });
    expect(list.textContent).toContain('Waiting to send');
    expect(list.textContent).not.toContain('Saved');
    expect((await readOutboxQueue(db)).pendingCount).toBe(1);
  });

  it('refuses a quantity the stocking unit cannot hold, before anything is queued', async () => {
    const { db } = await yard();
    renderScreen(db, holding([CAPABILITY.stockAdjust]));

    const productOption = await screen.findByRole('option', { name: /Cement 50kg/ });
    fireEvent.change(screen.getByLabelText('Which product'), {
      target: { value: productOption.getAttribute('value') },
    });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Damaged goods' })).toBeDefined());
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'DAMAGE' } });
    fireEvent.change(screen.getByLabelText(/Quantity in bag/), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));

    expect((await screen.findByRole('alert')).textContent).toContain('whole numbers');
    expect((await readOutboxQueue(db)).pendingCount).toBe(0);
  });
});

describe('the sign is never implied', () => {
  it('lets a correction go either way', async () => {
    const { db } = await yard();
    renderScreen(db, holding([CAPABILITY.stockAdjust]));
    // CORRECTION is the default, and the ledger allows both directions for it.
    expect(await screen.findByRole('radio', { name: 'Adds to the count' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'Takes off the count' })).toBeDefined();
  });

  it('states the only direction a write-off can go, instead of offering a choice', async () => {
    const { db } = await yard();
    renderScreen(db, holding([CAPABILITY.stockAdjust]));
    fireEvent.click(await screen.findByRole('radio', { name: 'Write-off' }));
    await waitFor(() =>
      expect(screen.queryByRole('radio', { name: 'Adds to the count' })).toBeNull(),
    );
    expect(screen.getByText('Takes off the count.')).toBeDefined();
  });
});

describe('a refused adjustment stays in front of a person', () => {
  it('names it, keeps it, and says the office’s count has not changed', async () => {
    const { db, productId } = await yard();
    await recordAdjustment(db, {
      movementId: uuidv7(),
      productId,
      qtyDelta: -20n,
      kind: 'WRITE_OFF',
      reasonCode: 'DAMAGE',
      hlc,
    });
    await drainOutbox(db, new Answering('BAD_REQUEST: unknown movement reason DAMAGE'));

    renderScreen(db, holding([CAPABILITY.stockAdjust]));

    expect(await screen.findByText(/The office refused this adjustment/)).toBeDefined();
    expect(screen.getByText(/BAD_REQUEST: unknown movement reason DAMAGE/)).toBeDefined();
    const list = screen.getByRole('list', { name: 'Recorded adjustments' });
    expect(list.textContent).toContain('Needs checking');
    expect(list.textContent).toContain('Cement 50kg');
  });

  it('shows Saved once the server has acknowledged it, and not before', async () => {
    const { db, productId } = await yard();
    await recordAdjustment(db, {
      movementId: uuidv7(),
      productId,
      qtyDelta: -20n,
      kind: 'WRITE_OFF',
      reasonCode: 'DAMAGE',
      hlc,
    });
    await drainOutbox(db, new Answering(undefined));

    renderScreen(db, holding([CAPABILITY.stockAdjust]));
    const list = await screen.findByRole('list', { name: 'Recorded adjustments' });
    await waitFor(() => expect(list.textContent).toContain('Saved'));
    expect(list.textContent).not.toContain('Waiting to send');
  });
});
