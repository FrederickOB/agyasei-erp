// @vitest-environment jsdom
/**
 * WHO OWES — the Credit screen's worklist, built from the synced book.
 *
 * Money-touching (CLAUDE.md §2.7 category 1), so the claims are proven, not
 * asserted:
 *
 *  1. **Nothing is added up.** The balance is the server's synced figure and
 *     "how late" is ONE band's server figure — the oldest overdue band holding
 *     money. A device total would be wrong by construction (credit-offline-plan
 *     R2); a fixture with two overdue bands proves the oldest is picked, not
 *     summed.
 *  2. **Most urgent first**, by bigint comparison: older band beats larger
 *     amount; within a band, the larger amount; then the larger balance.
 *  3. **A device without the book says nothing** — `null`, and the screen
 *     falls back to the plain customer list rather than "nobody owes".
 *  4. **Staleness is in the sentence** (R3): every figure is labelled "as at".
 *
 * The tenant boundary for these rows is the `tenant_credit` sync rule, proven
 * in `packages/wire-conformance/test/sync-rules-tenant-boundary.test.ts`; this
 * read adds no server path and no rows the device did not already hold.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ApiFetch } from '../src/data/api/client';
import { CAPABILITY, type PermissionsState } from '../src/data/api/session';
import type { LocalDb } from '../src/data/db';
import { compareDebtors, loadDebtors, type Debtor } from '../src/data/queries/debtors';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { Credit } from '../src/features/credit/Credit';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { provisionDevice, seedCustomer } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const LOC = '018f3a1e-0000-7000-8000-00000000aaaa';
const AS_OF = '2026-11-23';
const COMPUTED_AT = '2026-11-23T06:40:00.000Z';
const HLC = `${'0'.repeat(13)}-00001-${'ab'.repeat(16)}`;
const SIGN = DEV_PLACEHOLDER_CURRENCY.symbol;

/** The server's band vector: current, then three overdue bands (from_dpd ≥ 1). */
const BANDS = [
  { seq: 0, label: 'current', from: null, to: 0 },
  { seq: 1, label: '1-30', from: 1, to: 30 },
  { seq: 2, label: '31-60', from: 31, to: 60 },
  { seq: 3, label: '60+', from: 61, to: null },
] as const;

let n = 0;
async function seedAccount(
  db: LocalDb,
  input: {
    readonly name: string;
    readonly code: string;
    readonly balance: string;
    readonly available?: string;
    readonly status?: string;
    /** Amount per band, in BANDS order. */
    readonly bands: readonly [string, string, string, string];
  },
): Promise<string> {
  n += 1;
  const customerId = await seedCustomer(db, { code: input.code, name: input.name });
  const accountId = `acct-${String(n)}`;
  await db.execute(
    `INSERT INTO credit_position_snapshot
       (id, tenant_id, account_id, customer_id, status, terms_days,
        credit_limit_minor, limit_version_id, balance_minor, trade_exposure_minor,
        available_minor, on_account_credit_minor, fee_outstanding_minor,
        opening_before_window_minor, aged_by, fee_confirmed_at, entry_window_days,
        as_of, as_of_hlc, computed_at)
     VALUES (?, NULL, ?, ?, ?, 30, 5000000, NULL, CAST(? AS INTEGER), CAST(? AS INTEGER),
             CAST(? AS INTEGER), 0, 0, 0, 'days_past_due', NULL, 400, ?, ?, ?)`,
    [
      `snap-${String(n)}`,
      accountId,
      customerId,
      input.status ?? 'ACTIVE',
      input.balance,
      input.balance,
      input.available ?? '1000000',
      AS_OF,
      HLC,
      COMPUTED_AT,
    ],
  );
  for (const band of BANDS) {
    await db.execute(
      `INSERT INTO credit_position_bucket
         (id, tenant_id, account_id, seq, label, from_dpd, to_dpd, amount_minor, as_of, as_of_hlc)
       VALUES (?, NULL, ?, ?, ?, ?, ?, CAST(? AS INTEGER), ?, ?)`,
      [
        `${accountId}-b${String(band.seq)}`,
        accountId,
        band.seq,
        band.label,
        band.from,
        band.to,
        input.bands[band.seq],
        AS_OF,
        HLC,
      ],
    );
  }
  return customerId;
}

async function device(): Promise<LocalDb> {
  const db = openTestDb();
  await provisionDevice(db, { locationId: LOC, locationCode: 'OUT-01' });
  return db;
}

/** A book with every ordering rule exercised once. */
async function seedBook(db: LocalDb): Promise<void> {
  // Smallest late amount, but in the OLDEST band — must come first.
  await seedAccount(db, {
    name: 'Ama Hardware', code: 'CU-A', balance: '50000',
    bands: ['0', '20000', '0', '30000'],
  });
  // Larger amount in a younger band, and over its limit.
  await seedAccount(db, {
    name: 'Bono Builders', code: 'CU-B', balance: '900000', available: '-150000',
    bands: ['0', '0', '900000', '0'],
  });
  // Same band as Bono, smaller amount — must follow it.
  await seedAccount(db, {
    name: 'Cedi Cement', code: 'CU-C', balance: '400000',
    bands: ['0', '0', '400000', '0'],
  });
  // Nothing late, biggest balance of all — after every late account.
  await seedAccount(db, {
    name: 'Dagomba Depot', code: 'CU-D', balance: '2000000',
    bands: ['2000000', '0', '0', '0'],
  });
  // Owes nothing (paid ahead): not a debtor, not listed.
  await seedAccount(db, {
    name: 'Effia Estates', code: 'CU-E', balance: '-10000',
    bands: ['0', '0', '0', '0'],
  });
}

