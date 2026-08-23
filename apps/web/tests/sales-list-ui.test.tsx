// @vitest-environment jsdom
/**
 * "Recent sales" is the answer to "did that go through?" (§8.5), and until now
 * it could only ever give three words. A sale the server has refused eleven
 * times and a sale that has simply never had a signal both read "Waiting to
 * send" — identical rows, opposite situations, and only one of them is ever
 * going to clear on its own.
 *
 * These tests hold the line that this list says what the server said, the way
 * stock adjustments, goods receipts and delivery updates already do.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { LocalDb } from '../src/data/db';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { SalesList } from '../src/features/sales/SalesList';
import { uuidv7 } from '../src/lib/uuidv7';
import { openTestDb } from './helpers/node-db';

interface QueuedSale {
  readonly rejectedAt?: string | null;
  readonly rejectReason?: string | null;
  readonly lastRefusalReason?: string | null;
  readonly serverAckAt?: string | null;
}

async function queueSale(db: LocalDb, sale: QueuedSale = {}): Promise<string> {
  const id = uuidv7();
  await db.execute(
    `INSERT INTO outbox
       (id, idempotency_key, claimed_hlc, kind, payload, total_minor, receipt_no,
        created_at, server_ack_at, rejected_at, reject_reason,
        last_refusal_reason, last_refusal_at)
     VALUES (?, ?, NULL, 'sale', '{}', CAST(? AS INTEGER), 'RCT-1',
             '2026-08-21T09:00:00.000Z', ?, ?, ?, ?, ?)`,
    [
      id,
      id,
      '62000',
      sale.serverAckAt ?? null,
      sale.rejectedAt ?? null,
      sale.rejectReason ?? null,
      sale.lastRefusalReason ?? null,
      sale.lastRefusalReason === undefined ? null : '2026-08-21T09:05:00.000Z',
    ],
  );
  return id;
}

function renderList(db: LocalDb): void {
  render(
    <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
      <SalesList db={db} />
    </CurrencyProvider>,
  );
}

afterEach(cleanup);

describe('a sale the server keeps refusing', () => {
  const REASON = 'PRECONDITION_FAILED: no price list DEFAULT in force on 2026-08-21';

  it('quotes the server on the row, and still reads as waiting rather than failed', async () => {
    const db = openTestDb();
    await queueSale(db, { lastRefusalReason: REASON });

    renderList(db);

    // The sentence itself — the whole point. Without it "Waiting to send" is
    // the only thing anyone can act on, and it is not actionable.
    expect(await screen.findByText(REASON)).toBeTruthy();
    expect(screen.getByText(/still trying/)).toBeTruthy();
    // Not failure language: the till has not given up, and painting this the
    // same as a dead-lettered sale teaches the counter to ignore both.
    expect(screen.getByText('Waiting to send')).toBeTruthy();
    expect(screen.queryByText(/Tell your manager/)).toBeNull();
  });

  it('says nothing at all about a sale that is merely waiting for a signal', async () => {
    // Offline is the EXPECTED condition (§8.4). A queue with no refusal in it
    // is not a problem and must not be dressed as one.
    const db = openTestDb();
    await queueSale(db);

    renderList(db);

    expect(await screen.findByText('Waiting to send')).toBeTruthy();
    expect(screen.queryByText(/still trying/)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('escalates to the manager once the server has definitively refused it', async () => {
    const db = openTestDb();
    const fatal = 'BAD_REQUEST: lines must not be empty';
    await queueSale(db, { rejectedAt: '2026-08-21T09:05:00.000Z', rejectReason: fatal });

    renderList(db);

    expect(await screen.findByText(fatal)).toBeTruthy();
    expect(screen.getByText(/Tell your manager/)).toBeTruthy();
    expect(screen.getByText('Needs checking')).toBeTruthy();
    expect(screen.queryByText(/still trying/)).toBeNull();
  });

  it('drops the whole notice once the sale lands', async () => {
    const db = openTestDb();
    await queueSale(db, {
      serverAckAt: '2026-08-21T09:06:00.000Z',
      lastRefusalReason: REASON, // a refusal it recovered from
    });

    renderList(db);

    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(screen.queryByText(REASON)).toBeNull();
  });
});