afterEach(cleanup);

describe('the debtors read', () => {
  it('is null — not empty — on a device that holds no credit book', async () => {
    const db = await device();
    await seedCustomer(db, { code: 'CU-X', name: 'Somebody' });
    expect(await loadDebtors(db)).toBeNull();
  });

  it('lists only accounts that owe, most urgent first', async () => {
    const db = await device();
    await seedBook(db);
    const debtors = await loadDebtors(db);
    expect(debtors?.map((d) => d.name)).toEqual([
      'Ama Hardware',
      'Bono Builders',
      'Cedi Cement',
      'Dagomba Depot',
    ]);
  });

  it('picks the OLDEST late band and its own figure — never a sum of bands', async () => {
    const db = await device();
    await seedBook(db);
    const [ama] = (await loadDebtors(db)) ?? [];
    // Ama has 20,000 in 1-30 and 30,000 in 60+. The answer is the 60+ band's
    // 30,000 — not 50,000, which is what adding the late bands would say.
    expect(ama?.oldestOverdue).toEqual({ label: '60+', seq: 3, amountMinor: 30_000n });
    expect(ama?.balanceMinor).toBe(50_000n);
  });

  it('reads every figure as bigint minor units', async () => {
    const db = await device();
    await seedBook(db);
    for (const d of (await loadDebtors(db)) ?? []) {
      expect(typeof d.balanceMinor).toBe('bigint');
      expect(typeof d.availableMinor).toBe('bigint');
      if (d.oldestOverdue !== null) expect(typeof d.oldestOverdue.amountMinor).toBe('bigint');
    }
  });

  it('orders by bigint comparison beyond float precision', () => {
    // 2^53 + 1 and 2^53 are equal as doubles; a Number-based sort would tie.
    const base: Debtor = {
      accountId: 'a', customerId: 'c', name: 'Same', code: '', phone: null,
      status: 'ACTIVE', balanceMinor: 9_007_199_254_740_992n, availableMinor: 0n,
      oldestOverdue: null, asOf: AS_OF, computedAtMs: null,
    };
    const bigger: Debtor = { ...base, accountId: 'b', balanceMinor: 9_007_199_254_740_993n };
    expect([base, bigger].sort(compareDebtors).map((d) => d.accountId)).toEqual(['b', 'a']);
  });
});

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

const DEAD_RADIO: ApiFetch = () => Promise.reject(new Error('no radio'));

function renderScreen(db: LocalDb) {
  return render(
    <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
      <Credit
        db={db}
        permissions={holding([CAPABILITY.creditView])}
        apiOptions={{ endpoint: { url: 'http://api.test', bearer: 'dev' }, fetchFn: DEAD_RADIO }}
      />
    </CurrencyProvider>,
  );
}

describe('the Credit screen opens on who owes', () => {
  it('shows the worklist in order, every figure labelled with its age', async () => {
    const db = await device();
    await seedBook(db);
    renderScreen(db);

    const list = await screen.findByRole('list', { name: 'Customers who owe' });
    const rows = within(list).getAllByRole('button');
    expect(rows.map((r) => r.querySelector('b')?.textContent)).toEqual([
      'Ama Hardware',
      'Bono Builders',
      'Cedi Cement',
      'Dagomba Depot',
    ]);
    expect(screen.getByText(/4 customers owe; 3 are overdue/)).toBeTruthy();

    const ama = rows[0]!;
    expect(ama.textContent).toMatch(/Owed as at/);
    expect(ama.textContent).toContain(`${SIGN}500.00`);
    expect(ama.textContent).toContain(`${SIGN}300.00 60+ days overdue`);

    const bono = rows[1]!;
    expect(bono.textContent).toContain('Over limit');
    expect(bono.textContent).toContain(`${SIGN}9,000.00`);

    expect(rows[3]!.textContent).toContain('Not yet due');
    expect(screen.queryByText('Effia Estates')).toBeNull();
  });

  it('opens a customer from the worklist', async () => {
    const db = await device();
    await seedBook(db);
    renderScreen(db);
    const name = await screen.findByText('Bono Builders');
    fireEvent.click(name.closest('button')!);
    expect(await screen.findByRole('button', { name: 'Change' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Customers who owe' })).toBeNull();
  });

  it('search still reaches a customer who owes nothing', async () => {
    const db = await device();
    await seedBook(db);
    renderScreen(db);
    await screen.findByRole('list', { name: 'Customers who owe' });
    fireEvent.change(screen.getByLabelText('Which customer'), { target: { value: 'effia' } });
    expect(await screen.findByText('Effia Estates')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Customers who owe' })).toBeNull();
  });

  it('falls back to the plain customer list on a device with no book', async () => {
    const db = await device();
    await seedCustomer(db, { code: 'CU-X', name: 'Somebody' });
    renderScreen(db);
    expect(await screen.findByText('Somebody')).toBeTruthy();
    expect(screen.queryByText(/Who owes/)).toBeNull();
    expect(screen.queryByText(/Nobody owes/)).toBeNull();
  });
});
